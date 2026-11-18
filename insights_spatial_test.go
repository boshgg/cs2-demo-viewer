package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestInsightsSpatialSidesPhasesPositionsAndLandmarks(t *testing.T) {
	red := TeamEconomy{TeamKey: "red"}
	blue := TeamEconomy{TeamKey: "blue"}
	stats := &StatisticsDemo{
		Rounds: []StatisticsRound{{Number: 1, CT: red, T: blue}, {Number: 2, CT: blue, T: red}},
		Teams:  []StatisticsGroup{{TeamKey: "red", Label: "Red"}, {TeamKey: "blue", Label: "Blue"}},
	}
	d := &DemoData{ID: "one", Map: "de_ancient", Rounds: []Round{
		{Number: 1, Start: 0, FreezeEnd: 10, End: 100, EndedAt: 80},
		{Number: 2, Start: 110, FreezeEnd: 110, End: 125},
	}}
	a, b := Position{-10, 390, 132}, Position{400, 2, 31}
	for _, at := range []float64{24.9, 25.1, 25.35, 25.60, 25.85, 26.1, 29.9, 30.1, 30.35, 30.60, 30.85, 31.1, 31.35} {
		p := a
		if at >= 30.1 {
			p = b
		}
		d.Frames = append(d.Frames, Frame{Round: 1, T: at, Players: []PlayerFrame{{ID: "7", Alive: true, Connected: true, Team: 3, X: p.X, Y: p.Y, Z: p.Z}}})
	}
	d.Frames = append(d.Frames, Frame{Round: 1, T: 51.1, Bomb: &Bomb{X: 600, State: "planted"}}, Frame{Round: 1, T: 50.3, Bomb: &Bomb{X: 777, State: "planted"}})
	d.Events = []Event{{Round: 1, T: 30, Type: "kill", KillerID: "7", VictimID: "8", KillerTeam: 3, VictimTeam: 2, KillerPos: &b, VictimPos: &a}, {Round: 1, Type: "bomb_planted", T: 50, Site: "B"},
		{Round: 2, Type: "bomb_planted", T: 115, Site: "A"}}
	hit := DamageEvent{Round: 1, T: 30, AttackerID: "7", VictimID: "8", AttackerTeam: 3, VictimTeam: 2, AttackerPos: &b, VictimPos: &a, Weapon: "AK-47", Damage: 25}
	d.Damage = []DamageEvent{hit, hit}
	shot := func(round, side int, when float64, id string) Shot {
		return Shot{T: when, Round: round, PlayerID: id, Team: side, Weapon: "AK-47", X: a.X, Y: a.Y, Z: a.Z}
	}
	d.Shots = []Shot{shot(1, 3, 29.99, "7"), shot(1, 3, 30, "7"), shot(1, 3, 70, "7"), shot(1, 3, 80.1, "7"), shot(1, 3, 71, "9"), shot(2, 2, 116, "7"), shot(2, 3, 116, "8")}
	d.Utilities = []Utility{
		{Type: "smoke", Round: 1, Team: 3, OwnerID: "7", ThrowObserved: true, Start: 29, Detonated: true, Detonate: 31, X: a.X, Y: a.Y, Z: a.Z},
		{Type: "he", Round: 1, Team: 3, OwnerID: "7", Detonated: true, Detonate: 31, X: b.X, Y: b.Y, Z: b.Z},
	}
	builder := newSpatialBuilder()
	player, _ := analysisPlayerID("one", "7")
	if err := builder.observe(context.Background(), d, stats, insightsRequest{PlayerID: player}); err != nil {
		t.Fatal(err)
	}
	report := builder.report()
	if len(report.Coverage) != 1 || report.Coverage[0].Timed != 1 || !report.Coverage[0].DamageRecorded {
		t.Fatalf("timing/coverage: %+v", report.Coverage)
	}
	if len(report.Landmarks) != 1 || report.Landmarks[0] != (spatialLandmark{"de_ancient", "B", 777, 0, 0, 1}) {
		t.Fatalf("landmarks: %+v", report.Landmarks)
	}
	phase := map[string]spatialGroup{}
	for _, g := range report.Groups {
		if g.TeamID != "red" || g.Rounds != 1 || len(g.DemoIDs) != 1 || g.DemoIDs[0] != "one" {
			t.Fatalf("incorrect scope: %+v", g)
		}
		phase[fmt.Sprintf("%d/%s", g.Side, g.Phase)] = g
	}
	if len(phase) != 5 {
		t.Fatal(phase)
	}
	open, mid := phase["3/opening"], phase["3/mid"]
	if open.Totals[4] != 1 || open.Totals[5] != 1 || open.UtilityTypes["smoke"] != 1 || phase["3/late"].Totals[4] != 1 || phase["2/unknown"].Totals[4] != 1 || phase["3/unknown"].Totals[5] != 1 {
		t.Fatal(phase)
	}
	if mid.Totals[1] != 1 || mid.Totals[2] != 0 || mid.Totals[3] != 1 || mid.Totals[4] != 1 || mid.Totals[5] != 0 {
		t.Fatalf("mid events: %+v", mid)
	}
	if open.OpeningAt15 == nil || open.OpeningAt15.PlayerRounds != 1 || open.OpeningAt15.Cells[0] != ([5]int{-192, 576, 192, 1, 1}) {
		t.Fatalf("15s snapshot: %+v", open.OpeningAt15)
	}
	if len(mid.Moves) != 1 || mid.Moves[0] != ([7]int{-192, 576, 192, 576, 192, 64, 1}) || mid.MoveEligible != 1 || mid.Moved != 1 {
		t.Fatalf("mid move: %+v", mid.Moves)
	}
	if open.Totals[0] != 1.55 || mid.Totals[0] != 1.60 {
		t.Fatalf("interval split at 20s: %v / %v", open.Totals, mid.Totals)
	}
	team := newSpatialBuilder()
	if err := team.observe(context.Background(), d, stats, insightsRequest{Team: "red"}); err != nil {
		t.Fatal(err)
	}
	for _, g := range team.report().Groups {
		if g.TeamID != "red" || (g.Phase == "late" && g.Totals[4] != 2) {
			t.Fatalf("team scope: %+v", g)
		}
	}
}

