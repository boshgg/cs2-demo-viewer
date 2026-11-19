package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/bits"
	"slices"
)

const analysisRoundEvidenceVersion = 1

// The same round can contribute to multiple players, sides, cells and metrics.
// Each index in these parallel arrays resolves to a shared set of round numbers.
type AnalysisRoundRefs struct {
	Cells            []int `json:"cells,omitempty"`
	MovementTimeline []int `json:"movementTimeline,omitempty"`
	EventTimeline    []int `json:"eventTimeline,omitempty"`
}

// Up to 64 rounds use one word. Overtime beyond that stays representable.
type analysisRoundSet struct {
	mask  uint64
	extra []int
}

func (s *analysisRoundSet) add(round int) {
	if round < 1 {
		return
	}
	if round <= 64 {
		s.mask |= 1 << (round - 1)
		return
	}
	i, ok := slices.BinarySearch(s.extra, round)
	if !ok {
		s.extra = slices.Insert(s.extra, i, round)
	}
}
func (s analysisRoundSet) numbers() []int {
	result := make([]int, 0, bits.OnesCount64(s.mask)+len(s.extra))
	for mask := s.mask; mask != 0; mask &= mask - 1 {
		result = append(result, 1+bits.TrailingZeros64(mask))
	}
	return append(result, s.extra...)
}

type analysisRoundDictionary struct {
	sets  [][]int
	short map[uint64]int
	long  map[string]int
}

func newAnalysisRoundDictionary() *analysisRoundDictionary {
	return &analysisRoundDictionary{sets: [][]int{{}}, short: map[uint64]int{0: 0}, long: map[string]int{}}
}
func (d *analysisRoundDictionary) index(s analysisRoundSet) int {
	if len(s.extra) == 0 {
		if ref, ok := d.short[s.mask]; ok {
			return ref
		}
		d.short[s.mask] = len(d.sets)
	} else {
		key := fmt.Sprint(s.mask, s.extra)
		if ref, ok := d.long[key]; ok {
			return ref
		}
		d.long[key] = len(d.sets)
	}
	ref := len(d.sets)
	d.sets = append(d.sets, s.numbers())
	return ref
}

// Match against the actual serialized rows. This preserves their order and
// their weighted elevations, including old summaries with different ordering.
type analysisRoundRow struct {
	x, y, z, amount      float64
	clock, plant, metric int
}
type analysisRoundLookup map[analysisRoundRow]analysisRoundSet

func (r analysisRoundLookup) put(g analysisGridKey, z, amount float64, clock, plant, metric int, s analysisRoundSet) {
	key := analysisRoundRow{(float64(g.x) + .5) * analysisCellSize, (float64(g.y) + .5) * analysisCellSize, math.Round(z*100) / 100, math.Round(amount*1e7) / 1e7, clock, plant, metric}
	other, ok := r[key]
	if ok {
		// Distinct vertical cells can serialize to the same rounded position.
		// Both pass the same frontend filters and contribute to the same set.
		other.mask |= s.mask
		if len(s.extra) > 0 {
			other.extra = slices.Clone(other.extra)
			for _, v := range s.extra {
				other.add(v)
			}
		}
		s = other
	}
	r[key] = s
}
func (r analysisRoundLookup) ref(d *analysisRoundDictionary, x, y, z, amount float64, clock, plant, metric int) int {
	if amount <= 0 {
		return 0
	}
	s, ok := r[analysisRoundRow{x, y, z, math.Round(amount*1e7) / 1e7, clock, plant, metric}]
	if !ok {
		return -1
	} // Cached measurement could not be verified against the replay.
	return d.index(s)
}
func (d *analysisRoundDictionary) heatmap(h *AnalysisHeatmap, s *analysisSeriesValue) {
	refs := &AnalysisRoundRefs{}
	h.RoundRefs = refs
	lookup := analysisRoundLookup{}
	if s != nil {
		for grid, v := range s.cells {
			for metric := 3; metric <= 6; metric++ {
				amount := v.cell[metric]
				if metric == 3 {
					amount = math.Round(amount*10000) / 10000
				}
				if amount > 0 {
					lookup.put(grid, v.zSum/v.zWeight, amount, -1, 0, metric, v.contributors[metric-3])
				}
			}
		}
		for k, v := range s.movement.timed {
			lookup.put(k.grid, v.zSum/v.seconds, v.seconds, k.second, 0, 3, v.contributors)
		}
		for k, v := range s.events.bins {
			if k.second >= 0 && k.second < 115 {
				lookup.put(k.grid, v.zSum/v.count, v.count, k.second, 0, k.metric, v.contributors)
			}
		}
	}
	for _, r := range h.Cells {
		for m := 3; m <= 6; m++ {
			refs.Cells = append(refs.Cells, lookup.ref(d, r[0], r[1], r[2], r[m], -1, 0, m))
		}
	}
	for _, r := range h.MovementTimeline {
		refs.MovementTimeline = append(refs.MovementTimeline, lookup.ref(d, r[0], r[1], r[2], r[4], int(r[3]), 0, 3))
	}
	for _, r := range h.EventTimeline {
		ref := -1
		for m := 4; m <= 6; m++ {
			if r[m] > 0 {
				ref = lookup.ref(d, r[0], r[1], r[2], r[m], int(r[3]), 0, m)
				break
			}
		}
		refs.EventTimeline = append(refs.EventTimeline, ref)
	}
}
func (d *analysisRoundDictionary) fillSeries(out *AnalysisSeries, full *analysisSeriesValue, phases *analysisPlantPhases, key analysisSeriesKey) {
	d.heatmap(&out.AnalysisHeatmap, full)
	for _, phase := range []string{"pre", "post"} {
		if h, ok := out.PlantPhases[phase]; ok {
			d.heatmap(&h, phases.series[key][phase])
			out.PlantPhases[phase] = h
		}
	}
	lookup := analysisRoundLookup{}
	for k, v := range phases.timeline[key] {
		lookup.put(k.grid, v.zSum/v.count, v.count, k.roundSecond, k.plantSecond, k.metric, v.contributors)
	}
	out.PlantRoundRefs = nil
	for _, r := range out.PlantTimeline {
		out.PlantRoundRefs = append(out.PlantRoundRefs, lookup.ref(d, r[0], r[1], r[2], r[6], int(r[4]), int(r[3]), int(r[5])))
	}
}

func (d *analysisRoundDictionary) patch(raw map[string]json.RawMessage, full *analysisSeriesValue, phases *analysisPlantPhases, key analysisSeriesKey) error {
	var out AnalysisSeries
	body, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(body, &out); err != nil {
		return err
	}
	d.fillSeries(&out, full, phases, key)
	raw["roundRefs"], _ = json.Marshal(out.RoundRefs)
	if len(out.PlantRoundRefs) > 0 {
		raw["plantRoundRefs"], _ = json.Marshal(out.PlantRoundRefs)
	} else {
		delete(raw, "plantRoundRefs")
	}
	if len(out.PlantPhases) > 0 {
		var blocks map[string]map[string]json.RawMessage
		if err := json.Unmarshal(raw["plantPhases"], &blocks); err != nil {
			return err
		}
		for phase, h := range out.PlantPhases {
			if block := blocks[phase]; block != nil && h.RoundRefs != nil {
				block["roundRefs"], _ = json.Marshal(h.RoundRefs)
			}
		}
		raw["plantPhases"], _ = json.Marshal(blocks)
	}
	return nil
}
