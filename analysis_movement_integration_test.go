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

// Optional, read-only verification against real replay caches. Exported reports
// must stay in a private directory; no demo or personal data belongs in Git.
func TestMovementExistingReplayCaches(t *testing.T) {
	dir := os.Getenv("CS2_MOVEMENT_CACHE_DIR")
	if dir == "" {
		t.Skip("set CS2_MOVEMENT_CACHE_DIR to verify existing replay caches")
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
	wanted := "," + os.Getenv("CS2_MOVEMENT_DEMO_IDS") + ","
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
			raw = nil
			var replay DemoData
			if err := readAnalysisTimingJSON(context.Background(), file, maxUploadBytes, &replay); err != nil {
				t.Fatal(err)
			}
			if replay.ID != record.ID || replay.Map != record.Map {
				t.Fatal("wrong replay cache")
			}
			actual := BuildAnalysis(&replay)
			var previous AnalysisDemo
			if err := readAnalysisTimingJSON(context.Background(), filepath.Join(dir, revision+".analysis.json.gz"), maxUploadBytes, &previous); err != nil {
				t.Fatal(err)
			}
			if actual.MovementTimingVersion != 1 || len(actual.Series) != len(previous.Series) || !reflect.DeepEqual(actual.Players, previous.Players) || !reflect.DeepEqual(actual.Teams, previous.Teams) {
				t.Fatal("missing movement timing or changed player/team identities")
			}
			oldByKey := map[string]AnalysisSeries{}
			for _, s := range previous.Series {
				oldByKey[s.PlayerID+"/"+s.TeamID+"/"+string(rune(s.Side))] = s
			}
			var total, timed, unknown, beyond float64
			bins := 0
			for _, s := range actual.Series {
				old, ok := oldByKey[s.PlayerID+"/"+s.TeamID+"/"+string(rune(s.Side))]
				if !ok || old.Rounds != s.Rounds || !reflect.DeepEqual(old.Cells, s.Cells) {
					t.Fatal("full-round cells or series membership changed")
				}
				var full, part float64
				for _, c := range s.Cells {
					full += c[3]
				}
				for _, c := range s.MovementTimeline {
					if c[3] != math.Floor(c[3]) || c[3] < 0 || c[3] >= 115 || c[4] <= 0 || math.IsNaN(c[4]) || math.IsInf(c[4], 0) {
						t.Fatalf("invalid time bin: %v", c)
					}
					part += c[4]
				}
				var untimedUnknown, untimedBeyond float64
				for _, c := range s.MovementUntimedCells {
					untimedUnknown += c[3]
					untimedBeyond += c[4]
				}
				// Original full-round cells round seconds to four decimals;
				// timeline rows retain the actual observed seconds.
				tolerance := .000051*float64(len(s.Cells)) + 1e-7
				if math.Abs(full-part-s.MovementUnknownSeconds-s.MovementBeyondSeconds) > tolerance || math.Abs(untimedUnknown-s.MovementUnknownSeconds) > tolerance || math.Abs(untimedBeyond-s.MovementBeyondSeconds) > tolerance {
					t.Fatalf("movement conservation failed: full=%g timed=%g unknown=%g beyond=%g", full, part, s.MovementUnknownSeconds, s.MovementBeyondSeconds)
				}
				total += full
				timed += part
				unknown += s.MovementUnknownSeconds
				beyond += s.MovementBeyondSeconds
				bins += len(s.MovementTimeline)
			}
			if total <= 0 || timed <= 0 || bins == 0 {
				t.Fatal("real match has no timed movement")
			}
			var metadata analysisTimingReplay
			if err := streamAnalysisReplay(context.Background(), file, &metadata, nil); err != nil {
				t.Fatal(err)
			}
			movement, err := upgradeAnalysisMovement(context.Background(), file, &metadata)
			if err != nil {
				t.Fatal(err)
			}
			var rawSummary map[string]json.RawMessage
			if err := readAnalysisTimingJSON(context.Background(), filepath.Join(dir, revision+".analysis.json.gz"), maxUploadBytes, &rawSummary); err != nil {
				t.Fatal(err)
			}
			if err := patchAnalysisMovementTiming(rawSummary, movement); err != nil {
				t.Fatal(err)
			}
			var upgraded []AnalysisSeries
			if err := json.Unmarshal(rawSummary["series"], &upgraded); err != nil {
				t.Fatal(err)
			}
			if len(upgraded) != len(actual.Series) || string(rawSummary["movementTimingVersion"]) != "1" {
				t.Fatal("streamed upgrade incomplete")
			}
			for i, s := range actual.Series {
				u := upgraded[i]
				if s.PlayerID != u.PlayerID || s.TeamID != u.TeamID || s.Side != u.Side || !reflect.DeepEqual(s.Cells, u.Cells) || !reflect.DeepEqual(s.MovementTimeline, u.MovementTimeline) || !reflect.DeepEqual(s.MovementUntimedCells, u.MovementUntimedCells) || math.Abs(s.MovementUnknownSeconds-u.MovementUnknownSeconds) > 1e-7 || math.Abs(s.MovementBeyondSeconds-u.MovementBeyondSeconds) > 1e-7 {
					t.Fatalf("streamed upgrade disagrees with fresh summary: %s / %s", s.PlayerID, s.TeamID)
				}
			}
			if output := os.Getenv("CS2_MOVEMENT_REPORT_DIR"); output != "" {
				if err := os.MkdirAll(output, 0700); err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(actual)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(output, record.ID+".json"), encoded, 0600); err != nil {
					t.Fatal(err)
				}
			}
			after, err := os.ReadFile(file)
			if err != nil || sha256.Sum256(after) != fingerprint {
				t.Fatal("source replay changed")
			}
			t.Logf("%s: %.3fs full / %.3fs timed / %.3fs unknown / %.3fs beyond; %d bins", record.Name, total, timed, unknown, beyond, bins)
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
