package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

// Bump when scoring or classification rules change; persisted replay bytes do
// not need to be rewritten to rebuild this derived, compact report.
const StatisticsVersion = "2"

type EconomySnapshot struct {
	Time       float64       `json:"time"`
	Source     string        `json:"source"`
	Complete   bool          `json:"complete"`
	Players    []PlayerFrame `json:"players"`
	CTName     string        `json:"ctName"`
	TName      string        `json:"tName"`
	Half       int           `json:"half"`
	HalfSource string        `json:"halfSource"`
	Pistol     bool          `json:"pistol"`
}

type StatisticsRule struct {
	Code        string `json:"code"`
	Label       string `json:"label"`
	Priority    int    `json:"priority"`
	Description string `json:"description"`
}
type EquipmentEvidence struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	Money         int             `json:"money"`
	Armor         int             `json:"armor"`
	Weapon        string          `json:"weapon"`
	WeaponClass   string          `json:"weaponClass"`
	Grenades      int             `json:"grenades"`
	Inventory     []InventoryItem `json:"inventory"`
	UtilityReady  bool            `json:"utilityReady"`
	UtilityReason string          `json:"utilityReason"`
	Eco           bool            `json:"eco"`
	Reason        string          `json:"reason"`
}
type TeamEconomy struct {
	Side           int                 `json:"side"`
	Name           string              `json:"name"`
	TeamKey        string              `json:"teamKey"`
	IdentitySource string              `json:"identitySource"`
	Type           string              `json:"type"`
	Label          string              `json:"label"`
	MatchedTypes   []string            `json:"matchedTypes"`
	Source         string              `json:"source"`
	Time           float64             `json:"time"`
	Complete       bool                `json:"complete"`
	Reason         string              `json:"reason"`
	Overlap        string              `json:"overlap"`
	Players        []EquipmentEvidence `json:"players"`
}
type StatisticsSummary struct {
	Kills               int      `json:"kills"`
	ScoredKills         int      `json:"scoredKills"`
	ExcludedKills       int      `json:"excludedKills"`
	Score               int      `json:"score"`
	Average             *float64 `json:"average"`
	Headshots           int      `json:"headshots"`
	Deaths              int      `json:"deaths"`
	PistolMismatchKills int      `json:"pistolMismatchKills"`
}
type StatisticsPlayer struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Summary StatisticsSummary `json:"summary"`
}
type StatisticsGroup struct {
	Side    int                `json:"side,omitempty"`
	Half    int                `json:"half,omitempty"`
	TeamKey string             `json:"teamKey,omitempty"`
	Label   string             `json:"label"`
	Summary StatisticsSummary  `json:"summary"`
	Players []StatisticsPlayer `json:"players"`
}
type StatisticsRound struct {
	Number     int                `json:"number"`
	Start      float64            `json:"start"`
	End        float64            `json:"end"`
	FreezeEnd  float64            `json:"freezeEnd"`
	Half       int                `json:"half"`
	HalfSource string             `json:"halfSource"`
	Pistol     bool               `json:"pistol"`
	CT         TeamEconomy        `json:"ct"`
	T          TeamEconomy        `json:"t"`
	Summary    StatisticsSummary  `json:"summary"`
	Players    []StatisticsPlayer `json:"players"`
}
type KillScore struct {
	Index           int     `json:"index"`
	Time            float64 `json:"time"`
	Round           int     `json:"round"`
	Half            int     `json:"half"`
	KillerID        string  `json:"killerId"`
	Killer          string  `json:"killer"`
	VictimID        string  `json:"victimId"`
	Victim          string  `json:"victim"`
	KillerSide      int     `json:"killerSide"`
	VictimSide      int     `json:"victimSide"`
	KillerTeamKey   string  `json:"killerTeamKey"`
	VictimTeamKey   string  `json:"victimTeamKey"`
	Weapon          string  `json:"weapon"`
	VictimWeapon    string  `json:"victimWeapon"`
	KillerValue     *int    `json:"killerValue"`
	VictimValue     *int    `json:"victimValue"`
	BaseScore       *int    `json:"baseScore"`
	ScoreMultiplier *int    `json:"scoreMultiplier"`
	Score           *int    `json:"score"`
	WeaponSource    string  `json:"weaponSource"`
	WeaponTime      float64 `json:"weaponTime"`
	Approx          bool    `json:"approx"`
	ExcludedReason  string  `json:"excludedReason"`
	Headshot        bool    `json:"headshot"`
	PistolMismatch  bool    `json:"pistolMismatch"`
}
type StatisticsDemo struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Map         string             `json:"map"`
	RuleVersion string             `json:"ruleVersion"`
	Warnings    []string           `json:"warnings"`
	Rules       []StatisticsRule   `json:"rules"`
	Rounds      []StatisticsRound  `json:"rounds"`
	Kills       []KillScore        `json:"kills"`
	Summary     StatisticsSummary  `json:"summary"`
	Players     []StatisticsPlayer `json:"players"`
	Sides       []StatisticsGroup  `json:"sides"`
	Halves      []StatisticsGroup  `json:"halves"`
	Teams       []StatisticsGroup  `json:"teams"`
}

