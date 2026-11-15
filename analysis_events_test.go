package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

func eventTimingFixture() *DemoData {
	a, b := analysisTestID(1), analysisTestID(2)
	d := &DemoData{ID: "events", Map: "de_mirage", Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 10, EndedAt: 130, End: 140}}, Frames: []Frame{{T: 10, Round: 1, Players: []PlayerFrame{analysisTestPlayer(a, 2, 130), analysisTestPlayer(b, 3, 500)}}, {T: 10.1, Round: 1, Players: []PlayerFrame{analysisTestPlayer(a, 2, 130), analysisTestPlayer(b, 3, 500)}}}}
	for _, when := range []float64{9.999, 10, 10.999, 11, 124.999, 125, 125.5, 130, 130.001} {
		d.Damage = append(d.Damage, DamageEvent{T: when, Round: 1, AttackerID: a, AttackerTeam: 2, VictimID: b, VictimTeam: 3, Weapon: common.EqAK47.String(), Damage: 10, AttackerPos: &Position{130, 70, 10}, VictimPos: &Position{500, 70, 10}})
		d.Events = append(d.Events, Event{T: when, Type: "kill", Round: 1, VictimID: a, VictimTeam: 2, VictimPos: &Position{130, 70, 20}})
		d.Shots = append(d.Shots, Shot{T: when, Round: 1, PlayerID: a, Team: 2, Weapon: common.EqAK47.String(), X: 130, Y: 70, Z: 30})
	}
	return d
}

func eventPartition(s AnalysisSeries) (timed, unknown, beyond [3]float64) {
	for _, r := range s.EventTimeline {
		for n := 0; n < 3; n++ {
			timed[n] += r[n+4]
		}
	}
	for _, r := range s.EventUntimedCells {
		for n := 0; n < 3; n++ {
			unknown[n] += r[n+3]
			beyond[n] += r[n+6]
		}
	}
	return
}

func eventSeriesFor(t *testing.T, a *AnalysisDemo, id string) AnalysisSeries {
	t.Helper()
	for _, s := range a.Series {
		if s.PlayerID == id {
			return s
		}
	}
	t.Fatalf("missing player %s", id)
	return AnalysisSeries{}
}

func TestEventTimingPartitionsSecondsAndPreservesMetricSpecificHeight(t *testing.T) {
	d := eventTimingFixture()
	before, _ := json.Marshal(d)
	a := BuildAnalysis(d)
	if a.EventTimingVersion != 1 {
		t.Fatal("event timing version missing")
	}
	s := eventSeriesFor(t, a, analysisTestID(1))
	timed, unknown, beyond := eventPartition(s)
	if timed != [3]float64{3, 4, 4} || unknown != [3]float64{} || beyond != [3]float64{2, 3, 3} {
		t.Fatalf("invalid partition: timed %v, unknown %v, beyond %v", timed, unknown, beyond)
	}
	var bins [3]map[int]float64
	for n := range bins {
		bins[n] = map[int]float64{}
	}
	for _, row := range s.EventTimeline {
		if row[3] < 0 || row[3] >= 115 || math.Floor(row[3]) != row[3] {
			t.Fatalf("invalid elapsed second: %v", row)
		}
		nonzero := 0
		for metric := 0; metric < 3; metric++ {
			if row[metric+4] > 0 {
				nonzero++
				bins[metric][int(row[3])] += row[metric+4]
				if row[2] != float64(10*(metric+1)) {
					t.Fatalf("metrics shared their height: %v", row)
				}
			}
		}
		if nonzero != 1 {
			t.Fatal("event row should retain one metric's height")
		}
	}
	if bins[0][0] != 1 || bins[1][0] != 2 || bins[2][0] != 2 || bins[0][1] != 1 || bins[0][114] != 1 {
		t.Fatalf("boundary bins incorrect: %v", bins)
	}
	for metric := 0; metric < 3; metric++ {
		if full := analysisMetric(a, s.PlayerID, metric+4); full != timed[metric]+unknown[metric]+beyond[metric] {
			t.Fatalf("metric %d lost events: %g", metric, full)
		}
	}
	after, _ := json.Marshal(d)
	if string(after) != string(before) {
		t.Fatal("source replay changed")
	}
}

