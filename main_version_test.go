package main

import (
	"strings"
	"testing"
)

func TestCanReuseViewer(t *testing.T) {
	tests := []struct {
		name      string
		health    viewerHealth
		wantReuse bool
		wantError bool
	}{
		{name: "same version", health: viewerHealth{App: "cs2-local-viewer", Version: appVersion}, wantReuse: true},
		{name: "older version", health: viewerHealth{App: "cs2-local-viewer", Version: "3.1.0"}, wantError: true},
		{name: "newer version", health: viewerHealth{App: "cs2-local-viewer", Version: "999.0.0"}, wantError: true},
		{name: "missing version", health: viewerHealth{App: "cs2-local-viewer"}, wantError: true},
		{name: "different application", health: viewerHealth{App: "another-local-service", Version: appVersion}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reuse, err := canReuseViewer(tt.health)
			if reuse != tt.wantReuse || (err != nil) != tt.wantError {
				t.Fatalf("canReuseViewer(%+v) = (%v, %v), want reuse=%v error=%v", tt.health, reuse, err, tt.wantReuse, tt.wantError)
			}
			if err == nil {
				return
			}
			for _, detail := range []string{appVersion, "关闭旧程序", "-port"} {
				if !strings.Contains(err.Error(), detail) {
					t.Errorf("version conflict lacks actionable detail %q: %s", detail, err)
				}
			}
			if tt.health.Version != "" && !strings.Contains(err.Error(), tt.health.Version) {
				t.Errorf("version conflict omits running version: %s", err)
			}
			if tt.health.Version == "" && !strings.Contains(err.Error(), "未知") {
				t.Errorf("missing version is not identified: %s", err)
			}
		})
	}
}
