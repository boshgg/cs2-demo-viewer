package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

var errAnalysisUpgradeStale = errors.New("analysis upgrade revision is no longer current")

type analysisTimingReplay struct {
	ID            string    `json:"id"`
	Map           string    `json:"map"`
	Rounds        []Round   `json:"rounds"`
	Utilities     []Utility `json:"utilities"`
	Events        []Event   `json:"events"`
	FramesPresent bool      `json:"-"`
}

type analysisUpgradeSnapshot struct {
	job                           *job
	id, revision, replay, summary string
	mapName                       string
}

type analysisCacheFingerprint struct {
	Size, Modified int64
	Exists         bool
}

type analysisUpgradeFailure struct {
	Revision        string
	Replay, Summary analysisCacheFingerprint
	At              time.Time
}

func analysisFingerprint(path string) analysisCacheFingerprint {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return analysisCacheFingerprint{}
	}
	return analysisCacheFingerprint{Size: info.Size(), Modified: info.ModTime().UnixNano(), Exists: true}
}

func (a *app) currentAnalysisUpgradeLocked(snapshot analysisUpgradeSnapshot) bool {
	j := snapshot.job
	return a.jobs[snapshot.id] == j && j.Status == "ready" && j.Revision == snapshot.revision && j.result == snapshot.replay && j.analysisResult == snapshot.summary && a.ctx.Err() == nil && (j.ctx == nil || j.ctx.Err() == nil)
}

func (a *app) currentAnalysisUpgrade(snapshot analysisUpgradeSnapshot) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	snapshot.job.mu.Lock()
	defer snapshot.job.mu.Unlock()
	return a.currentAnalysisUpgradeLocked(snapshot)
}

// Decode a bounded gzip JSON document and verify its complete trailer. Runtime
// replay upgrades use streamAnalysisReplay so the frame array is never retained.
func readAnalysisTimingJSON(ctx context.Context, path string, limit int64, out any) error {
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
	reader := &io.LimitedReader{R: contextReader{ctx, gz}, N: limit + 1}
	decoder := json.NewDecoder(reader)
	if err = decoder.Decode(out); err != nil {
		return err
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("invalid JSON or gzip trailer: %v", err)
	}
	if reader.N <= 0 {
		return fmt.Errorf("analysis cache exceeds its size limit")
	}
	return ctx.Err()
}

const analysisTimingUnavailableWarning = "道具投掷时机暂无法从完整回放缓存补齐，已归入“时机未知”；原有热力图和道具数量不变。可重新读取，或在原录像可用时重新解析。"

// One-second spatial bins can exceed the former 64 MiB summary limit in long
// recordings. The app-wide upgrade gate still permits only one decode at a time.
const analysisSummaryReadLimit int64 = 256 << 20

// All existing fields remain raw JSON, including team/player IDs and future
// fields this binary does not know about. This function only patches utilities;
// movement timing is upgraded separately without rewriting existing cell values.
func patchAnalysisUtilityTiming(summary map[string]json.RawMessage, replay *analysisTimingReplay) error {
	var utilities []map[string]json.RawMessage
	if raw := summary["utilities"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &utilities); err != nil {
			return err
		}
	}
	rounds := map[int]Round{}
	observed := map[string]Utility{}
	ambiguous := map[string]bool{}
	if replay != nil {
		rounds = analysisTimingRounds(replay.Rounds)
		for _, utility := range replay.Utilities {
			if _, exists := observed[utility.ID]; exists {
				ambiguous[utility.ID] = true
			}
			observed[utility.ID] = utility
		}
	}
	for _, raw := range utilities {
		if raw == nil {
			continue
		}
		var previous struct {
			ID            string  `json:"id"`
			Type          string  `json:"type"`
			Round         int     `json:"round"`
			Time          float64 `json:"time"`
			ThrowObserved bool    `json:"throwObserved"`
		}
		body, err := json.Marshal(raw)
		if err != nil {
			return err
		}
		var elapsed *float64
		source := "unknown"
		if err := json.Unmarshal(body, &previous); err == nil {
			if original, found := observed[previous.ID]; found && !ambiguous[previous.ID] && previous.ThrowObserved && original.ThrowObserved && previous.Round == original.Round && previous.Type == original.Type && previous.Time == original.Start {
				elapsed, source = analysisUtilityTiming(original, rounds)
			}
		}
		raw["roundElapsed"], _ = json.Marshal(elapsed)
		raw["timeSource"], _ = json.Marshal(source)
	}
	if _, exists := summary["utilities"]; exists {
		summary["utilities"], _ = json.Marshal(utilities)
	}
	if replay != nil {
		summary["utilityTimingVersion"], _ = json.Marshal(analysisUtilityTimingVersion)
	} else {
		var warnings []string
		_ = json.Unmarshal(summary["warnings"], &warnings)
		found := false
		for _, warning := range warnings {
			found = found || warning == analysisTimingUnavailableWarning
		}
		if !found {
			warnings = append(warnings, analysisTimingUnavailableWarning)
		}
		summary["warnings"], _ = json.Marshal(warnings)
	}
	return nil
}

