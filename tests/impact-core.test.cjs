const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const impact = require('../web/impact-core.js');

const A = '76561198000000001', B = '76561198000000002', Z = '76561198000000003';
const exposure = (playerId, round, extra = {}) => ({ playerId, player: playerId, round, half: 1, side: 3, teamKey: 'ct-a', eligible: true, approx: false, ...extra });
const kill = (playerId, round, score, extra = {}) => ({ ...exposure(playerId, round), index: round, time: round * 100 + 10, score, excludedReason: '', ...extra });
const death = (playerId, round, penalty, extra = {}) => ({ ...exposure(playerId, round), index: round, time: round * 100 + 20, penalty, corePenalty: penalty == null ? null : -penalty, economyPenalty: 0, firstDeath: false, excludedReason: '', ...extra });
function demo(id, { map = 'de_mirage', rounds = [], kills = [], deaths = [], warnings = [] } = {}) {
  return { id, name: `${id}.dem`, map, impact: { version: '1', rounds, kills, deaths, warnings } };
}
function fixture() {
  return [
    demo('a', { rounds: [exposure(A, 1), exposure(A, 2), exposure(B, 1, { side: 2, teamKey: 't-a' }), exposure(Z, 1)],
      kills: [kill(A, 1, 1000), kill(A, 2, 4000), kill(B, 1, 500, { side: 2, teamKey: 't-a' })],
      deaths: [death(A, 1, -2500, { firstDeath: true }), death(B, 1, -600, { side: 2, teamKey: 't-a', corePenalty: 500, economyPenalty: 100 })] }),
    demo('b', { map: 'de_anubis', rounds: [exposure(A, 1, { player: 'Renamed', half: 2, side: 2, teamKey: 't-b' }), exposure(B, 1), exposure(Z, 1)],
      kills: [kill(A, 1, 250, { half: 2, side: 2, teamKey: 't-b' })],
      deaths: [death(A, 1, -10000, { half: 2, side: 2, teamKey: 't-b', firstDeath: true, corePenalty: 9000, economyPenalty: 1000, approx: true })] }),
  ];
}
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
const totalKeys = ['killContribution', 'deathPenalty', 'combined', 'playerRounds', 'scoredKills', 'scoredDeaths', 'excludedKills', 'excludedDeaths', 'observedPlayerRounds', 'approximateEvents', 'approximatePlayerRounds', 'firstDeaths', 'economyPenalty'];

test('sums final backend contributions and negative penalties exactly without applying coefficients twice', () => {
  const result = impact.aggregate(fixture());
  assert.equal(result.version, '1'); assert.equal(result.status, 'ready');
  assert.equal(result.summary.killContribution, 5750); assert.equal(result.summary.deathPenalty, -13100);
  assert.equal(result.summary.combined, -7350); assert.equal(result.summary.playerRounds, 7);
  assert.equal(result.summary.perRound, -1050); assert.equal(result.summary.per24Rounds, -25200);
  assert.equal(result.summary.scoredKills, 4); assert.equal(result.summary.scoredDeaths, 3);
  assert.equal(result.summary.economyPenalty, 1100); assert.equal(result.summary.firstDeaths, 2);
  assert.equal(result.summary.coverage, 1); assert.equal(result.summary.eventCoverage, 1);
  assert.equal(result.deaths[2].penalty, -10000); assert.equal(result.kills[1].score, 4000);
  assert.equal(result.deaths[2].included, true); assert.equal(result.summary.approximateEvents, 1);
});

test('dataset ID deduplication uses the most recent report, not repeated appearances', () => {
  const data = fixture();
  assert.deepEqual(impact.aggregate([...data, ...data]), impact.aggregate(data));
  const updated = demo('a', { rounds: [exposure(A, 1)], kills: [kill(A, 1, 321)] });
  assert.equal(impact.aggregate([data[0], updated]).summary.killContribution, 321);
  assert.equal(impact.aggregate([data[0], updated]).summary.playerRounds, 1);
  assert.equal(impact.aggregate([data[0], { ...updated, map: 'de_anubis' }], { map: 'de_mirage' }).status, 'empty');
});

