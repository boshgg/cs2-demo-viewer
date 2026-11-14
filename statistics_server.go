package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

type statisticsSnapshot struct {
	job                         *job
	id, revision, file, mapName string
}

func (a *app) currentStatisticsSnapshot(snapshot statisticsSnapshot) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.jobs[snapshot.id] != snapshot.job {
		return false
	}
	snapshot.job.mu.Lock()
	defer snapshot.job.mu.Unlock()
	return snapshot.job.Status == "ready" && snapshot.job.Revision == snapshot.revision && snapshot.job.result == snapshot.file && a.ctx.Err() == nil && (snapshot.job.ctx == nil || snapshot.job.ctx.Err() == nil)
}

// One computation and one encoded result per app. In particular, this never
// retains a library-sized map of full decoded DemoData objects in memory.
func (a *app) statisticsResult(w http.ResponseWriter, r *http.Request) {
	j := a.getJob(r)
	if j == nil {
		apiError(w, 404, "录像不存在，请从资料库重新选择")
		return
	}
	j.mu.Lock()
	if j.Status != "ready" {
		j.mu.Unlock()
		apiError(w, 409, "请先选择并完成解析，再查看数据分析")
		return
	}
	snapshot := statisticsSnapshot{job: j, id: j.ID, revision: j.Revision, file: j.result, mapName: j.Map}
	j.mu.Unlock()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stopApp := context.AfterFunc(a.ctx, cancel)
	defer stopApp()
	if j.ctx != nil {
		stopJob := context.AfterFunc(j.ctx, cancel)
		defer stopJob()
	}
	select {
	case a.statisticsGate <- struct{}{}:
		defer func() { <-a.statisticsGate }()
	case <-ctx.Done():
		if !a.currentStatisticsSnapshot(snapshot) {
			apiError(w, 409, "录像已更新或移除，请重新选择")
		}
		return
	}
	if !a.currentStatisticsSnapshot(snapshot) {
		apiError(w, 409, "录像已更新或移除，请重新选择")
		return
	}
	key := snapshot.id + "\x00" + snapshot.revision + "\x00" + StatisticsVersion
	if a.statisticsKey != key || a.statisticsJSON == nil {
		data, err := readStatisticsDemo(ctx, snapshot)
		if err != nil {
			if !a.currentStatisticsSnapshot(snapshot) {
				apiError(w, 409, "录像已更新或移除，请重新选择")
				return
			}
			if ctx.Err() != nil {
				return
			}
			apiError(w, 500, "回放缓存无法用于数据分析，请重新选择并解析录像")
			return
		}
		if !a.currentStatisticsSnapshot(snapshot) {
			apiError(w, 409, "录像已更新或移除，请重新选择")
			return
		}
		if ctx.Err() != nil {
			return
		}
		statistics := BuildStatistics(data)
		body, err := json.Marshal(struct {
			*StatisticsDemo
			Revision string `json:"revision"`
		}{StatisticsDemo: statistics, Revision: snapshot.revision})
		if err != nil {
			apiError(w, 500, "统计结果生成失败")
			return
		}
		if !a.currentStatisticsSnapshot(snapshot) {
			apiError(w, 409, "录像已更新或移除，请重新选择")
			return
		}
		if ctx.Err() != nil {
			return
		}
		a.statisticsKey, a.statisticsJSON = key, body
	}
	if !a.currentStatisticsSnapshot(snapshot) {
		apiError(w, 409, "录像已更新或移除，请重新选择")
		return
	}
	if ctx.Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Demo-Revision", snapshot.revision)
	w.Header().Set("X-Statistics-Version", StatisticsVersion)
	_, _ = w.Write(a.statisticsJSON)
}

func readStatisticsDemo(ctx context.Context, snapshot statisticsSnapshot) (*DemoData, error) {
	f, err := os.Open(snapshot.file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	limited := &io.LimitedReader{R: contextReader{ctx, gz}, N: maxUploadBytes + 1}
	decoder := json.NewDecoder(limited)
	var data DemoData
	if err := decoder.Decode(&data); err != nil {
		return nil, err
	}
	// Reading through EOF verifies the gzip trailer/CRC and rejects extra JSON.
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("invalid cache trailer: %v", err)
	}
	if limited.N <= 0 {
		return nil, fmt.Errorf("decoded replay exceeds the size limit")
	}
	if data.ID != snapshot.id || (snapshot.mapName != "" && data.Map != snapshot.mapName) {
		return nil, fmt.Errorf("cache identity mismatch")
	}
	return &data, nil
}
