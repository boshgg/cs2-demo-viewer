package main

import "testing"

func TestCanReuseViewer(t *testing.T) {
	tests := []struct {
		name      string
		health    viewerHealth
		wantReuse bool
	}{
		{name: "same version", health: viewerHealth{App: "cs2-local-viewer", Version: appVersion}, wantReuse: true},
		{name: "older version", health: viewerHealth{App: "cs2-local-viewer", Version: "3.1.0"}},
		{name: "newer version", health: viewerHealth{App: "cs2-local-viewer", Version: "999.0.0"}},
		{name: "missing version", health: viewerHealth{App: "cs2-local-viewer"}},
		{name: "different application", health: viewerHealth{App: "another-local-service", Version: appVersion}},
		{name: "empty response", health: viewerHealth{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if reuse := canReuseViewer(tt.health); reuse != tt.wantReuse {
				t.Fatalf("canReuseViewer(%+v) = %v, want %v", tt.health, reuse, tt.wantReuse)
			}
		})
	}
}
