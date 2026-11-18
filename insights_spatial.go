package main

import (
	"cmp"
	"context"
	"maps"
	"math"
	"slices"
	"sort"
	"strings"
)

const spatialCellSize = 384
const spatialHeight = 128

type insightsSpatial struct {
	CellSize  int               `json:"cellSize"`
	Height    int               `json:"height"`
	Method    string            `json:"method"`
	Coverage  []spatialCoverage `json:"coverage"`
	Groups    []spatialGroup    `json:"groups"`
	Landmarks []spatialLandmark `json:"landmarks"`
}

type spatialCoverage struct {
	DemoID            string `json:"demoId"`
	Rounds            int    `json:"validRounds"`
	Timed             int    `json:"timedRounds"`
	DamageRecorded    bool   `json:"damageFieldPresent"`
	FramesRecorded    bool   `json:"framesFieldPresent"`
	EventsRecorded    bool   `json:"eventsFieldPresent"`
	ShotsRecorded     bool   `json:"shotsFieldPresent"`
	UtilitiesRecorded bool   `json:"utilitiesFieldPresent"`
}
type spatialLandmark struct {
	Map    string  `json:"map"`
	Site   string  `json:"site"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
	Plants int     `json:"plants"`
}

type spatialGroup struct {
	Map          string           `json:"map"`
	TeamID       string           `json:"teamId"`
	TeamName     string           `json:"teamName"`
	Side         int              `json:"side"`
	Phase        string           `json:"phase"`
	DemoIDs      []string         `json:"demoIds"`
	Rounds       int              `json:"rounds"`
	CellCount    int              `json:"cellCount"`
	Totals       [6]float64       `json:"totals"`
	Cells        [][10]float64    `json:"cells"`
	Moves        [][7]int         `json:"moves,omitempty"`
	MoveEligible int              `json:"moveEligiblePlayerRounds,omitempty"`
	Moved        int              `json:"movedPlayerRounds,omitempty"`
	OpeningAt15  *openingSnapshot `json:"openingAt15,omitempty"`
	UtilityTypes map[string]int   `json:"utilityTypes,omitempty"`
}

type spatialCoord [3]int
type spatialMove [2]spatialCoord
type spatialGroupKey struct {
	mapName, team string
	side, phase   int
}
type spatialRound struct {
	demo   string
	number int
}
type spatialCell struct {
	values [6]float64
	rounds map[spatialRound]bool
}
type spatialAccum struct {
	cells        map[spatialCoord]*spatialCell
	rounds       map[spatialRound]bool
	demos        map[string]bool
	moves        map[spatialMove]int
	moveEligible int
	moved        int
	totals       [6]float64
	utilities    map[string]int
	opening      *openingSnapshotAccum
	name         string
}
type spatialBuilder struct {
	groups   map[spatialGroupKey]*spatialAccum
	plants   map[[2]string][]Position
	coverage []spatialCoverage
}

func newSpatialBuilder() *spatialBuilder {
	return &spatialBuilder{groups: map[spatialGroupKey]*spatialAccum{}, plants: map[[2]string][]Position{}}
}

func spatialCoordinate(p Position) spatialCoord {
	center := func(v float64, size int) int { return int(math.Floor(v/float64(size)))*size + size/2 }
	return spatialCoord{center(p.X, spatialCellSize), center(p.Y, spatialCellSize), center(p.Z, spatialHeight)}
}

const (
	spOpening = iota
	spMid
	spLate
	spUnknown
)

var spatialPhaseNames = [...]string{"opening", "mid", "late", "unknown"}
var spatialMetricForEvent = map[int]int{4: 1, 5: 2, 6: 4}

func spatialPhaseAt(anchor *float64, when float64) (int, float64) {
	if anchor == nil || when < *anchor {
		return spUnknown, math.Inf(1)
	}
	if when < *anchor+20 {
		return spOpening, *anchor + 20
	}
	if when < *anchor+60 {
		return spMid, *anchor + 60
	}
	return spLate, math.Inf(1)
}

func (a *spatialAccum) add(cell spatialCoord, round spatialRound, metric int, weight float64) {
	c := a.cells[cell]
	if c == nil {
		c = &spatialCell{rounds: map[spatialRound]bool{}}
		a.cells[cell] = c
	}
	c.values[metric] += weight
	c.rounds[round] = true
	a.totals[metric] += weight
	a.demos[round.demo] = true
	a.rounds[round] = true
}

type spatialDwellKey struct {
	player, team string
	side, round  int
}
type spatialDwell [2]map[spatialCoord]float64

func (b *spatialBuilder) observe(ctx context.Context, d *DemoData, stats *StatisticsDemo, req insightsRequest) error {
	mapName := strings.ToLower(strings.TrimSpace(d.Map))
	// Keep unidentified maps isolated across recordings.
	if mapName == "" {
		mapName = "unknown-" + d.ID
	}
	windows, anchors := analysisWindows(d.Rounds), analysisMovementAnchors(d.Rounds)
	b.coverage = append(b.coverage, spatialCoverage{
		DemoID: d.ID, Rounds: len(windows), Timed: len(anchors), DamageRecorded: d.Damage != nil,
		FramesRecorded: d.Frames != nil, EventsRecorded: d.Events != nil,
		ShotsRecorded: d.Shots != nil, UtilitiesRecorded: d.Utilities != nil,
	})
	teamAt := map[[2]int]string{}
	names := map[string]string{}
	for _, r := range stats.Rounds {
		teamAt[[2]int{r.Number, 3}] = r.CT.TeamKey
		teamAt[[2]int{r.Number, 2}] = r.T.TeamKey
	}
	for _, t := range stats.Teams {
		names[t.TeamKey] = t.Label
	}
	selected := map[string]bool{}
	wanted := func(raw string) bool {
		if req.PlayerID == "" {
			return true
		}
		if found, known := selected[raw]; known {
			return found
		}
		id, _ := analysisPlayerID(d.ID, raw)
		selected[raw] = id == req.PlayerID
		return selected[raw]
	}
	groupFor := func(team string, side, phase int) *spatialAccum {
		key := spatialGroupKey{mapName, team, side, phase}
		group := b.groups[key]
		if group == nil {
			name := names[team]
			if name == "" {
				name = "队伍未知"
			}
			group = &spatialAccum{cells: map[spatialCoord]*spatialCell{}, rounds: map[spatialRound]bool{}, demos: map[string]bool{}, moves: map[spatialMove]int{}, utilities: map[string]int{}, name: name}
			b.groups[key] = group
		}
		return group
	}
	keyFor := func(raw, name string, round, side int) analysisSeriesKey {
		// Movement and battle events require a participant, while an observed
		// grenade may have a known side even if its owner ID was not recorded.
		team := teamAt[[2]int{round, side}]
		if team == "" {
			team = "demo:" + d.ID + ":team:unknown"
		}
		return analysisSeriesKey{player: raw, team: team, side: side}
	}
	inScope := func(key analysisSeriesKey) bool {
		return analysisSide(key.side) && (req.Team == "" || key.team == req.Team) && wanted(key.player)
	}
	dwell := map[spatialDwellKey]*spatialDwell{}
	sampledAt15 := map[spatialDwellKey]bool{}
	deaths := analysisDeathTimes(d.Events, windows)
	for i := 0; i+1 < len(d.Frames); i++ {
		if i%256 == 0 && ctx.Err() != nil {
			return ctx.Err()
		}
		f := d.Frames[i]
		analysisObserveMovement(f, d.Frames[i+1], windows, deaths, func(p PlayerFrame, pos Position, start, end float64) {
			key := keyFor(p.ID, "", f.Round, p.Team)
			if !inScope(key) {
				return
			}
			cell := spatialCoordinate(pos)
			dk := spatialDwellKey{p.ID, key.team, p.Team, f.Round}
			if anchor := anchors[f.Round]; anchor != nil && start <= *anchor+15 && end > *anchor+15 && !sampledAt15[dk] {
				sampledAt15[dk] = true
				groupFor(key.team, p.Team, spOpening).snapshotAt15(cell, spatialRound{d.ID, f.Round})
			}
			for start < end {
				phase, bound := spatialPhaseAt(anchors[f.Round], start)
				stop := math.Min(end, bound)
				weight := stop - start
				groupFor(key.team, p.Team, phase).add(cell, spatialRound{d.ID, f.Round}, 0, weight)
				if phase == spOpening || phase == spMid {
					v := dwell[dk]
					if v == nil {
						v = &spatialDwell{}
						dwell[dk] = v
					}
					if v[phase] == nil {
						v[phase] = map[spatialCoord]float64{}
					}
					v[phase][cell] += weight
				}
				start = stop
			}
		})
	}
	for k, v := range dwell {
		from, f := spatialDwellPeak(v[spOpening])
		to, t := spatialDwellPeak(v[spMid])
		if f >= 1 && t >= 1 {
			group := groupFor(k.team, k.side, spMid)
			group.moveEligible++
			if from != to {
				group.moves[spatialMove{from, to}]++
				group.moved++
			}
		}
	}
	record := func(key analysisSeriesKey, pos Position, round, phase, metric int) *spatialAccum {
		if !inScope(key) {
			return nil
		}
		g := groupFor(key.team, key.side, phase)
		g.add(spatialCoordinate(pos), spatialRound{d.ID, round}, metric, 1)
		return g
	}
	observer := analysisEventObserver{windows: windows, seen: map[analysisEngagementKey]bool{}, key: keyFor,
		add: func(key analysisSeriesKey, pos Position, metric, round int, when float64) {
			phase, _ := spatialPhaseAt(anchors[round], when)
			record(key, pos, round, phase, spatialMetricForEvent[metric])
		}}
	for _, e := range d.Damage {
		observer.damage(e)
	}
	for _, e := range d.Events {
		observer.death(e)
		if e.Type != "kill" || !observer.inside(e.Round, e.T) || e.KillerID == "" || e.VictimID == "" || e.KillerID == e.VictimID || !analysisSide(e.KillerTeam) || !analysisSide(e.VictimTeam) || e.KillerTeam == e.VictimTeam || !analysisPosition(e.KillerPos) {
			continue
		}
		phase, _ := spatialPhaseAt(anchors[e.Round], e.T)
		record(keyFor(e.KillerID, e.Killer, e.Round, e.KillerTeam), *e.KillerPos, e.Round, phase, 3)
	}
	for _, e := range d.Shots {
		observer.shot(e)
	}
	for _, u := range d.Utilities {
		pos := Position{u.X, u.Y, u.Z}
		if !u.Detonated || !analysisPosition(&pos) || !analysisFinite(u.Detonate) {
			continue
		}
		when, phase := u.Detonate, spUnknown
		if u.ThrowObserved {
			if !analysisFinite(u.Start) || u.Start > u.Detonate {
				continue
			}
			when = u.Start
			phase, _ = spatialPhaseAt(anchors[u.Round], when)
		}
		if !observer.inside(u.Round, when) {
			continue
		}
		if g := record(keyFor(u.OwnerID, u.Owner, u.Round, u.Team), pos, u.Round, phase, 5); g != nil {
			switch u.Type {
			case "smoke", "flash", "he", "molotov", "incendiary", "fire", "decoy":
				g.utilities[u.Type]++
			default:
				g.utilities["other"]++
			}
		}
	}
	b.observePlants(mapName, d, windows)
	return ctx.Err()
}

func coordLess(a, b spatialCoord) bool { return slices.Compare(a[:], b[:]) < 0 }

func spatialDwellPeak(cells map[spatialCoord]float64) (spatialCoord, float64) {
	var best spatialCoord
	var seconds float64
	for c, n := range cells {
		if n > seconds || (n == seconds && coordLess(c, best)) {
			best, seconds = c, n
		}
	}
	return best, seconds
}

// Pair the recorded site label with the first observed planted bomb shortly
// after that event, even when replay frames are out of order.
func (b *spatialBuilder) observePlants(mapName string, d *DemoData, windows map[int]analysisRoundWindow) {
	plants := map[int]Event{}
	ambiguous := map[int]bool{}
	for _, e := range d.Events {
		w, ok := windows[e.Round]
		if !ok || e.Type != "bomb_planted" || (e.Site != "A" && e.Site != "B") || !analysisFinite(e.T) || e.T < w.start || e.T > w.end {
			continue
		}
		if _, found := plants[e.Round]; found {
			ambiguous[e.Round] = true
		}
		plants[e.Round] = e
	}
	bestTime := map[int]float64{}
	best := map[int]Position{}
	for _, f := range d.Frames {
		e, ok := plants[f.Round]
		if !ok || ambiguous[f.Round] || f.Bomb == nil || f.Bomb.State != "planted" || !analysisFinite(f.T) || f.T < e.T || f.T > e.T+1 || f.T > windows[f.Round].end {
			continue
		}
		pos := Position{f.Bomb.X, f.Bomb.Y, f.Bomb.Z}
		if !analysisPosition(&pos) {
			continue
		}
		if t, seen := bestTime[f.Round]; !seen || f.T < t {
			bestTime[f.Round], best[f.Round] = f.T, pos
		}
	}
	for _, r := range slices.Sorted(maps.Keys(best)) {
		k := [2]string{mapName, plants[r].Site}
		b.plants[k] = append(b.plants[k], best[r])
	}
}

func spatialCenter(plants []Position) Position {
	var avg Position
	for _, p := range plants {
		avg.X += p.X
		avg.Y += p.Y
		avg.Z += p.Z
	}
	n := float64(len(plants))
	avg.X /= n
	avg.Y /= n
	avg.Z /= n
	dist := func(p Position) float64 { x, y, z := p.X-avg.X, p.Y-avg.Y, p.Z-avg.Z; return x*x + y*y + z*z }
	best := plants[0]
	for _, p := range plants[1:] {
		if dist(p) < dist(best) {
			best = p
		}
	}
	return best
}

// Keep each metric's leading cells, so the busiest spawn cell cannot hide a
// low-occupancy firing or death hotspot. Ties use world coordinates.
func spatialHotspots(g *spatialAccum, limit int) []spatialCoord {
	all := slices.Collect(maps.Keys(g.cells))
	limit = min(limit, len(all))
	var lists [8][]spatialCoord
	value := func(c spatialCoord, k int) float64 {
		v := g.cells[c].values
		switch k {
		case 6:
			return v[3] - v[2]
		case 7:
			return v[2] - v[3]
		}
		return v[k]
	}
	for k := range lists {
		for _, c := range all {
			if value(c, k) > 0 {
				lists[k] = append(lists[k], c)
			}
		}
		row := lists[k]
		sort.Slice(row, func(i, j int) bool {
			a, b := value(row[i], k), value(row[j], k)
			return a > b || (a == b && coordLess(row[i], row[j]))
		})
	}
	chosen := map[spatialCoord]bool{}
	out := make([]spatialCoord, 0, limit)
	for rank := 0; len(out) < limit; rank++ {
		hasMore := false
		for _, row := range lists {
			if rank >= len(row) {
				continue
			}
			hasMore = true
			c := row[rank]
			if !chosen[c] {
				chosen[c] = true
				out = append(out, c)
				if len(out) == limit {
					break
				}
			}
		}
		if !hasMore {
			break
		}
	}
	return out
}

func spatialRoundSeconds(n float64) float64 { return math.Round(n*100) / 100 }

func (b *spatialBuilder) report() insightsSpatial {
	out := insightsSpatial{CellSize: spatialCellSize, Height: spatialHeight, Coverage: b.coverage, Groups: []spatialGroup{}, Landmarks: []spatialLandmark{},
		Method: "坐标为 XY 边长 384、Z 高 128 的世界坐标网格中心。2=T，3=CT。以解冻为 0 秒，opening 为 [0,20)，mid 为 [20,60)，late 为 60 秒至有效回合结束，unknown 表示缺少可靠计时。" +
			"同地图、队伍、阵营合计，指定玩家时只计该人。cells 每行 [x,y,z,存活玩家秒,交火,死亡,敌对击杀,枪械开火,道具落点,覆盖回合数]。totals 按此顺序给出六项全量合计。cellCount 为全量格数。cells 按各项及击杀与死亡差额保留代表格。rounds 为存在任一空间记录的去重比赛回合数。" +
			"交火取敌方枪械伤害双方，按玩家、原地图分析网格和秒去重。死亡含非敌对，敌对击杀的位置取自击杀者。道具位置取起效点，阶段按投出时间划分，投出时间缺失计 unknown。coverage 标明旧缓存中各字段是否存在，字段缺失时相关数据未知。" +
			"openingAt15 给出解冻后第 15 秒存活且位置可观测的玩家。cells 为 [x,y,z,玩家回合数,回合数]，最多 12 格。" +
			"moves 为 [起x,y,z,终x,y,z,玩家回合数]。同场、同回合、同人开局和中期各自停留最长的格均至少停留 1 秒，即计入 moveEligiblePlayerRounds。两个格有变化时计入 movedPlayerRounds，最多列出四种移动。垂直分箱变化可能出现在同一平面坐标。" +
			"landmarks 由具名下包事件与之后一秒内同回合的已安装炸弹帧配对，坐标取最接近样本平均位置的观测值。其他报点名称需独立依据。判断风险时结合占位时长、交火和覆盖回合数。",
	}
	keys := slices.Collect(maps.Keys(b.groups))
	sort.Slice(keys, func(i, j int) bool {
		a, c := keys[i], keys[j]
		return cmp.Or(cmp.Compare(a.mapName, c.mapName), cmp.Compare(a.team, c.team), cmp.Compare(a.side, c.side), cmp.Compare(a.phase, c.phase)) < 0
	})
	limit := min(45, max(8, 1200/max(1, len(keys))))
	for _, k := range keys {
		g := b.groups[k]
		row := spatialGroup{
			Map: k.mapName, TeamID: k.team, TeamName: g.name, Side: k.side, Phase: spatialPhaseNames[k.phase],
			DemoIDs: slices.Sorted(maps.Keys(g.demos)), Rounds: len(g.rounds), CellCount: len(g.cells),
			Totals: g.totals, UtilityTypes: g.utilities, Cells: [][10]float64{}, MoveEligible: g.moveEligible, Moved: g.moved,
		}
		row.Totals[0] = spatialRoundSeconds(row.Totals[0])
		for _, c := range spatialHotspots(g, limit) {
			v := g.cells[c]
			data := [10]float64{float64(c[0]), float64(c[1]), float64(c[2])}
			copy(data[3:9], v.values[:])
			data[3] = spatialRoundSeconds(data[3])
			data[9] = float64(len(v.rounds))
			row.Cells = append(row.Cells, data)
		}
		moves := slices.Collect(maps.Keys(g.moves))
		sort.Slice(moves, func(i, j int) bool {
			a, c := moves[i], moves[j]
			if g.moves[a] != g.moves[c] {
				return g.moves[a] > g.moves[c]
			}
			if a[0] != c[0] {
				return coordLess(a[0], c[0])
			}
			return coordLess(a[1], c[1])
		})
		for _, move := range moves[:min(4, len(moves))] {
			a, c := move[0], move[1]
			row.Moves = append(row.Moves, [7]int{a[0], a[1], a[2], c[0], c[1], c[2], g.moves[move]})
		}
		row.OpeningAt15 = g.opening.report()
		out.Groups = append(out.Groups, row)
	}
	landmarks := slices.Collect(maps.Keys(b.plants))
	sort.Slice(landmarks, func(i, j int) bool { return slices.Compare(landmarks[i][:], landmarks[j][:]) < 0 })
	for _, k := range landmarks {
		positions := b.plants[k]
		p := spatialCenter(positions)
		out.Landmarks = append(out.Landmarks, spatialLandmark{k[0], k[1], math.Round(p.X), math.Round(p.Y), math.Round(p.Z), len(positions)})
	}
	return out
}

type openingSnapshot struct {
	Rounds       int      `json:"rounds"`
	PlayerRounds int      `json:"playerRounds"`
	Cells        [][5]int `json:"cells"`
}
type openingSnapshotAccum struct {
	rounds       map[spatialRound]bool
	playerRounds int
	counts       map[spatialCoord]int
	cellRounds   map[spatialCoord]map[spatialRound]bool
}

func (g *spatialAccum) snapshotAt15(c spatialCoord, r spatialRound) {
	if g.opening == nil {
		g.opening = &openingSnapshotAccum{rounds: map[spatialRound]bool{}, counts: map[spatialCoord]int{}, cellRounds: map[spatialCoord]map[spatialRound]bool{}}
	}
	s := g.opening
	s.rounds[r] = true
	s.playerRounds++
	s.counts[c]++
	if s.cellRounds[c] == nil {
		s.cellRounds[c] = map[spatialRound]bool{}
	}
	s.cellRounds[c][r] = true
}
func (s *openingSnapshotAccum) report() *openingSnapshot {
	if s == nil {
		return nil
	}
	coords := slices.Collect(maps.Keys(s.counts))
	sort.Slice(coords, func(i, j int) bool {
		a, b := coords[i], coords[j]
		return s.counts[a] > s.counts[b] || (s.counts[a] == s.counts[b] && coordLess(a, b))
	})
	out := &openingSnapshot{Rounds: len(s.rounds), PlayerRounds: s.playerRounds}
	for _, c := range coords[:min(12, len(coords))] {
		out.Cells = append(out.Cells, [5]int{c[0], c[1], c[2], s.counts[c], len(s.cellRounds[c])})
	}
	return out
}
