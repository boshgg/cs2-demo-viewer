const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const multi = require('../web/statistics-multi-core.js');
const single = require('../web/statistics.js');

const A = '76561198000000001', B = '76561198000000002', Z = '76561198000000003';
const X = '76561198000000004', Y = '76561198000000005', C = '76561198000000006';
const player = (id, name = id) => ({ id, name });
const kill = (index, killerId, victimId, score, killerValue, victimValue, extra = {}) => ({
  index, round: 2, half: 1, time: 20 + index, killerId, victimId,
  killer: killerId, victim: victimId, killerSide: 3, victimSide: 2,
  weapon: 'weapon', victimWeapon: 'held weapon', killerValue, victimValue, score,
  baseScore: score, scoreMultiplier: 1, excludedReason: '', weaponSource: 'death_event', approx: false, ...extra,
});
function fixture() {
  return [
    { id: 'a', name: 'A.dem', map: 'de_mirage', players: [player(A, 'Alpha'), player(B, 'Bravo'), player(X, 'Single A'), player(Z, 'Zero')], kills: [
      kill(0, A, X, 24, 1, 7, { baseScore: 6, scoreMultiplier: 4, headshot: true }),
      kill(1, B, A, -4, 5, 1, { killerSide: 2, victimSide: 3 }),
      kill(2, A, B, null, 5, null, { half: 2, excludedReason: '受害者手持刀', baseScore: null, scoreMultiplier: null, headshot: true }),
      kill(3, X, B, 4, 5, 7, { half: 2, baseScore: 2, scoreMultiplier: 2 }),
      kill(4, A, B, 0, 5, 5, { half: 2 }),
    ] },
    { id: 'b', name: 'B.dem', map: 'de_mirage', players: [player(A, 'Renamed'), player(B, 'Bravo'), player(Y, 'Single B'), player(Z, 'Zero')], kills: [
      kill(0, A, Y, -1, 2, 1, { killerSide: 2, victimSide: 3 }),
      kill(1, B, Y, 12, 1, 5, { half: 2, baseScore: 4, scoreMultiplier: 3 }),
      kill(2, '', A, null, null, null, { half: 2, killerSide: 0, excludedReason: '世界伤害', baseScore: null, scoreMultiplier: null }),
      kill(3, A, B, 6, 2, 5, { half: 2, killerSide: 2, victimSide: 3, baseScore: 3, scoreMultiplier: 2 }),
      kill(4, B, A, 0, 7, 7, { half: 2, approx: true, weaponSource: 'previous_tick', weaponTime: 23.9 }),
    ] },
  ];
}
function summary(score, kills, scoredKills, excludedKills, deaths, headshots = 0, pistolMismatchKills = 0) {
  return { score, kills, scoredKills, excludedKills, deaths, headshots, pistolMismatchKills, average: scoredKills ? score / scoredKills : null };
}
function deepFreeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }

test('stable IDs are exact public individual desktop Steam64 strings, never numeric or local identities', () => {
  const base = 76561197960265728n;
  for (const id of [A, String(base + 1n), String(base + 0xffffffffn)]) assert.equal(multi.isStablePlayerId(id), true, id);
  for (const id of [null, undefined, 76561198000000001, 0, '', 'bot-1', 'unknown', 'STEAM_1:0:1', '1', ` ${A}`, `${A} `, `0${A}`, '76561198abcdefghi', String(base), String(base + 0x100000000n), String(base + (1n << 56n)), String(base + (1n << 52n))]) assert.equal(multi.isStablePlayerId(id), false, String(id));
});

test('eligibility counts unique demo IDs, merges renamed players and excludes single-demo players from totals', () => {
  const data = fixture(), result = multi.aggregate([...data, ...data]);
  assert.equal(result.demoCount, 2); assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidates.map(p => p.id).sort(), [A, B, Z].sort());
  const renamed = result.candidates.find(p => p.id === A);
  assert.equal(renamed.appearances, 2); assert.deepEqual(renamed.demoIds, ['a', 'b']);
  assert.deepEqual(renamed.names, ['Alpha', 'Renamed']); assert.equal(renamed.name, 'Alpha');
  assert.deepEqual(result, multi.aggregate(data));
  assert.deepEqual(result.summary, summary(37, 8, 7, 1, 7, 2, 2));
  assert.deepEqual(result.players.find(p => p.id === A).summary, summary(29, 5, 4, 1, 3, 2, 1));
  assert.deepEqual(result.players.find(p => p.id === B).summary, summary(8, 3, 3, 0, 4, 0, 1));
  assert.deepEqual(result.players.find(p => p.id === Z).summary, summary(0, 0, 0, 0, 0));
  assert.equal(result.kills.some(k => k.killerId === X), false);
  assert.ok(result.kills.some(k => k.victimId === X), 'a once-seen opponent still contributes to a repeated player kill');
});

