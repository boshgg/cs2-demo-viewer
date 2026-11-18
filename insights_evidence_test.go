package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestInsightsSampleAndSelections(t *testing.T) {
	a, h := testViewer(t)
	r := httptest.NewRequest("POST", "http://127.0.0.1:8765/api/insights/evidence", strings.NewReader(`{"demoIds":["sample"]}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var result insightsReport
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("sample API: %d %s", w.Code, w.Body.String())
	}
	if !result.Synthetic || len(result.Matches) != 1 || result.Matches[0].RoundCount != 3 || len(result.Players) != 10 || len(result.Teams) != 2 {
		t.Fatalf("unexpected sample dimensions: %+v", result)
	}
	for _, team := range result.Teams {
		if team.CT.Decided+team.T.Decided != 3 {
			t.Fatalf("missing round results: %+v", team)
		}
	}
	for _, tc := range []struct {
		player, team   string
		players, teams int
	}{
		{result.Players[0].ID, "", 1, 0},
		{"", result.Teams[0].ID, 5, 1},
	} {
		filter, err := a.buildInsightsEvidence(context.Background(), insightsRequest{[]string{"sample"}, tc.player, tc.team})
		if err != nil || len(filter.Players) != tc.players || len(filter.Teams) != tc.teams {
			t.Fatalf("filter: %+v %v", filter, err)
		}
	}
}

func TestInsightsCrossDemoIDIsolationAndRevision(t *testing.T) {
	a, _ := testViewer(t)
	ids := []string{"000000000000000000000001", "000000000000000000000002"}
	const stable = "76561198000000001"
	for i, id := range ids {
		j, d := statisticsFixture(t, a, id, id+"-1", "private-location.dem")
		d.Synthetic = false
		// Same observed local IDs and same display names in multiple recordings.
		// Only a full Steam ID can identify the same player across recordings.
		d.Players = append(d.Players, PlayerInfo{ID: stable, Name: "shared"})
		d.Events = append(d.Events, Event{Type: "kill", KillerID: stable, VictimID: "0", Round: 1, T: 5, KillerTeam: 3, VictimTeam: 2})
		if i == 0 {
			d.Rounds[0].Winner = 0
		}
		writeFixtureGzip(t, j.result, d)
	}
	req := insightsRequest{DemoIDs: ids}
	report, err := a.buildInsightsEvidence(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if report.Synthetic || len(report.Players) != 21 || len(report.Matches) != 2 {
		t.Fatalf("unexpected cross-demo population %d", len(report.Players))
	}
	for _, p := range report.Players {
		if p.ID == stable {
			if p.Matches != 2 || p.RecordedKills != 2 {
				t.Fatalf("stable ID not combined: %+v", p)
			}
		} else if p.Matches != 1 || !strings.HasPrefix(p.ID, "demo:") {
			t.Fatalf("unscoped local identity: %+v", p)
		}
	}
	if report.Matches[0].Revision != ids[0]+"-1" {
		t.Fatal("missing revision")
	}
	for _, team := range report.Matches[0].Teams {
		if team.CT.Observed+team.T.Observed != 3 || team.CT.Decided+team.T.Decided != 2 {
			t.Fatalf("unknown winner counted: %+v", team)
		}
	}
	body, _ := json.Marshal(report)
	if strings.Contains(string(body), "private-location") {
		t.Fatal("local filename leaked into evidence")
	}
	req.PlayerID = "demo:" + ids[0] + ":player:0"
	filtered, err := a.buildInsightsEvidence(context.Background(), req)
	if err != nil || len(filtered.Players) != 1 || len(filtered.Matches[1].Players) != 0 || filtered.Players[0].Matches != 1 {
		t.Fatalf("absent target counted: %v", err)
	}
}

func TestInsightsRejectsInvalidAndIncompleteSelections(t *testing.T) {
	a, _ := testViewer(t)
	id := "000000000000000000000001"
	j, d := statisticsFixture(t, a, id, id+"-1", "test")
	d.Synthetic = false
	writeFixtureGzip(t, j.result, d)
	for _, tc := range []struct {
		req    insightsRequest
		status int
	}{
		{insightsRequest{}, 400},
		{insightsRequest{DemoIDs: []string{"sample", id}}, 400},
		{insightsRequest{DemoIDs: []string{id, id}}, 400},
		{insightsRequest{DemoIDs: []string{"../bad"}}, 400},
		{insightsRequest{[]string{id}, "x", "y"}, 400},
		{insightsRequest{DemoIDs: []string{"000000000000000000000099"}}, 404},
		{insightsRequest{[]string{id}, "unknown", ""}, 422},
	} {
		_, err := a.buildInsightsEvidence(context.Background(), tc.req)
		var e *insightsError
		if !errors.As(err, &e) || e.status != tc.status {
			t.Fatalf("request %v: got %v want %d", tc.req, err, tc.status)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.buildInsightsEvidence(ctx, insightsRequest{DemoIDs: []string{id}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation ignored: %v", err)
	}
	if err := os.WriteFile(j.result, []byte("unreadable"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := a.buildInsightsEvidence(context.Background(), insightsRequest{DemoIDs: []string{id}})
	var e *insightsError
	if !errors.As(err, &e) || e.status != 500 {
		t.Fatalf("broken cache presented as evidence: %v", err)
	}
}

func TestInsightsKeepsSwitchedPlayersInTheirRoundTeam(t *testing.T) {
	a := StatisticsPlayer{ID: "7", Name: "Sub", Summary: StatisticsSummary{Kills: 3, Deaths: 2}}
	b := StatisticsPlayer{ID: "8", Name: "Other"}
	d := &DemoData{ID: "sample", Rounds: []Round{{Number: 1, End: 10, Winner: 3}, {Number: 2, Start: 10, End: 20, Winner: 2}}}
	one, negative := 1000, -1200
	stats := &StatisticsDemo{
		Players: []StatisticsPlayer{a, b},
		Teams: []StatisticsGroup{
			{TeamKey: "name:red", Label: "Red", Players: []StatisticsPlayer{{ID: a.ID, Name: a.Name, Summary: StatisticsSummary{Kills: 1}}, b}},
			{TeamKey: "name:blue", Label: "Blue", Players: []StatisticsPlayer{b, a}},
		},
		Rounds: []StatisticsRound{
			{Number: 1, CT: TeamEconomy{TeamKey: "name:red"}, T: TeamEconomy{TeamKey: "name:blue"}},
			{Number: 2, CT: TeamEconomy{TeamKey: "name:blue"}, T: TeamEconomy{TeamKey: "name:red"}},
		},
		Impact: &StatisticsImpact{
			Rounds: []StatisticsExposure{
				{Round: 1, PlayerID: a.ID, TeamKey: "name:red", Eligible: true},
				{Round: 2, PlayerID: a.ID, TeamKey: "name:blue", Eligible: true},
			},
			Kills: []StatisticsImpactKill{
				{Index: 100, Round: 1, PlayerID: a.ID, TeamKey: "name:red", Score: &one},
				{Index: 110, Round: 2, PlayerID: b.ID, TeamKey: "name:red", Score: &one},
			},
			Deaths: []StatisticsImpactDeath{
				{Index: 100, Round: 1, PlayerID: b.ID, KillerID: a.ID, TeamKey: "name:blue", Outcome: "loss", FirstDeath: true, Penalty: &negative},
				{Index: 110, Round: 2, PlayerID: a.ID, KillerID: b.ID, TeamKey: "name:blue", Outcome: "loss", FirstDeath: true, Penalty: &negative},
			},
		},
	}
	m := summarizeInsightsMatch(d, stats, insightsRequest{Team: "name:red"})
	p := m.Players[0]
	if len(m.Players) != 2 || p.RecordedKills != 1 || p.ObservedRounds != 1 || p.Verified.Rounds != 1 || p.Verified.DeathPoints != 0 || p.Verified.KillPoints != 1000 {
		t.Fatalf("team filter mixed player's other-team contributions: %+v", p)
	}
	team := m.Teams[0]
	if team.CT.Won != 1 || team.T.Won != 1 || team.AfterOpeningKill != (insightsOutcome{2, 2}) || team.AfterOpeningDeath.Rounds != 0 {
		t.Fatalf("side swap or opening conversions incorrectly aggregated: %+v", team)
	}
}
