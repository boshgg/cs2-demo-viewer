package main

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

func impactDemo() *DemoData {
	players := append(statsSquad(3, "AK-47", 100, 100, statsFour()), statsSquad(2, "AK-47", 100, 100, statsFour())...)
	d := statsDemo(players)
	d.Rounds[0].Winner = 2
	d.Rounds = append(d.Rounds, Round{Number: 3, Start: 120, FreezeEnd: 130, EndedAt: 220, End: 240, Winner: 3, Economy: &EconomySnapshot{Time: 130, Source: "freeze_end", Complete: true, Players: append([]PlayerFrame{}, players...), Half: 1, HalfSource: "convar"}})
	d.Events = []Event{statsKill("AK-47", "AK-47")}
	return d
}

func impactOnlyDeath(t *testing.T, d *DemoData) StatisticsImpactDeath {
	t.Helper()
	impact := BuildStatistics(d).Impact
	if impact == nil || len(impact.Deaths) != 1 {
		t.Fatalf("expected one death: %+v", impact)
	}
	death := impact.Deaths[0]
	if death.Penalty == nil || death.CorePenalty == nil {
		t.Fatalf("unexpected missing score: %+v warnings=%v", death, impact.Warnings)
	}
	return death
}

func impactAt(k Event, t float64, killer, victim string, killerSide, victimSide int) Event {
	k.T, k.VictimWeaponTime, k.KillerID, k.VictimID, k.KillerTeam, k.VictimTeam = t, t, killer, victim, killerSide, victimSide
	return k
}

func TestImpactOpeningDeathWeaponMatrixAndKillContribution(t *testing.T) {
	guns := []string{"Glock-18", "MP9", "AK-47", "AWP"}
	for killerRank, killer := range guns {
		for victimRank, victim := range guns {
			t.Run(killer+"-"+victim, func(t *testing.T) {
				d := impactDemo()
				d.Rounds = d.Rounds[:1]
				d.Events = []Event{statsKill(killer, victim)}
				result := BuildStatistics(d)
				death := result.Impact.Deaths[0]
				wantCore := int(math.Round(2500 * math.Exp2(float64(victimRank-killerRank))))
				if death.Penalty == nil || *death.Penalty != -wantCore || *death.CorePenalty != wantCore || !death.FirstDeath || *death.AlliesBefore != 5 || *death.EnemiesBefore != 5 || death.Outcome != "loss" || *death.WeaponGap != victimRank-killerRank {
					t.Fatalf("wrong death context/formula: %+v want=%d", death, wantCore)
				}
				if result.Impact.Kills[0].Score == nil || *result.Impact.Kills[0].Score != 1000+125**result.Kills[0].Score {
					t.Fatalf("kill contribution changed or omitted base: %+v", result.Impact.Kills[0])
				}
			})
		}
	}
}

func TestImpactOpeningLossExamplesAndWinDiscount(t *testing.T) {
	for _, test := range []struct {
		killer, victim string
		winner, want   int
	}{{"AWP", "Glock-18", 2, 313}, {"AK-47", "AK-47", 2, 2500}, {"Glock-18", "AK-47", 2, 10000}, {"Glock-18", "AWP", 2, 20000}, {"Glock-18", "AK-47", 3, 3500}} {
		d := impactDemo()
		d.Rounds = d.Rounds[:1]
		d.Rounds[0].Winner = test.winner
		d.Events = []Event{statsKill(test.killer, test.victim)}
		death := impactOnlyDeath(t, d)
		if *death.CorePenalty != test.want {
			t.Fatalf("%s kills %s winner %d: got %d want %d", test.killer, test.victim, test.winner, *death.CorePenalty, test.want)
		}
	}
}