func statisticsRules() []StatisticsRule {
	return []StatisticsRule{
		{"pistol", "手枪局", 1, "仅常规赛上下半场首局；加时不算手枪局。该局身份与装备完整性分别标注。"},
		{"full_sniper", "全起有狙", 2, "5 人有甲且持 SMG、长枪或狙；至少 1 狙，非狙击手道具尽量齐，狙击手道具不限。"},
		{"full", "全起", 3, "5 人有甲，人人持 SMG 或长枪，人人 4 颗道具或余钱买不起仍可携带的道具。"},
		{"hero", "英雄枪", 4, "至少 3 人持手枪/SMG 且余钱 >1000；其余 1–2 人持长枪/狙并有甲，保枪计入。"},
		{"disorder", "乱买", 5, "2–4 人处于 ECO，其余人余钱 <1000 且有枪有甲、道具尽量齐；两拨余钱跨过 1000。"},
		{"mixed", "混起", 6, "5 人都有枪有甲，至少 3 人余钱 ≤1000，至少 1 人带 1–3 颗道具且并非全员 4 颗。"},
		{"force", "强起", 7, "人人有手枪、SMG 或长枪（不含狙），至少 3 人余钱 ≤500；护甲不限。"},
		{"eco", "ECO", 8, "至少 3 人持手枪或 SMG 且余钱 >1000；护甲不限。"},
		{"unknown", "未知", 9, "缺少冻结结束附近数据、队员或装备字段，或未满足任何明确规则。"},
	}
}

func statisticsWeaponKey(name string) string {
	name = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(name)), "weapon_")
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return -1
	}, name)
}

type statisticsGun struct {
	class string
	value int
	rank  int
}

var statisticsGuns = func() map[string]statisticsGun {
	m := map[string]statisticsGun{}
	for _, group := range []struct {
		class string
		value int
		rank  int
		guns  []common.EquipmentType
	}{
		{"pistol", 1, 1, []common.EquipmentType{common.EqP2000, common.EqGlock, common.EqP250, common.EqDeagle, common.EqFiveSeven, common.EqDualBerettas, common.EqTec9, common.EqCZ, common.EqUSP, common.EqRevolver}},
		{"smg", 2, 2, []common.EquipmentType{common.EqMP7, common.EqMP9, common.EqBizon, common.EqMac10, common.EqUMP, common.EqP90, common.EqMP5}},
		{"rifle", 5, 3, []common.EquipmentType{common.EqGalil, common.EqFamas, common.EqAK47, common.EqM4A4, common.EqM4A1, common.EqSG553, common.EqAUG, common.EqSawedOff, common.EqNova, common.EqMag7, common.EqXM1014, common.EqM249, common.EqNegev}},
		{"sniper", 7, 4, []common.EquipmentType{common.EqSSG08, common.EqAWP, common.EqScar20, common.EqG3SG1}},
	} {
		for _, gun := range group.guns {
			m[statisticsWeaponKey(gun.String())] = statisticsGun{group.class, group.value, group.rank}
		}
	}
	for alias, target := range map[string]string{"glock": "Glock-18", "hkp2000": "P2000", "deagle": "Desert Eagle", "elite": "Dual Berettas", "cz75a": "CZ75-Auto", "usp_silencer": "USP-S", "usps": "USP-S", "m4a1_silencer": "M4A1", "m4a1s": "M4A1", "galilar": "Galil AR", "sg556": "SG 553", "ssg08": "SSG 08", "scout": "SSG 08", "bizon": "PP-Bizon", "ump45": "UMP-45", "mp5sd": "MP5-SD"} {
		m[statisticsWeaponKey(alias)] = m[statisticsWeaponKey(target)]
	}
	return m
}()

func statisticsUtility(p PlayerFrame) (int, bool, string) {
	if p.Inventory == nil {
		return 0, false, "道具字段缺失"
	}
	counts := map[string]int{}
	total := 0
	for _, item := range p.Inventory {
		if item.Count < 0 {
			return 0, false, "道具数量无效"
		}
		if item.Count == 0 {
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(item.Type))
		if kind != "flash" && kind != "smoke" && kind != "he" && kind != "molotov" && kind != "incendiary" && kind != "decoy" {
			return total, false, "未知道具类型"
		}
		counts[kind] += item.Count
		total += item.Count
	}
	if total > 4 || counts["flash"] > 2 || counts["smoke"] > 1 || counts["he"] > 1 || counts["decoy"] > 1 || counts["molotov"]+counts["incendiary"] > 1 {
		return total, false, "道具数量超出默认携带限制"
	}
	if total == 4 {
		return total, true, "已携带 4 颗道具"
	}
	minimum := math.MaxInt
	for _, item := range []struct {
		kind         string
		price, limit int
	}{{"decoy", 50, 1}, {"flash", 200, 2}, {"smoke", 300, 1}, {"he", 300, 1}} {
		if counts[item.kind] < item.limit && item.price < minimum {
			minimum = item.price
		}
	}
	if counts["molotov"]+counts["incendiary"] == 0 {
		price := 400
		if p.Team == 3 {
			price = 500
		}
		if price < minimum {
			minimum = price
		}
	}
	if p.Money < minimum {
		return total, true, fmt.Sprintf("余钱 $%d，买不起仍可携带的最便宜道具（$%d）", p.Money, minimum)
	}
	return total, false, fmt.Sprintf("仍可购买至少 1 颗道具（最低 $%d，余钱 $%d）", minimum, p.Money)
}

