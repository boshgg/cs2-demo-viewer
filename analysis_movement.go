package main

import (
	"math"
	"sort"
)

// Movement rows retain world coordinates and absolute observed seconds. The
// fourth column is the half-open elapsed second [n,n+1) since freeze end.
type AnalysisMovementCell [5]float64
type AnalysisMovementUntimedCell [5]float64 // x, y, z, unknown seconds, >=115 seconds

type analysisMovementKey struct {
	grid   analysisGridKey
	second int
}
type analysisMovementValue struct {
	seconds, unknown, beyond, zSum float64
}
type analysisMovementAccumulator struct {
	timed   map[analysisMovementKey]*analysisMovementValue
	untimed map[analysisGridKey]*analysisMovementValue
}

func analysisWindows(rounds []Round) map[int]analysisRoundWindow {
	windows := map[int]analysisRoundWindow{}
	for _, r := range rounds {
		if r.Number < 1 || !analysisFinite(r.Start) || !analysisFinite(r.End) || r.End < r.Start {
			continue
		}
		start := r.Start
		if analysisFinite(r.FreezeEnd) && r.FreezeEnd > start && r.FreezeEnd <= r.End {
			start = r.FreezeEnd
		}
		end := r.End
		if analysisFinite(r.EndedAt) && r.EndedAt >= start && r.EndedAt > r.Start && r.EndedAt <= end {
			end = r.EndedAt
		}
		windows[r.Number] = analysisRoundWindow{start, end}
	}
	return windows
}

func analysisAddRoster(rosters map[int]map[int]*analysisRoster, windows map[int]analysisRoundWindow, f Frame, normalise func(string, string) string) {
	w, ok := windows[f.Round]
	if !ok || !analysisFinite(f.T) || f.T < w.start || f.T > w.end {
		return
	}
	if rosters[f.Round] == nil {
		rosters[f.Round] = map[int]*analysisRoster{}
	}
	for _, side := range []int{2, 3} {
		if rosters[f.Round][side] == nil {
			rosters[f.Round][side] = &analysisRoster{members: map[string]bool{}, stable: map[string]bool{}, names: map[string]int{}}
		}
		name := f.TName
		if side == 3 {
			name = f.CTName
		}
		if clean := analysisClanName(name); clean != "" {
			rosters[f.Round][side].names[clean]++
		}
	}
	for _, p := range f.Players {
		id := normalise(p.ID, "")
		if id == "" || !analysisSide(p.Team) || !p.Connected {
			continue
		}
		r := rosters[f.Round][p.Team]
		r.members[id] = true
		_, stable := analysisPlayerID("", p.ID)
		if stable {
			r.stable[id] = true
		}
	}
}

func analysisDeathTimes(events []Event, windows map[int]analysisRoundWindow) map[int]map[string][]float64 {
	result := map[int]map[string][]float64{}
	for _, e := range events {
		w, ok := windows[e.Round]
		if e.Type != "kill" || e.VictimID == "" || !ok || !analysisFinite(e.T) || e.T < w.start || e.T > w.end {
			continue
		}
		if result[e.Round] == nil {
			result[e.Round] = map[string][]float64{}
		}
		result[e.Round][e.VictimID] = append(result[e.Round][e.VictimID], e.T)
	}
	for _, byPlayer := range result {
		for _, times := range byPlayer {
			sort.Float64s(times)
		}
	}
	return result
}

// Both new reports and streamed upgrades use exactly the original full-round
// observation rules: no interpolation across gaps, no time after a death.
func analysisObserveMovement(f, next Frame, windows map[int]analysisRoundWindow, deaths map[int]map[string][]float64, add func(PlayerFrame, Position, float64, float64)) {
	w, ok := windows[f.Round]
	if !ok || !analysisFinite(f.T) || next.Round != f.Round || !analysisFinite(next.T) || next.T <= f.T {
		return
	}
	start := math.Max(f.T, w.start)
	end := math.Min(math.Min(next.T, f.T+.25), w.end)
	if end <= start {
		return
	}
	for _, p := range f.Players {
		if !p.Alive || !p.Connected || !analysisSide(p.Team) || p.ID == "" {
			continue
		}
		pos := Position{p.X, p.Y, p.Z}
		if !analysisPosition(&pos) {
			continue
		}
		playerEnd := end
		if times := deaths[f.Round][p.ID]; len(times) > 0 {
			n := sort.SearchFloat64s(times, f.T)
			if n < len(times) {
				playerEnd = math.Min(playerEnd, times[n])
			}
		}
		if playerEnd > start {
			add(p, pos, start, playerEnd)
		}
	}
}

