package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func libraryAssets(t *testing.T) fs.FS {
	t.Helper()
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		t.Fatal(err)
	}
	return assets
}
func persistentViewer(t *testing.T, root, demo string) *app {
	t.Helper()
	a, err := openLibrary(root, demo, libraryAssets(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.close)
	return a
}
func fileHash(t *testing.T, path string) string {
	t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func writeFixtureGzip(t *testing.T, path string, value any) {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	if err := json.NewEncoder(gz).Encode(value); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}
func sessionFixture(t *testing.T, count int) (string, sessionManifest) {
	t.Helper()
	dir := t.TempDir()
	m := sessionManifest{Version: 1, ID: "test-migration", Settings: json.RawMessage(`{"map":"de_ancient","aliases":{"source":"Merged Team"},"selectedDemos":[]}`)}
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("%024x", i+1)
		d := sessionDemo{ID: id, Name: fmt.Sprintf("match-%d.dem", i), Map: "de_ancient"}
		value := map[string]any{"id": id, "name": d.Name, "map": d.Map, "players": []any{}, "frames": []any{}, "series": []any{}}
		for _, suffix := range []string{".json.gz", ".analysis.json.gz"} {
			writeFixtureGzip(t, filepath.Join(dir, id+suffix), value)
		}
		d.ReplaySHA256 = fileHash(t, filepath.Join(dir, id+".json.gz"))
		d.AnalysisSHA256 = fileHash(t, filepath.Join(dir, id+".analysis.json.gz"))
		m.Demos = append(m.Demos, d)
	}
	return dir, m
}
func writeSessionManifest(t *testing.T, dir string, m sessionManifest) string {
	t.Helper()
	b, e := json.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "session.json")
	if e = os.WriteFile(path, b, 0600); e != nil {
		t.Fatal(e)
	}
	return path
}
func writeLocalDemo(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if e := os.WriteFile(path, []byte("PBDEMS2\x00invalid-payload-"+name), 0600); e != nil {
		t.Fatal(e)
	}
	past := time.Now().Add(-time.Hour)
	if e := os.Chtimes(path, past, past); e != nil {
		t.Fatal(e)
	}
	return path
}

func TestLibraryDefaultsAndExclusiveOwnership(t *testing.T) {
	base := t.TempDir()
	demo, data := installationDirectories(filepath.Join(base, "bin", "viewer.exe"))
	if demo != filepath.Join(base, "demo") || data != filepath.Join(base, "data") {
		t.Fatal(demo, data)
	}
	demo2, data2 := installationDirectories(filepath.Join(base, "viewer.exe"))
	if demo2 != demo || data2 != data {
		t.Fatal("flat binary defaults differ")
	}
	a := persistentViewer(t, data, demo)
	if other, err := openLibrary(data, demo, libraryAssets(t)); err == nil {
		other.close()
		t.Fatal("two instances acquired the same data directory")
	}
	a.close()
	reopened := persistentViewer(t, data, demo)
	if len(reopened.jobs) != 0 {
		t.Fatal("unexpected jobs")
	}
}

func TestRestoreMoreThanTenAndPersistentRestart(t *testing.T) {
	dir, m := sessionFixture(t, 13)
	root, demoDir := t.TempDir(), t.TempDir()
	a := persistentViewer(t, root, demoDir)
	path := writeSessionManifest(t, dir, m)
	if err := a.restoreSession(path); err != nil {
		t.Fatal(err)
	}
	if err := a.persistLibrary(); err != nil {
		t.Fatal(err)
	}
	response := localRequest(a.handler(), "GET", "/api/analyses")
	var listing struct {
		Demos    []struct{ ID string }
		MaxDemos int
	}
	if e := json.Unmarshal(response.Body.Bytes(), &listing); e != nil {
		t.Fatal(e)
	}
	if len(listing.Demos) != 13 || listing.MaxDemos != 0 {
		t.Fatalf("not unlimited: %s", response.Body.String())
	}
	for i, d := range listing.Demos {
		if d.ID != m.Demos[i].ID {
			t.Fatal("order changed")
		}
	}
	settings := localRequest(a.handler(), "GET", "/api/session-settings")
	if !strings.Contains(settings.Body.String(), "Merged Team") {
		t.Fatal("settings missing")
	}
	a.close()
	b := persistentViewer(t, root, demoDir)
	if len(b.jobs) != 13 {
		t.Fatal("restart lost jobs")
	}
	for _, j := range b.jobs {
		if j.Status != "ready" || !cacheExists(j.result) {
			t.Fatal("restored cache was reparsed or removed")
		}
	}
	if err := b.restoreSession(path); err != nil {
		t.Fatal("same migration must be idempotent", err)
	}
	localRequest(b.handler(), "DELETE", "/api/demos/"+m.Demos[0].ID)
	b.close()
	c := persistentViewer(t, root, demoDir)
	if len(c.jobs) != 12 {
		t.Fatal("deletion was not persisted")
	}
	if err := c.restoreSession(path); err != nil {
		t.Fatal(err)
	}
	if len(c.jobs) != 12 {
		t.Fatal("repeat restore resurrected deletion")
	}
	if !cacheExists(filepath.Join(dir, m.Demos[0].ID+".json.gz")) {
		t.Fatal("backup was deleted")
	}
}

