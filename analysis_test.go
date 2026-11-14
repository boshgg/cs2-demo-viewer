package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

func analysisTestID(n int) string { return strconv.FormatUint(76561198000000000+uint64(n), 10) }

func analysisTestPlayer(id string, side int, x float64) PlayerFrame {
	return PlayerFrame{ID: id, Team: side, Alive: true, Connected: true, HP: 100, X: x, Y: 64, Z: 0}
}

func analysisMetric(a *AnalysisDemo, player string, metric int) float64 {
	total := 0.0
	for _, s := range a.Series {
		if player == "" || s.PlayerID == player {
			for _, c := range s.Cells {
				total += c[metric]
			}
		}
	}
	return total
}

func TestAnalysisMovementWeightsLiveTimeAndCutsAtDeath(t *testing.T) {
	id := analysisTestID(1)
	d := &DemoData{ID: "time", Map: "de_mirage", Duration: 3, Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 1, EndedAt: 2, End: 3}}}
	for _, timestamp := range []float64{.8, .9, 1, 1.1, 1.2, 1.4, 1.6, 1.9, 2.2, 2.8} {
		p := analysisTestPlayer(id, 2, 130)
		p.Alive = timestamp < 1.4
		if timestamp < 1 {
			p.X = -800 // Freeze-time positions must not leak into the map.
		}
		disconnected := analysisTestPlayer(analysisTestID(2), 3, 600)
		disconnected.Connected = false
		d.Frames = append(d.Frames, Frame{T: timestamp, Round: 1, Players: []PlayerFrame{p, disconnected}})
	}
	d.Events = []Event{{Type: "kill", T: 1.25, Round: 1, VictimID: id, VictimTeam: 2, VictimPos: &Position{130, 64, 0}}}
	a := BuildAnalysis(d)
	if got := analysisMetric(a, id, 3); math.Abs(got-.25) > .0001 {
		t.Fatalf("living occupancy should stop exactly at 1.25, got %g seconds", got)
	}
	if got := analysisMetric(a, analysisTestID(2), 3); got != 0 {
		t.Fatalf("disconnected player contributes %g seconds", got)
	}
	for _, s := range a.Series {
		for _, cell := range s.Cells {
			if cell[0] < 0 && cell[3] > 0 {
				t.Fatal("freeze-time position entered movement heatmap")
			}
		}
	}
}

func TestAnalysisMovementGapsAndRoundTransitionsAreBounded(t *testing.T) {
	id := analysisTestID(1)
	d := &DemoData{ID: "gaps", Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 1, EndedAt: 3, End: 4}, {Number: 2, Start: 4, FreezeEnd: 5, End: 7}}}
	for _, v := range []struct {
		t float64
		r int
	}{{0, 1}, {1, 1}, {2, 1}, {2.25, 1}, {3.5, 1}, {4, 2}, {5, 2}, {5.1, 2}} {
		d.Frames = append(d.Frames, Frame{T: v.t, Round: v.r, Players: []PlayerFrame{analysisTestPlayer(id, 2, 1)}})
	}
	a := BuildAnalysis(d)
	if got := analysisMetric(a, id, 3); math.Abs(got-.85) > .0001 {
		t.Fatalf("gaps must cap at .25s and never span rounds; got %g", got)
	}
}

