/* Pure analysis operations, shared by the page, its worker, and Node tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayAnalysis = api;
  if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof importScripts === 'function') {
    let datasets = [];
    self.onmessage = ({ data }) => {
      try {
        if (data.type === 'datasets') { datasets = data.datasets; return; }
        const result = api.aggregate(datasets, data.filter);
        result.groups = api.clusterUtilities(result.utilities, data.cluster);
        self.postMessage({ id: data.id, result });
      } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const valid = n => typeof n === 'number' && Number.isFinite(n);
  const position = p => !!p && valid(p.x) && valid(p.y) && valid(p.z);
  const asSet = x => x == null ? null : new Set(x);
  const chosen = (set, value) => !set || set.has(value);
  const distance2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  function uniqueDemos(demos) {
    const result = [], ids = new Set();
    for (const d of demos || []) if (d && d.id && !ids.has(d.id)) { ids.add(d.id); result.push(d); }
    return result;
  }
  function teamKey(demoId, teamId, aliases = {}) {
    const alias = String(aliases[`${demoId}|${teamId}`] ?? aliases[teamId] ?? '').trim();
    return alias ? `alias:${alias.normalize('NFKC').toLocaleLowerCase()}` : String(teamId || `${demoId}:unknown`);
  }
  function floorOf(z, lowerMaxZ) { return valid(lowerMaxZ) ? (z < lowerMaxZ ? 'lower' : 'upper') : 'all'; }
  function aggregate(input, filter = {}) {
    const demos = uniqueDemos(input), map = filter.map || demos[0]?.map || '';
    const ids = asSet(filter.demoIds), players = asSet(filter.playerIds), teams = asSet(filter.teamIds), sides = asSet(filter.sides?.map(Number));
    const cells = new Map(), utilities = [], seenUtilities = new Set(), includedPlayers = new Set(), includedTeams = new Set(), includedDemos = new Set();
    const totals = { movementSeconds: 0, engagements: 0, deaths: 0, shots: 0, utilities: 0, players: 0, teams: 0, demos: 0, rounds: 0 };
    const selectedFloor = filter.floor || 'all';
    const includeFloor = z => selectedFloor === 'all' || floorOf(z, filter.lowerMaxZ) === selectedFloor;
    for (const d of demos) {
      if (d.map !== map || !chosen(ids, d.id)) continue;
      let contributed = false;
      for (const series of d.series || []) {
        const playerId = String(series.playerId), teamId = teamKey(d.id, series.teamId, filter.teamAliases);
        if (!chosen(players, playerId) || !chosen(teams, teamId) || !chosen(sides, Number(series.side))) continue;
        let populated = false;
        for (const row of series.cells || []) {
          if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 3).every(valid) || !includeFloor(row[2])) continue;
          const values = [3, 4, 5, 6].map(i => valid(row[i]) && row[i] > 0 ? row[i] : 0);
          if (!values.some(v => v > 0)) continue;
          const key = `${row[0]},${row[1]},${row[2]}`;
          if (!cells.has(key)) cells.set(key, [row[0], row[1], row[2], 0, 0, 0, 0]);
          const target = cells.get(key);
          values.forEach((v, i) => { target[i + 3] += v; });
          totals.movementSeconds += values[0]; totals.engagements += values[1]; totals.deaths += values[2]; totals.shots += values[3];
          populated = true;
        }
        if (populated) { includedPlayers.add(playerId); includedTeams.add(teamId); contributed = true; }
      }
      for (const u of d.utilities || []) {
        const teamId = teamKey(d.id, u.teamId, filter.teamAliases), playerId = String(u.playerId || '');
        const key = `${d.id}|${u.id}`;
        if (seenUtilities.has(key) || !u.detonated || !position(u.end) || !includeFloor(u.end.z) || !chosen(players, playerId) || !chosen(teams, teamId) || !chosen(sides, Number(u.side))) continue;
        if (filter.utilityType && filter.utilityType !== 'all' && u.type !== filter.utilityType) continue;
        seenUtilities.add(key);
        utilities.push({ ...u, start: u.throwObserved && position(u.start) ? u.start : null, demoId: d.id, demoName: d.name, map: d.map, playerId, teamId, key });
        if (playerId) includedPlayers.add(playerId);
        includedTeams.add(teamId); contributed = true;
      }
      if (contributed) { includedDemos.add(d.id); totals.rounds += Number(d.roundCount) || 0; }
    }
    totals.utilities = utilities.length; totals.players = includedPlayers.size; totals.teams = includedTeams.size; totals.demos = includedDemos.size;
    return { map, cells: [...cells.values()], utilities, totals };
  }
  function clusterUtilities(input, options = {}) {
    const landing = Math.max(1, Math.min(1024, Number(options.landing) || 128));
    const throwing = Math.max(1, Math.min(1024, Number(options.throwing) || 64));
    const zLimit = Math.max(1, Number(options.zLimit) || 96), maxDistance = landing * landing;
    const sameLayer = (a, b) => floorOf(a.z, options.lowerMaxZ) === floorOf(b.z, options.lowerMaxZ) && Math.abs(a.z - b.z) <= zLimit;
    const close = (a, b, limit) => sameLayer(a, b) && distance2(a, b) <= limit;
    // Coordinate ordering makes complete-link groups independent of import order.
    const values = [...input].filter(u => u.detonated && position(u.end)).sort((a, b) => String(a.type).localeCompare(String(b.type)) || a.end.x - b.end.x || a.end.y - b.end.y || a.end.z - b.end.z || String(a.key || a.id).localeCompare(String(b.key || b.id)));
    const groups = [], buckets = new Map();
    const bucketKey = (map, type, x, y) => `${map || ''}|${type}|${x}|${y}`;
    for (const item of values) {
      const gx = Math.floor(item.end.x / landing), gy = Math.floor(item.end.y / landing);
      let group;
      for (let dx = -1; dx <= 1 && !group; dx++) for (let dy = -1; dy <= 1 && !group; dy++) {
        for (const candidate of buckets.get(bucketKey(item.map, item.type, gx + dx, gy + dy)) || []) {
          if (candidate.items.every(other => close(item.end, other.end, maxDistance))) { group = candidate; break; }
        }
      }
      if (!group) {
        group = { id: `landing-${groups.length + 1}`, map: item.map, type: item.type, items: [], throws: [], end: item.end };
        groups.push(group);
        const key = bucketKey(item.map, item.type, gx, gy);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(group);
      }
      group.items.push(item);
    }
    for (const group of groups) {
      const sorted = group.items.slice().sort((a, b) => (a.start?.x ?? Infinity) - (b.start?.x ?? Infinity) || (a.start?.y ?? Infinity) - (b.start?.y ?? Infinity) || String(a.key || a.id).localeCompare(String(b.key || b.id)));
      for (const item of sorted) {
        const observedStart = item.throwObserved && position(item.start);
        let throwingGroup = observedStart && group.throws.find(g => !g.unknown && g.items.every(other => close(item.start, other.start, throwing * throwing) && close(item.end, other.end, throwing * throwing)));
        // Unknown release positions are not evidence of an identical throw.
        if (!throwingGroup) {
          throwingGroup = { id: `${group.id}-throw-${group.throws.length + 1}`, items: [], unknown: !observedStart, start: observedStart ? item.start : null, end: item.end };
          group.throws.push(throwingGroup);
        }
        throwingGroup.items.push(item);
      }
      group.count = group.items.length;
      group.percent = values.length ? group.count / values.length * 100 : 0;
      group.demoCount = new Set(group.items.map(u => u.demoId)).size;
      group.playerCount = new Set(group.items.map(u => u.playerId)).size;
      group.unknownStarts = group.items.filter(u => !u.throwObserved || !position(u.start)).length;
      group.throws.forEach(g => { g.count = g.items.length; });
      group.throws.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    }
    return groups.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }
  function csv(rows) {
    return '\ufeff' + rows.map(row => row.map(value => {
      const text = String(value ?? '');
      // Spreadsheet formulas in player names or filenames remain literal text.
      const safe = typeof value === 'string' && /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    }).join(',')).join('\r\n');
  }
  return { aggregate, clusterUtilities, uniqueDemos, teamKey, floorOf, csv };
});
