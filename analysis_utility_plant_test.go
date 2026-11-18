package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func utilityPlantFixture() *DemoData {
	d := &DemoData{ID: "demo", Map: "de_ancient", Duration: 400, Damage: []DamageEvent{}}
	for i := 0; i < 4; i++ {
		start := float64(i * 100)
		d.Rounds = append(d.Rounds, Round{Number: i + 1, Start: start, FreezeEnd: start + 1, EndedAt: start + 90, End: start + 100})
	}
	d.Events = []Event{
		{Round: 1, T: 30.5, Type: "bomb_planted"},
		{Round: 3, T: 296, Type: "bomb_planted"}, // Recorded after the round was decided.
	}
	d.Frames = []Frame{{T: 350, Round: 4, Bomb: &Bomb{State: "planted"}}}
	for _, v := range []struct {
		id    string
		round int
		when  float64
	}{
		{"cross", 1, 30.49}, {"exact", 1, 30.5}, {"after", 1, 30.51}, {"no-plant", 2, 160},
		{"after-win", 3, 255}, {"conflicting", 4, 360}, {"unobserved", 1, 31},
	} {
		d.Utilities = append(d.Utilities, Utility{ID: v.id, Type: "smoke", OwnerID: analysisTestID(1), Team: 2, Round: v.round,
			Start: v.when, Detonate: v.when + 1, Detonated: true, ThrowObserved: v.id != "unobserved", X: 100, Y: 200})
	}
	return d
}

func TestUtilityPlantPhaseUsesObservedThrow(t *testing.T) {
	d := utilityPlantFixture()
	report := BuildAnalysis(d)
	if report.UtilityPlantPhaseVersion != 1 || !reflect.DeepEqual(report.PlantPhaseUnknownRounds, []int{4}) || len(report.Utilities) != len(d.Utilities) {
		t.Fatal("unexpected utility phase coverage", report.PlantPhaseUnknownRounds)
	}
	want := map[string]string{"cross": "pre", "exact": "post", "after": "post", "no-plant": "pre", "after-win": "pre", "conflicting": "unknown", "unobserved": "unknown"}
	for _, u := range report.Utilities {
		if u.PlantPhase != want[u.ID] {
			t.Errorf("%s: got %s, want %s", u.ID, u.PlantPhase, want[u.ID])
		}
	}
}

func TestUtilityPlantLegacyAndCurrentHeatmapUpgrades(t *testing.T) {
	for _, tc := range []struct {
		name          string
		hasHeatPhases bool
	}{{"v4.3.1", true}, {"older cache", false}} {
		t.Run(tc.name, func(t *testing.T) {
			app := persistentViewer(t, t.TempDir(), t.TempDir())
			j, d, _ := legacyAnalysisFixture(t, app, "000000000000000000000422")
			d = utilityPlantFixture()
			d.ID, d.Name, j.Map = j.ID, j.Name, d.Map
			writeFixtureGzip(t, j.result, d)
			current := BuildAnalysis(d)
			body, err := json.Marshal(current)
			if err != nil {
				t.Fatal(err)
			}
			var raw map[string]json.RawMessage
			if err := json.Unmarshal(body, &raw); err != nil {
				t.Fatal(err)
			}
			delete(raw, "utilityPlantPhaseVersion")
			if !tc.hasHeatPhases {
				delete(raw, "plantPhaseVersion")
				delete(raw, "plantPhaseUnknownRounds")
			}
			var utilities []map[string]json.RawMessage
			if err := json.Unmarshal(raw["utilities"], &utilities); err != nil {
				t.Fatal(err)
			}
			for _, u := range utilities {
				delete(u, "plantPhase")
				u["futureMetadata"] = json.RawMessage(`{"preserve":true}`)
			}
			raw["utilities"], _ = json.Marshal(utilities)
			writeFixtureGzip(t, j.analysisResult, raw)
			originalHash := fileHash(t, j.analysisResult)
			req := func() map[string]json.RawMessage {
				return readAnalysisResponse(t, localRequest(app.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			}
			if err := os.Rename(j.result, j.result+".offline"); err != nil {
				t.Fatal(err)
			}
			fallback := req()
			if len(fallback["utilityPlantPhaseVersion"]) != 0 || fileHash(t, j.analysisResult) != originalHash {
				t.Fatal("unavailable replay changed the saved cache")
			}
			var fallbackUtilities []AnalysisUtility
			if err := json.Unmarshal(fallback["utilities"], &fallbackUtilities); err != nil {
				t.Fatal(err)
			}
			for _, u := range fallbackUtilities {
				if u.PlantPhase != "unknown" {
					t.Fatalf("unverified cached phase: %s", u.PlantPhase)
				}
			}
			if err := os.Rename(j.result+".offline", j.result); err != nil {
				t.Fatal(err)
			}
			upgraded := req()
			if string(upgraded["utilityPlantPhaseVersion"]) != "1" || string(upgraded["plantPhaseVersion"]) != "1" {
				t.Fatal("upgrade did not finish")
			}
			var got []AnalysisUtility
			if err := json.Unmarshal(upgraded["utilities"], &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, current.Utilities) {
				t.Fatalf("upgraded utilities differ: %+v, want %+v", got, current.Utilities)
			}
			var patched []map[string]json.RawMessage
			if err := json.Unmarshal(upgraded["utilities"], &patched); err != nil {
				t.Fatal(err)
			}
			for i, u := range patched {
				delete(u, "plantPhase")
				if !reflect.DeepEqual(utilities[i], u) {
					t.Fatal("changed existing utility fields")
				}
			}
			if tc.hasHeatPhases && string(upgraded["series"]) != string(raw["series"]) {
				t.Fatal("4.3.1 heatmaps changed")
			}
			saved := fileHash(t, j.analysisResult)
			req()
			if fileHash(t, j.analysisResult) != saved {
				t.Fatal("repeated completed upgrade")
			}
		})
	}
}
