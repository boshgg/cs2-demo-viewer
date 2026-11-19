package main

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"
)

func TestRoundEvidenceTracksContributingRoundsPerRow(t *testing.T) {
	d := eventTimingFixture()
	d.Rounds = append(d.Rounds, Round{Number: 65, Start: 140, FreezeEnd: 150, End: 250})
	p := analysisTestPlayer(analysisTestID(1), 2, 130)
	d.Frames = append(d.Frames, Frame{Round: 65, T: 150, Players: []PlayerFrame{p}})
	d.Events = append(d.Events, Event{Round: 1, T: 10, Type: "bomb_planted"}, Event{Round: 65, T: 150, Type: "bomb_planted"})
	shot := d.Shots[1]
	shot.Round, shot.T = 65, 150
	d.Shots = append(d.Shots, shot, shot)
	a := BuildAnalysis(d)
	s := eventSeriesFor(t, a, p.ID)
	if a.RoundEvidenceVersion != 1 || len(a.RoundSets[0]) != 0 {
		t.Fatal("missing version or empty sentinel")
	}
	for _, h := range []AnalysisHeatmap{s.AnalysisHeatmap, s.PlantPhases["post"]} {
		full, timed := false, false
		for i, cell := range h.Cells {
			if cell[6] > 0 {
				full = true
				if !slices.Equal(a.RoundSets[h.RoundRefs.Cells[4*i+3]], []int{1, 65}) {
					t.Fatal("shot rounds mixed with other metrics")
				}
			}
			if cell[5] > 0 && !slices.Equal(a.RoundSets[h.RoundRefs.Cells[4*i+2]], []int{1}) {
				t.Fatal("duplicated death rounds")
			}
		}
		for i, cell := range h.EventTimeline {
			if cell[6] > 0 && cell[3] == 0 {
				timed = true
				if !slices.Equal(a.RoundSets[h.RoundRefs.EventTimeline[i]], []int{1, 65}) {
					t.Fatal("missing timed shot origin")
				}
			}
		}
		if !full || !timed {
			t.Fatal("missing shot bins")
		}
	}
	found := false
	for i, cell := range s.PlantTimeline {
		if cell[5] == 6 && cell[3] == 0 && cell[4] == 0 {
			found = true
			if !slices.Equal(a.RoundSets[s.PlantRoundRefs[i]], []int{1, 65}) {
				t.Fatal("missing joint-clock origins")
			}
		}
	}
	if !found {
		t.Fatal("missing joint-clock shots")
	}
}

func TestRoundEvidenceUpgradeKeepsMeasurementsAndRetries(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, _ := eventUpgradeFixture(t, a)
	d.Events = append(d.Events, Event{Round: 1, Type: "bomb_planted", T: 12})
	writeFixtureGzip(t, j.result, d)
	current := BuildAnalysis(d)
	body, _ := json.Marshal(current)
	var old map[string]json.RawMessage
	json.Unmarshal(body, &old)
	delete(old, "roundSets")
	delete(old, "roundEvidenceVersion")
	var rows []map[string]json.RawMessage
	json.Unmarshal(old["series"], &rows)
	for _, s := range rows {
		delete(s, "roundRefs")
		delete(s, "plantRoundRefs")
		var phases map[string]map[string]json.RawMessage
		if len(s["plantPhases"]) > 0 {
			json.Unmarshal(s["plantPhases"], &phases)
			for _, h := range phases {
				delete(h, "roundRefs")
				h["futurePhaseField"] = json.RawMessage("true")
			}
			s["plantPhases"], _ = json.Marshal(phases)
		}
	}
	old["series"], _ = json.Marshal(rows)
	writeFixtureGzip(t, j.analysisResult, old)
	original := fileHash(t, j.analysisResult)
	read := func() map[string]json.RawMessage {
		return readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	}
	if err := os.Rename(j.result, j.result+".unavailable"); err != nil {
		t.Fatal(err)
	}
	if res := read(); len(res["roundEvidenceVersion"]) != 0 || fileHash(t, j.analysisResult) != original {
		t.Fatal("fabricated evidence or modified original cache")
	}
	if err := os.Rename(j.result+".unavailable", j.result); err != nil {
		t.Fatal(err)
	}
	res := read()
	var result AnalysisDemo
	encoded, _ := json.Marshal(res)
	json.Unmarshal(encoded, &result)
	if !reflect.DeepEqual(current.RoundSets, result.RoundSets) || !reflect.DeepEqual(current.Series, result.Series) || result.RoundEvidenceVersion != 1 {
		t.Fatal("upgraded evidence differs from fresh report")
	}
	var after []map[string]json.RawMessage
	json.Unmarshal(res["series"], &after)
	for _, s := range after {
		var phases map[string]map[string]json.RawMessage
		json.Unmarshal(s["plantPhases"], &phases)
		for _, h := range phases {
			if string(h["futurePhaseField"]) != "true" {
				t.Fatal("future phase metadata lost")
			}
		}
	}
}
