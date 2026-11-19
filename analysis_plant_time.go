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

func (bins analysisPlantTimeBins) add(pos Position, grid analysisGridKey, plantSecond, roundSecond, metric int, amount float64, round int) {
	key := analysisPlantTimeKey{grid, plantSecond, roundSecond, metric}
	v := bins[key]
	if v == nil {
		v = &analysisEventValue{}
		bins[key] = v
	}
	v.contributors.add(round)
	v.count += amount
	v.zSum += amount * pos.Z
}

// Compute the current bin and its exclusive end together. Comparing the
// absolute timestamp handles floating-point cancellation at second boundaries.
func analysisPlantTimeBin(t, origin float64) (int, float64) {
	second := int(math.Floor(t - origin))
	// Replay timestamps are decimal seconds. For example, adding a binary
	// float second to 0.14 points *past* the recorded timestamp 1.14.
	// Use exact integer microseconds when the origin roundtrips without loss.
	const scale = 1_000_000
	originMicros := math.Round(origin * scale)
	decimalClock := math.Abs(origin) < 1<<32 && math.Abs(t) < 1<<32 && originMicros/scale == origin
	boundary := func(n int) float64 {
		if decimalClock {
			return float64(int64(originMicros)+int64(n)*scale) / scale
		}
		return origin + float64(n)
	}
	if t >= boundary(second+1) {
		second++
	} else if t < boundary(second) {
		second--
	}
	return second, boundary(second + 1)
}

func analysisRoundTimeBin(t float64, anchor *float64) (int, float64) {
	if anchor == nil {
		return -1, math.Inf(1)
	}
	if t < *anchor {
		return -1, *anchor
	}
	second, next := analysisPlantTimeBin(t, *anchor)
	if second >= 115 {
		return 115, math.Inf(1)
	}
	return second, next
}

func (bins analysisPlantTimeBins) movement(pos Position, start, end, plant float64, anchor *float64, round int) {
	grid := analysisGrid(pos)
	// One observed interval can cross either or both independent clocks.
	for start < end {
		plantSecond, nextPlant := analysisPlantTimeBin(start, plant)
		roundSecond, nextRound := analysisRoundTimeBin(start, anchor)
		stop := min(end, nextPlant, nextRound)
		if stop <= start { // Malformed clocks can exceed float64 second resolution.
			return
		}
		bins.add(pos, grid, plantSecond, roundSecond, 3, stop-start, round)
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