func TestImpactPriorHostileKillsReducePenaltyAndEqualNumbersMatter(t *testing.T) {
	last := math.MaxInt
	for prior := 0; prior <= 4; prior++ {
		d := impactDemo()
		d.Rounds = d.Rounds[:1]
		d.Events = nil
		for n := 0; n < prior; n++ {
			victim := d.Rounds[0].Economy.Players[6+n].ID // T players 1..4; preserve killer p0.
			d.Events = append(d.Events, impactAt(statsKill("AK-47", "AK-47"), 20+float64(n), "s3-p0", victim, 3, 2))
		}
		d.Events = append(d.Events, statsKill("AK-47", "AK-47"))
		death := BuildStatistics(d).Impact.Deaths[len(d.Events)-1]
		if death.Penalty == nil || death.KillsBefore != prior || *death.AlliesBefore != 5 || *death.EnemiesBefore != 5-prior || *death.CorePenalty >= last {
			t.Fatalf("prior kills not monotonic or wrong numbers: prior=%d %+v", prior, death)
		}
		last = *death.CorePenalty
	}
	d := impactDemo()
	d.Rounds = d.Rounds[:1]
	first := impactAt(statsKill("AK-47", "AK-47"), 20, "s2-p0", "s3-p1", 2, 3)
	equalizer := impactAt(statsKill("AK-47", "AK-47"), 25, "s3-p2", "s2-p1", 3, 2)
	d.Events = []Event{first, statsKill("AK-47", "AK-47")}
	unequal := BuildStatistics(d).Impact.Deaths[1]
	d.Events = []Event{first, equalizer, statsKill("AK-47", "AK-47")}
	equal := BuildStatistics(d).Impact.Deaths[2]
	if *unequal.CorePenalty != 750 || *equal.CorePenalty != 1250 || equal.FirstDeath || *equal.AlliesBefore != 4 || *equal.EnemiesBefore != 4 {
		t.Fatalf("equal-state penalty must be greater: unequal=%+v equal=%+v", unequal, equal)
	}
}

func TestImpactNextWeaponAndUtilityCorrelationAreExclusiveAndCapped(t *testing.T) {
	for _, test := range []struct {
		label, killer, weapon, next   string
		nextUtility, drop, utility    int
		weaponPenalty, utilityPenalty int
	}{
		{"AWP lost to pistol then rifle", "Glock-18", "AWP", "AK-47", 4, 1, 0, 1200, 0},
		{"AWP lost to rifle then rifle", "AK-47", "AWP", "AK-47", 4, 1, 0, 300, 0},
		{"same gun fewer utility", "Glock-18", "AK-47", "AK-47", 1, 0, 3, 0, 720},
		{"upgrade fewer utility", "AK-47", "AK-47", "AWP", 2, 0, 2, 0, 120},
		{"downgrade and fewer utility", "AK-47", "AK-47", "MP9", 1, 1, 0, 150, 0},
	} {
		t.Run(test.label, func(t *testing.T) {
			d := impactDemo()
			d.Events[0] = statsKill(test.killer, test.weapon)
			d.Rounds[0].Economy.Players[0] = statsPlayer("s3-p0", 3, test.weapon, 100, 100, statsFour())
			utility := []InventoryItem{{Type: "flash", Count: 1}}
			switch test.nextUtility {
			case 4:
				utility = statsFour()
			case 2:
				utility = []InventoryItem{{Type: "flash", Count: 2}}
			}
			d.Rounds[1].Economy.Players[0] = statsPlayer("s3-p0", 3, test.next, 100, 100, utility)
			death := impactOnlyDeath(t, d)
			if death.Next.Status != "compared" || death.Next.WeaponDrop != test.drop || death.Next.UtilityDrop != test.utility || death.Next.WeaponPenalty != test.weaponPenalty || death.Next.UtilityPenalty != test.utilityPenalty || death.EconomyPenalty != test.weaponPenalty+test.utilityPenalty || *death.Penalty != -*death.CorePenalty-death.EconomyPenalty {
				t.Fatalf("bad economic comparison: %+v", death)
			}
		})
	}
	// A won late-round death with four prior kills has a small core. The
	// economic term is floored at 20%, not independently rounded above its cap.
	d := impactDemo()
	d.Rounds[0].Winner = 3
	d.Rounds[0].Economy.Players[0] = statsPlayer("s3-p0", 3, "AWP", 100, 100, statsFour())
	d.Rounds[1].Economy.Players[0] = statsPlayer("s3-p0", 3, "Glock-18", 100, 100, nil)
	d.Events = nil
	for n := 0; n < 4; n++ {
		d.Events = append(d.Events, impactAt(statsKill("AWP", "AK-47"), 20+float64(n), "s3-p0", d.Rounds[0].Economy.Players[6+n].ID, 3, 2))
	}
	d.Events = append(d.Events, statsKill("Glock-18", "AWP"))
	death := BuildStatistics(d).Impact.Deaths[4]
	if death.Next.WeaponDrop != 3 || death.EconomyPenalty != int(math.Floor(float64(*death.CorePenalty)*.2)) || float64(death.EconomyPenalty) > float64(*death.CorePenalty)*.2 {
		t.Fatalf("economic cap violated: %+v", death)
	}
}

