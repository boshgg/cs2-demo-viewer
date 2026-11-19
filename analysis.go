package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

const analysisCellSize = 64
const analysisUtilityTimingVersion = 1
const analysisMovementTimingVersion = 1
const analysisEventTimingVersion = 1
const analysisPlantPhaseVersion = 1
const analysisPlantTimeVersion = 1
const analysisUtilityPlantPhaseVersion = 1

// AnalysisCell holds a world-space grid centre followed by independent metrics:
// x, y, z, observed living-player seconds, gunfight involvements, deaths, shots.
// Counts are never normalised here: the client can combine independent demos
// without losing the underlying sample sizes.
type AnalysisCell [7]float64

type AnalysisPlayer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Stable bool   `json:"stable"`
}

type AnalysisTeam struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	PlayerIDs      []string `json:"playerIds"`
	IdentitySource string   `json:"identitySource"`
}

type AnalysisSeries struct {
	PlantRoundRefs []int `json:"plantRoundRefs,omitempty"`
	AnalysisHeatmap
	PlayerID      string                     `json:"playerId"`
	TeamID        string                     `json:"teamId"`
	Side          int                        `json:"side"`
	PlantPhases   map[string]AnalysisHeatmap `json:"plantPhases,omitempty"`
	PlantTimeline []AnalysisPlantTimeCell    `json:"plantTimeline,omitempty"`
}

type AnalysisHeatmap struct {
	RoundRefs              *AnalysisRoundRefs            `json:"roundRefs,omitempty"`
	Cells                  []AnalysisCell                `json:"cells"`
	Rounds                 int                           `json:"rounds"`
	MovementTimeline       []AnalysisMovementCell        `json:"movementTimeline"`
	MovementUntimedCells   []AnalysisMovementUntimedCell `json:"movementUntimedCells"`
	MovementUnknownSeconds float64                       `json:"movementUnknownSeconds"`
	MovementBeyondSeconds  float64                       `json:"movementBeyondSeconds"`
	EventTimeline          []AnalysisEventCell           `json:"eventTimeline"`
	EventUntimedCells      []AnalysisEventUntimedCell    `json:"eventUntimedCells"`
}

type AnalysisUtility struct {
	PlantPhase    string         `json:"plantPhase"`
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	PlayerID      string         `json:"playerId"`
	Owner         string         `json:"owner"`
	TeamID        string         `json:"teamId"`
	Side          int            `json:"side"`
	Round         int            `json:"round"`
	Time          float64        `json:"time"`
	RoundElapsed  *float64       `json:"roundElapsed"`
	TimeSource    string         `json:"timeSource"`
	Start         *Position      `json:"start"`
	End           Position       `json:"end"`
	Path          []UtilityPoint `json:"path"`
	ThrowObserved bool           `json:"throwObserved"`
	Detonated     bool           `json:"detonated"`
}

type AnalysisBounds struct {
	MinX float64 `json:"minX"`
	MaxX float64 `json:"maxX"`
	MinY float64 `json:"minY"`
	MaxY float64 `json:"maxY"`
}

type AnalysisDemo struct {
	RoundEvidenceVersion     int               `json:"roundEvidenceVersion"`
	RoundSets                [][]int           `json:"roundSets,omitempty"`
	PlantTimeVersion         int               `json:"plantTimeVersion"`
	UtilityPlantPhaseVersion int               `json:"utilityPlantPhaseVersion"`
	PlantPhaseVersion        int               `json:"plantPhaseVersion"`
	PlantPhaseUnknownRounds  []int             `json:"plantPhaseUnknownRounds,omitempty"`
	UtilityTimingVersion     int               `json:"utilityTimingVersion"`
	MovementTimingVersion    int               `json:"movementTimingVersion"`
	EventTimingVersion       int               `json:"eventTimingVersion"`
	ID                       string            `json:"id"`
	Name                     string            `json:"name"`
	Map                      string            `json:"map"`
	Duration                 float64           `json:"duration"`
	RoundCount               int               `json:"roundCount"`
	Synthetic                bool              `json:"synthetic"`
	Warnings                 []string          `json:"warnings"`
	Players                  []AnalysisPlayer  `json:"players"`
	Teams                    []AnalysisTeam    `json:"teams"`
	Series                   []AnalysisSeries  `json:"series"`
	Utilities                []AnalysisUtility `json:"utilities"`
	Bounds                   AnalysisBounds    `json:"bounds"`
	CellSize                 int               `json:"cellSize"`
}