test('same names on different IDs and many round appearances in one demo never manufacture a repeated player', () => {
  const first = { id: 'first', players: [player(A, 'Same')], rounds: Array.from({ length: 30 }, () => ({ ct: { players: [player(A, 'Same')] }, players: [player(A, 'Same')] })) };
  const second = { id: 'second', players: [player(B, 'Same')] };
  assert.equal(multi.prepare([first, second]).status, 'no-repeat-players');
  assert.deepEqual(multi.prepare([first, first]).candidates, []);
  assert.equal(multi.prepare([first, first]).status, 'need-more-demos');
});

test('rosters retain repeated zero-event players and observed kills can identify participants in partial demos', () => {
  const data = [
    { id: 'a', rounds: [{ ct: { players: [player(A, 'Round roster')] }, t: { players: [player(Z)] } }], kills: [kill(1, B, X, 0, 1, 1)] },
    { id: 'b', sides: [{ players: [player(A)] }], halves: [{ players: [player(Z)] }], teams: [{ players: [player(Z)] }], kills: [kill(1, B, Y, 0, 1, 1)] },
  ];
  const result = multi.aggregate(data);
  assert.deepEqual(result.candidates.map(p => p.id).sort(), [A, B, Z].sort());
  assert.equal(result.players.find(p => p.id === A).summary.kills, 0);
  assert.equal(result.players.find(p => p.id === Z).appearances, 2);
  assert.equal(Object.hasOwn(result, 'teams'), false, 'team rosters must not produce team statistics');
});

test('bot, missing, synthetic, numeric and invalid Steam identities cannot qualify even when repeated and scored', () => {
  const invalid = ['bot-1', '', 'unknown', 'p1', 76561198000000001, '76561197960265728'];
  const data = ['a', 'b'].map(id => ({ id, players: invalid.map(id => player(id, 'Same')), kills: invalid.map((id, index) => kill(index, id, id, 100, 1, 7)) }));
  const result = multi.aggregate(data);
  assert.equal(result.status, 'no-repeat-players'); assert.deepEqual(result.players, []); assert.deepEqual(result.kills, []);
  assert.deepEqual(result.summary, summary(0, 0, 0, 0, 0));
});

test('map and demo scope recompute eligibility while player, side and half filters do not', () => {
  const data = [...fixture(), { id: 'c', name: 'C.dem', map: 'de_dust2', players: [player(A), player(C)] }];
  const all = multi.prepare(data), mirage = multi.prepare(data, { map: 'de_mirage' });
  assert.equal(all.candidates.find(p => p.id === A).appearances, 3);
  assert.deepEqual(all.candidates.find(p => p.id === A).maps, ['de_dust2', 'de_mirage']);
  assert.equal(mirage.candidates.find(p => p.id === A).appearances, 2);
  assert.deepEqual(mirage.maps, [{ map: 'de_dust2', demoCount: 1 }, { map: 'de_mirage', demoCount: 2 }]);
  assert.equal(multi.prepare(data, { map: 'de_dust2' }).status, 'need-more-demos');
  assert.deepEqual(multi.prepare(data, { map: 'all', demoIds: ['a', 'c'] }).candidates.map(p => p.id), [A]);
  assert.deepEqual(multi.prepare(data, { playerIds: [], side: '2', half: 99 }).candidates, all.candidates);
  assert.deepEqual(multi.aggregate(data, { map: 'de_mirage', playerIds: [A], side: '3', half: 1 }).candidates, mirage.candidates);
});

