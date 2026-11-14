package main

import (
	"encoding/json"
	"math"
	"testing"
)

func assertWeightedKill(t *testing.T, kill KillScore, base, multiplier, score int) {
	t.Helper()
	if kill.ExcludedReason != "" || kill.BaseScore == nil || *kill.BaseScore != base || kill.ScoreMultiplier == nil || *kill.ScoreMultiplier != multiplier || kill.Score == nil || *kill.Score != score {
		t.Fatalf("wrong weighted score: base=%v multiplier=%v score=%v; want %d × %d = %d, exclusion=%q", kill.BaseScore, kill.ScoreMultiplier, kill.Score, base, multiplier, score, kill.ExcludedReason)
	}
	body, err := json.Marshal(kill)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	json.Unmarshal(body, &payload)
	if payload["baseScore"] != float64(base) || payload["scoreMultiplier"] != float64(multiplier) || payload["score"] != float64(score) {
		t.Fatal("weighted score provenance missing from JSON")
	}
}

func TestStatisticsWeightedScoreExplicitFourByFourMatrix(t *testing.T) {
	guns := []string{"Glock-18", "MP9", "AK-47", "AWP"}
	// Independent literal oracle: rows are killer tier, columns victim tier.
	bases := [4][4]int{{0, 1, 4, 6}, {-1, 0, 3, 5}, {-4, -3, 0, 2}, {-6, -5, -2, 0}}
	multipliers := [4][4]int{{1, 2, 3, 4}, {1, 1, 2, 3}, {1, 1, 1, 2}, {1, 1, 1, 1}}
	scores := [4][4]int{{0, 2, 12, 24}, {-1, 0, 6, 15}, {-4, -3, 0, 4}, {-6, -5, -2, 0}}
	for attacker, weapon := range guns {
		for victim, held := range guns {
			t.Run(weapon+"_vs_"+held, func(t *testing.T) {
				d := statsDemo(nil)
				d.Events = []Event{statsKill(weapon, held)}
				result := BuildStatistics(d)
				assertWeightedKill(t, result.Kills[0], bases[attacker][victim], multipliers[attacker][victim], scores[attacker][victim])
				if result.Summary.Score != scores[attacker][victim] || result.Summary.Average == nil || *result.Summary.Average != float64(scores[attacker][victim]) || result.Summary.ScoredKills != 1 {
					t.Fatal("single-kill summary does not use the final weighted score")
				}
				wantMismatch := victim == 0 && (attacker == 1 || attacker == 2)
				if result.Kills[0].PistolMismatch != wantMismatch {
					t.Fatal("weighted scoring changed the pistol matchup metric")
				}
			})
		}
	}
}

func TestStatisticsWeightedAliasesShotgunsAndMachineGuns(t *testing.T) {
	for _, test := range []struct {
		killer, victim          string
		base, multiplier, score int
	}{
		{"weapon_usp_silencer", "scout", 6, 4, 24},
		{"weapon_mp5sd", "weapon_m4a1_silencer", 3, 2, 6},
		{"deagle", "weapon_sg556", 4, 3, 12},
		{"weapon_ump45", "weapon_ssg08", 5, 3, 15},
		{"weapon_galilar", "AWP", 2, 2, 4},
		{"Nova", "AWP", 2, 2, 4},
		{"MP9", "Nova", 3, 2, 6},
		{"Glock-18", "Negev", 4, 3, 12},
		{"M249", "MP9", -3, 1, -3},
		{"Nova", "Negev", 0, 1, 0},
		{"AWP", "XM1014", -2, 1, -2},
	} {
		t.Run(test.killer+"_vs_"+test.victim, func(t *testing.T) {
			d := statsDemo(nil)
			d.Events = []Event{statsKill(test.killer, test.victim)}
			assertWeightedKill(t, BuildStatistics(d).Kills[0], test.base, test.multiplier, test.score)
		})
	}
}