type analysisRoundWindow struct {
	start, end float64
}

type analysisTeamGroup struct {
	team    AnalysisTeam
	members map[string]bool
	stable  map[string]bool
}

type analysisRoster struct {
	members map[string]bool
	stable  map[string]bool
	names   map[string]int
}

type analysisSeriesKey struct {
	player, team string
	side         int
}

type analysisGridKey struct{ x, y, z int }

type analysisCellValue struct {
	contributors [4]analysisRoundSet
	cell         AnalysisCell
	zSum         float64
	zWeight      float64
}

type analysisSeriesValue struct {
	cells    map[analysisGridKey]*analysisCellValue
	rounds   map[int]bool
	movement analysisMovementAccumulator
	events   analysisEventAccumulator
}

type analysisEngagementKey struct {
	series analysisSeriesKey
	grid   analysisGridKey
	round  int
	second int64
}

func (s *analysisSeriesValue) addCell(p Position, metric int, weight float64, round int) {
	if !analysisPosition(&p) || !analysisFinite(weight) || weight <= 0 {
		return
	}
	g := analysisGrid(p)
	c := s.cells[g]
	if c == nil {
		c = &analysisCellValue{cell: AnalysisCell{(float64(g.x) + .5) * analysisCellSize, (float64(g.y) + .5) * analysisCellSize}}
		s.cells[g] = c
	}
	c.contributors[metric-3].add(round)
	c.cell[metric] += weight
	c.zSum += p.Z * weight
	c.zWeight += weight
}

func (s *analysisSeriesValue) heatmap() AnalysisHeatmap {
	out := AnalysisSeries{AnalysisHeatmap: AnalysisHeatmap{Rounds: len(s.rounds), Cells: []AnalysisCell{}}}
	s.movement.fill(&out)
	s.events.fill(&out)
	for _, c := range s.cells {
		c.cell[2] = math.Round(c.zSum/c.zWeight*100) / 100
		c.cell[3] = math.Round(c.cell[3]*10000) / 10000
		out.Cells = append(out.Cells, c.cell)
	}
	sort.Slice(out.Cells, func(i, j int) bool {
		for n := 0; n < 3; n++ {
			if out.Cells[i][n] != out.Cells[j][n] {
				return out.Cells[i][n] < out.Cells[j][n]
			}
		}
		return false
	})
	return out.AnalysisHeatmap
}

