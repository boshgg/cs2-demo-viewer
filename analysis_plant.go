package main

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"slices"
)

// A confirmed no-plant round has a boundary at +Inf. Unknown rounds never
// contribute to either phase, while the original all-phase view stays usable.
type analysisPlantPhases struct {
	windows  map[int]analysisRoundWindow
	boundary map[int]float64
	unknown  map[int]bool
	series   map[analysisSeriesKey]map[string]*analysisSeriesValue
}

func newAnalysisPlantPhases(rounds []Round, events []Event, windows map[int]analysisRoundWindow) *analysisPlantPhases {
	p := &analysisPlantPhases{windows: windows, boundary: map[int]float64{}, unknown: map[int]bool{}, series: map[analysisSeriesKey]map[string]*analysisSeriesValue{}}
	unique := analysisTimingRounds(rounds)
	for number := range windows {
		p.boundary[number] = math.Inf(1)
		if _, ok := unique[number]; !ok || events == nil {
			p.unknown[number] = true
		}
	}
	resultImpliesPlant := map[int]bool{}
	for _, r := range rounds {
		if r.Reason == "#SFUI_Notice_Target_Bombed" || r.Reason == "#SFUI_Notice_Bomb_Defused" {
			resultImpliesPlant[r.Number] = true
		}
	}
	var lastEvent float64
	for _, e := range events {
		if analysisFinite(e.T) && e.T > lastEvent {
			lastEvent = e.T
		}
		r, ok := unique[e.Round]
		if !ok {
			continue
		}
		switch e.Type {
		case "bomb_planted":
			at := p.boundary[e.Round]
			// Bomb events belong to the recorded round, including the interval
			// between winner declaration and the next round. Heatmap samples
			// still use the shorter playable window.
			if !analysisFinite(e.T) || e.T < r.Start || e.T > r.End || (!math.IsInf(at, 1) && at != e.T) {
				p.unknown[e.Round] = true
			} else {
				p.boundary[e.Round] = e.T
			}
		case "bomb_defused", "bomb_exploded":
			resultImpliesPlant[e.Round] = true
		}
	}
	for round, at := range p.boundary {
		if math.IsInf(at, 1) && (resultImpliesPlant[round] || (len(events) >= maxReplayEvents && windows[round].end >= lastEvent)) {
			p.unknown[round] = true
		}
	}
	return p
}

func (p *analysisPlantPhases) observeFrame(f Frame, windows map[int]analysisRoundWindow) {
	w, ok := windows[f.Round]
	if !ok || !analysisFinite(f.T) || f.T < w.start || f.T > w.end || f.Bomb == nil || f.T >= p.boundary[f.Round] {
		return
	}
	switch f.Bomb.State {
	case "planted", "exploded", "defused":
		p.unknown[f.Round] = true
	}
}

func (p *analysisPlantPhases) unknownRounds() []int {
	return slices.Sorted(maps.Keys(p.unknown))
}
func (p *analysisPlantPhases) part(key analysisSeriesKey, phase string, round int) *analysisSeriesValue {
	groups := p.series[key]
	if groups == nil {
		groups = map[string]*analysisSeriesValue{}
		p.series[key] = groups
	}
	s := groups[phase]
	if s == nil {
		s = &analysisSeriesValue{cells: map[analysisGridKey]*analysisCellValue{}, rounds: map[int]bool{}}
		groups[phase] = s
	}
	s.rounds[round] = true
	return s
}

func (p *analysisPlantPhases) movement(key analysisSeriesKey, round int, pos Position, start, end float64, anchor *float64) {
	if p.unknown[round] {
		return
	}
	split := p.boundary[round]
	add := func(phase string, start, end float64) {
		if end <= start {
			return
		}
		s := p.part(key, phase, round)
		s.addCell(pos, 3, end-start)
		s.movement.add(pos, start, end, anchor)
	}
	add("pre", start, math.Min(end, split))
	add("post", math.Max(start, split), end)
}
func (p *analysisPlantPhases) phaseAt(round int, when float64) string {
	boundary, ok := p.boundary[round]
	if !ok || p.unknown[round] || !analysisFinite(when) {
		return "unknown"
	}
	if when >= boundary {
		return "post"
	}
	return "pre"
}