func statisticsEquipment(p PlayerFrame, names map[string]string) (EquipmentEvidence, bool) {
	e := EquipmentEvidence{ID: p.ID, Name: names[p.ID], Money: p.Money, Armor: p.Armor, Inventory: append([]InventoryItem{}, p.Inventory...)}
	if e.Name == "" {
		e.Name = p.ID
	}
	// Economy is carried equipment, including saved guns. Kill scoring below
	// deliberately uses only the active weapon and never calls this function.
	best := 0
	for _, weapon := range p.Weapons {
		if gun, ok := statisticsGuns[statisticsWeaponKey(weapon.Name)]; ok && gun.value > best {
			best, e.Weapon, e.WeaponClass = gun.value, weapon.Name, gun.class
		}
	}
	e.Grenades, e.UtilityReady, e.UtilityReason = statisticsUtility(p)
	e.Eco = (e.WeaponClass == "pistol" || e.WeaponClass == "smg") && p.Money > 1000
	valid := p.ID != "" && p.Connected && p.Alive && p.Money >= 0 && p.Armor >= 0 && p.Weapons != nil && p.Inventory != nil && best > 0
	if !valid {
		e.Reason = "队员状态或完整装备字段缺失，无法可靠分类"
	} else {
		e.Reason = fmt.Sprintf("持有 %s · 护甲 %d · 余钱 $%d · %d 颗道具", e.Weapon, p.Armor, p.Money, e.Grenades)
	}
	if strings.Contains(e.UtilityReason, "缺失") || strings.Contains(e.UtilityReason, "无效") || strings.Contains(e.UtilityReason, "未知") || strings.Contains(e.UtilityReason, "超出") {
		valid = false
		e.Reason = e.UtilityReason
	}
	return e, valid
}

func statisticsEconomy(snapshot EconomySnapshot, side int, pistol bool, names map[string]string, group *analysisTeamGroup) TeamEconomy {
	e := TeamEconomy{Side: side, Type: "unknown", Label: "未知", Source: snapshot.Source, Time: snapshot.Time, Complete: snapshot.Source == "freeze_end" || snapshot.Source == "sampled_cache" || snapshot.Source == "sampled_frame", MatchedTypes: []string{}, Players: []EquipmentEvidence{}}
	if side == 3 {
		e.Name = snapshot.CTName
	} else {
		e.Name = snapshot.TName
	}
	if group != nil {
		e.TeamKey, e.IdentitySource = group.team.ID, group.team.IdentitySource
		if analysisClanName(e.Name) == "" {
			e.Name = group.team.Name
		}
	}
	seen := map[string]bool{}
	for _, p := range snapshot.Players {
		if p.Team != side {
			continue
		}
		evidence, valid := statisticsEquipment(p, names)
		e.Players = append(e.Players, evidence)
		if !valid || seen[p.ID] {
			e.Complete = false
		}
		seen[p.ID] = true
	}
	sort.Slice(e.Players, func(i, j int) bool { return e.Players[i].ID < e.Players[j].ID })
	if len(e.Players) != 5 || len(seen) != 5 {
		e.Complete = false
	}
	if !e.Complete {
		e.Reason = "需要同一冻结结束快照中 5 名有效队员及完整装备；当前证据不足。"
		if pistol {
			e.Type, e.Label, e.MatchedTypes = "pistol", "手枪局", []string{"pistol"}
			e.Reason = "已识别为常规赛半场首局；装备证据不完整，仅能确认手枪局身份。"
		}
		return e
	}
	armor, full, fullSniper, snipers, eco, heroBuyers, disorderBuyers, low500, low1000, partial, allFour := 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, true
	for _, p := range e.Players {
		if p.Armor > 0 {
			armor++
		}
		if (p.WeaponClass == "smg" || p.WeaponClass == "rifle") && p.Armor > 0 && p.UtilityReady {
			full++
			fullSniper++
		}
		if p.WeaponClass == "sniper" {
			snipers++
			if p.Armor > 0 {
				fullSniper++
			}
		}
		if p.Eco {
			eco++
		} else {
			if (p.WeaponClass == "rifle" || p.WeaponClass == "sniper") && p.Armor > 0 {
				heroBuyers++
			}
			if p.Money < 1000 && p.Armor > 0 && p.UtilityReady {
				disorderBuyers++
			}
		}
		if p.Money <= 500 {
			low500++
		}
		if p.Money <= 1000 {
			low1000++
		}
		if p.Grenades >= 1 && p.Grenades <= 3 {
			partial++
		}
		allFour = allFour && p.Grenades == 4
	}
	matches := map[string]bool{"pistol": pistol, "full_sniper": fullSniper == 5 && snipers > 0, "full": full == 5, "hero": eco >= 3 && eco < 5 && heroBuyers == 5-eco, "disorder": eco >= 2 && eco < 5 && disorderBuyers == 5-eco, "mixed": armor == 5 && low1000 >= 3 && partial > 0 && !allFour, "force": low500 >= 3 && snipers == 0, "eco": eco >= 3}
	for _, rule := range statisticsRules() {
		if matches[rule.Code] {
			e.MatchedTypes = append(e.MatchedTypes, rule.Code)
			if e.Type == "unknown" {
				e.Type, e.Label, e.Reason = rule.Code, rule.Label, rule.Description
			}
		}
	}
	if len(e.MatchedTypes) > 1 {
		labels := []string{}
		for _, rule := range statisticsRules() {
			if matches[rule.Code] {
				labels = append(labels, rule.Label)
			}
		}
		e.Overlap = "同时满足 " + strings.Join(labels, "、") + "；按公开规则优先级采用「" + e.Label + "」。"
	}
	if e.Type == "unknown" {
		e.Reason = "装备数据完整，但未满足任何明确规则；不把边界情况强行归类。"
	}
	if e.Source == "sampled_cache" {
		e.Reason += " 本次依据旧缓存邻近采样，不能视为冻结结束精确购买记录。"
	} else if e.Source == "sampled_frame" {
		e.Reason += " 本回合缺少冻结结束事件快照，依据新版解析的邻近帧推断，不能视为精确记录。"
	}
	return e
}

