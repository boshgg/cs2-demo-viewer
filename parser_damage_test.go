package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/golang/geo/r3"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	st "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/sendtables"
)

// Only the entity surfaces used for observed positions are supplied. Unexpected
// entity accesses fail through the nil embedded interface instead of producing
// fabricated property defaults.
type damageTestEntity struct {
	st.Entity
	pos        r3.Vector
	controller bool
}

func (e *damageTestEntity) Position() r3.Vector { return e.pos }
func (e *damageTestEntity) PropertyValue(name string) (st.PropertyValue, bool) {
	if e.controller && (name == "m_hPawn" || name == "m_hPlayerPawn") {
		return st.PropertyValue{Any: uint64(1)}, true
	}
	return st.PropertyValue{}, false
}

type damageTestProvider struct{ pawn st.Entity }

func (damageTestProvider) IngameTick() int                          { return 0 }
func (damageTestProvider) TickRate() float64                        { return 64 }
func (damageTestProvider) FindPlayerByHandle(uint64) *common.Player { return nil }
func (damageTestProvider) FindPlayerByPawnHandle(uint64) *common.Player {
	return nil
}
func (damageTestProvider) FindWeaponByEntityID(int) *common.Equipment { return nil }
func (p damageTestProvider) FindEntityByHandle(uint64) st.Entity      { return p.pawn }

func damageTestPlayer(id uint64, team common.Team, pos r3.Vector) (*common.Player, *damageTestEntity) {
	pawn := &damageTestEntity{pos: pos}
	player := common.NewPlayer(damageTestProvider{pawn: pawn})
	player.SteamID64, player.Team = id, team
	player.Entity = &damageTestEntity{controller: true}
	return player, pawn
}

func TestDamageCapturesObservedParticipantsWithoutOverdamage(t *testing.T) {
	attacker, attackerPawn := damageTestPlayer(76561198000000001, common.TeamTerrorists, r3.Vector{X: -125.25, Y: 700.125, Z: 64})
	victim, victimPawn := damageTestPlayer(76561198000000002, common.TeamCounterTerrorists, r3.Vector{X: 512.75, Y: -845.5, Z: -512})
	e, ok := damageFromEvent(events.PlayerHurt{Player: victim, Attacker: attacker, Weapon: common.NewEquipment(common.EqM4A1), WeaponString: "m4a1", HealthDamage: 150, HealthDamageTaken: 5}, 12.345, 3)
	if !ok || e.T != 12.35 || e.Round != 3 || e.Damage != 5 {
		t.Fatalf("event lost its observed time/round/actual damage: %+v", e)
	}
	if e.AttackerID != "76561198000000001" || e.VictimID != "76561198000000002" || e.AttackerTeam != 2 || e.VictimTeam != 3 || e.Weapon != common.EqM4A1.String() {
		t.Fatalf("event lost participant or resolved weapon identity: %+v", e)
	}
	if e.AttackerPos == nil || *e.AttackerPos != (Position{X: -125.25, Y: 700.13, Z: 64}) || e.VictimPos == nil || *e.VictimPos != (Position{X: 512.75, Y: -845.5, Z: -512}) {
		t.Fatalf("event positions do not match the actual pawns: %+v", e)
	}
	attackerPawn.pos.X, victimPawn.pos.X = 999, 888
	if e.AttackerPos.X == 999 || e.VictimPos.X == 888 {
		t.Fatal("later movement changed a past damage position")
	}
}

func TestDamageKeepsWorldAttackerAndMissingPositionsUnknown(t *testing.T) {
	victim := &common.Player{SteamID64: 76561198000000002, Team: common.TeamCounterTerrorists}
	e, ok := damageFromEvent(events.PlayerHurt{Player: victim, HealthDamageTaken: 10, WeaponString: "world"}, 1, 1)
	if !ok || e.AttackerID != "" || e.AttackerTeam != 0 || e.AttackerPos != nil || e.VictimPos != nil || e.Weapon != "world" {
		t.Fatalf("world damage or absent pawn turned into invented participation: %+v", e)
	}
	if _, err := json.Marshal(e); err != nil {
		t.Fatal(err)
	}
	if _, ok := damageFromEvent(events.PlayerHurt{HealthDamageTaken: 10}, 1, 1); ok {
		t.Fatal("damage with no identified victim must not be emitted")
	}
}

func TestDamageRetainsArmorOnlyHitsAndRejectsInvalidCoordinates(t *testing.T) {
	victim, pawn := damageTestPlayer(76561198000000002, common.TeamCounterTerrorists, r3.Vector{X: math.NaN(), Y: 12, Z: 3})
	hurt := events.PlayerHurt{Player: victim, Weapon: common.NewEquipment(common.EqGlock), ArmorDamageTaken: 1}
	e, ok := damageFromEvent(hurt, 1, 1)
	if !ok || e.Damage != 0 || e.VictimPos != nil {
		t.Fatalf("armor-only participation or missing position was corrupted: %+v", e)
	}
	pawn.pos = r3.Vector{}
	e, ok = damageFromEvent(hurt, 1, 1)
	if !ok || e.VictimPos == nil || *e.VictimPos != (Position{}) {
		t.Fatal("a genuinely observed zero coordinate must stay distinct from a missing position")
	}
	for _, tm := range []float64{math.NaN(), math.Inf(1), -1} {
		if _, ok := damageFromEvent(hurt, tm, 1); ok {
			t.Fatalf("invalid event time accepted: %v", tm)
		}
	}
}

func TestRealDemoDamage(t *testing.T) {
	path := os.Getenv("CS2_TEST_DEMO")
	if path == "" {
		t.Skip("set CS2_TEST_DEMO to a real CS2 demo")
	}
	d, err := parseDemo(context.Background(), path, "damage-fixture", "fixture.dem", func(float64) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Damage) < 10 {
		t.Fatalf("too few actual damage events: %d", len(d.Damage))
	}
	rounds := map[int]Round{}
	for _, r := range d.Rounds {
		rounds[r.Number] = r
	}
	opponentWithPositions := 0
	for i, hurt := range d.Damage {
		r, ok := rounds[hurt.Round]
		if !ok || hurt.T < r.Start-.05 || hurt.T > r.End+.05 || hurt.T < 0 || hurt.T > d.Duration || hurt.Damage < 0 {
			t.Fatalf("damage %d lies outside its observed timeline: %+v; round=%+v", i, hurt, r)
		}
		if i > 0 && hurt.T < d.Damage[i-1].T {
			t.Fatal("damage events out of order")
		}
		if hurt.AttackerID != "" && hurt.AttackerTeam+hurt.VictimTeam == 5 && hurt.AttackerPos != nil && hurt.VictimPos != nil {
			opponentWithPositions++
		}
	}
	if opponentWithPositions == 0 {
		t.Fatal("no enemy damage event has both observed positions")
	}
	if _, err := json.Marshal(d.Damage); err != nil {
		t.Fatal(err)
	}
	t.Logf("actual damage events=%d; opponent events with both positions=%d", len(d.Damage), opponentWithPositions)
}