// BuildAnalysis does not mutate the source replay. It condenses frames to a
// world-space grid and keeps identities and side changes separate from metrics.
// Gunfights require observed opponent firearm damage; empty damage data is not
// silently substituted with missed shots or speculative lines of sight.
func BuildAnalysis(d *DemoData) *AnalysisDemo {
	a := &AnalysisDemo{RoundEvidenceVersion: analysisRoundEvidenceVersion, RoundSets: [][]int{{}}, PlantTimeVersion: analysisPlantTimeVersion, UtilityPlantPhaseVersion: analysisUtilityPlantPhaseVersion, PlantPhaseVersion: analysisPlantPhaseVersion, UtilityTimingVersion: analysisUtilityTimingVersion, MovementTimingVersion: analysisMovementTimingVersion, EventTimingVersion: analysisEventTimingVersion, CellSize: analysisCellSize, Players: []AnalysisPlayer{}, Teams: []AnalysisTeam{}, Series: []AnalysisSeries{}, Utilities: []AnalysisUtility{}, Warnings: []string{}}
	if d == nil {
		return a
	}
	a.ID, a.Name, a.Map, a.Synthetic = d.ID, d.Name, strings.ToLower(strings.TrimSpace(d.Map)), d.Synthetic
	if analysisFinite(d.Duration) && d.Duration > 0 {
		a.Duration = d.Duration
	}
	a.Warnings = append(a.Warnings, d.Warnings...)
	if d.Damage == nil {
		a.Warnings = append(a.Warnings, "此回放没有伤害事件字段，交火热力图为空；重新导入 Demo 后可提取真实枪械交火。")
	}
	scope := strings.TrimSpace(d.ID)
	if scope == "" {
		// Production imports always have an ID. The deterministic fallback keeps
		// programmatic callers usable without treating nicknames as identity.
		scope = "anonymous-" + analysisHash(fmt.Sprintf("%s\x00%s\x00%g\x00%v", d.Name, d.Map, d.Duration, d.Players))
	}
	players := map[string]AnalysisPlayer{}
	normalisePlayer := func(raw, name string) string {
		if raw == "" {
			return ""
		}
		id, stable := analysisPlayerID(scope, raw)
		p, ok := players[id]
		if !ok {
			p = AnalysisPlayer{ID: id, Stable: stable, Name: raw}
		}
		if strings.TrimSpace(name) != "" {
			p.Name = name
		}
		players[id] = p
		return id
	}
	for _, p := range d.Players {
		normalisePlayer(p.ID, p.Name)
	}
	windows := analysisWindows(d.Rounds)
	a.RoundCount = len(windows)
	inside := func(round int, t float64) bool {
		w, ok := windows[round]
		return ok && analysisFinite(t) && t >= w.start && t <= w.end
	}
	// Team snapshots use the actual side in each round. Names are an identity
	// hint only when they are real clan names; CT/T labels never merge opponents.
	rosters := map[int]map[int]*analysisRoster{}
	plants := newAnalysisPlantPhases(d.Rounds, d.Events, windows)
	for _, f := range d.Frames {
		plants.observeFrame(f, windows)
		analysisAddRoster(rosters, windows, f, normalisePlayer)
	}
	a.PlantPhaseUnknownRounds = plants.unknownRounds()
	roundTeams, groups := analysisIdentifyTeams(scope, windows, rosters)
	unknown := &analysisTeamGroup{team: AnalysisTeam{ID: "demo:" + scope + ":team:unknown", Name: "队伍未知", IdentitySource: "unknown", PlayerIDs: []string{}}, members: map[string]bool{}, stable: map[string]bool{}}
	unknownUsed := false
	teamAt := func(round, side int, player string) *analysisTeamGroup {
		g := roundTeams[round][side]
		if g == nil {
			g, unknownUsed = unknown, true
		}
		if player != "" {
			g.members[player] = true
		}
		return g
	}
	series := map[analysisSeriesKey]*analysisSeriesValue{}
	seriesFor := func(player string, round, side int) (analysisSeriesKey, *analysisSeriesValue) {
		key := analysisSeriesKey{player: player, team: teamAt(round, side, player).team.ID, side: side}
		s := series[key]
		if s == nil {
			s = &analysisSeriesValue{cells: map[analysisGridKey]*analysisCellValue{}, rounds: map[int]bool{}}
			series[key] = s
		}
		s.rounds[round] = true
		return key, s
	}
	deathTimes := analysisDeathTimes(d.Events, windows)
	anchors := analysisMovementAnchors(d.Rounds)
	hasBounds := false
	includeBounds := func(p Position) {
		if !hasBounds {
			a.Bounds = AnalysisBounds{p.X, p.X, p.Y, p.Y}
			hasBounds = true
		} else {
			a.Bounds.MinX = math.Min(a.Bounds.MinX, p.X)
			a.Bounds.MaxX = math.Max(a.Bounds.MaxX, p.X)
			a.Bounds.MinY = math.Min(a.Bounds.MinY, p.Y)
			a.Bounds.MaxY = math.Max(a.Bounds.MaxY, p.Y)
		}
	}
	for i := 0; i+1 < len(d.Frames); i++ {
		f := d.Frames[i]
		analysisObserveMovement(f, d.Frames[i+1], windows, deathTimes, func(p PlayerFrame, pos Position, start, end float64) {
			key, s := seriesFor(normalisePlayer(p.ID, ""), f.Round, p.Team)
			includeBounds(pos)
			s.addCell(pos, 3, end-start, f.Round)
			plants.movement(key, f.Round, pos, start, end, anchors[f.Round])
			s.movement.add(pos, start, end, anchors[f.Round], f.Round)
		})
	}
	observer := analysisEventObserver{
		windows: windows, seen: map[analysisEngagementKey]bool{},
		key: func(raw, name string, round, side int) analysisSeriesKey {
			key, _ := seriesFor(normalisePlayer(raw, name), round, side)
			return key
		},
		add: func(key analysisSeriesKey, pos Position, metric, round int, when float64) {
			s := series[key]
			includeBounds(pos)
			s.addCell(pos, metric, 1, round)
			plants.event(key, round, pos, metric, when, anchors[round])
			s.events.add(pos, metric, when, anchors[round], round)
		},
	}
	for _, event := range d.Damage {
		observer.damage(event)
	}
	for _, event := range d.Events {
		observer.death(event)
	}
	for _, event := range d.Shots {
		observer.shot(event)
	}
	timingRounds := analysisTimingRounds(d.Rounds)
	for _, u := range d.Utilities {
		end := Position{u.X, u.Y, u.Z}
		when := u.Detonate
		if u.ThrowObserved {
			when = u.Start
		}
		if !u.Detonated || !analysisPosition(&end) || !analysisFinite(u.Detonate) || !inside(u.Round, when) {
			continue
		}
		player := normalisePlayer(u.OwnerID, u.Owner)
		out := AnalysisUtility{ID: u.ID, Type: u.Type, PlayerID: player, Owner: u.Owner, TeamID: teamAt(u.Round, u.Team, player).team.ID, Side: u.Team, Round: u.Round, Time: when, End: end, Path: []UtilityPoint{}, ThrowObserved: u.ThrowObserved, Detonated: true}
		out.RoundElapsed, out.TimeSource = analysisUtilityTiming(u, timingRounds)
		out.PlantPhase = plants.throwPhase(u)
		if u.ThrowObserved && len(u.Path) > 0 {
			first := u.Path[0]
			pos := Position{first.X, first.Y, first.Z}
			if analysisPosition(&pos) && analysisFinite(first.T) && math.Abs(first.T-u.Start) <= .25 {
				out.Start = &pos
			}
		}
		validPath := make([]UtilityPoint, 0, len(u.Path))
		for _, p := range u.Path {
			if analysisFinite(p.T) && analysisPosition(&Position{p.X, p.Y, p.Z}) {
				validPath = append(validPath, p)
			}
		}
		if len(validPath) <= 24 {
			out.Path = validPath
		} else {
			for n := 0; n < 24; n++ {
				out.Path = append(out.Path, validPath[n*(len(validPath)-1)/23])
			}
		}
		a.Utilities = append(a.Utilities, out)
		includeBounds(end)
		if out.Start != nil {
			includeBounds(*out.Start)
		}
	}
	for _, p := range players {
		a.Players = append(a.Players, p)
	}
	sort.Slice(a.Players, func(i, j int) bool { return a.Players[i].ID < a.Players[j].ID })
	if unknownUsed {
		groups = append(groups, unknown)
	}
	for _, g := range groups {
		g.team.PlayerIDs = analysisSortedKeys(g.members)
		a.Teams = append(a.Teams, g.team)
	}
	sort.Slice(a.Teams, func(i, j int) bool { return a.Teams[i].ID < a.Teams[j].ID })
	for key, s := range series {
		out := AnalysisSeries{PlayerID: key.player, TeamID: key.team, Side: key.side, AnalysisHeatmap: s.heatmap(), PlantPhases: plants.heatmaps(key), PlantTimeline: plants.timeline[key].rows()}
		a.Series = append(a.Series, out)
	}
	sort.Slice(a.Series, func(i, j int) bool {
		x, y := a.Series[i], a.Series[j]
		if x.PlayerID != y.PlayerID {
			return x.PlayerID < y.PlayerID
		}
		if x.TeamID != y.TeamID {
			return x.TeamID < y.TeamID
		}
		return x.Side < y.Side
	})
	dictionary := newAnalysisRoundDictionary()
	for i := range a.Series {
		s := &a.Series[i]
		key := analysisSeriesKey{s.PlayerID, s.TeamID, s.Side}
		dictionary.fillSeries(s, series[key], plants, key)
	}
	a.RoundSets = dictionary.sets
	sort.SliceStable(a.Utilities, func(i, j int) bool {
		if a.Utilities[i].Time != a.Utilities[j].Time {
			return a.Utilities[i].Time < a.Utilities[j].Time
		}
		return a.Utilities[i].ID < a.Utilities[j].ID
	})
	return a
}