func statisticsEconomySnapshot(r Round, frames []*Frame) EconomySnapshot {
	if r.Economy != nil {
		s := *r.Economy
		if !analysisFinite(s.Time) || s.Time < r.Start || s.Time > r.End {
			return EconomySnapshot{Source: "unknown", Players: []PlayerFrame{}}
		}
		if s.Source == "" {
			s.Source = "freeze_end"
		}
		return s
	}
	s := EconomySnapshot{Source: "unknown", Players: []PlayerFrame{}}
	if !analysisFinite(r.FreezeEnd) || r.FreezeEnd < r.Start || r.FreezeEnd > r.End {
		return s
	}
	var best *Frame
	distance := math.Inf(1)
	for _, f := range frames {
		delta := math.Abs(f.T - r.FreezeEnd)
		if f.T < r.Start || f.T > r.End || delta > .250001 {
			continue
		}
		if delta < distance || delta == distance && f.T < best.T {
			best, distance = f, delta
		}
	}
	if best == nil {
		return s
	}
	s.Time, s.Source, s.Players, s.CTName, s.TName = best.T, "sampled_cache", best.Players, best.CTName, best.TName
	counts := map[int]int{}
	ids := map[string]bool{}
	s.Complete = true
	for _, p := range s.Players {
		if !analysisSide(p.Team) {
			continue
		}
		if !p.Connected || !p.Alive || p.ID == "" || ids[p.ID] {
			s.Complete = false
		}
		counts[p.Team]++
		ids[p.ID] = true
	}
	s.Complete = s.Complete && counts[2] == 5 && counts[3] == 5
	return s
}

// Reuse the same roster/name resolver as map analysis, without building its
// heatmap grids. This keeps anonymous matchmaking teams linked over side swaps.
func statisticsTeamGroups(d *DemoData, rounds []Round, snapshots map[int]EconomySnapshot, frames map[int][]*Frame) (map[int]map[int]*analysisTeamGroup, []*analysisTeamGroup) {
	windows := map[int]analysisRoundWindow{}
	rosters := map[int]map[int]*analysisRoster{}
	for _, r := range rounds {
		windows[r.Number] = analysisRoundWindow{r.Start, r.End}
		rosters[r.Number] = map[int]*analysisRoster{}
		for _, side := range []int{2, 3} {
			rosters[r.Number][side] = &analysisRoster{members: map[string]bool{}, stable: map[string]bool{}, names: map[string]int{}}
		}
		add := func(players []PlayerFrame, ct, t string) {
			for _, side := range []int{2, 3} {
				name := t
				if side == 3 {
					name = ct
				}
				if name = analysisClanName(name); name != "" {
					rosters[r.Number][side].names[name]++
				}
			}
			for _, p := range players {
				if p.ID == "" || !p.Connected || !analysisSide(p.Team) {
					continue
				}
				roster := rosters[r.Number][p.Team]
				roster.members[p.ID] = true
				_, stable := analysisPlayerID(d.ID, p.ID)
				if stable {
					roster.stable[p.ID] = true
				}
			}
		}
		s := snapshots[r.Number]
		add(s.Players, s.CTName, s.TName)
		for _, f := range frames[r.Number] {
			if f.T >= r.Start && f.T <= r.End {
				add(f.Players, f.CTName, f.TName)
			}
		}
	}
	return analysisIdentifyTeams(d.ID, windows, rosters)
}

