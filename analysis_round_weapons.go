package main

import (
	"strings"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

type analysisRoundPlayer struct {
	round  int
	player string // Original replay identity, local to this demo.
}

type analysisFirearmChoice struct {
	name string
	rank int
}

type analysisCarriedGun struct {
	analysisFirearmChoice
	firstSeen float64
}

type analysisRoundWeapons struct {
	windows map[int]analysisRoundWindow
	best    map[analysisRoundPlayer]analysisCarriedGun
	byName  map[string]analysisFirearmChoice
}

func newAnalysisRoundWeapons(rounds []Round) *analysisRoundWeapons {
	w := &analysisRoundWeapons{
		windows: analysisWindows(rounds),
		best:    make(map[analysisRoundPlayer]analysisCarriedGun),
		byName:  make(map[string]analysisFirearmChoice),
	}
	unique := analysisTimingRounds(rounds)
	for n := range w.windows {
		if _, ok := unique[n]; !ok {
			delete(w.windows, n)
		}
	}
	for n, r := range unique {
		if r.Economy != nil && r.Economy.Source == "freeze_end" {
			w.observeFrame(Frame{Round: n, T: r.Economy.Time, Players: r.Economy.Players})
		}
	}
	return w
}

// Keep the statistics page's four firearm tiers. Subtiers distinguish an
// upgraded loadout from a starter pistol, budget rifle or light sniper.
// Equal choices prefer the first observed in the round.
func analysisFirearmPreference(raw string) analysisFirearmChoice {
	key := statisticsWeaponKey(raw)
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "weapon_m4a1": // Internal entity name of the unsilenced M4A4.
		key = "m4a4"
	case "weapon_m4a1_silencer_off", "m4a1_silencer_off":
		key = "m4a1"
	}
	gun, ok := statisticsGuns[key]
	if !ok {
		return analysisFirearmChoice{}
	}
	name := gun.kind.String()
	if gun.kind == common.EqM4A1 {
		name = "M4A1-S"
	}
	subtier := 0
	switch gun.kind {
	case common.EqDeagle, common.EqAWP, common.EqAK47, common.EqM4A1, common.EqM4A4, common.EqSG553, common.EqAUG:
		subtier = 2
	case common.EqP250, common.EqDualBerettas, common.EqCZ, common.EqTec9, common.EqFiveSeven, common.EqRevolver,
		common.EqFamas, common.EqGalil, common.EqScar20, common.EqG3SG1:
		subtier = 1
	}
	return analysisFirearmChoice{name, gun.rank*10 + subtier}
}

func (w *analysisRoundWeapons) inside(round int, t float64) bool {
	window, ok := w.windows[round]
	return ok && t >= window.start && t <= window.end
}

func (w *analysisRoundWeapons) record(round int, t float64, id, weapon string) {
	if id == "" || weapon == "" {
		return
	}
	choice, ok := w.byName[weapon]
	if !ok {
		choice = analysisFirearmPreference(weapon)
		w.byName[weapon] = choice
	}
	if choice.rank == 0 {
		return
	}
	key := analysisRoundPlayer{round, id}
	prev := w.best[key]
	if choice.rank > prev.rank || choice.rank == prev.rank && (t < prev.firstSeen || t == prev.firstSeen && choice.name < prev.name) {
		w.best[key] = analysisCarriedGun{choice, t}
	}
}

func (w *analysisRoundWeapons) observeFrame(frame Frame) {
	if !w.inside(frame.Round, frame.T) {
		return
	}
	for _, p := range frame.Players {
		if !p.Alive || !p.Connected || !analysisSide(p.Team) {
			continue
		}
		for _, gun := range p.Weapons {
			w.record(frame.Round, frame.T, p.ID, gun.Name)
		}
		w.record(frame.Round, frame.T, p.ID, p.Weapon)
	}
}

func (w *analysisRoundWeapons) observeShot(s Shot) {
	if w.inside(s.Round, s.T) && analysisSide(s.Team) {
		w.record(s.Round, s.T, s.PlayerID, s.Weapon)
	}
}

func (w *analysisRoundWeapons) observeDamage(e DamageEvent) {
	if w.inside(e.Round, e.T) && analysisSide(e.AttackerTeam) {
		w.record(e.Round, e.T, e.AttackerID, e.Weapon)
	}
}

func (w *analysisRoundWeapons) observeEvent(e Event) {
	if e.Type != "kill" || !w.inside(e.Round, e.T) {
		return
	}
	if analysisSide(e.KillerTeam) {
		w.record(e.Round, e.T, e.KillerID, e.Weapon)
	}
	if analysisSide(e.VictimTeam) && observedVictimWeapon(e) && w.inside(e.Round, e.VictimWeaponTime) {
		w.record(e.Round, e.VictimWeaponTime, e.VictimID, e.VictimWeapon)
	}
}

func (w *analysisRoundWeapons) name(round int, rawPlayerID string) string {
	return w.best[analysisRoundPlayer{round, rawPlayerID}].name
}
