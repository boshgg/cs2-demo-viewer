package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type libraryRecord struct {
	ID            string        `json:"id"`
	Revision      string        `json:"revision,omitempty"`
	Name          string        `json:"name"`
	Map           string        `json:"map"`
	Analysis      bool          `json:"analysis"`
	Status        string        `json:"status"`
	Error         string        `json:"error,omitempty"`
	Source        string        `json:"source,omitempty"`
	OwnedSource   bool          `json:"ownedSource,omitempty"`
	SourceSize    int64         `json:"sourceSize,omitempty"`
	SourceModTime int64         `json:"sourceModTime,omitempty"`
	ContentSHA256 string        `json:"contentSHA256,omitempty"`
	Catalog       bool          `json:"catalog,omitempty"`
	Reparse       *reparseState `json:"reparse,omitempty"`
	Created       time.Time     `json:"created"`
}
type libraryManifest struct {
	Version   int             `json:"version"`
	Jobs      []libraryRecord `json:"jobs"`
	Sources   []librarySource `json:"sources,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Settings  json.RawMessage `json:"settings,omitempty"`
}
type libraryScan struct {
	Directory string   `json:"directory"`
	Added     int      `json:"added"`
	Unchanged int      `json:"unchanged"`
	Queued    int      `json:"queued"`
	Errors    []string `json:"errors"`
	Scanning  bool     `json:"scanning"`
}

func installationDirectories(executable string) (string, string) {
	base := filepath.Dir(executable)
	if strings.EqualFold(filepath.Base(base), "bin") {
		base = filepath.Dir(base)
	}
	return filepath.Join(base, "demo"), filepath.Join(base, "data")
}

func validLibraryRevision(id, revision string) bool {
	if revision == "" || revision == id {
		return true
	}
	if !strings.HasPrefix(revision, id+"-") {
		return false
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(revision, id+"-"), 10, 64)
	return err == nil && n > 0
}
func jobCachePaths(root, id, revision string) (string, string) {
	if revision == "" {
		revision = id
	}
	return filepath.Join(root, revision+".json.gz"), filepath.Join(root, revision+".analysis.json.gz")
}

func openLibrary(root, demoDir string, assets fs.FS) (*app, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	demoDir, err = filepath.Abs(demoDir)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(demoDir, 0755); err != nil {
		return nil, err
	}
	lock, err := lockLibrary(root)
	if err != nil {
		return nil, fmt.Errorf("data directory is already in use or unavailable: %w", err)
	}
	a := newApp(root, assets)
	a.persistent = true
	a.demoDir = demoDir
	a.libraryLock = lock
	if err = a.loadLibrary(); err != nil {
		a.cancel()
		a.wg.Wait()
		_ = lock.Close()
		return nil, err
	}
	return a, nil
}

func (a *app) enqueue(j *job) bool {
	a.mu.Lock()
	if a.ctx.Err() != nil {
		a.mu.Unlock()
		return false
	}
	a.pending = append(a.pending, j)
	a.mu.Unlock()
	select {
	case a.queue <- struct{}{}:
	default:
	}
	return true
}

func (a *app) cleanupDeletedSource(j *job) {
	if !j.ownedSource || a.ctx.Err() != nil {
		return
	}
	a.mu.Lock()
	removed := a.jobs[j.ID] != j
	a.mu.Unlock()
	if removed {
		_ = os.Remove(j.source)
	}
}

func (a *app) cleanupCompletedUpload(j *job) {
	if !j.ownedSource {
		return
	}
	j.mu.Lock()
	finished := j.Status == "ready" || j.Status == "error"
	path := j.source
	if finished {
		j.source = ""
	}
	j.mu.Unlock()
	if finished && path != "" {
		_ = os.Remove(path)
	}
}

func (a *app) saveLibrary() {
	if !a.persistent {
		return
	}
	if err := a.persistLibrary(); err != nil {
		log.Printf("Save library: %v", err)
	}
}
func (a *app) persistLibrary() error {
	if !a.persistent {
		return nil
	}
	a.persistMu.Lock()
	defer a.persistMu.Unlock()
	a.mu.Lock()
	m := a.libraryManifestLocked(nil)
	a.mu.Unlock()
	return a.writeLibraryManifest(m)
}

// Caller holds a.mu. A replacement lets reparse persist a complete new revision
// before exposing it to readers, while retaining all current session metadata.
func (a *app) libraryManifestLocked(replacement *job) libraryManifest {
	m := libraryManifest{Version: 1, Jobs: []libraryRecord{}, SessionID: a.sessionID, Settings: append(json.RawMessage(nil), a.sessionSettings...)}
	for _, j := range a.jobs {
		if replacement != nil && j.ID == replacement.ID {
			j = replacement
		}
		j.mu.Lock()
		m.Jobs = append(m.Jobs, libraryRecord{ID: j.ID, Revision: j.Revision, Name: j.Name, Map: j.Map, Analysis: j.Analysis, Status: j.Status, Error: j.Error, Source: j.source, OwnedSource: j.ownedSource, SourceSize: j.sourceSize, SourceModTime: j.sourceModTime, ContentSHA256: j.contentSHA256, Catalog: j.catalog, Reparse: copyReparseState(j.Reparse), Created: j.created})
		base := a.demoDir
		if j.ownedSource {
			base = a.root
		}
		m.Jobs[len(m.Jobs)-1].Source = portableLibraryPath(base, j.source)
		j.mu.Unlock()
	}
	for _, source := range a.sources {
		source.Source = portableLibraryPath(a.demoDir, source.Source)
		m.Sources = append(m.Sources, source)
	}
	sort.Slice(m.Jobs, func(i, j int) bool { return m.Jobs[i].Created.Before(m.Jobs[j].Created) })
	sort.Slice(m.Sources, func(i, j int) bool { return sourceKey(m.Sources[i]) < sourceKey(m.Sources[j]) })
	return m
}

// Persist paths relative to their configured root so the complete installation
// can be renamed without invalidating its source bindings. Runtime paths remain
// absolute; legacy manifests with absolute paths still load in their old root.
func portableLibraryPath(base, source string) string {
	if source == "" || !containedFile(base, source) {
		return source
	}
	rel, err := filepath.Rel(base, source)
	if err != nil {
		return source
	}
	return filepath.ToSlash(rel)
}

func resolveLibraryPath(base, source string) string {
	if source == "" || filepath.IsAbs(source) {
		return source
	}
	return filepath.Join(base, filepath.FromSlash(source))
}

// Serialize all manifest writes with persistMu, including transactional reparses.
func (a *app) writeLibraryManifest(m libraryManifest) error {
	f, err := os.CreateTemp(a.root, ".library-*.tmp")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err = json.NewEncoder(f).Encode(m); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, filepath.Join(a.root, "library.json"))
}

func (a *app) loadLibrary() error {
	path := filepath.Join(a.root, "library.json")
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	var m libraryManifest
	d := json.NewDecoder(io.LimitReader(f, 64<<20))
	if err = d.Decode(&m); err != nil {
		return fmt.Errorf("library manifest: %w", err)
	}
	var extra any
	if d.Decode(&extra) != io.EOF || m.Version != 1 {
		return fmt.Errorf("unsupported library manifest")
	}
	seen := map[string]bool{}
	for i := range m.Jobs {
		entry := &m.Jobs[i]
		if !validSessionID(entry.ID) || !validLibraryRevision(entry.ID, entry.Revision) || seen[entry.ID] || entry.Name == "" || (entry.ContentSHA256 != "" && !validSessionHash(entry.ContentSHA256)) {
			return fmt.Errorf("invalid library identity")
		}
		seen[entry.ID] = true
		if entry.Source != "" {
			base := a.demoDir
			if entry.OwnedSource {
				base = a.root
			}
			entry.Source = resolveLibraryPath(base, entry.Source)
			if !containedFile(base, entry.Source) {
				return fmt.Errorf("library source outside its configured directory")
			}
		}
	}
	for _, source := range m.Sources {
		source.Source = resolveLibraryPath(a.demoDir, source.Source)
		if !validLibrarySource(a.demoDir, source) || !seen[source.JobID] {
			return fmt.Errorf("invalid library source binding")
		}
		a.sources[sourceKey(source)] = source
	}
	a.sessionID = m.SessionID
	a.sessionSettings = m.Settings
	for _, entry := range m.Jobs {
		ctx, cancel := context.WithCancel(a.ctx)
		j := &job{ID: entry.ID, Name: entry.Name, name: entry.Name, Map: entry.Map, Analysis: entry.Analysis, Status: entry.Status, Error: entry.Error, source: entry.Source, ownedSource: entry.OwnedSource, sourceSize: entry.SourceSize, sourceModTime: entry.SourceModTime, contentSHA256: entry.ContentSHA256, catalog: entry.Catalog || a.persistent, created: entry.Created, ctx: ctx, cancel: cancel, result: filepath.Join(a.root, entry.ID+".json.gz"), analysisResult: filepath.Join(a.root, entry.ID+".analysis.json.gz")}
		j.Revision = entry.Revision
		if j.Revision == "" {
			j.Revision = j.ID
		}
		j.result, j.analysisResult = jobCachePaths(a.root, j.ID, j.Revision)
		j.Reparse = copyReparseState(entry.Reparse)
		if j.Reparse != nil && (j.Reparse.Status == "queued" || j.Reparse.Status == "parsing") {
			if j.Reparse.Revision != "" && j.Reparse.Revision != j.Revision && validLibraryRevision(j.ID, j.Reparse.Revision) {
				replay, analysis := jobCachePaths(a.root, j.ID, j.Reparse.Revision)
				_ = os.Remove(replay)
				_ = os.Remove(analysis)
			}
			j.Reparse.Status, j.Reparse.Message, j.Reparse.Error = "error", "上次重新解析已中断，旧缓存已保留", "服务退出前未完成重新解析，请重试"
		}
		if j.Status == "ready" && cacheExists(j.result) && cacheExists(j.analysisResult) {
			j.Progress = 1
			j.Message = "已从本机资料库恢复"
		} else if j.Status != "error" {
			j.Status = "discovered"
			j.Error = ""
			j.Message = "已发现录像，选择后解析"
		}
		if j.Status == "discovered" {
			j.catalog = true
		}
		a.jobs[j.ID] = j
	}
	// Starting the app restores the catalog/cache only. Even interrupted jobs
	// wait for an explicit selection; discovering files never invokes the parser.
	for _, source := range a.sources {
		a.jobs[source.JobID].catalog = true
	}
	return nil
}
func containedFile(base, path string) bool {
	base, err := filepath.Abs(base)
	if err != nil {
		return false
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(base, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func cacheExists(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}
func regularDemo(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && strings.EqualFold(filepath.Ext(path), ".dem")
}

func (a *app) libraryInfo(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	count := len(a.jobs)
	scanning := a.scanning
	result := a.scanResult
	result.Errors = append([]string{}, result.Errors...)
	a.mu.Unlock()
	jsonResponse(w, 200, map[string]any{"directory": a.demoDir, "enabled": a.persistent, "scanning": scanning, "count": count, "result": result, "message": "递归发现 .dem 和 ZIP 中的录像，校验去重后等待选择，不会自动解析"})
}
func (a *app) refreshLibrary(w http.ResponseWriter, r *http.Request) {
	if !a.persistent {
		apiError(w, 409, "此实例未启用本机资料库")
		return
	}
	jsonResponse(w, 200, a.startLibraryScan())
}
func (a *app) scanLibrary() (result libraryScan, err error) {
	a.scanMu.Lock()
	defer a.scanMu.Unlock()
	result = libraryScan{Directory: a.demoDir, Errors: []string{}}
	a.mu.Lock()
	a.scanning = true
	a.mu.Unlock()
	defer func() {
		if err != nil && a.ctx.Err() == nil {
			result.Errors = append(result.Errors, err.Error())
		}
		a.mu.Lock()
		a.scanning = false
		a.scanResult = result
		a.mu.Unlock()
	}()
	files, err := a.collectLibraryFiles(&result)
	if err != nil {
		return result, err
	}
	// Plain files go first so an archive alongside an existing .dem reuses its
	// original ID and cached analysis after its content hash has been verified.
	for _, entry := range files {
		if a.ctx.Err() != nil {
			return result, a.ctx.Err()
		}
		if !strings.EqualFold(filepath.Ext(entry.path), ".dem") {
			continue
		}
		info := entry.info
		if info.Size() == 0 || info.Size() > maxUploadBytes {
			result.Errors = append(result.Errors, entry.path+"：文件为空或超过 2 GiB，写入完成后刷新重试")
			continue
		}
		if e := a.scanPlainFile(entry.path, info, &result); e != nil {
			result.Errors = append(result.Errors, entry.path+"："+e.Error())
		}
		a.publishScanProgress(result)
	}
	for _, entry := range files {
		if a.ctx.Err() != nil {
			return result, a.ctx.Err()
		}
		if !strings.EqualFold(filepath.Ext(entry.path), ".zip") {
			continue
		}
		if e := a.scanArchive(entry.path, entry.info, &result); e != nil {
			result.Errors = append(result.Errors, entry.path+"："+e.Error())
		}
		a.publishScanProgress(result)
	}
	if err := a.persistLibrary(); err != nil {
		return result, err
	}
	return result, nil
}

// A parser reads a private stable snapshot, never the user's original path.
func (a *app) snapshotDemo(j *job) (string, func(), error) {
	// A fresh explicit upload is already a private verified copy. Prefer it when
	// deduplication reuses an ID whose previous catalog origins are now missing.
	if j.ownedSource && safeSourcePath(a.root, j.source) {
		return a.snapshotDirectDemo(j)
	}
	if sources := a.sourcesForJob(j.ID); len(sources) > 0 {
		return a.snapshotSelectedSource(j, sources)
	}
	return a.snapshotDirectDemo(j)
}

func (a *app) snapshotDirectDemo(j *job) (string, func(), error) {
	if j.ownedSource {
		if !safeSourcePath(a.root, j.source) {
			return "", func() {}, fmt.Errorf("本机上传副本不可用")
		}
		return j.source, func() {}, nil
	}
	if !safeSourcePath(a.demoDir, j.source) {
		return "", func() {}, fmt.Errorf("原始 Demo 不可用或路径包含链接")
	}
	if !regularDemo(j.source) {
		return "", func() {}, fmt.Errorf("Demo 不存在或不是普通文件")
	}
	before, err := os.Stat(j.source)
	if err != nil {
		return "", func() {}, err
	}
	if before.Size() != j.sourceSize || before.ModTime().UnixNano() != j.sourceModTime {
		return "", func() {}, fmt.Errorf("Demo 仍在写入，请完成后刷新重试")
	}
	if time.Since(before.ModTime()) < time.Second {
		select {
		case <-j.ctx.Done():
			return "", func() {}, j.ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	input, err := os.Open(j.source)
	if err != nil {
		return "", func() {}, err
	}
	defer input.Close()
	output, err := os.CreateTemp(a.root, "parse-*.dem")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.Remove(output.Name()) }
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, maxUploadBytes+1))
	if e := output.Close(); err == nil {
		err = e
	}
	after, statErr := os.Stat(j.source)
	if err == nil && (statErr != nil || n != j.sourceSize || after.Size() != j.sourceSize || after.ModTime().UnixNano() != j.sourceModTime) {
		err = fmt.Errorf("Demo 在读取期间变化，请写入完成后刷新重试")
	}
	j.mu.Lock()
	expectedHash := j.contentSHA256
	j.mu.Unlock()
	if err == nil && expectedHash != "" && !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expectedHash) {
		err = fmt.Errorf("Demo 内容在校验后变化，请刷新重试")
	}
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	return output.Name(), cleanup, nil
}