test('duplicate exposures never inflate denominators; contradictory duplicates are ineligible', () => {
  const e = exposure(A, 1), k = kill(A, 1, 1000);
  const good = impact.aggregate([demo('a', { rounds: [e, { ...e }], kills: [k] })]);
  assert.equal(good.summary.playerRounds, 1); assert.equal(good.summary.observedPlayerRounds, 1);
  const bad = impact.aggregate([demo('a', { rounds: [e, { ...e, eligible: false, reason: '回合不完整' }], kills: [k] })]);
  assert.equal(bad.summary.playerRounds, 0); assert.equal(bad.summary.observedPlayerRounds, 1);
  assert.equal(bad.summary.combined, 0); assert.equal(bad.summary.excludedKills, 1); assert.equal(bad.summary.coverage, 0);
  assert.equal(bad.kills[0].included, false); assert.equal(bad.kills[0].score, 1000, 'preserve backend score for audit');
  assert.match(bad.kills[0].aggregationExcludedReason, /不完整/);
  for (const extra of [{ side: 2 }, { half: 2 }, { teamKey: 'different' }]) {
    const conflicting = impact.aggregate([demo('a', { rounds: [e, { ...e, ...extra }], kills: [k] })]);
    assert.equal(conflicting.summary.playerRounds, 0); assert.equal(conflicting.summary.scoredKills, 0);
  }
});

test('players with observed rounds but zero events remain present and have zero raw score', () => {
  const result = impact.aggregate(fixture(), { playerIds: [Z] });
  assert.equal(result.players.length, 1); assert.equal(result.players[0].id, Z);
  assert.equal(result.summary.playerRounds, 2); assert.equal(result.summary.combined, 0);
  assert.equal(result.summary.perRound, 0); assert.equal(result.summary.rating.code, 'insufficient-evidence');
  assert.deepEqual(result.kills, []); assert.deepEqual(result.deaths, []);
});

test('player, map, side, team, half, round and dataset filters intersect after scores are computed', () => {
  const data = fixture();
  const filtered = impact.aggregate(data, { demoIds: ['b'], map: 'de_anubis', playerIds: [A], side: '2', team: 't-b', half: '2', round: '1' });
  assert.equal(filtered.summary.killContribution, 250); assert.equal(filtered.summary.deathPenalty, -10000);
  assert.equal(filtered.summary.playerRounds, 1); assert.equal(filtered.deaths[0].firstDeath, true);
  assert.deepEqual(impact.aggregate(data, { player: A }).summary, impact.aggregate(data, { playerIds: [A] }).summary);
  assert.deepEqual(impact.aggregate(data, { sides: [2] }).summary, impact.aggregate(data, { side: 2 }).summary);
  assert.deepEqual(impact.aggregate(data, { map: 'all', side: 'all', player: 'all', team: 'all', half: 'all', round: 'all' }), impact.aggregate(data));
  assert.equal(impact.aggregate(data, { playerIds: [] }).summary.playerRounds, 0);
  assert.equal(impact.aggregate(data, { sides: [] }).kills.length, 0);
  assert.equal(impact.aggregate(data, { playerIds: [A], player: B }).deaths.length, 0);
  assert.equal(impact.aggregate(data, { demoIds: [] }).status, 'empty');
});

test('source, map, side, half, round and player grouping partitions match aggregate totals', () => {
  const result = impact.aggregate(fixture());
  for (const name of ['players', 'byDemo', 'byMap', 'bySide', 'byHalf', 'byRound']) {
    for (const key of totalKeys) assert.equal(result[name].reduce((sum, row) => sum + row.summary[key], 0), result.summary[key], `${name}/${key}`);
  }
  assert.deepEqual(result.byRound.map(r => [r.demoId, r.round]), [['a', 1], ['a', 2], ['b', 1]]);
  assert.deepEqual(result.bySide.map(r => r.label), ['CT', 'T']);
  assert.deepEqual(result.byHalf.map(r => r.label), ['上半场', '下半场']);
  assert.equal(result.summary.rating.label, '所选玩家平均');
  assert.notEqual(result.players[0].summary.rating.code, 'aggregate');
});

test('same event indices and round numbers in different demos remain distinct source-linked rows', () => {
  const data = fixture(); data[0].impact.kills.push({ ...data[0].impact.kills[0], score: 10 });
  const result = impact.aggregate(data);
  assert.equal(new Set(result.kills.map(k => k.key)).size, result.kills.length);
  assert.equal(new Set(result.deaths.map(k => k.key)).size, result.deaths.length);
  assert.deepEqual(result.kills.map(k => k.demoName), ['a.dem', 'a.dem', 'a.dem', 'a.dem', 'b.dem']);
  assert.equal(result.summary.killContribution, 5760);
});

