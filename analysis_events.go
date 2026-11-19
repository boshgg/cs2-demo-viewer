package main

import (
	"math"
	"sort"
)

// Each sparse row contains one metric, keeping each layer's own observed Z
// instead of mixing floor evidence with the other layers or movement samples.
type AnalysisEventCell [7]float64        // x, y, z, elapsed second, engagements, deaths, shots
type AnalysisEventUntimedCell [9]float64 // x,y,z, unknown E/D/S, beyond-115 E/D/S

type analysisEventKey struct {
	grid           analysisGridKey
	second, metric int // second -1 is unknown; 115 is beyond the countdown
}
type analysisEventValue struct {
	count, zSum  float64
	contributors analysisRoundSet
}
type analysisEventAccumulator struct {
	bins map[analysisEventKey]*analysisEventValue
}

func (a *analysisEventAccumulator) add(pos Position, metric int, when float64, anchor *float64, round int) {
	if !analysisPosition(&pos) || metric < 4 || metric > 6 || !analysisFinite(when) {
		return
	}
	second := -1
	if anchor != nil && analysisFinite(*anchor) && when >= *anchor {
		elapsed := when - *anchor
		if analysisFinite(elapsed) {
			if elapsed >= 115 {
				second = 115
			} else {
				second = int(math.Floor(elapsed))
			}
		}
	}
	if a.bins == nil {
		a.bins = map[analysisEventKey]*analysisEventValue{}
	}
	key := analysisEventKey{analysisGrid(pos), second, metric}
	v := a.bins[key]
	if v == nil {
		v = &analysisEventValue{}
		a.bins[key] = v
	}
	v.contributors.add(round)
	v.count++
	v.zSum += pos.Z
}

func (a *analysisEventAccumulator) fill(out *AnalysisSeries) {
	out.EventTimeline = []AnalysisEventCell{}
	out.EventUntimedCells = []AnalysisEventUntimedCell{}
	for key, v := range a.bins {
		x, y, z := (float64(key.grid.x)+.5)*analysisCellSize, (float64(key.grid.y)+.5)*analysisCellSize, math.Round(v.zSum/v.count*100)/100
		if key.second >= 0 && key.second < 115 {
			row := AnalysisEventCell{x, y, z, float64(key.second)}
			row[key.metric] = v.count
			out.EventTimeline = append(out.EventTimeline, row)
		} else {
			row := AnalysisEventUntimedCell{x, y, z}
			column := key.metric - 1
			if key.second == 115 {
				column += 3
			}
			row[column] = v.count
			out.EventUntimedCells = append(out.EventUntimedCells, row)
		}
	}
	sort.Slice(out.EventTimeline, func(i, j int) bool {
		for n := 0; n < 7; n++ {
			if out.EventTimeline[i][n] != out.EventTimeline[j][n] {
				return out.EventTimeline[i][n] < out.EventTimeline[j][n]
			}
		}
		return false
	})
	sort.Slice(out.EventUntimedCells, func(i, j int) bool {
		for n := 0; n < 9; n++ {
			if out.EventUntimedCells[i][n] != out.EventUntimedCells[j][n] {
				return out.EventUntimedCells[i][n] < out.EventUntimedCells[j][n]
			}
		}
		return false
	})
}

// Shared acceptance and deduplication rules keep the new timeline an exact
// partition of full-round event counts, including array-order tie attribution.
type analysisEventObserver struct {
	windows map[int]analysisRoundWindow
	seen    map[analysisEngagementKey]bool
	key     func(raw, name string, round, side int) analysisSeriesKey
	add     func(analysisSeriesKey, Position, int, int, float64)
}

func (o *analysisEventObserver) inside(round int, t float64) bool {
	w, ok := o.windows[round]
	return ok && analysisFinite(t) && t >= w.start && t <= w.end
}

func (o *analysisEventObserver) damage(e DamageEvent) {
	if !o.inside(e.Round, e.T) || e.Damage < 0 || !analysisSide(e.AttackerTeam) || !analysisSide(e.VictimTeam) || e.AttackerTeam == e.VictimTeam || e.AttackerID == "" || e.VictimID == "" || e.AttackerID == e.VictimID || !analysisFirearm(e.Weapon) {
		return
	}
	for _, p := range []struct {
		id   string
		side int
		pos  *Position
	}{{e.AttackerID, e.AttackerTeam, e.AttackerPos}, {e.VictimID, e.VictimTeam, e.VictimPos}} {
		if !analysisPosition(p.pos) {
			continue
		}
		key := o.key(p.id, "", e.Round, p.side)
		seen := analysisEngagementKey{series: key, grid: analysisGrid(*p.pos), round: e.Round, second: int64(math.Floor(e.T - o.windows[e.Round].start))}
		if o.seen[seen] {
			continue
		}
		o.seen[seen] = true
		o.add(key, *p.pos, 4, e.Round, e.T)
	}
}

func (o *analysisEventObserver) death(e Event) {
	if e.Type != "kill" || !o.inside(e.Round, e.T) || e.VictimID == "" || !analysisSide(e.VictimTeam) || !analysisPosition(e.VictimPos) {
		return
	}
	key := o.key(e.VictimID, e.Victim, e.Round, e.VictimTeam)
	o.add(key, *e.VictimPos, 5, e.Round, e.T)
}

func (o *analysisEventObserver) shot(e Shot) {
	if !o.inside(e.Round, e.T) || e.PlayerID == "" || !analysisSide(e.Team) || !analysisFirearm(e.Weapon) {
		return
	}
	pos := Position{e.X, e.Y, e.Z}
	if !analysisPosition(&pos) {
		return
	}
	key := o.key(e.PlayerID, "", e.Round, e.Team)
	o.add(key, pos, 6, e.Round, e.T)
}