func TestImpactNextComparisonSkipsResetGapMissingPlayerAndIncompleteEquipment(t *testing.T) {
	for _, variant := range []string{"last", "gap", "half", "pistol", "side", "missing", "inventory", "weapons", "incomplete", "default-half"} {
		t.Run(variant, func(t *testing.T) {
			d := impactDemo()
			d.Rounds[0].Economy.Players[0] = statsPlayer("s3-p0", 3, "AWP", 100, 100, statsFour())
			d.Rounds[1].Economy.Players[0] = statsPlayer("s3-p0", 3, "Glock-18", 100, 100, nil)
			switch variant {
			case "last":
				d.Rounds = d.Rounds[:1]
			case "gap":
				d.Rounds[1].Number = 4
			case "half":
				d.Rounds[1].Economy.Half = 2
			case "pistol":
				d.Rounds[1].Economy.Pistol = true
			case "side":
				d.Rounds[1].Economy.Players[0].Team = 2
				d.Rounds[1].Economy.Players[5].Team = 3
			case "missing":
				d.Rounds[1].Economy.Players[0].ID = "substitute"
			case "inventory":
				d.Rounds[1].Economy.Players[0].Inventory = nil
			case "weapons":
				d.Rounds[1].Economy.Players[0].Weapons = nil
			case "incomplete":
				d.Rounds[1].Economy.Complete = false
			case "default-half":
				d.Rounds[0].Economy.HalfSource, d.Rounds[1].Economy.HalfSource = "default_mr12", "default_mr12"
			}
			death := impactOnlyDeath(t, d)
			if death.EconomyPenalty != 0 || death.Next.Status != "unavailable" || death.Next.Reason == "" {
				t.Fatalf("invalid next comparison manufactured data: %+v", death)
			}
		})
	}
}