test('ineligible rounds and orphan events are visible but neither scores nor denominators are fabricated', () => {
  const result = impact.aggregate([demo('partial', { rounds: [exposure(A, 1, { eligible: false, reason: '缺少回合结束' }), exposure(A, 2)],
    kills: [kill(A, 1, 4000), kill(A, 3, 1000), kill(A, 2, 500)], deaths: [death(A, 3, -5000)] })]);
  assert.equal(result.summary.observedPlayerRounds, 3); assert.equal(result.summary.playerRounds, 1);
  assert.equal(result.summary.killContribution, 500); assert.equal(result.summary.deathPenalty, 0);
  assert.equal(result.summary.excludedKills, 2); assert.equal(result.summary.excludedDeaths, 1);
  assert.equal(result.summary.coverage, 1 / 3); assert.equal(result.summary.rating.code, 'insufficient-evidence');
  assert.equal(result.kills[0].included, false); assert.equal(result.kills[1].included, false); assert.equal(result.kills[2].included, true);
  assert.match(result.kills[1].aggregationExcludedReason, /参赛回合证据/);
});

test('nonfinite, string and incorrect-sign scores cannot contaminate arithmetic', () => {
  const result = impact.aggregate([demo('invalid', { rounds: [exposure(A, 1)],
    kills: [kill(A, 1, NaN), kill(A, 1, Infinity), kill(A, 1, '1000'), kill(A, 1, -1), kill(A, 1, 0)],
    deaths: [death(A, 1, NaN), death(A, 1, -Infinity), death(A, 1, '-1000'), death(A, 1, 1), death(A, 1, 0)] })]);
  assert.equal(result.summary.scoredKills, 1); assert.equal(result.summary.scoredDeaths, 1);
  assert.equal(result.summary.excludedKills, 4); assert.equal(result.summary.excludedDeaths, 4);
  assert.equal(result.summary.combined, 0); assert.equal(result.summary.eventCoverage, .2);
});

test('explicit exclusions override numeric fields, but intentional exclusions do not lower round coverage or block rating', () => {
  const rounds = Array.from({ length: 30 }, (_, i) => exposure(A, i + 1));
  const kills = rounds.map((row, i) => kill(A, i + 1, 1000));
  const excluded = Array.from({ length: 40 }, (_, i) => kill(A, 1, 1000, { index: i + 50, excludedReason: '回合结束后的击杀不计分' }));
  const result = impact.aggregate([demo('full', { rounds, kills: [...kills, ...excluded] })]);
  assert.equal(result.summary.killContribution, 30000); assert.equal(result.summary.scoredKills, 30);
  assert.equal(result.summary.excludedKills, 40); assert.equal(result.summary.coverage, 1);
  assert.equal(result.summary.eventCoverage, 30 / 70); assert.equal(result.summary.rating.code, 'excellent');
});

test('event metadata inconsistent with its exposure is excluded rather than counted in a side without a denominator', () => {
  const result = impact.aggregate([demo('inconsistent', { rounds: [exposure(A, 1)], kills: [kill(A, 1, 1000, { side: 2 })] })]);
  assert.equal(result.summary.playerRounds, 1); assert.equal(result.summary.scoredKills, 0);
  assert.equal(result.kills[0].included, false); assert.match(result.kills[0].aggregationExcludedReason, /不一致/);
});

test('missing or incompatible impact reports are explicit unavailable data, never zero-score excellent players', () => {
  for (const old of [{ id: 'old' }, { id: 'old', impact: { version: '0', rounds: [], kills: [], deaths: [] } }, { id: 'old', impact: { version: '1' } }]) {
    const result = impact.aggregate([old]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.unavailableDemos.length, 1);
    assert.equal(result.summary.perRound, null); assert.equal(result.summary.coverage, null);
    assert.equal(result.summary.rating.code, 'insufficient-evidence'); assert.equal(result.players.length, 0);
  }
  const ready = demo('ready', { rounds: Array.from({ length: 30 }, (_, i) => exposure(A, i + 1)), kills: [kill(A, 1, 30000)] });
  const partial = impact.aggregate([ready, { id: 'old', map: 'de_mirage' }]);
  assert.equal(partial.status, 'partial'); assert.equal(partial.summary.killContribution, 30000);
  assert.equal(partial.players[0].summary.rating.code, 'insufficient-evidence');
  assert.equal(partial.byDemo.find(d => d.demoId === 'ready').summary.rating.code, 'excellent');
});