// Duplicate round numbers do not provide a unique timing anchor.
func analysisTimingRounds(rounds []Round) map[int]Round {
	indexed := map[int]Round{}
	ambiguous := map[int]bool{}
	for _, round := range rounds {
		if _, exists := indexed[round.Number]; exists {
			ambiguous[round.Number] = true
		}
		indexed[round.Number] = round
	}
	for number := range ambiguous {
		delete(indexed, number)
	}
	return indexed
}

func analysisUtilityTiming(utility Utility, rounds map[int]Round) (*float64, string) {
	round, ok := rounds[utility.Round]
	if !ok || round.Number < 1 || !utility.ThrowObserved || !analysisFinite(utility.Start) || !analysisFinite(round.Start) || !analysisFinite(round.End) || !analysisFinite(round.FreezeEnd) || round.End < round.Start || round.FreezeEnd < round.Start || round.FreezeEnd > round.End || utility.Start < round.FreezeEnd || utility.Start > round.End {
		return nil, "unknown"
	}
	// The parser historically replaced a missing FreezeEnd with Round.Start.
	// Treat that equality as unknown unless a recorded freeze-end event proves it.
	if round.FreezeEnd == round.Start && (round.Economy == nil || round.Economy.Source != "freeze_end" || !analysisFinite(round.Economy.Time) || round.Economy.Time != round.FreezeEnd) {
		return nil, "unknown"
	}
	elapsed := utility.Start - round.FreezeEnd
	if !analysisFinite(elapsed) || elapsed < 0 {
		return nil, "unknown"
	}
	return &elapsed, "freeze_end"
}