func TestAnalysisGunfightUsesBothObservedPositionsAndSeparateDeaths(t *testing.T) {
	attacker, victim := analysisTestID(1), analysisTestID(2)
	aPos, vPos, vOther := &Position{130, 130, 5}, &Position{400, 400, 5}, &Position{480, 400, 5}
	d := &DemoData{ID: "combat", Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 1, EndedAt: 9, End: 10}}, Frames: []Frame{{T: 1, Round: 1, Players: []PlayerFrame{analysisTestPlayer(attacker, 2, 0), analysisTestPlayer(victim, 3, 500)}}, {T: 1.1, Round: 1, Players: []PlayerFrame{analysisTestPlayer(attacker, 2, 0), analysisTestPlayer(victim, 3, 500)}}}}
	hit := func(at float64) DamageEvent {
		return DamageEvent{T: at, Round: 1, AttackerID: attacker, VictimID: victim, AttackerTeam: 2, VictimTeam: 3, Weapon: common.EqAK47.String(), Damage: 20, AttackerPos: aPos, VictimPos: vPos}
	}
	d.Damage = append(d.Damage, hit(1.05), hit(1.25), hit(2.1))
	other := hit(1.9)
	other.VictimPos = vOther
	d.Damage = append(d.Damage, other)
	ally := hit(2.2)
	ally.VictimTeam = 2
	d.Damage = append(d.Damage, ally)
	grenade := hit(2.4)
	grenade.Weapon = common.EqHE.String()
	d.Damage = append(d.Damage, grenade)
	armour := hit(3.1)
	armour.Damage = 0 // A real PlayerHurt event can be entirely absorbed by armour.
	d.Damage = append(d.Damage, armour)
	missing := hit(4.1)
	missing.AttackerPos = nil
	d.Damage = append(d.Damage, missing, hit(.5), hit(9.95))
	d.Events = []Event{
		{Type: "kill", T: 3.4, Round: 1, KillerID: attacker, VictimID: attacker, VictimTeam: 2, VictimPos: &Position{900, 900, 5}},
		{Type: "kill", T: 4.2, Round: 1, VictimID: victim, VictimTeam: 3, VictimPos: &Position{-100, -100, 5}},
		{Type: "kill", T: 5, Round: 1, VictimID: victim, VictimTeam: 3},
		{Type: "kill", T: .5, Round: 1, VictimID: victim, VictimTeam: 3, VictimPos: vPos},
		{Type: "kill", T: 9.5, Round: 1, VictimID: victim, VictimTeam: 3, VictimPos: vPos},
	}
	d.Shots = []Shot{{T: 1.1, Round: 1, PlayerID: attacker, Team: 2, Weapon: common.EqAK47.String(), X: 200, Y: 200, Z: 5}, {T: 1.2, Round: 1, PlayerID: attacker, Team: 2, Weapon: common.EqSmoke.String(), X: 200, Y: 200, Z: 5}}
	a := BuildAnalysis(d)
	if got := analysisMetric(a, attacker, 4); got != 3 {
		t.Fatalf("attacker should have 3 deduplicated gunfight bins, got %g", got)
	}
	if got := analysisMetric(a, victim, 4); got != 5 {
		t.Fatalf("victim should have 5 gunfight bins including own movement and unknown attacker pos, got %g", got)
	}
	if analysisMetric(a, attacker, 5) != 1 || analysisMetric(a, victim, 5) != 1 {
		t.Fatal("suicide and world deaths must count at the observed victim positions")
	}
	if got := analysisMetric(a, attacker, 6); got != 1 {
		t.Fatalf("only firearm shots count, got %g", got)
	}
	for _, s := range a.Series {
		if s.PlayerID == attacker {
			for _, c := range s.Cells {
				if c[4] != 0 && (c[0] != 160 || c[1] != 160) {
					t.Fatalf("gunfight was placed away from the actual attacker location: %v", c)
				}
				if c[5] != 0 && (c[0] != 928 || c[1] != 928) {
					t.Fatalf("death was not placed at the victim location: %v", c)
				}
			}
		}
	}
}

func analysisSwapFixture(nameA, nameB string) *DemoData {
	d := &DemoData{ID: "swap", Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, EndedAt: .8, End: 2}, {Number: 2, Start: 2, EndedAt: 2.8, End: 4}}}
	for round := 1; round <= 2; round++ {
		for _, offset := range []float64{.1, .2} {
			f := Frame{T: float64((round-1)*2) + offset, Round: round}
			for i := 0; i < 10; i++ {
				side := 2
				if i >= 5 {
					side = 3
				}
				if round == 2 {
					side = 5 - side
				}
				f.Players = append(f.Players, analysisTestPlayer(analysisTestID(i+1), side, float64(i*100)))
			}
			f.TName, f.CTName = nameA, nameB
			if round == 2 {
				f.TName, f.CTName = nameB, nameA
			}
			d.Frames = append(d.Frames, f)
		}
		if round == 1 {
			// The server may switch entities before the next RoundStart.
			// This post-round snapshot must not contaminate either roster.
			f := d.Frames[len(d.Frames)-1]
			f.T = 1.8
			f.Players = append([]PlayerFrame{}, f.Players...)
			for i := range f.Players {
				f.Players[i].Team = 5 - f.Players[i].Team
			}
			d.Frames = append(d.Frames, f)
		}
	}
	return d
}