func TestImpactExclusionsAndNeutralUnknownMatchups(t *testing.T) {
	for _, variant := range []string{"world", "self", "friendly", "freeze", "post", "winner", "end", "roster", "victim-knife", "victim-unknown", "victim-unrecognized", "killer-grenade", "killer-unrecognized"} {
		t.Run(variant, func(t *testing.T) {
			d := impactDemo()
			d.Rounds = d.Rounds[:1]
			switch variant {
			case "world":
				d.Events[0].KillerID, d.Events[0].KillerTeam = "", 0
			case "self":
				d.Events[0].KillerID, d.Events[0].KillerTeam = "s3-p0", 3
			case "friendly":
				d.Events[0].KillerID, d.Events[0].KillerTeam = "s3-p1", 3
			case "freeze":
				d.Events[0].T, d.Events[0].VictimWeaponTime = 5, 5
			case "post":
				d.Events[0].T, d.Events[0].VictimWeaponTime = 110, 110
			case "winner":
				d.Rounds[0].Winner = 0
			case "end":
				d.Rounds[0].EndedAt = 0
			case "roster":
				d.Rounds[0].Economy.Players = d.Rounds[0].Economy.Players[:9]
			case "victim-knife":
				d.Events[0].VictimWeapon = "Knife"
			case "victim-unknown":
				d.Events[0].VictimWeapon, d.Events[0].VictimWeaponSource = "", "unavailable"
			case "victim-unrecognized":
				d.Events[0].VictimWeapon = "future_rifle"
			case "killer-grenade":
				d.Events[0].Weapon = "HE Grenade"
			case "killer-unrecognized":
				d.Events[0].Weapon = "future_rifle"
			}
			result := BuildStatistics(d)
			death, kill := result.Impact.Deaths[0], result.Impact.Kills[0]
			neutral := variant == "victim-knife" || variant == "victim-unknown" || variant == "victim-unrecognized" || variant == "killer-grenade" || variant == "killer-unrecognized"
			if neutral {
				if death.Penalty == nil || *death.CorePenalty != 2500 || death.WeaponGap != nil || death.WeaponFactor != 1 || len(death.Notes) == 0 {
					t.Fatalf("unknown matchup should explicitly use neutral factor: %+v", death)
				}
				if variant == "killer-grenade" || variant == "killer-unrecognized" {
					if kill.Score != nil || kill.ExcludedReason == "" {
						t.Fatal("utility kill contribution must be excluded")
					}
				} else if kill.Score == nil || *kill.Score != 1000 || kill.Reason == "" {
					t.Fatal("gun kill needs base-only evidence")
				}
				if strings.Contains(variant, "unrecognized") && !death.Approx || variant == "victim-unrecognized" && !kill.Approx {
					t.Fatal("unrecognized nonempty weapon must be marked approximate")
				}
			} else if death.Penalty != nil || death.CorePenalty != nil || death.ExcludedReason == "" || kill.Score != nil || kill.ExcludedReason == "" {
				t.Fatalf("invalid impact became zero/scored: death=%+v kill=%+v", death, kill)
			}
		})
	}
}

func TestImpactAllDeathsAdvanceFirstAndAliveButDuplicatesDoNot(t *testing.T) {
	d := impactDemo()
	d.Rounds = d.Rounds[:1]
	world := impactAt(statsKill("", "AK-47"), 20, "", "s3-p1", 0, 3)
	d.Events = []Event{world, statsKill("AK-47", "AK-47")}
	result := BuildStatistics(d).Impact
	if !result.Deaths[0].FirstDeath || result.Deaths[0].Penalty != nil || result.Deaths[1].FirstDeath || *result.Deaths[1].AlliesBefore != 4 || *result.Deaths[1].CorePenalty != 750 {
		t.Fatalf("excluded world death did not advance state: %+v", result.Deaths)
	}
	first := statsKill("AK-47", "AK-47")
	duplicate := first
	duplicate.T, duplicate.VictimWeaponTime = 31, 31
	last := impactAt(first, 32, "s2-p0", "s3-p1", 2, 3)
	d.Events = []Event{first, duplicate, last}
	result = BuildStatistics(d).Impact
	if result.Deaths[1].Penalty != nil || !strings.Contains(result.Deaths[1].ExcludedReason, "重复") || result.Kills[1].Score != nil || *result.Deaths[2].AlliesBefore != 4 || *result.Deaths[2].CorePenalty != 750 {
		t.Fatalf("duplicate death changed counts or score: %+v", result)
	}
	// Utility kills still mitigate the killer's later death, despite not adding
	// gun-matchup kill contribution.
	utility := impactAt(statsKill("HE Grenade", "AK-47"), 20, "s3-p0", "s2-p1", 3, 2)
	d.Events = []Event{utility, first}
	result = BuildStatistics(d).Impact
	if result.Kills[0].Score != nil || result.Deaths[1].KillsBefore != 1 || result.Deaths[1].KillMitigation != .625 {
		t.Fatalf("hostile utility kill was lost in prior-kill mitigation: %+v", result)
	}
}