func TestEventTimingDedupUsesFirstAcceptedRecordAndExactOldEligibility(t *testing.T) {
	d := eventTimingFixture()
	d.Damage = nil
	d.Events = nil
	d.Shots = nil
	a, b := analysisTestID(1), analysisTestID(2)
	hit := func(when, z float64) DamageEvent {
		return DamageEvent{T: when, Round: 1, AttackerID: a, AttackerTeam: 2, VictimID: b, VictimTeam: 3, Weapon: common.EqAK47.String(), AttackerPos: &Position{130, 70, z}, VictimPos: &Position{500, 70, 0}}
	}
	d.Damage = append(d.Damage, hit(10.8, 30), hit(10.1, 10), hit(11, 50)) // First array record wins each spatial/second group.
	negative := hit(12, 0)
	negative.Damage = -1
	d.Damage = append(d.Damage, negative)
	teamkill := hit(13, 0)
	teamkill.VictimTeam = 2
	d.Damage = append(d.Damage, teamkill)
	grenade := hit(14, 0)
	grenade.Weapon = common.EqHE.String()
	d.Damage = append(d.Damage, grenade)
	missingPos := hit(15, 0)
	missingPos.AttackerPos = nil
	d.Damage = append(d.Damage, missingPos)
	d.Damage = append(d.Damage, hit(math.NaN(), 0), hit(140, 0))
	for _, weapon := range []string{common.EqAK47.String(), common.EqHE.String(), common.EqKnife.String(), "future_weapon"} {
		d.Shots = append(d.Shots, Shot{T: 11, Round: 1, PlayerID: a, Team: 2, Weapon: weapon, X: 130, Y: 70})
	}
	d.Events = []Event{{Type: "kill", T: 11, Round: 1, VictimID: a, VictimTeam: 2, VictimPos: &Position{130, 70, 0}}, {Type: "kill", T: 12, Round: 1, VictimID: a, VictimTeam: 2}, {Type: "round_end", T: 12, Round: 1, VictimID: a, VictimTeam: 2, VictimPos: &Position{130, 70, 0}}}
	actual := BuildAnalysis(d)
	s := eventSeriesFor(t, actual, a)
	if analysisMetric(actual, a, 4) != 2 || analysisMetric(actual, b, 4) != 3 || analysisMetric(actual, a, 5) != 1 || analysisMetric(actual, a, 6) != 1 {
		t.Fatal("legacy event eligibility changed")
	}
	for _, row := range s.EventTimeline {
		if row[4] > 0 {
			want := 30.0
			if row[3] == 1 {
				want = 50
			}
			if row[2] != want {
				t.Fatalf("dedup did not retain first accepted actual event: %v", row)
			}
		}
	}
}