func TestAnalysisTeamsRetainRosterIdentityAcrossSides(t *testing.T) {
	for _, names := range [][2]string{{"Alpha Club", "Beta Club"}, {"TERRORISTS", "COUNTER-TERRORISTS"}, {"Team A", "Team B"}, {"Duplicate Clan", "Duplicate Clan"}} {
		t.Run(names[0]+"/"+names[1], func(t *testing.T) {
			a := BuildAnalysis(analysisSwapFixture(names[0], names[1]))
			if len(a.Teams) != 2 {
				t.Fatalf("expected 2 physical teams, got %+v", a.Teams)
			}
			for _, team := range a.Teams {
				if len(team.PlayerIDs) != 5 {
					t.Fatalf("a post-round swap contaminated team membership: %+v", team)
				}
			}
			byPlayer := map[string]string{}
			sides := map[string]map[int]bool{}
			for _, s := range a.Series {
				if old := byPlayer[s.PlayerID]; old != "" && old != s.TeamID {
					t.Fatalf("%s changed team identity at half-time: %s -> %s", s.PlayerID, old, s.TeamID)
				}
				byPlayer[s.PlayerID] = s.TeamID
				if sides[s.PlayerID] == nil {
					sides[s.PlayerID] = map[int]bool{}
				}
				sides[s.PlayerID][s.Side] = true
			}
			for player, found := range sides {
				if len(found) != 2 {
					t.Fatalf("player %s must retain distinct CT and T series", player)
				}
			}
		})
	}
}

func TestAnalysisOnlySteamIdentitiesMergeBetweenDemos(t *testing.T) {
	build := func(demoID, steamID string) *AnalysisDemo {
		d := &DemoData{ID: demoID, Damage: []DamageEvent{}, Players: []PlayerInfo{{ID: steamID, Name: "Same nickname"}, {ID: "bot-7", Name: "Same nickname"}, {ID: "1", Name: "Synthetic"}}, Rounds: []Round{{Number: 1, Start: 0, End: 2}}}
		for _, at := range []float64{.1, .2} {
			d.Frames = append(d.Frames, Frame{T: at, Round: 1, TName: "Team A", Players: []PlayerFrame{analysisTestPlayer(steamID, 2, 100), analysisTestPlayer("bot-7", 2, 200)}})
		}
		return BuildAnalysis(d)
	}
	a, b, c := build("a", analysisTestID(1)), build("b", analysisTestID(1)), build("c", analysisTestID(2))
	if a.Teams[0].ID != b.Teams[0].ID {
		t.Fatal("same stable roster did not receive a shared identity")
	}
	if a.Teams[0].ID == c.Teams[0].ID {
		t.Fatal("generic Team A label incorrectly merged unrelated rosters")
	}
	idsA := map[string]bool{}
	for _, p := range a.Players {
		idsA[p.ID] = p.Stable
		if p.Name == "Synthetic" && p.Stable {
			t.Fatal("small numeric demonstration ID incorrectly treated as SteamID64")
		}
	}
	for _, p := range b.Players {
		if _, exists := idsA[p.ID]; exists && !p.Stable {
			t.Fatalf("demo-local identity leaked between recordings: %s", p.ID)
		}
	}
}

func TestAnalysisUtilitiesKeepUnknownThrowOriginsUnknown(t *testing.T) {
	id := analysisTestID(1)
	d := &DemoData{ID: "grenades", Damage: []DamageEvent{}, Rounds: []Round{{Number: 1, Start: 0, FreezeEnd: 1, EndedAt: 9, End: 10}}, Frames: []Frame{{T: 1, Round: 1, Players: []PlayerFrame{analysisTestPlayer(id, 2, 100)}}}}
	good := Utility{ID: "good", Type: "smoke", OwnerID: id, Owner: "Thrower", Team: 2, Round: 1, Start: 1, Detonate: 2, Detonated: true, ThrowObserved: true, X: 300, Y: 400, Z: 20}
	for n := 0; n < 30; n++ {
		good.Path = append(good.Path, UtilityPoint{T: 1 + float64(n)/29, X: 100 + float64(n)*200/29, Y: 400, Z: 20})
	}
	unknown := good
	unknown.ID, unknown.ThrowObserved, unknown.SourceInferred = "unknown", false, true
	late := good
	late.ID = "late-first-observation"
	late.Path = []UtilityPoint{{T: 1.5, X: 180, Y: 400, Z: 30}}
	notDetonated := good
	notDetonated.ID, notDetonated.Detonated = "unobserved-impact", false
	invalid := good
	invalid.ID, invalid.X = "invalid-impact", math.NaN()
	freeze := good
	freeze.ID, freeze.Start = "freeze-throw", .5
	unknownOwner := good
	unknownOwner.ID, unknownOwner.OwnerID, unknownOwner.Team = "unknown-owner", "", 0
	d.Utilities = []Utility{good, unknown, late, notDetonated, invalid, freeze, unknownOwner}
	a := BuildAnalysis(d)
	if len(a.Utilities) != 4 {
		t.Fatalf("expected only 4 live observed detonations, got %+v", a.Utilities)
	}
	for _, u := range a.Utilities {
		switch u.ID {
		case "good":
			if u.Start == nil || u.Start.X != 100 || u.End.X != 300 || len(u.Path) != 24 || u.Path[0].X != 100 || u.Path[23].X != 300 {
				t.Fatalf("observed throw and flight endpoints lost: %+v", u)
			}
		case "unknown", "late-first-observation":
			if u.Start != nil {
				t.Fatalf("missing throw location replaced with an invented origin: %+v", u)
			}
		case "unknown-owner":
			if u.PlayerID != "" || !strings.Contains(u.TeamID, "unknown") {
				t.Fatalf("unknown thrower incorrectly identified: %+v", u)
			}
		}
	}
	if _, err := json.Marshal(a); err != nil {
		t.Fatalf("analysis must not contain non-finite numbers: %v", err)
	}
}

