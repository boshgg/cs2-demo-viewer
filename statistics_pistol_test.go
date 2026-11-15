package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestStatisticsPistolMismatchMatchesActualGunClasses(t *testing.T) {
	for _, test := range []struct {
		killer, victim string
		want           bool
		score          int
		excluded       bool
	}{
		{"MP9", "Glock-18", true, 0, false},
		{"MP5-SD", "USP-S", true, 0, false},
		{"AK-47", "P250", true, 0, false},
		{"M4A1-S", "Desert Eagle", true, 0, false},
		{"Nova", "Glock-18", true, 0, false},
		{"XM1014", "USP-S", true, 0, false},
		{"M249", "Five-SeveN", true, 0, false},
		{"Negev", "Dual Berettas", true, 0, false},
		{"AWP", "Glock-18", false, 0, false},
		{"SSG 08", "P250", false, 0, false},
		{"SCAR-20", "Glock-18", false, 0, false},
		{"G3SG1", "Glock-18", false, 0, false},
		{"Glock-18", "P250", false, 0, false},
		{"MP9", "MP7", false, 0, false},
		{"AK-47", "M4A4", false, 0, false},
		{"AK-47", "AWP", false, 4, false},
		{"Knife", "Glock-18", false, 0, true},
		{"Zeus x27", "Glock-18", false, 0, true},
		{"HE Grenade", "Glock-18", false, 0, true},
		{"AK-47", "Knife", false, 0, true},
		{"AK-47", "Smoke Grenade", false, 0, true},
	} {
		t.Run(test.killer+"_vs_"+test.victim, func(t *testing.T) {
			d := statsDemo(append(statsSquad(2, "AK-47", 0, 100, nil), statsSquad(3, "AWP", 0, 100, nil)...))
			d.Events = []Event{statsKill(test.killer, test.victim)}
			before, _ := json.Marshal(d)
			result := BuildStatistics(d)
			kill := result.Kills[0]
			wantCount := 0
			if test.want {
				wantCount = 1
			}
			if kill.PistolMismatch != test.want || result.Summary.PistolMismatchKills != wantCount {
				t.Fatalf("matchup wrongly counted: %+v %+v", kill, result.Summary)
			}
			if test.excluded {
				if kill.Score != nil || kill.ExcludedReason == "" {
					t.Fatal("excluded weapon gained a score")
				}
			} else if kill.Score == nil || *kill.Score != test.score || result.Summary.Score != test.score {
				t.Fatal("final value does not honor the zero-value pistol-mismatch rule")
			}
			after, _ := json.Marshal(d)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("derived metric mutated the original replay")
			}
		})
	}
}

func TestStatisticsPistolMismatchExcludesInvalidKills(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Event)
	}{
		{"team kill", func(e *Event) { e.VictimTeam = e.KillerTeam }},
		{"suicide", func(e *Event) { e.VictimID = e.KillerID }},
		{"world damage", func(e *Event) { e.KillerID = "" }},
		{"missing victim", func(e *Event) { e.VictimID = "" }},
		{"missing side", func(e *Event) { e.VictimTeam = 0 }},
		{"warmup round", func(e *Event) { e.Round = 0 }},
		{"freeze time", func(e *Event) { e.T, e.VictimWeaponTime = 5, 5 }},
		{"outside round", func(e *Event) { e.T, e.VictimWeaponTime = 150, 150 }},
		{"missing active weapon", func(e *Event) { e.VictimWeapon, e.VictimWeaponSource = "", "unavailable" }},
		{"stale active weapon", func(e *Event) { e.VictimWeaponTime, e.VictimWeaponSource = 25, "previous_tick" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			d := statsDemo(nil)
			e := statsKill("AK-47", "Glock-18")
			test.change(&e)
			d.Events = []Event{e}
			result := BuildStatistics(d)
			if result.Kills[0].PistolMismatch || result.Kills[0].ExcludedReason == "" || result.Summary.PistolMismatchKills != 0 {
				t.Fatalf("excluded kill was counted: %+v", result.Kills[0])
			}
		})
	}
}