func TestImpactSameTickOrderAndFrameConsistency(t *testing.T) {
	for _, frameState := range []string{"before", "after", "missing", "revived", "disconnected"} {
		t.Run(frameState, func(t *testing.T) {
			d := impactDemo()
			d.Rounds = d.Rounds[:1]
			second := impactAt(statsKill("AK-47", "AK-47"), 30, "s2-p0", "s3-p1", 2, 3)
			d.Events = append(d.Events, second)
			framePlayers := append([]PlayerFrame{}, d.Rounds[0].Economy.Players...)
			frameTime := 30.0
			switch frameState {
			case "after":
				framePlayers[0].Alive, framePlayers[1].Alive = false, false
			case "missing":
				frameTime = 29
				framePlayers[0].Alive = false
			case "revived":
				frameTime = 31
			case "disconnected":
				frameTime = 29
				framePlayers[4].Connected = false
			}
			d.Frames = []Frame{{T: frameTime, Round: 2, Players: framePlayers}}
			result := BuildStatistics(d).Impact
			valid := frameState == "before" || frameState == "after"
			for _, exposure := range result.Rounds {
				if exposure.Eligible != valid {
					t.Fatalf("exposure disagrees with round evidence: %+v", exposure)
				}
			}
			if valid {
				if !result.Deaths[0].FirstDeath || result.Deaths[1].FirstDeath || *result.Deaths[1].AlliesBefore != 4 || result.Deaths[1].Penalty == nil {
					t.Fatalf("same-tick sequence lost: %+v", result.Deaths)
				}
			} else if result.Deaths[0].Penalty != nil || result.Deaths[0].AlliesBefore != nil || result.Kills[0].Score != nil {
				t.Fatalf("inconsistent round invented counts/score: %+v", result)
			}
		})
	}
}

func TestImpactEndEventFallbackAndSameTimestampBoundary(t *testing.T) {
	d := impactDemo()
	d.Rounds = d.Rounds[:1]
	d.Rounds[0].EndedAt = 0
	kill := impactAt(statsKill("AK-47", "AK-47"), 100, "s2-p0", "s3-p0", 2, 3)
	post := impactAt(kill, 100, "s2-p0", "s3-p1", 2, 3)
	d.Events = []Event{kill, {Type: "round_end", Round: 2, T: 100}, post}
	result := BuildStatistics(d)
	if result.Impact.Deaths[0].Penalty == nil || result.Impact.Deaths[1].Penalty != nil || !strings.Contains(result.Impact.Deaths[1].ExcludedReason, "胜负已确定") || result.Kills[1].Score == nil {
		t.Fatalf("end fallback broke event order or legacy score: %+v", result.Impact)
	}
	d.Events = append(d.Events, Event{Type: "round_end", Round: 2, T: 105})
	if BuildStatistics(d).Impact.Deaths[0].Penalty != nil {
		t.Fatal("ambiguous end events must not establish a boundary")
	}
}

func TestImpactExposureIncludesZeroEventPlayersAndDoesNotMutateReplay(t *testing.T) {
	d := impactDemo()
	before, _ := json.Marshal(d)
	result := BuildStatistics(d)
	after, _ := json.Marshal(d)
	if string(before) != string(after) || len(result.Impact.Rounds) != 20 || result.Impact.Version != "1" || result.RuleVersion != StatisticsVersion {
		t.Fatalf("input mutated or exposure missing: %+v", result.Impact)
	}
	seen := map[[2]string]bool{}
	for _, exposure := range result.Impact.Rounds {
		key := [2]string{string(rune(exposure.Round)), exposure.PlayerID}
		if seen[key] || !exposure.Eligible || exposure.Side == 0 || exposure.Player == "" {
			t.Fatalf("invalid/duplicate exposure: %+v", exposure)
		}
		seen[key] = true
	}
	if !reflect.DeepEqual(result.Impact, BuildStatistics(d).Impact) {
		t.Fatal("impact not deterministic")
	}
	empty, err := json.Marshal(BuildStatistics(nil).Impact)
	if err != nil || !strings.Contains(string(empty), `"kills":[]`) || !strings.Contains(string(empty), `"deaths":[]`) || !strings.Contains(string(empty), `"rounds":[]`) {
		t.Fatalf("bad empty contract: %s %v", empty, err)
	}
}