test('all player, CT/T, half and demo filters intersect with separate killer and victim semantics', () => {
  const data = fixture();
  assert.deepEqual(multi.aggregate(data, { playerIds: [A], side: '3', half: 1 }).summary, summary(24, 1, 1, 0, 1, 1, 0));
  assert.deepEqual(multi.aggregate(data, { playerIds: [B], side: 2 }).summary, summary(-4, 1, 1, 0, 3, 0, 1));
  assert.deepEqual(multi.aggregate(data, { half: 1 }).summary, summary(19, 3, 3, 0, 1, 1, 2));
  assert.deepEqual(multi.aggregate(data, { sides: [2] }).summary, multi.aggregate(data, { side: 2 }).summary);
  assert.deepEqual(multi.aggregate(data, { sides: [2, 3] }).summary, multi.aggregate(data).summary);
  assert.equal(multi.aggregate(data, { demoIds: ['a'] }).status, 'need-more-demos');
  assert.equal(multi.aggregate(data, { demoIds: ['a'] }).summary.kills, 0);
  const noPlayers = multi.aggregate(data, { playerIds: [] }); assert.equal(noPlayers.status, 'no-players-selected'); assert.deepEqual(noPlayers.selectedPlayerIds, []); assert.equal(noPlayers.summary.kills, 0);
  assert.equal(multi.aggregate(data, { playerIds: [X, 'bogus'] }).summary.kills, 0);
  assert.deepEqual(multi.aggregate(data, { playerIds: null }).summary, multi.aggregate(data).summary);
  assert.equal(multi.aggregate(data, { sides: [] }).summary.kills, 0);
});

test('cross-map aggregation accumulates a repeated player across maps while a map-local lone appearance stays ineligible', () => {
  const data = [...fixture(), { id: 'c', name: 'C.dem', map: 'de_dust2', players: [player(A), player(C)], kills: [kill(0, A, C, -6, 7, 1)] }];
  const all = multi.aggregate(data, { map: 'all' });
  assert.equal(all.summary.score, 31); assert.equal(all.players.find(p => p.id === A).summary.score, 23);
  assert.deepEqual(all.byMap.map(group => [group.map, group.summary.score]), [['de_dust2', -6], ['de_mirage', 37]]);
  assert.equal(all.byMap.reduce((sum, group) => sum + group.summary.kills, 0), all.summary.kills);
  assert.equal(all.byMap.reduce((sum, group) => sum + group.summary.deaths, 0), all.summary.deaths);
  const twoMaps = multi.aggregate(data, { demoIds: ['a', 'c'], map: 'all' });
  assert.deepEqual(twoMaps.selectedPlayerIds, [A]); assert.equal(twoMaps.summary.score, 18);
  assert.equal(multi.aggregate(data, { map: 'de_dust2' }).summary.score, 0);
  assert.equal(multi.aggregate(data, { map: 'de_dust2' }).status, 'need-more-demos');
});

test('each player summary agrees with single-demo semantics and all grouping partitions sum exactly once', () => {
  const data = fixture(), result = multi.aggregate(data);
  for (const item of result.players) {
    const summaries = data.map(demo => single.summarize(demo.kills, { player: item.id }));
    for (const key of ['kills', 'scoredKills', 'excludedKills', 'score', 'deaths', 'headshots', 'pistolMismatchKills']) assert.equal(item.summary[key], summaries.reduce((sum, row) => sum + row[key], 0), `${item.id}/${key}`);
  }
  for (const group of [result.players, result.byDemo, result.byMap, result.bySide]) for (const key of ['kills', 'scoredKills', 'excludedKills', 'score', 'deaths', 'headshots', 'pistolMismatchKills']) assert.equal(group.reduce((sum, row) => sum + row.summary[key], 0), result.summary[key], key);
  assert.deepEqual(result.byDemo.map(row => [row.demoId, row.summary.score]), [['a', 20], ['b', 17]]);
  assert.deepEqual(result.bySide.map(row => [row.side, row.summary.score, row.summary.deaths]), [[3, 36, 2], [2, 1, 5]]);
  assert.equal(result.matchups.reduce((sum, row) => sum + row.score, 0), 37);
  assert.equal(result.matchups.reduce((sum, row) => sum + row.kills, 0), 7);
  assert.equal(result.summary.average, 37 / 7);
});

test('final API scores, exclusions, zeroes and provenance remain unchanged instead of reapplying multipliers', () => {
  const data = fixture(), result = multi.aggregate(data);
  const weighted = result.kills.find(k => k.demoId === 'a' && k.index === 0);
  assert.equal(weighted.score, 24); assert.equal(weighted.baseScore, 6); assert.equal(weighted.scoreMultiplier, 4);
  const excluded = result.kills.find(k => k.demoId === 'a' && k.index === 2);
  assert.equal(excluded.score, null); assert.equal(excluded.baseScore, null); assert.equal(excluded.scoreMultiplier, null); assert.equal(excluded.excludedReason, '受害者手持刀');
  const approximate = result.kills.find(k => k.demoId === 'b' && k.index === 4);
  assert.equal(approximate.approx, true); assert.equal(approximate.weaponSource, 'previous_tick'); assert.equal(approximate.weaponTime, 23.9);
  data[0].kills[0].score = 3; data[0].kills[0].baseScore = 999; data[0].kills[0].scoreMultiplier = 4;
  assert.equal(multi.aggregate(data).summary.score, 16, 'the API final value is authoritative even if metadata is stale');
});

