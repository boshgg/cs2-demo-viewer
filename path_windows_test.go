package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestWindowsShortPathAliasIsAValidLibrarySource(t *testing.T) {
	longDir := filepath.Join(t.TempDir(), "Library source with a long directory name")
	if err := os.Mkdir(longDir, 0755); err != nil {
		t.Fatal(err)
	}
	name, err := syscall.UTF16PtrFromString(longDir)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	n, err := syscall.GetShortPathName(name, &buffer[0], uint32(len(buffer)))
	if err != nil || n == 0 || int(n) >= len(buffer) {
		t.Skipf("Windows did not provide a short path: %v", err)
	}
	shortDir := syscall.UTF16ToString(buffer[:n])
	if strings.EqualFold(filepath.Clean(shortDir), filepath.Clean(longDir)) {
		t.Skip("8.3 aliases are disabled for this test volume")
	}
	t.Logf("checking actual Windows 8.3 alias %q", shortDir)
	body := []byte("PBDEMS2\x00short-path-content")
	if err := os.WriteFile(filepath.Join(longDir, "match.dem"), body, 0600); err != nil {
		t.Fatal(err)
	}
	writeTestArchive(t, longDir, "copy.zip", testArchiveMember{"nested/match.dem", body, 0})
	if !unlinkedPath(shortDir) || !safeSourcePath(shortDir, filepath.Join(shortDir, "match.dem")) {
		t.Fatal("a real 8.3 alias was mistaken for a redirected source")
	}
	// Mix long and short spellings deliberately: the cache directory must
	// still be excluded by identity when it lives beneath the demo directory.
	a := persistentViewer(t, filepath.Join(longDir, "private cache"), shortDir)
	if err := os.WriteFile(filepath.Join(a.root, "private.dem"), []byte("PBDEMS2\x00private-content"), 0600); err != nil {
		t.Fatal(err)
	}
	scan, err := a.scanLibrary()
	if err != nil || len(scan.Errors) != 0 || scan.Added != 1 || len(a.jobs) != 1 || len(a.sources) != 2 || len(a.pending) != 0 {
		t.Fatalf("short-path scan failed: %+v err=%v jobs=%d sources=%d", scan, err, len(a.jobs), len(a.sources))
	}
	for _, j := range a.jobs {
		if j.Status != "discovered" {
			t.Fatal("discovering short-path sources unexpectedly parsed a demo")
		}
	}
	if next, err := a.scanLibrary(); err != nil || next.Added != 0 || len(next.Errors) != 0 {
		t.Fatalf("short-path refresh did not reuse content: %+v %v", next, err)
	}
}

func TestWindowsJunctionAncestorsAreRejected(t *testing.T) {
	demo, outside := t.TempDir(), t.TempDir()
	writeLocalDemo(t, outside, "outside.dem")
	link := filepath.Join(demo, "redirected")
	// Junction creation needs no symlink privilege on ordinary NTFS volumes.
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
		t.Skipf("junction creation unavailable: %v: %s", err, output)
	}
	t.Cleanup(func() {
		if err := os.Remove(link); err != nil && !os.IsNotExist(err) {
			t.Errorf("remove test junction: %v", err)
		}
	})
	if unlinkedPath(link) || unlinkedPath(filepath.Join(link, "outside.dem")) || safeSourcePath(demo, filepath.Join(link, "outside.dem")) {
		t.Fatal("junction or a regular file beneath it was accepted")
	}
	a := persistentViewer(t, t.TempDir(), demo)
	if scan, err := a.scanLibrary(); err != nil || scan.Added != 0 || len(a.jobs) != 0 {
		t.Fatalf("junction tree was scanned: %+v %v", scan, err)
	}
}