func assertWeightedSummary(t *testing.T, label string, summary StatisticsSummary, score, kills int) {
	t.Helper()
	if summary.Score != score || summary.ScoredKills != kills {
		t.Fatalf("%s summary got score=%d/count=%d want %d/%d", label, summary.Score, summary.ScoredKills, score, kills)
	}
	if kills == 0 {
		if summary.Average != nil {
			t.Fatalf("%s zero-kill average should be unknown", label)
		}
	} else if summary.Average == nil || math.Abs(*summary.Average-float64(score)/float64(kills)) > 1e-12 {
		t.Fatalf("%s mean does not use final weighted values", label)
	}
}

func assertWeightedPlayers(t *testing.T, label string, players []StatisticsPlayer, expected map[string][2]int) {
	t.Helper()
	for _, player := range players {
		value := expected[player.ID]
		assertWeightedSummary(t, label+"/"+player.ID, player.Summary, value[0], value[1])
	}
}

func TestStatisticsWeightedScoresAndMeansReachAllAggregates(t *testing.T) {
	players := append(statsSquad(2, "AK-47", 0, 100, nil), statsSquad(3, "AWP", 0, 100, nil)...)
	d := statsDemo(players)
	swapped := append([]PlayerFrame(nil), players...)
	for i := range swapped {
		swapped[i].Team = 5 - swapped[i].Team
	}
	d.Rounds = append(d.Rounds, Round{Number: 13, Start: 130, FreezeEnd: 140, End: 250, Economy: &EconomySnapshot{Time: 140, Source: "freeze_end", Players: swapped, Half: 2, HalfSource: "convar"}})
	for _, row := range []struct {
		weapon, victimWeapon, killer, victim string
		round, side                          int
		at                                   float64
	}{
		{"Glock-18", "AWP", "s2-p0", "s3-p0", 2, 2, 30}, // +24
		{"AWP", "Glock-18", "s3-p1", "s2-p1", 2, 3, 31}, // -6
		{"MP9", "AK-47", "s2-p1", "s3-p1", 2, 2, 32},    // +6
		{"Knife", "Glock-18", "s2-p0", "s3-p0", 2, 2, 33},
		{"AK-47", "AWP", "s2-p0", "s3-p0", 13, 3, 150},      // +4
		{"Glock-18", "AK-47", "s3-p1", "s2-p1", 13, 2, 151}, // +12
		{"AK-47", "M4A4", "s3-p0", "s2-p0", 13, 2, 152},     // 0
		{"MP9", "Glock-18", "s2-p1", "s3-p1", 13, 3, 153},   // -1
	} {
		e := statsKill(row.weapon, row.victimWeapon)
		e.KillerID, e.VictimID, e.Round, e.KillerTeam, e.VictimTeam = row.killer, row.victim, row.round, row.side, 5-row.side
		e.T, e.VictimWeaponTime = row.at, row.at
		d.Events = append(d.Events, e)
	}
	result := BuildStatistics(d)
	assertWeightedSummary(t, "total", result.Summary, 39, 7)
	if result.Summary.ExcludedKills != 1 || result.Summary.PistolMismatchKills != 1 {
		t.Fatal("excluded/mismatch counts changed under weighted scoring")
	}
	assertWeightedPlayers(t, "total", result.Players, map[string][2]int{"s2-p0": {28, 2}, "s2-p1": {5, 2}, "s3-p1": {6, 2}, "s3-p0": {0, 1}})
	for _, round := range result.Rounds {
		if round.Number == 2 {
			assertWeightedSummary(t, "round2", round.Summary, 24, 3)
			assertWeightedPlayers(t, "round2", round.Players, map[string][2]int{"s2-p0": {24, 1}, "s2-p1": {6, 1}, "s3-p1": {-6, 1}})
		} else {
			assertWeightedSummary(t, "round13", round.Summary, 15, 4)
			assertWeightedPlayers(t, "round13", round.Players, map[string][2]int{"s2-p0": {4, 1}, "s2-p1": {-1, 1}, "s3-p1": {12, 1}, "s3-p0": {0, 1}})
		}
	}
	for _, half := range result.Halves {
		if half.Half == 1 {
			assertWeightedSummary(t, "half1", half.Summary, 24, 3)
			assertWeightedPlayers(t, "half1", half.Players, map[string][2]int{"s2-p0": {24, 1}, "s2-p1": {6, 1}, "s3-p1": {-6, 1}})
		} else {
			assertWeightedSummary(t, "half2", half.Summary, 15, 4)
			assertWeightedPlayers(t, "half2", half.Players, map[string][2]int{"s2-p0": {4, 1}, "s2-p1": {-1, 1}, "s3-p1": {12, 1}, "s3-p0": {0, 1}})
		}
	}
	for _, side := range result.Sides {
		if side.Side == 2 {
			assertWeightedSummary(t, "T", side.Summary, 42, 4)
			assertWeightedPlayers(t, "T", side.Players, map[string][2]int{"s2-p0": {24, 1}, "s2-p1": {6, 1}, "s3-p1": {12, 1}, "s3-p0": {0, 1}})
		} else {
			assertWeightedSummary(t, "CT", side.Summary, -3, 3)
			assertWeightedPlayers(t, "CT", side.Players, map[string][2]int{"s2-p0": {4, 1}, "s2-p1": {-1, 1}, "s3-p1": {-6, 1}})
		}
	}
	firstTeam := result.Rounds[0].T.TeamKey
	for _, team := range result.Teams {
		if team.TeamKey == firstTeam {
			assertWeightedSummary(t, "first team", team.Summary, 33, 4)
			assertWeightedPlayers(t, "first team", team.Players, map[string][2]int{"s2-p0": {28, 2}, "s2-p1": {5, 2}})
		} else {
			assertWeightedSummary(t, "second team", team.Summary, 6, 3)
			assertWeightedPlayers(t, "second team", team.Players, map[string][2]int{"s3-p1": {6, 2}, "s3-p0": {0, 1}})
		}
	}
}