func analysisMovementAnchors(rounds []Round) map[int]*float64 {
	unique := analysisTimingRounds(rounds)
	result := map[int]*float64{}
	for number, r := range unique {
		// Share the utility timing evidence rules, including old caches that used
		// round start as a missing freeze-end placeholder.
		if elapsed, _ := analysisUtilityTiming(Utility{Round: number, Start: r.FreezeEnd, ThrowObserved: true}, unique); elapsed != nil {
			anchor := r.FreezeEnd
			result[number] = &anchor
		}
	}
	return result
}

func (a *analysisMovementAccumulator) add(p Position, start, end float64, anchor *float64) {
	if !analysisPosition(&p) || !analysisFinite(start) || !analysisFinite(end) || end <= start {
		return
	}
	g := analysisGrid(p)
	addUntimed := func(seconds float64, unknown bool) {
		if seconds <= 0 {
			return
		}
		if a.untimed == nil {
			a.untimed = map[analysisGridKey]*analysisMovementValue{}
		}
		v := a.untimed[g]
		if v == nil {
			v = &analysisMovementValue{}
			a.untimed[g] = v
		}
		if unknown {
			v.unknown += seconds
		} else {
			v.beyond += seconds
		}
		v.seconds += seconds
		v.zSum += p.Z * seconds
	}
	if anchor == nil || !analysisFinite(*anchor) || start < *anchor {
		addUntimed(end-start, true)
		return
	}
	start -= *anchor
	end -= *anchor
	if end > 115 {
		addUntimed(end-math.Max(start, 115), false)
	}
	end = math.Min(end, 115)
	if a.timed == nil {
		a.timed = map[analysisMovementKey]*analysisMovementValue{}
	}
	for start < end {
		second := int(math.Floor(start))
		stop := math.Min(end, float64(second+1))
		seconds := stop - start
		key := analysisMovementKey{g, second}
		v := a.timed[key]
		if v == nil {
			v = &analysisMovementValue{}
			a.timed[key] = v
		}
		v.seconds += seconds
		v.zSum += p.Z * seconds
		start = stop
	}
}

func (a *analysisMovementAccumulator) fill(out *AnalysisSeries) {
	out.MovementTimeline = []AnalysisMovementCell{}
	out.MovementUntimedCells = []AnalysisMovementUntimedCell{}
	out.MovementUnknownSeconds, out.MovementBeyondSeconds = 0, 0
	for k, v := range a.timed {
		out.MovementTimeline = append(out.MovementTimeline, AnalysisMovementCell{(float64(k.grid.x) + .5) * analysisCellSize, (float64(k.grid.y) + .5) * analysisCellSize, math.Round(v.zSum/v.seconds*100) / 100, float64(k.second), v.seconds})
	}
	for g, v := range a.untimed {
		out.MovementUntimedCells = append(out.MovementUntimedCells, AnalysisMovementUntimedCell{(float64(g.x) + .5) * analysisCellSize, (float64(g.y) + .5) * analysisCellSize, math.Round(v.zSum/v.seconds*100) / 100, v.unknown, v.beyond})
	}
	sort.Slice(out.MovementTimeline, func(i, j int) bool {
		for n := 0; n < 4; n++ {
			if out.MovementTimeline[i][n] != out.MovementTimeline[j][n] {
				return out.MovementTimeline[i][n] < out.MovementTimeline[j][n]
			}
		}
		return false
	})
	sort.Slice(out.MovementUntimedCells, func(i, j int) bool {
		for n := 0; n < 3; n++ {
			if out.MovementUntimedCells[i][n] != out.MovementUntimedCells[j][n] {
				return out.MovementUntimedCells[i][n] < out.MovementUntimedCells[j][n]
			}
		}
		return false
	})
	for _, row := range out.MovementUntimedCells {
		out.MovementUnknownSeconds += row[3]
		out.MovementBeyondSeconds += row[4]
	}
}
