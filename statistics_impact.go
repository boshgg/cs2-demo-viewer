package main

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

// Impact is a transparent review heuristic, not a fitted win-probability model.
// It is derived from the existing replay; no source, membership or cache is
// changed when the rule version changes.
type StatisticsImpact struct {
	Version  string                  `json:"version"`
	Kills    []StatisticsImpactKill  `json:"kills"`
	Deaths   []StatisticsImpactDeath `json:"deaths"`
	Rounds   []StatisticsExposure    `json:"rounds"`
	Warnings []string                `json:"warnings"`
}

type StatisticsImpactKill struct {
	Index          int     `json:"index"`
	Time           float64 `json:"time"`
	Round          int     `json:"round"`
	Half           int     `json:"half"`
	PlayerID       string  `json:"playerId"`
	Player         string  `json:"player"`
	Side           int     `json:"side"`
	TeamKey        string  `json:"teamKey"`
	Score          *int    `json:"score"`
	ExcludedReason string  `json:"excludedReason"`
	Approx         bool    `json:"approx"`
	Reason         string  `json:"reason"`
}

type StatisticsImpactNext struct {
	Status          string `json:"status"`
	Reason          string `json:"reason"`
	Round           int    `json:"round"`
	CurrentWeapon   string `json:"currentWeapon"`
	NextWeapon      string `json:"nextWeapon"`
	CurrentGrenades *int   `json:"currentGrenades"`
	NextGrenades    *int   `json:"nextGrenades"`
	WeaponDrop      int    `json:"weaponDrop"`
	UtilityDrop     int    `json:"utilityDrop"`
	WeaponPenalty   int    `json:"weaponPenalty"`
	UtilityPenalty  int    `json:"utilityPenalty"`
}

type StatisticsImpactDeath struct {
	Index          int                  `json:"index"`
	Time           float64              `json:"time"`
	Round          int                  `json:"round"`
	Half           int                  `json:"half"`
	PlayerID       string               `json:"playerId"`
	Player         string               `json:"player"`
	Side           int                  `json:"side"`
	TeamKey        string               `json:"teamKey"`
	KillerID       string               `json:"killerId"`
	Killer         string               `json:"killer"`
	KillerWeapon   string               `json:"killerWeapon"`
	Weapon         string               `json:"weapon"`
	FirstDeath     bool                 `json:"firstDeath"`
	KillsBefore    int                  `json:"killsBefore"`
	AlliesBefore   *int                 `json:"alliesBefore"`
	EnemiesBefore  *int                 `json:"enemiesBefore"`
	Outcome        string               `json:"outcome"`
	WeaponGap      *int                 `json:"weaponGap"`
	WeaponFactor   float64              `json:"weaponFactor"`
	BalanceFactor  float64              `json:"balanceFactor"`
	FirstFactor    float64              `json:"firstFactor"`
	ResultFactor   float64              `json:"resultFactor"`
	KillMitigation float64              `json:"killMitigation"`
	CorePenalty    *int                 `json:"corePenalty"`
	EconomyPenalty int                  `json:"economyPenalty"`
	Penalty        *int                 `json:"penalty"`
	ExcludedReason string               `json:"excludedReason"`
	Approx         bool                 `json:"approx"`
	Notes          []string             `json:"notes"`
	Next           StatisticsImpactNext `json:"next"`
}

// One record per observed player and round. Consumers must use eligible
// exposures, not selected-demo count or deaths, as the per-round denominator.
type StatisticsExposure struct {
	Round    int    `json:"round"`
	Half     int    `json:"half"`
	PlayerID string `json:"playerId"`
	Player   string `json:"player"`
	Side     int    `json:"side"`
	TeamKey  string `json:"teamKey"`
	Eligible bool   `json:"eligible"`
	Reason   string `json:"reason"`
	Approx   bool   `json:"approx"`
}

func emptyStatisticsImpact() *StatisticsImpact {
	return &StatisticsImpact{Version: "1", Kills: []StatisticsImpactKill{}, Deaths: []StatisticsImpactDeath{}, Rounds: []StatisticsExposure{}, Warnings: []string{}}
}

type impactBeforeDeath struct {
	allies, enemies, kills int
	first                  bool
	reason                 string
}

