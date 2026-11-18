package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func requestDirectory(t *testing.T, a *app, dir string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"directory": dir})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/library/directory", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://127.0.0.1:8765")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}

// Windows temporary directories can use their 8.3 alias. The API may return
// their canonical path. An offline folder must still match its saved name.
func responsesReferToDirectory(got, want string) bool {
	if got == want {
		return true
	}
	actual, err := os.Stat(got)
	expected, wantErr := os.Stat(want)
	return err == nil && wantErr == nil && os.SameFile(actual, expected)
}

func waitForDirectory(t *testing.T, a *app, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		w := localRequest(a.handler(), "GET", "/api/library")
		var info struct {
			Directory string
			Scanning  bool
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &info) != nil || !responsesReferToDirectory(info.Directory, want) {
			t.Fatalf("expected directory %q, got %d %s", want, w.Code, w.Body.String())
		}
		if !info.Scanning {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("scan of %q did not finish", want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func applyTestDirectory(t *testing.T, a *app, dir string) {
	t.Helper()
	w := requestDirectory(t, a, dir)
	if w.Code != http.StatusOK && w.Code != http.StatusAccepted {
		t.Fatalf("change directory: %d %s", w.Code, w.Body.String())
	}
	var reply struct{ Directory string }
	if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil || !responsesReferToDirectory(reply.Directory, dir) {
		t.Fatalf("switch response omitted directory %q: %s", dir, w.Body.String())
	}
	waitForDirectory(t, a, dir)
}

func TestLibraryDirectorySwitchSeparatesSourcesAndSurvivesRestart(t *testing.T) {
	data, first := t.TempDir(), t.TempDir()
	a := persistentViewer(t, data, first)
	old, original, contents := reparseFixture(t, a, 1, false)
	second := filepath.Join(t.TempDir(), "战队 比赛录像")
	if err := os.Mkdir(second, 0700); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(second, filepath.Base(original))
	nextContents := bytes.Clone(contents)
	nextContents[len(nextContents)-1] ^= 1
	if err := os.WriteFile(other, nextContents, 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(original)
	if err != nil {
		t.Fatal(err)
	}
	// Identical relative path, size and timestamp must not reuse the old recording.
	if err := os.Chtimes(other, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	originalHash, otherHash, cacheHash := fileHash(t, original), fileHash(t, other), fileHash(t, old.result)
	applyTestDirectory(t, a, second)
	var newID string
	for _, item := range catalogListing(t, a) {
		id := item["id"].(string)
		for _, origin := range item["sources"].([]any) {
			source := origin.(map[string]any)
			if source["available"] != true || source["path"] != filepath.Base(other) {
				continue
			}
			if id == old.ID || item["status"] != "discovered" || newID != "" {
				t.Fatalf("new directory's recording was aliased, parsed, or duplicated: %v", item)
			}
			newID = id
		}
	}
	if newID == "" {
		t.Fatal("switch did not automatically discover the new file")
	}
	a.close()
	b := persistentViewer(t, data, first)
	waitForDirectory(t, b, second)
	replay := localRequest(b.handler(), "GET", "/api/demos/"+old.ID)
	if replay.Code != http.StatusOK || fileHash(t, old.result) != cacheHash {
		t.Fatalf("old cached replay not preserved, status %d", replay.Code)
	}
	if b.jobs[newID] == nil || b.jobs[newID].contentSHA256 != otherHash {
		t.Fatal("new recording's identity did not survive restart")
	}
	applyTestDirectory(t, b, first)
	if len(b.sourcesForJob(old.ID)) != 1 || !b.sourceAvailable(b.sourcesForJob(old.ID)[0]) {
		t.Fatal("switching back did not reconnect the original file with its cached replay")
	}
	if fileHash(t, original) != originalHash || fileHash(t, other) != otherHash {
		t.Fatal("changing directories modified a user's original")
	}
}

func TestLibraryDirectoryRejectsInvalidSelectionWithoutChangingLibrary(t *testing.T) {
	data, old := t.TempDir(), t.TempDir()
	a := persistentViewer(t, data, old)
	file := writeLocalDemo(t, old, "match.dem")
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "missing")
	for _, dir := range []string{"", "relative-path", file, missing} {
		w := requestDirectory(t, a, dir)
		var problem struct{ Error string }
		if w.Code < 400 || w.Code >= 500 || json.Unmarshal(w.Body.Bytes(), &problem) != nil || problem.Error == "" {
			t.Fatalf("expected client error for %q, got %d %s", dir, w.Code, w.Body.String())
		}
		waitForDirectory(t, a, old)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("choosing a missing directory must not create it")
	}
	a.close()
	b := persistentViewer(t, data, old)
	waitForDirectory(t, b, old)
	if len(catalogListing(t, b)) != 1 {
		t.Fatal("invalid request changed the persisted catalog")
	}
}

func TestLibraryDirectoryOfflineAndExplicitStartupOverride(t *testing.T) {
	data, initial := t.TempDir(), t.TempDir()
	a := persistentViewer(t, data, initial)
	drive := filepath.Join(t.TempDir(), "external-drive")
	if err := os.Mkdir(drive, 0700); err != nil {
		t.Fatal(err)
	}
	drive, err := filepath.EvalSymlinks(drive)
	if err != nil {
		t.Fatal(err)
	}
	applyTestDirectory(t, a, drive)
	a.close()
	if err := os.Remove(drive); err != nil {
		t.Fatal(err)
	}
	b := persistentViewer(t, data, initial)
	waitForDirectory(t, b, drive)
	if _, err := os.Stat(drive); !os.IsNotExist(err) {
		t.Fatal("startup unexpectedly recreated an offline source directory")
	}
	b.close()
	override := t.TempDir()
	c, err := openLibraryWithOverride(data, initial, libraryAssets(t), override)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.close)
	waitForDirectory(t, c, override)
}

func TestLibraryDirectoryChangeCanRetryAfterWriteFailure(t *testing.T) {
	data, old, next := t.TempDir(), t.TempDir(), t.TempDir()
	a := persistentViewer(t, data, old)
	writeLocalDemo(t, old, "original.dem")
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(data, "library.json")
	if err := os.Rename(manifest, manifest+".bak"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(manifest, 0700); err != nil {
		t.Fatal(err)
	}
	w := requestDirectory(t, a, next)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected a failed manifest write, got %d", w.Code)
	}
	waitForDirectory(t, a, old)
	if items := catalogListing(t, a); len(items) != 1 || items[0]["available"] != true {
		t.Fatal("failed write detached the original catalog")
	}
	if err := os.Remove(manifest); err != nil {
		t.Fatal(err)
	}
	applyTestDirectory(t, a, next)
}

func TestLibraryDirectoryRefusesChangeDuringReparse(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	a := persistentViewer(t, t.TempDir(), first)
	j, _, _ := reparseFixture(t, a, 1, false)
	ready := make(chan struct{})
	release := make(chan struct{})
	a.reparseParser = func(ctx context.Context, path, id, name string, progress func(float64)) (*DemoData, error) {
		close(ready)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return syntheticReparse(ctx, path, id, name, progress)
		}
	}
	result := submitReparse(t, a, reparseIDs(j.ID))
	if len(result.Queued) != 1 {
		t.Fatalf("could not start reparse: %+v", result)
	}
	waitReparseStart(t, ready)
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() { response <- requestDirectory(t, a, second) }()
	select {
	case w := <-response:
		if w.Code != http.StatusConflict {
			t.Fatalf("expected busy conflict, got %d %s", w.Code, w.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("directory change blocked on the active parser")
	}
	waitForDirectory(t, a, first)
	if w := localRequest(a.handler(), "GET", "/api/demos/"+j.ID); w.Code != http.StatusOK {
		t.Fatal("switch attempt made the active replay unavailable")
	}
	close(release)
	waitReparse(t, a, j.ID, "ready")
	applyTestDirectory(t, a, second)
}
