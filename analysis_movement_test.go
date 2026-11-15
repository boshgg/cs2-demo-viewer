package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func movementPartition(s AnalysisSeries) float64 {
	total := s.MovementUnknownSeconds + s.MovementBeyondSeconds
	for _, row := range s.MovementTimeline {
		total += row[4]
	}
	return total
}

func TestMovementSecondsSplitAtExactBinAndCountdownEnd(t *testing.T) {
	a := analysisMovementAccumulator{}
	anchor := 10.0
	p := Position{130, 70, 12}
	a.add(p, 10, 10.5, &anchor)
	a.add(p, 10.9, 11.15, &anchor)
	a.add(p, 124.9, 125.15, &anchor)
	a.add(p, 126, 126.25, &anchor)
	a.add(Position{130, 70, 200}, 140, 140.25, nil)
	var s AnalysisSeries
	a.fill(&s)
	bins := map[int]float64{}
	for _, row := range s.MovementTimeline {
		bins[int(row[3])] += row[4]
		if row[3] < 0 || row[3] >= 115 || row[3] != math.Floor(row[3]) {
			t.Fatalf("invalid elapsed bin: %v", row)
		}
	}
	for second, want := range map[int]float64{0: .6, 1: .15, 114: .1} {
		if math.Abs(bins[second]-want) > 1e-10 {
			t.Fatalf("second %d=%g, want%g", second, bins[second], want)
		}
	}
	if len(bins) != 3 || math.Abs(s.MovementBeyondSeconds-.4) > 1e-10 || s.MovementUnknownSeconds != .25 || math.Abs(movementPartition(s)-1.5) > 1e-10 {
		t.Fatalf("partition failed: %+v", s)
	}
	if len(s.MovementUntimedCells) != 2 {
		t.Fatalf("floor buckets were merged: %+v", s.MovementUntimedCells)
	}
}

func TestMovementBuildClipsFreezeDeathWinnerGapAndRoundSwitch(t *testing.T) {
	id := analysisTestID(1)
	d := &DemoData{ID: "bounds", Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 10, End: 140, EndedAt: 130}, {Number: 2, Start: 140, FreezeEnd: 150, End: 180, EndedAt: 151.05}}}
	for _, x := range []struct {
		time  float64
		round int
	}{{9.9, 1}, {10.1, 1}, {10.9, 1}, {11.15, 1}, {11.4, 1}, {129.9, 1}, {130.2, 1}, {140, 2}, {150.9, 2}, {151.1, 2}, {170, 2}} {
		d.Frames = append(d.Frames, Frame{T: x.time, Round: x.round, Players: []PlayerFrame{analysisTestPlayer(id, 2, 130)}})
	}
	d.Events = []Event{{Type: "kill", Round: 1, T: 11.05, VictimID: id, VictimTeam: 2, VictimPos: &Position{130, 64, 0}}}
	// Mark post-death snapshots dead, exactly as observed by the parser.
	for i := range d.Frames {
		if d.Frames[i].Round == 1 && d.Frames[i].T >= 11.05 {
			d.Frames[i].Players[0].Alive = false
		}
	}
	before, _ := json.Marshal(d)
	a := BuildAnalysis(d)
	if a.MovementTimingVersion != 1 {
		t.Fatal("missing version")
	}
	if len(a.Series) != 1 {
		t.Fatalf("unexpected series: %+v", a.Series)
	}
	s := a.Series[0]
	// R1: .1 + .25 + .15; R2: .15, winner clipping at 151.05.
	if math.Abs(analysisMetric(a, id, 3)-.65) > 1e-9 || math.Abs(movementPartition(s)-.65) > 1e-9 {
		t.Fatalf("bad observed duration: %+v", s)
	}
	bins := map[int]float64{}
	for _, row := range s.MovementTimeline {
		bins[int(row[3])] += row[4]
	}
	if math.Abs(bins[0]-.55) > 1e-9 || math.Abs(bins[1]-.1) > 1e-9 {
		t.Fatalf("did not align each round freeze end: %v", bins)
	}
	after, _ := json.Marshal(d)
	if string(before) != string(after) {
		t.Fatal("source replay was mutated")
	}
	if s.Cells[0][5] != 1 {
		t.Fatal("death metric changed")
	}
}

