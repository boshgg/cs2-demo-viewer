package main

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

func TestPlantCrossesSecondAndPartitionsAllFourLayers(t *testing.T) {
	a, b := analysisTestID(1), analysisTestID(2)
	player := analysisTestPlayer(a, 2, 120)
	d := &DemoData{ID: "phase", Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 1, End: 150, EndedAt: 145}, {Number: 2, Start: 150, End: 200}}, Frames: []Frame{{T: 10.75, Round: 1, Players: []PlayerFrame{player}}, {T: 11, Round: 1, Players: []PlayerFrame{player}}}, Events: []Event{{Type: "bomb_planted", T: 10.875, Round: 1}}}
	pos := &Position{120, 100, 12}
	for _, v := range []struct {
		round int
		t     float64
		x     float64
	}{{1, 10.8, 120}, {1, 10.875, 320}, {1, 10.95, 320}, {1, 130, 250}, {2, 175, 320}} {
		d.Events = append(d.Events, Event{Type: "kill", T: v.t, Round: v.round, VictimID: b, VictimTeam: 3, VictimPos: pos})
		d.Shots = append(d.Shots, Shot{T: v.t, Round: v.round, PlayerID: a, Team: 2, Weapon: common.EqAK47.String(), X: v.x, Y: 100, Z: 12})
		d.Damage = append(d.Damage, DamageEvent{T: v.t, Round: v.round, AttackerID: a, AttackerTeam: 2, VictimID: b, VictimTeam: 3, Weapon: common.EqAK47.String(), Damage: 1, AttackerPos: &Position{v.x, 100, 12}, VictimPos: pos})
	}
	report := BuildAnalysis(d)
	if report.PlantPhaseVersion != 1 || len(report.PlantPhaseUnknownRounds) != 0 {
		t.Fatal("unexpected phase coverage", report.PlantPhaseUnknownRounds)
	}
	// Round 2 has no freeze anchor and no plant. Round 1 has data beyond
	// the regulation countdown and two shots at/after plant in second 9.
	var timeBins [2]float64
	var timed, unknown, beyond [2][3]float64
	for _, s := range report.Series {
		for i, phase := range []string{"pre", "post"} {
			part := s.PlantPhases[phase]
			for _, c := range part.MovementTimeline {
				if c[3] != 9 {
					t.Fatal("wrong movement second", c)
				}
				timeBins[i] += c[4]
			}
			for _, c := range part.EventTimeline {
				if c[3] != 9 {
					t.Fatal("wrong event second", c)
				}
				for k := range timed[i] {
					timed[i][k] += c[4+k]
				}
			}
			for _, c := range part.EventUntimedCells {
				for k := range unknown[i] {
					unknown[i][k] += c[3+k]
					beyond[i][k] += c[6+k]
				}
			}
		}
	}
	if timeBins != [2]float64{.125, .125} || timed != [2][3]float64{{2, 1, 1}, {1, 2, 2}} || unknown != [2][3]float64{{2, 1, 1}, {}} || beyond != [2][3]float64{{}, {2, 1, 1}} {
		t.Fatalf("incorrect partition: move=%v timed=%v unknown=%v beyond=%v", timeBins, timed, unknown, beyond)
	}
}

func TestPlantOutsidePlayableWindowInsideRecordedRound(t *testing.T) {
	for _, tc := range []struct {
		name  string
		when  float64
		phase string
	}{
		{"after result before next round", 187.16, "pre"},
		{"before freeze end", 99, "post"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := eventTimingFixture()
			d.Rounds[0] = Round{Number: 1, Start: 93.3, FreezeEnd: 105, EndedAt: 182.2, End: 187.2}
			d.Events = append(d.Events, Event{Type: "bomb_planted", Round: 1, T: tc.when})
			d.Frames[0].T, d.Frames[1].T = 122, 122.2
			d.Frames = append(d.Frames, Frame{Round: 1, T: 187.17, Bomb: &Bomb{State: "planted"}})
			result := BuildAnalysis(d)
			if len(result.PlantPhaseUnknownRounds) != 0 || len(result.Series) == 0 {
				t.Fatal("plant during recorded round discarded", result.PlantPhaseUnknownRounds)
			}
			for _, s := range result.Series {
				part, ok := s.PlantPhases[tc.phase]
				if !ok || len(s.PlantPhases) != 1 || !reflect.DeepEqual(part, s.AnalysisHeatmap) {
					t.Fatal("expected entire playable interval in", tc.phase, s.PlayerID)
				}
			}
		})
	}
}

