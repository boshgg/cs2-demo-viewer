package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testArchiveMember struct {
	name string
	data []byte
	mode os.FileMode
}

func writeTestArchive(t *testing.T, dir, name string, members ...testArchiveMember) string {
	t.Helper()
	var buffer bytes.Buffer
	w := zip.NewWriter(&buffer)
	for _, item := range members {
		header := &zip.FileHeader{Name: item.name, Method: zip.Store}
		if item.mode != 0 {
			header.SetMode(item.mode)
		}
		member, err := w.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = member.Write(item.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func seedReadyContent(t *testing.T, a *app, number int, name string, content []byte) *job {
	t.Helper()
	id := fmt.Sprintf("%024x", number)
	h := sha256.Sum256(content)
	ctx, cancel := context.WithCancel(a.ctx)
	j := &job{ID: id, Revision: id, Name: name, name: name, Map: "de_ancient", Analysis: true, Status: "ready", Progress: 1, contentSHA256: hex.EncodeToString(h[:]), created: time.Now().Add(time.Duration(number)), ctx: ctx, cancel: cancel}
	j.result, j.analysisResult = jobCachePaths(a.root, id, id)
	value := map[string]string{"id": id, "name": name, "map": j.Map}
	writeFixtureGzip(t, j.result, value)
	writeFixtureGzip(t, j.analysisResult, value)
	a.mu.Lock()
	a.jobs[id] = j
	a.mu.Unlock()
	return j
}

func TestArchiveContentDeduplicationAndPersistentBindings(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	body := []byte("PBDEMS2\x00sample-demo-bytes")
	j := seedReadyContent(t, a, 1, "original.dem", body)
	plain := filepath.Join(a.demoDir, "original.dem")
	if err := os.WriteFile(plain, body, 0600); err != nil {
		t.Fatal(err)
	}
	first := writeTestArchive(t, a.demoDir, "one.zip", testArchiveMember{"nested/renamed.DEM", body, 0}, testArchiveMember{"readme.txt", []byte("ignored"), 0})
	second := writeTestArchive(t, a.demoDir, "two.ZIP", testArchiveMember{"another.dem", body, 0})
	for i := 0; i < 2; i++ {
		result, err := a.scanLibrary()
		if err != nil || len(result.Errors) != 0 || result.Added != 0 || result.Queued != 0 || result.Unchanged != 3 {
			t.Fatalf("scan %d: %+v %v", i, result, err)
		}
	}
	if len(a.jobs) != 1 || len(a.sources) != 3 {
		t.Fatal("duplicate library records or missing source bindings")
	}
	for _, source := range a.sources {
		if source.JobID != j.ID {
			t.Fatal("duplicate source changed ID")
		}
	}
	a.close()
	b := persistentViewer(t, a.root, a.demoDir)
	result, err := b.scanLibrary()
	if err != nil || result.Added != 0 || result.Queued != 0 || result.Unchanged != 3 || len(b.jobs) != 1 {
		t.Fatalf("restart reparsed duplicates: %+v %v", result, err)
	}
	localRequest(b.handler(), "DELETE", "/api/demos/"+j.ID)
	for _, file := range []string{plain, first, second} {
		if _, err := os.Stat(file); err != nil {
			t.Fatal("original removed", err)
		}
	}
	if len(b.sources) != 0 {
		t.Fatal("deleted job left stale source aliases")
	}
}

func TestArchiveSameBasenameDifferentBytesRemainSeparate(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	one, two := []byte("PBDEMS2\x00one"), []byte("PBDEMS2\x00two")
	first := seedReadyContent(t, a, 1, "same.dem", one)
	second := seedReadyContent(t, a, 2, "same.dem", two)
	file := writeTestArchive(t, a.demoDir, "series.zip", testArchiveMember{"round1/same.dem", one, 0}, testArchiveMember{"round2/same.dem", two, 0})
	result, err := a.scanLibrary()
	if err != nil || len(result.Errors) != 0 || result.Unchanged != 2 || len(a.jobs) != 2 {
		t.Fatalf("different content collapsed: %+v %v", result, err)
	}
	if a.sources[sourceKey(librarySource{Source: file, Member: "round1/same.dem"})].JobID != first.ID || a.sources[sourceKey(librarySource{Source: file, Member: "round2/same.dem"})].JobID != second.ID {
		t.Fatal("member identity lost")
	}
}

func TestArchiveChangesForkSharedContentButReuseUniqueIdentity(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	body := []byte("PBDEMS2\x00initial")
	ready := seedReadyContent(t, a, 1, "match.dem", body)
	file := writeTestArchive(t, a.demoDir, "match.zip", testArchiveMember{"match.dem", body, 0})
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	// Only the ZIP owns this identity: changed bytes replace its revision.
	writeTestArchive(t, a.demoDir, "match.zip", testArchiveMember{"match.dem", []byte("PBDEMS2\x00changed-and-invalid"), 0})
	result, err := a.scanLibrary()
	if err != nil || result.Added != 0 || result.Queued != 1 || len(a.jobs) != 1 {
		t.Fatalf("unique source did not update: %+v %v", result, err)
	}
	j := a.jobs[ready.ID]
	if j.Revision == ready.Revision || j.Status != "error" || a.sources[sourceKey(librarySource{Source: file, Member: "match.dem"})].JobID != ready.ID {
		t.Fatal("changed source identity/revision incorrect")
	}
	// A second source sharing the old bytes must keep its original analysis.
	b := persistentViewer(t, t.TempDir(), t.TempDir())
	old := seedReadyContent(t, b, 2, "plain.dem", body)
	os.WriteFile(filepath.Join(b.demoDir, "plain.dem"), body, 0600)
	writeTestArchive(t, b.demoDir, "shared.zip", testArchiveMember{"match.dem", body, 0})
	if _, err := b.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	writeTestArchive(t, b.demoDir, "shared.zip", testArchiveMember{"match.dem", []byte("PBDEMS2\x00different-new-content"), 0})
	result, err = b.scanLibrary()
	if err != nil || result.Added != 1 || len(b.jobs) != 2 || b.jobs[old.ID] != old || old.Status != "ready" {
		t.Fatalf("shared source overwritten: %+v %v", result, err)
	}
}

func TestArchiveSharedMissingCacheAndFailedContentKeepOneIdentity(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	body := []byte("PBDEMS2\x00invalid-bytes")
	j := seedReadyContent(t, a, 1, "plain.dem", body)
	os.WriteFile(filepath.Join(a.demoDir, "plain.dem"), body, 0600)
	writeTestArchive(t, a.demoDir, "same.zip", testArchiveMember{"nested/copy.dem", body, 0})
	if _, err := a.scanLibrary(); err != nil {
		t.Fatal(err)
	}
	os.Remove(j.analysisResult)
	result, err := a.scanLibrary()
	if err != nil || result.Added != 0 {
		t.Fatalf("cache repair made a new ID: %+v %v", result, err)
	}
	if len(a.jobs) != 1 {
		t.Fatal("duplicate record after shared cache repair")
	}
	for _, source := range a.sources {
		if source.JobID != j.ID {
			t.Fatal("shared source stopped referring to original ID")
		}
	}
	// The parser rejects these test bytes. Another ZIP must reuse the error ID.
	writeTestArchive(t, a.demoDir, "another.zip", testArchiveMember{"different-name.dem", body, 0})
	result, err = a.scanLibrary()
	if err != nil || result.Added != 0 || len(a.jobs) != 1 {
		t.Fatalf("failed duplicate proliferated: %+v %v", result, err)
	}
}

func TestArchiveRejectsTraversalLinksOversizeAndBadCRC(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	body := []byte("PBDEMS2\x00sample")
	writeTestArchive(t, a.demoDir, "unsafe.zip", testArchiveMember{"../outside.dem", body, 0}, testArchiveMember{"C:/outside.dem", body, 0}, testArchiveMember{"nested\\escape.dem", body, 0}, testArchiveMember{"link.dem", body, os.ModeSymlink | 0777})
	corrupt := writeTestArchive(t, a.demoDir, "corrupt.zip", testArchiveMember{"valid.dem", body, 0})
	bytesOnDisk, _ := os.ReadFile(corrupt)
	index := bytes.Index(bytesOnDisk, body)
	if index < 0 {
		t.Fatal("missing stored member payload")
	}
	bytesOnDisk[index+9] ^= 0xff
	os.WriteFile(corrupt, bytesOnDisk, 0600)
	var oversize bytes.Buffer
	w := zip.NewWriter(&oversize)
	if _, err := w.CreateRaw(&zip.FileHeader{Name: "huge.dem", Method: zip.Store, UncompressedSize64: uint64(maxUploadBytes) + 1}); err != nil {
		t.Fatal(err)
	}
	w.Close()
	os.WriteFile(filepath.Join(a.demoDir, "oversize.zip"), oversize.Bytes(), 0600)
	os.WriteFile(filepath.Join(a.demoDir, "broken.zip"), []byte("not zip"), 0600)
	result, err := a.scanLibrary()
	if err != nil || len(result.Errors) != 7 || result.Added != 0 || len(a.sources) != 0 || len(a.jobs) != 0 {
		t.Fatalf("unsafe members accepted: %+v %v", result, err)
	}
	entries, _ := os.ReadDir(a.root)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "extract-") {
			t.Fatal("failed extraction left a private file")
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(a.demoDir), "outside.dem")); !os.IsNotExist(err) {
		t.Fatal("ZIP path escaped data directory")
	}
}

func TestArchiveMetadataOnlyRestoreRequiresVerifiedHash(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j := seedReadyContent(t, a, 1, "same.dem", []byte("old bytes"))
	file := writeTestArchive(t, a.demoDir, "new.zip", testArchiveMember{"same.dem", []byte("PBDEMS2\x00new-bytes"), 0})
	result, err := a.scanLibrary()
	if err != nil || result.Added != 1 || len(a.jobs) != 2 || a.jobs[j.ID] != j {
		t.Fatalf("same name incorrectly merged: %+v %v", result, err)
	}
	if a.sources[sourceKey(librarySource{Source: file, Member: "same.dem"})].JobID == j.ID {
		t.Fatal("unverified cache identity was reused")
	}
}

func TestBackgroundScanClosesWithoutLeakingWorkers(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	writeTestArchive(t, a.demoDir, "new.zip", testArchiveMember{"demo.dem", []byte("PBDEMS2\x00invalid"), 0})
	first := a.startLibraryScan()
	if !first.Scanning {
		t.Fatal("scan did not return immediately")
	}
	a.startLibraryScan()
	done := make(chan struct{})
	go func() { a.close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("close blocked on background scan")
	}
}
