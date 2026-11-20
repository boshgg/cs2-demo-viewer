package main

import "testing"

func TestUtilityBestGunBelongsToThrowersWholeLiveRound(t *testing.T) {
	d := utilityPlantFixture()
	id := d.Utilities[0].OwnerID
	player := PlayerFrame{ID: id, Team: 2, Alive: true, Connected: true, Weapon: "Knife", Weapons: []WeaponItem{{Name: "Glock-18"}, {Name: "deagle"}}}
	d.Rounds[0].Economy = &EconomySnapshot{Source: "freeze_end", Time: 1, Players: []PlayerFrame{player}}
	d.Rounds[1].Economy = &EconomySnapshot{Source: "freeze_end", Time: 101, Players: []PlayerFrame{player}}
	player.Weapons = []WeaponItem{{Name: "M4A1", Slot: "primary"}}
	// This acquisition occurs after every throw in round one. The thrower is holding a knife.
	d.Frames = append(d.Frames, Frame{Round: 1, T: 65, Players: []PlayerFrame{player}})
	player.Weapons = nil
	player.Weapon = "AWP"
	d.Frames = append(d.Frames, Frame{Round: 2, T: 190.01, Players: []PlayerFrame{player}}) // After the round ended.
	player.Alive = false
	d.Frames = append(d.Frames, Frame{Round: 2, T: 175, Players: []PlayerFrame{player}}) // Stale dead inventory.
	d.Shots = []Shot{
		{Round: 1, T: 45, PlayerID: analysisTestID(2), Team: 2, Weapon: "AWP"},
		{Round: 2, T: 100.5, PlayerID: id, Team: 2, Weapon: "AWP"}, // Before freeze ends.
		{Round: 3, T: 220, PlayerID: id, Team: 2, Weapon: "AWP"},
	}
	report := BuildAnalysis(d)
	if len(report.Utilities) != len(d.Utilities) || report.UtilityWeaponVersion != analysisUtilityWeaponVersion {
		t.Fatal("unexpected utility count or version")
	}
	for _, u := range report.Utilities {
		want := map[int]string{1: "M4A1-S", 2: "Desert Eagle", 3: "AWP", 4: ""}[u.Round]
		if got := u.RoundBestWeapon; got != want {
			t.Errorf("round %d: got %q, want %q", u.Round, got, want)
		}
	}
}

func TestRoundBestWeaponAliasesTiesAndEventEvidence(t *testing.T) {
	w := newAnalysisRoundWeapons([]Round{{Number: 1, Start: 0, FreezeEnd: 5, EndedAt: 45, End: 50}})
	w.observeShot(Shot{T: 32, Round: 1, PlayerID: "thrower", Team: 3, Weapon: "AK-47"})
	w.observeDamage(DamageEvent{T: 30, Round: 1, AttackerID: "thrower", AttackerTeam: 3, Weapon: "weapon_m4a1"})
	if got := w.name(1, "thrower"); got != "M4A4" {
		t.Fatalf("equal-tier earlier firearm = %q", got)
	}
	w.observeShot(Shot{T: 24, Round: 1, PlayerID: "thrower", Team: 3, Weapon: "scout"})
	w.observeEvent(Event{Type: "kill", T: 35, Round: 1, KillerID: "thrower", KillerTeam: 3, Weapon: "AWP", VictimID: "target", VictimTeam: 2, VictimWeapon: "deagle", VictimWeaponSource: "previous_tick", VictimWeaponTime: 34.9})
	if got := w.name(1, "thrower"); got != "AWP" {
		t.Fatalf("AWP over scout = %q", got)
	}
	if got := w.name(1, "target"); got != "Desert Eagle" {
		t.Fatalf("victim's own weapon = %q", got)
	}
	w.observeEvent(Event{Type: "kill", T: 40, Round: 1, VictimID: "target", VictimTeam: 2, VictimWeapon: "AWP", VictimWeaponSource: "previous_tick", VictimWeaponTime: 33})
	if got := w.name(1, "target"); got != "Desert Eagle" {
		t.Fatalf("stale victim weapon = %q", got)
	}
	for _, name := range []string{"knife", "Zeus x27", "C4", "Flashbang", "unknown", ""} {
		w.observeShot(Shot{T: 20, Round: 1, PlayerID: "none", Team: 2, Weapon: name})
	}
	if got := w.name(1, "none"); got != "" {
		t.Fatalf("non-firearms returned %q", got)
	}
}