func TestPlantConflictingOrMissingEvidenceStaysUnclassified(t *testing.T) {
	d := eventTimingFixture()
	for _, tc := range []string{"no events field", "event after valid round", "conflicting plants", "planted frame only", "bombed outcome only"} {
		t.Run(tc, func(t *testing.T) {
			copy := *d
			copy.Frames = slices.Clone(d.Frames)
			copy.Events = slices.Clone(d.Events)
			copy.Rounds = slices.Clone(d.Rounds)
			switch tc {
			case "no events field":
				copy.Events = nil
			case "event after valid round":
				copy.Events = append(copy.Events, Event{Round: 1, Type: "bomb_planted", T: 140.01})
			case "conflicting plants":
				copy.Events = append(copy.Events, Event{Round: 1, Type: "bomb_planted", T: 11}, Event{Round: 1, Type: "bomb_planted", T: 12})
			case "planted frame only":
				copy.Frames[0].Bomb = &Bomb{State: "planted"}
			case "bombed outcome only":
				copy.Rounds[0].Reason = "#SFUI_Notice_Target_Bombed"
			}
			result := BuildAnalysis(&copy)
			if !slices.Equal(result.PlantPhaseUnknownRounds, []int{1}) || len(result.Series) == 0 {
				t.Fatal("missing reliable coverage indication")
			}
			for _, s := range result.Series {
				if len(s.PlantPhases) > 0 {
					t.Fatal("unverified round assigned to a phase")
				}
			}
		})
	}
}

func TestPlantUpgradePreservesOldResultsAndMatchesFresh(t *testing.T) {
	app := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, old := eventUpgradeFixture(t, app)
	d.Events = append(d.Events, Event{Type: "bomb_planted", T: 10.999, Round: 1})
	writeFixtureGzip(t, j.result, d)
	delete(old, "plantPhaseVersion")
	old["eventTimingVersion"] = json.RawMessage("1")
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(old["series"], &rows); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		delete(r, "plantPhases")
	}
	old["series"], _ = json.Marshal(rows)
	writeFixtureGzip(t, j.analysisResult, old)
	hash := fileHash(t, j.analysisResult)
	if err := os.Rename(j.result, j.result+".unavailable"); err != nil {
		t.Fatal(err)
	}
	req := func() map[string]json.RawMessage {
		return readAnalysisResponse(t, localRequest(app.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	}
	missing := req()
	if len(missing["plantPhaseVersion"]) > 0 || fileHash(t, j.analysisResult) != hash {
		t.Fatal("missing replay fabricated ready version or overwrote summary")
	}
	if err := os.Rename(j.result+".unavailable", j.result); err != nil {
		t.Fatal(err)
	}
	upgraded := req()
	assertMovementUpgradePreservesOld(t, old, upgraded)
	if string(upgraded["plantPhaseVersion"]) != "1" {
		t.Fatal("phase upgrade not persisted")
	}
	var got []AnalysisSeries
	if err := json.Unmarshal(upgraded["series"], &got); err != nil {
		t.Fatal(err)
	}
	want := BuildAnalysis(d).Series
	if len(want) != len(got) {
		t.Fatal("number of series changed")
	}
	for i, s := range got {
		if !reflect.DeepEqual(s.PlantPhases, want[i].PlantPhases) {
			t.Fatal("streamed and fresh plant bins differ", s.PlayerID)
		}
		var count, partition [4]float64
		for _, c := range s.Cells {
			for k := range count {
				count[k] += c[k+3]
			}
		}
		for _, group := range s.PlantPhases {
			for _, c := range group.Cells {
				for k := range partition {
					partition[k] += c[k+3]
				}
			}
		}
		for k := range count {
			if math.Abs(count[k]-partition[k]) > .001 {
				t.Fatalf("lost full metric %d", k)
			}
		}
	}
}
