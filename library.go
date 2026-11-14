package main

import (
	"context"
	"crypto/rand"
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
	ID            string    `json:"id"`
	Revision      string    `json:"revision,omitempty"`
	Name          string    `json:"name"`
	Map           string    `json:"map"`
	Analysis      bool      `json:"analysis"`
	Status        string    `json:"status"`
	Error         string    `json:"error,omitempty"`
	Source        string    `json:"source,omitempty"`
	OwnedSource   bool      `json:"ownedSource,omitempty"`
	SourceSize    int64     `json:"sourceSize,omitempty"`
	SourceModTime int64     `json:"sourceModTime,omitempty"`
	Created       time.Time `json:"created"`
}
type libraryManifest struct {
	Version   int             `json:"version"`
	Jobs      []libraryRecord `json:"jobs"`
	SessionID string          `json:"sessionId,omitempty"`
	Settings  json.RawMessage `json:"settings,omitempty"`
}
type libraryScan struct {
	Directory string   `json:"directory"`
	Added     int      `json:"added"`
	Unchanged int      `json:"unchanged"`
	Queued    int      `json:"queued"`
	Errors    []string `json:"errors"`
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
	m := libraryManifest{Version: 1, Jobs: []libraryRecord{}, SessionID: a.sessionID, Settings: append(json.RawMessage(nil), a.sessionSettings...)}
	for _, j := range a.jobs {
		j.mu.Lock()
		m.Jobs = append(m.Jobs, libraryRecord{ID: j.ID, Revision: j.Revision, Name: j.Name, Map: j.Map, Analysis: j.Analysis, Status: j.Status, Error: j.Error, Source: j.source, OwnedSource: j.ownedSource, SourceSize: j.sourceSize, SourceModTime: j.sourceModTime, Created: j.created})
		j.mu.Unlock()
	}
	a.mu.Unlock()
	sort.Slice(m.Jobs, func(i, j int) bool { return m.Jobs[i].Created.Before(m.Jobs[j].Created) })
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
	for _, entry := range m.Jobs {
		if !validSessionID(entry.ID) || !validLibraryRevision(entry.ID, entry.Revision) || seen[entry.ID] || entry.Name == "" {
			return fmt.Errorf("invalid library identity")
		}
		seen[entry.ID] = true
		if entry.Source != "" {
			base := a.demoDir
			if entry.OwnedSource {
				base = a.root
			}
			if !containedFile(base, entry.Source) {
				return fmt.Errorf("library source outside its configured directory")
			}
		}
	}
	a.sessionID = m.SessionID
	a.sessionSettings = m.Settings
	for _, entry := range m.Jobs {
		ctx, cancel := context.WithCancel(a.ctx)
		j := &job{ID: entry.ID, Name: entry.Name, name: entry.Name, Map: entry.Map, Analysis: entry.Analysis, Status: entry.Status, Error: entry.Error, source: entry.Source, ownedSource: entry.OwnedSource, sourceSize: entry.SourceSize, sourceModTime: entry.SourceModTime, created: entry.Created, ctx: ctx, cancel: cancel, result: filepath.Join(a.root, entry.ID+".json.gz"), analysisResult: filepath.Join(a.root, entry.ID+".analysis.json.gz")}
		j.Revision = entry.Revision
		if j.Revision == "" {
			j.Revision = j.ID
		}
		j.result, j.analysisResult = jobCachePaths(a.root, j.ID, j.Revision)
		if j.Status == "ready" && cacheExists(j.result) && cacheExists(j.analysisResult) {
			j.Progress = 1
			j.Message = "已从本机资料库恢复"
		} else if j.Status != "error" {
			if regularDemo(j.source) {
				j.Status = "queued"
				j.Error = ""
				j.Message = "等待恢复解析"
			} else {
				j.Status = "error"
				j.Error = "缓存不完整且原始 Demo 不可用，请重新导入"
				j.Message = "需要重新导入"
			}
		}
		a.jobs[j.ID] = j
	}
	// Preserve saved order, including interrupted uploads. Only one worker parses.
	for _, entry := range m.Jobs {
		if j := a.jobs[entry.ID]; j.Status == "queued" {
			a.enqueue(j)
		}
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
	a.mu.Unlock()
	jsonResponse(w, 200, map[string]any{"directory": a.demoDir, "enabled": a.persistent, "scanning": scanning, "count": count, "message": "文件保留在本机；刷新后发现新 Demo，按顺序解析"})
}
func (a *app) refreshLibrary(w http.ResponseWriter, r *http.Request) {
	if !a.persistent {
		apiError(w, 409, "此实例未启用本机资料库")
		return
	}
	result, err := a.scanLibrary()
	if err != nil {
		apiError(w, 500, err.Error())
		return
	}
	jsonResponse(w, 200, result)
}
func (a *app) scanLibrary() (libraryScan, error) {
	a.scanMu.Lock()
	defer a.scanMu.Unlock()
	result := libraryScan{Directory: a.demoDir, Errors: []string{}}
	a.mu.Lock()
	a.scanning = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.scanning = false; a.mu.Unlock() }()
	entries, err := os.ReadDir(a.demoDir)
	if err != nil {
		return result, err
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.EqualFold(filepath.Ext(entry.Name()), ".dem") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if info.Size() == 0 || info.Size() > maxUploadBytes {
			result.Errors = append(result.Errors, entry.Name()+"：文件为空或超过 2 GiB，写入完成后刷新重试")
			continue
		}
		path := filepath.Join(a.demoDir, entry.Name())
		a.mu.Lock()
		var existing *job
		for _, candidate := range a.jobs {
			if !candidate.ownedSource && strings.EqualFold(candidate.source, path) {
				existing = candidate
				break
			}
		}
		if existing != nil {
			existing.mu.Lock()
			same := existing.sourceSize == info.Size() && existing.sourceModTime == info.ModTime().UnixNano()
			status := existing.Status
			existing.mu.Unlock()
			if (same && status != "error") || status == "queued" || status == "parsing" {
				a.mu.Unlock()
				result.Unchanged++
				continue
			}
		}
		var id string
		created := time.Now()
		if existing != nil {
			id = existing.ID
			created = existing.created
			existing.cancel()
		} else {
			b := make([]byte, 12)
			if _, err := rand.Read(b); err != nil {
				a.mu.Unlock()
				return result, err
			}
			id = hex.EncodeToString(b)
		}
		ctx, cancel := context.WithCancel(a.ctx)
		j := &job{ID: id, Name: entry.Name(), name: entry.Name(), Analysis: true, Status: "queued", Message: "已发现本机 Demo，等待解析", source: path, sourceSize: info.Size(), sourceModTime: info.ModTime().UnixNano(), created: created, ctx: ctx, cancel: cancel, result: filepath.Join(a.root, id+".json.gz"), analysisResult: filepath.Join(a.root, id+".analysis.json.gz")}
		j.Revision = fmt.Sprintf("%s-%d", id, time.Now().UnixNano())
		j.result, j.analysisResult = jobCachePaths(a.root, j.ID, j.Revision)
		a.jobs[id] = j
		a.mu.Unlock()
		if existing != nil {
			_ = os.Remove(existing.result)
			_ = os.Remove(existing.analysisResult)
		}
		if existing == nil {
			result.Added++
		}
		result.Queued++
		a.enqueue(j)
	}
	if err := a.persistLibrary(); err != nil {
		return result, err
	}
	return result, nil
}

// A parser reads a private stable snapshot, never the user's original path.
func (a *app) snapshotDemo(j *job) (string, func(), error) {
	if j.ownedSource {
		return j.source, func() {}, nil
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
	n, err := io.Copy(output, io.LimitReader(input, maxUploadBytes+1))
	if e := output.Close(); err == nil {
		err = e
	}
	after, statErr := os.Stat(j.source)
	if err == nil && (statErr != nil || n != j.sourceSize || after.Size() != j.sourceSize || after.ModTime().UnixNano() != j.sourceModTime) {
		err = fmt.Errorf("Demo 在读取期间变化，请写入完成后刷新重试")
	}
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	return output.Name(), cleanup, nil
}