func analysisIdentifyTeams(scope string, windows map[int]analysisRoundWindow, rosters map[int]map[int]*analysisRoster) (map[int]map[int]*analysisTeamGroup, []*analysisTeamGroup) {
	result := map[int]map[int]*analysisTeamGroup{}
	groups := []*analysisTeamGroup{}
	roundNumbers := make([]int, 0, len(windows))
	for round := range windows {
		roundNumbers = append(roundNumbers, round)
	}
	sort.Ints(roundNumbers)
	for _, round := range roundNumbers {
		result[round] = map[int]*analysisTeamGroup{}
		used := map[*analysisTeamGroup]bool{}
		for _, side := range []int{2, 3} {
			r := rosters[round][side]
			if r == nil || len(r.members) == 0 {
				continue
			}
			name := analysisRosterName(r)
			key := ""
			otherName := analysisRosterName(rosters[round][5-side])
			if name != "" && !strings.EqualFold(name, otherName) {
				key = "name:" + strings.ToLower(name)
			}
			var found *analysisTeamGroup
			for _, g := range groups {
				if !used[g] && key != "" && g.team.ID == key {
					found = g
					break
				}
			}
			if found == nil {
				best := 0
				for _, g := range groups {
					if used[g] {
						continue
					}
					a, b := r.stable, g.stable
					if len(a) == 0 || len(b) == 0 {
						a, b = r.members, g.members
					}
					shared := 0
					for id := range a {
						if b[id] {
							shared++
						}
					}
					minimum := min(len(a), len(b))
					if shared > best && (shared >= 3 && shared*2 >= minimum || shared > 0 && shared == minimum) {
						found, best = g, shared
					}
				}
			}
			if found == nil {
				identity := "clan"
				if key == "" {
					identity = "roster"
					key = "roster:" + analysisHash(strings.Join(analysisSortedKeys(r.stable), ","))
					name = "阵容队伍 " + strconv.Itoa(len(groups)+1)
					if len(r.stable) == 0 {
						identity = "demo"
						key = fmt.Sprintf("demo:%s:team:%d", scope, len(groups)+1)
					}
				}
				// Identical clan labels on opposing sides are ambiguous. Keep
				// both records distinct rather than collapsing an entire match.
				for _, g := range groups {
					if g.team.ID == key {
						key, identity = key+":demo:"+scope+":roster:"+analysisHash(strings.Join(analysisSortedKeys(r.members), ",")), "ambiguous"
						break
					}
				}
				found = &analysisTeamGroup{team: AnalysisTeam{ID: key, Name: name, IdentitySource: identity}, members: map[string]bool{}, stable: map[string]bool{}}
				groups = append(groups, found)
			} else if found.team.IdentitySource != "clan" && key != "" {
				duplicate := false
				for _, g := range groups {
					duplicate = duplicate || g != found && g.team.ID == key
				}
				if !duplicate {
					found.team.ID, found.team.Name, found.team.IdentitySource = key, name, "clan"
				}
			}
			for id := range r.members {
				found.members[id] = true
			}
			for id := range r.stable {
				found.stable[id] = true
			}
			result[round][side], used[found] = found, true
		}
	}
	return result, groups
}

