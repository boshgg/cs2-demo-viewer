package main

import "fmt"

type statisticsRoundDeathEvidence struct {
	died   *bool
	time   *float64
	reason string
}

// Round.End is the beginning of the next round (or the recorded demo end).
// Unlike the impact model, this rule intentionally includes real deaths after
// the winner was decided. It never derives deaths from disconnects or frames.
func statisticsDeathRoundValid(r Round) bool {
	return r.Number > 0 && analysisFinite(r.Start) && analysisFinite(r.End) && r.End > r.Start
}

func statisticsConfirmedSurvivor(id string, r Round, snapshot EconomySnapshot, frames []*Frame, nextStart *float64) bool {
	if !statisticsDeathRoundValid(r) || !analysisFinite(r.FreezeEnd) || r.FreezeEnd < r.Start || r.FreezeEnd >= r.End || !analysisSide(r.Winner) || !analysisFinite(r.EndedAt) || r.EndedAt <= r.FreezeEnd || r.EndedAt > r.End {
		return false
	}
	roster, complete := impactRoster(snapshot)
	if !complete {
		return false
	}
	opening, exists := roster[id]
	if !exists {
		return false
	}
	terminalAlive := false
	for _, frame := range frames {
		if frame.T < r.FreezeEnd || frame.T > r.End || nextStart != nil && frame.T >= *nextStart {
			continue
		}
		seen := map[string]PlayerFrame{}
		for _, player := range frame.Players {
			if _, duplicate := seen[player.ID]; duplicate {
				return false
			}
			seen[player.ID] = player
		}
		player, found := seen[id]
		if !found || !player.Alive || !player.Connected || player.Team != opening.Team {
			// A dead/disconnected sample without its event is incomplete evidence,
			// not an invented death, and not proof of surviving the whole round.
			return false
		}
		end := r.End
		if nextStart != nil && *nextStart < end {
			end = *nextStart
		}
		if frame.T < r.EndedAt || end-frame.T > .250001 {
			continue
		}
		allObserved := len(seen) == len(roster)
		for participant, start := range roster {
			observed, ok := seen[participant]
			if !ok || observed.Team != start.Team {
				allObserved = false
				break
			}
		}
		terminalAlive = terminalAlive || allObserved
	}
	return terminalAlive
}

func applyStatisticsRoundDeathRule(d *DemoData, kills []KillScore, rounds []Round, snapshots map[int]EconomySnapshot, frames map[int][]*Frame) {
	roundByNumber := map[int]Round{}
	nextStarts := map[int]*float64{}
	for _, round := range rounds {
		roundByNumber[round.Number] = round
	}
	for index, round := range rounds {
		for _, following := range rounds[index+1:] {
			if following.Start > round.Start {
				start := following.Start
				nextStarts[round.Number] = &start
				break
			}
		}
	}
	// Build the complete (round, player ID) lookup once, before any UI filter
	// or aggregation. Positive death evidence also works in truncated demos.
	deaths := map[int]map[string]float64{}
	for _, event := range d.Events {
		if event.Type != "kill" && event.Type != "death" || event.VictimID == "" || !analysisFinite(event.T) {
			continue
		}
		round, exists := roundByNumber[event.Round]
		if !exists || !statisticsDeathRoundValid(round) || event.T < round.Start || event.T > round.End {
			continue
		}
		// The next observed round is a strict boundary even if a malformed or
		// old cache retained an overlapping End or an old round label.
		if start := nextStarts[round.Number]; start != nil && event.T >= *start {
			continue
		}
		// Match legacy kill scoring: use a known valid freeze boundary, but do
		// not discard a real death merely because an old cache omitted it.
		if analysisFinite(round.FreezeEnd) && round.FreezeEnd > round.Start && round.FreezeEnd <= round.End && event.T < round.FreezeEnd {
			continue
		}
		if deaths[event.Round] == nil {
			deaths[event.Round] = map[string]float64{}
		}
		previous, found := deaths[event.Round][event.VictimID]
		if !found || event.T < previous {
			deaths[event.Round][event.VictimID] = event.T
		}
	}
	evidence := map[int]map[string]statisticsRoundDeathEvidence{}
	for i := range kills {
		kill := &kills[i]
		if evidence[kill.Round] == nil {
			evidence[kill.Round] = map[string]statisticsRoundDeathEvidence{}
		}
		observed, found := evidence[kill.Round][kill.KillerID]
		if !found {
			observed.reason = "未记录到该玩家本回合死亡，但缺少完整存活证据；不推断死亡或扣负净值"
			if kill.KillerID == "" {
				observed.reason = "击杀者身份缺失，无法核验本回合死亡"
			} else if at, died := deaths[kill.Round][kill.KillerID]; died {
				value := true
				observed.died, observed.time = &value, &at
				observed.reason = "已记录同一玩家 ID 在本回合实际死亡，包含胜负确定后、下一回合开始前的死亡"
			} else if round, exists := roundByNumber[kill.Round]; exists && statisticsConfirmedSurvivor(kill.KillerID, round, snapshots[kill.Round], frames[kill.Round], nextStarts[kill.Round]) {
				value := false
				observed.died = &value
				observed.reason = "完整开局阵容及回合末存活帧确认该玩家存活，且本回合没有死亡事件"
			}
			evidence[kill.Round][kill.KillerID] = observed
		}
		kill.KillerDiedInRound, kill.KillerDeathTime, kill.KillerSurvivalReason = observed.died, observed.time, observed.reason
		if kill.Score == nil || kill.BaseScore == nil || *kill.BaseScore >= 0 {
			continue
		}
		if observed.died != nil && *observed.died {
			kill.ScoreAdjustment = "advantage_kill_round_death"
			kill.ScoreReason = fmt.Sprintf("高级枪击杀低级枪，且自己本回合有实际死亡记录，保留基础负净值 %d；死亡影响另按原规则计算", *kill.BaseScore)
		} else {
			*kill.Score = 0
			kill.ScoreAdjustment = "advantage_kill_zero"
			if observed.died != nil {
				kill.ScoreReason = "高级枪击杀低级枪，自己本回合存活，最终净值为 0"
			} else {
				kill.ScoreReason = "高级枪击杀低级枪，未记录到自己本回合实际死亡，最终净值为 0；存活证据不足不推断死亡"
			}
		}
	}
}
