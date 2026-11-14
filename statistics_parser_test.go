package main

import "testing"

func TestDeathWeaponNeverSubstitutesCarriedOrStaleGun(t *testing.T) {
	previous := activeWeaponObservation{"AWP", 3, 12}
	weapon, source, _ := chooseDeathWeapon("Smoke Grenade", previous, 3, 12.01)
	if weapon != "Smoke Grenade" || source != "death_event" {
		t.Fatalf("active grenade replaced by a gun: %s %s", weapon, source)
	}
	weapon, source, at := chooseDeathWeapon("", previous, 3, 12.01)
	if weapon != "AWP" || source != "previous_tick" || at != 12 {
		t.Fatalf("recent observation lost: %s %s %v", weapon, source, at)
	}
	for _, p := range []activeWeaponObservation{{"AWP", 2, 12}, {"AWP", 3, 11}, {"AWP", 3, 13}} {
		weapon, source, _ = chooseDeathWeapon("", p, 3, 12.01)
		if weapon != "" || source != "unavailable" {
			t.Fatalf("invalid observation scored: %+v -> %s", p, weapon)
		}
	}
}

func TestStatisticsPhasesHonorRegulationAndOvertime(t *testing.T) {
	for _, row := range []struct {
		number int
		vars   map[string]string
		half   int
		pistol bool
	}{
		{1, nil, 1, true}, {12, nil, 1, false}, {13, nil, 2, true}, {24, nil, 2, false}, {25, nil, 3, false}, {28, nil, 4, false}, {31, nil, 5, false},
		{16, map[string]string{"mp_maxrounds": "30"}, 2, true},
		{31, map[string]string{"mp_maxrounds": "30", "mp_overtime_maxrounds": "10"}, 3, false},
		{36, map[string]string{"mp_maxrounds": "30", "mp_overtime_maxrounds": "10"}, 4, false},
	} {
		half, pistol, _ := statisticsRoundPhase(row.number, row.vars)
		if half != row.half || pistol != row.pistol {
			t.Fatalf("round %d vars %v: half=%d pistol=%v", row.number, row.vars, half, pistol)
		}
	}
}