type impactRoundContext struct {
	round      Round
	statistics StatisticsRound
	snapshot   EconomySnapshot
	roster     map[string]PlayerFrame
	before     map[int]impactBeforeDeath
	endedAt    float64
	endIndex   int
	reason     string
	approx     bool
}

func impactInt(value int) *int { return &value }

func impactKnownNonFirearm(name string) bool {
	key := statisticsWeaponKey(name)
	for _, equipment := range []common.EquipmentType{common.EqKnife, common.EqBomb, common.EqSmoke, common.EqFlash, common.EqHE, common.EqMolotov, common.EqIncendiary, common.EqDecoy, common.EqZeus} {
		if key == statisticsWeaponKey(equipment.String()) {
			return true
		}
	}
	// Raw and legacy demo aliases have no gun-matchup rank either.
	switch key {
	case "knife", "knifegg", "bayonet", "taser", "zeus", "zeusx27", "c4", "hegrenade", "flashbang", "smokegrenade", "molotov", "incgrenade", "inferno", "decoy":
		return true
	}
	return strings.HasPrefix(key, "knife")
}

func impactTeamKey(r StatisticsRound, side int) string {
	if side == 3 {
		return r.CT.TeamKey
	}
	if side == 2 {
		return r.T.TeamKey
	}
	return ""
}

func impactRoster(s EconomySnapshot) (map[string]PlayerFrame, bool) {
	roster, counts := map[string]PlayerFrame{}, map[int]int{}
	valid := s.Complete && (s.Source == "freeze_end" || s.Source == "sampled_frame" || s.Source == "sampled_cache")
	for _, p := range s.Players {
		if !analysisSide(p.Team) {
			continue
		}
		if p.ID == "" || !p.Alive || !p.Connected {
			valid = false
		}
		if _, duplicate := roster[p.ID]; duplicate {
			valid = false
		}
		roster[p.ID] = p
		counts[p.Team]++
	}
	return roster, valid && len(roster) == 10 && counts[2] == 5 && counts[3] == 5
}

func impactEnd(r Round, events []Event) (float64, int, bool) {
	end, index := r.EndedAt, -1
	valid := analysisFinite(end) && end > r.FreezeEnd && end >= r.Start && end <= r.End
	matching := []int{}
	for i, event := range events {
		if event.Type != "round_end" || event.Round != r.Number || !analysisFinite(event.T) || event.T <= r.FreezeEnd || event.T < r.Start || event.T > r.End {
			continue
		}
		if !valid || math.Abs(event.T-end) <= .001001 {
			matching = append(matching, i)
		}
	}
	if len(matching) == 1 {
		index = matching[0]
		if !valid {
			end, valid = events[index].T, true
		}
	}
	return end, index, valid
}

func impactLiveEvent(c *impactRoundContext, k KillScore) string {
	if c == nil {
		return "不属于可核验的比赛回合"
	}
	if !analysisFinite(k.Time) || k.Time < c.round.Start || k.Time > c.round.End {
		return "事件时间不在该回合内"
	}
	if k.Time < c.round.FreezeEnd || k.Time < c.snapshot.Time {
		return "冻结阶段或开局快照之前的事件不计战局影响"
	}
	if k.Time > c.endedAt || c.endIndex >= 0 && math.Abs(k.Time-c.endedAt) <= .001001 && k.Index > c.endIndex {
		return "胜负已确定后的事件不计战局影响"
	}
	if c.endIndex < 0 && math.Abs(k.Time-c.endedAt) <= .001001 {
		return "事件与回合结束同时间戳，但缺少可核验的先后顺序，不计战局影响"
	}
	return ""
}