func TestRestoreFailureIsAtomicAndValidatesContent(t *testing.T) {
	for _, variant := range []string{"missing", "digest", "gzip", "identity", "path", "duplicate"} {
		t.Run(variant, func(t *testing.T) {
			dir, m := sessionFixture(t, 2)
			target := filepath.Join(dir, m.Demos[1].ID+".analysis.json.gz")
			switch variant {
			case "missing":
				os.Remove(target)
			case "digest":
				m.Demos[1].AnalysisSHA256 = strings.Repeat("0", 64)
			case "gzip":
				os.WriteFile(target, []byte("bad gzip"), 0600)
				m.Demos[1].AnalysisSHA256 = fileHash(t, target)
			case "identity":
				writeFixtureGzip(t, target, map[string]string{"id": m.Demos[0].ID, "name": m.Demos[1].Name, "map": m.Demos[1].Map})
				m.Demos[1].AnalysisSHA256 = fileHash(t, target)
			case "path":
				m.Demos[1].ID = "../../outside"
			case "duplicate":
				m.Demos[1].ID = m.Demos[0].ID
			}
			a, _ := testViewer(t)
			if err := a.restoreSession(writeSessionManifest(t, dir, m)); err == nil {
				t.Fatal("invalid restore accepted")
			}
			if len(a.jobs) != 0 {
				t.Fatal("partial jobs registered")
			}
			files, _ := os.ReadDir(a.root)
			if len(files) != 0 {
				t.Fatal("partial cache copies remained")
			}
		})
	}
}

func TestBoundFolderFilesDoNotDuplicateMigratedJobs(t *testing.T) {
	dir, m := sessionFixture(t, 12)
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	for i := range m.Demos {
		d := &m.Demos[i]
		path := writeLocalDemo(t, a.demoDir, d.Name)
		info, _ := os.Stat(path)
		d.SourceFile = d.Name
		d.SourceSize = info.Size()
		d.SourceModTime = info.ModTime().UnixNano()
		d.SourceSHA256 = fileHash(t, path)
	}
	if err := a.restoreSession(writeSessionManifest(t, dir, m)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		scan, err := a.scanLibrary()
		if err != nil {
			t.Fatal(err)
		}
		if scan.Added != 0 || scan.Queued != 0 || scan.Unchanged != 12 {
			t.Fatalf("duplicate scan: %+v", scan)
		}
	}
	for _, j := range a.jobs {
		if j.Status != "ready" {
			t.Fatal("bound cache was needlessly parsed")
		}
	}
	first := m.Demos[0]
	localRequest(a.handler(), "DELETE", "/api/demos/"+first.ID)
	if !regularDemo(filepath.Join(a.demoDir, first.Name)) {
		t.Fatal("removal deleted user demo")
	}
}

