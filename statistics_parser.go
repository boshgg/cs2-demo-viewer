package main

import (
	"sort"
	"strconv"

	demo "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

type activeWeaponObservation struct {
	weapon string
	round  int
	time   float64
}

// Only an observed active weapon is eligible; never substitute carried rifles
// when the victim was holding a knife or grenade. A stale/cross-round observation
// cannot establish what the victim held at death.
func chooseDeathWeapon(direct string, previous activeWeaponObservation, round int, now float64) (string, string, float64) {
	if direct != "" && direct != "Unknown" {
		return direct, "death_event", now
	}
	if previous.weapon != "" && previous.round == round && previous.time <= now && now-previous.time <= .25 {
		return previous.weapon, "previous_tick", previous.time
	}
	return "", "unavailable", now
}

func deathActiveWeapon(player *common.Player, previous activeWeaponObservation, round int, now float64) (string, string, float64) {
	direct := ""
	if player != nil && player.Entity != nil && player.PlayerPawnEntity() != nil {
		if weapon := player.ActiveWeapon(); weapon != nil {
			direct = weapon.String()
		}
	}
	return chooseDeathWeapon(direct, previous, round, now)
}

func statisticsRoundPhase(number int, convars map[string]string) (int, bool, string) {
	maxRounds, err := strconv.Atoi(convars["mp_maxrounds"])
	source := "convar"
	if err != nil || maxRounds < 2 || maxRounds > 100 || maxRounds%2 != 0 {
		maxRounds, source = 24, "default_mr12"
	}
	if number <= maxRounds/2 {
		return 1, number == 1, source
	}
	if number <= maxRounds {
		return 2, number == maxRounds/2+1, source
	}
	overtimeRounds, err := strconv.Atoi(convars["mp_overtime_maxrounds"])
	if err != nil || overtimeRounds < 2 || overtimeRounds > 100 || overtimeRounds%2 != 0 {
		overtimeRounds = 6
		source += "_overtime_mr3"
	}
	return 3 + (number-maxRounds-1)/(overtimeRounds/2), false, source
}

func captureEconomySnapshot(gs demo.GameState, round int, t float64) *EconomySnapshot {
	snapshot := &EconomySnapshot{Time: t, Source: "freeze_end", Players: []PlayerFrame{}}
	var convars map[string]string
	if rules := gs.Rules(); rules != nil {
		convars = rules.ConVars()
	}
	snapshot.Half, snapshot.Pistol, snapshot.HalfSource = statisticsRoundPhase(round, convars)
	if team := gs.TeamCounterTerrorists(); team != nil && team.Entity != nil && team.Entity.Property("m_szClanTeamname") != nil {
		snapshot.CTName = team.ClanName()
	}
	if team := gs.TeamTerrorists(); team != nil && team.Entity != nil && team.Entity.Property("m_szClanTeamname") != nil {
		snapshot.TName = team.ClanName()
	}
	counts := map[int]int{}
	for _, player := range gs.Participants().Playing() {
		if player == nil || player.Entity == nil || player.PlayerPawnEntity() == nil || !player.IsConnected || !player.IsAlive() || !analysisSide(int(player.Team)) {
			continue
		}
		active := ""
		if weapon := player.ActiveWeapon(); weapon != nil {
			active = weapon.String()
		}
		frame := PlayerFrame{ID: playerID(player), Team: int(player.Team), Connected: true, Alive: true, HP: player.Health(), Armor: player.Armor(), Money: player.Money(), Helmet: player.HasHelmet(), DefuseKit: player.HasDefuseKit(), Weapon: active, Weapons: playerWeapons(player), Inventory: playerGrenades(player)}
		snapshot.Players = append(snapshot.Players, frame)
		counts[frame.Team]++
	}
	snapshot.Complete = counts[2] == 5 && counts[3] == 5
	sort.Slice(snapshot.Players, func(i, j int) bool { return snapshot.Players[i].ID < snapshot.Players[j].ID })
	return snapshot
}
