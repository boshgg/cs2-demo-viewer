package main

import (
	"context"
	"encoding/json"
	"fmt"
)

// Upgrade only event timing: frames are streamed for roster identity, then event
// records are visited one at a time. Existing movement bins are never rebuilt.
func upgradeAnalysisEvents(ctx context.Context, path string, replay *analysisTimingReplay) (map[analysisSeriesKey]*analysisEventAccumulator, error) {
	if replay == nil || !replay.FramesPresent {
		return nil, fmt.Errorf("replay has no frame array")
	}
	windows := analysisWindows(replay.Rounds)
	rosters := map[int]map[int]*analysisRoster{}
	normalise := func(raw, name string) string {
		if raw == "" {
			return ""
		}
		id, _ := analysisPlayerID(replay.ID, raw)
		return id
	}
	if err := streamAnalysisReplay(ctx, path, nil, func(f Frame) { analysisAddRoster(rosters, windows, f, normalise) }); err != nil {
		return nil, err
	}
	teams, _ := analysisIdentifyTeams(replay.ID, windows, rosters)
	anchors := analysisMovementAnchors(replay.Rounds)
	result := map[analysisSeriesKey]*analysisEventAccumulator{}
	observer := analysisEventObserver{
		windows: windows, seen: map[analysisEngagementKey]bool{},
		key: func(raw, name string, round, side int) analysisSeriesKey {
			team := "demo:" + replay.ID + ":team:unknown"
			if g := teams[round][side]; g != nil {
				team = g.team.ID
			}
			return analysisSeriesKey{normalise(raw, name), team, side}
		},
		add: func(key analysisSeriesKey, pos Position, metric, round int, when float64) {
			v := result[key]
			if v == nil {
				v = &analysisEventAccumulator{}
				result[key] = v
			}
			v.add(pos, metric, when, anchors[round])
		},
	}
	err := streamAnalysisReplayWithVisitor(ctx, path, nil, analysisReplayVisitor{damage: observer.damage, death: observer.death, shot: observer.shot})
	return result, err
}

const analysisEventUnavailableWarning = "部分交火、死亡或开火事件的回合时间无法从完整回放缓存补齐，已标记为时间未知；整回合热力图、移动时间数据、分组和其他统计保持不变。可重新读取，或在原录像可用时重新解析。"

// Raw maps preserve all old fields, notably cells and the movement timeline.
// If a metric cannot be reconciled with its old count, keep only that metric
// unknown; the old full count remains authoritative and is never replaced.
func patchAnalysisEventTiming(summary map[string]json.RawMessage, events map[analysisSeriesKey]*analysisEventAccumulator) error {
	var series []map[string]json.RawMessage
	if raw := summary["series"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &series); err != nil {
			return err
		}
	}
	unknown := events == nil
	for _, raw := range series {
		if raw == nil {
			continue
		}
		var original AnalysisSeries
		body, err := json.Marshal(raw)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(body, &original); err != nil {
			return err
		}
		out := AnalysisSeries{}
		value := events[analysisSeriesKey{original.PlayerID, original.TeamID, original.Side}]
		if value == nil {
			value = &analysisEventAccumulator{}
		}
		value.fill(&out)
		var totals, partition [3]float64
		for _, row := range original.Cells {
			for metric := 0; metric < 3; metric++ {
				totals[metric] += row[metric+4]
			}
		}
		for _, row := range out.EventTimeline {
			for metric := 0; metric < 3; metric++ {
				partition[metric] += row[metric+4]
			}
		}
		for _, row := range out.EventUntimedCells {
			for metric := 0; metric < 3; metric++ {
				partition[metric] += row[metric+3] + row[metric+6]
			}
		}
		for metric := 0; metric < 3; metric++ {
			if events != nil && totals[metric] == partition[metric] {
				continue
			}
			unknown = true
			timed := out.EventTimeline[:0]
			for _, row := range out.EventTimeline {
				row[metric+4] = 0
				if row[4]+row[5]+row[6] > 0 {
					timed = append(timed, row)
				}
			}
			out.EventTimeline = timed
			untimed := out.EventUntimedCells[:0]
			for _, row := range out.EventUntimedCells {
				row[metric+3], row[metric+6] = 0, 0
				if row[3]+row[4]+row[5]+row[6]+row[7]+row[8] > 0 {
					untimed = append(untimed, row)
				}
			}
			out.EventUntimedCells = untimed
			for _, cell := range original.Cells {
				if cell[metric+4] > 0 {
					row := AnalysisEventUntimedCell{cell[0], cell[1], cell[2]}
					row[metric+3] = cell[metric+4]
					out.EventUntimedCells = append(out.EventUntimedCells, row)
				}
			}
		}
		raw["eventTimeline"], _ = json.Marshal(out.EventTimeline)
		raw["eventUntimedCells"], _ = json.Marshal(out.EventUntimedCells)
	}
	if _, exists := summary["series"]; exists {
		summary["series"], _ = json.Marshal(series)
	}
	if events != nil {
		summary["eventTimingVersion"], _ = json.Marshal(analysisEventTimingVersion)
	}
	if unknown {
		var warnings []string
		_ = json.Unmarshal(summary["warnings"], &warnings)
		found := false
		for _, w := range warnings {
			found = found || w == analysisEventUnavailableWarning
		}
		if !found {
			warnings = append(warnings, analysisEventUnavailableWarning)
		}
		summary["warnings"], _ = json.Marshal(warnings)
	}
	return nil
}
