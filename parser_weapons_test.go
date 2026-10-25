package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

func TestMuzzleEventsExcludeUtilityAndEquipment(t *testing.T) {
	for _, firearm := range []common.EquipmentType{common.EqGlock, common.EqUSP, common.EqDeagle, common.EqAK47, common.EqAWP, common.EqMP9, common.EqNegev, common.EqNova} {
		if !isFirearm(firearm) {
			t.Errorf("firearm %s cannot produce a muzzle cue", firearm)
		}
	}
	for _, equipment := range []common.EquipmentType{common.EqKnife, common.EqBomb, common.EqSmoke, common.EqFlash, common.EqHE, common.EqMolotov, common.EqIncendiary, common.EqDecoy, common.EqZeus, common.EqUnknown} {
		if isFirearm(equipment) {
			t.Errorf("non-firearm %s produces a muzzle cue", equipment)
		}
	}
}

func TestRealDemoWeaponsAndShots(t *testing.T) {
	path := os.Getenv("CS2_TEST_DEMO")
	if path == "" {
		t.Skip("set CS2_TEST_DEMO to the upstream Mirage fixture")
	}
	d, err := parseDemo(context.Background(), path, "weapons", filepath.Base(path), func(float64) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Shots) < 1000 {
		t.Fatalf("too few observed shots: %d", len(d.Shots))
	}
	players := map[string]bool{}
	for _, player := range d.Players {
		players[player.ID] = true
	}
	gunNames := map[string]bool{}
	for _, equipment := range []common.EquipmentType{
		common.EqP2000, common.EqGlock, common.EqP250, common.EqDeagle, common.EqFiveSeven, common.EqDualBerettas, common.EqTec9, common.EqCZ, common.EqUSP, common.EqRevolver,
		common.EqMP7, common.EqMP9, common.EqBizon, common.EqMac10, common.EqUMP, common.EqP90, common.EqMP5,
		common.EqSawedOff, common.EqNova, common.EqMag7, common.EqXM1014, common.EqM249, common.EqNegev,
		common.EqGalil, common.EqFamas, common.EqAK47, common.EqM4A4, common.EqM4A1, common.EqSSG08, common.EqSG553, common.EqAUG, common.EqAWP, common.EqScar20, common.EqG3SG1,
	} {
		gunNames[equipment.String()] = true
	}
	for i, shot := range d.Shots {
		if !players[shot.PlayerID] || !gunNames[shot.Weapon] || (shot.Team != 2 && shot.Team != 3) {
			t.Fatalf("shot %d lacks valid shooter/weapon/team: %+v", i, shot)
		}
		if shot.T < 0 || shot.T > d.Duration || (i > 0 && shot.T < d.Shots[i-1].T) {
			t.Fatalf("shot %d lies outside the playback timeline: %+v", i, shot)
		}
		if shot.Round < 1 || shot.Round > len(d.Rounds) {
			t.Fatalf("shot %d references missing round %d", i, shot.Round)
		}
		round := d.Rounds[shot.Round-1]
		if shot.T < round.Start-.05 || shot.T > round.End+.05 {
			t.Fatalf("shot %d does not belong to its round: %+v; round=%+v", i, shot, round)
		}
		if math.IsNaN(shot.X) || math.IsNaN(shot.Y) || math.IsNaN(shot.Yaw) {
			t.Fatalf("shot %d contains nonfinite coordinates", i)
		}
	}
	loadouts, twoGuns, heldUtility, activeGuns, namedTeams, knownClocks := 0, 0, 0, 0, 0, 0
	for _, round := range d.Rounds {
		if round.TimeLimit > 0 {
			knownClocks++
		}
	}
	for _, frame := range d.Frames {
		if frame.CTName != "" || frame.TName != "" {
			namedTeams++
		}
		for _, player := range frame.Players {
			active, primary, secondary := 0, false, false
			for _, weapon := range player.Weapons {
				if weapon.Active {
					active++
					if weapon.Name != player.Weapon {
						t.Fatalf("active loadout item disagrees with active weapon: %+v", player)
					}
				}
				primary = primary || weapon.Slot == "primary"
				secondary = secondary || weapon.Slot == "secondary"
				if !gunNames[weapon.Name] && weapon.Name != common.EqZeus.String() {
					t.Fatalf("loadout contains an item that should be in grenade inventory: %+v", weapon)
				}
			}
			if active > 1 {
				t.Fatalf("multiple active weapons: %+v", player)
			}
			if len(player.Weapons) > 0 {
				loadouts++
			}
			if primary && secondary {
				twoGuns++
			}
			if player.Alive && gunNames[player.Weapon] && active == 1 {
				activeGuns++
			}
			if player.Alive && len(player.Weapons) > 0 && !gunNames[player.Weapon] && player.Weapon != common.EqZeus.String() && active == 0 {
				heldUtility++
			}
		}
	}
	if loadouts == 0 || twoGuns == 0 || activeGuns == 0 || heldUtility == 0 {
		t.Fatalf("missing real loadout states: carried=%d both=%d active=%d holding other=%d", loadouts, twoGuns, activeGuns, heldUtility)
	}
	for _, event := range d.Events {
		if event.Type == "shot" || event.Type == "weapon_fire" {
			t.Fatal("shot stream must not consume the important-event budget")
		}
	}
	if _, err := json.Marshal(d.Shots); err != nil {
		t.Fatal(err)
	}
	t.Logf("shots=%d, events=%d, loadout snapshots=%d, primary+secondary=%d, active firearms=%d, holding utility/knife=%d, team-name frames=%d, known round clocks=%d", len(d.Shots), len(d.Events), loadouts, twoGuns, activeGuns, heldUtility, namedTeams, knownClocks)
	t.Logf("first shot: t=%.2f, weapon=%s; first round limit=%d seconds", d.Shots[0].T, d.Shots[0].Weapon, d.Rounds[0].TimeLimit)
}
