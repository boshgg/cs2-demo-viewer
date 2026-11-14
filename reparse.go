package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"time"
)

type reparseState struct {
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Message  string  `json:"message,omitempty"`
	Error    string  `json:"error,omitempty"`
	Revision string  `json:"revision,omitempty"`
}

func copyReparseState(state *reparseState) *reparseState {
	if state == nil {
		return nil
	}
	copy := *state
	return &copy
}

type reparseSkip struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Error string `json:"error"`
}
type reparseResponse struct {
	Queued  []string      `json:"queued"`
	Active  []string      `json:"active"`
	Skipped []reparseSkip `json:"skipped"`
}

const reparseMissingSource = "原始录像不可用或已改变；请将原 DEM 或 ZIP 放回 demo 文件夹并刷新后重试。旧缓存已保留。"

// Caller holds a.mu and j.mu. A ready cache alone is not a reparse source.
func (a *app) hasReparseSourceLocked(j *job) bool {
	for _, source := range a.sourcesForJobLocked(j.ID) {
		if (j.contentSHA256 == "" || source.ContentSHA256 == j.contentSHA256) && a.sourceAvailable(source) {
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

func (a *app) reparseLibrary(w http.ResponseWriter, r *http.Request) {
	request := &struct {
		IDs json.RawMessage `json:"ids"`
	}{}
	if r.Body != nil {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); (err != nil && err != io.EOF) || request == nil {
			apiError(w, 400, "重新解析请求格式无效")
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			apiError(w, 400, "重新解析请求包含多余内容")
			return
		}
	}
	var ids []string
	all := len(request.IDs) == 0
	if !all && (string(request.IDs) == "null" || json.Unmarshal(request.IDs, &ids) != nil) {
		apiError(w, 400, "ids 必须是录像 ID 数组")
		return
	}
	response := reparseResponse{Queued: []string{}, Active: []string{}, Skipped: []reparseSkip{}}
	a.mu.Lock()
	if a.ctx.Err() != nil {
		a.mu.Unlock()
		apiError(w, 503, "服务正在关闭")
		return
	}
	if all {
		for id, j := range a.jobs {
			j.mu.Lock()
			if j.Status == "ready" {
				ids = append(ids, id)
			}
			j.mu.Unlock()
		}
		sort.Slice(ids, func(i, j int) bool { return a.jobs[ids[i]].created.Before(a.jobs[ids[j]].created) })
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		j := a.jobs[id]
		if j == nil {
			response.Skipped = append(response.Skipped, reparseSkip{ID: id, Error: "录像不在本地资料库中"})
			continue
		}
		j.mu.Lock()
		if j.reparseStage != nil && j.Reparse != nil && (j.Reparse.Status == "queued" || j.Reparse.Status == "parsing") {
			response.Active = append(response.Active, id)
			j.mu.Unlock()
			continue
		}
		reason := ""
		if j.Status != "ready" || !cacheExists(j.result) || !cacheExists(j.analysisResult) {
			reason = "该录像尚未解析完成，请先选择录像完成首次解析"
		} else if !a.hasReparseSourceLocked(j) {
			reason = reparseMissingSource
		}
		if reason != "" {
			response.Skipped = append(response.Skipped, reparseSkip{ID: id, Name: j.Name, Error: reason})
			if j.Status == "ready" {
				j.Reparse = &reparseState{Status: "error", Message: "无法开始重新解析，旧缓存已保留", Error: reason}
			}
			j.mu.Unlock()
			continue
		}
		ctx, cancel := context.WithCancel(a.ctx)
		revision := fmt.Sprintf("%s-%d", j.ID, time.Now().UnixNano())
		stage := &job{ID: j.ID, Revision: revision, Name: j.Name, name: j.name, Map: j.Map, Analysis: j.Analysis, Status: "queued", source: j.source, ownedSource: j.ownedSource, sourceSize: j.sourceSize, sourceModTime: j.sourceModTime, contentSHA256: j.contentSHA256, catalog: j.catalog, created: j.created, ctx: ctx, cancel: cancel, reparseBase: j, reparseBaseRevision: j.Revision}
		stage.result, stage.analysisResult = jobCachePaths(a.root, j.ID, revision)
		stage.stopBaseCancellation = context.AfterFunc(j.ctx, cancel)
		j.Reparse = &reparseState{Status: "queued", Message: "等待重新解析，当前仍可使用旧数据", Revision: revision}
		j.reparseStage = stage
		a.pending = append(a.pending, stage)
		response.Queued = append(response.Queued, id)
		j.mu.Unlock()
	}
	a.mu.Unlock()
	a.saveLibrary()
	if len(response.Queued) > 0 {
		select {
		case a.queue <- struct{}{}:
		default:
		}
	}
	jsonResponse(w, http.StatusAccepted, response)
}

// Caller holds a.mu and base.mu. Refresh/delete may invalidate a staging job.
func (a *app) currentReparseLocked(stage, base *job) bool {
	return a.jobs[stage.ID] == base && base.reparseStage == stage && base.Revision == stage.reparseBaseRevision && base.Status == "ready" && base.ctx.Err() == nil
}

func (a *app) reparseProgress(stage *job, progress float64, message string) bool {
	base := stage.reparseBase
	a.mu.Lock()
	defer a.mu.Unlock()
	base.mu.Lock()
	defer base.mu.Unlock()
	if stage.ctx.Err() != nil || !a.currentReparseLocked(stage, base) {
		return false
	}
	base.Reparse.Status, base.Reparse.Progress = "parsing", progress
	if message != "" {
		base.Reparse.Message = message
	}
	return true
}

func (a *app) finishReparseError(stage *job, err error) {
	base := stage.reparseBase
	if base == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	base.mu.Lock()
	defer base.mu.Unlock()
	if a.jobs[stage.ID] != base || base.reparseStage != stage {
		return
	}
	message := "重新解析未完成，旧缓存已保留"
	if a.ctx.Err() != nil {
		message = "重新解析已中断，旧缓存已保留"
	}
	base.Reparse.Status, base.Reparse.Message, base.Reparse.Error = "error", message, err.Error()
	base.reparseStage = nil
}

func (a *app) processReparse(stage *job) {
	committed := false
	defer func() {
		if stage.stopBaseCancellation != nil {
			stage.stopBaseCancellation()
		}
		if !committed {
			stage.cancel()
			_ = os.Remove(stage.result)
			_ = os.Remove(stage.analysisResult)
		}
		a.saveLibrary()
	}()
	if !a.reparseProgress(stage, 0, "正在重新解析，旧数据仍可使用") {
		a.finishReparseError(stage, fmt.Errorf("重新解析已取消或录像已变化"))
		return
	}
	a.saveLibrary()
	file, cleanup, err := a.snapshotDemo(stage)
	defer cleanup()
	var data *DemoData
	if err == nil {
		parser := a.reparseParser
		if parser == nil {
			parser = parseDemo
		}
		data, err = parser(stage.ctx, file, stage.ID, stage.name, func(progress float64) { a.reparseProgress(stage, progress, "") })
	}
	if err == nil && stage.ctx.Err() == nil {
		if data == nil || data.ID != stage.ID {
			err = fmt.Errorf("重新解析返回的录像身份不匹配")
		} else {
			a.reparseProgress(stage, .96, "正在保存新版回放与分析数据，旧数据仍可使用")
			err = writeReparseCache(stage.ctx, stage.result, data)
			if err == nil {
				err = writeReparseCache(stage.ctx, stage.analysisResult, BuildAnalysis(data))
			}
		}
	}
	if err == nil {
		err = stage.ctx.Err()
	}
	if err == nil {
		stage.Map = data.Map
		err = a.commitReparse(stage)
		committed = err == nil
	}
	if err != nil {
		a.finishReparseError(stage, err)
		log.Printf("Reparse %s: %v", stage.name, err)
	}
}

// Each file is unique to the attempt. Flush both before updating the durable
// manifest; neither old cache is overwritten, even when a write fails halfway.
func writeReparseCache(ctx context.Context, file string, data any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	gz, _ := gzip.NewWriterLevel(f, gzip.BestSpeed)
	err = json.NewEncoder(gz).Encode(data)
	if closeErr := gz.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = ctx.Err()
	}
	return err
}

func (a *app) commitReparse(stage *job) error {
	base := stage.reparseBase
	// Match persistLibrary's lock order and prevent a concurrent old manifest
	// snapshot from being written after this successful revision switch.
	a.persistMu.Lock()
	defer a.persistMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	base.mu.Lock()
	if stage.ctx.Err() != nil || !a.currentReparseLocked(stage, base) || !cacheExists(stage.result) || !cacheExists(stage.analysisResult) {
		base.mu.Unlock()
		return fmt.Errorf("录像已变化或重新解析已中断，未替换原缓存")
	}
	stage.Analysis, stage.Name, stage.name, stage.created, stage.catalog = base.Analysis, base.Name, base.name, base.created, base.catalog
	stage.contentSHA256 = base.contentSHA256
	stage.Status, stage.Progress, stage.Message = "ready", 1, "重新解析完成，已使用新版数据"
	stage.Reparse = &reparseState{Status: "ready", Progress: 1, Message: "重新解析完成", Revision: stage.Revision}
	base.mu.Unlock()
	if a.persistent {
		if err := a.writeLibraryManifest(a.libraryManifestLocked(stage)); err != nil {
			return fmt.Errorf("新版资料库保存失败，旧缓存已保留：%w", err)
		}
	}
	// The staged context is independent of base.ctx. Detach cancellation before
	// retiring the old revision, so the newly committed job remains usable.
	if stage.stopBaseCancellation != nil {
		stage.stopBaseCancellation()
	}
	stage.reparseBase = nil
	a.jobs[stage.ID] = stage
	base.mu.Lock()
	base.reparseStage = nil
	base.mu.Unlock()
	base.cancel()
	_ = os.Remove(base.result)
	_ = os.Remove(base.analysisResult)
	return nil
}
