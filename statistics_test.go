package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func statsPlayer(id string, side int, weapon string, money, armor int, grenades []InventoryItem) PlayerFrame {
	return PlayerFrame{ID: id, Team: side, Weapon: weapon, Weapons: []WeaponItem{{Name: weapon, Slot: "primary", Active: true}}, Money: money, Armor: armor, Alive: true, Connected: true, HP: 100, Inventory: append([]InventoryItem{}, grenades...)}
}
func statsSquad(side int, weapon string, money, armor int, grenades []InventoryItem) []PlayerFrame {
	players := []PlayerFrame{}
	for i := 0; i < 5; i++ {
		players = append(players, statsPlayer(fmt.Sprintf("s%d-p%d", side, i), side, weapon, money, armor, grenades))
	}
	return players
}
func statsFour() []InventoryItem {
	return []InventoryItem{{Type: "flash", Count: 2}, {Type: "smoke", Count: 1}, {Type: "he", Count: 1}}
}
func statsDemo(players []PlayerFrame) *DemoData {
	d := &DemoData{ID: "statistics-fixture", Name: "Statistics fixture", Map: "de_anubis", StatisticsVersion: 1, Players: []PlayerInfo{}, Rounds: []Round{{Number: 2, Start: 0, End: 120, FreezeEnd: 10, EndedAt: 100, Economy: &EconomySnapshot{Time: 10, Source: "freeze_end", Complete: true, Players: players, Half: 1, HalfSource: "convar"}}}, Frames: []Frame{}, Events: []Event{}}
	for _, p := range players {
		d.Players = append(d.Players, PlayerInfo{ID: p.ID, Name: "Player " + p.ID, Team: p.Team})
	}
	return d
}
func statsEconomy(t *testing.T, players []PlayerFrame) TeamEconomy {
	t.Helper()
	d := statsDemo(append(statsSquad(3, "AK-47", 2000, 100, statsFour()), players...))
	return BuildStatistics(d).Rounds[0].T
}
func statsKill(weapon, victimWeapon string) Event {
	return Event{Type: "kill", Round: 2, T: 30, KillerID: "s2-p0", VictimID: "s3-p0", KillerTeam: 2, VictimTeam: 3, Weapon: weapon, VictimWeapon: victimWeapon, VictimWeaponSource: "death_event", VictimWeaponTime: 30}
}
func statsContains(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}

func TestStatisticsEconomyEightRulesAndUnknown(t *testing.T) {
	cases := []struct {
		name, want string
		players    []PlayerFrame
	}{
		{"full", "full", statsSquad(2, "AK-47", 9000, 100, statsFour())},
		{"force", "force", statsSquad(2, "Glock-18", 500, 0, nil)},
		{"eco", "eco", statsSquad(2, "MP9", 1001, 0, nil)},
		{"mixed", "mixed", statsSquad(2, "Glock-18", 750, 100, []InventoryItem{{Type: "smoke", Count: 1}})},
		{"unmatched", "unknown", statsSquad(2, "AK-47", 750, 0, nil)},
	}
	fullSniper := statsSquad(2, "AK-47", 9000, 100, statsFour())
	fullSniper[0] = statsPlayer(fullSniper[0].ID, 2, "AWP", 9000, 100, nil)
	cases = append(cases, struct {
		name, want string
		players    []PlayerFrame
	}{"full-sniper-exempt-utilities", "full_sniper", fullSniper})
	hero := statsSquad(2, "Glock-18", 2000, 0, nil)
	for i := 3; i < 5; i++ {
		hero[i] = statsPlayer(hero[i].ID, 2, "AK-47", 2000, 100, nil)
	}
	cases = append(cases, struct {
		name, want string
		players    []PlayerFrame
	}{"saved-hero-rifles", "hero", hero})
	disorder := statsSquad(2, "Glock-18", 2000, 0, nil)
	for i := 2; i < 5; i++ {
		disorder[i] = statsPlayer(disorder[i].ID, 2, "AK-47", 999, 100, statsFour())
	}
	cases = append(cases, struct {
		name, want string
		players    []PlayerFrame
	}{"two-eco-three-buy", "disorder", disorder})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := statsEconomy(t, tc.players)
			if got.Type != tc.want || !got.Complete {
				t.Fatalf("got %s complete=%v matches=%v reason=%s", got.Type, got.Complete, got.MatchedTypes, got.Reason)
			}
		})
	}
	d := statsDemo(append(statsSquad(3, "Glock-18", 0, 0, nil), statsSquad(2, "Glock-18", 0, 0, nil)...))
	d.Rounds[0].Number = 1
	d.Rounds[0].Economy.Pistol = true
	if got := BuildStatistics(d).Rounds[0]; got.CT.Type != "pistol" || got.T.Type != "pistol" {
		t.Fatal("regulation opener was not pistol")
	}
}

