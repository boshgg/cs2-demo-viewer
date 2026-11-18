package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"slices"
)

const maxInsightsDemos = 8

type insightsRequest struct {
	DemoIDs  []string `json:"demoIds"`
	PlayerID string   `json:"playerId,omitempty"`
	Team     string   `json:"team,omitempty"`
}

type insightsError struct {
	status  int
	message string
}

func (e *insightsError) Error() string { return e.message }

func writeInsightsError(w http.ResponseWriter, err error) {
	var e *insightsError
	switch {
	case errors.As(err, &e):
		apiError(w, e.status, e.message)
	case errors.Is(err, context.DeadlineExceeded):
		apiError(w, http.StatusGatewayTimeout, "生成比赛证据超时，请缩小选场范围")
	case errors.Is(err, context.Canceled):
		apiError(w, http.StatusRequestTimeout, "请求已取消")
	default:
		apiError(w, http.StatusInternalServerError, "生成比赛证据失败")
	}
}

// Impact metrics are reported only for rounds meeting the existing 5v5
// reconstruction requirements. Raw event counts remain useful with partial POVs.
type insightsPlayer struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Matches        int             `json:"matches"`
	ObservedRounds int             `json:"observedRounds"`
	RecordedKills  int             `json:"recordedKills"`
	RecordedDeaths int             `json:"recordedDeaths"`
	ScoredGunKills int             `json:"scoredGunKills"`
	GunNetScore    int             `json:"gunNetScore"`
	Verified       *insightsImpact `json:"verifiedImpact"`
}

type insightsImpact struct {
	Rounds        int `json:"rounds"`
	ApproxRounds  int `json:"approxRounds"`
	OpeningDeaths int `json:"openingDeaths"`
	KillPoints    int `json:"killPoints"`
	DeathPoints   int `json:"deathPoints"`
}

type insightsSide struct {
	Observed int `json:"observedRounds"`
	Decided  int `json:"decidedRounds"`
	Won      int `json:"wonRounds"`
}

type insightsTeam struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Matches           int             `json:"matches"`
	CT                insightsSide    `json:"ct"`
	T                 insightsSide    `json:"t"`
	AfterOpeningKill  insightsOutcome `json:"afterOpeningKill"`
	AfterOpeningDeath insightsOutcome `json:"afterOpeningDeath"`
}

type insightsOutcome struct {
	Rounds int `json:"rounds"`
	Wins   int `json:"wins"`
}

type insightsOpening struct {
	Round         int     `json:"round"`
	Seconds       float64 `json:"demoSeconds"`
	KillerID      string  `json:"killerId"`
	VictimID      string  `json:"victimId"`
	VictimSide    int     `json:"victimSide"`
	VictimOutcome string  `json:"victimRoundOutcome"`
	Approx        bool    `json:"approximate"`
}

type insightsMatch struct {
	DemoID             string            `json:"demoId"`
	Revision           string            `json:"revision,omitempty"`
	Map                string            `json:"map"`
	RoundCount         int               `json:"roundCount"`
	SourceWarningCount int               `json:"sourceWarningCount"`
	Players            []insightsPlayer  `json:"players"`
	Teams              []insightsTeam    `json:"teams"`
	Openings           []insightsOpening `json:"openingExamples"`
}

type insightsReport struct {
	Synthetic         bool             `json:"synthetic"`
	StatisticsVersion string           `json:"statisticsVersion"`
	Matches           []insightsMatch  `json:"matches"`
	Players           []insightsPlayer `json:"players"`
	Teams             []insightsTeam   `json:"teams"`
	Notes             []string         `json:"notes"`
}

func (req insightsRequest) validate() error {
	if len(req.DemoIDs) == 0 || len(req.DemoIDs) > maxInsightsDemos {
		return &insightsError{400, "请选择 1–8 场录像"}
	}
	if req.PlayerID != "" && req.Team != "" || len(req.PlayerID) > 256 || len(req.Team) > 512 {
		return &insightsError{400, "请选择一个有效的玩家 ID 或队伍 ID，两者不能同时指定"}
	}
	seen := make(map[string]bool)
	for _, id := range req.DemoIDs {
		if id == "sample" && len(req.DemoIDs) != 1 {
			return &insightsError{400, "合成示例只能单独分析"}
		}
		if (id != "sample" && !validSessionID(id)) || seen[id] {
			return &insightsError{400, "录像 ID 无效或重复"}
		}
		seen[id] = true
	}
	return nil
}