func TestScanIgnoresArchivesAndRetriesChangedOrFailedFiles(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	path := writeLocalDemo(t, a.demoDir, "match.dem")
	os.WriteFile(filepath.Join(a.demoDir, "archive.zip"), []byte("not a demo"), 0600)
	os.Mkdir(filepath.Join(a.demoDir, "folder.dem"), 0700)
	scan, err := a.scanLibrary()
	if err != nil || scan.Added != 1 {
		t.Fatalf("scan=%+v %v", scan, err)
	}
	var id, revision string
	a.mu.Lock()
	for _, j := range a.jobs {
		id = j.ID
		revision = j.Revision
	}
	a.mu.Unlock()
	waitForTestJob(t, a.handler(), id)
	if !regularDemo(path) {
		t.Fatal("failed parser removed original")
	}
	scan, err = a.scanLibrary()
	if err != nil || scan.Added != 0 || scan.Queued != 1 {
		t.Fatalf("retry=%+v %v", scan, err)
	}
	waitForTestJob(t, a.handler(), id)
	a.mu.Lock()
	j := a.jobs[id]
	a.mu.Unlock()
	if j.Revision == revision {
		t.Fatal("retry did not change revision")
	}
	if filepath.Base(j.result) == id+".json.gz" {
		t.Fatal("new revision shares old cache path")
	}
	a.close()
	b := persistentViewer(t, a.root, a.demoDir)
	if len(b.jobs) != 1 {
		t.Fatal("failed library record lost")
	}
	if localRequest(b.handler(), "GET", "/api/library").Code != 200 {
		t.Fatal("library metadata unavailable")
	}
	if !regularDemo(path) {
		t.Fatal("close deleted user demo")
	}
}

func TestFolderScanQueuesMoreThanTenWithoutDuplicateIDs(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	for i := 0; i < 13; i++ {
		writeLocalDemo(t, a.demoDir, fmt.Sprintf("folder-%02d.dem", i))
	}
	scan, err := a.scanLibrary()
	if err != nil || scan.Added != 13 || scan.Queued != 13 {
		t.Fatalf("scan %+v: %v", scan, err)
	}
	a.mu.Lock()
	ids := make([]string, 0, len(a.jobs))
	for id := range a.jobs {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	if len(ids) != 13 {
		t.Fatal("folder scan retained a ten-demo ceiling")
	}
	for _, id := range ids {
		waitForTestJob(t, a.handler(), id)
	}
	scan, err = a.scanLibrary()
	if err != nil || scan.Added != 0 {
		t.Fatalf("retry duplicated jobs: %+v %v", scan, err)
	}
	a.mu.Lock()
	count := len(a.jobs)
	a.mu.Unlock()
	if count != 13 {
		t.Fatal("retry changed library cardinality")
	}
}

func TestSnapshotIsPrivateAndRejectsChangedSource(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	path := writeLocalDemo(t, a.demoDir, "source.dem")
	info, _ := os.Stat(path)
	j := &job{source: path, sourceSize: info.Size(), sourceModTime: info.ModTime().UnixNano(), ctx: a.ctx}
	copyPath, cleanup, err := a.snapshotDemo(j)
	if err != nil {
		t.Fatal(err)
	}
	if copyPath == path || !containedFile(a.root, copyPath) {
		t.Fatal("parser received original path")
	}
	cleanup()
	if !regularDemo(path) {
		t.Fatal("snapshot cleanup deleted source")
	}
	os.WriteFile(path, []byte("changed"), 0600)
	if _, cleanup, err = a.snapshotDemo(j); err == nil {
		cleanup()
		t.Fatal("changed source accepted")
	}
}

func TestPersistentUploadRestoresInterruptedQueueAndRejectsEscapingManifest(t *testing.T) {
	root, demoDir := t.TempDir(), t.TempDir()
	id := fmt.Sprintf("%024x", 99)
	source := writeLocalDemo(t, root, "upload-test.dem")
	m := libraryManifest{Version: 1, Jobs: []libraryRecord{{ID: id, Name: "uploaded.dem", Analysis: true, Status: "parsing", Source: source, OwnedSource: true, Created: time.Now()}}}
	data, _ := json.Marshal(m)
	os.WriteFile(filepath.Join(root, "library.json"), data, 0600)
	a := persistentViewer(t, root, demoDir)
	waitForTestJob(t, a.handler(), id)
	deadline := time.Now().Add(time.Second)
	for {
		_, err := os.Stat(source)
		if os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completed upload retained its private source")
		}
		time.Sleep(time.Millisecond)
	}
	a.close()
	m.Jobs[0].Source = filepath.Join(t.TempDir(), "outside.dem")
	data, _ = json.Marshal(m)
	os.WriteFile(filepath.Join(root, "library.json"), data, 0600)
	if invalid, err := openLibrary(root, demoDir, libraryAssets(t)); err == nil {
		invalid.close()
		t.Fatal("manifest source traversal accepted")
	}
}