func TestStatisticsOverlapsRemainVisibleAndPrecedenceIsDeterministic(t *testing.T) {
	mixed := statsSquad(2, "Glock-18", 500, 100, []InventoryItem{{Type: "he", Count: 1}})
	got := statsEconomy(t, mixed)
	if got.Type != "mixed" || !statsContains(got.MatchedTypes, "force") || got.Overlap == "" {
		t.Fatalf("mixed/force overlap hidden: %+v", got)
	}
	hero := statsSquad(2, "Glock-18", 2000, 0, nil)
	for i := 3; i < 5; i++ {
		hero[i] = statsPlayer(hero[i].ID, 2, "AK-47", 0, 100, statsFour())
	}
	got = statsEconomy(t, hero)
	if got.Type != "hero" || !statsContains(got.MatchedTypes, "eco") || !statsContains(got.MatchedTypes, "disorder") {
		t.Fatalf("hero priority/overlaps wrong: %+v", got)
	}
	full := statsSquad(2, "AK-47", 0, 100, nil)
	got = statsEconomy(t, full)
	if got.Type != "full" || !statsContains(got.MatchedTypes, "force") {
		t.Fatal("cannot-afford utility exception or full priority failed")
	}
}

func TestStatisticsMajorityAndMoneyBoundaries(t *testing.T) {
	players := statsSquad(2, "Glock-18", 501, 0, nil)
	for i := 0; i < 2; i++ {
		players[i].Money = 500
	}
	if got := statsEconomy(t, players); got.Type != "unknown" {
		t.Fatalf("two is not a majority: %s", got.Type)
	}
	players[2].Money = 500
	if got := statsEconomy(t, players); got.Type != "force" {
		t.Fatalf("three at exactly 500 must qualify: %s", got.Type)
	}
	players = statsSquad(2, "Glock-18", 1000, 0, nil)
	if got := statsEconomy(t, players); got.Type != "unknown" {
		t.Fatalf("eco threshold is strict: %s", got.Type)
	}
	for i := 0; i < 3; i++ {
		players[i].Money = 1001
	}
	if got := statsEconomy(t, players); got.Type != "eco" {
		t.Fatalf("three eco players must qualify: %s", got.Type)
	}
	players = statsSquad(2, "Glock-18", 0, 0, nil)
	players[0] = statsPlayer(players[0].ID, 2, "AWP", 0, 100, nil)
	if got := statsEconomy(t, players); statsContains(got.MatchedTypes, "force") {
		t.Fatal("literal force rule must not be extended to sniper loadouts")
	}
}

func TestStatisticsUtilityCapacityAndAffordableRemainingType(t *testing.T) {
	p := statsPlayer("one", 2, "AK-47", 49, 100, []InventoryItem{{Type: "flash", Count: 2}, {Type: "smoke", Count: 1}})
	if count, ready, _ := statisticsUtility(p); count != 3 || !ready {
		t.Fatal("49 cannot buy an available decoy")
	}
	p.Money = 50
	if _, ready, _ := statisticsUtility(p); ready {
		t.Fatal("exactly 50 can still buy a decoy")
	}
	p.Inventory = []InventoryItem{{Type: "decoy", Count: 1}, {Type: "flash", Count: 2}}
	p.Money = 299
	if _, ready, _ := statisticsUtility(p); !ready {
		t.Fatal("third flash is forbidden; remaining cheapest costs 300")
	}
	p.Money = 300
	if _, ready, _ := statisticsUtility(p); ready {
		t.Fatal("exactly 300 can buy remaining HE/smoke")
	}
	p.Inventory = statsFour()
	p.Money = 16000
	if _, ready, _ := statisticsUtility(p); !ready {
		t.Fatal("four is full regardless of leftover money")
	}
	p.Inventory = []InventoryItem{{Type: "flash", Count: 3}}
	if _, ready, reason := statisticsUtility(p); ready || !strings.Contains(reason, "超出") {
		t.Fatal("invalid capacity was accepted")
	}
}

