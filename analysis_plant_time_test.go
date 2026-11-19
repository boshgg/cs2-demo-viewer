package main

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

func TestPlantTimeDecimalSecondEdges(t *testing.T) {
	for _, v := range []struct {
		at, plant float64
		want      int
	}{
		{1.14, .14, 1}, {math.Nextafter(1.14, 0), .14, 0},
		{.14, 1.14, -1}, {math.Nextafter(.14, 0), 1.14, -2},
		{42.37, 42.37, 0}, {math.Nextafter(42.37, 0), 42.37, -1},
	} {
		sec, next := analysisPlantTimeBin(v.at, v.plant)
		if sec != v.want || next <= v.at {
			t.Fatalf("at %v plant %v: got bin %d ending at %v, want %d", v.at, v.plant, sec, next, v.want)
		}
	}
}

func TestPlantTimeIntersectsBothClocksForMovementAndEvents(t *testing.T) {
	d := eventTimingFixture()
	d.Rounds[0].FreezeEnd = 1.125
	d.Frames[0].T, d.Frames[1].T = 2, 2.25
	plant := 2.0625
	d.Events = []Event{{Type: "bomb_planted", Round: 1, T: plant}}
	// Three different event types retain their own heights and use the
	// observed fire/damage/death times, including a shot exactly at plant.
	d.Damage, d.Shots = d.Damage[:1], d.Shots[:1]
	d.Damage[0].T, d.Shots[0].T = 2, plant
	d.Events = append(d.Events, Event{Type: "kill", Round: 1, T: 2.125, VictimID: analysisTestID(3), VictimTeam: 2, VictimPos: &Position{130, 70, 20}})
	result := BuildAnalysis(d)
	if result.PlantTimeVersion != 1 {
		t.Fatal("missing signed timeline capability")
	}
	type bin struct{ plant, round, metric int }
	got := map[bin]float64{}
	for _, s := range result.Series {
		for _, row := range s.PlantTimeline {
			key := bin{int(row[3]), int(row[4]), int(row[5])}
			got[key] += row[6]
			if key.metric != 3 && row[2] != float64(10*(key.metric-3)) {
				t.Fatalf("incorrect event height %v", row)
			}
		}
	}
	want := map[bin]float64{
		{-1, 0, 3}: 2 * .0625, {0, 0, 3}: 2 * .0625, {0, 1, 3}: 2 * .125,
		{-1, 0, 4}: 2, {0, 0, 6}: 1, {0, 1, 5}: 1,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("incorrect joint clock bins %v, want %v", got, want)
	}
}

func TestPlantTimeRequiresARealPlantAndKeepsOutOfClockEvents(t *testing.T) {
	d := eventTimingFixture()
	for _, variant := range []string{"no plant", "conflict", "unknown freeze", "long round"} {
		t.Run(variant, func(t *testing.T) {
			replay := *d
			replay.Rounds = append([]Round(nil), d.Rounds...)
			replay.Events = append([]Event(nil), d.Events...)
			if variant != "no plant" {
				replay.Events = append(replay.Events, Event{Type: "bomb_planted", Round: 1, T: 120})
			}
			if variant == "conflict" {
				replay.Events = append(replay.Events, Event{Type: "bomb_planted", Round: 1, T: 122})
			}
			if variant == "unknown freeze" {
				replay.Rounds[0].FreezeEnd = 0
			}
			rows := eventSeriesFor(t, BuildAnalysis(&replay), analysisTestID(1)).PlantTimeline
			if variant == "no plant" || variant == "conflict" {
				if len(rows) != 0 {
					t.Fatal("fabricated origin", rows)
				}
				return
			}
			expectedRound := 115
			if variant == "unknown freeze" {
				expectedRound = -1
			}
			count := 0.0
			for _, row := range rows {
				if row[3] == 5 && int(row[4]) == expectedRound && row[5] == 6 {
					count += row[6]
				}
			}
			if count != 2 {
				t.Fatal("shots at plant +5s and +5.5s lost", count)
			}
		})
	}
}

func TestPlantTimeUpgradePreservesPhaseSummaryAndRetries(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, _ := eventUpgradeFixture(t, a)
	d.Events = append(d.Events, Event{Type: "bomb_planted", Round: 1, T: 10.0625})
	writeFixtureGzip(t, j.result, d)
	fresh := BuildAnalysis(d)
	body, err := json.Marshal(fresh)
	if err != nil {
		t.Fatal(err)
	}
	var old map[string]json.RawMessage
	if err = json.Unmarshal(body, &old); err != nil {
		t.Fatal(err)
	}
	delete(old, "plantTimeVersion")
	var series []map[string]json.RawMessage
	if err = json.Unmarshal(old["series"], &series); err != nil {
		t.Fatal(err)
	}
	for _, s := range series {
		delete(s, "plantTimeline")
		s["futureField"] = json.RawMessage(`{"value":42}`)
	}
	old["series"], _ = json.Marshal(series)
	writeFixtureGzip(t, j.analysisResult, old)
	original := fileHash(t, j.analysisResult)
	read := func() map[string]json.RawMessage {
		return readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	}
	if err = os.Rename(j.result, j.result+".missing"); err != nil {
		t.Fatal(err)
	}
	unavailable := read()
	if len(unavailable["plantTimeVersion"]) != 0 || fileHash(t, j.analysisResult) != original || string(unavailable["plantPhaseVersion"]) != "1" {
		t.Fatal("missing replay overwrote old summary or reported relative coverage")
	}
	if err = os.Rename(j.result+".missing", j.result); err != nil {
		t.Fatal(err)
	}
	upgraded := read()
	assertMovementUpgradePreservesOld(t, old, upgraded)
	var got []AnalysisSeries
	if err = json.Unmarshal(upgraded["series"], &got); err != nil {
		t.Fatal(err)
	}
	if string(upgraded["plantTimeVersion"]) != "1" || !reflect.DeepEqual(got, fresh.Series) {
		t.Fatal("upgraded timelines differ from fresh build")
	}
}
