const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../web/analysis-core.js');
const pos = (x = 0, y = 0, z = 0) => ({ x, y, z });
function demo(id, overrides = {}) {
  return { id, name: `${id}.dem`, map: 'de_mirage', roundCount: 2, players: [{ id: '76561198000000001', name: 'same', stable: true }], teams: [{ id: 'name:a', name: 'A', playerIds: ['76561198000000001'] }], series: [{ playerId: '76561198000000001', teamId: 'name:a', side: 3, rounds: 1, cells: [[0, 0, 0, 2, 1, 1, 3]] }], utilities: [], ...overrides };
}
function utility(id, end = pos(), start = pos(-100)) { return { id, key: id, demoId: 'one', map: 'de_mirage', playerId: '76561198000000001', owner: 'same', side: 3, type: 'smoke', start, end, throwObserved: !!start, detonated: true }; }
const counts = groups => groups.map(g => g.items.map(u => u.id).sort()).sort((a, b) => a.join().localeCompare(b.join()));

test('ten demos sum observations for the same stable ID and team, never average away counts', () => {
  const result = A.aggregate(Array.from({ length: 10 }, (_, i) => demo(`demo-${i}`)), { map: 'de_mirage', playerIds: ['76561198000000001'], teamIds: ['name:a'] });
  assert.equal(result.totals.demos, 10); assert.equal(result.totals.players, 1); assert.equal(result.totals.teams, 1);
  assert.deepEqual(result.cells, [[0, 0, 0, 20, 10, 10, 30]]);
});
test('same name with different player IDs remains independently selectable', () => {
  const other = demo('two', { players: [{ id: '76561198000000002', name: 'same', stable: true }], series: [{ playerId: '76561198000000002', teamId: 'name:a', side: 3, cells: [[100, 0, 0, 5, 7, 0, 9]] }] });
  const filtered = A.aggregate([demo('one'), other], { playerIds: ['76561198000000001'] });
  assert.equal(filtered.totals.movementSeconds, 2); assert.equal(filtered.cells.length, 1);
  assert.equal(A.aggregate([demo('one'), other]).totals.players, 2);
});
test('CT / T use event-time sides and preserve team identity through switching sides', () => {
  const data = demo('one'); data.series.push({ playerId: '76561198000000001', teamId: 'name:a', side: 2, cells: [[100, 0, 0, 7, 3, 4, 8]] });
  assert.equal(A.aggregate([data], { sides: [3] }).totals.deaths, 1);
  assert.equal(A.aggregate([data], { sides: [2] }).totals.deaths, 4);
  assert.equal(A.aggregate([data], { sides: [2, 3] }).totals.teams, 1);
  assert.equal(A.aggregate([data], { sides: [] }).totals.players, 0);
});
test('maps remain isolated even when coordinates and player IDs match', () => {
  const one = demo('one'), two = demo('two', { map: 'de_nuke' });
  assert.equal(A.aggregate([one, two], { map: 'de_nuke' }).totals.demos, 1);
  assert.equal(A.aggregate([one, two]).totals.demos, 1);
  assert.equal(A.aggregate([one, two], { map: 'missing' }).cells.length, 0);
});
test('duplicate demo IDs and utility IDs do not double-count a restored dataset', () => {
  const data = demo('one'); const u = { ...utility('u'), teamId: 'name:a' }; data.utilities.push(u, u);
  const result = A.aggregate([data, data]);
  assert.equal(result.totals.movementSeconds, 2); assert.equal(result.totals.utilities, 1);
});
test('explicit team aliases merge selected team variants without merging unrelated teams', () => {
  const two = demo('two'); two.series[0].teamId = 'name:variant';
  const aliases = { 'name:a': 'My Team', 'name:variant': 'my team' };
  const filtered = A.aggregate([demo('one'), two], { teamAliases: aliases, teamIds: ['alias:my team'] });
  assert.equal(filtered.totals.teams, 1); assert.equal(filtered.totals.movementSeconds, 4);
  assert.equal(A.aggregate([demo('one'), two], { teamIds: ['name:a'] }).totals.movementSeconds, 2);
});
test('floor filters separate vertically coincident cells and utility endpoints', () => {
  const d = demo('one'); d.series[0].cells.push([0, 0, -500, 9, 2, 3, 4]);
  assert.equal(A.aggregate([d], { floor: 'lower', lowerMaxZ: -495 }).totals.movementSeconds, 9);
  assert.equal(A.aggregate([d], { floor: 'upper', lowerMaxZ: -495 }).totals.movementSeconds, 2);
});
test('each metric adds independently; invalid numbers cannot poison the density', () => {
  const d = demo('one'); d.series[0].cells.push([0, 0, 0, NaN, 2, -4, 1], [NaN, 0, 0, 500, 500, 500, 500]);
  const result = A.aggregate([d]); assert.deepEqual(result.cells[0], [0, 0, 0, 2, 3, 1, 4]);
  assert.equal(result.totals.engagements, 3); assert.equal(result.totals.deaths, 1);
});
test('near landing points share a class but distant release positions remain distinct throws', () => {
  const groups = A.clusterUtilities([utility('a', pos(0), pos(-500)), utility('b', pos(30), pos(-490)), utility('c', pos(10), pos(500))], { landing: 128, throwing: 64 });
  assert.equal(groups.length, 1); assert.equal(groups[0].count, 3); assert.equal(groups[0].throws.length, 2); assert.equal(groups[0].throws[0].count, 2); assert.equal(groups[0].percent, 100);
});
test('complete-link landing clusters prevent chain merging and are import-order independent', () => {
  const values = [utility('a', pos(0)), utility('b', pos(90)), utility('c', pos(180))];
  const first = A.clusterUtilities(values, { landing: 100 }), reversed = A.clusterUtilities(values.slice().reverse(), { landing: 100 });
  assert.deepEqual(counts(first), [['a', 'b'], ['c']]); assert.deepEqual(counts(first), counts(reversed));
});
test('same-throw clustering applies distance to both release and landing points', () => {
  const groups = A.clusterUtilities([utility('a', pos(0), pos(-100)), utility('b', pos(80), pos(-100)), utility('c', pos(120), pos(-100))], { landing: 160, throwing: 64 });
  assert.equal(groups.length, 1); assert.equal(groups[0].throws.length, 2);
});
test('unknown release positions are never presented as one known throw', () => {
  const groups = A.clusterUtilities([utility('a', pos(), null), utility('b', pos(), null), { ...utility('c'), throwObserved: false }]);
  assert.equal(groups.length, 1); assert.equal(groups[0].unknownStarts, 3); assert.equal(groups[0].throws.length, 3); assert.ok(groups[0].throws.every(g => g.unknown));
});
test('different types, floors and maps cannot share a landing class', () => {
  const items = [utility('a'), { ...utility('b'), type: 'flash' }, utility('c', pos(0, 0, -500)), { ...utility('d'), map: 'de_nuke' }];
  assert.equal(A.clusterUtilities(items, { lowerMaxZ: -495 }).length, 4);
});
test('empty selections produce no rows and unknown detonation positions are excluded', () => {
  const d = demo('one'); d.utilities = [{ ...utility('missing'), end: null }, { ...utility('flight'), detonated: false }];
  assert.equal(A.aggregate([d], { demoIds: [] }).cells.length, 0);
  assert.equal(A.aggregate([d], { playerIds: [] }).cells.length, 0);
  assert.equal(A.aggregate([d]).utilities.length, 0);
});
test('CSV safely escapes names, line breaks, quotes and spreadsheet formulas', () => {
  const csv = A.csv([['=HYPERLINK("bad")', 'a,b', 'a\nb', '-2']]);
  assert.ok(csv.startsWith('\ufeff')); assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('"a,b"')); assert.ok(csv.includes('"a\nb"')); assert.ok(csv.includes("'-2"));
});