func TestStatisticsEconomyKeepsSavedGunsAndDoesNotConfuseActiveKnife(t *testing.T) {
	players := statsSquad(2, "AK-47", 9000, 100, statsFour())
	for i := range players {
		players[i].Weapon = "Knife"
		players[i].Weapons[0].Active = false
		players[i].Weapons = append(players[i].Weapons, WeaponItem{Name: "Glock-18", Slot: "secondary"})
	}
	got := statsEconomy(t, players)
	if got.Type != "full" || got.Players[0].Weapon != "AK-47" {
		t.Fatal("economy must include carried/saved primary, independently of active item")
	}
}

func TestStatisticsMissingOneSideDoesNotInvalidateCompleteOpponents(t *testing.T) {
	players := append(statsSquad(3, "AK-47", 9000, 100, statsFour())[:4], statsSquad(2, "AK-47", 9000, 100, statsFour())...)
	d := statsDemo(players)
	d.Rounds[0].Economy.Complete = false
	r := BuildStatistics(d).Rounds[0]
	if r.CT.Type != "unknown" || r.CT.Complete || r.T.Type != "full" || !r.T.Complete {
		t.Fatalf("side-specific evidence lost: CT=%s/%v T=%s/%v", r.CT.Type, r.CT.Complete, r.T.Type, r.T.Complete)
	}
	d.Rounds[0].Number = 1
	d.Rounds[0].Economy.Pistol = true
	r = BuildStatistics(d).Rounds[0]
	if r.CT.Type != "pistol" || r.CT.Complete {
		t.Fatal("pistol identity must survive incomplete gear without claiming completeness")
	}
	players = statsSquad(2, "AK-47", 0, 100, nil)
	players[0].Inventory = nil
	if got := statsEconomy(t, players); got.Type != "unknown" || got.Complete {
		t.Fatal("missing inventory cannot be treated as zero grenades")
	}
}

func TestStatisticsSampledEconomyIsLocalToRoundAndQuarterSecond(t *testing.T) {
	players := append(statsSquad(3, "AK-47", 9000, 100, statsFour()), statsSquad(2, "AK-47", 9000, 100, statsFour())...)
	d := statsDemo(players)
	d.StatisticsVersion = 0
	d.Rounds[0].Economy = nil
	d.Frames = []Frame{{Round: 1, T: 10, Players: players}, {Round: 2, T: 9.7, Players: players}}
	if got := BuildStatistics(d).Rounds[0].T; got.Type != "unknown" || got.Source != "unknown" {
		t.Fatal("cross-round or distant economy sampling was accepted")
	}
	d.Frames = append(d.Frames, Frame{Round: 2, T: 10.2, Players: players})
	got := BuildStatistics(d).Rounds[0].T
	if got.Type != "full" || got.Source != "sampled_cache" || got.Time != 10.2 || !strings.Contains(got.Reason, "采样") {
		t.Fatalf("sample provenance lost: %+v", got)
	}
}

func TestModernMissingFreezeSnapshotIsNotLabeledLegacyCache(t *testing.T) {
	players := append(statsSquad(3, "AK-47", 9000, 100, statsFour()), statsSquad(2, "AK-47", 9000, 100, statsFour())...)
	d := statsDemo(players)
	d.StatisticsVersion = 1
	d.Rounds[0].Economy = nil
	d.Frames = []Frame{{Round: 2, T: 10.1, Players: players}}
	result := BuildStatistics(d)
	got := result.Rounds[0].CT
	if got.Source != "sampled_frame" || got.Type != "full" || !strings.Contains(got.Reason, "邻近帧") || strings.Contains(got.Reason, "旧缓存") {
		t.Fatalf("new replay was mislabeled as legacy: %+v", got)
	}
	if !strings.Contains(strings.Join(result.Warnings, " "), "已使用新版解析") {
		t.Fatal("missing-event limitation should remain explicit after reparse")
	}
	d.Frames[0].T = 10.3
	if got := BuildStatistics(d).Rounds[0].CT; got.Source != "unknown" {
		t.Fatal("modern frames must retain the same quarter-second evidence limit")
	}
}

