package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLibraryRelocationPreservesSourcesCachesAndSettings(t *testing.T) {
	parent := t.TempDir()
	before, after := filepath.Join(parent, "old-version"), filepath.Join(parent, "new-version")
	root, demo := filepath.Join(before, "data"), filepath.Join(before, "demo")
	a := persistentViewer(t, root, demo)
	nested := filepath.Join(demo, "自定义赛事", "第二天")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	contents := []byte("PBDEMS2\x00portable-match")
	if err := os.WriteFile(filepath.Join(nested, "match.dem"), contents, 0600); err != nil {
		t.Fatal(err)
	}
	writeTestArchive(t, nested, "matches.zip", testArchiveMember{"inside/match.dem", contents, 0})
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	if len(a.jobs) != 1 || len(a.sources) != 2 {
		t.Fatal("fixture must have one unique demo and two sources")
	}
	var id string
	for _, j := range a.jobs {
		id = j.ID
		j.Status, j.Analysis = "ready", true
		writeFixtureGzip(t, j.result, map[string]any{"id": j.ID, "frames": []any{}})
		writeFixtureGzip(t, j.analysisResult, map[string]any{"id": j.ID, "series": []any{}})
		// Also exercise pending uploaded originals, which live under data.
		j.ownedSource = true
		j.source = filepath.Join(root, "upload.dem")
		if err := os.WriteFile(j.source, contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	a.sessionID = "portable-session"
	a.sessionSettings = json.RawMessage(`{"map":"de_anubis","aliases":{"team":"自定义队伍"},"selectedDemos":["` + id + `"],"selectedPlayers":["76561198000000001"]}`)
	wantSettings := append([]byte(nil), a.sessionSettings...)
	if err := a.persistLibrary(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "library.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest libraryManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Jobs[0].Source != "upload.dem" {
		t.Fatal("owned source not relative", manifest.Jobs[0].Source)
	}
	for _, source := range manifest.Sources {
		if filepath.IsAbs(source.Source) || !strings.HasPrefix(source.Source, "自定义赛事/第二天/") {
			t.Fatal("source is not portable", source.Source)
		}
	}
	cacheHash := fileHash(t, a.jobs[id].result)
	a.close()
	if err := os.Rename(before, after); err != nil {
		t.Fatal(err)
	}
	b := persistentViewer(t, filepath.Join(after, "data"), filepath.Join(after, "demo"))
	j := b.jobs[id]
	if j == nil || j.Status != "ready" || !j.Analysis || fileHash(t, j.result) != cacheHash {
		t.Fatal("relocation lost cached identity")
	}
	if !reflect.DeepEqual([]byte(b.sessionSettings), wantSettings) || b.sessionID != "portable-session" {
		t.Fatal("relocation changed filters or grouping")
	}
	if j.source != filepath.Join(after, "data", "upload.dem") {
		t.Fatal("owned source did not move", j.source)
	}
	for _, source := range b.sources {
		if !b.sourceAvailable(source) {
			t.Fatal("source unavailable after relocation", source.Source)
		}
	}
	scan, err := b.scanLibrary()
	if err != nil || scan.Added != 0 || scan.Queued != 0 || len(b.jobs) != 1 || len(b.pending) != 0 {
		t.Fatalf("relocation duplicated or parsed demos: %+v %v", scan, err)
	}
}

func TestLegacyAbsoluteLibrarySourcesBecomePortable(t *testing.T) {
	root, demo := t.TempDir(), t.TempDir()
	a := persistentViewer(t, root, demo)
	writeLocalDemo(t, demo, "match.dem")
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	manifest := a.libraryManifestLocked(nil)
	a.mu.Unlock()
	for i := range manifest.Jobs {
		manifest.Jobs[i].Source = filepath.Join(demo, "match.dem")
	}
	for i := range manifest.Sources {
		manifest.Sources[i].Source = filepath.Join(demo, "match.dem")
	}
	a.close()
	if err := a.writeLibraryManifest(manifest); err != nil {
		t.Fatal(err)
	}
	b := persistentViewer(t, root, demo)
	if len(b.jobs) != 1 || len(b.sources) != 1 {
		t.Fatal("legacy absolute manifest no longer loads")
	}
	if err := b.persistLibrary(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(root, "library.json"))
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Jobs[0].Source != "match.dem" || manifest.Sources[0].Source != "match.dem" {
		t.Fatal("legacy paths were not migrated")
	}
}

func TestRelativeLibraryPathsCannotEscapeConfiguredRoots(t *testing.T) {
	for _, binding := range []bool{false, true} {
		t.Run(map[bool]string{false: "job", true: "binding"}[binding], func(t *testing.T) {
			root, demo := t.TempDir(), t.TempDir()
			a := persistentViewer(t, root, demo)
			writeLocalDemo(t, demo, "match.dem")
			if _, err := a.scanLibrary(); err != nil {
				t.Fatal(err)
			}
			a.mu.Lock()
			manifest := a.libraryManifestLocked(nil)
			a.mu.Unlock()
			a.close()
			if binding {
				manifest.Sources[0].Source = "../outside.dem"
			} else {
				manifest.Jobs[0].Source = "../outside.dem"
			}
			if err := a.writeLibraryManifest(manifest); err != nil {
				t.Fatal(err)
			}
			if b, err := openLibrary(root, demo, libraryAssets(t)); err == nil {
				b.close()
				t.Fatal("relative path escaped its root")
			}
		})
	}
}