func (a *app) insightsEvidence(w http.ResponseWriter, r *http.Request) {
	var req insightsRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil || decoder.Decode(new(any)) != io.EOF {
		apiError(w, 400, "分析请求须为包含 demoIds 的 JSON 对象")
		return
	}
	report, err := a.buildInsightsEvidence(r.Context(), req)
	if err != nil {
		writeInsightsError(w, err)
		return
	}
	jsonResponse(w, 200, report)
}

func (a *app) buildInsightsEvidence(ctx context.Context, req insightsRequest) (*insightsReport, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopApp := context.AfterFunc(a.ctx, cancel)
	defer stopApp()
	report := &insightsReport{
		StatisticsVersion: StatisticsVersion,
		Players:           []insightsPlayer{}, Teams: []insightsTeam{},
		Notes: []string{
			"样本为所选录像。matches[].roundCount 为该录像的有效回合数；玩家与队伍的 matches 只统计其出现的比赛。稳定 Steam ID 可跨录像合并，其余玩家 ID 按录像隔离。队伍依战队名或阵容识别，换边按每回合归属。",
			"recordedKills 和 recordedDeaths 是统计页记录的事件计数，可能含回合外、非敌对或无法计分的事件。gunNetScore 仅累加 scoredGunKills 次枪械对位计分。",
			"verifiedImpact 为有完整开局与回合结果的可核验样本，缺少覆盖时为 null。净影响为 killPoints 与负数 deathPoints 之和；每回合影响的分母为 verifiedImpact.rounds。openingDeaths 为计入复盘模型的敌对首死。它们是录像内复盘指标，不能直接换算段位或全服百分位。",
			"队伍胜率用同侧 wonRounds / decidedRounds，分母为 0 时未知。openingExamples 每场最多给出前四次符合筛选的可核验敌对首死，demoSeconds 为录像绝对秒数。",
			"afterOpeningKill 和 afterOpeningDeath 分别统计队伍取得首杀、遭遇首死后赢下的回合与样本数，仅包含可核验的敌对开局交锋。sourceWarningCount 为录像原始警告数，可在回放中查看数据限制。",
		},
	}
	players := make(map[string]insightsPlayer)
	teams := make(map[string]insightsTeam)
	var snapshots []statisticsSnapshot
	for _, id := range req.DemoIDs {
		match, synthetic, snapshot, err := a.insightsMatchForID(ctx, id, req)
		if err != nil {
			return nil, err
		}
		if synthetic && len(req.DemoIDs) != 1 {
			return nil, &insightsError{400, "合成录像只能单独分析"}
		}
		report.Synthetic = synthetic
		report.Matches = append(report.Matches, match)
		for _, p := range match.Players {
			total := players[p.ID]
			total.add(p)
			players[p.ID] = total
		}
		for _, t := range match.Teams {
			total := teams[t.ID]
			total.ID, total.Name = t.ID, t.Name
			total.Matches++
			total.CT.add(t.CT)
			total.T.add(t.T)
			total.AfterOpeningKill.Rounds += t.AfterOpeningKill.Rounds
			total.AfterOpeningKill.Wins += t.AfterOpeningKill.Wins
			total.AfterOpeningDeath.Rounds += t.AfterOpeningDeath.Rounds
			total.AfterOpeningDeath.Wins += t.AfterOpeningDeath.Wins
			teams[t.ID] = total
		}
		if snapshot.job != nil {
			snapshots = append(snapshots, snapshot)
		}
	}
	for _, snapshot := range snapshots {
		if !a.currentStatisticsSnapshot(snapshot) {
			return nil, staleInsights()
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if (req.PlayerID != "" && len(players) == 0) || (req.Team != "" && len(teams) == 0) {
		return nil, &insightsError{422, "所选录像没有该目标，请从未筛选证据中的 players 或 teams 选择 ID"}
	}
	for _, id := range slices.Sorted(maps.Keys(players)) {
		report.Players = append(report.Players, players[id])
	}
	for _, id := range slices.Sorted(maps.Keys(teams)) {
		report.Teams = append(report.Teams, teams[id])
	}
	if report.Synthetic {
		report.Notes = append(report.Notes, "合成示例仅供验证功能，不能据此评价真实选手或战队。")
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		return nil, err
	}
	if len(encoded) > 128<<10 {
		return nil, &insightsError{422, "所选录像产生的证据超过 128 KiB，请减少场数或指定玩家、队伍"}
	}
	return report, nil
}

func (p *insightsPlayer) add(part insightsPlayer) {
	p.ID, p.Name = part.ID, part.Name
	p.Matches += part.Matches
	p.ObservedRounds += part.ObservedRounds
	p.RecordedKills += part.RecordedKills
	p.RecordedDeaths += part.RecordedDeaths
	p.ScoredGunKills += part.ScoredGunKills
	p.GunNetScore += part.GunNetScore
	if v := part.Verified; v != nil {
		if p.Verified == nil {
			p.Verified = &insightsImpact{}
		}
		p.Verified.Rounds += v.Rounds
		p.Verified.ApproxRounds += v.ApproxRounds
		p.Verified.KillPoints += v.KillPoints
		p.Verified.DeathPoints += v.DeathPoints
		p.Verified.OpeningDeaths += v.OpeningDeaths
	}
}

func (s *insightsSide) add(part insightsSide) {
	s.Observed += part.Observed
	s.Decided += part.Decided
	s.Won += part.Won
}

func staleInsights() error {
	return &insightsError{409, "录像已更新或移除，请重新选择并重试"}
}

// Decode and derive one recording at a time; share the normal statistics
// concurrency limit so an Agent cannot load a second full replay alongside it.
func (a *app) insightsMatchForID(ctx context.Context, id string, req insightsRequest) (insightsMatch, bool, statisticsSnapshot, error) {
	var snapshot statisticsSnapshot
	var empty insightsMatch
	if id != "sample" {
		a.mu.Lock()
		j := a.jobs[id]
		a.mu.Unlock()
		if j == nil {
			return empty, false, snapshot, &insightsError{404, "所选录像不存在：" + id}
		}
		j.mu.Lock()
		if j.Status != "ready" {
			j.mu.Unlock()
			return empty, false, snapshot, &insightsError{409, "所选录像尚未完成解析：" + id}
		}
		snapshot = statisticsSnapshot{job: j, id: j.ID, revision: j.Revision, file: j.result, mapName: j.Map}
		j.mu.Unlock()
	}
	select {
	case a.statisticsGate <- struct{}{}:
		defer func() { <-a.statisticsGate }()
	case <-ctx.Done():
		return empty, false, snapshot, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return empty, false, snapshot, err
	}
	var d *DemoData
	if id == "sample" {
		d = sampleDemo()
	} else {
		if !a.currentStatisticsSnapshot(snapshot) {
			return empty, false, snapshot, staleInsights()
		}
		var err error
		d, err = readStatisticsDemo(ctx, snapshot)
		if !a.currentStatisticsSnapshot(snapshot) {
			return empty, false, snapshot, staleInsights()
		}
		if ctx.Err() != nil {
			return empty, false, snapshot, ctx.Err()
		}
		if err != nil {
			return empty, false, snapshot, &insightsError{500, "录像缓存无法读取，请重新解析：" + id}
		}
	}
	stats := BuildStatistics(d)
	if err := ctx.Err(); err != nil {
		return empty, false, snapshot, err
	}
	match := summarizeInsightsMatch(d, stats, req)
	match.Revision = snapshot.revision
	return match, d.Synthetic, snapshot, nil
}

func summarizeInsightsMatch(d *DemoData, stats *StatisticsDemo, req insightsRequest) insightsMatch {
	match := insightsMatch{
		DemoID: d.ID, Map: d.Map, RoundCount: len(stats.Rounds), SourceWarningCount: len(d.Warnings),
		Players: []insightsPlayer{}, Teams: []insightsTeam{}, Openings: []insightsOpening{},
	}
	selectedPlayers := stats.Players
	winners := make(map[int]int, len(d.Rounds))
	for _, r := range d.Rounds {
		if _, seen := winners[r.Number]; !seen && r.Number > 0 && analysisFinite(r.Start) && analysisFinite(r.End) && r.End >= r.Start {
			winners[r.Number] = r.Winner
		}
	}
	if req.Team != "" {
		selectedPlayers = nil
	}
	teamIndex := make(map[string]int)
	for _, group := range stats.Teams {
		if req.PlayerID != "" || (req.Team != "" && group.TeamKey != req.Team) {
			continue
		}
		if req.Team != "" {
			selectedPlayers = group.Players
		}
		t := insightsTeam{ID: group.TeamKey, Name: group.Label, Matches: 1}
		for _, r := range stats.Rounds {
			var side int
			var counts *insightsSide
			switch group.TeamKey {
			case r.CT.TeamKey:
				side, counts = 3, &t.CT
			case r.T.TeamKey:
				side, counts = 2, &t.T
			default:
				continue
			}
			counts.Observed++
			w := winners[r.Number]
			if analysisSide(w) {
				counts.Decided++
			}
			if w == side {
				counts.Won++
			}
		}
		teamIndex[t.ID] = len(match.Teams)
		match.Teams = append(match.Teams, t)
	}
	index := make(map[string]int)
	for _, p := range selectedPlayers {
		id, _ := analysisPlayerID(d.ID, p.ID)
		if req.PlayerID != "" && id != req.PlayerID {
			continue
		}
		index[p.ID] = len(match.Players)
		match.Players = append(match.Players, insightsPlayer{ID: id, Name: p.Name, Matches: 1, RecordedKills: p.Summary.Kills, RecordedDeaths: p.Summary.Deaths, ScoredGunKills: p.Summary.ScoredKills, GunNetScore: p.Summary.Score})
	}
	playerInScope := func(rawID, team string) *insightsPlayer {
		i, found := index[rawID]
		if !found || (req.Team != "" && req.Team != team) {
			return nil
		}
		return &match.Players[i]
	}
	for _, e := range stats.Impact.Rounds {
		p := playerInScope(e.PlayerID, e.TeamKey)
		if p == nil {
			continue
		}
		p.ObservedRounds++
		if e.Eligible {
			if p.Verified == nil {
				p.Verified = &insightsImpact{}
			}
			p.Verified.Rounds++
			if e.Approx {
				p.Verified.ApproxRounds++
			}
		}
	}
	killerTeam := make(map[int]string)
	for _, k := range stats.Impact.Kills {
		killerTeam[k.Index] = k.TeamKey
		if p := playerInScope(k.PlayerID, k.TeamKey); p != nil && k.Score != nil && p.Verified != nil {
			p.Verified.KillPoints += *k.Score
		}
	}
	for _, e := range stats.Impact.Deaths {
		if e.Penalty == nil {
			continue
		}
		victim := playerInScope(e.PlayerID, e.TeamKey)
		if victim != nil && victim.Verified != nil {
			victim.Verified.DeathPoints += *e.Penalty
			if e.FirstDeath {
				victim.Verified.OpeningDeaths++
			}
		}
		if !e.FirstDeath {
			continue
		}
		if i, found := teamIndex[e.TeamKey]; found {
			counts := &match.Teams[i].AfterOpeningDeath
			counts.Rounds++
			if e.Outcome == "win" {
				counts.Wins++
			}
		}
		if i, found := teamIndex[killerTeam[e.Index]]; found {
			counts := &match.Teams[i].AfterOpeningKill
			counts.Rounds++
			if e.Outcome == "loss" {
				counts.Wins++
			}
		}
		if len(match.Openings) == 4 {
			continue
		}
		if victim == nil && playerInScope(e.KillerID, killerTeam[e.Index]) == nil {
			continue
		}
		killerID, _ := analysisPlayerID(d.ID, e.KillerID)
		victimID, _ := analysisPlayerID(d.ID, e.PlayerID)
		match.Openings = append(match.Openings, insightsOpening{e.Round, e.Time, killerID, victimID, e.Side, e.Outcome, e.Approx})
	}
	return match
}
