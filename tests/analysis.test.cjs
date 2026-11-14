const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

function timedUtility(id, elapsed, overrides = {}) { return { ...utility(id), teamId: 'name:a', roundElapsed: elapsed, timeSource: 'freeze_end', time: 2700 + (elapsed || 0), ...overrides }; }
const emptyTimeCounts = () => ({ '0-5': 0, '5-20': 0, '20-50': 0, '50+': 0, unknown: 0 });

test('utility release buckets have inclusive upper boundaries and tolerate tiny floating-point drift', () => {
  for (const [elapsed, bucket] of [[0,'0-5'],[5,'0-5'],[20,'5-20'],[50,'20-50'],[50.01,'50+']]) assert.equal(A.utilityTimeBucket(timedUtility('u',elapsed)),bucket);
  const epsilon = 1e-7;
  for (const [boundary, lower, upper] of [[5,'0-5','5-20'],[20,'5-20','20-50'],[50,'20-50','50+']]) {
    assert.equal(A.utilityTimeBucket(timedUtility('u',boundary-epsilon)),lower);
    assert.equal(A.utilityTimeBucket(timedUtility('u',boundary+epsilon*.5)),lower);
    assert.equal(A.utilityTimeBucket(timedUtility('u',boundary+epsilon)),lower);
    assert.equal(A.utilityTimeBucket(timedUtility('u',boundary+epsilon*2)),upper);
  }
  assert.equal(A.utilityTimeLabel('all'),'全部时间');
  assert.deepEqual(A.utilityTimeBuckets.map(bucket => bucket.key),['0-5','5-20','20-50','50+','unknown']);
  assert.equal(A.utilityTimeLabel('unknown'),'时间未知');
});

test('legacy, unknown releases and invalid elapsed times never borrow the absolute replay or detonation clock', () => {
  for (const value of [undefined,null,NaN,Infinity,-Infinity,-.00000001,-1,'3',true]) assert.equal(A.utilityTimeBucket(timedUtility('u',value)), 'unknown');
  for (const overrides of [{ throwObserved:false },{ throwObserved:undefined },{ throwObserved:1 },{ timeSource:'unknown' },{ timeSource:undefined },{ timeSource:'round_start' }]) assert.equal(A.utilityTimeBucket(timedUtility('u',3,overrides)), 'unknown');
  assert.equal(A.utilityTimeBucket({ time:3, detonate:4, throwObserved:true }), 'unknown');
  assert.equal(A.utilityTimeBucket(timedUtility('u',3,{time:3603,detonate:3620})), '0-5');
  assert.equal(A.utilityTimeBucket(timedUtility('u',55,{time:4,detonate:5})), '50+');
  assert.equal(A.utilityTimeBucket(null), 'unknown');
});

test('time distribution counts once before the time filter and emitted utilities carry their derived bucket', () => {
  const d=demo('one');d.utilities=[timedUtility('early',5),timedUtility('early',5),timedUtility('middle',20),timedUtility('late',50),timedUtility('last',90),timedUtility('legacy',null,{timeSource:'unknown'})];
  const before=structuredClone(d), expected={'0-5':1,'5-20':1,'20-50':1,'50+':1,unknown:1};
  for(const bucket of ['all','0-5','5-20','20-50','50+','unknown']) {
    const result=A.aggregate([d,d],{utilityTime:bucket});
    assert.deepEqual(result.utilityTimeCounts,expected);
    assert.equal(result.totals.utilities,bucket==='all'?5:1);
    assert.ok(result.utilities.every(u=>u.timeBucket===A.utilityTimeBucket(u)));
    if(bucket!=='all')assert.equal(result.utilities[0].timeBucket,bucket);
  }
  assert.deepEqual(d,before,'aggregation must not stamp bucket fields into source data');
});

test('time selection affects grenade counts and clustering without changing any heatmap metric or scope totals', () => {
  const one=demo('one'),two=demo('utility-only',{series:[]});one.utilities=[timedUtility('early',3),timedUtility('late',60)];two.utilities=[timedUtility('extra',60,{playerId:'76561198000000002',teamId:'name:b'})];
  const all=A.aggregate([one,two]);
  for(const bucket of ['0-5','50+','unknown']){
    const result=A.aggregate([one,two],{utilityTime:bucket});
    assert.deepEqual(result.cells,all.cells);
    const {utilities:_,...metrics}=result.totals,{utilities:__,...original}=all.totals;
    assert.deepEqual(metrics,original);
    const groups=A.clusterUtilities(result.utilities);
    assert.equal(groups.reduce((sum,group)=>sum+group.count,0),result.totals.utilities);
  }
});