func (p *analysisPlantPhases) throwPhase(u Utility) string {
	w, ok := p.windows[u.Round]
	if !ok || !u.ThrowObserved || !u.Detonated || !analysisFinite(u.Detonate) || u.Start > u.Detonate || u.Start < w.start || u.Start > w.end {
		return "unknown"
	}
	return p.phaseAt(u.Round, u.Start)
}

func (p *analysisPlantPhases) event(key analysisSeriesKey, round int, pos Position, metric int, when float64, anchor *float64) {
	phase := p.phaseAt(round, when)
	if phase == "unknown" {
		return
	}
	s := p.part(key, phase, round)
	s.addCell(pos, metric, 1)
	s.events.add(pos, metric, when, anchor)
}
func (p *analysisPlantPhases) heatmaps(key analysisSeriesKey) map[string]AnalysisHeatmap {
	if len(p.series[key]) == 0 {
		return nil
	}
	out := map[string]AnalysisHeatmap{}
	for phase, s := range p.series[key] {
		out[phase] = s.heatmap()
	}
	return out
}

// The first frame pass resolves team identity and verifies plant coverage.
// The second retains only adjacent frames and streams each type of event.
func upgradeAnalysisPlantPhases(ctx context.Context, path string, replay *analysisTimingReplay, summary map[string]json.RawMessage) error {
	if !replay.FramesPresent {
		return fmt.Errorf("replay has no frame array")
	}
	windows := analysisWindows(replay.Rounds)
	p := newAnalysisPlantPhases(replay.Rounds, replay.Events, windows)
	rosters := map[int]map[int]*analysisRoster{}
	normalise := func(raw, name string) string {
		if raw == "" {
			return ""
		}
		id, _ := analysisPlayerID(replay.ID, raw)
		return id
	}
	err := streamAnalysisReplay(ctx, path, nil, func(f Frame) { p.observeFrame(f, windows); analysisAddRoster(rosters, windows, f, normalise) })
	if err != nil {
		return err
	}
	teams, _ := analysisIdentifyTeams(replay.ID, windows, rosters)
	keyFor := func(raw, name string, round, side int) analysisSeriesKey {
		team := "demo:" + replay.ID + ":team:unknown"
		if g := teams[round][side]; g != nil {
			team = g.team.ID
		}
		return analysisSeriesKey{normalise(raw, name), team, side}
	}
	anchors := analysisMovementAnchors(replay.Rounds)
	deaths := analysisDeathTimes(replay.Events, windows)
	observer := analysisEventObserver{windows: windows, seen: map[analysisEngagementKey]bool{}, key: keyFor, add: func(k analysisSeriesKey, pos Position, metric, round int, when float64) {
		p.event(k, round, pos, metric, when, anchors[round])
	}}
	var previous Frame
	havePrevious := false
	err = streamAnalysisReplayWithVisitor(ctx, path, nil, analysisReplayVisitor{damage: observer.damage, death: observer.death, shot: observer.shot, frame: func(next Frame) {
		if havePrevious {
			round := previous.Round
			analysisObserveMovement(previous, next, windows, deaths, func(player PlayerFrame, pos Position, start, end float64) {
				p.movement(keyFor(player.ID, "", round, player.Team), round, pos, start, end, anchors[round])
			})
		}
		previous = next
		havePrevious = true
	}})
	if err != nil {
		return err
	}
	var series []map[string]json.RawMessage
	if raw := summary["series"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &series); err != nil {
			return err
		}
	}
	for _, raw := range series {
		if raw == nil {
			continue
		}
		var key analysisSeriesKey
		_ = json.Unmarshal(raw["playerId"], &key.player)
		_ = json.Unmarshal(raw["teamId"], &key.team)
		_ = json.Unmarshal(raw["side"], &key.side)
		if blocks := p.heatmaps(key); len(blocks) > 0 {
			rows, err := json.Marshal(blocks)
			if err != nil {
				return err
			}
			raw["plantPhases"] = rows
		} else {
			delete(raw, "plantPhases")
		}
	}
	if _, found := summary["series"]; found {
		rows, err := json.Marshal(series)
		if err != nil {
			return err
		}
		summary["series"] = rows
	}
	if unknown := p.unknownRounds(); len(unknown) > 0 {
		summary["plantPhaseUnknownRounds"], _ = json.Marshal(unknown)
	}
	summary["plantPhaseVersion"], _ = json.Marshal(analysisPlantPhaseVersion)
	return nil
}
