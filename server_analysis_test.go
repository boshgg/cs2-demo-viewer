package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func analysisUpload(t *testing.T, h http.Handler, name string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := demoRequest("http://127.0.0.1:8765/api/demos?mode=analysis", name, bytes.NewReader(content))
	defer r.Body.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestUnlimitedAnalysisAndReplayRetention(t *testing.T) {
	a, h := testViewer(t)
	if w := analysisUpload(t, h, "bad.dem", []byte("invalid")); w.Code != 400 {
		t.Fatalf("invalid upload=%d", w.Code)
	}
	if len(a.jobs) != 0 {
		t.Fatal("invalid upload registered a job")
	}
	ids := []string{}
	for i := 0; i < 13; i++ {
		id := acceptedDemoID(t, analysisUpload(t, h, fmt.Sprintf("match-%d.dem", i), []byte("PBDEMS2\x00")))
		waitForTestJob(t, h, id)
		ids = append(ids, id)
	}
	// Import enough ordinary replays to trigger eviction. All analysis jobs
	// survive independently of their total count.
	for i := 0; i < maxReplayHistory+1; i++ {
		id := acceptedDemoID(t, submitTestDemo(t, h, "playback.dem", []byte("PBDEMS2\x00")))
		waitForTestJob(t, h, id)
	}
	for _, id := range ids {
		if w := localRequest(h, "GET", "/api/demos/"+id+"/status"); w.Code != 200 {
			t.Fatalf("analysis evicted: %s", id)
		}
	}
	var listing struct {
		Demos []struct {
			ID, Name, Status string
			Analysis         bool
		}
		MaxDemos int
	}
	w := localRequest(h, "GET", "/api/analyses")
	if err := json.Unmarshal(w.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Demos) != 13 || listing.MaxDemos != 0 {
		t.Fatalf("listing=%+v", listing)
	}
	for _, j := range listing.Demos {
		if !j.Analysis || j.Name == "" || j.Status != "error" {
			t.Fatalf("bad metadata=%+v", j)
		}
	}
	localRequest(h, "DELETE", "/api/demos/"+ids[0])
	localRequest(h, "DELETE", "/api/demos/"+ids[0])
	if localRequest(h, "GET", "/api/demos/"+ids[0]+"/status").Code != 404 {
		t.Fatal("remove must remove the selected job")
	}
	id := acceptedDemoID(t, analysisUpload(t, h, "replacement.dem", []byte("PBDEMS2\x00")))
	waitForTestJob(t, h, id)
}

func TestAnalysisCacheAndConcurrentRemoval(t *testing.T) {
	a, h := testViewer(t)
	ctx, cancel := context.WithCancel(a.ctx)
	j := &job{ID: "analysis-fixture", Name: "fixture.dem", name: "fixture.dem", Map: "de_mirage", Status: "ready", Analysis: true, created: time.Now(), ctx: ctx, cancel: cancel, result: filepath.Join(a.root, "replay.json.gz"), analysisResult: filepath.Join(a.root, "analysis.json.gz")}
	a.mu.Lock()
	a.jobs[j.ID] = j
	a.mu.Unlock()
	if err := os.WriteFile(j.result, []byte("not a full demo"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeAnalysisCache(j.analysisResult, BuildAnalysis(sampleDemo())); err != nil {
		t.Fatal(err)
	}
	for _, encoding := range []string{"identity", "gzip", "gzip;q=0, identity;q=1"} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8765/api/demos/"+j.ID+"/analysis", nil)
		r.Header.Set("Accept-Encoding", encoding)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("analysis=%d %s", w.Code, w.Body.String())
		}
		var body io.Reader = w.Body
		if encoding == "gzip" {
			gz, err := gzip.NewReader(body)
			if err != nil {
				t.Fatal(err)
			}
			defer gz.Close()
			body = gz
		} else if w.Header().Get("Content-Encoding") != "" {
			t.Fatal("client declining gzip received compressed data")
		}
		var data map[string]json.RawMessage
		if err := json.NewDecoder(body).Decode(&data); err != nil {
			t.Fatal(err)
		}
		if data["series"] == nil || data["utilities"] == nil || data["frames"] != nil {
			t.Fatal("summary must be compact and independent from replay cache")
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); localRequest(h, "DELETE", "/api/demos/"+j.ID) }()
	}
	wg.Wait()
	if ctx.Err() != context.Canceled {
		t.Fatal("concurrent deletion did not cancel the job")
	}
	for _, path := range []string{j.result, j.analysisResult} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("cache not removed %s", path)
		}
	}
	if w := localRequest(h, "GET", "/api/demos/"+j.ID+"/analysis"); w.Code != 404 {
		t.Fatalf("deleted analysis=%d", w.Code)
	}
}

type blockedCacheResponse struct {
	*httptest.ResponseRecorder
	started chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func (w *blockedCacheResponse) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.started); <-w.resume })
	return w.ResponseRecorder.Write(p)
}

func TestAnalysisDeleteDuringDownloadCleansWindowsCache(t *testing.T) {
	a, h := testViewer(t)
	ctx, cancel := context.WithCancel(a.ctx)
	j := &job{ID: "downloading", Name: "download.dem", Status: "ready", Analysis: true, created: time.Now(), ctx: ctx, cancel: cancel, result: filepath.Join(a.root, "download.json.gz"), analysisResult: filepath.Join(a.root, "download.analysis.json.gz")}
	a.mu.Lock()
	a.jobs[j.ID] = j
	a.mu.Unlock()
	if err := writeAnalysisCache(j.analysisResult, BuildAnalysis(sampleDemo())); err != nil {
		t.Fatal(err)
	}
	writer := &blockedCacheResponse{ResponseRecorder: httptest.NewRecorder(), started: make(chan struct{}), resume: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.ServeHTTP(writer, httptest.NewRequest("GET", "http://127.0.0.1:8765/api/demos/downloading/analysis", nil))
	}()
	select {
	case <-writer.started:
	case <-time.After(3 * time.Second):
		close(writer.resume)
		t.Fatal("download did not start")
	}
	localRequest(h, "DELETE", "/api/demos/downloading")
	close(writer.resume)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("download did not end")
	}
	if _, err := os.Stat(j.analysisResult); !os.IsNotExist(err) {
		t.Fatal("a cancelled download left a cache file after its handle closed")
	}
}

func TestSyntheticAnalysisEndpoint(t *testing.T) {
	_, h := testViewer(t)
	w := localRequest(h, "GET", "/api/sample/analysis")
	var d struct {
		Synthetic bool
		Map       string
		Series    []json.RawMessage
	}
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !d.Synthetic || d.Map != "de_mirage" || len(d.Series) == 0 {
		t.Fatalf("missing labelled example: %s", w.Body.String())
	}
}
