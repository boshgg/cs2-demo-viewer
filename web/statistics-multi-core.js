/* Pure cross-demo statistics. Final scores come from the single-demo API. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayMultiStatistics = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const array = value => Array.isArray(value) ? value : [];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const asSet = value => value == null ? null : new Set(Array.isArray(value) || value instanceof Set ? value : [value]);
  const emptySummary = () => ({ kills: 0, scoredKills: 0, excludedKills: 0, score: 0, deaths: 0, headshots: 0, pistolMismatchKills: 0, average: null });
  const validScore = kill => !kill.excludedReason && finite(kill.score);
  const isPistolMismatch = kill => validScore(kill) && [2, 5].includes(kill.killerValue) && kill.victimValue === 1;

  function isStablePlayerId(id) {
    // Match Go's analysisPlayerID: public individual desktop account, nonzero
    // account number. Never accept a JS number: Steam64 exceeds safe precision.
    if (typeof id !== 'string' || !/^\d{17}$/.test(id)) return false;
    const value = BigInt(id);
    return value >> 56n === 1n && (value >> 52n & 15n) === 1n && (value >> 32n & 0xfffffn) === 1n && (value & 0xffffffffn) !== 0n;
  }

  function metadata(demo) { return { id: demo.id, name: text(demo.name) || demo.id, map: text(demo.map) || 'unknown' }; }
  function selectedDatasets(datasets, filter) {
    const ids = asSet(filter.demoIds), unique = new Map();
    // A newer response for the same ID replaces an earlier revision; a demo
    // never supplies a second appearance just because it was loaded twice.
    for (const demo of array(datasets)) if (demo && typeof demo.id === 'string' && demo.id.trim() && (!ids || ids.has(demo.id))) unique.set(demo.id, demo);
    return [...unique.values()];
  }

  function roster(demo) {
    const people = new Map();
    const add = (id, name) => {
      if (!isStablePlayerId(id)) return;
      if (!people.has(id)) people.set(id, new Set());
      // The backend falls back to the ID when a name is unavailable. Do not
      // prefer that fallback over a real observed alias from another round.
      if (text(name) && text(name) !== id) people.get(id).add(text(name));
    };
    const addPlayers = players => { for (const player of array(players)) if (player) add(player.id, player.name); };
    addPlayers(demo.players);
    for (const round of array(demo.rounds)) if (round) { addPlayers(round.players); addPlayers(round.ct?.players); addPlayers(round.t?.players); }
    // These are identity rosters only; no team score or team aggregation is used.
    for (const group of [...array(demo.sides), ...array(demo.halves), ...array(demo.teams)]) if (group) addPlayers(group.players);
    // An observed kill/death also establishes participation when a partial
    // replay has no freeze-end roster. Scoring eligibility is separate.
    for (const kill of array(demo.kills)) if (kill) { add(kill.killerId, kill.killer); add(kill.victimId, kill.victim); }
    return people;
  }

  function prepare(datasets, filter = {}) {
    filter ||= {};
    const selected = selectedDatasets(datasets, filter), maps = new Map();
    for (const demo of selected) { const map = metadata(demo).map; maps.set(map, (maps.get(map) || 0) + 1); }
    const scope = selected.filter(demo => !filter.map || filter.map === 'all' || metadata(demo).map === filter.map);
    const demos = scope.map(metadata), people = new Map(), warnings = new Set();
    for (let i = 0; i < scope.length; i++) {
      const demo = scope[i], info = demos[i];
      for (const warning of array(demo.warnings)) if (text(warning)) warnings.add(`${info.name}：${text(warning)}`);
      for (const [id, names] of roster(demo)) {
        if (!people.has(id)) people.set(id, { names: new Set(), demos: [] });
        const player = people.get(id);
        for (const name of names) player.names.add(name);
        player.demos.push(info);
      }
    }
    const candidates = [...people.entries()].filter(([, player]) => player.demos.length >= 2).map(([id, player]) => {
      const names = [...player.names].sort(compare);
      return { id, name: names[0] || id, names, appearances: player.demos.length, demoIds: player.demos.map(demo => demo.id), demos: player.demos, maps: [...new Set(player.demos.map(demo => demo.map))].sort(compare) };
    }).sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
    const status = !demos.length ? 'no-demos' : demos.length < 2 ? 'need-more-demos' : !candidates.length ? 'no-repeat-players' : 'ready';
    return { demos, maps: [...maps].map(([map, demoCount]) => ({ map, demoCount })).sort((a, b) => compare(a.map, b.map)), demoCount: demos.length, candidates, warnings: [...warnings], status };
  }

  function addKill(summary, kill) {
    summary.kills++;
    if (kill.headshot) summary.headshots++;
    if (validScore(kill)) { summary.scoredKills++; summary.score += kill.score; }
    else summary.excludedKills++;
    if (isPistolMismatch(kill)) summary.pistolMismatchKills++;
  }
  function finalize(summary) { summary.average = summary.scoredKills ? summary.score / summary.scoredKills : null; return summary; }
  function sideOf(value) { return value === 2 || value === 3 || value === '2' || value === '3' ? Number(value) : 0; }
  function sideMatches(side, filter) {
    if (filter.sides != null) { const sides = asSet(filter.sides); return sides.has(side) || sides.has(String(side)); }
    return filter.side == null || filter.side === '' || filter.side === 'all' || String(side) === String(filter.side);
  }
  function halfMatches(kill, filter) { return filter.half == null || filter.half === '' || filter.half === 'all' || String(kill.half) === String(filter.half); }

  function aggregate(datasets, filter = {}) {
    filter ||= {};
    const prepared = prepare(datasets, filter), chosen = asSet(filter.playerIds);
    const players = prepared.candidates.filter(player => !chosen || chosen.has(player.id)).map(player => ({ ...player, summary: emptySummary() }));
    const byPlayer = new Map(players.map(player => [player.id, player]));
    const byDemo = prepared.demos.map(demo => ({ demoId: demo.id, demoName: demo.name, map: demo.map, summary: emptySummary() }));
    const demos = new Map(byDemo.map(demo => [demo.demoId, demo]));
    const maps = new Map([...new Set(prepared.demos.map(demo => demo.map))].sort(compare).map(map => [map, { map, summary: emptySummary() }]));
    const sides = new Map([3, 2].map(side => [side, { side, label: side === 3 ? 'CT' : 'T', summary: emptySummary() }]));
    const summary = emptySummary(), kills = [], matchups = new Map();
    const participantSummaries = (id, side, demo) => {
      if (!byPlayer.has(id) || !sideMatches(side, filter)) return [];
      if (!sides.has(side)) sides.set(side, { side, label: '未知阵营', summary: emptySummary() });
      return [summary, byPlayer.get(id).summary, demo.summary, maps.get(demo.map).summary, sides.get(side).summary];
    };
    for (const dataset of selectedDatasets(datasets, filter)) {
      const demo = demos.get(dataset.id);
      if (!demo) continue;
      array(dataset.kills).forEach((kill, ordinal) => {
        if (!kill || !halfMatches(kill, filter)) return;
        const killerSummaries = participantSummaries(kill.killerId, sideOf(kill.killerSide), demo);
        for (const target of killerSummaries) addKill(target, kill);
        for (const target of participantSummaries(kill.victimId, sideOf(kill.victimSide), demo)) target.deaths++;
        if (!killerSummaries.length) return;
        // Include the array ordinal even when an imported report reuses index.
        // Neither equal event indices nor equal round numbers across demos merge.
        kills.push({ ...kill, demoId: demo.demoId, demoName: demo.demoName, map: demo.map, key: JSON.stringify([demo.demoId, kill.index ?? null, ordinal]) });
        if (validScore(kill)) {
          const killerValue = [1, 2, 5, 7].includes(kill.killerValue) ? kill.killerValue : null;
          const victimValue = [1, 2, 5, 7].includes(kill.victimValue) ? kill.victimValue : null;
          const key = JSON.stringify([killerValue, victimValue]);
          if (!matchups.has(key)) matchups.set(key, { killerValue, victimValue, kills: 0, score: 0 });
          const matchup = matchups.get(key); matchup.kills++; matchup.score += kill.score;
        }
      });
    }
    for (const item of [summary, ...players.map(player => player.summary), ...byDemo.map(demo => demo.summary), ...[...maps.values()].map(map => map.summary), ...[...sides.values()].map(side => side.summary)]) finalize(item);
    players.sort((a, b) => b.summary.score - a.summary.score || b.summary.scoredKills - a.summary.scoredKills || compare(a.name, b.name) || compare(a.id, b.id));
    const valueOrder = value => value == null ? 99 : value;
    return { ...prepared, status: prepared.status === 'ready' && !players.length ? 'no-players-selected' : prepared.status,
      selectedPlayerIds: players.map(player => player.id), summary, players, byDemo, byMap: [...maps.values()], bySide: [...sides.values()], kills,
      matchups: [...matchups.values()].sort((a, b) => valueOrder(a.killerValue) - valueOrder(b.killerValue) || valueOrder(a.victimValue) - valueOrder(b.victimValue)) };
  }
  return { prepare, aggregate, isStablePlayerId };
});
