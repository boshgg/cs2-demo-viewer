package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestStatisticsPistolMismatchConditionalNetDoesNotChangeDeathImpact(t *testing.T) {
	for _, weapon := range []string{"MP9", "AK-47", "Nova", "Negev"} {
		for _, state := range []string{"survived", "died", "world-death", "post-round-death", "unknown-outcome"} {
			t.Run(weapon+"/"+state, func(t *testing.T) {
				d := impactDemo()
				d.Rounds = d.Rounds[:1]
				d.Rounds[0].Winner = 3
				d.Events = []Event{statsKill(weapon, "Glock-18")}
				later := impactAt(statsKill("AK-47", weapon), 40, "s3-p1", "s2-p0", 3, 2)
				switch state {
				case "died":
					d.Events = append(d.Events, later)
				case "world-death":
					later.KillerID, later.KillerTeam, later.Weapon = "", 0, "worldspawn"
					d.Events = append(d.Events, later)
				case "post-round-death":
					later.T, later.VictimWeaponTime = 110, 110
					d.Events = append(d.Events, later)
				case "unknown-outcome":
					d.Rounds[0].Winner = 0
				}
				result := BuildStatistics(d)
				kill := result.Kills[0]
				wantBase := -4
				if weapon == "MP9" {
					wantBase = -1
				}
				wantScore, wantAdjustment := 0, "advantage_kill_zero"
				if state == "died" || state == "world-death" || state == "post-round-death" {
					wantScore, wantAdjustment = wantBase, "advantage_kill_round_death"
				}
				if kill.Score == nil || *kill.Score != wantScore || !kill.PistolMismatch || *kill.BaseScore != wantBase || *kill.ScoreMultiplier != 1 || kill.ScoreAdjustment != wantAdjustment || kill.ScoreReason == "" {
					t.Fatalf("conditional negative rule or provenance wrong: %+v", kill)
				}
				if result.Summary.PistolMismatchKills != 1 {
					t.Fatal("zero rule removed the mismatch count")
				}
				if state != "unknown-outcome" && (result.Impact.Kills[0].Score == nil || *result.Impact.Kills[0].Score != 1000+125*wantScore) {
					t.Fatal("impact did not consume final conditional net value")
				}
				if state == "died" && (result.Impact.Deaths[1].Penalty == nil || *result.Impact.Deaths[1].Penalty >= 0) {
					t.Fatal("later death lost its ordinary penalty")
				}
				// Reconstruct exactly the pre-adjustment legacy net values, then
				// verify every death evidence field and penalty stays unchanged.
				legacy := *result
				legacy.Kills = append([]KillScore{}, result.Kills...)
				for i := range legacy.Kills {
					k := &legacy.Kills[i]
					if k.ScoreAdjustment != "" {
						original := *k.BaseScore * *k.ScoreMultiplier
						k.Score, k.ScoreAdjustment, k.ScoreReason = &original, "", ""
					}
				}
				snapshots := map[int]EconomySnapshot{2: *d.Rounds[0].Economy}
				names := map[string]string{}
				for _, player := range d.Players {
					names[player.ID] = player.Name
				}
				legacyImpact := buildStatisticsImpact(d, &legacy, d.Rounds, snapshots, map[int][]*Frame{}, names)
				if !reflect.DeepEqual(result.Impact.Deaths, legacyImpact.Deaths) || !reflect.DeepEqual(result.Impact.Rounds, legacyImpact.Rounds) {
					t.Fatal("zero-value kill adjustment changed death impact or exposure")
				}
			})
		}
	}
}

func TestStatisticsConditionalNetRebuildsVersionFourDerivedCacheInPlace(t *testing.T) {
	a, handler := testViewer(t)
	id := "000000000000000000000024"
	j, _ := statisticsFixture(t, a, id, id+"-7", "pistol-zero.dem")
	d := impactDemo()
	d.ID, d.Name, j.Map = id, j.Name, d.Map
	d.Events[0] = statsKill("AK-47", "Glock-18")
	writeFixtureGzip(t, j.result, d)
	before := fileHash(t, j.result)
	a.statisticsKey = id + "\x00" + j.Revision + "\x004"
	a.statisticsJSON = []byte(`{"ruleVersion":"4","kills":[{"score":0,"scoreAdjustment":"pistol_mismatch_zero"}]}`)
	response := localRequest(handler, "GET", "/api/demos/"+id+"/statistics")
	var result StatisticsDemo
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.RuleVersion != StatisticsVersion || result.Kills[0].Score == nil || *result.Kills[0].Score != 0 || *result.Kills[0].BaseScore != -4 || result.Kills[0].ScoreAdjustment != "advantage_kill_zero" || result.Summary.PistolMismatchKills != 1 || result.Summary.Score != 0 || result.Impact.Version != "1" {
		t.Fatalf("version 4 report not upgraded to conditional-net contract: %d %s", response.Code, response.Body.String())
	}
	if fileHash(t, j.result) != before || len(a.pending) != 0 || j.Analysis || j.Revision != id+"-7" {
		t.Fatal("derived cache upgrade changed source, revision or membership")
	}
}