// Replay ordered deaths against the observed opening roster. Living frame sets
// corroborate the reconstruction: a disconnect, revival or missing death makes
// the entire round ineligible rather than silently inventing a 5-player state.
func impactReconstruct(c *impactRoundContext, kills []KillScore, frames []*Frame) {
	if c.reason != "" {
		return
	}
	alive, killCounts := map[string]bool{}, map[string]int{}
	for id := range c.roster {
		alive[id] = true
	}
	deathTimes := map[float64]bool{}
	for _, k := range kills {
		if impactLiveEvent(c, k) == "" {
			deathTimes[k.Time] = true
		}
	}
	frameIndex := 0
	checkUntil := func(until float64) bool {
		for frameIndex < len(frames) && frames[frameIndex].T < until {
			frame := frames[frameIndex]
			frameIndex++
			// Replay times are rounded to hundredths. A frame sharing a death
			// timestamp can be either side of that event; do not reject either.
			if frame.T < c.snapshot.Time || frame.T >= c.endedAt || deathTimes[frame.T] {
				continue
			}
			observed := map[string]bool{}
			for _, p := range frame.Players {
				if !p.Connected || !p.Alive || !analysisSide(p.Team) {
					continue
				}
				start, found := c.roster[p.ID]
				if !found || start.Team != p.Team || observed[p.ID] || !alive[p.ID] {
					c.reason = "存活帧与死亡事件不一致（可能有复活、换队或缺失事件），该回合不计综合影响"
					return false
				}
				observed[p.ID] = true
			}
			for id, living := range alive {
				if living && !observed[id] {
					c.reason = "存活帧缺少应存活队员（可能有断线、POV 缺失或漏记死亡），该回合不计综合影响"
					return false
				}
			}
		}
		return true
	}
	deaths := 0
	for _, k := range kills {
		if impactLiveEvent(c, k) != "" {
			continue
		}
		if !checkUntil(k.Time) {
			return
		}
		victim, found := c.roster[k.VictimID]
		if !found || k.VictimID == "" || victim.Team != k.VictimSide {
			c.reason = "死亡者身份或阵营与开局阵容不一致，无法核验本回合人数"
			return
		}
		if !alive[k.VictimID] {
			c.before[k.Index] = impactBeforeDeath{reason: "同一回合重复死亡事件，不重复扣分或改变人数"}
			continue
		}
		before := impactBeforeDeath{first: deaths == 0, kills: killCounts[k.VictimID]}
		for id, living := range alive {
			if !living {
				continue
			}
			if c.roster[id].Team == victim.Team {
				before.allies++
			} else {
				before.enemies++
			}
		}
		c.before[k.Index] = before
		alive[k.VictimID], deaths = false, deaths+1
		if killer, exists := c.roster[k.KillerID]; exists && k.KillerID != k.VictimID && killer.Team == k.KillerSide && killer.Team != victim.Team {
			// All hostile kills count as prior contributions, including utility;
			// this does not award weapon-value points to excluded weapons.
			killCounts[k.KillerID]++
		}
	}
	checkUntil(c.endedAt)
}

func impactHostileReason(c *impactRoundContext, k KillScore) string {
	if k.VictimID == "" || k.KillerID == "" {
		return "环境死亡或击杀者身份缺失，不归为个人对枪惩罚"
	}
	if k.KillerID == k.VictimID {
		return "自杀不归为个人对枪惩罚"
	}
	killer, hasKiller := c.roster[k.KillerID]
	victim, hasVictim := c.roster[k.VictimID]
	if !hasKiller || !hasVictim || killer.Team != k.KillerSide || victim.Team != k.VictimSide {
		return "参与者身份或阵营证据不足"
	}
	if killer.Team == victim.Team {
		return "队友击杀不惩罚受害者，也不奖励击杀者"
	}
	return ""
}

func impactUnavailableNext(reason string) StatisticsImpactNext {
	return StatisticsImpactNext{Status: "unavailable", Reason: reason}
}

