package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func reparseFixture(t *testing.T, a *app, number int, archive bool) (*job, string, []byte) {
	t.Helper()
	body := []byte(fmt.Sprintf("PBDEMS2\x00reparse-original-%d", number))
	name := fmt.Sprintf("match-%d.dem", number)
	j := seedReadyContent(t, a, number, name, body)
	d := sampleDemo()
	d.ID, d.Name = j.ID, name
	j.Map = d.Map
	writeFixtureGzip(t, j.result, d)
	writeFixtureGzip(t, j.analysisResult, BuildAnalysis(d))
	source := filepath.Join(a.demoDir, name)
	if archive {
		source = writeTestArchive(t, a.demoDir, fmt.Sprintf("archive-%d.zip", number), testArchiveMember{"nested/" + name, body, 0})
	} else if err := os.WriteFile(source, body, 0600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(source, past, past); err != nil {
		t.Fatal(err)
	}
	if scan, err := a.scanLibrary(); err != nil || scan.Added != 0 || len(scan.Errors) != 0 {
		t.Fatalf("fixture scan: %+v %v", scan, err)
	}
	return j, source, body
}

func submitReparse(t *testing.T, a *app, body string) reparseResponse {
	t.Helper()
	r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/library/reparse", strings.NewReader(body))
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 202 {
		t.Fatalf("reparse request: %d %s", w.Code, w.Body.String())
	}
	var response reparseResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func reparseIDs(ids ...string) string {
	body, _ := json.Marshal(map[string]any{"ids": ids})
	return string(body)
}

func waitReparse(t *testing.T, a *app, id, status string) *job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		j := a.jobs[id]
		finished := false
		if j != nil {
			j.mu.Lock()
			finished = j.Reparse != nil && j.Reparse.Status == status
			j.mu.Unlock()
		}
		a.mu.Unlock()
		if finished {
			return j
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("reparse %s did not become %s", id, status)
	return nil
}

func waitReparseStart(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("reparse worker did not start")
	}
}

func syntheticReparse(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
	d := sampleDemo()
	d.ID, d.Name = id, name
	d.Events = []Event{}
	progress(.7)
	return d, nil
}

func TestReparseKeepsReadyDataUntilDurableSuccess(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	old, source, body := reparseFixture(t, a, 1, false)
	oldRevision, oldHash, originalHash := old.Revision, fileHash(t, old.result), fileHash(t, source)
	firstStats := localRequest(a.handler(), "GET", "/api/demos/"+old.ID+"/statistics")
	if firstStats.Code != 200 {
		t.Fatal(firstStats.Body.String())
	}
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var calls atomic.Int32
	a.reparseParser = func(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
		calls.Add(1)
		actual, err := os.ReadFile(file)
		if err != nil || !bytes.Equal(actual, body) || !containedFile(a.root, file) || file == source {
			return nil, fmt.Errorf("parser did not receive a verified private snapshot")
		}
		close(started)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
		}
		return syntheticReparse(ctx, file, id, name, progress)
	}
	response := submitReparse(t, a, reparseIDs(old.ID, old.ID))
	if len(response.Queued) != 1 || len(response.Active)+len(response.Skipped) != 0 {
		t.Fatalf("duplicate IDs were queued twice: %+v", response)
	}
	waitReparseStart(t, started)
	if again := submitReparse(t, a, reparseIDs(old.ID)); len(again.Queued) != 0 || len(again.Active) != 1 {
		t.Fatalf("duplicate click restarted work: %+v", again)
	}
	for _, endpoint := range []string{"/api/demos/" + old.ID + "/status", "/api/library/demos", "/api/analyses"} {
		w := localRequest(a.handler(), "GET", endpoint)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"revision":"`+oldRevision+`"`) || !strings.Contains(w.Body.String(), `"reparse":{`) || !strings.Contains(w.Body.String(), `"status":"parsing"`) {
			t.Fatalf("reparse metadata missing from %s: %s", endpoint, w.Body.String())
		}
	}
	for _, suffix := range []string{"", "/analysis", "/statistics"} {
		w := localRequest(a.handler(), "GET", "/api/demos/"+old.ID+suffix)
		if w.Code != 200 {
			t.Fatalf("old result unavailable while reparsing: %s %d", suffix, w.Code)
		}
		if suffix == "/statistics" && !bytes.Equal(w.Body.Bytes(), firstStats.Body.Bytes()) {
			t.Fatal("statistics changed before successful commit")
		}
	}
	if old.ctx.Err() != nil || fileHash(t, old.result) != oldHash {
		t.Fatal("old revision was canceled or overwritten before commit")
	}
	if w := localRequest(a.handler(), "DELETE", "/api/analyses/"+old.ID); w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	settings := json.RawMessage(`{"map":"de_mirage","aliases":{"team":"kept"},"selectedDemos":[],"selectedPlayers":["same-id"]}`)
	a.mu.Lock()
	a.sessionSettings = settings
	a.mu.Unlock()
	releaseOnce.Do(func() { close(release) })
	next := waitReparse(t, a, old.ID, "ready")
	if next == old || next.Revision == oldRevision || next.ID != old.ID || next.Analysis || next.ctx.Err() != nil || old.ctx.Err() == nil || next.contentSHA256 != old.contentSHA256 {
		t.Fatal("revision switch lost ID, membership or source identity")
	}
	if calls.Load() != 1 || len(a.jobs) != 1 || len(a.sources) != 1 || fileHash(t, source) != originalHash {
		t.Fatal("reparse duplicated a job or changed its original")
	}
	newStats := localRequest(a.handler(), "GET", "/api/demos/"+next.ID+"/statistics")
	if newStats.Code != 200 || newStats.Header().Get("X-Demo-Revision") != next.Revision || bytes.Equal(firstStats.Body.Bytes(), newStats.Body.Bytes()) {
		t.Fatal("statistics cache did not invalidate on committed revision")
	}
	a.close()
	reopened := persistentViewer(t, a.root, a.demoDir)
	loaded := reopened.jobs[next.ID]
	if loaded == nil || loaded.Revision != next.Revision || loaded.Status != "ready" || loaded.Analysis || loaded.Reparse == nil || loaded.Reparse.Status != "ready" || !bytes.Equal(reopened.sessionSettings, settings) {
		t.Fatal("committed revision or latest session settings were not durable")
	}
}

func TestReparseFailuresKeepBothOriginalCaches(t *testing.T) {
	for _, mode := range []string{"parser", "analysis-write", "manifest-write", "modified-source"} {
		t.Run(mode, func(t *testing.T) {
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			old, source, body := reparseFixture(t, a, 2, false)
			replayHash, analysisHash := fileHash(t, old.result), fileHash(t, old.analysisResult)
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			defer once.Do(func() { close(release) })
			var calls atomic.Int32
			a.reparseParser = func(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
				calls.Add(1)
				close(started)
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-release:
				}
				if mode == "parser" {
					return nil, fmt.Errorf("deliberate parser failure")
				}
				return syntheticReparse(ctx, file, id, name, progress)
			}
			if mode == "modified-source" {
				info, _ := os.Stat(source)
				body[len(body)-1] ^= 1
				if err := os.WriteFile(source, body, 0600); err != nil {
					t.Fatal(err)
				}
				os.Chtimes(source, info.ModTime(), info.ModTime())
			}
			if result := submitReparse(t, a, reparseIDs(old.ID)); len(result.Queued) != 1 {
				t.Fatalf("not queued: %+v", result)
			}
			manifest := filepath.Join(a.root, "library.json")
			backup := manifest + ".test-backup"
			if mode != "modified-source" {
				waitReparseStart(t, started)
				old.mu.Lock()
				stage := old.reparseStage
				old.mu.Unlock()
				if mode == "analysis-write" {
					if err := os.Mkdir(stage.analysisResult, 0700); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "manifest-write" {
					if err := os.Rename(manifest, backup); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(manifest, 0700); err != nil {
						t.Fatal(err)
					}
				}
				once.Do(func() { close(release) })
			}
			current := waitReparse(t, a, old.ID, "error")
			if current != old || current.Status != "ready" || old.ctx.Err() != nil || fileHash(t, old.result) != replayHash || fileHash(t, old.analysisResult) != analysisHash {
				t.Fatal("failed attempt replaced or damaged an original cache")
			}
			if mode == "modified-source" && calls.Load() != 0 {
				t.Fatal("changed source bypassed SHA validation")
			}
			if mode == "manifest-write" {
				// The error status is visible before processReparse's deferred
				// save completes. Serialize fixture restoration with that writer,
				// just as production manifest updates do, and unlock before close.
				err := func() error {
					a.persistMu.Lock()
					defer a.persistMu.Unlock()
					if err := os.Remove(manifest); err != nil {
						return err
					}
					return os.Rename(backup, manifest)
				}()
				if err != nil {
					t.Fatal(err)
				}
			}
			a.close()
			reopened := persistentViewer(t, a.root, a.demoDir)
			loaded := reopened.jobs[old.ID]
			if loaded == nil || loaded.Revision != old.Revision || loaded.Status != "ready" || loaded.Reparse == nil || loaded.Reparse.Status != "error" || fileHash(t, loaded.result) != replayHash {
				t.Fatal("failed reparse was not recoverable after restart")
			}
		})
	}
}

func TestReparseBatchDefaultsSkipUnparsedAndMissingSources(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	one, _, _ := reparseFixture(t, a, 3, false)
	two, _, _ := reparseFixture(t, a, 4, false)
	two.Analysis = false
	missing := seedReadyContent(t, a, 5, "cache-only.dem", []byte("missing"))
	writeLocalDemo(t, a.demoDir, "unselected.dem")
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	a.reparseParser = func(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
		calls.Add(1)
		return syntheticReparse(ctx, file, id, name, progress)
	}
	if empty := submitReparse(t, a, `{"ids":[]}`); len(empty.Queued)+len(empty.Active)+len(empty.Skipped) != 0 {
		t.Fatal("explicit empty selection queued the whole library")
	}
	result := submitReparse(t, a, `{}`)
	if len(result.Queued) != 2 || len(result.Skipped) != 1 || result.Skipped[0].ID != missing.ID || !strings.Contains(result.Skipped[0].Error, "旧缓存已保留") {
		t.Fatalf("batch selection includes wrong entries: %+v", result)
	}
	waitReparse(t, a, one.ID, "ready")
	waitReparse(t, a, two.ID, "ready")
	if calls.Load() != 2 || !cacheExists(missing.result) || missing.Status != "ready" {
		t.Fatal("batch parsed unselected entries or removed missing-source cache")
	}
	for _, j := range a.jobs {
		if j.Name == "unselected.dem" && (j.Status != "discovered" || j.Reparse != nil) {
			t.Fatal("batch started an unparsed demo")
		}
	}
	for _, body := range []string{`null`, `{"ids":null}`, `{"ids":"all"}`, `{"ids":[2]}`, `{} {}`, `{"unknown":true}`} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/library/reparse", strings.NewReader(body))
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid request accepted: %s %d", body, w.Code)
		}
	}
}

func TestReparseZIPSourceRemainsIntact(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	old, archive, body := reparseFixture(t, a, 6, true)
	archiveHash := fileHash(t, archive)
	a.reparseParser = func(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
		actual, err := os.ReadFile(file)
		if err != nil || !bytes.Equal(actual, body) || !containedFile(a.root, file) {
			return nil, fmt.Errorf("ZIP member not supplied as a private snapshot")
		}
		return syntheticReparse(ctx, file, id, name, progress)
	}
	if response := submitReparse(t, a, reparseIDs(old.ID)); len(response.Queued) != 1 {
		t.Fatalf("ZIP could not reparse: %+v", response)
	}
	next := waitReparse(t, a, old.ID, "ready")
	if next.Revision == old.Revision || fileHash(t, archive) != archiveHash || len(a.sources) != 1 {
		t.Fatal("ZIP identity changed or original was modified")
	}
	if scan, err := a.scanLibrary(); err != nil || scan.Added != 0 || len(a.jobs) != 1 || a.jobs[old.ID] != next {
		t.Fatalf("refresh after ZIP reparse duplicated a demo: %+v %v", scan, err)
	}
}

func TestReparseInterruptedAndQueuedJobsRestoreOriginalCache(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	one, _, _ := reparseFixture(t, a, 7, false)
	two, _, _ := reparseFixture(t, a, 8, false)
	started := make(chan struct{})
	a.reparseParser = func(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if response := submitReparse(t, a, reparseIDs(one.ID, two.ID)); len(response.Queued) != 2 {
		t.Fatal(response)
	}
	waitReparseStart(t, started)
	a.close()
	reopened := persistentViewer(t, a.root, a.demoDir)
	for _, old := range []*job{one, two} {
		loaded := reopened.jobs[old.ID]
		if loaded == nil || loaded.Status != "ready" || loaded.Revision != old.Revision || !cacheExists(loaded.result) || !cacheExists(loaded.analysisResult) || loaded.Reparse == nil || loaded.Reparse.Status != "error" {
			t.Fatal("interruption replaced the old revision or resumed automatically")
		}
	}
	if len(reopened.pending) != 0 {
		t.Fatal("restart automatically resumed reparses")
	}
}

func TestReparseCrashManifestDiscardsOnlyStagedCaches(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	old, _, _ := reparseFixture(t, a, 9, false)
	revision := old.ID + "-1234567"
	old.Reparse = &reparseState{Status: "parsing", Revision: revision}
	partial, partialAnalysis := jobCachePaths(a.root, old.ID, revision)
	writeFixtureGzip(t, partial, map[string]string{"incomplete": "new"})
	writeFixtureGzip(t, partialAnalysis, map[string]string{"incomplete": "new"})
	a.close()
	reopened := persistentViewer(t, a.root, a.demoDir)
	loaded := reopened.jobs[old.ID]
	if loaded.Revision != old.Revision || loaded.Status != "ready" || loaded.Reparse.Status != "error" || cacheExists(partial) || cacheExists(partialAnalysis) || !cacheExists(loaded.result) || !cacheExists(loaded.analysisResult) {
		t.Fatal("crash recovery did not keep the last committed revision")
	}
}

func TestReparseCannotResurrectDeletedOrRefreshedJob(t *testing.T) {
	for _, mode := range []string{"delete", "refresh"} {
		t.Run(mode, func(t *testing.T) {
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			old, source, _ := reparseFixture(t, a, 10, false)
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			defer once.Do(func() { close(release) })
			a.reparseParser = func(ctx context.Context, file, id, name string, progress func(float64)) (*DemoData, error) {
				close(started)
				<-release // Deliberately finish after cancellation to test commit guards.
				return syntheticReparse(ctx, file, id, name, progress)
			}
			submitReparse(t, a, reparseIDs(old.ID))
			waitReparseStart(t, started)
			if mode == "delete" {
				if w := localRequest(a.handler(), "DELETE", "/api/library/demos/"+old.ID); w.Code != 204 {
					t.Fatal(w.Body.String())
				}
			} else {
				if err := os.WriteFile(source, []byte("PBDEMS2\x00changed-source-content"), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := a.scanLibrary(); err != nil {
					t.Fatal(err)
				}
			}
			once.Do(func() { close(release) })
			a.close()
			if mode == "delete" {
				if len(a.jobs) != 0 {
					t.Fatal("reparse resurrected a deleted job")
				}
			} else if current := a.jobs[old.ID]; current == nil || current == old || current.Status != "discovered" || current.Revision == old.Revision {
				t.Fatal("reparse overwrote a changed source discovered by refresh")
			}
			if _, err := os.Stat(source); err != nil {
				t.Fatal("race cleanup deleted the original")
			}
		})
	}
}
