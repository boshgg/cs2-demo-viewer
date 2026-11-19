package main

import (
	"math"
	"slices"
)

// x, y, metric-specific Z, signed second since plant, second since freeze end,
// metric (3 movement, 4 engagement, 5 death, 6 shot), observed value.
// Round second -1 is unknown and 115 includes everything after the countdown.
type AnalysisPlantTimeCell [7]float64

type analysisPlantTimeKey struct {
	grid                             analysisGridKey
	plantSecond, roundSecond, metric int
}

type analysisPlantTimeBins map[analysisPlantTimeKey]*analysisEventValue

func (bins analysisPlantTimeBins) add(pos Position, grid analysisGridKey, plantSecond, roundSecond, metric int, amount float64) {
	key := analysisPlantTimeKey{grid, plantSecond, roundSecond, metric}
	v := bins[key]
	if v == nil {
		v = &analysisEventValue{}
		bins[key] = v
	}
	v.count += amount
	v.zSum += amount * pos.Z
}

// Compute the current bin and its exclusive end together. Comparing the
// absolute timestamp handles floating-point cancellation at second boundaries.
func analysisPlantTimeBin(t, origin float64) (int, float64) {
	second := int(math.Floor(t - origin))
	if t >= origin+float64(second+1) {
		second++
	} else if t < origin+float64(second) {
		second--
	}
	return second, origin + float64(second+1)
}

func analysisRoundTimeBin(t float64, anchor *float64) (int, float64) {
	if anchor == nil {
		return -1, math.Inf(1)
	}
	if t < *anchor {
		return -1, *anchor
	}
	if t >= *anchor+115 {
		return 115, math.Inf(1)
	}
	return analysisPlantTimeBin(t, *anchor)
}

func (bins analysisPlantTimeBins) movement(pos Position, start, end, plant float64, anchor *float64) {
	grid := analysisGrid(pos)
	// One observed interval can cross either or both independent clocks.
	for start < end {
		plantSecond, nextPlant := analysisPlantTimeBin(start, plant)
		roundSecond, nextRound := analysisRoundTimeBin(start, anchor)
		stop := min(end, nextPlant, nextRound)
		if stop <= start { // Malformed clocks can exceed float64 second resolution.
			return
		}
		bins.add(pos, grid, plantSecond, roundSecond, 3, stop-start)
		start = stop
	}
}

func (bins analysisPlantTimeBins) rows() []AnalysisPlantTimeCell {
	if len(bins) == 0 {
		return nil
	}
	rows := make([]AnalysisPlantTimeCell, 0, len(bins))
	for k, v := range bins {
		rows = append(rows, AnalysisPlantTimeCell{
			(float64(k.grid.x) + .5) * analysisCellSize, (float64(k.grid.y) + .5) * analysisCellSize,
			math.Round(v.zSum/v.count*100) / 100, float64(k.plantSecond), float64(k.roundSecond), float64(k.metric), v.count,
		})
	}
	slices.SortFunc(rows, func(a, b AnalysisPlantTimeCell) int { return slices.Compare(a[:], b[:]) })
	return rows
}
