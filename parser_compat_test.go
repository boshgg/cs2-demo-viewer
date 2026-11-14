package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Optional local regression coverage. Recordings stay outside the repository.
func TestParseLocalCompatibilityDemos(t *testing.T) {
	paths := os.Getenv("CS2_COMPAT_DEMOS")
	if paths == "" {
		t.Skip("set CS2_COMPAT_DEMOS to local demo paths separated by semicolons")
	}
	for _, path := range strings.Split(paths, ";") {
		t.Run(filepath.Base(path), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			d, err := parseDemo(ctx, path, "compat", "local.dem", func(float64) {})
			if err != nil {
				t.Fatal(err)
			}
			if len(d.Frames) < 100 || len(d.Players) < 2 || len(d.Rounds) < 1 || d.Duration <= 0 || d.Map == "" {
				t.Fatal("incomplete replay")
			}
			for i, f := range d.Frames {
				if i > 0 && f.T <= d.Frames[i-1].T {
					t.Fatalf("non-monotonic frame %d", i)
				}
			}
			a := BuildAnalysis(d)
			if len(a.Series) == 0 || len(a.Teams) == 0 {
				t.Fatal("missing analysis data")
			}
			t.Logf("map=%s rounds=%d players=%d frames=%d duration=%.2f utilities=%d warnings=%v", d.Map, len(d.Rounds), len(d.Players), len(d.Frames), d.Duration, len(d.Utilities), d.Warnings)
		})
	}
}

// Unnamed matchmaking recordings must expose rosters and players independently
// of clan labels. This optional full-demo regression uses only a local file;
// neither recordings nor player identities are checked into the repository.
func TestParseLocalUnnamedLadderDemo(t *testing.T) {
	path := os.Getenv("CS2_LADDER_DEMO")
	if path == "" {
		t.Skip("set CS2_LADDER_DEMO to a local unnamed matchmaking .dem")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	d, err := parseDemo(ctx, path, "ladder-regression", "local-ladder.dem", func(float64) {})
	if err != nil {
		t.Fatal(err)
	}
	a := BuildAnalysis(d)
	if len(a.Players) < 2 || len(a.Teams) != 2 || len(a.Series) == 0 || a.RoundCount == 0 {
		t.Fatalf("unnamed ladder analysis is incomplete: %d players, %d teams, %d series, %d rounds", len(a.Players), len(a.Teams), len(a.Series), a.RoundCount)
	}
	players := map[string]bool{}
	for _, p := range a.Players {
		players[p.ID] = true
	}
	members := map[string]map[string]bool{}
	for _, team := range a.Teams {
		if team.Name == "" || team.IdentitySource != "roster" || len(team.PlayerIDs) == 0 {
			t.Fatal("unnamed teams must have a generated name and nonempty roster")
		}
		members[team.ID] = map[string]bool{}
		for _, id := range team.PlayerIDs {
			if !players[id] {
				t.Fatal("team member is absent from the player selector")
			}
			members[team.ID][id] = true
		}
	}
	playerTeams := map[string]string{}
	teamSides := map[string]map[int]bool{}
	for _, s := range a.Series {
		if !players[s.PlayerID] || !members[s.TeamID][s.PlayerID] {
			t.Fatal("analysis series refers to an unavailable player or team")
		}
		if team := playerTeams[s.PlayerID]; team != "" && team != s.TeamID {
			t.Fatal("a player changed roster identity when switching CT/T")
		}
		playerTeams[s.PlayerID] = s.TeamID
		if teamSides[s.TeamID] == nil {
			teamSides[s.TeamID] = map[int]bool{}
		}
		teamSides[s.TeamID][s.Side] = true
	}
	for _, sides := range teamSides {
		if !sides[2] || !sides[3] {
			t.Fatal("completed ladder match must preserve both CT and T analysis for each roster")
		}
	}
	for metric := 3; metric <= 6; metric++ {
		if analysisMetric(a, "", metric) <= 0 {
			t.Fatalf("ladder heatmap metric %d has no observations", metric)
		}
	}
	t.Logf("map=%s rounds=%d players=%d teams=%d series=%d utilities=%d movement=%.2fs fights=%.0f deaths=%.0f shots=%.0f warnings=%d", a.Map, a.RoundCount, len(a.Players), len(a.Teams), len(a.Series), len(a.Utilities), analysisMetric(a, "", 3), analysisMetric(a, "", 4), analysisMetric(a, "", 5), analysisMetric(a, "", 6), len(a.Warnings))
}