test('rating guardrails require 30 eligible rounds, 90% round coverage and a scored event', () => {
  const sufficient = { perRound: 600, playerRounds: 30, coverage: 1, scoredKills: 1, scoredDeaths: 0 };
  assert.equal(impact.rating(sufficient).code, 'excellent');
  assert.equal(impact.rating({ ...sufficient, playerRounds: 29 }).code, 'insufficient-sample');
  assert.equal(impact.rating({ ...sufficient, coverage: .9 }).code, 'excellent');
  assert.equal(impact.rating({ ...sufficient, coverage: .899 }).code, 'insufficient-evidence');
  assert.equal(impact.rating({ ...sufficient, coverage: null }).code, 'insufficient-evidence');
  assert.equal(impact.rating({ ...sufficient, scoredKills: 0 }).code, 'insufficient-evidence');
  assert.equal(impact.rating({ ...sufficient, unavailableDemos: 1 }).code, 'insufficient-evidence');
  assert.equal(impact.rating({ ...sufficient, playerRounds: 29 }).band.code, 'excellent', 'guidepost may be explained without claiming a supported rating');
});

test('all rating threshold boundaries use fixed per-player-round model guideposts', () => {
  const base = { playerRounds: 30, coverage: 1, scoredKills: 1, scoredDeaths: 1 };
  for (const [perRound, code] of [[500, 'excellent'], [499.99, 'good'], [200, 'good'], [199.99, 'balanced'], [0, 'balanced'], [-.01, 'negative'], [-299.99, 'negative'], [-300, 'strong-negative'], [-10000, 'strong-negative']]) {
    const rating = impact.rating({ ...base, perRound });
    assert.equal(rating.code, code, String(perRound)); assert.match(rating.description, /暂定规则基准/);
  }
});

test('per-round means use accumulated player-rounds, not average of unequal demo averages', () => {
  const a = demo('a', { rounds: [exposure(A, 1)], kills: [kill(A, 1, 4000)] });
  const b = demo('b', { rounds: Array.from({ length: 9 }, (_, i) => exposure(A, i + 1)), kills: [kill(A, 1, 1000)] });
  const result = impact.aggregate([a, b]);
  assert.equal(result.summary.perRound, 500); assert.equal(result.summary.per24Rounds, 12000);
  assert.equal(result.summary.playerRounds, 10); assert.equal(result.summary.rating.code, 'insufficient-sample');
});

test('warnings retain provenance, are deduplicated, and approximation remains visible separately from coverage', () => {
  const result = impact.aggregate([demo('warn', { rounds: [exposure(A, 1, { approx: true })], kills: [kill(A, 1, 1000, { approx: true })], warnings: ['回合估算', '回合估算', ''] })]);
  assert.deepEqual(result.warnings, ['warn.dem：回合估算']);
  assert.equal(result.summary.approximateEvents, 1); assert.equal(result.summary.approximatePlayerRounds, 1);
  assert.equal(result.summary.coverage, 1);
});

test('aggregation is immutable, deterministic, browser-loadable, and safe with prototype-like IDs', () => {
  const data = freeze(fixture()), before = JSON.stringify(data);
  assert.deepEqual(impact.aggregate(data), impact.aggregate(data)); assert.equal(JSON.stringify(data), before);
  const hostile = demo('__proto__', { map: 'constructor', rounds: [exposure('__proto__', 1)], kills: [kill('__proto__', 1, 1000)] });
  const result = impact.aggregate([hostile]); assert.equal(result.players[0].id, '__proto__'); assert.equal(result.summary.killContribution, 1000);
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/impact-core.js'), 'utf8'), context);
  assert.equal(typeof context.ReplayImpact.aggregate, 'function'); assert.equal(context.ReplayImpact.version, '1');
  assert.equal(context.ReplayImpact.aggregate([]).status, 'empty');
});
