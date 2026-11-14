package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requestCatalogParse(t *testing.T, a *app, id, mode string, status int) map[string]any {
	t.Helper()
	r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/library/demos/"+id+"/parse", strings.NewReader(`{"mode":"`+mode+`"}`))
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("parse %s: expected %d got %d: %s", id, status, w.Code, w.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func catalogListing(t *testing.T, a *app) []map[string]any {
	t.Helper()
	w := localRequest(a.handler(), "GET", "/api/library/demos")
	var result struct{ Demos []map[string]any }
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Demos
}

func TestRecursiveCatalogDiscoveryDeduplicatesWithoutParsing(t *testing.T) {
	demo := t.TempDir()
	data := filepath.Join(demo, "cache")
	a := persistentViewer(t, data, demo)
	nested := filepath.Join(demo, "competition", "rounds")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	one, two := []byte("PBDEMS2\x00one"), []byte("PBDEMS2\x00two")
	os.WriteFile(filepath.Join(demo, "root.dem"), one, 0600)
	os.WriteFile(filepath.Join(nested, "duplicate.dem"), one, 0600)
	writeTestArchive(t, nested, "matches.zip", testArchiveMember{"more/first.dem", one, 0}, testArchiveMember{"more/second.dem", two, 0})
	os.WriteFile(filepath.Join(data, "private.dem"), []byte("PBDEMS2\x00private"), 0600)
	scan, err := a.scanLibrary()
	if err != nil || scan.Added != 2 || scan.Queued != 0 || len(scan.Errors) != 0 {
		t.Fatalf("recursive scan: %+v %v", scan, err)
	}
	if len(a.jobs) != 2 || len(a.sources) != 4 || len(a.pending) != 0 {
		t.Fatal("wrong dedup count or parser unexpectedly queued")
	}
	var selected string
	for id, j := range a.jobs {
		if j.Status != "discovered" || j.Analysis {
			t.Fatal("unselected catalog entered analysis")
		}
		if j.Name == "second.dem" {
			selected = id
		}
	}
	if selected == "" {
		t.Fatal("nested ZIP member missing")
	}
	listing := catalogListing(t, a)
	if len(listing) != 2 {
		t.Fatal("catalog not exposed")
	}
	for _, item := range listing {
		if item["available"] != true {
			t.Fatal("present source reported unavailable")
		}
		for _, raw := range item["sources"].([]any) {
			source := raw.(map[string]any)
			if strings.Contains(source["path"].(string), "cache") {
				t.Fatal("cache scanned as original")
			}
		}
	}
	if body := localRequest(a.handler(), "GET", "/api/analyses").Body.String(); strings.Contains(body, selected) {
		t.Fatal("unselected discovery leaked into analysis list")
	}
	a.close()
	b := persistentViewer(t, data, demo)
	for _, j := range b.jobs {
		if j.Status != "discovered" {
			t.Fatal("restart parsed an unselected file")
		}
	}
	scan, err = b.scanLibrary()
	if err != nil || scan.Added != 0 || scan.Queued != 0 {
		t.Fatalf("restart changed catalog: %+v %v", scan, err)
	}
	requestCatalogParse(t, b, selected, "playback", 202)
	waitForTestJob(t, b.handler(), selected)
	for id, j := range b.jobs {
		j.mu.Lock()
		status, analysis := j.Status, j.Analysis
		j.mu.Unlock()
		if id == selected {
			if status != "error" || analysis {
				t.Fatal("selected invalid demo did not reach parser independently")
			}
		} else if status != "discovered" {
			t.Fatal("another discovered demo was parsed")
		}
	}
	requestCatalogParse(t, b, selected, "analysis", 202)
	waitForTestJob(t, b.handler(), selected)
	if !strings.Contains(localRequest(b.handler(), "GET", "/api/analyses").Body.String(), selected) {
		t.Fatal("explicit analysis selection not included")
	}
}

func TestReadyCatalogSelectionIsIdempotentAndPreservesAnalysisMode(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	one := seedReadyContent(t, a, 1, "old-analysis.dem", []byte("one"))
	two := seedReadyContent(t, a, 2, "replay-only.dem", []byte("two"))
	two.Analysis = false
	for i := 0; i < 2; i++ {
		response := requestCatalogParse(t, a, one.ID, "playback", 200)
		if response["cached"] != true || response["revision"] != one.Revision || response["analysis"] != true {
			t.Fatal("ready analysis was requeued or demoted")
		}
	}
	response := requestCatalogParse(t, a, two.ID, "playback", 200)
	if response["analysis"] != false {
		t.Fatal("playback automatically enrolled in analysis")
	}
	response = requestCatalogParse(t, a, two.ID, "analysis", 200)
	if response["analysis"] != true || response["cached"] != true {
		t.Fatal("ready replay not reused for analysis")
	}
	if len(a.pending) != 0 {
		t.Fatal("cached selection called parser")
	}
	for _, item := range catalogListing(t, a) {
		if item["available"] != true || item["sourceCount"] != float64(0) {
			t.Fatal("cache-only item lost availability")
		}
	}
}

func TestRepeatedPendingCatalogSelectionQueuesOnlyOnce(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j := seedReadyContent(t, a, 1, "pending.dem", []byte("body"))
	j.Status = "queued"
	j.Analysis = false
	for i := 0; i < 3; i++ {
		response := requestCatalogParse(t, a, j.ID, "playback", 202)
		if response["revision"] != j.Revision || response["cached"] != false {
			t.Fatal("pending job got a duplicate revision")
		}
	}
	requestCatalogParse(t, a, j.ID, "analysis", 202)
	if len(a.pending) != 0 || len(a.jobs) != 1 || !j.Analysis {
		t.Fatal("duplicate selection enqueued extra job")
	}
}

func TestCatalogChangedOrMissingSourcesRequireRefreshAndSelection(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	file := writeLocalDemo(t, a.demoDir, "source.dem")
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	var id, revision string
	for _, j := range a.jobs {
		id = j.ID
		revision = j.Revision
	}
	os.WriteFile(file, []byte("PBDEMS2\x00changed-content"), 0600)
	requestCatalogParse(t, a, id, "playback", 409)
	scan, err := a.scanLibrary()
	if err != nil || scan.Added != 0 || scan.Queued != 0 || len(a.jobs) != 1 {
		t.Fatalf("changed discovery: %+v %v", scan, err)
	}
	if a.jobs[id].Revision == revision || a.jobs[id].Status != "discovered" {
		t.Fatal("changed source auto parsed or lost ID")
	}
	os.Remove(file)
	requestCatalogParse(t, a, id, "analysis", 409)
	if item := catalogListing(t, a)[0]; item["available"] != false {
		t.Fatal("missing source available")
	}
	if a.jobs[id].Analysis {
		t.Fatal("failed selection altered analysis inclusion")
	}
}

func TestRecursiveCatalogSkipsLinksAndRejectsEscapingBindings(t *testing.T) {
	demo, outside := t.TempDir(), t.TempDir()
	a := persistentViewer(t, t.TempDir(), demo)
	file := writeLocalDemo(t, outside, "outside.dem")
	link := filepath.Join(demo, "external")
	if err := os.Symlink(outside, link); err == nil {
		if _, err := a.scanLibrary(); err != nil {
			t.Fatal(err)
		}
		if len(a.jobs) != 0 || safeSourcePath(demo, filepath.Join(link, "outside.dem")) {
			t.Fatal("linked tree was followed")
		}
	} else {
		t.Log("symlink creation unavailable; direct escape checks still run")
	}
	if safeSourcePath(demo, file) || validLibrarySource(demo, librarySource{Source: file, SourceSize: 1, SourceModTime: 1, MemberSize: 1, ContentSHA256: strings.Repeat("0", 64), JobID: strings.Repeat("1", 24)}) {
		t.Fatal("outside source accepted")
	}
	if w := localRequest(a.handler(), "POST", "/api/library/demos/missing/parse"); w.Code != 404 {
		t.Fatal("unknown ID accepted")
	}
}

func TestPersistentPlaybackUploadsCannotEvictCatalog(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	for i := 0; i < 8; i++ {
		writeLocalDemo(t, a.demoDir, fmt.Sprintf("unselected-%d.dem", i))
	}
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	old := seedReadyContent(t, a, 99, "cache-only.dem", []byte("cached"))
	old.Analysis = false
	old.catalog = true
	for i := 0; i < maxReplayHistory+1; i++ {
		id := acceptedDemoID(t, submitTestDemo(t, a.handler(), "uploaded.dem", []byte(fmt.Sprintf("PBDEMS2\x00unique-%d", i))))
		waitForTestJob(t, a.handler(), id)
	}
	if len(a.jobs) != 8+1+maxReplayHistory+1 || a.jobs[old.ID] != old {
		t.Fatal("ordinary playback evicted persistent catalog entries")
	}
	for _, j := range a.jobs {
		if strings.HasPrefix(j.Name, "unselected-") && j.Status != "discovered" {
			t.Fatal("manual upload parsed unrelated catalog")
		}
	}
}

func TestAnalysisDetachmentPreservesSharedCatalogAndLegacyDeleteIsBlocked(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	body := []byte("PBDEMS2\x00cached")
	j := seedReadyContent(t, a, 1, "shared.dem", body)
	file := filepath.Join(a.demoDir, "shared.dem")
	os.WriteFile(file, body, 0600)
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	if w := localRequest(a.handler(), "DELETE", "/api/analyses/"+j.ID); w.Code != 204 {
		t.Fatal(w.Body.String())
	}
	if j.Analysis || a.jobs[j.ID] != j || len(a.sources) != 1 || !cacheExists(j.result) || !cacheExists(j.analysisResult) || j.ctx.Err() != nil {
		t.Fatal("analysis detachment deleted or cancelled shared state")
	}
	if w := localRequest(a.handler(), "DELETE", "/api/demos/"+j.ID); w.Code != 409 {
		t.Fatal("legacy cancel can delete a shared catalog job")
	}
	a.close()
	b := persistentViewer(t, a.root, a.demoDir)
	if b.jobs[j.ID].Analysis || b.jobs[j.ID].Status != "ready" {
		t.Fatal("detachment not persisted")
	}
	requestCatalogParse(t, b, j.ID, "playback", 200)
	if w := localRequest(b.handler(), "DELETE", "/api/library/demos/"+j.ID); w.Code != 204 {
		t.Fatal("explicit library deletion failed")
	}
	if len(b.jobs) != 0 || len(b.sources) != 0 || !regularDemo(file) {
		t.Fatal("explicit deletion did not preserve original file")
	}
}

func TestPersistentUploadReusesCatalogContentAndReportsSharedOwnership(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	body := []byte("PBDEMS2\x00known-content")
	ready := seedReadyContent(t, a, 1, "known.dem", body)
	ready.Analysis = false
	response := analysisUpload(t, a.handler(), "renamed-upload.dem", body)
	if id := acceptedDemoID(t, response); id != ready.ID {
		t.Fatal("same content got a new analysis identity")
	}
	var uploaded struct{ Shared bool }
	json.Unmarshal(response.Body.Bytes(), &uploaded)
	if !uploaded.Shared || !ready.Analysis || ready.Status != "ready" || len(a.jobs) != 1 {
		t.Fatal("shared ready upload reparsed or was not marked shared")
	}
	response = submitTestDemo(t, a.handler(), "replay.dem", body)
	if acceptedDemoID(t, response) != ready.ID || !ready.Analysis {
		t.Fatal("replay upload demoted existing analysis")
	}
	other := []byte("PBDEMS2\x00discovered-content")
	file := filepath.Join(a.demoDir, "pending.dem")
	os.WriteFile(file, other, 0600)
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	var discoveredID string
	for id, j := range a.jobs {
		if j.Status == "discovered" {
			discoveredID = id
		}
	}
	if discoveredID == "" {
		t.Fatal("missing catalog discovery")
	}
	os.Remove(file) // An explicit upload supplies verified bytes when an old origin moved.
	response = submitTestDemo(t, a.handler(), "upload-source.dem", other)
	if acceptedDemoID(t, response) != discoveredID {
		t.Fatal("discovered content duplicated by upload")
	}
	json.Unmarshal(response.Body.Bytes(), &uploaded)
	if !uploaded.Shared {
		t.Fatal("new selected shared ID treated as private upload")
	}
	waitForTestJob(t, a.handler(), discoveredID)
	j := a.jobs[discoveredID]
	j.mu.Lock()
	status, errorMessage, analysis := j.Status, j.Error, j.Analysis
	j.mu.Unlock()
	if status != "error" || analysis || strings.Contains(errorMessage, "原始录像") {
		t.Fatal("fresh upload did not supply the missing origin to parser")
	}
	if len(a.jobs) != 2 {
		t.Fatal("upload dedup changed catalog cardinality")
	}
	response = submitTestDemo(t, a.handler(), "new.dem", []byte("PBDEMS2\x00brand-new"))
	json.Unmarshal(response.Body.Bytes(), &uploaded)
	if !uploaded.Shared {
		t.Fatal("persistent new upload must also be protected from cancel deletion")
	}
	waitForTestJob(t, a.handler(), acceptedDemoID(t, response))
}
