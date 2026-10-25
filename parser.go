package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/golang/geo/r3"
	demo "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/msg"
)

const sampleRate = 16
const maxFrames = 120000
const maxShots = 200000

// Clock preserves elapsed time when a recording resets the server tick counter.
type timelineClock struct {
	initialized                   bool
	origin, lastRaw, last, offset float64
}

func (c *timelineClock) at(raw float64) float64 {
	if !c.initialized {
		c.initialized = true
		c.origin = raw
		c.lastRaw = raw
	}
	if raw < c.lastRaw-1 {
		c.offset += c.lastRaw - raw
	}
	t := math.Max(c.last, raw-c.origin+c.offset)
	c.lastRaw, c.last = raw, t
	return t
}
func rounded(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}
func playerID(p *common.Player) string {
	if p == nil {
		return ""
	}
	if p.SteamID64 != 0 {
		return strconv.FormatUint(p.SteamID64, 10)
	}
	return fmt.Sprintf("bot-%d", p.UserID)
}
func playerName(p *common.Player) string {
	if p == nil {
		return "环境"
	}
	return p.Name
}

type countedReader struct {
	r     io.Reader
	bytes atomic.Int64
}

func (r *countedReader) Read(p []byte) (int, error) {
	n, e := r.r.Read(p)
	r.bytes.Add(int64(n))
	return n, e
}