func TestAnalysisDeterminismNoSourceMutationAndVerticalSeparation(t *testing.T) {
	d := analysisSwapFixture("Alpha", "Beta")
	d.Frames[0].Players[0].Z = -550
	d.Frames[1].Players[0].Z = 200
	before, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	a := BuildAnalysis(d)
	b := BuildAnalysis(d)
	aJSON, _ := json.Marshal(a)
	bJSON, _ := json.Marshal(b)
	after, _ := json.Marshal(d)
	if !reflect.DeepEqual(aJSON, bJSON) || !reflect.DeepEqual(before, after) {
		t.Fatal("analysis changed source replay or generated nondeterministic results")
	}
	if d.Frames[0].Players[0].Z != -550 || d.Frames[1].Players[0].Z != 200 {
		t.Fatal("vertical positions changed")
	}
	lower, upper := false, false
	for _, s := range a.Series {
		if s.PlayerID != analysisTestID(1) || s.Side != 2 {
			continue
		}
		for _, c := range s.Cells {
			lower = lower || c[2] == -550 && c[3] > 0
			upper = upper || c[2] == 200 && c[3] > 0
		}
	}
	if !lower || !upper {
		t.Fatal("same XY on different floors must retain separate movement cells")
	}
	if _, err := json.Marshal(BuildAnalysis(nil)); err != nil {
		t.Fatal(err)
	}
}

func TestAnalysisMissingDamageDoesNotInventGunfights(t *testing.T) {
	d := sampleDemo()
	d.Damage = nil
	a := BuildAnalysis(d)
	if analysisMetric(a, "", 4) != 0 || analysisMetric(a, "", 6) == 0 {
		t.Fatal("shots must remain distinct from observed damaging gunfights")
	}
	if len(a.Warnings) <= len(d.Warnings) {
		t.Fatal("old data without damage field must tell the user to reimport")
	}
}

func TestRealDemoAnalysis(t *testing.T) {
	path := os.Getenv("CS2_TEST_DEMO")
	if path == "" {
		t.Skip("set CS2_TEST_DEMO to the upstream Mirage fixture")
	}
	d, err := parseDemo(context.Background(), path, "analysis-real", "upstream-test.dem", func(float64) {})
	if err != nil {
		t.Fatal(err)
	}
	a := BuildAnalysis(d)
	if len(a.Players) != 10 || a.RoundCount != 10 || a.Map != "de_mirage" || len(a.Teams) != 2 {
		t.Fatalf("unexpected fixture identity summary: players=%d rounds=%d map=%s teams=%+v", len(a.Players), a.RoundCount, a.Map, a.Teams)
	}
	movement, combat, deaths, shots := analysisMetric(a, "", 3), analysisMetric(a, "", 4), analysisMetric(a, "", 5), analysisMetric(a, "", 6)
	if movement <= 100 || movement > d.Duration*10 || combat < 100 || deaths < 50 || deaths > 73 || shots < 500 || len(a.Utilities) < 10 {
		t.Fatalf("expected observed activities absent: seconds=%g combat=%g deaths=%g shots=%g utilities=%d", movement, combat, deaths, shots, len(a.Utilities))
	}
	encoded, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("analysis: bytes=%d series=%d players=%d teams=%d seconds=%.2f combat=%.0f deaths=%.0f shots=%.0f utilities=%d", len(encoded), len(a.Series), len(a.Players), len(a.Teams), movement, combat, deaths, shots, len(a.Utilities))
}
