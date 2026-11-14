package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

func statisticsFixture(t *testing.T, a *app, id, revision, name string) (*job, *DemoData) {
	t.Helper()
	d := sampleDemo()
	d.ID = id
	d.Name = name
	ctx, cancel := context.WithCancel(a.ctx)
	j := &job{ID: id, Revision: revision, Name: name, name: name, Map: d.Map, Status: "ready", created: time.Now(), ctx: ctx, cancel: cancel}
	j.result, j.analysisResult = jobCachePaths(a.root, id, revision)
	writeFixtureGzip(t, j.result, d)
	writeFixtureGzip(t, j.analysisResult, map[string]string{"id": id})
	a.mu.Lock()
	a.jobs[id] = j
	a.mu.Unlock()
	return j, d
}

func TestStatisticsEndpointCachesOnlySelectedReadyRevision(t *testing.T) {
	a, h := testViewer(t)
	if w := localRequest(h, "GET", "/api/demos/missing/statistics"); w.Code != 404 {
		t.Fatal("missing demo must be 404")
	}
	id := "000000000000000000000001"
	j, _ := statisticsFixture(t, a, id, id+"-1", "selected.dem")
	j.Status = "discovered"
	if w := localRequest(h, "GET", "/api/demos/"+id+"/statistics"); w.Code != 409 {
		t.Fatal("unparsed discovery must not be analysed")
	}
	j.Status = "ready"
	first := localRequest(h, "GET", "/api/demos/"+id+"/statistics")
	if first.Code != 200 {
		t.Fatalf("statistics failed: %d %s", first.Code, first.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["id"] != id || result["revision"] != j.Revision || result["ruleVersion"] != StatisticsVersion || result["frames"] != nil {
		t.Fatal("statistics response has wrong identity or exposes full replay")
	}
	if first.Header().Get("X-Demo-Revision") != j.Revision || first.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("revision headers missing")
	}
	if j.Analysis || len(a.pending) != 0 {
		t.Fatal("statistics lookup changed heatmap membership or enqueued parser")
	}
	// Once computed, a repeat of the same selected revision needs no gzip decode.
	os.WriteFile(j.result, []byte("not gzip anymore"), 0600)
	second := localRequest(h, "GET", "/api/demos/"+id+"/statistics")
	if second.Code != 200 || !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Fatal("same revision did not reuse its statistics cache")
	}
	j.cancel()
	next, _ := statisticsFixture(t, a, id, id+"-2", "new-revision.dem")
	third := localRequest(h, "GET", "/api/demos/"+id+"/statistics")
	if third.Code != 200 {
		t.Fatal(third.Body.String())
	}
	json.Unmarshal(third.Body.Bytes(), &result)
	if result["revision"] != next.Revision || result["name"] != "new-revision.dem" {
		t.Fatal("old statistics survived revision change")
	}
	a.mu.Lock()
	delete(a.jobs, id)
	a.mu.Unlock()
	next.cancel()
	if w := localRequest(h, "GET", "/api/demos/"+id+"/statistics"); w.Code != 404 {
		t.Fatal("deleted job served cached statistics")
	}
}

func TestStatisticsEndpointRejectsCorruptOrMismatchedReplay(t *testing.T) {
	for _, variant := range []string{"gzip", "crc", "truncated", "trailing-json", "identity"} {
		t.Run(variant, func(t *testing.T) {
			a, h := testViewer(t)
			id := "000000000000000000000002"
			j, d := statisticsFixture(t, a, id, id+"-1", "damaged.dem")
			switch variant {
			case "gzip":
				os.WriteFile(j.result, []byte("invalid gzip"), 0600)
			case "crc":
				raw, _ := os.ReadFile(j.result)
				raw[len(raw)-8] ^= 1
				os.WriteFile(j.result, raw, 0600)
			case "truncated":
				raw, _ := os.ReadFile(j.result)
				os.WriteFile(j.result, raw[:len(raw)-4], 0600)
			case "trailing-json":
				var raw bytes.Buffer
				gz := gzip.NewWriter(&raw)
				json.NewEncoder(gz).Encode(d)
				gz.Write([]byte(`{}`))
				gz.Close()
				os.WriteFile(j.result, raw.Bytes(), 0600)
			case "identity":
				d.ID = "other-demo"
				writeFixtureGzip(t, j.result, d)
			}
			w := localRequest(h, "GET", "/api/demos/"+id+"/statistics")
			if w.Code != 500 || a.statisticsJSON != nil {
				t.Fatalf("invalid %s cache accepted: %d %s", variant, w.Code, w.Body.String())
			}
		})
	}
}

type observedStatisticsContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *observedStatisticsContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

func TestStatisticsWaitingRequestRejectsReplacedJob(t *testing.T) {
	a, h := testViewer(t)
	id := "000000000000000000000003"
	old, _ := statisticsFixture(t, a, id, id+"-1", "old.dem")
	a.statisticsGate <- struct{}{}
	ctx := &observedStatisticsContext{Context: context.Background(), entered: make(chan struct{})}
	r := httptest.NewRequest("GET", "http://127.0.0.1:8765/api/demos/"+id+"/statistics", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, r); close(done) }()
	select {
	case <-ctx.entered:
	case <-time.After(3 * time.Second):
		<-a.statisticsGate
		t.Fatal("request did not snapshot selected job")
	}
	old.cancel()
	statisticsFixture(t, a, id, id+"-2", "replacement.dem")
	<-a.statisticsGate
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not finish after replacement")
	}
	if w.Code != 409 || a.statisticsJSON != nil {
		t.Fatalf("replacement served an old revision: %d %s", w.Code, w.Body.String())
	}
}

func TestStatisticsRequestCancellationDoesNotLeakGate(t *testing.T) {
	a, h := testViewer(t)
	id := "000000000000000000000004"
	statisticsFixture(t, a, id, id+"-1", "cancel.dem")
	url := "http://127.0.0.1:8765/api/demos/" + id + "/statistics"
	// A canceled waiter must neither consume nor release the active request's
	// gate, and must not populate the derived cache.
	a.statisticsGate <- struct{}{}
	parent, cancel := context.WithCancel(context.Background())
	ctx := &observedStatisticsContext{Context: parent, entered: make(chan struct{})}
	r := httptest.NewRequest("GET", url, nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, r); close(done) }()
	select {
	case <-ctx.entered:
	case <-time.After(3 * time.Second):
		cancel()
		<-a.statisticsGate
		t.Fatal("request did not start waiting")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		<-a.statisticsGate
		t.Fatal("canceled request did not stop")
	}
	if len(a.statisticsGate) != 1 || a.statisticsJSON != nil || w.Body.Len() != 0 {
		t.Fatal("canceled waiter modified the gate or generated statistics")
	}
	<-a.statisticsGate
	// Cancellation before acquisition may select either the free gate or the
	// canceled context. Both paths must leave it available to the next request.
	for i := 0; i < 10; i++ {
		r = httptest.NewRequest("GET", url, nil).WithContext(parent)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if len(a.statisticsGate) != 0 || a.statisticsJSON != nil || w.Body.Len() != 0 {
			t.Fatal("pre-canceled request leaked the gate or generated statistics")
		}
	}
	if next := localRequest(h, "GET", "/api/demos/"+id+"/statistics"); next.Code != 200 || len(a.statisticsGate) != 0 {
		t.Fatalf("next request blocked after cancellation: %d", next.Code)
	}
}
