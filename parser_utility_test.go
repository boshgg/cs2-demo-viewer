package main

import (
	"context"
	"os"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

func TestFireLifetimeTracksBurningCellsNotEntityDestruction(t *testing.T) {
	u := Utility{Type: "molotov", Detonated: true, Detonate: 1, End: 8, Approx: true}
	recordFireState(&u, 1, []Position{}, true)
	if u.BurnObserved || u.EndObserved {
		t.Fatal("an initially empty inferno is not a burning fire")
	}
	recordFireState(&u, 1.03, []Position{{X: 20, Y: 30, Z: 5}}, false)
	if !u.BurnObserved || u.BurnStart != 1.03 {
		t.Fatal("first active cells must establish actual burn start")
	}
	// Extinction must be recorded between the usual 4 Hz geometry samples.
	recordFireState(&u, 1.16, []Position{}, false)
	if !u.EndObserved || u.End != 1.16 || u.Approx {
		t.Fatalf("burning end was not observed: %+v", u)
	}
	if len(u.FireFrames) != 3 || len(u.FireFrames[2].Points) != 0 {
		t.Fatal("must retain an empty terminal fire frame")
	}
	d := &DemoData{Utilities: []Utility{u}}
	s := newUtilityTracker(d, func() float64 { return 21 }, func() int { return 1 }, func(Event) {}, func() bool { return true })
	inf := common.NewInferno(nil, nil, nil)
	s.infernos[inf.UniqueID()] = 0
	s.infernoExpired(inf)
	if d.Utilities[0].End != 1.16 {
		t.Fatal("late inferno entity destruction must not extend the visible fire")
	}
}

func TestRealDemoUtilityAndPlayerDetails(t *testing.T) {
	path := os.Getenv("CS2_TEST_DEMO")
	if path == "" {
		t.Skip("CS2_TEST_DEMO fixture required")
	}
	d, err := parseDemo(context.Background(), path, "utility-fixture", "fixture.dem", func(float64) {})
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	observed, unknownOwners, bounces, fireFrames := 0, 0, 0, 0
	throws := map[string]bool{}
	for _, e := range d.Events {
		if e.Type == "utility_throw" {
			throws[e.UtilityID] = true
		}
	}
	firstObserved := 0
	observedFires, shortExtinguishedFire := 0, false
	rounds := map[int]Round{}
	for _, r := range d.Rounds {
		rounds[r.Number] = r
	}
	for _, u := range d.Utilities {
		if u.BurnObserved {
			observedFires++
			last := u.FireFrames[len(u.FireFrames)-1]
			if !u.EndObserved || u.End-u.Detonate > 8 || last.T != u.End || len(last.Points) != 0 {
				t.Errorf("fire outlives burning cells: owner=%s round=%d detonate=%v end=%v terminal=%+v", u.Owner, u.Round, u.Detonate, u.End, last)
			}
			if u.Round == 5 && u.Owner == "IMI Negev" {
				shortExtinguishedFire = u.End > 448.3 && u.End < 448.4
			}
		}
		if u.ThrowObserved != throws[u.ID] {
			t.Errorf("throw observation must match actual event: id=%s observed=%t event=%t", u.ID, u.ThrowObserved, throws[u.ID])
		}
		if !u.ThrowObserved {
			firstObserved++
		}
		if u.Type == "fire" || u.Type == "grenade" {
			t.Logf("unresolved utility: %+v", u)
		}
		counts[u.Type]++
		if u.EndObserved {
			observed++
		}
		if u.OwnerID == "" {
			unknownOwners++
		}
		r, ok := rounds[u.Round]
		if !ok || u.Start < r.Start || u.End > r.End || u.End < u.Start {
			t.Errorf("utility outside round: %+v, round=%+v", u, r)
		}
		if u.Detonated && (u.Detonate < u.Start || u.Detonate > u.End) {
			t.Errorf("invalid detonation bounds: %+v", u)
		}
		for i, p := range u.Path {
			if p.T < u.Start || p.T > u.End || (i > 0 && p.T <= u.Path[i-1].T) {
				t.Errorf("invalid path time %v for %s", p.T, u.ID)
			}
			if p.Bounce {
				bounces++
			}
		}
		for _, f := range u.FireFrames {
			if f.T < u.Detonate || f.T > u.End {
				t.Errorf("invalid fire time: %v utility %+v", f.T, u)
			}
			if len(f.Points) > 0 {
				fireFrames++
			}
		}
	}
	if len(d.Utilities) < 50 || counts["smoke"] == 0 || counts["flash"] == 0 || fireFrames == 0 || bounces == 0 {
		t.Fatalf("missing utility detail: counts=%v fireframes=%d bounces=%d", counts, fireFrames, bounces)
	}
	if unknownOwners != 0 {
		t.Errorf("%d fixture utilities have no thrower", unknownOwners)
	}
	if firstObserved == 0 {
		t.Errorf("fixture starts with existing projectiles; no first-observed utility retained")
	}
	if observedFires != 25 || !shortExtinguishedFire {
		t.Errorf("incorrect fire lifetimes: observedFires=%d earlyExtinguishedRound5=%t", observedFires, shortExtinguishedFire)
	}
	if counts["fire"] > 0 {
		t.Errorf("fixture fire sources failed to associate: %d", counts["fire"])
	}
	if observed < 10 {
		t.Errorf("too few observed expiry events: %d", observed)
	}
	inventory, money, ammo, flash, kit := false, false, false, false, false
	for _, f := range d.Frames {
		for _, p := range f.Players {
			inventory = inventory || len(p.Inventory) > 0
			money = money || p.Money > 0
			ammo = ammo || p.Ammo > 1
			flash = flash || p.Flash > 0
			kit = kit || p.DefuseKit
		}
	}
	if !inventory || !money || !ammo || !flash || !kit {
		t.Errorf("missing player details: inventory=%t money=%t ammo=%t flash=%t kit=%t", inventory, money, ammo, flash, kit)
	}
	kills, positions := 0, 0
	for _, e := range d.Events {
		if _, ok := rounds[e.Round]; !ok {
			t.Errorf("unknown event round %d", e.Round)
		}
		if e.Type == "kill" {
			kills++
			if e.KillerPos != nil && e.VictimPos != nil {
				positions++
			}
		}
	}
	if kills != 73 || positions < 70 {
		t.Errorf("incomplete kills: kills=%d positions=%d", kills, positions)
	}
	t.Logf("utilities=%d counts=%v observedThrows=%d firstObserved=%d observedEnds=%d ownerless=%d bounces=%d fireFrames=%d killPositions=%d events=%d", len(d.Utilities), counts, len(throws), firstObserved, observed, unknownOwners, bounces, fireFrames, positions, len(d.Events))
}
