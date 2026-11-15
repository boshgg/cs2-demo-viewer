package main

import (
	"math"
	"strings"
	"testing"
)

func TestStatisticsConditionalNetIndependentFourByFourMatrices(t *testing.T) {
	guns := []string{"Glock-18", "MP9", "AK-47", "AWP"}
	bases := [4][4]int{{0, 1, 4, 6}, {-1, 0, 3, 5}, {-4, -3, 0, 2}, {-6, -5, -2, 0}}
	multipliers := [4][4]int{{1, 2, 3, 4}, {1, 1, 2, 3}, {1, 1, 1, 2}, {1, 1, 1, 1}}
	aliveScores := [4][4]int{{0, 2, 12, 24}, {0, 0, 6, 15}, {0, 0, 0, 4}, {0, 0, 0, 0}}
	deadScores := [4][4]int{{0, 2, 12, 24}, {-1, 0, 6, 15}, {-4, -3, 0, 4}, {-6, -5, -2, 0}}
	for _, died := range []bool{false, true} {
		for attacker, weapon := range guns {
			for victim, held := range guns {
				d := impactDemo()
				d.Rounds = d.Rounds[:1]
				d.Events = []Event{statsKill(weapon, held)}
				terminal := append([]PlayerFrame{}, d.Rounds[0].Economy.Players...)
				terminal[0].Alive = false
				want := aliveScores[attacker][victim]
				if died {
					d.Events = append(d.Events, impactAt(statsKill("AK-47", weapon), 40, "s3-p1", "s2-p0", 3, 2))
					terminal[5].Alive = false
					want = deadScores[attacker][victim]
				}
				d.Frames = []Frame{{Round: 2, T: 119.9, Players: terminal}}
				result := BuildStatistics(d)
				kill := result.Kills[0]
				assertWeightedKill(t, kill, bases[attacker][victim], multipliers[attacker][victim], want)
				if kill.KillerDiedInRound == nil || *kill.KillerDiedInRound != died || kill.KillerSurvivalReason == "" {
					t.Fatalf("%s -> %s death=%v: missing survival evidence %+v", weapon, held, died, kill)
				}
				if died && (kill.KillerDeathTime == nil || *kill.KillerDeathTime != 40) || !died && kill.KillerDeathTime != nil {
					t.Fatal("wrong actual death timestamp")
				}
				if result.Impact.Kills[0].Score == nil || *result.Impact.Kills[0].Score != 1000+125*want {
					t.Fatal("impact did not consume final conditional score")
				}
				wantMismatch := victim == 0 && (attacker == 1 || attacker == 2)
				if kill.PistolMismatch != wantMismatch {
					t.Fatal("death rule changed the special matchup count")
				}
			}
		}
	}
}