func statisticsFallbackHalf(number int) int {
	if number <= 12 {
		return 1
	}
	if number <= 24 {
		return 2
	}
	return 3 + (number-25)/3
}
func statisticsHalfLabel(half int) string {
	if half == 1 {
		return "上半场"
	}
	if half == 2 {
		return "下半场"
	}
	if half > 2 {
		return fmt.Sprintf("加时第 %d 半场", half-2)
	}
	return "半场未知"
}

func statisticsDeathWeapon(d *DemoData, e Event, frames []*Frame) (string, string, float64, bool) {
	age := e.T - e.VictimWeaponTime
	observed := e.VictimWeaponSource == "death_event" && age <= .001001 || e.VictimWeaponSource == "previous_tick" && age <= .250001
	if e.VictimWeapon != "" && observed && analysisFinite(e.VictimWeaponTime) && age >= 0 {
		return e.VictimWeapon, e.VictimWeaponSource, e.VictimWeaponTime, e.VictimWeaponSource == "previous_tick"
	}
	if d.StatisticsVersion > 0 || e.VictimWeapon != "" || e.VictimWeaponSource != "" {
		return "", "unknown", 0, false
	}
	for i := len(frames) - 1; i >= 0; i-- {
		f := frames[i]
		if f.T > e.T {
			continue
		}
		if e.T-f.T > .250001 {
			break
		}
		for _, p := range f.Players {
			if p.ID == e.VictimID && p.Alive && p.Connected {
				return p.Weapon, "sampled_cache", f.T, true
			}
		}
	}
	return "", "unknown", 0, false
}

func statisticsSideAt(id string, t float64, frames []*Frame) int {
	for i := len(frames) - 1; i >= 0; i-- {
		if frames[i].T > t {
			continue
		}
		for _, p := range frames[i].Players {
			if p.ID == id && p.Connected && analysisSide(p.Team) {
				return p.Team
			}
		}
	}
	return 0
}

func statisticsScore(d *DemoData, e Event, index int, r *StatisticsRound, frames []*Frame, names map[string]string, teams map[int]*analysisTeamGroup) KillScore {
	k := KillScore{Index: index, Time: e.T, Round: e.Round, KillerID: e.KillerID, Killer: e.Killer, VictimID: e.VictimID, Victim: e.Victim, KillerSide: e.KillerTeam, VictimSide: e.VictimTeam, Weapon: e.Weapon, Headshot: e.Headshot, WeaponSource: "unknown"}
	if k.Killer == "" {
		k.Killer = names[k.KillerID]
	}
	if k.Victim == "" {
		k.Victim = names[k.VictimID]
	}
	if r != nil {
		k.Half = r.Half
	}
	if !analysisSide(k.KillerSide) {
		k.KillerSide = statisticsSideAt(k.KillerID, e.T, frames)
	}
	if !analysisSide(k.VictimSide) {
		k.VictimSide = statisticsSideAt(k.VictimID, e.T, frames)
	}
	if g := teams[k.KillerSide]; g != nil {
		k.KillerTeamKey = g.team.ID
	}
	if g := teams[k.VictimSide]; g != nil {
		k.VictimTeamKey = g.team.ID
	}
	k.VictimWeapon, k.WeaponSource, k.WeaponTime, k.Approx = statisticsDeathWeapon(d, e, frames)
	if r != nil && k.VictimWeapon != "" && k.WeaponTime < r.Start {
		k.VictimWeapon, k.WeaponSource, k.WeaponTime, k.Approx = "", "unknown", 0, false
	}
	killerRank, victimRank := 0, 0
	if gun, ok := statisticsGuns[statisticsWeaponKey(k.Weapon)]; ok {
		value := gun.value
		k.KillerValue = &value
		killerRank = gun.rank
	}
	if gun, ok := statisticsGuns[statisticsWeaponKey(k.VictimWeapon)]; ok {
		value := gun.value
		k.VictimValue = &value
		victimRank = gun.rank
	}
	switch {
	case r == nil || e.Round < 1:
		k.ExcludedReason = "不属于有效比赛回合（热身或回合信息缺失）"
	case !analysisFinite(e.T) || e.T < r.Start || e.T > r.End:
		k.ExcludedReason = "击杀时间不在该回合有效区间"
	case r.FreezeEnd > r.Start && r.FreezeEnd <= r.End && e.T < r.FreezeEnd:
		k.ExcludedReason = "冻结阶段击杀不计分"
	case k.KillerID == "":
		k.ExcludedReason = "世界伤害或击杀者缺失"
	case k.VictimID == "":
		k.ExcludedReason = "受害者身份缺失"
	case k.KillerID == k.VictimID:
		k.ExcludedReason = "自杀不计分"
	case !analysisSide(k.KillerSide) || !analysisSide(k.VictimSide):
		k.ExcludedReason = "阵营证据不足，无法排除队友击杀"
	case k.KillerSide == k.VictimSide:
		k.ExcludedReason = "队友击杀不计分"
	case k.KillerValue == nil:
		k.ExcludedReason = "击杀武器不是计分枪械（刀、电击枪、道具或未知武器）"
	case k.VictimWeapon == "":
		k.ExcludedReason = "缺少受害者死亡前手持武器证据"
	case k.VictimValue == nil:
		k.ExcludedReason = "受害者当时手持刀、道具、电击枪或未知武器，不计分"
	default:
		base, multiplier := *k.VictimValue-*k.KillerValue, 1
		if base > 0 {
			multiplier = victimRank - killerRank + 1
		}
		score := base * multiplier
		k.BaseScore, k.ScoreMultiplier = &base, &multiplier
		k.Score = &score
	}
	k.PistolMismatch = statisticsPistolMismatch(k)
	return k
}

