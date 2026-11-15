package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Real-cache verification is opt-in and read-only. Reports must be exported to
// a private directory; source demos and personal data are never test fixtures.
func TestEventTimingExistingReplayCaches(t *testing.T) {
	dir := os.Getenv("CS2_EVENT_CACHE_DIR")
	if dir == "" {
		t.Skip("set CS2_EVENT_CACHE_DIR to verify real cached demos")
	}
	manifestPath := filepath.Join(dir, "library.json")
	before, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Jobs []struct{ ID, Revision, Status, Name, Map string } `json:"jobs"`
	}
	if err := json.Unmarshal(before, &manifest); err != nil {
		t.Fatal(err)
	}
	wanted := "," + os.Getenv("CS2_EVENT_DEMO_IDS") + ","
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
				t.Fatal("unsafe revision")
			}
			file := filepath.Join(dir, revision+".json.gz")
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			fingerprint := sha256.Sum256(raw)
			raw = nil
			var replay DemoData
			if err := readAnalysisTimingJSON(context.Background(), file, maxUploadBytes, &replay); err != nil {
				t.Fatal(err)
			}
			if replay.ID != record.ID || replay.Map != record.Map {
				t.Fatal("wrong replay identity")
			}
			actual := BuildAnalysis(&replay)
			var previous AnalysisDemo
			if err := readAnalysisTimingJSON(context.Background(), filepath.Join(dir, revision+".analysis.json.gz"), analysisSummaryReadLimit, &previous); err != nil {
				t.Fatal(err)
			}
			if actual.EventTimingVersion != 1 || len(actual.Series) != len(previous.Series) || !reflect.DeepEqual(actual.Teams, previous.Teams) || !reflect.DeepEqual(actual.Players, previous.Players) || !reflect.DeepEqual(actual.Utilities, previous.Utilities) {
				t.Fatal("changed identities/utilities or missing timing")
			}
			var full, timed, unknown, beyond [3]float64
			bins := 0
			for i, s := range actual.Series {
				old := previous.Series[i]
				if s.PlayerID != old.PlayerID || s.TeamID != old.TeamID || s.Side != old.Side || s.Rounds != old.Rounds || !reflect.DeepEqual(s.Cells, old.Cells) || !reflect.DeepEqual(s.MovementTimeline, old.MovementTimeline) || !reflect.DeepEqual(s.MovementUntimedCells, old.MovementUntimedCells) || math.Abs(s.MovementUnknownSeconds-old.MovementUnknownSeconds) > 1e-7 || math.Abs(s.MovementBeyondSeconds-old.MovementBeyondSeconds) > 1e-7 {
					t.Fatal("existing heatmap or movement timing changed")
				}
				var sf, st, su, sb [3]float64
				for _, c := range s.Cells {
					for m := range sf {
						sf[m] += c[4+m]
					}
				}
				for _, c := range s.EventTimeline {
					if c[3] < 0 || c[3] >= 115 || c[3] != math.Floor(c[3]) {
						t.Fatalf("invalid event time bin %v", c)
					}
					nonzero := 0
					for m := range st {
						n := c[4+m]
						if n < 0 || n != math.Floor(n) || math.IsNaN(n) || math.IsInf(n, 0) {
							t.Fatal("invalid event count")
						}
						st[m] += n
						if n > 0 {
							nonzero++
						}
					}
					if nonzero != 1 {
						t.Fatal("event metrics must retain independent spatial height")
					}
				}
				for _, c := range s.EventUntimedCells {
					for m := range su {
						su[m] += c[3+m]
						sb[m] += c[6+m]
					}
				}
				for m := range sf {
					if sf[m] != st[m]+su[m]+sb[m] {
						t.Fatalf("metric %d failed conservation: %g != %g+%g+%g", m, sf[m], st[m], su[m], sb[m])
					}
					full[m] += sf[m]
					timed[m] += st[m]
					unknown[m] += su[m]
					beyond[m] += sb[m]
				}
				bins += len(s.EventTimeline)
			}
			if bins == 0 {
				t.Fatal("no real event bins")
			}
			var metadata analysisTimingReplay
			if err := streamAnalysisReplay(context.Background(), file, &metadata, nil); err != nil {
				t.Fatal(err)
			}
			events, err := upgradeAnalysisEvents(context.Background(), file, &metadata)
			if err != nil {
				t.Fatal(err)
			}
			var oldSummary map[string]json.RawMessage
			if err := readAnalysisTimingJSON(context.Background(), filepath.Join(dir, revision+".analysis.json.gz"), analysisSummaryReadLimit, &oldSummary); err != nil {
				t.Fatal(err)
			}
			copyBytes, _ := json.Marshal(oldSummary)
			var upgraded map[string]json.RawMessage
			json.Unmarshal(copyBytes, &upgraded)
			if err := patchAnalysisEventTiming(upgraded, events); err != nil {
				t.Fatal(err)
			}
			for key, original := range oldSummary {
				if key != "series" && key != "eventTimingVersion" && !reflect.DeepEqual(original, upgraded[key]) {
					t.Fatalf("upgrade modified %s", key)
				}
			}
			var rows []AnalysisSeries
			if err := json.Unmarshal(upgraded["series"], &rows); err != nil {
				t.Fatal(err)
			}
			if len(rows) != len(actual.Series) || string(upgraded["eventTimingVersion"]) != "1" {
				t.Fatal("incomplete streamed upgrade")
			}
			for i, s := range rows {
				if !reflect.DeepEqual(s.EventTimeline, actual.Series[i].EventTimeline) || !reflect.DeepEqual(s.EventUntimedCells, actual.Series[i].EventUntimedCells) || !reflect.DeepEqual(s.Cells, previous.Series[i].Cells) || !reflect.DeepEqual(s.MovementTimeline, previous.Series[i].MovementTimeline) || !reflect.DeepEqual(s.MovementUntimedCells, previous.Series[i].MovementUntimedCells) || s.MovementUnknownSeconds != previous.Series[i].MovementUnknownSeconds || s.MovementBeyondSeconds != previous.Series[i].MovementBeyondSeconds {
					t.Fatal("streamed upgrade disagrees or rewrote old timing")
				}
			}
			if output := os.Getenv("CS2_EVENT_REPORT_DIR"); output != "" {
				if err := os.MkdirAll(output, 0700); err != nil {
					t.Fatal(err)
				}
				body, err := json.Marshal(actual)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(output, record.ID+".json"), body, 0600); err != nil {
					t.Fatal(err)
				}
			}
			after, err := os.ReadFile(file)
			if err != nil || sha256.Sum256(after) != fingerprint {
				t.Fatal("replay modified")
			}
			t.Logf("%s engagements/deaths/shots: full=%v timed=%v unknown=%v beyond=%v; %d bins", record.Name, full, timed, unknown, beyond, bins)
			verified++
		})
	}
	if verified == 0 {
		t.Fatal("no matching ready caches")
	}
	after, err := os.ReadFile(manifestPath)
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("library manifest modified")
	}
}
