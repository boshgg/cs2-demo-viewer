package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Optional local regression coverage. Recordings stay outside the repository.
func TestParseLocalCompatibilityDemos(t *testing.T) {
	paths := os.Getenv("CS2_COMPAT_DEMOS")
	if paths == "" {
		t.Skip("set CS2_COMPAT_DEMOS to local demo paths separated by semicolons")
	}
	for _, path := range strings.Split(paths, ";") {
		t.Run(filepath.Base(path), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			d, err := parseDemo(ctx, path, "compat", "local.dem", func(float64) {})
			if err != nil {
				t.Fatal(err)
			}
			if len(d.Frames) < 100 || len(d.Players) < 2 || len(d.Rounds) < 1 || d.Duration <= 0 || d.Map == "" {
				t.Fatal("incomplete replay")
			}
			for i, f := range d.Frames {
				if i > 0 && f.T <= d.Frames[i-1].T {
					t.Fatalf("non-monotonic frame %d", i)
				}
			}
			a := BuildAnalysis(d)
			if len(a.Series) == 0 || len(a.Teams) == 0 {
				t.Fatal("missing analysis data")
			}
			t.Logf("map=%s rounds=%d players=%d frames=%d duration=%.2f utilities=%d warnings=%v", d.Map, len(d.Rounds), len(d.Players), len(d.Frames), d.Duration, len(d.Utilities), d.Warnings)
		})
	}
}