// This count describes a specific weapon matchup, independently of the signed
// kill score. Shotguns and machine guns share the existing long-gun value 5.
func statisticsPistolMismatch(k KillScore) bool {
	return k.Score != nil && k.ExcludedReason == "" && k.KillerValue != nil && k.VictimValue != nil && (*k.KillerValue == 2 || *k.KillerValue == 5) && *k.VictimValue == 1
}

func statisticsAddKill(s *StatisticsSummary, k KillScore) {
	s.Kills++
	if k.Headshot {
		s.Headshots++
	}
	if k.PistolMismatch && statisticsPistolMismatch(k) {
		s.PistolMismatchKills++
	}
	if k.Score == nil {
		s.ExcludedKills++
	} else {
		s.ScoredKills++
		s.Score += *k.Score
	}
}
func statisticsFinalize(s *StatisticsSummary) {
	if s.ScoredKills > 0 {
		average := float64(s.Score) / float64(s.ScoredKills)
		s.Average = &average
	}
}
func statisticsPadPlayers(players []StatisticsPlayer, names map[string]string, ids map[string]bool) []StatisticsPlayer {
	seen := map[string]bool{}
	for _, p := range players {
		seen[p.ID] = true
	}
	for id := range ids {
		if id != "" && !seen[id] {
			name := names[id]
			if name == "" {
				name = id
			}
			players = append(players, StatisticsPlayer{ID: id, Name: name})
		}
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	return players
}
func statisticsAggregate(kills []KillScore, names map[string]string, include func(KillScore, bool) bool) (StatisticsSummary, []StatisticsPlayer) {
	summary := StatisticsSummary{}
	players := map[string]*StatisticsPlayer{}
	player := func(id, name string) *StatisticsPlayer {
		if id == "" {
			return nil
		}
		p := players[id]
		if p == nil {
			if names[id] != "" {
				name = names[id]
			}
			if name == "" {
				name = id
			}
			p = &StatisticsPlayer{ID: id, Name: name}
			players[id] = p
		}
		return p
	}
	for _, k := range kills {
		if include(k, false) {
			statisticsAddKill(&summary, k)
			if p := player(k.KillerID, k.Killer); p != nil {
				statisticsAddKill(&p.Summary, k)
			}
		}
		if include(k, true) && k.VictimID != "" {
			summary.Deaths++
			player(k.VictimID, k.Victim).Summary.Deaths++
		}
	}
	statisticsFinalize(&summary)
	out := []StatisticsPlayer{}
	for _, p := range players {
		statisticsFinalize(&p.Summary)
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return summary, out
}

// BuildStatistics is pure: no parsing, filesystem access or mutation of d.
func BuildStatistics(d *DemoData) *StatisticsDemo {
	out := &StatisticsDemo{RuleVersion: StatisticsVersion, Warnings: []string{}, Rules: statisticsRules(), Rounds: []StatisticsRound{}, Kills: []KillScore{}, Players: []StatisticsPlayer{}, Sides: []StatisticsGroup{}, Halves: []StatisticsGroup{}, Teams: []StatisticsGroup{}}
	if d == nil {
		return out
	}
	out.ID, out.Name, out.Map = d.ID, d.Name, d.Map
	for _, warning := range d.Warnings {
		if strings.TrimSpace(warning) != "" {
			out.Warnings = append(out.Warnings, warning)
		}
	}
	out.Warnings = append(out.Warnings, "经济分类基于冻结结束持有装备与剩余现金，包含保枪，并非实际购买日志。道具判断按默认服务器价格与携带上限：诱饵 50、闪光 200（最多 2）、烟/雷 300、T 火 400、CT 火 500；自定义价格服务器可能不适用。")
	names := map[string]string{}
	for _, p := range d.Players {
		names[p.ID] = p.Name
	}
	for _, e := range d.Events {
		if e.KillerID != "" && e.Killer != "" {
			names[e.KillerID] = e.Killer
		}
		if e.VictimID != "" && e.Victim != "" {
			names[e.VictimID] = e.Victim
		}
	}
	rounds := []Round{}
	seenRounds := map[int]bool{}
	for _, r := range d.Rounds {
		if r.Number < 1 || seenRounds[r.Number] || !analysisFinite(r.Start) || !analysisFinite(r.End) || r.End < r.Start {
			continue
		}
		rounds = append(rounds, r)
		seenRounds[r.Number] = true
	}
	sort.Slice(rounds, func(i, j int) bool { return rounds[i].Number < rounds[j].Number })
	frames := map[int][]*Frame{}
	for i := range d.Frames {
		f := &d.Frames[i]
		if analysisFinite(f.T) {
			frames[f.Round] = append(frames[f.Round], f)
		}
		for _, p := range f.Players {
			if p.ID != "" && names[p.ID] == "" {
				names[p.ID] = p.ID
			}
		}
	}
	for _, list := range frames {
		sort.SliceStable(list, func(i, j int) bool { return list[i].T < list[j].T })
	}
	snapshots := map[int]EconomySnapshot{}
	sampled, sampledFrame := false, false
	for _, r := range rounds {
		s := statisticsEconomySnapshot(r, frames[r.Number])
		if d.StatisticsVersion > 0 && s.Source == "sampled_cache" {
			s.Source = "sampled_frame"
		}
		snapshots[r.Number] = s
		sampled = sampled || s.Source == "sampled_cache"
		sampledFrame = sampledFrame || s.Source == "sampled_frame"
		for _, p := range s.Players {
			if p.ID != "" && names[p.ID] == "" {
				names[p.ID] = p.ID
			}
		}
	}
	teamAt, teamGroups := statisticsTeamGroups(d, rounds, snapshots, frames)
	// Determine actual swap boundaries before assigning any half. Incremental
	// MR12 guesses would mislabel R13 and count an MR15 R16 swap as overtime.
	previousCT, previousT, previousNumber := "", "", 0
	swaps := []int{}
	observedRosterRounds := map[int]bool{}
	for _, r := range rounds {
		ct, t := "", ""
		if g := teamAt[r.Number][3]; g != nil {
			ct = g.team.ID
		}
		if g := teamAt[r.Number][2]; g != nil {
			t = g.team.ID
		}
		if previousNumber+1 == r.Number && previousCT != "" && previousT != "" && ct == previousT && t == previousCT {
			swaps = append(swaps, r.Number)
		}
		if ct != "" && t != "" {
			observedRosterRounds[r.Number] = true
			previousCT, previousT, previousNumber = ct, t, r.Number
		}
	}
	useRosterHalves := len(rounds) > 0 && rounds[0].Number == 1 && len(swaps) > 0
	regulationEnd, overtimeHalfLength := 0, 3
	overtimeSource := "roster_swap_overtime_mr3"
	if useRosterHalves {
		regulationEnd = 2 * (swaps[0] - 1)
		overtimeStart := regulationEnd + 1
		// Overtime starts a new half even when both teams retain their sides.
		// A complete observation of its first side change can identify a custom
		// overtime length. Sparse recordings retain the explicit MR3 assumption.
		for _, boundary := range swaps {
			if boundary <= overtimeStart {
				continue
			}
			complete := true
			for number := overtimeStart; number <= boundary; number++ {
				if !observedRosterRounds[number] {
					complete = false
					break
				}
			}
			if complete {
				overtimeHalfLength = boundary - overtimeStart
				overtimeSource = "roster_swap_overtime_observed"
			}
			break
		}
	}
	halfSeen := map[int]bool{}
	roundIndex := map[int]int{}
	for _, r := range rounds {
		s := snapshots[r.Number]
		half, halfSource, pistol := s.Half, s.HalfSource, s.Pistol
		if half <= 0 || !strings.HasPrefix(halfSource, "convar") {
			if useRosterHalves {
				half = 1
				halfSource = "roster_swap"
				if r.Number >= swaps[0] {
					half = 2
				}
				if r.Number > regulationEnd {
					half = 3 + (r.Number-regulationEnd-1)/overtimeHalfLength
					halfSource = overtimeSource
				}
				pistol = r.Number == 1 || r.Number == swaps[0]
			} else {
				half = statisticsFallbackHalf(r.Number)
				halfSource = "default_mr12"
				pistol = r.Number == 1 || r.Number == 13
			}
		}
		if halfSource == "" {
			halfSource = "unknown"
		}
		if half > 2 {
			pistol = false
		}
		halfSeen[half] = true
		roundIndex[r.Number] = len(out.Rounds)
		out.Rounds = append(out.Rounds, StatisticsRound{Number: r.Number, Start: r.Start, End: r.End, FreezeEnd: r.FreezeEnd, Half: half, HalfSource: halfSource, Pistol: pistol, CT: statisticsEconomy(s, 3, pistol, names, teamAt[r.Number][3]), T: statisticsEconomy(s, 2, pistol, names, teamAt[r.Number][2]), Players: []StatisticsPlayer{}})
	}
	for index, e := range d.Events {
		if e.Type != "kill" && e.Type != "death" {
			continue
		}
		var r *StatisticsRound
		if i, ok := roundIndex[e.Round]; ok {
			r = &out.Rounds[i]
		}
		out.Kills = append(out.Kills, statisticsScore(d, e, index, r, frames[e.Round], names, teamAt[e.Round]))
	}
	sort.SliceStable(out.Kills, func(i, j int) bool { return out.Kills[i].Time < out.Kills[j].Time })
	out.Summary, out.Players = statisticsAggregate(out.Kills, names, func(KillScore, bool) bool { return true })
	// Include observed players with zero events in every selected scope.
	allIDs := map[string]bool{}
	for id := range names {
		allIDs[id] = true
	}
	out.Players = statisticsPadPlayers(out.Players, names, allIDs)
	roster := func(round, half, side int, team string) map[string]bool {
		ids := map[string]bool{}
		for _, r := range out.Rounds {
			if round > 0 && r.Number != round || half > 0 && r.Half != half {
				continue
			}
			add := func(players []PlayerFrame) {
				for _, p := range players {
					if !p.Connected || !analysisSide(p.Team) || side > 0 && side != p.Team {
						continue
					}
					g := teamAt[r.Number][p.Team]
					if team != "" && (g == nil || g.team.ID != team) {
						continue
					}
					ids[p.ID] = true
				}
			}
			add(snapshots[r.Number].Players)
			for _, f := range frames[r.Number] {
				if f.T >= r.Start && f.T <= r.End {
					add(f.Players)
				}
			}
		}
		return ids
	}
	for i := range out.Rounds {
		r := &out.Rounds[i]
		r.Summary, r.Players = statisticsAggregate(out.Kills, names, func(k KillScore, _ bool) bool { return k.Round == r.Number })
		r.Players = statisticsPadPlayers(r.Players, names, roster(r.Number, 0, 0, ""))
	}
	for _, side := range []int{3, 2} {
		g := StatisticsGroup{Side: side, Label: map[int]string{3: "CT", 2: "T"}[side]}
		g.Summary, g.Players = statisticsAggregate(out.Kills, names, func(k KillScore, victim bool) bool {
			if victim {
				return k.VictimSide == side
			}
			return k.KillerSide == side
		})
		g.Players = statisticsPadPlayers(g.Players, names, roster(0, 0, side, ""))
		out.Sides = append(out.Sides, g)
	}
	halfNumbers := []int{}
	for half := range halfSeen {
		halfNumbers = append(halfNumbers, half)
	}
	sort.Ints(halfNumbers)
	for _, half := range halfNumbers {
		g := StatisticsGroup{Half: half, Label: statisticsHalfLabel(half)}
		g.Summary, g.Players = statisticsAggregate(out.Kills, names, func(k KillScore, _ bool) bool { return k.Half == half })
		g.Players = statisticsPadPlayers(g.Players, names, roster(0, half, 0, ""))
		out.Halves = append(out.Halves, g)
	}
	for _, team := range teamGroups {
		g := StatisticsGroup{TeamKey: team.team.ID, Label: team.team.Name}
		g.Summary, g.Players = statisticsAggregate(out.Kills, names, func(k KillScore, victim bool) bool {
			if victim {
				return k.VictimTeamKey == team.team.ID
			}
			return k.KillerTeamKey == team.team.ID
		})
		g.Players = statisticsPadPlayers(g.Players, names, roster(0, 0, 0, team.team.ID))
		out.Teams = append(out.Teams, g)
	}
	if sampled {
		out.Warnings = append(out.Warnings, "缺少冻结结束精确快照时，经济分类使用前后 0.25 秒内最近缓存采样；离开该窗口或字段不足时标未知。")
	}
	if sampledFrame {
		out.Warnings = append(out.Warnings, "本次已使用新版解析；部分回合未记录冻结结束事件，经济分类采用前后 0.25 秒内邻近帧推断，并逐回合标明；重新解析不能补造录像中缺失的事件。")
	}
	for _, k := range out.Kills {
		if k.Approx {
			out.Warnings = append(out.Warnings, "部分受害者手持武器来自同回合死亡前最近存活采样，可能遗漏瞬时切枪；逐条保留采样时间，不使用背包最高武器代替。")
			break
		}
	}
	for _, r := range out.Rounds {
		if r.HalfSource == "default_mr12" {
			out.Warnings = append(out.Warnings, "部分半场按默认 MR12 / 加时每半场 3 回合推断；无服务器规则或明确换边证据时，特殊赛制可能不适用。")
			break
		}
	}
	for _, r := range out.Rounds {
		if strings.Contains(r.HalfSource, "overtime_mr3") {
			out.Warnings = append(out.Warnings, "缺少明确加时半场长度时，按加时每半场 3 回合推断；即使加时开始未换边，也单独计入加时。")
			break
		}
	}
	return out
}
