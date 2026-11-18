package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type localLibraryFile struct {
	path string
	info os.FileInfo
}

func (a *app) removeAnalysis(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	if j := a.jobs[r.PathValue("id")]; j != nil {
		j.mu.Lock()
		j.Analysis = false
		j.mu.Unlock()
	}
	a.mu.Unlock()
	a.saveLibrary()
	w.WriteHeader(http.StatusNoContent)
}

func safeSourcePath(base, file string) bool {
	if file == "" || !containedFile(base, file) || !unlinkedPath(file) {
		return false
	}
	info, err := os.Lstat(file)
	return err == nil && info.Mode().IsRegular()
}

func (a *app) collectLibraryFiles(result *libraryScan) ([]localLibraryFile, error) {
	var files []localLibraryFile
	privateData, _ := os.Stat(a.root)
	err := filepath.WalkDir(a.demoDir, func(file string, entry fs.DirEntry, walkErr error) error {
		if a.ctx.Err() != nil {
			return a.ctx.Err()
		}
		if walkErr != nil {
			result.Errors = append(result.Errors, file+"："+walkErr.Error())
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Clean(file), filepath.Clean(a.root)) || containedFile(a.root, file) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 || !unlinkedPath(file) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			// The demo root may use a Windows 8.3 alias while a.root uses
			// its long name. Directory identity still excludes our cache.
			if privateData != nil {
				if info, err := entry.Info(); err == nil && os.SameFile(privateData, info) {
					return filepath.SkipDir
				}
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(file))
		if ext != ".dem" && ext != ".zip" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			result.Errors = append(result.Errors, file+"："+err.Error())
			return nil
		}
		if info.Mode().IsRegular() {
			files = append(files, localLibraryFile{file, info})
		}
		return nil
	})
	return files, err
}

func (a *app) sourcesForJob(id string) []librarySource {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sourcesForJobLocked(id)
}
func (a *app) sourcesForJobLocked(id string) []librarySource {
	var sources []librarySource
	for _, source := range a.sources {
		if source.JobID == id {
			sources = append(sources, source)
		}
	}
	sort.Slice(sources, func(i, j int) bool {
		if (sources[i].Member == "") != (sources[j].Member == "") {
			return sources[i].Member == ""
		}
		return sourceKey(sources[i]) < sourceKey(sources[j])
	})
	return sources
}
func (a *app) sourceAvailable(source librarySource) bool {
	return sourceAvailableIn(a.demoDir, source)
}

func sourceAvailableIn(directory string, source librarySource) bool {
	if !safeSourcePath(directory, source.Source) {
		return false
	}
	info, err := os.Lstat(source.Source)
	return err == nil && info.Size() == source.SourceSize && info.ModTime().UnixNano() == source.SourceModTime
}

// Caller holds the job mutex. Cached results remain usable if originals move.
func (a *app) jobAvailable(j *job, sources []librarySource) bool {
	if j.Status == "ready" && cacheExists(j.result) && cacheExists(j.analysisResult) {
		return true
	}
	for _, source := range sources {
		if a.sourceAvailable(source) {
			return true
		}
	}
	if j.ownedSource {
		return safeSourcePath(a.root, j.source)
	}
	if !safeSourcePath(a.demoDir, j.source) {
		return false
	}
	info, err := os.Lstat(j.source)
	return err == nil && info.Size() == j.sourceSize && info.ModTime().UnixNano() == j.sourceModTime
}

func (a *app) libraryDemos(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	jobs := make([]*job, 0, len(a.jobs))
	for _, j := range a.jobs {
		jobs = append(jobs, j)
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].created.Before(jobs[j].created) })
	items := make([]map[string]any, 0, len(jobs))
	for _, j := range jobs {
		sources := a.sourcesForJobLocked(j.ID)
		origins := make([]map[string]any, 0, len(sources))
		for _, source := range sources {
			rel, _ := filepath.Rel(a.demoDir, source.Source)
			kind := "dem"
			if source.Member != "" {
				kind = "zip"
			}
			origins = append(origins, map[string]any{"path": filepath.ToSlash(rel), "member": source.Member, "kind": kind, "available": a.sourceAvailable(source)})
		}
		j.mu.Lock()
		items = append(items, map[string]any{"id": j.ID, "name": j.Name, "map": j.Map, "status": j.Status, "revision": j.Revision, "progress": j.Progress, "message": j.Message, "error": j.Error, "analysis": j.Analysis, "sourceCount": len(origins), "sources": origins, "available": a.jobAvailable(j, sources), "reparse": copyReparseState(j.Reparse)})
		j.mu.Unlock()
	}
	scanning := a.scanning
	a.mu.Unlock()
	jsonResponse(w, 200, map[string]any{"demos": items, "scanning": scanning})
}