func impactEconomy(c, next *impactRoundContext, death *StatisticsImpactDeath, names map[string]string) StatisticsImpactNext {
	comparison := impactUnavailableNext("没有连续的下一回合，末回合不追加经济惩罚")
	if next == nil || next.round.Number != c.round.Number+1 {
		return comparison
	}
	comparison.Round = next.round.Number
	comparison.CurrentWeapon = death.Weapon
	currentGun, hasCurrent := statisticsGuns[statisticsWeaponKey(death.Weapon)]
	if !hasCurrent {
		comparison.Reason = "死亡时手持非枪械或武器证据缺失，无法确认枪械降档，不追加经济惩罚"
		return comparison
	}
	if c.statistics.Half <= 0 || next.statistics.Half != c.statistics.Half || next.statistics.Pistol {
		comparison.Reason = "半场或加时经济重置边界，不比较下一回合装备"
		return comparison
	}
	if strings.HasPrefix(c.statistics.HalfSource, "default_") || strings.HasPrefix(next.statistics.HalfSource, "default_") || strings.Contains(c.statistics.HalfSource, "overtime_mr3") || strings.Contains(next.statistics.HalfSource, "overtime_mr3") || c.statistics.HalfSource == "unknown" || next.statistics.HalfSource == "unknown" {
		comparison.Reason = "赛制或加时半场边界仅有默认推断，无法可靠排除经济重置，不追加经济惩罚"
		return comparison
	}
	_, completeCurrent := impactRoster(c.snapshot)
	_, completeNext := impactRoster(next.snapshot)
	if !completeCurrent || !completeNext {
		comparison.Reason = "本回合或下一回合冻结结束阵容不完整，不追加经济惩罚"
		return comparison
	}
	current, currentExists := c.roster[death.PlayerID]
	following, nextExists := next.roster[death.PlayerID]
	if !currentExists || !nextExists || current.Team != following.Team {
		comparison.Reason = "下一回合玩家缺失或换边，不比较装备"
		return comparison
	}
	currentEquipment, currentValid := statisticsEquipment(current, names)
	nextEquipment, nextValid := statisticsEquipment(following, names)
	comparison.NextWeapon = nextEquipment.Weapon
	if !currentValid || !nextValid {
		comparison.Reason = "本回合或下一回合枪械、道具证据不完整，不追加经济惩罚"
		return comparison
	}
	comparison.CurrentGrenades, comparison.NextGrenades = impactInt(currentEquipment.Grenades), impactInt(nextEquipment.Grenades)
	nextGun, hasNext := statisticsGuns[statisticsWeaponKey(nextEquipment.Weapon)]
	if !hasNext {
		comparison.Reason = "下一回合枪械档位无法比较，不追加经济惩罚"
		return comparison
	}
	comparison.Status = "compared"
	comparison.Reason = "枪械比较死亡时手持枪与下一回合冻结结束持有枪；道具比较两回合冻结结束持有数。仅表明装备变化关联，不代表已证实死亡导致或实际购买数量"
	if c.snapshot.Source != "freeze_end" || next.snapshot.Source != "freeze_end" {
		death.Approx = true
		death.Notes = append(death.Notes, "下一回合装备比较包含邻近采样，并非精确冻结结束记录")
	}
	gap := 0
	if death.WeaponGap != nil {
		gap = max(0, *death.WeaponGap)
	}
	factor := math.Exp2(float64(gap))
	if currentGun.rank > nextGun.rank {
		comparison.WeaponDrop = currentGun.rank - nextGun.rank
		comparison.WeaponPenalty = int(math.Round(150 * float64(comparison.WeaponDrop) * factor))
	} else if currentEquipment.Grenades > nextEquipment.Grenades {
		comparison.UtilityDrop = currentEquipment.Grenades - nextEquipment.Grenades
		comparison.UtilityPenalty = int(math.Round(60 * float64(comparison.UtilityDrop) * factor))
	}
	// The branches are exclusive. Allocate the rounded cap to that component so
	// components always sum exactly to economyPenalty and the signed total.
	if death.CorePenalty != nil {
		cap := int(math.Floor(float64(*death.CorePenalty) * .2))
		comparison.WeaponPenalty = min(cap, comparison.WeaponPenalty)
		comparison.UtilityPenalty = min(cap, comparison.UtilityPenalty)
	}
	return comparison
}