test('time counts respect maps, selected recordings, player IDs, merged teams, side, floor and grenade type', () => {
  const one=demo('one');one.utilities=[
    timedUtility('chosen',4,{end:pos(0,0,-500)}),
    timedUtility('wrong-side',15,{side:2,end:pos(0,0,-500)}),
    timedUtility('wrong-floor',25,{end:pos(0,0,100)}),
    timedUtility('wrong-type',65,{type:'flash',end:pos(0,0,-500)}),
    timedUtility('wrong-player',1,{playerId:'76561198000000002',end:pos(0,0,-500)}),
    timedUtility('wrong-team',1,{teamId:'name:other',end:pos(0,0,-500)}),
  ];
  const two=demo('two',{utilities:[timedUtility('variant',16,{teamId:'name:variant',end:pos(0,0,-500)})]});
  const excludedDemo=demo('unselected',{utilities:[timedUtility('unselected',35,{end:pos(0,0,-500)})]});
  const otherMap=demo('nuke',{map:'de_nuke',utilities:[timedUtility('chosen',4,{end:pos(0,0,-500)})]});
  const filter={map:'de_mirage',demoIds:['one','two','nuke'],playerIds:['76561198000000001'],teamAliases:{'name:a':'Team','name:variant':'TEAM'},teamIds:['alias:team'],sides:[3],floor:'lower',lowerMaxZ:0,utilityType:'smoke',utilityTime:'5-20'};
  const result=A.aggregate([one,two,one,excludedDemo,otherMap],filter);
  assert.deepEqual(result.utilityTimeCounts,{'0-5':1,'5-20':1,'20-50':0,'50+':0,unknown:0});
  assert.deepEqual(result.utilities.map(u=>[u.demoId,u.id,u.timeBucket]),[['two','variant','5-20']]);
  assert.deepEqual(A.aggregate([one,two],{...filter,sides:[]}).utilityTimeCounts,emptyTimeCounts());
});

test('same utility IDs in different recordings remain distinct while non-detonated and unlocated observations stay excluded', () => {
  const one=demo('one',{utilities:[timedUtility('shared',2),timedUtility('airborne',2,{detonated:false}),timedUtility('missing',2,{end:null})]});
  const two=demo('two',{utilities:[timedUtility('shared',7),timedUtility('unknownthrow',2,{throwObserved:false})]});
  const result=A.aggregate([one,two]);
  assert.deepEqual(result.utilityTimeCounts,{'0-5':1,'5-20':1,'20-50':0,'50+':0,unknown:1});
  assert.equal(new Set(result.utilities.map(u=>u.key)).size,3);
  const unknown=result.utilities.find(u=>u.id==='unknownthrow');assert.equal(unknown.timeBucket,'unknown');assert.equal(unknown.start,null);
});

test('unknown time filter values safely use all, and empty selections keep every count key', () => {
  const d=demo('one',{utilities:[timedUtility('one',8)]});
  assert.equal(A.aggregate([d],{utilityTime:'stale-option'}).utilities.length,1);
  assert.deepEqual(A.aggregate([d],{demoIds:[]}).utilityTimeCounts,emptyTimeCounts());
  assert.deepEqual(A.aggregate([]).utilityTimeCounts,emptyTimeCounts());
});

test('worker and direct aggregation use the same filtered counts, utilities and cluster inputs', () => {
  const messages=[],sandbox={self:{postMessage:message=>messages.push(message)},importScripts(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/analysis-core.js'),'utf8'),sandbox,{filename:'analysis-core.js'});
  const datasets=[demo('one',{utilities:[timedUtility('early',4),timedUtility('middle',20),timedUtility('legacy',null,{timeSource:'unknown'})]})],filter={utilityTime:'5-20'},cluster={landing:128,throwing:64};
  sandbox.self.onmessage({data:{type:'datasets',datasets}});assert.equal(messages.length,0);
  sandbox.self.onmessage({data:{type:'compute',id:7,filter,cluster}});
  const direct=A.aggregate(datasets,filter);direct.groups=A.clusterUtilities(direct.utilities,cluster);
  assert.equal(messages[0].id,7);assert.deepEqual(JSON.parse(JSON.stringify(messages[0].result)),JSON.parse(JSON.stringify(direct)));
  assert.deepEqual(direct.utilityTimeCounts,{'0-5':1,'5-20':1,'20-50':0,'50+':0,unknown:1});
});
