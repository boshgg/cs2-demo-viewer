package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Opt in with an existing local cache directory. This reads completed replay
// caches only: it never parses source demos, writes the library, or changes
// membership/preferences. Optional reports belong in a private output folder.
func TestImpactExistingReplayCaches(t *testing.T) {
	dir := os.Getenv("CS2_IMPACT_CACHE_DIR")
	if dir == "" {
		t.Skip("set CS2_IMPACT_CACHE_DIR to verify existing replay caches")
	}
	manifestPath := filepath.Join(dir, "library.json")
	before, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Jobs []struct{ ID, Revision, Name, Status, Map string } `json:"jobs"`
	}
	if err = json.Unmarshal(before, &manifest); err != nil {
		t.Fatal(err)
	}
	wanted := "," + os.Getenv("CS2_IMPACT_DEMO_IDS") + ","
	verified := 0
	for _, record := range manifest.Jobs {
		if record.Status != "ready" || wanted != ",," && !strings.Contains(wanted, ","+record.ID+",") {
			continue
		}
		t.Run(record.ID, func(t *testing.T) {
			revision := record.Revision
			if revision == "" {
				revision = record.ID
			}
			if filepath.Base(revision) != revision || strings.ContainsAny(revision, `/\\`) {
				t.Fatal("unsafe cache revision")
			}
			file := filepath.Join(dir, revision+".json.gz")
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			fingerprint := sha256.Sum256(raw)
			data, err := readStatisticsDemo(context.Background(), statisticsSnapshot{id: record.ID, revision: revision, file: file, mapName: record.Map})
			if err != nil {
				t.Fatal(err)
			}
			report := BuildStatistics(data)
			encoded, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Impact struct {
					Version string `json:"version"`
					Rounds  []struct {
						Eligible bool `json:"eligible"`
					} `json:"rounds"`
					Deaths []struct {
						Penalty  *int   `json:"penalty"`
						Core     *int   `json:"corePenalty"`
						Economy  int    `json:"economyPenalty"`
						Excluded string `json:"excludedReason"`
					} `json:"deaths"`
				} `json:"impact"`
			}
			if err = json.Unmarshal(encoded, &result); err != nil || result.Impact.Version != "1" {
				t.Fatalf("missing impact report: %v", err)
			}
			eligible, scored, excluded := 0, 0, map[string]int{}
			for _, exposure := range result.Impact.Rounds {
				if exposure.Eligible {
					eligible++
				}
			}
			for _, death := range result.Impact.Deaths {
				if death.Penalty == nil {
					excluded[death.Excluded]++
					continue
				}
				scored++
				if death.Core == nil || death.Excluded != "" || *death.Penalty != -(*death.Core+death.Economy) || *death.Penalty > 0 || death.Economy < 0 || float64(death.Economy) > float64(*death.Core)*.2+1 {
					t.Fatalf("inconsistent death calculation: %+v", death)
				}
			}
			if output := os.Getenv("CS2_IMPACT_REPORT_DIR"); output != "" {
				if err = os.MkdirAll(output, 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(filepath.Join(output, record.ID+".json"), encoded, 0600); err != nil {
					t.Fatal(err)
				}
			}
			after, err := os.ReadFile(file)
			if err != nil || sha256.Sum256(after) != fingerprint {
				t.Fatal("replay cache changed")
			}
			t.Logf("%s: eligible player-rounds %d/%d; scored deaths %d/%d; exclusions %v", record.Name, eligible, len(result.Impact.Rounds), scored, len(result.Impact.Deaths), excluded)
			verified++
		})
	}
	if verified == 0 {
		t.Fatal("no matching ready replay caches")
	}
	after, err := os.ReadFile(manifestPath)
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("library manifest changed")
	}
}