// A nil response means the existing cache is current or has been atomically
// upgraded. A non-nil response is a safe unknown-timing view after an upgrade
// failure; the original summary file has not been overwritten.
func (a *app) ensureAnalysisUtilityTiming(request context.Context, j *job) ([]byte, error) {
	j.mu.Lock()
	snapshot := analysisUpgradeSnapshot{job: j, id: j.ID, revision: j.Revision, replay: j.result, summary: j.analysisResult, mapName: j.Map}
	j.mu.Unlock()
	ctx, cancel := context.WithCancel(request)
	defer cancel()
	stopApp := context.AfterFunc(a.ctx, cancel)
	defer stopApp()
	if j.ctx != nil {
		stopJob := context.AfterFunc(j.ctx, cancel)
		defer stopJob()
	}
	select {
	case a.analysisUpgradeGate <- struct{}{}:
		defer func() { <-a.analysisUpgradeGate }()
	case <-ctx.Done():
		if !a.currentAnalysisUpgrade(snapshot) {
			return nil, errAnalysisUpgradeStale
		}
		return nil, ctx.Err()
	}
	if !a.currentAnalysisUpgrade(snapshot) {
		return nil, errAnalysisUpgradeStale
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	before := analysisFingerprint(snapshot.summary)
	var summary map[string]json.RawMessage
	if err := readAnalysisTimingJSON(ctx, snapshot.summary, analysisSummaryReadLimit, &summary); err != nil {
		if !a.currentAnalysisUpgrade(snapshot) {
			return nil, errAnalysisUpgradeStale
		}
		return nil, err
	}
	if summary == nil {
		return nil, fmt.Errorf("invalid analysis summary")
	}
	if !a.currentAnalysisUpgrade(snapshot) {
		return nil, errAnalysisUpgradeStale
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var version, movementVersion, eventVersion, plantVersion int
	_ = json.Unmarshal(summary["plantPhaseVersion"], &plantVersion)
	needPlant := plantVersion < analysisPlantPhaseVersion
	_ = json.Unmarshal(summary["utilityTimingVersion"], &version)
	_ = json.Unmarshal(summary["movementTimingVersion"], &movementVersion)
	_ = json.Unmarshal(summary["eventTimingVersion"], &eventVersion)
	needUtility, needMovement := version < analysisUtilityTimingVersion, movementVersion < analysisMovementTimingVersion
	needEvents := eventVersion < analysisEventTimingVersion
	if !needUtility && !needMovement && !needEvents && !needPlant {
		return nil, nil
	}
	var id string
	_ = json.Unmarshal(summary["id"], &id)
	replayFingerprint := analysisFingerprint(snapshot.replay)
	previous, failed := a.analysisUpgradeFailures[snapshot.id]
	skipRetry := failed && previous.Revision == snapshot.revision && previous.Replay == replayFingerprint && previous.Summary == before && time.Since(previous.At) < time.Minute
	var replay analysisTimingReplay
	var upgradeErr error
	if id != snapshot.id {
		upgradeErr = fmt.Errorf("analysis identity mismatch")
	} else if skipRetry {
		upgradeErr = fmt.Errorf("unchanged cache upgrade previously failed")
	} else {
		upgradeErr = streamAnalysisReplay(ctx, snapshot.replay, &replay, nil)
		if upgradeErr == nil && (replay.ID != snapshot.id || snapshot.mapName != "" && !strings.EqualFold(replay.Map, snapshot.mapName)) {
			upgradeErr = fmt.Errorf("replay identity mismatch")
		}
	}
	if !a.currentAnalysisUpgrade(snapshot) {
		return nil, errAnalysisUpgradeStale
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if upgradeErr == nil {
		if needMovement {
			var movements map[analysisSeriesKey]*analysisMovementAccumulator
			movements, upgradeErr = upgradeAnalysisMovement(ctx, snapshot.replay, &replay)
			if upgradeErr == nil {
				upgradeErr = patchAnalysisMovementTiming(summary, movements)
			}
		}
		if upgradeErr == nil && needUtility {
			upgradeErr = patchAnalysisUtilityTiming(summary, &replay)
		}
		if upgradeErr == nil && needEvents {
			var events map[analysisSeriesKey]*analysisEventAccumulator
			events, upgradeErr = upgradeAnalysisEvents(ctx, snapshot.replay, &replay)
			if upgradeErr == nil {
				upgradeErr = patchAnalysisEventTiming(summary, events)
			}
		}
		if upgradeErr == nil && needPlant {
			upgradeErr = upgradeAnalysisPlantPhases(ctx, snapshot.replay, &replay, summary)
		}

		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if upgradeErr == nil && analysisFingerprint(snapshot.replay) != replayFingerprint {
			upgradeErr = fmt.Errorf("replay changed during timing upgrade")
		}
		if upgradeErr == nil {
			upgradeErr = a.commitAnalysisTiming(ctx, snapshot, before, summary)
		}
		if upgradeErr == nil {
			delete(a.analysisUpgradeFailures, snapshot.id)
			return nil, nil
		}
		if errors.Is(upgradeErr, errAnalysisUpgradeStale) {
			return nil, upgradeErr
		}
		// A failed atomic write must not pretend the on-disk upgrade completed.
		if needUtility {
			delete(summary, "utilityTimingVersion")
		}
		if needMovement {
			delete(summary, "movementTimingVersion")
		}
		if needEvents {
			delete(summary, "eventTimingVersion")
		}
	}
	if !skipRetry {
		a.analysisUpgradeFailures[snapshot.id] = analysisUpgradeFailure{Revision: snapshot.revision, Replay: replayFingerprint, Summary: before, At: time.Now()}
	}
	if !a.currentAnalysisUpgrade(snapshot) {
		return nil, errAnalysisUpgradeStale
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if needUtility {
		if err := patchAnalysisUtilityTiming(summary, nil); err != nil {
			return nil, err
		}
	}
	if needMovement {
		if err := patchAnalysisMovementTiming(summary, nil); err != nil {
			return nil, err
		}
	}
	if needEvents {
		if err := patchAnalysisEventTiming(summary, nil); err != nil {
			return nil, err
		}
	}
	if needPlant {
		delete(summary, "plantPhaseVersion")
		var warnings []string
		_ = json.Unmarshal(summary["warnings"], &warnings)
		warnings = append(warnings, "无法从回放缓存核实下包阶段，按下包前后筛选时将跳过这场比赛。")
		summary["warnings"], _ = json.Marshal(warnings)
	}
	return json.Marshal(summary)
}

func (a *app) commitAnalysisTiming(ctx context.Context, snapshot analysisUpgradeSnapshot, before analysisCacheFingerprint, summary map[string]json.RawMessage) error {
	f, err := os.CreateTemp(a.root, ".analysis-timing-*.tmp")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer os.Remove(temporary)
	gz, _ := gzip.NewWriterLevel(f, gzip.BestSpeed)
	err = json.NewEncoder(gz).Encode(summary)
	if closeErr := gz.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	snapshot.job.mu.Lock()
	defer snapshot.job.mu.Unlock()
	if !a.currentAnalysisUpgradeLocked(snapshot) || ctx.Err() != nil || before != analysisFingerprint(snapshot.summary) {
		return errAnalysisUpgradeStale
	}
	return os.Rename(temporary, snapshot.summary)
}