func TestStatisticsActualKillWeaponAndVictimActiveWeaponScoring(t *testing.T) {
	d := statsDemo(append(statsSquad(3, "AWP", 0, 100, nil), statsSquad(2, "AWP", 0, 100, nil)...))
	d.Events = []Event{statsKill("Glock-18", "AWP"), statsKill("AWP", "Glock-18"), statsKill("AK-47", "M4A4"), statsKill("Nova", "Negev")}
	got := BuildStatistics(d)
	want := []int{24, -6, 0, 0}
	for i, k := range got.Kills {
		if k.Score == nil || *k.Score != want[i] || k.Approx || k.WeaponSource != "death_event" {
			t.Fatalf("kill %d wrong: %+v", i, k)
		}
	}
	if got.Summary.ScoredKills != 4 || got.Summary.Score != 18 || got.Summary.Average == nil || *got.Summary.Average != 4.5 {
		t.Fatalf("weighted totals or averages are wrong: %+v", got.Summary)
	}
}

func TestStatisticsExclusionsAreNullableAndRetainEveryEvent(t *testing.T) {
	d := statsDemo(append(statsSquad(3, "AK-47", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...))
	cases := []struct {
		name   string
		change func(*Event)
	}{
		{"teamkill", func(e *Event) { e.KillerTeam = 3 }}, {"suicide", func(e *Event) { e.KillerID = e.VictimID }}, {"world", func(e *Event) { e.KillerID = ""; e.Weapon = "worldspawn" }}, {"knife killer", func(e *Event) { e.Weapon = "Knife" }}, {"taser killer", func(e *Event) { e.Weapon = "Zeus x27" }}, {"utility killer", func(e *Event) { e.Weapon = "HE Grenade" }}, {"knife victim", func(e *Event) { e.VictimWeapon = "Knife" }}, {"utility victim", func(e *Event) { e.VictimWeapon = "Smoke Grenade" }}, {"unknown", func(e *Event) { e.VictimWeapon = ""; e.VictimWeaponSource = "unavailable" }}, {"warmup", func(e *Event) { e.Round = 0 }}, {"freeze", func(e *Event) { e.T = 5; e.VictimWeaponTime = 5 }},
	}
	for _, tc := range cases {
		e := statsKill("AK-47", "AWP")
		tc.change(&e)
		d.Events = append(d.Events, e)
	}
	got := BuildStatistics(d)
	if len(got.Kills) != len(cases) || got.Summary.ExcludedKills != len(cases) || got.Summary.Average != nil {
		t.Fatalf("excluded events dropped or averaged: %+v", got.Summary)
	}
	for _, k := range got.Kills {
		if k.Score != nil || k.BaseScore != nil || k.ScoreMultiplier != nil || k.ExcludedReason == "" {
			t.Fatalf("missing exclusion: %+v", k)
		}
	}
	data, err := json.Marshal(got)
	if err != nil || !strings.Contains(string(data), `"score":null`) || !strings.Contains(string(data), `"baseScore":null`) || !strings.Contains(string(data), `"scoreMultiplier":null`) {
		t.Fatal("excluded scores must serialize as null")
	}
}

func TestStatisticsLegacyDeathUsesNearestAliveActiveOnly(t *testing.T) {
	players := append(statsSquad(3, "AWP", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...)
	d := statsDemo(players)
	d.StatisticsVersion = 0
	e := statsKill("AK-47", "")
	e.VictimWeaponSource = ""
	e.VictimWeaponTime = 0
	d.Events = []Event{e}
	old := statsPlayer(e.VictimID, 3, "AWP", 0, 100, nil)
	recent := old
	recent.Weapon = "Glock-18"
	dead := recent
	dead.Alive = false
	dead.Weapon = "Knife"
	d.Frames = []Frame{{Round: 2, T: 28, Players: []PlayerFrame{old}}, {Round: 2, T: 29.9, Players: []PlayerFrame{recent}}, {Round: 2, T: 30, Players: []PlayerFrame{dead}}, {Round: 2, T: 31, Players: []PlayerFrame{old}}}
	k := BuildStatistics(d).Kills[0]
	if k.Score == nil || *k.Score != -4 || k.VictimWeapon != "Glock-18" || !k.Approx || k.WeaponTime != 29.9 || k.WeaponSource != "sampled_cache" {
		t.Fatalf("used dead/future/backpack weapon: %+v", k)
	}
	d.Frames = []Frame{{Round: 1, T: 29, Players: []PlayerFrame{old}}}
	if k := BuildStatistics(d).Kills[0]; k.Score != nil {
		t.Fatal("borrowed victim weapon from another round")
	}
}

func TestStatisticsObservedWeaponHasPriorityAndMissingNewEvidenceStaysUnknown(t *testing.T) {
	d := statsDemo(append(statsSquad(3, "AWP", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...))
	d.Frames = []Frame{{Round: 2, T: 29.9, Players: []PlayerFrame{statsPlayer("s3-p0", 3, "AWP", 0, 100, nil)}}}
	e := statsKill("Glock-18", "Knife")
	d.Events = []Event{e}
	if k := BuildStatistics(d).Kills[0]; k.Score != nil || k.VictimWeapon != "Knife" {
		t.Fatal("exact knife was replaced by a more valuable cached gun")
	}
	e.VictimWeapon = ""
	e.VictimWeaponSource = "unavailable"
	d.Events = []Event{e}
	if k := BuildStatistics(d).Kills[0]; k.Score != nil || k.WeaponSource != "unknown" {
		t.Fatal("new unavailable observation must not become a coarse fallback")
	}
	e.VictimWeapon = "AWP"
	e.VictimWeaponSource = "previous_tick"
	e.VictimWeaponTime = 29.75
	d.Events = []Event{e}
	if k := BuildStatistics(d).Kills[0]; k.Score == nil || *k.Score != 24 || !k.Approx {
		t.Fatal("previous tick must count with approximate provenance")
	}
	e.VictimWeaponTime = 29.749
	d.Events = []Event{e}
	if k := BuildStatistics(d).Kills[0]; k.Score != nil {
		t.Fatal("stale previous tick must not count")
	}
}

func TestStatisticsPostRoundKillsAndScopeTotalsAgree(t *testing.T) {
	players := append(statsSquad(3, "AK-47", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...)
	d := statsDemo(players)
	e := statsKill("Glock-18", "AWP")
	e.T = 110
	e.VictimWeaponTime = 110
	e.Headshot = true
	d.Events = []Event{e}
	got := BuildStatistics(d)
	if got.Summary.Score != 24 || got.Rounds[0].Summary.Score != 24 || got.Halves[0].Summary.Score != 24 {
		t.Fatal("post-round save kill was cut off by EndedAt")
	}
	if len(got.Players) != 10 || len(got.Rounds[0].Players) != 10 {
		t.Fatal("zero-event players must remain visible")
	}
	for _, side := range got.Sides {
		if side.Side == 2 && (side.Summary.Score != 24 || side.Summary.Kills != 1) || side.Side == 3 && (side.Summary.Score != 0 || side.Summary.Deaths != 1) {
			t.Fatalf("side summary wrong: %+v", side)
		}
	}
	for _, p := range got.Players {
		if p.ID == e.KillerID && (p.Summary.Score != 24 || p.Summary.Headshots != 1) || p.ID == e.VictimID && (p.Summary.Deaths != 1 || p.Summary.Score != 0) {
			t.Fatalf("player attribution wrong: %+v", p)
		}
	}
}

func TestStatisticsLegacyHalfUsesActualRosterSwapAndNoOvertimePistols(t *testing.T) {
	players := append(statsSquad(3, "AK-47", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...)
	d := statsDemo(players)
	d.StatisticsVersion = 0
	d.Rounds = nil
	d.Frames = nil
	for i, number := range []int{1, 10, 11, 20, 21, 24, 25} {
		start := float64(i * 120)
		ps := append([]PlayerFrame{}, players...)
		if number >= 11 && number <= 20 || number >= 24 {
			for j := range ps {
				ps[j].Team = 5 - ps[j].Team
			}
		}
		d.Rounds = append(d.Rounds, Round{Number: number, Start: start, End: start + 119, FreezeEnd: start + 10})
		d.Frames = append(d.Frames, Frame{Round: number, T: start + 10, Players: ps})
	}
	got := BuildStatistics(d)
	if got.Rounds[2].Half != 2 || !got.Rounds[2].Pistol || got.Rounds[2].HalfSource != "roster_swap" {
		t.Fatalf("MR10 actual switch not recognized: %+v", got.Rounds[2])
	}
	for _, r := range got.Rounds {
		if r.Number >= 21 && (r.Pistol || r.T.Type == "pistol" || r.CT.Type == "pistol") {
			t.Fatal("overtime reset misclassified as pistol")
		}
	}
	if got.Rounds[0].CT.TeamKey != got.Rounds[2].T.TeamKey || len(got.Teams) != 2 {
		t.Fatal("anonymous roster identity broke over side swap")
	}
}

func TestStatisticsDoesNotMutateReplayAndSerializesEmptyReport(t *testing.T) {
	d := statsDemo(append(statsSquad(3, "AK-47", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...))
	d.Events = []Event{statsKill("AK-47", "AWP")}
	d.Frames = []Frame{{T: 20, Round: 2}, {T: 10, Round: 2}}
	before, _ := json.Marshal(d)
	first := BuildStatistics(d)
	second := BuildStatistics(d)
	after, _ := json.Marshal(d)
	if string(before) != string(after) || !reflect.DeepEqual(first, second) {
		t.Fatal("statistics mutated replay or produced unstable output")
	}
	empty, err := json.Marshal(BuildStatistics(nil))
	if err != nil || !strings.Contains(string(empty), `"kills":[]`) || !strings.Contains(string(empty), `"average":null`) {
		t.Fatalf("empty schema invalid: %s %v", empty, err)
	}
}

func TestStatisticsDeathEvidenceRejectsStaleAndFutureTimes(t *testing.T) {
	d := statsDemo(append(statsSquad(3, "AWP", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...))
	d.StatisticsVersion = 0
	e := statsKill("Glock-18", "")
	e.T = 80
	e.VictimWeaponSource = ""
	e.VictimWeaponTime = 0
	d.Events = []Event{e}
	p := statsPlayer(e.VictimID, 3, "AWP", 0, 100, nil)
	for _, observed := range []float64{20, 79.749, 80.1} {
		d.Frames = []Frame{{Round: 2, T: observed, Players: []PlayerFrame{p}}}
		if k := BuildStatistics(d).Kills[0]; k.Score != nil || k.VictimWeapon != "" {
			t.Fatalf("stale/future evidence at %g accepted: %+v", observed, k)
		}
	}
	d.Frames = []Frame{{Round: 2, T: 79.75, Players: []PlayerFrame{p}}}
	if k := BuildStatistics(d).Kills[0]; k.Score == nil || !k.Approx {
		t.Fatal("quarter-second boundary should retain explicit approximate evidence")
	}
	d.StatisticsVersion = 1
	e.VictimWeapon = "AWP"
	e.VictimWeaponSource = "death_event"
	e.VictimWeaponTime = 79.75
	d.Events = []Event{e}
	if k := BuildStatistics(d).Kills[0]; k.Score != nil {
		t.Fatal("an old death_event field must not be called exact")
	}
}

func TestStatisticsMR15SwapOverridesLegacyAndNewDefaultHalfGuesses(t *testing.T) {
	for _, modernDefault := range []bool{false, true} {
		t.Run(fmt.Sprint(modernDefault), func(t *testing.T) {
			players := append(statsSquad(3, "AK-47", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...)
			d := statsDemo(players)
			d.Rounds = nil
			d.Frames = nil
			if !modernDefault {
				d.StatisticsVersion = 0
			}
			for number := 1; number <= 30; number++ {
				start := float64(number * 120)
				ps := append([]PlayerFrame{}, players...)
				if number >= 16 {
					for i := range ps {
						ps[i].Team = 5 - ps[i].Team
					}
				}
				r := Round{Number: number, Start: start, End: start + 119, FreezeEnd: start + 10}
				if modernDefault {
					r.Economy = &EconomySnapshot{Time: start + 10, Source: "freeze_end", Complete: true, Players: ps, Half: statisticsFallbackHalf(number), HalfSource: "default_mr12", Pistol: number == 1 || number == 13}
				}
				d.Rounds = append(d.Rounds, r)
				d.Frames = append(d.Frames, Frame{Round: number, T: start + 10, Players: ps})
			}
			got := BuildStatistics(d)
			for _, r := range got.Rounds {
				wantHalf := 1
				if r.Number >= 16 {
					wantHalf = 2
				}
				if r.Half != wantHalf || r.HalfSource != "roster_swap" || r.Pistol != (r.Number == 1 || r.Number == 16) {
					t.Fatalf("MR15 round %d assigned half %d pistol %v source %s", r.Number, r.Half, r.Pistol, r.HalfSource)
				}
			}
		})
	}
}

func TestStatisticsDisorderStrictBudgetAndMixedInclusiveBudget(t *testing.T) {
	players := statsSquad(2, "Glock-18", 1001, 0, nil)
	for i := 2; i < 5; i++ {
		players[i] = statsPlayer(players[i].ID, 2, "AK-47", 1000, 100, statsFour())
	}
	if got := statsEconomy(t, players); statsContains(got.MatchedTypes, "disorder") {
		t.Fatal("exactly 1000 is not below the disorder threshold")
	}
	for i := 2; i < 5; i++ {
		players[i].Money = 999
	}
	if got := statsEconomy(t, players); got.Type != "disorder" {
		t.Fatal("2 ECO and 3 fully equipped players below 1000 must qualify")
	}
	mixed := statsSquad(2, "AK-47", 1000, 100, []InventoryItem{{Type: "smoke", Count: 1}})
	if got := statsEconomy(t, mixed); got.Type != "mixed" {
		t.Fatal("mixed threshold includes exactly 1000")
	}
	overlap := statsSquad(2, "Glock-18", 500, 100, []InventoryItem{{Type: "smoke", Count: 1}})
	got := statsEconomy(t, overlap)
	if !strings.Contains(got.Overlap, "混起") || !strings.Contains(got.Overlap, "强起") || strings.Contains(got.Overlap, "mixed") {
		t.Fatal("overlap explanation must use readable labels")
	}
}

func TestStatisticsPreservesReplayQualityWarnings(t *testing.T) {
	d := statsDemo(nil)
	d.Warnings = []string{"POV 数据不包含所有玩家", "录像末尾截断"}
	got := BuildStatistics(d)
	for _, warning := range d.Warnings {
		if !statsContains(got.Warnings, warning) {
			t.Fatalf("lost parser quality warning %q", warning)
		}
	}
}

func TestStatisticsOvertimeStartsWithoutAnImmediateSideSwap(t *testing.T) {
	for _, tc := range []struct {
		name                      string
		regulationHalf, lastRound int
		observed                  bool
	}{
		{"MR12 OT first half without swap", 12, 27, false},
		{"MR12 OT observed second half", 12, 28, true},
		{"MR12 next overtime starts without swap", 12, 31, true},
		{"MR15 OT first half without swap", 15, 33, false},
		{"MR15 OT observed second half", 15, 34, true},
	} {
		for _, modernDefault := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s modern=%v", tc.name, modernDefault), func(t *testing.T) {
				players := append(statsSquad(3, "AK-47", 0, 100, nil), statsSquad(2, "AK-47", 0, 100, nil)...)
				d := statsDemo(players)
				d.Rounds = nil
				d.Frames = nil
				if !modernDefault {
					d.StatisticsVersion = 0
				}
				regulationEnd := tc.regulationHalf * 2
				for number := 1; number <= tc.lastRound; number++ {
					start := float64(number * 120)
					ps := append([]PlayerFrame{}, players...)
					// The first OT half retains regulation's final sides. The next OT
					// also starts with the final sides of the previous OT, not a swap.
					flipped := number > tc.regulationHalf
					if number > regulationEnd {
						flipped = (1+(number-regulationEnd-1+3)/6)%2 == 1
					}
					if flipped {
						for i := range ps {
							ps[i].Team = 5 - ps[i].Team
						}
					}
					r := Round{Number: number, Start: start, End: start + 119, FreezeEnd: start + 10}
					if modernDefault {
						r.Economy = &EconomySnapshot{Time: start + 10, Source: "freeze_end", Complete: true, Players: ps, Half: statisticsFallbackHalf(number), HalfSource: "default_mr12", Pistol: number == 1 || number == 13}
					}
					d.Rounds = append(d.Rounds, r)
					d.Frames = append(d.Frames, Frame{Round: number, T: start + 10, Players: ps})
				}
				got := BuildStatistics(d)
				for _, r := range got.Rounds {
					if r.Number <= regulationEnd {
						continue
					}
					wantHalf := 3 + (r.Number-regulationEnd-1)/3
					if r.Half != wantHalf || r.Pistol || r.CT.Type == "pistol" || r.T.Type == "pistol" {
						t.Fatalf("OT round %d got half=%d pistol=%v, want half=%d", r.Number, r.Half, r.Pistol, wantHalf)
					}
					wantSource := "roster_swap_overtime_mr3"
					if tc.observed {
						wantSource = "roster_swap_overtime_observed"
					}
					if r.HalfSource != wantSource {
						t.Fatalf("round %d source=%s, want %s", r.Number, r.HalfSource, wantSource)
					}
				}
			})
		}
	}
}