func analysisPlayerID(scope, raw string) (string, bool) {
	v, err := strconv.ParseUint(raw, 10, 64)
	// Steam's public individual-user ID: universe 1, account type 1,
	// desktop instance 1, nonzero account number. Small synthetic IDs and
	// server-local bot IDs are intentionally never shared across recordings.
	if err == nil && v>>56 == 1 && v>>52&15 == 1 && v>>32&0xfffff == 1 && uint32(v) != 0 {
		return strconv.FormatUint(v, 10), true
	}
	return "demo:" + scope + ":player:" + raw, false
}

func analysisClanName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	key := strings.ToLower(name)
	key = strings.NewReplacer("-", "", "_", "", " ", "").Replace(key)
	switch key {
	case "", "ct", "t", "counterterrorist", "counterterrorists", "terrorist", "terrorists", "反恐精英", "恐怖分子", "ctteam", "tteam", "teamct", "teamt", "counterterroriststeam", "terroriststeam", "team", "team1", "team2", "teama", "teamb", "队伍1", "队伍2", "a队", "b队":
		return ""
	}
	return name
}

func analysisRosterName(r *analysisRoster) string {
	name := ""
	if r == nil {
		return name
	}
	for _, n := range analysisSortedIntKeys(r.names) {
		if name == "" || r.names[n] > r.names[name] {
			name = n
		}
	}
	return name
}

func analysisSortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func analysisSortedIntKeys(values map[string]int) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func analysisHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:12])
}

func analysisSide(side int) bool    { return side == 2 || side == 3 }
func analysisFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func analysisPosition(p *Position) bool {
	return p != nil && analysisFinite(p.X) && analysisFinite(p.Y) && analysisFinite(p.Z) && math.Abs(p.X) <= 1e6 && math.Abs(p.Y) <= 1e6 && math.Abs(p.Z) <= 1e6
}

func analysisGrid(p Position) analysisGridKey {
	return analysisGridKey{int(math.Floor(p.X / analysisCellSize)), int(math.Floor(p.Y / analysisCellSize)), int(math.Floor(p.Z / analysisCellSize))}
}

var analysisFirearms = func() map[string]bool {
	names := map[string]bool{}
	for _, typ := range []common.EquipmentType{
		common.EqP2000, common.EqGlock, common.EqP250, common.EqDeagle, common.EqFiveSeven, common.EqDualBerettas, common.EqTec9, common.EqCZ, common.EqUSP, common.EqRevolver,
		common.EqMP7, common.EqMP9, common.EqBizon, common.EqMac10, common.EqUMP, common.EqP90, common.EqMP5,
		common.EqSawedOff, common.EqNova, common.EqMag7, common.EqXM1014, common.EqM249, common.EqNegev,
		common.EqGalil, common.EqFamas, common.EqAK47, common.EqM4A4, common.EqM4A1, common.EqSSG08, common.EqSG553, common.EqAUG, common.EqAWP, common.EqScar20, common.EqG3SG1,
	} {
		names[strings.ToLower(typ.String())] = true
	}
	return names
}()

func analysisFirearm(name string) bool {
	return analysisFirearms[strings.ToLower(strings.TrimSpace(name))]
}