func TestEventTimingMissingFreezeAndPerRoundAnchors(t *testing.T) {
	for _, variant := range []string{"missing", "placeholder", "duplicate", "nonfinite", "explicit-zero"} {
		t.Run(variant, func(t *testing.T) {
			d := eventTimingFixture()
			switch variant {
			case "missing", "placeholder":
				d.Rounds[0].FreezeEnd = d.Rounds[0].Start
			case "duplicate":
				d.Rounds = append(d.Rounds, d.Rounds[0])
			case "nonfinite":
				d.Rounds[0].FreezeEnd = math.NaN()
			case "explicit-zero":
				d.Rounds[0].FreezeEnd = 0
				d.Rounds[0].Economy = &EconomySnapshot{Source: "freeze_end", Time: 0}
			}
			a := BuildAnalysis(d)
			for _, s := range a.Series {
				timed, unknown, beyond := eventPartition(s)
				for metric := 0; metric < 3; metric++ {
					var full float64
					for _, c := range s.Cells {
						full += c[metric+4]
					}
					if full != timed[metric]+unknown[metric]+beyond[metric] {
						t.Fatal("unknown anchor lost full count")
					}
					if variant != "explicit-zero" && (timed[metric] != 0 || beyond[metric] != 0 || unknown[metric] != full) {
						t.Fatal("untrusted anchor was guessed")
					}
				}
			}
		})
	}
	d := eventTimingFixture()
	d.Rounds = append(d.Rounds, Round{Number: 2, Start: 140, FreezeEnd: 150, End: 180})
	d.Shots = append(d.Shots, Shot{T: 150, Round: 2, PlayerID: analysisTestID(1), Team: 2, Weapon: common.EqAK47.String(), X: 130, Y: 70, Z: 30})
	p := analysisTestPlayer(analysisTestID(1), 2, 130)
	d.Frames = append(d.Frames, Frame{T: 150, Round: 2, Players: []PlayerFrame{p}})
	s := eventSeriesFor(t, BuildAnalysis(d), analysisTestID(1))
	zeroShots := 0.0
	for _, r := range s.EventTimeline {
		if r[3] == 0 {
			zeroShots += r[6]
		}
	}
	if zeroShots != 3 {
		t.Fatalf("round two did not restart at 1:55: %g", zeroShots)
	}
}

func eventUpgradeFixture(t *testing.T, a *app) (*job, *DemoData, map[string]json.RawMessage) {
	t.Helper()
	j, _ := statisticsFixture(t, a, "000000000000000000000031", "000000000000000000000031", "events.dem")
	d := eventTimingFixture()
	d.ID, d.Name = j.ID, j.Name
	j.Analysis, j.Map = true, d.Map
	writeFixtureGzip(t, j.result, d)
	body, _ := json.Marshal(BuildAnalysis(d))
	var old map[string]json.RawMessage
	json.Unmarshal(body, &old)
	delete(old, "eventTimingVersion")
	old["futureMetadata"] = json.RawMessage(`{"untouched":true}`)
	var series []map[string]json.RawMessage
	json.Unmarshal(old["series"], &series)
	for _, s := range series {
		delete(s, "eventTimeline")
		delete(s, "eventUntimedCells")
		s["futureSeriesField"] = json.RawMessage(`"retained"`)
	}
	old["series"], _ = json.Marshal(series)
	writeFixtureGzip(t, j.analysisResult, old)
	return j, d, old
}

func TestEventLazyUpgradePreservesCurrentMovementAndLibrary(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, old := eventUpgradeFixture(t, a)
	// Deliberate sentinel values prove an event-only upgrade does not rebuild
	// either current movement field or the existing utility metadata.
	var oldSeries []map[string]json.RawMessage
	json.Unmarshal(old["series"], &oldSeries)
	oldSeries[0]["movementTimeline"] = json.RawMessage(`[[32,96,0,2,123]]`)
	oldSeries[0]["movementUnknownSeconds"] = json.RawMessage(`99`)
	old["series"], _ = json.Marshal(oldSeries)
	writeFixtureGzip(t, j.analysisResult, old)
	a.sessionSettings = json.RawMessage(`{"aliases":{"team":"retained"},"movementRange":{"start":15,"end":45},"selectedPlayers":["same"]}`)
	if err := a.persistLibrary(); err != nil {
		t.Fatal(err)
	}
	manifest, replay, revision := fileHash(t, filepath.Join(a.root, "library.json")), fileHash(t, j.result), j.Revision
	updated := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	assertMovementUpgradePreservesOld(t, old, updated)
	if string(updated["eventTimingVersion"]) != "1" {
		t.Fatal("event marker missing")
	}
	var result []AnalysisSeries
	json.Unmarshal(updated["series"], &result)
	fresh := BuildAnalysis(d)
	for i, s := range result {
		if !reflect.DeepEqual(s.EventTimeline, fresh.Series[i].EventTimeline) || !reflect.DeepEqual(s.EventUntimedCells, fresh.Series[i].EventUntimedCells) {
			t.Fatal("streamed event bins differ from fresh")
		}
	}
	if fileHash(t, filepath.Join(a.root, "library.json")) != manifest || fileHash(t, j.result) != replay || j.Revision != revision || len(a.pending) != 0 {
		t.Fatal("upgrade altered source, library or reparse queue")
	}
	hash := fileHash(t, j.analysisResult)
	os.WriteFile(j.result, []byte("unavailable"), 0600)
	readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	if fileHash(t, j.analysisResult) != hash {
		t.Fatal("current event cache upgraded again")
	}
}