test('equal round numbers and event indices across demos or within a report keep unique audit keys', () => {
  const data = fixture();
  for (const demo of data) for (const kill of demo.kills) { kill.index = 1; kill.round = 1; }
  const result = multi.aggregate(data);
  assert.equal(result.kills.length, 8); assert.equal(new Set(result.kills.map(k => k.key)).size, 8);
  assert.deepEqual(new Set(result.kills.map(k => k.demoId)), new Set(['a', 'b']));
  assert.ok(result.kills.every(k => k.demoName === `${k.demoId.toUpperCase()}.dem` && k.map === 'de_mirage'));
  const selected = multi.aggregate(data, { playerIds: [A] });
  assert.ok(selected.kills.every(k => result.kills.some(original => original.key === k.key)), 'filtering does not renumber event keys');
});

test('unknown sides and malformed scores stay honest without losing deaths or breaking grouping sums', () => {
  const data = ['a', 'b'].map(id => ({ id, players: [player(A), player(B)], kills: [] }));
  data[0].kills = [
    kill(0, A, B, null, 5, 1, { killerSide: 0, victimSide: 0, excludedReason: '阵营证据缺失' }),
    kill(1, A, B, '12', 1, 5), kill(2, A, B, NaN, 1, 5), kill(3, A, B, Infinity, 1, 5),
    kill(4, A, B, -4, 5, 1, { excludedReason: '队友击杀', pistolMismatch: true }),
    kill(5, A, B, 0, 5, 5),
  ];
  const result = multi.aggregate(data);
  assert.deepEqual(result.summary, summary(0, 6, 1, 5, 6));
  assert.equal(result.bySide.find(side => side.side === 0).summary.excludedKills, 1);
  assert.equal(result.bySide.reduce((sum, side) => sum + side.summary.deaths, 0), 6);
  assert.equal(result.bySide.reduce((sum, side) => sum + side.summary.kills, 0), 6);
  assert.equal(result.matchups.length, 1); assert.equal(result.matchups[0].kills, 1);
});

test('duplicate IDs take only their latest response and neither prepare nor aggregate mutates shared cache objects', () => {
  const data = fixture(), changed = structuredClone(data[0]); changed.name = 'Updated.dem'; changed.kills[0].score = 12;
  const source = deepFreeze([data[0], data[1], changed]), snapshot = JSON.stringify(source);
  const result = multi.aggregate(source);
  assert.equal(result.summary.score, 25); assert.equal(result.demoCount, 2); assert.equal(result.byDemo[0].demoName, 'Updated.dem');
  assert.equal(JSON.stringify(source), snapshot);
});

test('empty, partial, one-demo and unknown-map scopes return an explicit state and usable empty schemas', () => {
  for (const input of [null, undefined, [], [null, {}, { id: '' }]]) {
    const result = multi.aggregate(input);
    assert.equal(result.status, 'no-demos'); assert.deepEqual(result.summary, summary(0, 0, 0, 0, 0));
    for (const key of ['demos', 'maps', 'candidates', 'players', 'byDemo', 'byMap', 'kills', 'matchups', 'warnings']) assert.deepEqual(result[key], []);
    assert.equal(result.bySide.length, 2);
  }
  assert.equal(multi.aggregate(fixture(), { demoIds: [] }).status, 'no-demos');
  assert.equal(multi.aggregate(fixture(), { map: 'not-present' }).status, 'no-demos');
  const one = multi.aggregate([{ id: 'one', players: [player(A)], warnings: ['POV 缺失位置'] }]);
  assert.equal(one.status, 'need-more-demos'); assert.equal(one.byDemo[0].map, 'unknown'); assert.deepEqual(one.warnings, ['one：POV 缺失位置']);
});

test('browser UMD uses the identical pure aggregation path without depending on the single-demo UI', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/statistics-multi-core.js'), 'utf8'), sandbox = {};
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.ReplayMultiStatistics.aggregate, 'function');
  const browser = sandbox.ReplayMultiStatistics.aggregate(fixture(), { side: '2', playerIds: [A, B] });
  assert.deepEqual(JSON.parse(JSON.stringify(browser)), multi.aggregate(fixture(), { side: '2', playerIds: [A, B] }));
});