func TestStatisticsSameRoundDeathRequiresActualMatchingEventAndValidTime(t *testing.T) {
	for _, variant := range []string{"hostile", "world", "suicide", "teamkill", "post-winner", "freeze-boundary", "end-boundary", "freeze", "before-start", "after-end", "nan", "infinite", "other-id", "other-round", "disconnect", "duplicate"} {
		t.Run(variant, func(t *testing.T) {
			d := impactDemo()
			d.Events = []Event{statsKill("AWP", "MP9")}
			death := impactAt(statsKill("AK-47", "AWP"), 40, "s3-p1", "s2-p0", 3, 2)
			wantDeath, wantTime := true, 40.0
			switch variant {
			case "world":
				death.KillerID, death.KillerTeam, death.Weapon = "", 0, "worldspawn"
			case "suicide":
				death.KillerID, death.KillerTeam = "s2-p0", 2
			case "teamkill":
				death.KillerID, death.KillerTeam = "s2-p1", 2
			case "post-winner":
				death.T, wantTime = 110, 110
			case "freeze-boundary":
				death.T, wantTime = 10, 10
			case "end-boundary":
				death.T, wantTime = 120, 120
				d.Rounds = d.Rounds[:1] // Only the final recorded round has an inclusive end.
			case "freeze":
				death.T, wantDeath = 5, false
			case "before-start":
				death.T, wantDeath = -1, false
			case "after-end":
				death.T, wantDeath = 120.01, false
			case "nan":
				death.T, wantDeath = math.NaN(), false
			case "infinite":
				death.T, wantDeath = math.Inf(1), false
			case "other-id":
				death.VictimID, death.Victim, wantDeath = "s2-p1", "same display name", false
			case "other-round":
				death.Round, death.T, wantDeath = 3, 140, false
			case "disconnect":
				death.Type, wantDeath = "disconnect", false
			case "duplicate":
				later := death
				later.T = 50
				d.Events = append(d.Events, later)
			}
			death.VictimWeaponTime = death.T
			d.Events = append(d.Events, death)
			var first KillScore
			for _, kill := range BuildStatistics(d).Kills {
				if kill.Index == 0 {
					first = kill
					break
				}
			}
			wantScore := 0
			if wantDeath {
				wantScore = -5
			}
			if first.Score == nil || *first.Score != wantScore {
				t.Fatalf("%s produced wrong final value %+v", variant, first)
			}
			if wantDeath {
				if first.KillerDiedInRound == nil || !*first.KillerDiedInRound || first.KillerDeathTime == nil || *first.KillerDeathTime != wantTime {
					t.Fatalf("actual death not traced: %+v", first)
				}
			} else if first.KillerDiedInRound != nil || first.KillerDeathTime != nil {
				t.Fatal("missing/invalid event became invented death or confirmed survival")
			}
		})
	}
}

func TestStatisticsLegacyMissingFreezeDoesNotDiscardActualSameRoundDeath(t *testing.T) {
	d := impactDemo()
	d.StatisticsVersion = 0
	d.Rounds[1].FreezeEnd = 0
	first := impactAt(statsKill("AWP", "AK-47"), 150, "s2-p0", "s3-p0", 2, 3)
	first.Round = 3
	death := impactAt(statsKill("AK-47", "AWP"), 160, "s3-p1", "s2-p0", 3, 2)
	death.Round = 3
	d.Events = []Event{first, death}
	result := BuildStatistics(d)
	if result.Kills[0].Score == nil || *result.Kills[0].Score != -2 || result.Kills[0].KillerDiedInRound == nil || !*result.Kills[0].KillerDiedInRound {
		t.Fatalf("legacy missing freeze dropped a real death: %+v", result.Kills[0])
	}
}

func TestStatisticsSurvivalNeverInventsDeathFromDeadOrDisconnectedFrames(t *testing.T) {
	for _, variant := range []string{"no-frame", "dead-frame", "disconnected", "missing-player", "missing-roster", "partial-terminal", "old-terminal", "winner-unknown"} {
		t.Run(variant, func(t *testing.T) {
			d := impactDemo()
			d.Rounds = d.Rounds[:1]
			d.Events = []Event{statsKill("AK-47", "MP9")}
			players := append([]PlayerFrame{}, d.Rounds[0].Economy.Players...)
			players[0].Alive = false
			d.Frames = []Frame{{Round: 2, T: 119.9, Players: players}}
			switch variant {
			case "no-frame":
				d.Frames = nil
			case "dead-frame":
				d.Frames[0].Players[5].Alive = false
			case "disconnected":
				d.Frames[0].Players[5].Connected = false
			case "missing-player":
				d.Frames[0].Players[5].ID = "someone-else"
			case "missing-roster":
				d.Rounds[0].Economy.Complete = false
			case "partial-terminal":
				d.Frames[0].Players = d.Frames[0].Players[1:]
			case "old-terminal":
				d.Frames[0].T = 110
			case "winner-unknown":
				d.Rounds[0].Winner = 0
			}
			kill := BuildStatistics(d).Kills[0]
			if kill.KillerDiedInRound != nil || kill.KillerDeathTime != nil || kill.Score == nil || *kill.Score != 0 || !strings.Contains(kill.KillerSurvivalReason, "证据") {
				t.Fatalf("partial data fabricated outcome: %+v", kill)
			}
		})
	}
}

