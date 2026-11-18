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
  const movementDuration = 115;
  const eventMetrics = ['engagements', 'deaths', 'shots'];
  function normalizeMovementTime(value) {
    if (!value || typeof value !== 'object' || !valid(value.start) || !valid(value.end)) return null;
    let start = Math.max(0, Math.min(movementDuration, Math.round(value.start)));
    let end = Math.max(0, Math.min(movementDuration, Math.round(value.end)));
    if (start > end) [start, end] = [end, start];
    if (start === end) {
      if (end < movementDuration) end++;
      else start--;
    }
    return { start, end };
  }
  const utilityTimeBuckets = Object.freeze([
    { key: '0-5', label: '开局 0–5 秒' }, { key: '5-20', label: '5–20 秒' },
    { key: '20-50', label: '20–50 秒' }, { key: '50+', label: '50 秒以后' },
    { key: 'unknown', label: '时间未知' },
  ].map(Object.freeze));
  function utilityTimeBucket(utility) {
    const elapsed = utility?.roundElapsed;
    // Absolute replay time and a detonation time are not release-time evidence.
    // Legacy summaries remain unknown until timing evidence is added from replay data.
    if (utility?.throwObserved !== true || utility?.timeSource !== 'freeze_end' || !valid(elapsed) || elapsed < 0) return 'unknown';
    const epsilon = 1e-7;
    if (elapsed <= 5 + epsilon) return '0-5';
    if (elapsed <= 20 + epsilon) return '5-20';
    if (elapsed <= 50 + epsilon) return '20-50';
    return '50+';
  }
  function utilityTimeLabel(key) { return key === 'all' ? '全部时间' : utilityTimeBuckets.find(bucket => bucket.key === key)?.label || '时间未知'; }
  function utilityPlantPhaseLabel(key) {
    switch (key) {
      case 'all': return '全部阶段';
      case 'pre': return '下包前';
      case 'post': return '下包后';
      default: return '阶段未知';
    }
  }
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
    const movementTime = normalizeMovementTime(filter.movementTime);
    const plantPhase = ['pre', 'post'].includes(filter.plantPhase) ? filter.plantPhase : 'all';
    const utilityPlantPhase = ['pre', 'post'].includes(filter.utilityPlantPhase) ? filter.utilityPlantPhase : 'all';
    const utilityPlantPhaseCounts = { all: 0, pre: 0, post: 0, unknown: 0 };
    const missingPlantPhaseDemos = [];
    let unknownPlantRounds = 0;
    const movementCoverage = movementTime ? { status: 'empty', selectedDemos: 0, timedDemos: 0, missingDemos: 0, missingDemoIds: [], totalSeconds: 0, timedSeconds: 0, unknownSeconds: 0, beyondSeconds: 0, selectedSeconds: 0, coverage: null } : null;
    const heatmapCoverage = movementTime ? { movement: movementCoverage, ...Object.fromEntries(eventMetrics.map(metric => [metric, { status: 'empty', selectedDemos: 0, timedDemos: 0, missingDemos: 0, missingDemoIds: [], totalCount: 0, timedCount: 0, unknownCount: 0, beyondCount: 0, selectedCount: 0, coverage: null }])) } : null;
    const ids = asSet(filter.demoIds), players = asSet(filter.playerIds), teams = asSet(filter.teamIds), sides = asSet(filter.sides?.map(Number));
    const cells = new Map(), utilities = [], seenUtilities = new Set(), includedPlayers = new Set(), includedTeams = new Set(), includedDemos = new Set();
    const utilityTimeCounts = Object.fromEntries(utilityTimeBuckets.map(bucket => [bucket.key, 0]));
    const selectedTime = utilityTimeBuckets.some(bucket => bucket.key === filter.utilityTime) ? filter.utilityTime : 'all';
    const totals = { movementSeconds: 0, engagements: 0, deaths: 0, shots: 0, utilities: 0, players: 0, teams: 0, demos: 0, rounds: 0 };
    const selectedFloor = filter.floor || 'all';
    const includeFloor = z => selectedFloor === 'all' || floorOf(z, filter.lowerMaxZ) === selectedFloor;
    for (const d of demos) {
      if (d.map !== map || !chosen(ids, d.id)) continue;
      let contributed = false;
      let movementObserved = false;
      const phaseFiltered = plantPhase !== 'all';
      const phaseAvailable = d.plantPhaseVersion === 1;
      if (phaseFiltered && !phaseAvailable) missingPlantPhaseDemos.push(d.id);
      if (phaseFiltered && phaseAvailable && Array.isArray(d.plantPhaseUnknownRounds)) unknownPlantRounds += d.plantPhaseUnknownRounds.length;
      const timingAvailable = phaseFiltered ? phaseAvailable : d.movementTimingVersion === 1;
      const eventsAvailable = phaseFiltered ? phaseAvailable : d.eventTimingVersion === 1, eventsObserved = [false, false, false];
      for (const source of d.series || []) {
        const playerId = String(source.playerId), teamId = teamKey(d.id, source.teamId, filter.teamAliases);
        if (!chosen(players, playerId) || !chosen(teams, teamId) || !chosen(sides, Number(source.side))) continue;
        const series = phaseFiltered ? phaseAvailable && source.plantPhases?.[plantPhase] : source;
        if (!series) continue;
        let populated = false;
        let fullSeconds = 0, fullCellCount = 0;
        const fullEvents = [0, 0, 0];
        for (const row of series.cells || []) {
          if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 3).every(valid) || !includeFloor(row[2])) continue;
          const values = [3, 4, 5, 6].map(i => valid(row[i]) && row[i] > 0 ? row[i] : 0);
          if (!values.some(v => v > 0)) continue;
          // Keep original scope counts even when this player's observations
          // fall outside the shared heatmap interval.
          populated = true;
          if (movementTime) {
            fullSeconds += values[0];
            if (values[0] > 0) fullCellCount++;
            for (let i = 0; i < 3; i++) fullEvents[i] += values[i + 1];
            continue;
          }
          const key = `${row[0]},${row[1]},${row[2]}`;
          if (!cells.has(key)) cells.set(key, [row[0], row[1], row[2], 0, 0, 0, 0]);
          const target = cells.get(key);
          values.forEach((v, i) => { target[i + 3] += v; });
          totals.movementSeconds += values[0]; totals.engagements += values[1]; totals.deaths += values[2]; totals.shots += values[3];
        }
        if (movementTime) {
          let timedSeconds = 0;
          if (timingAvailable) for (const row of series.movementTimeline || []) {
            if (!Array.isArray(row) || row.length < 5 || !valid(row[0]) || !valid(row[1]) || !valid(row[2]) || !includeFloor(row[2]) || !Number.isInteger(row[3]) || row[3] < 0 || row[3] >= movementDuration || !valid(row[4]) || row[4] <= 0) continue;
            timedSeconds += row[4];
            populated = true;
            // Bins represent [second, second + 1), so an end of 115
            // includes bin 114, never the post-countdown observations.
            if (row[3] < movementTime.start || row[3] >= movementTime.end) continue;
            const key = `${row[0]},${row[1]},${row[2]}`;
            if (!cells.has(key)) cells.set(key, [row[0], row[1], row[2], 0, 0, 0, 0]);
            cells.get(key)[3] += row[4];
            totals.movementSeconds += row[4];
          }
          let unknownSeconds = 0, beyondSeconds = 0;
          if (timingAvailable) for (const row of series.movementUntimedCells || []) {
            if (!Array.isArray(row) || row.length < 5 || !valid(row[0]) || !valid(row[1]) || !valid(row[2]) || !includeFloor(row[2])) continue;
            if (valid(row[3]) && row[3] > 0) unknownSeconds += row[3];
            if (valid(row[4]) && row[4] > 0) beyondSeconds += row[4];
          }
          // Movement has its own weighted elevation, independent from shots
          // and deaths. Its spatial evidence, rather than a mixed-metric Z,
          // determines floor-scoped coverage. Legacy caches stay unknown.
          if (!timingAvailable || (!Array.isArray(series.movementTimeline) && !Array.isArray(series.movementUntimedCells))) unknownSeconds = fullSeconds;
          else if (selectedFloor === 'all') {
            // Legacy cells round each duration to 4 decimals, while timelines
            // preserve observed precision. Only deficits beyond that error
            // bound indicate missing or malformed timing evidence.
            const deficit = fullSeconds - timedSeconds - unknownSeconds - beyondSeconds;
            if (deficit > fullCellCount * .00005 + 1e-6) unknownSeconds += deficit;
          }
          const observedSeconds = timedSeconds + unknownSeconds + beyondSeconds;
          movementCoverage.totalSeconds += observedSeconds;
          movementCoverage.timedSeconds += timedSeconds;
          movementCoverage.beyondSeconds += beyondSeconds;
          movementCoverage.unknownSeconds += unknownSeconds;
          if (observedSeconds > 0) movementObserved = true;

          const timed = [0, 0, 0], unknown = [0, 0, 0], beyond = [0, 0, 0];
          if (eventsAvailable) for (const row of series.eventTimeline || []) {
            if (!Array.isArray(row) || row.length < 7 || !valid(row[0]) || !valid(row[1]) || !valid(row[2]) || !includeFloor(row[2]) || !Number.isInteger(row[3]) || row[3] < 0 || row[3] >= movementDuration) continue;
            const inRange = row[3] >= movementTime.start && row[3] < movementTime.end;
            let target;
            for (let i = 0; i < 3; i++) {
              const value = row[i + 4];
              if (!valid(value) || value <= 0) continue;
              timed[i] += value; populated = true;
              if (!inRange) continue;
              if (!target) {
                const key = `${row[0]},${row[1]},${row[2]}`;
                if (!cells.has(key)) cells.set(key, [row[0], row[1], row[2], 0, 0, 0, 0]);
                target = cells.get(key);
              }
              target[i + 4] += value; totals[eventMetrics[i]] += value;
            }
          }
          if (eventsAvailable) for (const row of series.eventUntimedCells || []) {
            if (!Array.isArray(row) || row.length < 9 || !valid(row[0]) || !valid(row[1]) || !valid(row[2]) || !includeFloor(row[2])) continue;
            for (let i = 0; i < 3; i++) {
              if (valid(row[i + 3]) && row[i + 3] > 0) unknown[i] += row[i + 3];
              if (valid(row[i + 6]) && row[i + 6] > 0) beyond[i] += row[i + 6];
            }
          }
          for (let i = 0; i < 3; i++) {
            if (!eventsAvailable || (!Array.isArray(series.eventTimeline) && !Array.isArray(series.eventUntimedCells))) unknown[i] = fullEvents[i];
            // As with movement, each metric has independent Z evidence.
            // Integer event counts need no per-cell rounding allowance.
            else if (selectedFloor === 'all') unknown[i] += Math.max(0, fullEvents[i] - timed[i] - unknown[i] - beyond[i]);
            const observed = timed[i] + unknown[i] + beyond[i], coverage = heatmapCoverage[eventMetrics[i]];
            coverage.totalCount += observed; coverage.timedCount += timed[i]; coverage.unknownCount += unknown[i]; coverage.beyondCount += beyond[i];
            if (observed > 0) { eventsObserved[i] = true; populated = true; }
          }
        }
        if (populated) { includedPlayers.add(playerId); includedTeams.add(teamId); contributed = true; }
      }
      if (movementCoverage && movementObserved) {
        movementCoverage.selectedDemos++;
        if (timingAvailable) movementCoverage.timedDemos++;
        else { movementCoverage.missingDemos++; movementCoverage.missingDemoIds.push(d.id); }
      }
      if (heatmapCoverage) for (let i = 0; i < 3; i++) if (eventsObserved[i]) {
        const coverage = heatmapCoverage[eventMetrics[i]];
        coverage.selectedDemos++;
        if (eventsAvailable) coverage.timedDemos++;
        else { coverage.missingDemos++; coverage.missingDemoIds.push(d.id); }
      }
      for (const u of d.utilities || []) {
        const teamId = teamKey(d.id, u.teamId, filter.teamAliases), playerId = String(u.playerId || '');
        const key = `${d.id}|${u.id}`;
        if (seenUtilities.has(key) || !u.detonated || !position(u.end) || !includeFloor(u.end.z) || !chosen(players, playerId) || !chosen(teams, teamId) || !chosen(sides, Number(u.side))) continue;
        if (filter.utilityType && filter.utilityType !== 'all' && u.type !== filter.utilityType) continue;
        seenUtilities.add(key);
        const timeBucket = utilityTimeBucket(u);
        const phase = d.utilityPlantPhaseVersion === 1 && u.throwObserved === true && (u.plantPhase === 'pre' || u.plantPhase === 'post') ? u.plantPhase : 'unknown';
        const timeMatches = selectedTime === 'all' || timeBucket === selectedTime;
        const phaseMatches = utilityPlantPhase === 'all' || phase === utilityPlantPhase;
        if (phaseMatches) utilityTimeCounts[timeBucket]++;
        if (timeMatches) {
          utilityPlantPhaseCounts.all++;
          utilityPlantPhaseCounts[phase]++;
        }
        if (playerId) includedPlayers.add(playerId);
        includedTeams.add(teamId); contributed = true;
        if (!timeMatches || !phaseMatches) continue;
        utilities.push({ ...u, plantPhase: phase, start: u.throwObserved && position(u.start) ? u.start : null, demoId: d.id, demoName: d.name, map: d.map, playerId, teamId, key, timeBucket });
      }
      if (contributed) { includedDemos.add(d.id); totals.rounds += Number(d.roundCount) || 0; }
    }
    totals.utilities = utilities.length; totals.players = includedPlayers.size; totals.teams = includedTeams.size; totals.demos = includedDemos.size;
    if (movementCoverage) {
      movementCoverage.selectedSeconds = totals.movementSeconds;
      if (movementCoverage.totalSeconds > 0) {
        movementCoverage.coverage = Math.min(1, (movementCoverage.timedSeconds + movementCoverage.beyondSeconds) / movementCoverage.totalSeconds);
        movementCoverage.status = movementCoverage.unknownSeconds > 1e-6 ? (movementCoverage.timedSeconds > 0 ? 'partial' : 'missing') : 'ready';
      }
      for (const metric of eventMetrics) {
        const coverage = heatmapCoverage[metric];
        coverage.selectedCount = totals[metric];
        if (coverage.totalCount > 0) {
          coverage.coverage = Math.min(1, (coverage.timedCount + coverage.beyondCount) / coverage.totalCount);
          coverage.status = coverage.unknownCount > 0 ? (coverage.timedCount > 0 ? 'partial' : 'missing') : 'ready';
        }
      }
    }
    return { map, cells: [...cells.values()], utilities, utilityTimeCounts, utilityPlantPhase, utilityPlantPhaseCounts, totals, movementTime, movementCoverage, heatmapCoverage, plantPhase, missingPlantPhaseDemos, unknownPlantRounds };
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
  return { aggregate, clusterUtilities, uniqueDemos, teamKey, floorOf, csv, utilityTimeBucket, utilityTimeLabel, utilityTimeBuckets, utilityPlantPhaseLabel, normalizeMovementTime, movementDuration };
});
