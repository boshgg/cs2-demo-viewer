/* Pure aggregation of versioned, server-calculated impact scores. No scoring
 * coefficient is reapplied here: filters must never change event context. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayImpact = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const VERSION = '1';
  const array = value => Array.isArray(value) ? value : [];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const validRound = value => Number.isInteger(Number(value)) && Number(value) > 0;
  const sideOf = value => value === 2 || value === 3 || value === '2' || value === '3' ? Number(value) : 0;
  const set = value => value == null ? null : new Set(Array.isArray(value) || value instanceof Set ? value : [value]);
  const all = value => value == null || value === '' || value === 'all';
  const same = (value, filter) => all(filter) || String(value) === String(filter);
  const metadata = demo => ({ id: demo.id, name: text(demo.name) || demo.id, map: text(demo.map) || 'unknown' });
  const roundKey = (playerId, round) => JSON.stringify([playerId, Number(round)]);
  const halfLabel = half => half === 1 ? '上半场' : half === 2 ? '下半场' : half > 2 ? `加时第 ${half - 2} 半场` : '半场未知';
  const bands = Object.freeze([
    Object.freeze({ min: 500, code: 'excellent', label: '优秀', description: '按当前模型，平均每个有效参赛回合至少 +500 分。' }),
    Object.freeze({ min: 200, code: 'good', label: '良好', description: '按当前模型，平均每个有效参赛回合 +200 至不足 +500 分。' }),
    Object.freeze({ min: 0, code: 'balanced', label: '接近平衡 / 轻度正向', description: '按当前模型，平均每个有效参赛回合 0 至不足 +200 分。' }),
    Object.freeze({ min: -300, exclusive: true, code: 'negative', label: '负向', description: '按当前模型，平均每个有效参赛回合大于 −300、低于 0 分。' }),
    Object.freeze({ min: -Infinity, code: 'strong-negative', label: '明显负向', description: '按当前模型，平均每个有效参赛回合不高于 −300 分。' }),
  ]);

  // These are explicit model guideposts, not population percentiles or a
  // prediction of actual match win probability. Keep low samples unrated.
  function rating(summary = {}) {
    const value = summary.perRound;
    const selected = finite(value) ? bands.find(band => band.exclusive ? value > band.min : value >= band.min) : null;
    const band = selected ? { code: selected.code, label: selected.label, description: selected.description } : null;
    if (summary.unavailableDemos > 0 || !finite(summary.coverage) || summary.coverage < .9 || !(summary.scoredKills + summary.scoredDeaths > 0)) {
      return { code: 'insufficient-evidence', label: '证据不足', description: '需要有效参赛回合覆盖率达到 90%，且有可计分事件；缺失报告不按零分计算。', band };
    }
    if (!(summary.playerRounds >= 30)) return { code: 'insufficient-sample', label: '样本不足', description: '至少累计 30 个有效参赛回合后显示模型评级。', band };
    if (!band) return { code: 'insufficient-evidence', label: '证据不足', description: '没有可比较的每回合分数。', band };
    return { ...band, description: `${band.description} 这是暂定规则基准，不是实际胜率或全体玩家的平均水平。`, band };
  }

  function aggregate(datasets, filter = {}) {
    filter ||= {};
    const demoIds = set(filter.demoIds), playerIds = set(filter.playerIds), sides = set(filter.sides);
    const selected = new Map();
    for (const demo of array(datasets)) if (demo && typeof demo.id === 'string' && demo.id.trim() && (!demoIds || demoIds.has(demo.id))) selected.set(demo.id, demo);
    const scope = [...selected.values()].filter(demo => all(filter.map) || metadata(demo).map === filter.map);
    const warnings = new Set(), unavailableDemos = [], kills = [], deaths = [];
    const playerMap = new Map(), demoMap = new Map(), mapMap = new Map(), sideMap = new Map(), halfMap = new Map(), roundMap = new Map();
    const people = new WeakMap();
    const createSummary = () => {
      const summary = { killContribution: 0, deathPenalty: 0, combined: 0, playerRounds: 0, perRound: null, per24Rounds: null,
        scoredKills: 0, scoredDeaths: 0, excludedKills: 0, excludedDeaths: 0, observedPlayerRounds: 0, coverage: null,
        eventCoverage: null, approximateEvents: 0, approximatePlayerRounds: 0, firstDeaths: 0, economyPenalty: 0, unavailableDemos: 0, selectedPlayers: 0, rating: null };
      people.set(summary, new Set());
      return summary;
    };
    const summary = createSummary();
    const group = (map, key, initial) => {
      if (!map.has(key)) map.set(key, { ...initial, summary: createSummary() });
      return map.get(key);
    };
    const matches = row => {
      if (!row || typeof row.playerId !== 'string' || !row.playerId.trim()) return false;
      return (!playerIds || playerIds.has(row.playerId)) && same(row.playerId, filter.player) && same(row.teamKey, filter.team)
        && (sides ? sides.has(sideOf(row.side)) || sides.has(String(sideOf(row.side))) : same(sideOf(row.side), filter.side))
        && same(row.half, filter.half) && same(row.round, filter.round);
    };
    const targets = (row, demo) => {
      const player = group(playerMap, row.playerId, { id: row.playerId, name: text(row.player) || row.playerId });
      if (player.name === player.id && text(row.player) && text(row.player) !== player.id) player.name = text(row.player);
      const side = sideOf(row.side), half = Number.isInteger(Number(row.half)) ? Number(row.half) : 0, round = validRound(row.round) ? Number(row.round) : 0;
      const key = JSON.stringify([demo.id, round]);
      const groups = [summary, player.summary, group(demoMap, demo.id, { demoId: demo.id, demoName: demo.name, map: demo.map }).summary,
        group(mapMap, demo.map, { map: demo.map }).summary, group(sideMap, side, { side, label: side === 3 ? 'CT' : side === 2 ? 'T' : '未知阵营' }).summary,
        group(halfMap, half, { half, label: halfLabel(half) }).summary,
        group(roundMap, key, { key, demoId: demo.id, demoName: demo.name, map: demo.map, round, half }).summary];
      for (const target of groups) people.get(target).add(row.playerId);
      return groups;
    };
    let available = 0;
    for (const dataset of scope) {
      const demo = metadata(dataset), report = dataset.impact;
      const demoGroup = group(demoMap, demo.id, { demoId: demo.id, demoName: demo.name, map: demo.map });
      const mapGroup = group(mapMap, demo.map, { map: demo.map });
      if (!report || report.version !== VERSION || !Array.isArray(report.rounds) || !Array.isArray(report.kills) || !Array.isArray(report.deaths)) {
        const reason = !report ? '尚无死亡影响报告，请使用新版解析或重新载入。' : '死亡影响报告版本或结构不受支持。';
        unavailableDemos.push({ ...demo, reason });
        warnings.add(`${demo.name}：${reason}`);
        demoGroup.summary.unavailableDemos++;
        mapGroup.summary.unavailableDemos++;
        continue;
      }
      available++;
      for (const warning of array(report.warnings)) if (text(warning)) warnings.add(`${demo.name}：${text(warning)}`);
      const exposures = new Map();
      for (const source of report.rounds) {
        if (!source || typeof source.playerId !== 'string' || !source.playerId.trim() || !validRound(source.round)) continue;
        const row = { ...source }, key = roundKey(row.playerId, row.round);
        if (!exposures.has(key)) exposures.set(key, row);
        else {
          const previous = exposures.get(key);
          // Duplicates never add another denominator. Conflicting evidence must
          // not make an incomplete player-round look eligible.
          previous.approx = !!previous.approx || !!row.approx;
          if (previous.eligible !== true || row.eligible !== true || sideOf(previous.side) !== sideOf(row.side) || String(previous.half) !== String(row.half) || previous.teamKey !== row.teamKey) {
            previous.eligible = false;
            previous.reason = previous.reason || row.reason || '重复参赛记录存在冲突';
          }
        }
      }
      for (const row of [...report.kills, ...report.deaths]) {
        if (!row || typeof row.playerId !== 'string' || !row.playerId.trim() || !validRound(row.round)) continue;
        const key = roundKey(row.playerId, row.round);
        if (!exposures.has(key)) exposures.set(key, { round: row.round, half: row.half, playerId: row.playerId, player: row.player, side: row.side, teamKey: row.teamKey, eligible: false, reason: '缺少对应参赛回合证据', approx: true });
      }
      for (const row of exposures.values()) {
        if (!matches(row)) continue;
        for (const target of targets(row, demo)) {
          target.observedPlayerRounds++;
          if (row.eligible === true) target.playerRounds++;
          if (row.approx) target.approximatePlayerRounds++;
        }
      }
      const addEvents = (events, kind, destination) => events.forEach((row, ordinal) => {
        if (!matches(row)) return;
        const exposure = validRound(row.round) ? exposures.get(roundKey(row.playerId, row.round)) : null;
        const value = kind === 'kill' ? row.score : row.penalty;
        const validValue = finite(value) && (kind === 'kill' ? value >= 0 : value <= 0);
        let aggregationExcludedReason = '';
        if (!exposure || exposure.eligible !== true) aggregationExcludedReason = exposure?.reason || '缺少有效参赛回合证据';
        else if (!matches(exposure) || sideOf(row.side) !== sideOf(exposure.side) || String(row.half) !== String(exposure.half) || row.teamKey !== exposure.teamKey) aggregationExcludedReason = '事件与参赛回合的阵营、阶段或队伍证据不一致';
        else if (text(row.excludedReason)) aggregationExcludedReason = row.excludedReason;
        else if (!validValue) aggregationExcludedReason = '事件影响分缺失或无效';
        const included = !aggregationExcludedReason;
        destination.push({ ...row, demoId: demo.id, demoName: demo.name, map: demo.map, key: JSON.stringify([demo.id, kind, row.index ?? null, ordinal]), included, aggregationExcludedReason });
        for (const target of targets(row, demo)) {
          if (row.approx) target.approximateEvents++;
          if (kind === 'kill') {
            if (included) { target.scoredKills++; target.killContribution += value; }
            else target.excludedKills++;
          } else if (included) {
            target.scoredDeaths++; target.deathPenalty += value;
            if (row.firstDeath === true) target.firstDeaths++;
            if (finite(row.economyPenalty) && row.economyPenalty > 0) target.economyPenalty += row.economyPenalty;
          } else target.excludedDeaths++;
        }
      });
      addEvents(report.kills, 'kill', kills);
      addEvents(report.deaths, 'death', deaths);
    }
    summary.unavailableDemos = unavailableDemos.length;
    // A missing report cannot prove that a selected player did not participate.
    // Conservatively withhold their aggregate rating, while retaining measured
    // contributions and explicit warnings for the successfully read reports.
    if (unavailableDemos.length) for (const player of playerMap.values()) player.summary.unavailableDemos = unavailableDemos.length;
    const finalize = target => {
      target.combined = target.killContribution + target.deathPenalty;
      target.perRound = target.playerRounds ? target.combined / target.playerRounds : null;
      target.per24Rounds = target.perRound == null ? null : target.perRound * 24;
      target.coverage = target.observedPlayerRounds ? target.playerRounds / target.observedPlayerRounds : null;
      const scored = target.scoredKills + target.scoredDeaths, events = scored + target.excludedKills + target.excludedDeaths;
      target.eventCoverage = events ? scored / events : null;
      target.selectedPlayers = people.get(target).size;
      target.rating = rating(target);
      if (target.selectedPlayers > 1) target.rating = { ...target.rating, individualCode: target.rating.code, code: 'aggregate', label: '所选玩家平均', description: `按玩家回合加权平均，不代表整个团队的竞技评级。${target.rating.description}` };
      return target;
    };
    finalize(summary);
    for (const map of [playerMap, demoMap, mapMap, sideMap, halfMap, roundMap]) for (const item of map.values()) finalize(item.summary);
    const players = [...playerMap.values()].sort((a, b) => (b.summary.perRound ?? -Infinity) - (a.summary.perRound ?? -Infinity) || b.summary.combined - a.summary.combined || compare(a.name, b.name) || compare(a.id, b.id));
    return { version: VERSION, status: !scope.length ? 'empty' : !available ? 'unavailable' : unavailableDemos.length ? 'partial' : 'ready',
      demos: scope.map(metadata), unavailableDemos, warnings: [...warnings], summary, players,
      byDemo: [...demoMap.values()], byMap: [...mapMap.values()].sort((a, b) => compare(a.map, b.map)),
      bySide: [...sideMap.values()].sort((a, b) => b.side - a.side), byHalf: [...halfMap.values()].sort((a, b) => a.half - b.half),
      byRound: [...roundMap.values()].sort((a, b) => compare(a.demoId, b.demoId) || a.round - b.round), kills, deaths };
  }
  return { aggregate, rating, version: VERSION, bands };
});