func TestStatisticsConditionalNegativeAppliesToAllKillsByTheSamePlayerInThatRound(t *testing.T) {
	d := impactDemo()
	d.Rounds = d.Rounds[:1]
	d.Events = []Event{
		impactAt(statsKill("AWP", "Glock-18"), 20, "s2-p0", "s3-p0", 2, 3),
		impactAt(statsKill("AWP", "MP9"), 25, "s2-p0", "s3-p1", 2, 3),
		impactAt(statsKill("AWP", "AK-47"), 30, "s2-p0", "s3-p2", 2, 3),
		impactAt(statsKill("AK-47", "AWP"), 50, "s3-p3", "s2-p0", 3, 2),
	}
	result := BuildStatistics(d)
	for i, want := range []int{-6, -5, -2} {
		if *result.Kills[i].Score != want || *result.Kills[i].KillerDeathTime != 50 {
			t.Fatal("same-round evidence was local to one kill/filter")
		}
	}
	// Player, round, side, half and real-team aggregation all consume final net.
	assertWeightedSummary(t, "whole", result.Summary, -9, 4)
	assertWeightedSummary(t, "round", result.Rounds[0].Summary, -9, 4)
	assertWeightedSummary(t, "half", result.Halves[0].Summary, -9, 4)
	for _, player := range result.Players {
		if player.ID == "s2-p0" {
			assertWeightedSummary(t, "player", player.Summary, -13, 3)
		}
	}
	for _, side := range result.Sides {
		if side.Side == 2 {
			assertWeightedSummary(t, "T", side.Summary, -13, 3)
		}
	}
	for _, team := range result.Teams {
		if team.TeamKey == result.Rounds[0].T.TeamKey {
			assertWeightedSummary(t, "team", team.Summary, -13, 3)
		}
	}
}

func TestStatisticsNextRoundStartStrictlyBoundsDeathAndSurvivalEvidence(t *testing.T) {
	for _, overlap := range []bool{false, true} {
		for _, at := range []float64{119.99, 120, 121} {
			d := impactDemo()
			if overlap {
				d.Rounds[0].End = 150
			}
			d.Events = []Event{statsKill("AWP", "AK-47"), impactAt(statsKill("AK-47", "AWP"), at, "s3-p1", "s2-p0", 3, 2)}
			kill := BuildStatistics(d).Kills[0]
			want := 0
			if at < 120 {
				want = -2
			}
			if kill.Score == nil || *kill.Score != want || (kill.KillerDiedInRound != nil && *kill.KillerDiedInRound) != (at < 120) {
				t.Fatalf("overlap=%v death=%g crossed next Start: %+v", overlap, at, kill)
			}
		}
		// A next-round respawn frame carrying an old label is not proof that the
		// player survived the preceding round, even when the old End overlaps.
		d := impactDemo()
		if overlap {
			d.Rounds[0].End = 150
		}
		d.Events = []Event{statsKill("AWP", "AK-47")}
		players := append([]PlayerFrame{}, d.Rounds[0].Economy.Players...)
		players[0].Alive = false
		d.Frames = []Frame{{Round: 2, T: 120, Players: players}}
		kill := BuildStatistics(d).Kills[0]
		if kill.KillerDiedInRound != nil {
			t.Fatalf("next-round frame fabricated survival: %+v", kill)
		}
	}
	// Missing old-cache freeze does not weaken the next-round boundary.
	d := impactDemo()
	d.Rounds[0].Start, d.Rounds[0].FreezeEnd, d.Rounds[0].End = 1, 0, 150
	d.Events = []Event{statsKill("AWP", "AK-47"), impactAt(statsKill("AK-47", "AWP"), 121, "s3-p1", "s2-p0", 3, 2)}
	if kill := BuildStatistics(d).Kills[0]; *kill.Score != 0 || kill.KillerDiedInRound != nil {
		t.Fatal("missing freeze admitted a next-round death")
	}
}