func parseDemo(ctx context.Context, path, id, name string, progress func(float64)) (result *DemoData, err error) {
	defer func() {
		if v := recover(); v != nil {
			result = nil
			err = fmt.Errorf("Demo 解析失败，文件可能损坏或游戏版本暂不兼容：%v", v)
		}
	}()
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	reader := &countedReader{r: f}
	cfg := demo.DefaultParserConfig
	cfg.MsgQueueBufferSize = 0 // bounded, deterministic event dispatch
	p := demo.NewParserWithConfig(reader, cfg)
	defer p.Close()
	d := &DemoData{ID: id, Name: name, SampleRate: sampleRate, Players: []PlayerInfo{}, Rounds: []Round{}, Frames: []Frame{}, Events: []Event{}, Shots: []Shot{}, Utilities: []Utility{}, Warnings: []string{}}
	players := map[string]PlayerInfo{}
	seenWarnings := map[string]bool{}
	warn := func(s string) {
		if !seenWarnings[s] && len(d.Warnings) < 12 {
			d.Warnings = append(d.Warnings, s)
			seenWarnings[s] = true
		}
	}
	clock := timelineClock{}
	pendingRound := false
	roundTimeLimit := 0
	bombState := "dropped"
	lastSample := -1.0
	limited := false
	p.RegisterNetMessageHandler(func(m *msg.CDemoFileHeader) {
		if m.GetMapName() != "" {
			d.Map = m.GetMapName()
		}
	})
	p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_ServerInfo) {
		if m.GetMapName() != "" {
			d.Map = m.GetMapName()
		}
	})
	now := func() float64 { return clock.at(p.CurrentTime().Seconds()) }
	currentRound := func() int {
		if len(d.Rounds) > 0 && !pendingRound {
			return d.Rounds[len(d.Rounds)-1].Number
		}
		n := p.GameState().TotalRoundsPlayed() + 1
		if len(d.Rounds) > 0 && n < d.Rounds[len(d.Rounds)-1].Number {
			n = d.Rounds[len(d.Rounds)-1].Number + 1
		}
		return n
	}
	addEvent := func(e Event) {
		if clock.initialized && !p.GameState().IsWarmupPeriod() && len(d.Events) < 50000 {
			e.T = rounded(now())
			e.Round = currentRound()
			d.Events = append(d.Events, e)
		}
	}
	utility := newUtilityTracker(d, now, currentRound, addEvent, func() bool { return clock.initialized && !p.GameState().IsWarmupPeriod() })
	p.RegisterEventHandler(func(e events.GrenadeProjectileThrow) { utility.projectile(e.Projectile, true) })
	p.RegisterEventHandler(func(e events.GrenadeProjectileBounce) { utility.bounce(e.Projectile) })
	p.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) { utility.destroy(e.Projectile) })
	p.RegisterEventHandler(func(e events.HeExplode) { utility.detonation(e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.FlashExplode) { utility.detonation(e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.SmokeStart) { utility.detonation(e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.DecoyStart) { utility.detonation(e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.SmokeExpired) { utility.expiry(e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.DecoyExpired) { utility.expiry(e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.InfernoStart) { utility.infernoStart(e.Inferno) })
	p.RegisterEventHandler(func(e events.InfernoExpired) { utility.infernoExpired(e.Inferno) })
	p.RegisterEventHandler(func(e events.ParserWarn) { warn("解析器提示：" + e.Message) })
	p.RegisterEventHandler(func(e events.POVRecordingPlayerDetected) {
		warn("这是个人视角（POV）Demo，未被该客户端记录的其他玩家位置可能不完整；全局复盘建议使用比赛服务器 Demo。")
	})
	p.RegisterEventHandler(func(e events.RoundStart) {
		pendingRound, bombState = true, "dropped"
		roundTimeLimit = max(0, e.TimeLimit)
	})
	p.RegisterEventHandler(func(e events.RoundFreezetimeEnd) {
		if clock.initialized && len(d.Rounds) > 0 && !p.GameState().IsWarmupPeriod() {
			d.Rounds[len(d.Rounds)-1].FreezeEnd = rounded(now())
		}
	})
	p.RegisterEventHandler(func(e events.RoundEnd) {
		if len(d.Rounds) > 0 && !p.GameState().IsWarmupPeriod() {
			r := &d.Rounds[len(d.Rounds)-1]
			r.Winner = int(e.Winner)
			r.Reason = e.Message
			r.EndedAt = rounded(now())
		}
		addEvent(Event{Type: "round_end", Text: e.Message})
	})
	p.RegisterEventHandler(func(e events.Kill) {
		weapon := ""
		if e.Weapon != nil {
			weapon = e.Weapon.String()
		}
		addEvent(Event{Type: "kill", Killer: playerName(e.Killer), Victim: playerName(e.Victim), KillerID: playerID(e.Killer), VictimID: playerID(e.Victim), Weapon: weapon, Headshot: e.IsHeadshot,
			Assister: optionalPlayerName(e.Assister), AssisterID: playerID(e.Assister), KillerTeam: playerTeam(e.Killer), VictimTeam: playerTeam(e.Victim),
			Penetrated: e.PenetratedObjects, NoScope: e.NoScope, ThroughSmoke: e.ThroughSmoke, AttackerBlind: e.AttackerBlind, AssistedFlash: e.AssistedFlash,
			KillerPos: playerPosition(e.Killer), VictimPos: playerPosition(e.Victim)})
	})
	p.RegisterEventHandler(func(e events.WeaponFire) {
		if !clock.initialized || p.GameState().IsWarmupPeriod() || e.Shooter == nil || e.Shooter.Entity == nil || e.Shooter.PlayerPawnEntity() == nil || e.Weapon == nil || !isFirearm(e.Weapon.Type) {
			return
		}
		if len(d.Shots) >= maxShots {
			warn("开火事件过多，仅保留前 200000 次开火；其后的开火特效将不再显示。")
			return
		}
		pos := e.Shooter.Position()
		d.Shots = append(d.Shots, Shot{T: rounded(now()), Round: currentRound(), PlayerID: playerID(e.Shooter), Team: int(e.Shooter.Team), Weapon: e.Weapon.String(), X: rounded(pos.X), Y: rounded(pos.Y), Z: rounded(pos.Z), Yaw: rounded(float64(e.Shooter.ViewDirectionX()))})
	})
	p.RegisterEventHandler(func(e events.BombPlanted) {
		bombState = "planted"
		addEvent(Event{Type: "bomb_planted", Text: "炸弹已安放", OwnerID: playerID(e.Player), Owner: optionalPlayerName(e.Player), Site: string(rune(e.Site))})
	})
	p.RegisterEventHandler(func(e events.BombDefused) {
		bombState = "defused"
		addEvent(Event{Type: "bomb_defused", Text: "炸弹已拆除"})
	})
	p.RegisterEventHandler(func(e events.BombExplode) {
		bombState = "exploded"
		addEvent(Event{Type: "bomb_exploded", Text: "炸弹爆炸"})
	})
	p.RegisterEventHandler(func(e events.FrameDone) {
		if ctx.Err() != nil {
			p.Cancel()
			return
		}
		if p.CurrentFrame()%256 == 0 {
			progress(math.Min(.94, float64(reader.bytes.Load())/float64(info.Size())*.94))
		}
		gs := p.GameState()
		if gs.IsWarmupPeriod() {
			return
		}
		playing := gs.Participants().Playing()
		if len(playing) == 0 || p.CurrentTime() < 0 {
			return
		}
		t := now()
		newRound := pendingRound || len(d.Rounds) == 0
		if !newRound && t-lastSample < 1.0/sampleRate-.0001 {
			return
		}
		if len(d.Frames) >= maxFrames {
			limited = true
			p.Cancel()
			return
		}
		frame := Frame{T: rounded(t), Players: make([]PlayerFrame, 0, len(playing)), Grenades: []Grenade{}}
		if team := gs.TeamCounterTerrorists(); team != nil && team.Entity != nil {
			frame.CTScore = team.Score()
			if team.Entity.Property("m_szClanTeamname") != nil {
				frame.CTName = team.ClanName()
			}
		}
		if team := gs.TeamTerrorists(); team != nil && team.Entity != nil {
			frame.TScore = team.Score()
			if team.Entity.Property("m_szClanTeamname") != nil {
				frame.TName = team.ClanName()
			}
		}
		b := gs.Bomb()
		for _, pl := range playing {
			if pl == nil || pl.Entity == nil || pl.PlayerPawnEntity() == nil {
				continue
			}
			pos := pl.Position()
			pid := playerID(pl)
			players[pid] = PlayerInfo{ID: pid, Name: pl.Name, Team: int(pl.Team)}
			weapon := ""
			ammo, reserve := 0, 0
			if w := pl.ActiveWeapon(); w != nil {
				weapon = w.String()
				ammo, reserve = w.AmmoInMagazine(), w.AmmoReserve()
			}
			frame.Players = append(frame.Players, PlayerFrame{ID: pid, X: rounded(pos.X), Y: rounded(pos.Y), Z: rounded(pos.Z), Yaw: rounded(float64(pl.ViewDirectionX())), HP: pl.Health(), Armor: pl.Armor(), Team: int(pl.Team), Alive: pl.IsAlive(), Weapon: weapon, HasBomb: b != nil && b.Carrier == pl, Connected: pl.IsConnected,
				Weapons: playerWeapons(pl), Inventory: playerGrenades(pl), Ammo: ammo, Reserve: reserve, Money: pl.Money(), Helmet: pl.HasHelmet(), DefuseKit: pl.HasDefuseKit(), Flash: rounded(pl.FlashDurationTimeRemaining().Seconds()), Scoped: pl.IsScoped(), Crouching: pl.IsDucking()})
		}
		if len(frame.Players) == 0 {
			return
		}
		if newRound {
			n := gs.TotalRoundsPlayed() + 1
			if len(d.Rounds) > 0 {
				prev := &d.Rounds[len(d.Rounds)-1]
				if n == prev.Number || t-prev.Start < .5 {
					if roundTimeLimit > 0 {
						prev.TimeLimit = roundTimeLimit
					}
					pendingRound = false
					newRound = false
				} else {
					prev.End = rounded(t)
					if n < prev.Number {
						n = prev.Number + 1
						warn("录像包含回合计数重置，后续回合按播放顺序编号。")
					}
				}
			}
			if newRound {
				d.Rounds = append(d.Rounds, Round{Number: n, Start: rounded(t), TimeLimit: roundTimeLimit})
			}
			pendingRound = false
		}
		frame.Round = d.Rounds[len(d.Rounds)-1].Number
		d.Rounds[len(d.Rounds)-1].CTScore = frame.CTScore
		d.Rounds[len(d.Rounds)-1].TScore = frame.TScore
		for _, g := range gs.GrenadeProjectiles() {
			if g == nil || g.Entity == nil {
				continue
			}
			pos := g.Position()
			typ := "grenade"
			if g.WeaponInstance != nil {
				typ = grenadeType(g.WeaponInstance.Type)
			}
			utility.projectile(g, false)
			frame.Grenades = append(frame.Grenades, Grenade{ID: strconv.FormatInt(g.UniqueID(), 10), Type: typ, X: rounded(pos.X), Y: rounded(pos.Y), Z: rounded(pos.Z), OwnerID: playerID(g.Thrower), Owner: optionalPlayerName(g.Thrower), Team: playerTeam(g.Thrower)})
		}
		for _, inf := range gs.Infernos() {
			utility.sampleFire(inf, false)
		}
		if b != nil {
			pos := b.Position()
			state := bombState
			if b.Carrier != nil {
				state = "carried"
			}
			if pos.X != 0 || pos.Y != 0 || pos.Z != 0 {
				frame.Bomb = &Bomb{X: rounded(pos.X), Y: rounded(pos.Y), Z: rounded(pos.Z), State: state}
			}
		}
		sort.Slice(frame.Players, func(i, j int) bool { return frame.Players[i].ID < frame.Players[j].ID })
		// Multiple events in one tick must not create zero-duration duplicate snapshots.
		if len(d.Frames) > 0 && frame.T <= d.Frames[len(d.Frames)-1].T {
			d.Frames[len(d.Frames)-1] = frame
		} else {
			d.Frames = append(d.Frames, frame)
		}
		lastSample = t
	})
	err = p.ParseToEnd()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if limited {
		return nil, fmt.Errorf("Demo 过长：超过 %d 个回放采样帧，请使用较短的比赛录像", maxFrames)
	}
	if err != nil {
		if len(d.Frames) > 1 && (errors.Is(err, demo.ErrUnexpectedEndOfDemo) || errors.Is(err, io.ErrUnexpectedEOF)) {
			warn("Demo 文件不完整：仅显示成功解析的部分，最后一回合可能缺失。")
		} else {
			return nil, fmt.Errorf("无法解析此 Demo（可能损坏或版本不兼容）：%w", err)
		}
	}
	if len(d.Frames) < 2 {
		return nil, fmt.Errorf("未找到可回放的比赛帧。请使用包含正式比赛的 CS2 .dem 文件")
	}
	d.Duration = d.Frames[len(d.Frames)-1].T
	end := rounded(clock.last)
	for _, e := range d.Events {
		if e.T > end {
			end = e.T
		}
	}
	if end > d.Duration {
		last := d.Frames[len(d.Frames)-1]
		last.Players = append([]PlayerFrame(nil), last.Players...)
		for _, e := range d.Events {
			if e.Type == "kill" && e.T > d.Duration {
				for i := range last.Players {
					if last.Players[i].ID == e.VictimID {
						last.Players[i].Alive = false
						last.Players[i].HP = 0
					}
				}
			}
		}
		last.T = end
		d.Frames = append(d.Frames, last)
		d.Duration = end
	}
	for i := range d.Rounds {
		if d.Rounds[i].End == 0 {
			d.Rounds[i].End = d.Duration
		}
		if d.Rounds[i].FreezeEnd < d.Rounds[i].Start || d.Rounds[i].FreezeEnd > d.Rounds[i].End {
			d.Rounds[i].FreezeEnd = d.Rounds[i].Start
		}
	}
	utility.finish()
	d.TickRate = p.TickRate()
	if d.TickRate <= 0 {
		d.TickRate = 64
		warn("录像未提供 Tick Rate，按 64 Tick 解释时间。")
	}
	d.Map = strings.TrimSuffix(strings.TrimPrefix(strings.ReplaceAll(d.Map, "\\", "/"), "maps/"), ".vpk")
	for _, pl := range players {
		d.Players = append(d.Players, pl)
	}
	sort.Slice(d.Players, func(i, j int) bool {
		if d.Players[i].Team != d.Players[j].Team {
			return d.Players[i].Team < d.Players[j].Team
		}
		return d.Players[i].ID < d.Players[j].ID
	})
	progress(.95)
	return d, nil
}

func grenadeType(t common.EquipmentType) string {
	switch t {
	case common.EqSmoke:
		return "smoke"
	case common.EqFlash:
		return "flash"
	case common.EqHE:
		return "he"
	case common.EqMolotov:
		return "molotov"
	case common.EqIncendiary:
		return "incendiary"
	case common.EqDecoy:
		return "decoy"
	default:
		return "grenade"
	}
}

func optionalPlayerName(p *common.Player) string {
	if p == nil {
		return ""
	}
	return p.Name
}
func playerTeam(p *common.Player) int {
	if p == nil {
		return 0
	}
	return int(p.Team)
}
func vectorPosition(v r3.Vector) Position {
	return Position{X: rounded(v.X), Y: rounded(v.Y), Z: rounded(v.Z)}
}
func playerPosition(p *common.Player) *Position {
	if p == nil || p.Entity == nil || p.PlayerPawnEntity() == nil {
		return nil
	}
	pos := vectorPosition(p.Position())
	return &pos
}

func isFirearm(typ common.EquipmentType) bool {
	switch typ.Class() {
	case common.EqClassPistols, common.EqClassSMG, common.EqClassHeavy, common.EqClassRifle:
		return true
	default:
		return false
	}
}

func playerWeapons(p *common.Player) []WeaponItem {
	items := make([]WeaponItem, 0, 3)
	if p == nil {
		return items
	}
	active := p.ActiveWeapon()
	seen := map[string]bool{}
	for _, weapon := range p.Inventory {
		if weapon == nil || (!isFirearm(weapon.Type) && weapon.Type != common.EqZeus) {
			continue
		}
		name := weapon.String()
		if seen[name] {
			continue
		}
		seen[name] = true
		slot := "primary"
		if weapon.Class() == common.EqClassPistols {
			slot = "secondary"
		} else if weapon.Type == common.EqZeus {
			slot = "equipment"
		}
		items = append(items, WeaponItem{Name: name, Slot: slot, Active: active != nil && active.Type == weapon.Type})
	}
	priority := map[string]int{"primary": 0, "secondary": 1, "equipment": 2}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Slot != items[j].Slot {
			return priority[items[i].Slot] < priority[items[j].Slot]
		}
		return items[i].Name < items[j].Name
	})
	return items
}

func playerGrenades(p *common.Player) []InventoryItem {
	counts := map[string]int{}
	for _, w := range p.Inventory {
		if w == nil || w.Class() != common.EqClassGrenade {
			continue
		}
		typ := grenadeType(w.Type)
		count := 1
		if w.Type == common.EqFlash {
			count = int(p.FlashbangCount())
			if count == 0 {
				count = 1
			}
		}
		if count > counts[typ] {
			counts[typ] = count
		}
	}
	items := make([]InventoryItem, 0, len(counts))
	for _, typ := range []string{"smoke", "flash", "he", "molotov", "incendiary", "decoy", "grenade"} {
		if count := counts[typ]; count > 0 {
			items = append(items, InventoryItem{Type: typ, Count: count})
		}
	}
	return items
}

type utilityTracker struct {
	d           *DemoData
	now         func() float64
	round       func() int
	emit        func(Event)
	active      func() bool
	projectiles map[int64]int
	entities    map[int]int
	infernos    map[int64]int
}

func newUtilityTracker(d *DemoData, now func() float64, round func() int, emit func(Event), active func() bool) *utilityTracker {
	return &utilityTracker{d: d, now: now, round: round, emit: emit, active: active, projectiles: map[int64]int{}, entities: map[int]int{}, infernos: map[int64]int{}}
}

func (s *utilityTracker) create(id, typ string, owner *common.Player, pos r3.Vector) int {
	t := rounded(s.now())
	u := Utility{ID: id, Type: typ, OwnerID: playerID(owner), Owner: optionalPlayerName(owner), Team: playerTeam(owner), Round: s.round(), Start: t, End: t, X: rounded(pos.X), Y: rounded(pos.Y), Z: rounded(pos.Z), Path: []UtilityPoint{}}
	s.d.Utilities = append(s.d.Utilities, u)
	return len(s.d.Utilities) - 1
}

func (s *utilityTracker) appendPoint(idx int, pos r3.Vector, bounce, force bool) {
	u := &s.d.Utilities[idx]
	if u.Detonated {
		return
	}
	t := rounded(s.now())
	point := UtilityPoint{T: t, X: rounded(pos.X), Y: rounded(pos.Y), Z: rounded(pos.Z), Bounce: bounce}
	if len(u.Path) > 0 {
		last := &u.Path[len(u.Path)-1]
		if t <= last.T {
			point.Bounce = point.Bounce || last.Bounce
			*last = point
			return
		}
		// Sample flight at 16 Hz, retaining genuine bounce events between snapshots.
		if !force && !bounce && t-last.T < 1.0/sampleRate-.01 {
			return
		}
	}
	if len(u.Path) < 4096 {
		u.Path = append(u.Path, point)
	}
	u.End = t
	u.X, u.Y, u.Z = point.X, point.Y, point.Z
}

func (s *utilityTracker) projectile(g *common.GrenadeProjectile, thrown bool) int {
	if !s.active() || g == nil || g.Entity == nil {
		return -1
	}
	idx, exists := s.projectiles[g.UniqueID()]
	if !exists {
		if len(s.d.Utilities) >= 20000 {
			return -1
		}
		typ := "grenade"
		if g.WeaponInstance != nil {
			typ = grenadeType(g.WeaponInstance.Type)
		}
		idx = s.create(strconv.FormatInt(g.UniqueID(), 10), typ, g.Thrower, g.Position())
		s.projectiles[g.UniqueID()] = idx
		s.entities[g.Entity.ID()] = idx
	}
	u := &s.d.Utilities[idx]
	if u.Type == "grenade" && g.WeaponInstance != nil {
		u.Type = grenadeType(g.WeaponInstance.Type)
	}
	if u.OwnerID == "" && g.Thrower != nil {
		u.OwnerID, u.Owner, u.Team = playerID(g.Thrower), g.Thrower.Name, int(g.Thrower.Team)
	}
	if thrown && !u.ThrowObserved {
		u.ThrowObserved = true
		s.emit(Event{Type: "utility_throw", UtilityID: u.ID, Weapon: u.Type, OwnerID: u.OwnerID, Owner: u.Owner, Team: u.Team})
	}
	s.appendPoint(idx, g.Position(), false, false)
	return idx
}

func (s *utilityTracker) bounce(g *common.GrenadeProjectile) {
	if idx := s.projectile(g, false); idx >= 0 {
		s.appendPoint(idx, g.Position(), true, true)
	}
}

func (s *utilityTracker) destroy(g *common.GrenadeProjectile) {
	if idx := s.projectile(g, false); idx >= 0 {
		u := &s.d.Utilities[idx]
		if !u.Detonated {
			s.appendPoint(idx, g.Position(), false, true)
			u.End = rounded(s.now())
			u.EndObserved = true
		}
	}
}

func (s *utilityTracker) detonation(e events.GrenadeEvent) {
	if !s.active() {
		return
	}
	typ := grenadeType(e.GrenadeType)
	idx, exists := s.entities[e.GrenadeEntityID]
	if exists && s.d.Utilities[idx].Type == "grenade" {
		s.d.Utilities[idx].Type = typ
	}
	if exists && (s.d.Utilities[idx].Round != s.round() || s.d.Utilities[idx].Type != typ) {
		exists = false
	}
	if !exists {
		// Some POV/partial demos begin after the throw. Keep the observed impact without inventing a flight.
		idx = s.create(fmt.Sprintf("effect-%d-%d", e.GrenadeEntityID, len(s.d.Utilities)), typ, e.Thrower, e.Position)
		s.entities[e.GrenadeEntityID] = idx
	}
	s.detonate(idx, e.Position)
}

func (s *utilityTracker) detonate(idx int, pos r3.Vector) {
	u := &s.d.Utilities[idx]
	if u.Detonated {
		return
	}
	s.appendPoint(idx, pos, false, true)
	u.Detonate = rounded(s.now())
	u.Detonated = true
	u.X, u.Y, u.Z = rounded(pos.X), rounded(pos.Y), rounded(pos.Z)
	u.EndObserved = false
	// Instantaneous HE/flash pops get a brief visual cue. Persistent effects are
	// closed by actual expiry events; defaults only cover truncated/partial demos.
	tail := .8
	switch u.Type {
	case "smoke":
		tail = 20
	case "decoy":
		tail = 15
	case "molotov", "incendiary", "fire":
		tail = 7
	}
	u.End, u.Approx = rounded(u.Detonate+tail), true
	s.emit(Event{Type: "utility_detonate", UtilityID: u.ID, Weapon: u.Type, OwnerID: u.OwnerID, Owner: u.Owner, Team: u.Team})
}

func (s *utilityTracker) expiry(e events.GrenadeEvent) {
	if !s.active() {
		return
	}
	if idx, ok := s.entities[e.GrenadeEntityID]; ok {
		u := &s.d.Utilities[idx]
		if u.Detonated && u.Type == grenadeType(e.GrenadeType) {
			u.End, u.EndObserved, u.Approx = rounded(s.now()), true, false
		}
	}
}

func (s *utilityTracker) infernoStart(inf *common.Inferno) {
	if !s.active() || inf == nil || inf.Entity == nil {
		return
	}
	if _, ok := s.infernos[inf.UniqueID()]; ok {
		return
	}
	pos, owner := inf.Entity.Position(), inf.Thrower()
	best, distance := -1, 256.0*256.0
	t := rounded(s.now())
	for i := len(s.d.Utilities) - 1; i >= 0; i-- {
		u := &s.d.Utilities[i]
		if u.Round != s.round() || u.Detonated || (u.Type != "molotov" && u.Type != "incendiary" && u.Type != "grenade") || t-u.End > 2 {
			continue
		}
		if owner != nil && u.OwnerID != playerID(owner) {
			continue
		}
		dx, dy, dz := u.X-pos.X, u.Y-pos.Y, u.Z-pos.Z
		if d := dx*dx + dy*dy + dz*dz; d < distance {
			best, distance = i, d
		}
	}
	if best < 0 {
		// Inferno entities do not encode whether the source was a molotov or incendiary.
		best = s.create("fire-"+strconv.FormatInt(inf.UniqueID(), 10), "fire", owner, pos)
	} else if owner == nil {
		s.d.Utilities[best].SourceInferred = true
	}
	if s.d.Utilities[best].Type == "grenade" {
		s.d.Utilities[best].Type = "fire"
	}
	s.infernos[inf.UniqueID()] = best
	s.detonate(best, pos)
	s.sampleFire(inf, true)
}

func (s *utilityTracker) sampleFire(inf *common.Inferno, force bool) {
	if !s.active() || inf == nil || inf.Entity == nil {
		return
	}
	idx, exists := s.infernos[inf.UniqueID()]
	if !exists {
		s.infernoStart(inf)
		return
	}
	u := &s.d.Utilities[idx]
	if u.Round != s.round() || (u.BurnObserved && u.EndObserved) {
		return
	}
	t := rounded(s.now())
	points := make([]Position, 0)
	for _, f := range inf.Fires().Active().List() {
		points = append(points, vectorPosition(f.Vector))
	}
	recordFireState(u, t, points, force)
}

// Inferno entities can remain alive for about 20 seconds, long after their fire
// cells have stopped burning. Inspect every replay snapshot for transitions;
// only the geometry stream is throttled to 4 Hz.
func recordFireState(u *Utility, t float64, points []Position, force bool) {
	if u.BurnObserved && u.EndObserved {
		return
	}
	if len(points) > 0 && !u.BurnObserved {
		u.BurnObserved, u.BurnStart, force = true, t, true
	}
	if len(points) == 0 && u.BurnObserved {
		u.End, u.EndObserved, u.Approx, force = t, true, false, true
	}
	if !force && len(u.FireFrames) > 0 && t-u.FireFrames[len(u.FireFrames)-1].T < .25-.01 {
		return
	}
	frame := FireFrame{T: t, Points: points}
	if len(u.FireFrames) > 0 && u.FireFrames[len(u.FireFrames)-1].T == t {
		u.FireFrames[len(u.FireFrames)-1] = frame
	} else if len(u.FireFrames) < 256 {
		u.FireFrames = append(u.FireFrames, frame)
	}
}

func (s *utilityTracker) infernoExpired(inf *common.Inferno) {
	if !s.active() || inf == nil {
		return
	}
	if idx, ok := s.infernos[inf.UniqueID()]; ok {
		u := &s.d.Utilities[idx]
		if u.EndObserved {
			return
		}
		if u.BurnObserved {
			// Destruction also ends any cells still burning (e.g. round cleanup).
			recordFireState(u, rounded(s.now()), []Position{}, true)
		} else {
			// An immediately extinguished fire can exist as an empty entity. It
			// has no observed burning lifetime to display or count down.
			u.End, u.Approx = u.Detonate, false
		}
	}
}

func (s *utilityTracker) finish() {
	// CS2 can leave entities from warmup in the first server snapshot and remove
	// them on the very next tick. Do not present those empty/unknown remnants as
	// grenades thrown in the first competitive round.
	discard := map[string]bool{}
	for i := range s.d.Utilities {
		u := &s.d.Utilities[i]
		if u.Start == 0 && u.End < .1 {
			activeFire := false
			for _, f := range u.FireFrames {
				activeFire = activeFire || len(f.Points) > 0
			}
			if (u.Type == "grenade" && !u.Detonated) || (u.Type == "fire" && !activeFire) {
				discard[u.ID] = true
			}
		}
		end := s.d.Duration
		for _, r := range s.d.Rounds {
			if r.Number == u.Round {
				end = r.End
				break
			}
		}
		u.End = math.Min(math.Max(u.Start, u.End), end)
		if u.Detonated && u.Detonate > u.End {
			u.Detonate = u.End
		}
		for len(u.Path) > 0 && u.Path[len(u.Path)-1].T > u.End {
			u.Path = u.Path[:len(u.Path)-1]
		}
		for len(u.FireFrames) > 0 && u.FireFrames[len(u.FireFrames)-1].T > u.End {
			u.FireFrames = u.FireFrames[:len(u.FireFrames)-1]
		}
	}
	if len(discard) > 0 {
		kept := s.d.Utilities[:0]
		for _, u := range s.d.Utilities {
			if !discard[u.ID] {
				kept = append(kept, u)
			}
		}
		s.d.Utilities = kept
		keptEvents := s.d.Events[:0]
		for _, e := range s.d.Events {
			if !discard[e.UtilityID] {
				keptEvents = append(keptEvents, e)
			}
		}
		s.d.Events = keptEvents
	}
}