func TestStatisticsPistolMismatchUsesVictimsActiveWeapon(t *testing.T) {
	d := statsDemo(append(statsSquad(2, "AK-47", 0, 100, nil), statsSquad(3, "AWP", 0, 100, nil)...))
	// The victim carries a saved AWP and a pistol. The death event establishes
	// which item was active; neither economy nor inventory value may replace it.
	for i := range d.Rounds[0].Economy.Players {
		p := &d.Rounds[0].Economy.Players[i]
		if p.ID == "s3-p0" {
			p.Weapons = []WeaponItem{{Name: "AWP"}, {Name: "Glock-18"}}
		}
	}
	for _, test := range []struct {
		active string
		want   bool
	}{{"Glock-18", true}, {"AWP", false}, {"Knife", false}, {"Flashbang", false}} {
		d.Events = []Event{statsKill("AK-47", test.active)}
		if kill := BuildStatistics(d).Kills[0]; kill.PistolMismatch != test.want || kill.VictimWeapon != test.active {
			t.Fatalf("active %s was replaced with inventory evidence: %+v", test.active, kill)
		}
	}
	// Legacy cached demos may supply a recent active-weapon observation, which
	// remains explicitly approximate while counting the same observed matchup.
	d.StatisticsVersion = 0
	d.Events = []Event{statsKill("MP9", "")}
	d.Events[0].VictimWeaponSource, d.Events[0].VictimWeaponTime = "", 0
	d.Frames = []Frame{{T: 29.95, Round: 2, Players: []PlayerFrame{{ID: "s3-p0", Team: 3, Connected: true, Alive: true, Weapon: "Glock-18", Weapons: []WeaponItem{{Name: "AWP"}, {Name: "Glock-18"}}}}}}
	if kill := BuildStatistics(d).Kills[0]; !kill.PistolMismatch || !kill.Approx || kill.WeaponSource != "sampled_cache" {
		t.Fatalf("legacy active-weapon evidence lost its metric or approximation marker: %+v", kill)
	}
}