func TestMovementMissingOrAmbiguousFreezePreservesFullCells(t *testing.T) {
	for _, variant := range []string{"missing", "equal-placeholder", "duplicate", "nonfinite", "explicit-zero"} {
		t.Run(variant, func(t *testing.T) {
			r := Round{Number: 1, Start: 0, FreezeEnd: 1, End: 5}
			switch variant {
			case "missing", "equal-placeholder":
				r.FreezeEnd = 0
			case "nonfinite":
				r.FreezeEnd = math.NaN()
			case "explicit-zero":
				r.FreezeEnd = 0
				r.Economy = &EconomySnapshot{Source: "freeze_end", Time: 0}
			}
			rounds := []Round{r}
			if variant == "duplicate" {
				rounds = append(rounds, r)
			}
			p := analysisTestPlayer(analysisTestID(1), 2, 1)
			a := BuildAnalysis(&DemoData{ID: variant, Rounds: rounds, Damage: []DamageEvent{}, Frames: []Frame{{T: 1, Round: 1, Players: []PlayerFrame{p}}, {T: 1.2, Round: 1, Players: []PlayerFrame{p}}}})
			s := a.Series[0]
			if math.Abs(s.Cells[0][3]-.2) > 1e-9 || math.Abs(movementPartition(s)-.2) > 1e-9 {
				t.Fatal("full movement lost")
			}
			if variant == "explicit-zero" {
				if len(s.MovementTimeline) != 1 || s.MovementTimeline[0][3] != 1 {
					t.Fatal("explicit freeze-end zero must be trusted")
				}
			} else if len(s.MovementTimeline) != 0 || math.Abs(s.MovementUnknownSeconds-.2) > 1e-9 {
				t.Fatalf("missing timing was guessed: %+v", s)
			}
		})
	}
}

func movementUpgradeFixture(t *testing.T, a *app) (*job, *DemoData, map[string]json.RawMessage) {
	t.Helper()
	j, _ := statisticsFixture(t, a, "000000000000000000000021", "000000000000000000000021", "movement.dem")
	d := analysisSwapFixture("Alpha", "Bravo")
	d.ID = j.ID
	d.Name = j.Name
	d.Map = "de_mirage"
	for i := range d.Rounds {
		d.Rounds[i].FreezeEnd = d.Rounds[i].Start + .05
	}
	d.Utilities = []Utility{{ID: "throw", Type: "smoke", Round: 1, Start: .1, ThrowObserved: true, Detonated: true, Detonate: .3, X: 200, Y: 300}}
	j.Analysis, j.Map = true, d.Map
	writeFixtureGzip(t, j.result, d)
	body, _ := json.Marshal(BuildAnalysis(d))
	var old map[string]json.RawMessage
	json.Unmarshal(body, &old)
	delete(old, "movementTimingVersion")
	old["futureMetadata"] = json.RawMessage(`{"keep":true}`)
	var series []map[string]json.RawMessage
	json.Unmarshal(old["series"], &series)
	for _, s := range series {
		delete(s, "movementTimeline")
		delete(s, "movementUntimedCells")
		delete(s, "movementUnknownSeconds")
		delete(s, "movementBeyondSeconds")
		s["futureSeriesField"] = json.RawMessage(`"kept"`)
	}
	old["series"], _ = json.Marshal(series)
	writeFixtureGzip(t, j.analysisResult, old)
	return j, d, old
}

func assertMovementUpgradePreservesOld(t *testing.T, old, updated map[string]json.RawMessage) {
	t.Helper()
	for k, v := range old {
		if k == "series" || k == "warnings" {
			continue
		}
		var x, y any
		json.Unmarshal(v, &x)
		json.Unmarshal(updated[k], &y)
		if !reflect.DeepEqual(x, y) {
			t.Fatalf("unrelated top field changed: %s", k)
		}
	}
	var before, after []map[string]json.RawMessage
	json.Unmarshal(old["series"], &before)
	json.Unmarshal(updated["series"], &after)
	if len(before) != len(after) {
		t.Fatal("series population changed")
	}
	for i, b := range before {
		for k, v := range b {
			var x, y any
			json.Unmarshal(v, &x)
			json.Unmarshal(after[i][k], &y)
			if !reflect.DeepEqual(x, y) {
				t.Fatalf("existing series %d field changed: %s", i, k)
			}
		}
	}
}