func TestStatisticsWeightedLegacyCacheDerivesWithoutReparsing(t *testing.T) {
	a, h := testViewer(t)
	id := "000000000000000000000017"
	j, _ := statisticsFixture(t, a, id, id, "legacy-weighted.dem")
	d := statsDemo(nil)
	d.ID, d.Name, d.StatisticsVersion = id, j.Name, 0
	first, second := statsKill("Glock-18", ""), statsKill("AK-47", "")
	first.VictimWeaponSource, second.VictimWeaponSource = "", ""
	first.VictimWeaponTime, second.VictimWeaponTime = 0, 0
	second.T = 31
	d.Events = []Event{first, second}
	d.Frames = []Frame{
		{Round: 2, T: 29.9, Players: []PlayerFrame{statsPlayer(first.VictimID, 3, "AWP", 0, 100, nil)}},
		{Round: 2, T: 30.9, Players: []PlayerFrame{statsPlayer(second.VictimID, 3, "Glock-18", 0, 100, nil)}},
	}
	j.Map = d.Map
	writeFixtureGzip(t, j.result, d)
	before := fileHash(t, j.result)
	a.statisticsKey = id + "\x00" + id + "\x001"
	a.statisticsJSON = []byte(`{"ruleVersion":"1","score":2}`)
	w := localRequest(h, "GET", "/api/demos/"+id+"/statistics")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result StatisticsDemo
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	assertWeightedKill(t, result.Kills[0], 6, 4, 24)
	assertWeightedKill(t, result.Kills[1], -4, 1, -4)
	assertWeightedSummary(t, "legacy", result.Summary, 20, 2)
	if result.RuleVersion != StatisticsVersion || !result.Kills[0].Approx || !result.Kills[1].Approx || !result.Kills[1].PistolMismatch || j.Revision != id || len(a.pending) != 0 || fileHash(t, j.result) != before {
		t.Fatal("legacy derived report lost evidence or changed its original replay")
	}
}