func TestStatisticsPistolMismatchAggregatesByPlayerRoundSideHalfAndTeam(t *testing.T) {
	players := append(statsSquad(2, "AK-47", 0, 100, nil), statsSquad(3, "Glock-18", 0, 100, nil)...)
	d := statsDemo(players)
	swapped := append([]PlayerFrame(nil), players...)
	for i := range swapped {
		swapped[i].Team = 5 - swapped[i].Team
	}
	d.Rounds = append(d.Rounds, Round{Number: 13, Start: 130, FreezeEnd: 140, End: 250, Economy: &EconomySnapshot{Time: 140, Source: "freeze_end", Players: swapped, Half: 2, HalfSource: "convar"}})
	a := statsKill("MP9", "Glock-18")
	b := statsKill("AK-47", "Glock-18")
	b.KillerID, b.VictimID, b.KillerTeam, b.VictimTeam = "s3-p1", "s2-p1", 3, 2
	c := statsKill("AK-47", "Glock-18")
	c.Round, c.T, c.VictimWeaponTime, c.KillerTeam, c.VictimTeam = 13, 150, 150, 3, 2
	dontCount := statsKill("AWP", "Glock-18")
	dontCount.Round, dontCount.T, dontCount.VictimWeaponTime = 13, 160, 160
	dontCount.KillerID, dontCount.VictimID = "s3-p0", "s2-p1"
	d.Events = []Event{a, b, c, dontCount}
	result := BuildStatistics(d)
	if result.RuleVersion != StatisticsVersion || result.Summary.PistolMismatchKills != 3 || result.Summary.Score != -6 {
		t.Fatalf("total or rule version wrong: %+v", result.Summary)
	}
	assertPlayers := func(label string, players []StatisticsPlayer, want map[string]int) {
		t.Helper()
		for _, player := range players {
			if player.Summary.PistolMismatchKills != want[player.ID] {
				t.Fatalf("%s player %s: got %d want %d", label, player.ID, player.Summary.PistolMismatchKills, want[player.ID])
			}
		}
	}
	assertPlayers("total", result.Players, map[string]int{"s2-p0": 2, "s3-p1": 1})
	for _, round := range result.Rounds {
		want := 2
		wantPlayers := map[string]int{"s2-p0": 1, "s3-p1": 1}
		if round.Number == 13 {
			want, wantPlayers = 1, map[string]int{"s2-p0": 1}
		}
		if round.Summary.PistolMismatchKills != want {
			t.Fatal("round total does not match its kill flags")
		}
		assertPlayers("round", round.Players, wantPlayers)
	}
	for _, side := range result.Sides {
		want, wantPlayers := 1, map[string]int{"s2-p0": 1}
		if side.Side == 3 {
			want, wantPlayers = 2, map[string]int{"s2-p0": 1, "s3-p1": 1}
		}
		if side.Summary.PistolMismatchKills != want {
			t.Fatal("side total did not follow killer side across the switch")
		}
		assertPlayers("side", side.Players, wantPlayers)
	}
	for _, half := range result.Halves {
		want, wantPlayers := 2, map[string]int{"s2-p0": 1, "s3-p1": 1}
		if half.Half == 2 {
			want, wantPlayers = 1, map[string]int{"s2-p0": 1}
		}
		if half.Summary.PistolMismatchKills != want {
			t.Fatal("half total is incorrect")
		}
		assertPlayers("half", half.Players, wantPlayers)
	}
	firstTeam := result.Rounds[0].T.TeamKey
	if firstTeam == "" || result.Rounds[1].CT.TeamKey != firstTeam || len(result.Teams) != 2 {
		t.Fatal("team identity was not preserved through side switch")
	}
	for _, team := range result.Teams {
		want, wantPlayers := 1, map[string]int{"s3-p1": 1}
		if team.TeamKey == firstTeam {
			want, wantPlayers = 2, map[string]int{"s2-p0": 2}
		}
		if team.Summary.PistolMismatchKills != want {
			t.Fatal("team total incorrectly groups current CT/T instead of roster")
		}
		assertPlayers("team", team.Players, wantPlayers)
	}
}

func TestStatisticsPistolMismatchRuleVersionInvalidatesDerivedCache(t *testing.T) {
	a, h := testViewer(t)
	id := "000000000000000000000016"
	j, d := statisticsFixture(t, a, id, id, "old-cache.dem")
	d = statsDemo(nil)
	d.ID, d.Name = id, j.Name
	d.Events = []Event{statsKill("MP9", "Glock-18")}
	j.Map = d.Map
	writeFixtureGzip(t, j.result, d)
	a.statisticsKey = id + "\x00" + id + "\x001"
	a.statisticsJSON = []byte(`{"ruleVersion":"1","obsolete":true}`)
	w := localRequest(h, "GET", "/api/demos/"+id+"/statistics")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result StatisticsDemo
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RuleVersion != StatisticsVersion || result.Summary.PistolMismatchKills != 1 || !result.Kills[0].PistolMismatch || j.Revision != id || len(a.pending) != 0 || j.Analysis {
		t.Fatal("old derived report was not upgraded from replay without reparse or membership changes")
	}
	for _, value := range []any{StatisticsSummary{}, KillScore{}} {
		body, _ := json.Marshal(value)
		var fields map[string]json.RawMessage
		json.Unmarshal(body, &fields)
		if _, ok := value.(StatisticsSummary); ok {
			if string(fields["pistolMismatchKills"]) != "0" {
				t.Fatal("zero count must be present in JSON")
			}
		} else if string(fields["pistolMismatch"]) != "false" {
			t.Fatal("false kill flag must be present in JSON")
		}
	}
}
