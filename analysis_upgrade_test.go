package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// A restored same-size fixture can retain its previous modification timestamp
// after a rapid rewrite on Windows. Immediate retry is deliberately keyed by
// file metadata, so model an observable cache replacement instead of relying on
// wall-clock resolution. Keep the unchanged-fingerprint throttle tests intact.
func restoreChangedAnalysisReplay(t *testing.T, path string, value any, previous analysisCacheFingerprint) {
	t.Helper()
	writeFixtureGzip(t, path, value)
	modified := time.Unix(0, previous.Modified).Add(2 * time.Second)
	if !previous.Exists {
		modified = time.Now().Add(2 * time.Second)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	current := analysisFingerprint(path)
	if !current.Exists || current == previous {
		t.Fatalf("restored replay must change its fingerprint: before=%+v after=%+v", previous, current)
	}
}

func legacyAnalysisFixture(t *testing.T, a *app, id string) (*job, *DemoData, map[string]json.RawMessage) {
	t.Helper()
	j, _ := statisticsFixture(t, a, id, id, "legacy.dem")
	d := utilityTimingFixture()
	d.ID, d.Name = id, j.Name
	j.Analysis, j.Map = true, d.Map
	writeFixtureGzip(t, j.result, d)
	body, _ := json.Marshal(BuildAnalysis(d))
	var summary map[string]json.RawMessage
	if err := json.Unmarshal(body, &summary); err != nil {
		t.Fatal(err)
	}
	delete(summary, "utilityTimingVersion")
	summary["futureMetadata"] = json.RawMessage(`{"preserve":[1,"two",true]}`)
	var utilities []map[string]json.RawMessage
	json.Unmarshal(summary["utilities"], &utilities)
	for _, utility := range utilities {
		delete(utility, "roundElapsed")
		delete(utility, "timeSource")
		utility["futureUtilityField"] = json.RawMessage(`"retained"`)
	}
	summary["utilities"], _ = json.Marshal(utilities)
	writeFixtureGzip(t, j.analysisResult, summary)
	return j, d, summary
}

func readAnalysisResponse(t *testing.T, w *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("analysis response %d: %s", w.Code, w.Body.String())
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func assertAnalysisTimingOnlyPatch(t *testing.T, before, after map[string]json.RawMessage, known bool) {
	t.Helper()
	for key, raw := range before {
		if key == "utilities" || key == "warnings" {
			continue
		}
		var old, next any
		json.Unmarshal(raw, &old)
		json.Unmarshal(after[key], &next)
		if !reflect.DeepEqual(old, next) {
			t.Fatalf("unrelated summary field changed: %s", key)
		}
	}
	var oldUtilities, newUtilities []map[string]json.RawMessage
	json.Unmarshal(before["utilities"], &oldUtilities)
	json.Unmarshal(after["utilities"], &newUtilities)
	if len(oldUtilities) != len(newUtilities) {
		t.Fatal("upgrade changed the number of utilities")
	}
	for i, utility := range newUtilities {
		for key, raw := range oldUtilities[i] {
			var old, next any
			json.Unmarshal(raw, &old)
			json.Unmarshal(utility[key], &next)
			if !reflect.DeepEqual(old, next) {
				t.Fatalf("utility %d lost existing field %s", i, key)
			}
		}
		var observed bool
		json.Unmarshal(utility["throwObserved"], &observed)
		if known && observed {
			if string(utility["roundElapsed"]) == "null" || string(utility["timeSource"]) != `"freeze_end"` {
				t.Fatal("valid throw timing was not upgraded")
			}
		} else if string(utility["roundElapsed"]) != "null" || string(utility["timeSource"]) != `"unknown"` {
			t.Fatal("unrecoverable timing was not kept unknown")
		}
	}
}

func TestAnalysisTimingUpgradePreservesIdentitiesAndPersistsOnce(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, _, old := legacyAnalysisFixture(t, a, "000000000000000000000011")
	a.sessionSettings = json.RawMessage(`{"aliases":{"first":"merged"},"selectedDemos":["kept"],"selectedPlayers":["person"]}`)
	if err := a.persistLibrary(); err != nil {
		t.Fatal(err)
	}
	manifestHash := fileHash(t, filepath.Join(a.root, "library.json"))
	replayHash, oldRevision := fileHash(t, j.result), j.Revision
	responses := make(chan *httptest.ResponseRecorder, 8)
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			responses <- localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis")
		}()
	}
	wait.Wait()
	close(responses)
	for response := range responses {
		upgraded := readAnalysisResponse(t, response)
		if string(upgraded["utilityTimingVersion"]) != "1" {
			t.Fatal("upgrade marker missing")
		}
		assertAnalysisTimingOnlyPatch(t, old, upgraded, true)
	}
	if j.Revision != oldRevision || a.jobs[j.ID] != j || !j.Analysis || len(a.pending) != 0 || fileHash(t, j.result) != replayHash || fileHash(t, filepath.Join(a.root, "library.json")) != manifestHash {
		t.Fatal("lazy upgrade changed library identity, settings or full replay")
	}
	upgradedHash := fileHash(t, j.analysisResult)
	// A current marker must make future reads independent of full replay data.
	if err := os.WriteFile(j.result, []byte("full cache deliberately unavailable"), 0600); err != nil {
		t.Fatal(err)
	}
	readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	if fileHash(t, j.analysisResult) != upgradedHash {
		t.Fatal("a completed upgrade was recomputed")
	}
	a.close()
	reopened := persistentViewer(t, a.root, a.demoDir)
	readAnalysisResponse(t, localRequest(reopened.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	if reopened.jobs[j.ID].Revision != oldRevision || fileHash(t, j.analysisResult) != upgradedHash {
		t.Fatal("timing upgrade was not retained across restart")
	}
}

func TestAnalysisTimingUpgradeFailureKeepsLegacySummaryReadable(t *testing.T) {
	for _, variant := range []string{"missing", "gzip", "crc", "identity"} {
		t.Run(variant, func(t *testing.T) {
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			j, replay, old := legacyAnalysisFixture(t, a, "000000000000000000000012")
			originalHash := fileHash(t, j.analysisResult)
			switch variant {
			case "missing":
				if err := os.Remove(j.result); err != nil {
					t.Fatal(err)
				}
			case "gzip":
				if err := os.WriteFile(j.result, []byte("invalid gzip"), 0600); err != nil {
					t.Fatal(err)
				}
			case "crc":
				raw, err := os.ReadFile(j.result)
				if err != nil {
					t.Fatal(err)
				}
				raw[len(raw)-8] ^= 1
				if err := os.WriteFile(j.result, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "identity":
				replay.ID = "wrong-demo"
				writeFixtureGzip(t, j.result, replay)
			}
			first := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			assertAnalysisTimingOnlyPatch(t, old, first, false)
			if !strings.Contains(string(first["warnings"]), "时机未知") || fileHash(t, j.analysisResult) != originalHash {
				t.Fatal("upgrade failure hid the warning or overwrote the old summary")
			}
			failure := a.analysisUpgradeFailures[j.ID]
			second := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			assertAnalysisTimingOnlyPatch(t, old, second, false)
			if a.analysisUpgradeFailures[j.ID].At != failure.At {
				t.Fatal("unchanged failed full cache was decoded again on the next request")
			}
			// Restoring the existing replay cache allows a retry without reimport,
			// new IDs/revisions, or running the DEM parser.
			replay.ID = j.ID
			restoreChangedAnalysisReplay(t, j.result, replay, failure.Replay)
			fixed := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			assertAnalysisTimingOnlyPatch(t, old, fixed, true)
		})
	}
}

func TestAnalysisTimingUpgradeWriteFailurePreservesOriginalOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows sharing locks are required for this write-failure fixture")
	}
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, _, old := legacyAnalysisFixture(t, a, "000000000000000000000013")
	before := fileHash(t, j.analysisResult)
	file, err := os.Open(j.analysisResult)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	response := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	assertAnalysisTimingOnlyPatch(t, old, response, false)
	if fileHash(t, j.analysisResult) != before {
		t.Fatal("failed atomic replacement damaged the previous summary")
	}
}

func TestAnalysisTimingUpgradeRejectsChangedRevisionBeforeCommit(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, replay, summary := legacyAnalysisFixture(t, a, "000000000000000000000014")
	oldHash := fileHash(t, j.analysisResult)
	snapshot := analysisUpgradeSnapshot{job: j, id: j.ID, revision: j.Revision, replay: j.result, summary: j.analysisResult, mapName: j.Map}
	if err := patchAnalysisUtilityTiming(summary, &analysisTimingReplay{ID: replay.ID, Map: replay.Map, Rounds: replay.Rounds, Utilities: replay.Utilities}); err != nil {
		t.Fatal(err)
	}
	next, _ := statisticsFixture(t, a, j.ID, j.ID+"-123", "replacement.dem")
	j.cancel()
	nextHash := fileHash(t, next.analysisResult)
	if err := a.commitAnalysisTiming(context.Background(), snapshot, analysisFingerprint(j.analysisResult), summary); err != errAnalysisUpgradeStale {
		t.Fatalf("stale upgrade was committed: %v", err)
	}
	if fileHash(t, j.analysisResult) != oldHash || fileHash(t, next.analysisResult) != nextHash {
		t.Fatal("stale upgrade modified either revision")
	}
}

func TestAnalysisTimingWaitingUpgradeDoesNotSurviveRemovalOrCancellation(t *testing.T) {
	for _, mode := range []string{"remove", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			j, _, _ := legacyAnalysisFixture(t, a, "000000000000000000000015")
			a.analysisUpgradeGate <- struct{}{}
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx := &observedStatisticsContext{Context: parent, entered: make(chan struct{})}
			r := httptest.NewRequest("GET", "http://127.0.0.1:8765/api/demos/"+j.ID+"/analysis", nil).WithContext(ctx)
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { a.handler().ServeHTTP(w, r); close(done) }()
			select {
			case <-ctx.entered:
			case <-time.After(3 * time.Second):
				<-a.analysisUpgradeGate
				t.Fatal("request did not start waiting for upgrade gate")
			}
			if mode == "remove" {
				localRequest(a.handler(), "DELETE", "/api/library/demos/"+j.ID)
			} else {
				cancel()
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				<-a.analysisUpgradeGate
				t.Fatal("canceled upgrade did not release its wait")
			}
			if len(a.analysisUpgradeGate) != 1 || len(a.analysisUpgradeFailures) != 0 {
				t.Fatal("canceled waiter released another request's gate or read replay data")
			}
			<-a.analysisUpgradeGate
			if mode == "remove" && w.Code != 409 {
				t.Fatalf("removed job was served: %d", w.Code)
			}
			if mode == "cancel" {
				if !bytes.Equal(w.Body.Bytes(), nil) {
					t.Fatal("canceled request generated an analysis response")
				}
				readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			}
		})
	}
}