func (a *app) parseLibraryDemo(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Mode string `json:"mode"`
	}
	if r.Body != nil {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		if err := decoder.Decode(&request); err != nil && err != io.EOF {
			apiError(w, 400, "解析请求格式无效")
			return
		}
	}
	mode := request.Mode
	if mode == "" {
		mode = r.URL.Query().Get("mode")
	}
	if mode == "" {
		mode = "playback"
	}
	if mode != "playback" && mode != "analysis" {
		apiError(w, 400, "未知解析模式")
		return
	}
	a.mu.Lock()
	if a.ctx.Err() != nil {
		a.mu.Unlock()
		apiError(w, 503, "服务正在关闭")
		return
	}
	j := a.jobs[r.PathValue("id")]
	if j == nil {
		a.mu.Unlock()
		apiError(w, 404, "录像不存在，请刷新资料库")
		return
	}
	j.mu.Lock()
	cached := j.Status == "ready" && cacheExists(j.result) && cacheExists(j.analysisResult)
	if cached || j.Status == "queued" || j.Status == "parsing" {
		if mode == "analysis" {
			j.Analysis = true
		}
		j.catalog = true
		response := map[string]any{"id": j.ID, "status": j.Status, "revision": j.Revision, "analysis": j.Analysis, "cached": cached}
		j.mu.Unlock()
		a.mu.Unlock()
		a.saveLibrary()
		status := http.StatusAccepted
		if cached {
			status = http.StatusOK
		}
		jsonResponse(w, status, response)
		return
	}
	if !a.jobAvailable(j, a.sourcesForJobLocked(j.ID)) {
		j.mu.Unlock()
		a.mu.Unlock()
		apiError(w, 409, "原始录像已移动、修改或不可用，请刷新资料库后重试")
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	next := &job{ID: j.ID, Revision: fmt.Sprintf("%s-%d", j.ID, time.Now().UnixNano()), Name: j.Name, name: j.name, Map: j.Map, Analysis: j.Analysis || mode == "analysis", Status: "queued", Message: "已选择录像，等待解析", source: j.source, ownedSource: j.ownedSource, sourceSize: j.sourceSize, sourceModTime: j.sourceModTime, contentSHA256: j.contentSHA256, catalog: true, created: j.created, ctx: ctx, cancel: cancel}
	next.result, next.analysisResult = jobCachePaths(a.root, next.ID, next.Revision)
	j.cancel()
	j.mu.Unlock()
	a.jobs[next.ID] = next
	a.pending = append(a.pending, next)
	analysisSelected := next.Analysis
	a.mu.Unlock()
	_ = os.Remove(j.result)
	_ = os.Remove(j.analysisResult)
	select {
	case a.queue <- struct{}{}:
	default:
	}
	a.saveLibrary()
	jsonResponse(w, http.StatusAccepted, map[string]any{"id": next.ID, "status": "queued", "revision": next.Revision, "analysis": analysisSelected, "cached": false})
}

func (a *app) snapshotSelectedSource(j *job, sources []librarySource, directory string) (string, func(), error) {
	j.mu.Lock()
	expectedHash := j.contentSHA256
	j.mu.Unlock()
	var lastErr error
	for _, source := range sources {
		if j.ctx.Err() != nil {
			return "", func() {}, j.ctx.Err()
		}
		if !sourceAvailableIn(directory, source) || (expectedHash != "" && expectedHash != source.ContentSHA256) {
			continue
		}
		if source.Member == "" {
			candidate := &job{source: source.Source, sourceSize: source.SourceSize, sourceModTime: source.SourceModTime, contentSHA256: source.ContentSHA256, ctx: j.ctx}
			file, cleanup, err := a.snapshotDirectDemo(candidate, directory)
			if err == nil {
				return file, cleanup, nil
			}
			lastErr = err
			continue
		}
		archive, err := zip.OpenReader(source.Source)
		if err != nil {
			lastErr = err
			continue
		}
		var member *zip.File
		duplicate := false
		for _, entry := range archive.File {
			if entry.Name == source.Member {
				if member != nil {
					duplicate = true
					break
				}
				member = entry
			}
		}
		if member == nil || duplicate || member.UncompressedSize64 != uint64(source.MemberSize) || member.CRC32 != source.MemberCRC {
			archive.Close()
			lastErr = fmt.Errorf("ZIP 成员已变化，请刷新资料库")
			continue
		}
		info, err := os.Lstat(source.Source)
		if err != nil {
			archive.Close()
			lastErr = err
			continue
		}
		file, hash, err := a.extractArchiveMember(member, source.Source, info)
		archive.Close()
		if err == nil && (hash != source.ContentSHA256 || j.ctx.Err() != nil) {
			_ = os.Remove(file)
			err = fmt.Errorf("ZIP 内容已变化或解析已取消，请重新选择")
		}
		if err == nil {
			return file, func() { _ = os.Remove(file) }, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("原始录像已移动、修改或不可用，请刷新资料库")
	}
	return "", func() {}, lastErr
}