func TestImpactVersionRebuildsFromReplayWithoutChangingCacheOrMembership(t *testing.T) {
	a, handler := testViewer(t)
	id := "000000000000000000000023"
	j, _ := statisticsFixture(t, a, id, id+"-4", "impact-cache.dem")
	d := impactDemo()
	d.ID, d.Name = id, j.Name
	j.Map = d.Map
	writeFixtureGzip(t, j.result, d)
	before := fileHash(t, j.result)
	a.statisticsKey = id + "\x00" + j.Revision + "\x002"
	a.statisticsJSON = []byte(`{"ruleVersion":"2","obsolete":true}`)
	response := localRequest(handler, "GET", "/api/demos/"+id+"/statistics")
	var result StatisticsDemo
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Impact == nil || result.Impact.Deaths[0].Penalty == nil || result.RuleVersion != StatisticsVersion || fileHash(t, j.result) != before || j.Analysis || len(a.pending) != 0 || j.Revision != id+"-4" {
		t.Fatalf("derived cache migration changed replay or did not add impact: %d %s", response.Code, response.Body.String())
	}
}

func TestImpactEconomyUsesDeathHeldGunIncludingMidRoundPickup(t *testing.T) {
	for _, test := range []struct {
		opening, held, following string
		wantDrop, wantPenalty    int
		wantStatus               string
	}{
		{"AK-47", "AWP", "AK-47", 1, 1200, "compared"},
		{"AWP", "AK-47", "AK-47", 0, 0, "compared"},
		{"AWP", "Knife", "AK-47", 0, 0, "unavailable"},
		{"AWP", "Smoke Grenade", "AK-47", 0, 0, "unavailable"},
		{"AWP", "future_rifle", "AK-47", 0, 0, "unavailable"},
	} {
		d := impactDemo()
		d.Events[0] = statsKill("Glock-18", test.held)
		d.Rounds[0].Economy.Players[0] = statsPlayer("s3-p0", 3, test.opening, 100, 100, statsFour())
		d.Rounds[1].Economy.Players[0] = statsPlayer("s3-p0", 3, test.following, 100, 100, statsFour())
		death := impactOnlyDeath(t, d)
		if death.Next.CurrentWeapon != test.held || death.Next.WeaponDrop != test.wantDrop || death.EconomyPenalty != test.wantPenalty || death.Next.Status != test.wantStatus {
			t.Fatalf("opening=%s held=%s following=%s: %+v", test.opening, test.held, test.following, death.Next)
		}
	}
}

func TestImpactMissingEndOrderDoesNotGuessSameTimeKill(t *testing.T) {
	d := impactDemo()
	d.Rounds = d.Rounds[:1]
	d.Events[0] = impactAt(statsKill("AK-47", "AK-47"), 100, "s2-p0", "s3-p0", 2, 3)
	for _, duplicateEnds := range []bool{false, true} {
		if duplicateEnds {
			d.Events = append(d.Events, Event{Type: "round_end", Round: 2, T: 100}, Event{Type: "round_end", Round: 2, T: 100})
		}
		result := BuildStatistics(d)
		if result.Impact.Deaths[0].Penalty != nil || result.Impact.Kills[0].Score != nil || !strings.Contains(result.Impact.Deaths[0].ExcludedReason, "先后顺序") || result.Kills[0].Score == nil {
			t.Fatalf("ambiguous same-time end counted: %+v", result.Impact)
		}
	}
}