func buildStatisticsImpact(d *DemoData, statistics *StatisticsDemo, rounds []Round, snapshots map[int]EconomySnapshot, frames map[int][]*Frame, names map[string]string) *StatisticsImpact {
	out := emptyStatisticsImpact()
	out.Warnings = append(out.Warnings, "综合影响是公开规则构建的复盘评分，不是真实胜率变化或经过人群校准的竞技评级。", "枪械比较死亡时手持与次回合开打装备，道具比较两回合开打携带数；仅表示关联，没有使用购买日志或证明死亡的因果作用。")
	contexts, statsRounds, roundKills := map[int]*impactRoundContext{}, map[int]StatisticsRound{}, map[int][]KillScore{}
	for _, r := range statistics.Rounds {
		statsRounds[r.Number] = r
	}
	for _, k := range statistics.Kills {
		roundKills[k.Round] = append(roundKills[k.Round], k)
	}
	for _, r := range rounds {
		c := &impactRoundContext{round: r, statistics: statsRounds[r.Number], snapshot: snapshots[r.Number], before: map[int]impactBeforeDeath{}, endIndex: -1}
		var rosterValid, endValid bool
		c.roster, rosterValid = impactRoster(c.snapshot)
		c.endedAt, c.endIndex, endValid = impactEnd(r, d.Events)
		c.approx = c.snapshot.Source != "freeze_end"
		switch {
		case !rosterValid:
			c.reason = "缺少完整的开局 5v5 存活阵容，无法可靠计算人数与首死"
		case !analysisSide(r.Winner):
			c.reason = "回合胜负未知，不计综合影响"
		case !endValid:
			c.reason = "回合胜负确定时间缺失，不把回合间追杀当作战局影响"
		case !analysisFinite(c.snapshot.Time) || !analysisFinite(r.FreezeEnd) || r.FreezeEnd < r.Start || r.FreezeEnd >= c.endedAt || c.snapshot.Time < r.Start || c.snapshot.Time >= c.endedAt || math.Abs(c.snapshot.Time-r.FreezeEnd) > .250001:
			c.reason = "开局快照时间无效，无法可靠计算本回合影响"
		}
		contexts[r.Number] = c
		impactReconstruct(c, roundKills[r.Number], frames[r.Number])
		if c.reason != "" {
			out.Warnings = append(out.Warnings, fmt.Sprintf("R%d：%s", r.Number, c.reason))
		}
	}
	for _, r := range rounds {
		c := contexts[r.Number]
		// Keep ineligible observed players in coverage, including players omitted
		// from a partial opening snapshot. No unobserved roster is fabricated.
		observed := map[string]int{}
		for id, p := range c.roster {
			observed[id] = p.Team
		}
		for _, f := range frames[r.Number] {
			if f.T < r.Start || f.T > r.End {
				continue
			}
			for _, p := range f.Players {
				if p.ID != "" && p.Connected && analysisSide(p.Team) {
					if _, exists := observed[p.ID]; !exists {
						observed[p.ID] = p.Team
					}
				}
			}
		}
		for _, k := range roundKills[r.Number] {
			if k.KillerID != "" && analysisSide(k.KillerSide) {
				if _, exists := observed[k.KillerID]; !exists {
					observed[k.KillerID] = k.KillerSide
				}
			}
			if k.VictimID != "" && analysisSide(k.VictimSide) {
				if _, exists := observed[k.VictimID]; !exists {
					observed[k.VictimID] = k.VictimSide
				}
			}
		}
		ids := make([]string, 0, len(observed))
		for id := range observed {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			side, name := observed[id], names[id]
			if name == "" {
				name = id
			}
			reason := c.reason
			if _, exists := c.roster[id]; !exists && reason == "" {
				reason = "玩家未出现在开局存活阵容中"
			}
			out.Rounds = append(out.Rounds, StatisticsExposure{Round: r.Number, Half: c.statistics.Half, PlayerID: id, Player: name, Side: side, TeamKey: impactTeamKey(c.statistics, side), Eligible: reason == "", Reason: reason, Approx: c.approx})
		}
	}
	for _, k := range statistics.Kills {
		ik := StatisticsImpactKill{Index: k.Index, Time: k.Time, Round: k.Round, Half: k.Half, PlayerID: k.KillerID, Player: k.Killer, Side: k.KillerSide, TeamKey: k.KillerTeamKey, Approx: k.Approx}
		death := StatisticsImpactDeath{Index: k.Index, Time: k.Time, Round: k.Round, Half: k.Half, PlayerID: k.VictimID, Player: k.Victim, Side: k.VictimSide, TeamKey: k.VictimTeamKey, KillerID: k.KillerID, Killer: k.Killer, KillerWeapon: k.Weapon, Weapon: k.VictimWeapon, Outcome: "unknown", WeaponFactor: 1, BalanceFactor: 1, FirstFactor: 1, ResultFactor: 1, KillMitigation: 1, Approx: k.Approx, Notes: []string{}, Next: impactUnavailableNext("该次死亡未计分，不追加经济惩罚")}
		c := contexts[k.Round]
		reason := ""
		if c == nil {
			reason = "不属于可核验的比赛回合"
		} else {
			ik.Approx, death.Approx = ik.Approx || c.approx, death.Approx || c.approx
			if analysisSide(c.round.Winner) && analysisSide(k.VictimSide) {
				death.Outcome = "loss"
				if c.round.Winner == k.VictimSide {
					death.Outcome = "win"
				}
			}
			reason = c.reason
			if reason == "" {
				reason = impactLiveEvent(c, k)
			}
			if reason == "" {
				before, found := c.before[k.Index]
				if !found {
					reason = "缺少该次死亡的人数与事件顺序证据"
				} else if before.reason != "" {
					reason = before.reason
				} else {
					death.FirstDeath, death.KillsBefore = before.first, before.kills
					death.AlliesBefore, death.EnemiesBefore = impactInt(before.allies), impactInt(before.enemies)
					reason = impactHostileReason(c, k)
				}
			}
		}
		ik.ExcludedReason, death.ExcludedReason = reason, reason
		if reason == "" {
			killerGun, killerGunKnown := statisticsGuns[statisticsWeaponKey(k.Weapon)]
			victimGun, victimGunKnown := statisticsGuns[statisticsWeaponKey(k.VictimWeapon)]
			if killerGunKnown {
				score := 1000
				ik.Reason = "有效敌对枪械击杀基础贡献 1000"
				if k.Score != nil && victimGunKnown {
					score += 125 * *k.Score
					ik.Reason += fmt.Sprintf(" + 原加权净值 %d × 125", *k.Score)
				} else {
					ik.Reason += "；受害者手持非枪械或武器证据缺失，不追加武器对位权重"
					if !impactKnownNonFirearm(k.VictimWeapon) || k.WeaponSource == "unknown" {
						ik.Approx = true
						ik.Reason += "；武器名称或证据未知，基础贡献标为近似"
					}
				}
				ik.Score = impactInt(score)
			} else {
				ik.ExcludedReason = "实际击杀武器为刀、电击枪、道具或未知武器，不计击杀贡献"
			}
			if killerGunKnown && victimGunKnown {
				death.WeaponGap = impactInt(victimGun.rank - killerGun.rank)
				death.WeaponFactor = math.Exp2(float64(*death.WeaponGap))
			} else {
				death.Notes = append(death.Notes, "双方未同时观测到计分枪械，武器差倍率按中性 1 处理，不猜测背包武器")
				if !victimGunKnown && !impactKnownNonFirearm(k.VictimWeapon) || !killerGunKnown && !impactKnownNonFirearm(k.Weapon) || k.WeaponSource == "unknown" {
					death.Approx = true
					death.Notes = append(death.Notes, "包含无法识别的武器名称或缺失武器证据，中性倍率是近似处理")
				}
			}
			if death.FirstDeath {
				death.FirstFactor = 2
			}
			death.BalanceFactor = .75
			if *death.AlliesBefore == *death.EnemiesBefore {
				death.BalanceFactor = 1.25
			}
			if death.Outcome == "win" {
				death.ResultFactor = .35
			}
			death.KillMitigation = 1 / (1 + .6*float64(death.KillsBefore))
			core := int(math.Round(1000 * death.FirstFactor * death.WeaponFactor * death.BalanceFactor * death.ResultFactor * death.KillMitigation))
			death.CorePenalty = impactInt(core)
			death.Next = impactEconomy(c, contexts[k.Round+1], &death, names)
			death.EconomyPenalty = death.Next.WeaponPenalty + death.Next.UtilityPenalty
			death.Penalty = impactInt(-core - death.EconomyPenalty)
		}
		// Malformed cached event times must never make the report unencodable.
		if !analysisFinite(ik.Time) {
			ik.Time, death.Time = 0, 0
		}
		out.Kills = append(out.Kills, ik)
		out.Deaths = append(out.Deaths, death)
	}
	return out
}