func TestEventUpgradeFailurePreservesCacheAndRetries(t *testing.T) {
	for _, variant := range []string{"missing", "crc", "missingframes", "identity", "write"} {
		t.Run(variant, func(t *testing.T) {
			if variant == "write" && runtime.GOOS != "windows" {
				t.Skip("Windows file sharing test")
			}
			a := persistentViewer(t, t.TempDir(), t.TempDir())
			j, d, old := eventUpgradeFixture(t, a)
			hash := fileHash(t, j.analysisResult)
			var lock *os.File
			switch variant {
			case "missing":
				if err := os.Remove(j.result); err != nil {
					t.Fatal(err)
				}
			case "crc":
				raw, err := os.ReadFile(j.result)
				if err != nil {
					t.Fatal(err)
				}
				raw[len(raw)-8] ^= 1
				if err := os.WriteFile(j.result, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "missingframes":
				copy := *d
				copy.Frames = nil
				writeFixtureGzip(t, j.result, &copy)
			case "identity":
				copy := *d
				copy.ID = "other"
				writeFixtureGzip(t, j.result, &copy)
			case "write":
				var err error
				lock, err = os.Open(j.analysisResult)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Close()
			}
			updated := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			assertMovementUpgradePreservesOld(t, old, updated)
			if _, ok := updated["eventTimingVersion"]; ok {
				t.Fatal("failed event upgrade claimed complete")
			}
			if fileHash(t, j.analysisResult) != hash {
				t.Fatal("failed upgrade replaced source cache")
			}
			var series []AnalysisSeries
			json.Unmarshal(updated["series"], &series)
			for _, s := range series {
				timed, unknown, beyond := eventPartition(s)
				if timed != [3]float64{} || beyond != [3]float64{} {
					t.Fatal("missing evidence invented timed data")
				}
				for m := 0; m < 3; m++ {
					full := 0.0
					for _, c := range s.Cells {
						full += c[m+4]
					}
					if full != unknown[m] {
						t.Fatal("unknown fallback lost events")
					}
				}
			}
			if lock != nil {
				if err := lock.Close(); err != nil {
					t.Fatal(err)
				}
			}
			restoreChangedAnalysisReplay(t, j.result, d, a.analysisUpgradeFailures[j.ID].Replay)
			fixed := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
			if string(fixed["eventTimingVersion"]) != "1" {
				t.Fatal("restored cache failed to retry")
			}
		})
	}
}

func TestEventUpgradeRetryRequiresChangedFingerprintOrCooldown(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, _ := eventUpgradeFixture(t, a)
	raw, err := os.ReadFile(j.result)
	if err != nil {
		t.Fatal(err)
	}
	raw[len(raw)-8] ^= 1
	if err := os.WriteFile(j.result, raw, 0600); err != nil {
		t.Fatal(err)
	}
	readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	failure, found := a.analysisUpgradeFailures[j.ID]
	if !found {
		t.Fatal("corrupt cache failure was not tracked")
	}
	writeFixtureGzip(t, j.result, d)
	unchanged := time.Unix(0, failure.Replay.Modified)
	if err := os.Chtimes(j.result, unchanged, unchanged); err != nil {
		t.Fatal(err)
	}
	if got := analysisFingerprint(j.result); got != failure.Replay {
		t.Fatalf("same-size CRC fixture must reproduce the metadata collision: %+v != %+v", got, failure.Replay)
	}
	var valid analysisTimingReplay
	if err := streamAnalysisReplay(context.Background(), j.result, &valid, nil); err != nil {
		t.Fatalf("restored bytes must be valid despite unchanged metadata: %v", err)
	}
	throttled := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	if _, upgraded := throttled["eventTimingVersion"]; upgraded || a.analysisUpgradeFailures[j.ID].At != failure.At {
		t.Fatal("unchanged metadata must retain the existing retry cooldown")
	}
	restoreChangedAnalysisReplay(t, j.result, d, failure.Replay)
	fixed := readAnalysisResponse(t, localRequest(a.handler(), "GET", "/api/demos/"+j.ID+"/analysis"))
	if string(fixed["eventTimingVersion"]) != "1" {
		t.Fatal("observable replacement should retry immediately")
	}
}

func TestEventUpgradeConservationMismatchOnlyInvalidatesAffectedMetric(t *testing.T) {
	a := persistentViewer(t, t.TempDir(), t.TempDir())
	j, d, old := eventUpgradeFixture(t, a)
	var meta analysisTimingReplay
	if err := streamAnalysisReplay(context.Background(), j.result, &meta, nil); err != nil {
		t.Fatal(err)
	}
	values, err := upgradeAnalysisEvents(context.Background(), j.result, &meta)
	if err != nil {
		t.Fatal(err)
	}
	var records []map[string]json.RawMessage
	json.Unmarshal(old["series"], &records)
	var cells []AnalysisCell
	json.Unmarshal(records[0]["cells"], &cells)
	cells[0][5] += 2
	records[0]["cells"], _ = json.Marshal(cells)
	old["series"], _ = json.Marshal(records)
	if err := patchAnalysisEventTiming(old, values); err != nil {
		t.Fatal(err)
	}
	var series []AnalysisSeries
	json.Unmarshal(old["series"], &series)
	timed, unknown, beyond := eventPartition(series[0])
	fresh := BuildAnalysis(d)
	ft, _, fb := eventPartition(fresh.Series[0])
	if timed[0] != ft[0] || timed[2] != ft[2] || beyond[0] != fb[0] || beyond[2] != fb[2] || timed[1] != 0 || beyond[1] != 0 || unknown[1] != 9 {
		t.Fatalf("metric-specific mismatch fallback wrong: %v / %v / %v", timed, unknown, beyond)
	}
}

func TestEventStreamReorderedFieldsAndCancellation(t *testing.T) {
	d := eventTimingFixture()
	raw, _ := json.Marshal(d)
	var fields map[string]json.RawMessage
	json.Unmarshal(raw, &fields)
	path := filepath.Join(t.TempDir(), "events.gz")
	writeFixtureGzip(t, path, fields)
	var meta analysisTimingReplay
	if err := streamAnalysisReplay(context.Background(), path, &meta, nil); err != nil {
		t.Fatal(err)
	}
	values, err := upgradeAnalysisEvents(context.Background(), path, &meta)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range BuildAnalysis(d).Series {
		var out AnalysisSeries
		values[analysisSeriesKey{s.PlayerID, s.TeamID, s.Side}].fill(&out)
		if !reflect.DeepEqual(s.EventTimeline, out.EventTimeline) || !reflect.DeepEqual(s.EventUntimedCells, out.EventUntimedCells) {
			t.Fatal("JSON object ordering changed timing")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := upgradeAnalysisEvents(ctx, path, &meta); err == nil {
		t.Fatal("cancelled event upgrade succeeded")
	}
}
