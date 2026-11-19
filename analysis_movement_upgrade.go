package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
)

// Visit the replay as a stream. Large arrays are decoded one record at a time;
// neither the JSON decoder nor the caller retains an entire frame array. Every
// pass verifies the gzip CRC/trailer, size limit, cancellation and JSON end.
func streamAnalysisReplay(ctx context.Context, path string, metadata *analysisTimingReplay, visit func(Frame)) error {
	return streamAnalysisReplayWithVisitor(ctx, path, metadata, analysisReplayVisitor{frame: visit})
}

type analysisReplayVisitor struct {
	frame  func(Frame)
	damage func(DamageEvent)
	death  func(Event)
	shot   func(Shot)
}

func streamAnalysisReplayWithVisitor(ctx context.Context, path string, metadata *analysisTimingReplay, visit analysisReplayVisitor) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	r := &io.LimitedReader{R: contextReader{ctx, gz}, N: maxUploadBytes + 1}
	d := json.NewDecoder(r)
	first, err := d.Token()
	if err != nil {
		return err
	}
	if first != json.Delim('{') {
		return fmt.Errorf("replay must be an object")
	}
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return fmt.Errorf("invalid or duplicate replay field")
		}
		seen[key] = true
		var target any
		if metadata != nil {
			switch key {
			case "id":
				target = &metadata.ID
			case "map":
				target = &metadata.Map
			case "rounds":
				target = &metadata.Rounds
			case "events":
				target = &metadata.Events
			case "utilities":
				target = &metadata.Utilities
			}
		}
		if target != nil {
			if err := d.Decode(target); err != nil {
				return err
			}
			continue
		}
		if key == "frames" || key == "shots" || key == "damage" || key == "events" || key == "utilities" || key == "rounds" || key == "players" {
			begin, err := d.Token()
			if err != nil {
				return err
			}
			if begin == nil {
				continue
			}
			if begin != json.Delim('[') {
				return fmt.Errorf("invalid replay array %s", key)
			}
			if key == "frames" && metadata != nil {
				metadata.FramesPresent = true
			}
			for d.More() {
				if key == "frames" && visit.frame != nil {
					var frame Frame
					if err := d.Decode(&frame); err != nil {
						return err
					}
					visit.frame(frame)
				} else if key == "damage" && visit.damage != nil {
					var event DamageEvent
					if err := d.Decode(&event); err != nil {
						return err
					}
					visit.damage(event)
				} else if key == "events" && visit.death != nil {
					var event Event
					if err := d.Decode(&event); err != nil {
						return err
					}
					visit.death(event)
				} else if key == "shots" && visit.shot != nil {
					var event Shot
					if err := d.Decode(&event); err != nil {
						return err
					}
					visit.shot(event)
				} else {
					var discard json.RawMessage
					if err := d.Decode(&discard); err != nil {
						return err
					}
				}
			}
			if _, err = d.Token(); err != nil {
				return err
			}
		} else {
			var discard json.RawMessage
			if err := d.Decode(&discard); err != nil {
				return err
			}
		}
	}
	if _, err = d.Token(); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return fmt.Errorf("invalid JSON or gzip trailer: %v", err)
	}
	if r.N <= 0 {
		return fmt.Errorf("replay cache exceeds its size limit")
	}
	return ctx.Err()
}

// Resolve the same round rosters as BuildAnalysis, then accumulate one-second
// spatial bins using only two adjacent frames. No parse, manifest write, or job
// revision change is needed to upgrade a retained replay cache.
func upgradeAnalysisMovement(ctx context.Context, path string, replay *analysisTimingReplay) (map[analysisSeriesKey]*analysisMovementAccumulator, error) {
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
	deaths := analysisDeathTimes(replay.Events, windows)
	anchors := analysisMovementAnchors(replay.Rounds)
	result := map[analysisSeriesKey]*analysisMovementAccumulator{}
	var previous *Frame
	err := streamAnalysisReplay(ctx, path, nil, func(next Frame) {
		if previous != nil {
			f := *previous
			analysisObserveMovement(f, next, windows, deaths, func(p PlayerFrame, pos Position, start, end float64) {
				team := "demo:" + replay.ID + ":team:unknown"
				if g := teams[f.Round][p.Team]; g != nil {
					team = g.team.ID
				}
				key := analysisSeriesKey{player: normalise(p.ID, ""), team: team, side: p.Team}
				value := result[key]
				if value == nil {
					value = &analysisMovementAccumulator{}
					result[key] = value
				}
				value.add(pos, start, end, anchors[f.Round], f.Round)
			})
		}
		previous = &next
	})
	return result, err
}

const analysisMovementUnavailableWarning = "部分移动时间无法从完整回放缓存补齐，已标记为时间未知；整回合热力图、分组和其他统计保持不变。可重新读取，或在原录像可用时重新解析。"

func patchAnalysisMovementTiming(summary map[string]json.RawMessage, movements map[analysisSeriesKey]*analysisMovementAccumulator) error {
	var series []map[string]json.RawMessage
	if raw := summary["series"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &series); err != nil {
			return err
		}
	}
	unknown := movements == nil
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
		value := movements[analysisSeriesKey{original.PlayerID, original.TeamID, original.Side}]
		if value == nil {
			value = &analysisMovementAccumulator{}
		}
		value.fill(&out)
		var total float64
		for _, c := range original.Cells {
			total += c[3]
		}
		timed := out.MovementUnknownSeconds + out.MovementBeyondSeconds
		for _, c := range out.MovementTimeline {
			timed += c[4]
		}
		// Existing cells were rounded independently to four decimals. A mismatch
		// beyond that error means an old identity/rule cannot be safely matched;
		// retain its movement as unknown rather than manufacturing timed samples.
		if movements == nil || math.Abs(total-timed) > float64(len(original.Cells))*.000051+1e-7 {
			unknown = true
			out.MovementTimeline = []AnalysisMovementCell{}
			out.MovementUntimedCells = []AnalysisMovementUntimedCell{}
			out.MovementUnknownSeconds, out.MovementBeyondSeconds = 0, 0
			for _, c := range original.Cells {
				if c[3] > 0 {
					out.MovementUntimedCells = append(out.MovementUntimedCells, AnalysisMovementUntimedCell{c[0], c[1], c[2], c[3], 0})
					out.MovementUnknownSeconds += c[3]
				}
			}
		}
		raw["movementTimeline"], _ = json.Marshal(out.MovementTimeline)
		raw["movementUntimedCells"], _ = json.Marshal(out.MovementUntimedCells)
		raw["movementUnknownSeconds"], _ = json.Marshal(out.MovementUnknownSeconds)
		raw["movementBeyondSeconds"], _ = json.Marshal(out.MovementBeyondSeconds)
	}
	if _, exists := summary["series"]; exists {
		summary["series"], _ = json.Marshal(series)
	}
	if movements != nil {
		summary["movementTimingVersion"], _ = json.Marshal(analysisMovementTimingVersion)
	}
	if unknown {
		var warnings []string
		_ = json.Unmarshal(summary["warnings"], &warnings)
		found := false
		for _, w := range warnings {
			found = found || w == analysisMovementUnavailableWarning
		}
		if !found {
			warnings = append(warnings, analysisMovementUnavailableWarning)
		}
		summary["warnings"], _ = json.Marshal(warnings)
	}
	return nil
}
