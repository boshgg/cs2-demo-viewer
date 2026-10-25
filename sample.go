package main

import (
	"fmt"
	"math"
	"sort"
)

// Synthetic fixture: explicitly labeled in both the API and the interface.
// Its paths and effects exercise the viewer; they are not a recorded match.
func sampleDemo() *DemoData {
	d := &DemoData{ID: "sample", Name: "交互示例 · 非真实比赛", Map: "de_mirage", TickRate: 64, Duration: 105, SampleRate: 12, Synthetic: true, Players: []PlayerInfo{}, Rounds: []Round{}, Frames: []Frame{}, Events: []Event{}, Shots: []Shot{}, Utilities: []Utility{}, Warnings: []string{"这是人工生成的交互示例，玩家路线、道具轨迹、开火和火焰位置均为演示数据。"}}
	for i := 0; i < 10; i++ {
		team := 2
		if i >= 5 {
			team = 3
		}
		d.Players = append(d.Players, PlayerInfo{ID: fmt.Sprint(i), Name: fmt.Sprintf("示例 %s %d", map[int]string{2: "T", 3: "CT"}[team], i%5+1), Team: team})
	}
	for r := 0; r < 3; r++ {
		base := float64(r * 35)
		winner, attackingOffset, victimOffset := 2, 0, 5
		if r == 1 {
			winner, attackingOffset, victimOffset = 3, 5, 0
		}
		ctScore, tScore := 0, 1
		if r >= 1 {
			ctScore = 1
		}
		if r >= 2 {
			tScore = 2
		}
		d.Rounds = append(d.Rounds, Round{Number: r + 1, Start: base, End: base + 35, FreezeEnd: base + 3, EndedAt: base + 32, Winner: winner, Reason: "交互示例", CTScore: ctScore, TScore: tScore, TimeLimit: 32})
		for k := 0; k < 5; k++ {
			phase := float64(15 + k*4)
			killer, victim := d.Players[attackingOffset+k], d.Players[victimOffset+k]
			kp, vp := samplePlayerPosition(attackingOffset+k, phase), samplePlayerPosition(victimOffset+k, phase)
			event := Event{T: base + phase, Round: r + 1, Type: "kill", Killer: killer.Name, Victim: victim.Name, KillerID: killer.ID, VictimID: victim.ID, KillerTeam: killer.Team, VictimTeam: victim.Team, Weapon: sampleWeapon(attackingOffset + k), Headshot: k%2 == 0, KillerPos: &kp, VictimPos: &vp}
			for burst := 0; burst < 3; burst++ {
				shotTime := phase - float64(2-burst)*.09
				shotPos := samplePlayerPosition(attackingOffset+k, shotTime)
				d.Shots = append(d.Shots, Shot{T: rounded(base + shotTime), Round: r + 1, PlayerID: killer.ID, Team: killer.Team, Weapon: event.Weapon, X: shotPos.X, Y: shotPos.Y, Z: shotPos.Z, Yaw: rounded(-(float64(attackingOffset+k)*.59 + shotTime*.045) * 180 / math.Pi)})
			}
			if k == 0 {
				assister := d.Players[attackingOffset+2]
				event.Assister, event.AssisterID, event.AssistedFlash = assister.Name, assister.ID, true
			}
			event.ThroughSmoke = k == 2
			if k == 3 {
				event.Penetrated = 1
			}
			d.Events = append(d.Events, event)
		}
		d.Events = append(d.Events, Event{T: base + 20, Round: r + 1, Type: "bomb_planted", Owner: d.Players[4].Name, OwnerID: d.Players[4].ID, Team: 2, Site: "A", Text: "炸弹已安放"}, Event{T: base + 32, Round: r + 1, Type: "round_end", Text: "示例回合结束"})
		if r == 1 {
			d.Events = append(d.Events, Event{T: base + 32, Round: r + 1, Type: "bomb_defused", Text: "炸弹已拆除"})
		}
		// Smoke reaches the molotov at 11 seconds, ending fire immediately.
		// This also exercises effect removal and seeking backwards.
		fixtures := []struct {
			kind                 string
			owner                int
			start, detonate, end float64
			impact               Position
		}{
			{"molotov", 1, 5, 7, 11, Position{X: -590, Y: -650, Z: 0}},
			{"smoke", 0, 8, 11, 29, Position{X: -590, Y: -650, Z: 0}},
			{"flash", 2, 13, 14.5, 15.7, Position{X: -1190, Y: -800, Z: 95}},
			{"he", 3, 18, 20, 21.1, Position{X: -900, Y: -1300, Z: 0}},
			{"decoy", 4, 22, 24, 34, Position{X: -300, Y: -1150, Z: 0}},
		}
		for n, fixture := range fixtures {
			ownerIndex := attackingOffset + fixture.owner
			owner := d.Players[ownerIndex]
			startPos := samplePlayerPosition(ownerIndex, fixture.start)
			u := Utility{ID: fmt.Sprintf("sample-r%d-%s", r+1, fixture.kind), Type: fixture.kind, OwnerID: owner.ID, Owner: owner.Name, Team: owner.Team, Round: r + 1, Start: base + fixture.start, Detonate: base + fixture.detonate, End: base + fixture.end, Detonated: true, EndObserved: true, ThrowObserved: true, X: fixture.impact.X, Y: fixture.impact.Y, Z: fixture.impact.Z, Path: []UtilityPoint{}}
			for step := 0; step <= 16; step++ {
				fraction := float64(step) / 16
				p := UtilityPoint{T: rounded(u.Start + (u.Detonate-u.Start)*fraction), X: rounded(startPos.X + (u.X-startPos.X)*fraction), Y: rounded(startPos.Y + (u.Y-startPos.Y)*fraction + math.Sin(fraction*math.Pi)*float64(35+n*12)), Z: rounded(60*(1-fraction) + u.Z*fraction + 180*math.Sin(fraction*math.Pi)), Bounce: step == 12 && fixture.kind != "flash"}
				u.Path = append(u.Path, p)
			}
			if fixture.kind == "molotov" {
				for s := u.Detonate; s < u.End; s += .5 {
					fire := FireFrame{T: s, Points: []Position{{X: u.X, Y: u.Y, Z: u.Z}}}
					count := 3 + int(math.Min(6, (s-u.Detonate)*3))
					for j := 0; j < count; j++ {
						angle := float64(j) * math.Pi * 2 / float64(count)
						fire.Points = append(fire.Points, Position{X: rounded(u.X + math.Cos(angle)*78), Y: rounded(u.Y + math.Sin(angle)*62), Z: u.Z})
					}
					u.FireFrames = append(u.FireFrames, fire)
				}
			}
			d.Utilities = append(d.Utilities, u)
			d.Events = append(d.Events, Event{T: u.Start, Round: u.Round, Type: "utility_throw", UtilityID: u.ID, OwnerID: u.OwnerID, Owner: u.Owner, Team: u.Team, Weapon: u.Type}, Event{T: u.Detonate, Round: u.Round, Type: "utility_detonate", UtilityID: u.ID, OwnerID: u.OwnerID, Owner: u.Owner, Team: u.Team, Weapon: u.Type})
		}
	}
	for tick := 0; tick <= 105*12; tick++ {
		t := float64(tick) / 12
		r := int(t / 35)
		if r > 2 {
			r = 2
		}
		phase := t - float64(r*35)
		f := Frame{T: rounded(t), Round: r + 1, CTName: "示例 CT", TName: "示例 T", Players: []PlayerFrame{}, Grenades: []Grenade{}}
		if r >= 1 {
			f.TScore = 1
		}
		if r >= 2 {
			f.CTScore = 1
		}
		if phase >= 32 {
			if r == 1 {
				f.CTScore++
			} else {
				f.TScore++
			}
		}
		for i, info := range d.Players {
			victim := (r == 1 && i < 5) || (r != 1 && i >= 5)
			deathTime := float64(15 + (i%5)*4)
			alive := !victim || phase < deathTime
			positionPhase := phase
			hp := 100
			if !alive {
				hp = 0
				positionPhase = deathTime
			}
			p := samplePlayerPosition(i, positionPhase)
			weapon := sampleWeapon(i)
			sidearm := "Glock-18"
			if info.Team == 3 {
				sidearm = "USP-S"
			}
			weapons := []WeaponItem{{Name: weapon, Slot: "primary", Active: true}, {Name: sidearm, Slot: "secondary", Active: false}}
			if !alive {
				weapons = []WeaponItem{}
			}
			inventory := []InventoryItem{}
			for _, u := range d.Utilities {
				if u.Round == r+1 && u.OwnerID == info.ID && t < u.Start {
					inventory = append(inventory, InventoryItem{Type: u.Type, Count: 1})
				}
			}
			flash := 0.0
			if victim && i%5 < 2 && phase >= 14.5 && phase < 17 {
				flash = rounded(17 - phase)
			}
			f.Players = append(f.Players, PlayerFrame{ID: info.ID, X: p.X, Y: p.Y, Z: p.Z, Yaw: rounded(-(float64(i)*.59 + positionPhase*.045) * 180 / math.Pi), HP: hp, Armor: 100, Team: info.Team, Alive: alive, Connected: true, Weapon: weapon, Weapons: weapons, HasBomb: i == 4 && phase < 20, Inventory: inventory, Ammo: 30 - int(math.Max(0, phase-15))%23, Reserve: 90, Money: 850 + (i%5)*750, Helmet: true, DefuseKit: info.Team == 3 && i%2 == 0, Flash: flash, Crouching: alive && i%3 == 1 && phase >= 9 && phase < 13})
		}
		for _, u := range d.Utilities {
			if u.Round != r+1 || t < u.Start || t >= u.Detonate {
				continue
			}
			for j := 1; j < len(u.Path); j++ {
				before, after := u.Path[j-1], u.Path[j]
				if t > after.T {
					continue
				}
				fraction := math.Max(0, math.Min(1, (t-before.T)/(after.T-before.T)))
				f.Grenades = append(f.Grenades, Grenade{ID: u.ID, Type: u.Type, OwnerID: u.OwnerID, Owner: u.Owner, Team: u.Team, X: rounded(before.X + (after.X-before.X)*fraction), Y: rounded(before.Y + (after.Y-before.Y)*fraction), Z: rounded(before.Z + (after.Z-before.Z)*fraction)})
				break
			}
		}
		b := f.Players[4]
		f.Bomb = &Bomb{X: b.X, Y: b.Y, Z: 0, State: "carried"}
		if phase >= 20 {
			f.Bomb = &Bomb{X: -500, Y: -600, Z: 0, State: "planted"}
			if r == 1 && phase >= 32 {
				f.Bomb.State = "defused"
			}
		}
		d.Frames = append(d.Frames, f)
	}
	sort.SliceStable(d.Events, func(i, j int) bool { return d.Events[i].T < d.Events[j].T })
	sort.SliceStable(d.Utilities, func(i, j int) bool { return d.Utilities[i].Start < d.Utilities[j].Start })
	return d
}

func sampleWeapon(player int) string {
	return []string{"AK-47", "AWP", "SG 553", "MAC-10", "AK-47", "M4A1", "AWP", "AUG", "MP9", "M4A4"}[player%10]
}

func samplePlayerPosition(player int, phase float64) Position {
	a := float64(player)*.59 + phase*.045
	px := 490 + math.Cos(a)*(190+float64(player%3)*40)
	py := 490 + math.Sin(a)*(210+float64(player%2)*50)
	return Position{X: rounded(-3230 + px*5), Y: rounded(1713 - py*5), Z: 0}
}