func TestInsightsSpatialMultiMapBudgetPreservesAllGroups(t *testing.T) {
	r := &insightsReport{}
	for m := 0; m < 8; m++ {
		for team := 0; team < 2; team++ {
			for side := 2; side <= 3; side++ {
				for _, phase := range spatialPhaseNames {
					g := spatialGroup{Map: fmt.Sprintf("map%d", m), TeamID: fmt.Sprintf("name:%d-%d", m, team), TeamName: strings.Repeat("队", 24), Side: side, Phase: phase, Rounds: 24, CellCount: 100, Totals: [6]float64{700, 130, 30, 24, 400, 60}}
					for i := 0; i < 80; i++ {
						g.Cells = append(g.Cells, [10]float64{float64(384*i + 192), -1728, 64, 200, 37, 15, 13, 40, 5, 18})
					}
					r.Spatial.Groups = append(r.Spatial.Groups, g)
				}
			}
		}
	}
	raw, _ := json.Marshal(r)
	if len(raw) <= maxInsightsEvidenceBytes {
		t.Fatal("fixture must trigger size fallback")
	}
	if err := r.fitSize(maxInsightsEvidenceBytes); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(r)
	if len(encoded) > maxInsightsEvidenceBytes || len(r.Spatial.Groups) != 128 {
		t.Fatal("oversized or groups lost", len(encoded), len(r.Spatial.Groups))
	}
	for _, g := range r.Spatial.Groups {
		if len(g.Cells) == 0 || g.CellCount != 100 || g.Totals[4] != 400 || g.Rounds != 24 {
			t.Fatal(g)
		}
	}
}