func TestMovementLazyUpgradeMatchesFreshAndPreservesLibrary(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, old := movementUpgradeFixture(t, a)
	a.sessionSettings = json.RawMessage(`{"aliases":{"Alpha":"same"},"selectedPlayers":["retained"],"selectedMap":"de_mirage"}`)
	if err := a.persistLibrary(); err != nil {
		t.Fatal(err)
	}
	manifest, replay, revision := fileHash(t, filepath.Join(a.root, "library.json")), fileHash(t, j.result), j.Revision
	updated := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	assertMovementUpgradePreservesOld(t, old, updated)
	if string(updated["movementTimingVersion"]) != "1" {
		t.Fatal("movement marker missing")
	}
	var series []AnalysisSeries
	json.Unmarshal(updated["series"], &series)
	if !reflect.DeepEqual(series, BuildAnalysis(d).Series) {
		t.Fatal("streamed cache upgrade differs from fresh report")
	}
	if fileHash(t, filepath.Join(a.root, "library.json")) != manifest || fileHash(t, j.result) != replay || j.Revision != revision || len(a.pending) != 0 {
		t.Fatal("upgrade reparsed or altered library/settings/replay")
	}
	upgradedHash := fileHash(t, j.analysisResult)
	os.WriteFile(j.result, []byte("unavailable"), 0600)
	readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	if fileHash(t, j.analysisResult) != upgradedHash {
		t.Fatal("current cache upgraded repeatedly")
	}
}

func TestMovementUpgradeFailureRetainsUtilityTimingAndRetries(t *testing.T) {
	for _, variant := range []string{"missing", "crc", "missingframes", "identity"} {
		t.Run(variant, func(t *testing.T) {
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			j, d, old := movementUpgradeFixture(t, a)
			hash := fileHash(t, j.analysisResult)
			switch variant {
			case "missing":
				os.Remove(j.result)
			case "crc":
				b, _ := os.ReadFile(j.result)
				b[len(b)-8] ^= 1
				os.WriteFile(j.result, b, 0600)
			case "missingframes":
				copy := *d
				copy.Frames = nil
				writeFixtureGzip(t, j.result, &copy)
			case "identity":
				copy := *d
				copy.ID = "wrong"
				writeFixtureGzip(t, j.result, &copy)
			}
			updated := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			assertMovementUpgradePreservesOld(t, old, updated)
			if _, ok := updated["movementTimingVersion"]; ok {
				t.Fatal("failed upgrade claimed complete")
			}
			if fileHash(t, j.analysisResult) != hash {
				t.Fatal("failed upgrade overwrote legacy cache")
			}
			var series []AnalysisSeries
			json.Unmarshal(updated["series"], &series)
			for _, s := range series {
				if len(s.MovementTimeline) != 0 || s.MovementUnknownSeconds <= 0 {
					t.Fatal("missing movement evidence was guessed")
				}
			}
			writeFixtureGzip(t, j.result, d)
			fixed := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			if string(fixed["movementTimingVersion"]) != "1" {
				t.Fatal("restored replay did not retry")
			}
		})
	}
}

func TestMovementStreamingAcceptsReorderedFieldsAndChecksTrailer(t *testing.T) {
	d := analysisSwapFixture("Alpha", "Bravo")
	d.ID = "stream"
	d.Map = "de_mirage"
	for i := range d.Rounds {
		d.Rounds[i].FreezeEnd = d.Rounds[i].Start + .05
	}
	// Alphabetical map encoding places frames before rounds, unlike DemoData.
	b, _ := json.Marshal(d)
	var reordered map[string]json.RawMessage
	json.Unmarshal(b, &reordered)
	path := filepath.Join(t.TempDir(), "replay.gz")
	writeFixtureGzip(t, path, reordered)
	var meta analysisTimingReplay
	if err := streamAnalysisReplay(context.Background(), path, &meta, nil); err != nil {
		t.Fatal(err)
	}
	values, err := upgradeAnalysisMovement(context.Background(), path, &meta)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range BuildAnalysis(d).Series {
		var out AnalysisSeries
		values[analysisSeriesKey{s.PlayerID, s.TeamID, s.Side}].fill(&out)
		if !reflect.DeepEqual(out.MovementTimeline, s.MovementTimeline) {
			t.Fatal("field ordering changed movement bins")
		}
	}
	raw, _ := os.ReadFile(path)
	raw[len(raw)-8] ^= 1
	os.WriteFile(path, raw, 0600)
	if err := streamAnalysisReplay(context.Background(), path, &meta, nil); err == nil {
		t.Fatal("bad gzip CRC accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := streamAnalysisReplay(ctx, path, &meta, nil); err == nil {
		t.Fatal("cancelled stream succeeded")
	}
}
