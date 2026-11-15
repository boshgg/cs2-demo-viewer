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

function movementDemo(id = 'timed', overrides = {}) {
  return demo(id, {
    movementTimingVersion: 1,
    series: [{ playerId: '76561198000000001', teamId: 'name:a', side: 3, rounds: 2,
      cells: [[0, 0, 0, 16, 2, 1, 3]],
      movementTimeline: [[0, 0, 0, 0, .5], [0, 0, 0, 4, 1.5], [0, 0, 0, 5, 2], [0, 0, 0, 19, 3], [0, 0, 0, 20, 1], [0, 0, 0, 114, 4]],
      movementUntimedCells: [[0, 0, 0, 1, 3]], movementUnknownSeconds: 1, movementBeyondSeconds: 3,
    }], ...overrides,
  });
}

test('movement ranges normalize to integer elapsed seconds with at least one second and never reinterpret full as 0..115', () => {
  assert.equal(A.movementDuration, 115);
  for (const value of [undefined, null, false, 'all', {}, {start:NaN,end:20}, {start:1,end:Infinity}, {start:'5',end:20}]) assert.equal(A.normalizeMovementTime(value), null);
  for (const [input, expected] of [
    [{start:-5,end:200},{start:0,end:115}], [{start:20,end:5},{start:5,end:20}],
    [{start:4.4,end:19.6},{start:4,end:20}], [{start:10,end:10},{start:10,end:11}],
    [{start:115,end:115},{start:114,end:115}], [{start:0,end:0},{start:0,end:1}],
  ]) assert.deepEqual(A.normalizeMovementTime(input), expected);
  const d=movementDemo(),full=A.aggregate([d]);
  assert.equal(full.totals.movementSeconds,16);assert.equal(full.movementTime,null);assert.equal(full.movementCoverage,null);
  assert.equal(A.aggregate([d],{movementTime:{start:0,end:115}}).totals.movementSeconds,12);
  assert.equal(d.series[0].cells[0][3],16,'range normalization must not mutate source data');
});

test('movement ranges use half-open one-second bins, sum overlapping round observations, and conserve all movement evidence', () => {
  const d=movementDemo(),before=structuredClone(d);
  const early=A.aggregate([d],{movementTime:{start:0,end:5}}), middle=A.aggregate([d],{movementTime:{start:5,end:20}}),late=A.aggregate([d],{movementTime:{start:20,end:115}});
  assert.equal(early.totals.movementSeconds,2);assert.equal(middle.totals.movementSeconds,5);assert.equal(late.totals.movementSeconds,5);
  assert.equal(A.aggregate([d],{movementTime:{start:114,end:115}}).totals.movementSeconds,4);
  const all=A.aggregate([d],{movementTime:{start:0,end:115}}),c=all.movementCoverage;
  assert.equal(early.totals.movementSeconds+middle.totals.movementSeconds+late.totals.movementSeconds,all.totals.movementSeconds);
  assert.deepEqual(c,{status:'partial',selectedDemos:1,timedDemos:1,missingDemos:0,missingDemoIds:[],totalSeconds:16,timedSeconds:12,unknownSeconds:1,beyondSeconds:3,selectedSeconds:12,coverage:15/16});
  assert.equal(c.timedSeconds+c.unknownSeconds+c.beyondSeconds,A.aggregate([d]).totals.movementSeconds);
  assert.deepEqual(d,before);
});

test('a shared elapsed range changes heatmap metrics but preserves scope and independent utility-time filtering', () => {
  const one=movementDemo(),two=movementDemo('movement-only');
  one.utilities=[timedUtility('early',3),timedUtility('late',60),timedUtility('unknown',null,{timeSource:'unknown'})];
  two.series[0].cells=[[50,0,0,2,0,0,0]];two.series[0].movementTimeline=[[50,0,0,0,2]];two.series[0].movementUntimedCells=[];
  const otherMetrics = result => Object.fromEntries(Object.entries(result.totals).filter(([key]) => !['movementSeconds','engagements','deaths','shots'].includes(key)));
  for(const utilityTime of ['all','0-5','50+','unknown']) {
    const full=A.aggregate([one,two],{utilityTime}),range=A.aggregate([one,two],{utilityTime,movementTime:{start:40,end:50}});
    assert.equal(range.totals.movementSeconds,0);
    assert.deepEqual(otherMetrics(range),otherMetrics(full));
    assert.deepEqual(range.utilities,full.utilities);assert.deepEqual(range.utilityTimeCounts,full.utilityTimeCounts);
    assert.deepEqual(range.cells,[]);
    assert.equal(range.heatmapCoverage.engagements.status,'missing');
  }
});

test('old, unsupported and missing timing evidence never masquerades as whole-round movement in range mode', () => {
  const legacy=demo('legacy'),future=movementDemo('future',{movementTimingVersion:2});
  const ranged=A.aggregate([legacy,legacy,future],{movementTime:{start:0,end:115}});
  assert.equal(ranged.totals.movementSeconds,0);assert.equal(ranged.totals.engagements,0);
  assert.deepEqual(ranged.movementCoverage,{status:'missing',selectedDemos:2,timedDemos:0,missingDemos:2,missingDemoIds:['legacy','future'],totalSeconds:18,timedSeconds:0,unknownSeconds:18,beyondSeconds:0,selectedSeconds:0,coverage:0});
  assert.equal(A.aggregate([legacy,future]).totals.movementSeconds,18);
  const absent=movementDemo('absent');delete absent.series[0].movementTimeline;delete absent.series[0].movementUntimedCells;
  const result=A.aggregate([absent],{movementTime:{start:0,end:115}});
  assert.equal(result.movementCoverage.unknownSeconds,16);assert.equal(result.movementCoverage.status,'missing');
  assert.equal(result.totals.movementSeconds,0);
});

test('movement timings and coverage obey map, demo, player, team aliases, side and floor selections without double-counting demos', () => {
  const makeSeries = (overrides={}) => ({playerId:'76561198000000001',teamId:'name:a',side:3,cells:[[0,0,-500,4,1,1,1]],movementTimeline:[[0,0,-500,5,2]],movementUntimedCells:[[0,0,-500,1,1]],...overrides});
  const one=movementDemo('one',{series:[makeSeries(),makeSeries({playerId:'76561198000000002'}),makeSeries({side:2}),makeSeries({teamId:'name:other'}),makeSeries({cells:[[0,0,100,4,1,1,1]],movementTimeline:[[0,0,100,5,2]],movementUntimedCells:[[0,0,100,1,1]]})]});
  const two=movementDemo('two',{series:[makeSeries({teamId:'name:variant'})]}),otherMap=movementDemo('nuke',{map:'de_nuke'}),unselected=movementDemo('unselected');
  const filter={map:'de_mirage',demoIds:['one','two','nuke'],playerIds:['76561198000000001'],teamAliases:{'name:a':'Team','name:variant':'TEAM'},teamIds:['alias:team'],sides:[3],floor:'lower',lowerMaxZ:0,movementTime:{start:5,end:6}};
  const result=A.aggregate([one,two,one,otherMap,unselected],filter);
  assert.deepEqual(result.cells,[[0,0,-500,4,0,0,0]]);
  assert.equal(result.totals.demos,2);assert.equal(result.totals.players,1);assert.equal(result.totals.teams,1);
  assert.deepEqual(result.movementCoverage,{status:'partial',selectedDemos:2,timedDemos:2,missingDemos:0,missingDemoIds:[],totalSeconds:8,timedSeconds:4,unknownSeconds:2,beyondSeconds:2,selectedSeconds:4,coverage:.75});
  assert.equal(A.aggregate([one,two],{...filter,sides:[]}).movementCoverage.status,'empty');
  assert.equal(A.aggregate([one,two],{...filter,playerIds:[]}).movementCoverage.totalSeconds,0);
});

test('floor coverage uses movement elevations rather than elevations mixed with combat events', () => {
  const d=movementDemo();d.series[0].cells=[[0,0,-490,8,1,1,1]];
  d.series[0].movementTimeline=[[0,0,-500,5,3],[0,0,-480,5,1]];
  d.series[0].movementUntimedCells=[[0,0,-500,1,1],[0,0,-480,1,1]];
  const lower=A.aggregate([d],{floor:'lower',lowerMaxZ:-495,movementTime:{start:0,end:115}}),upper=A.aggregate([d],{floor:'upper',lowerMaxZ:-495,movementTime:{start:0,end:115}});
  assert.equal(lower.totals.movementSeconds,3);assert.equal(lower.movementCoverage.totalSeconds,5);assert.equal(lower.movementCoverage.unknownSeconds,1);assert.equal(lower.movementCoverage.beyondSeconds,1);
  assert.equal(upper.totals.movementSeconds,1);assert.equal(upper.movementCoverage.totalSeconds,3);
  assert.equal(lower.movementCoverage.totalSeconds+upper.movementCoverage.totalSeconds,8);
});

test('no selected-time movement is distinct from missing evidence, and post-countdown movement is not unknown', () => {
  const d=movementDemo();d.series[0].cells=[[0,0,0,5,0,0,0]];d.series[0].movementTimeline=[[0,0,0,5,2]];d.series[0].movementUntimedCells=[[0,0,0,0,3]];
  const emptyRange=A.aggregate([d],{movementTime:{start:50,end:60}});
  assert.equal(emptyRange.totals.movementSeconds,0);assert.equal(emptyRange.movementCoverage.status,'ready');assert.equal(emptyRange.movementCoverage.coverage,1);assert.equal(emptyRange.movementCoverage.beyondSeconds,3);
  assert.equal(A.aggregate([d],{demoIds:[],movementTime:{start:0,end:115}}).movementCoverage.status,'empty');
  assert.equal(A.aggregate([],{movementTime:{start:0,end:115}}).movementCoverage.coverage,null);
});

test('invalid timing values cannot poison or expand a selected range, and lost known totals remain unknown', () => {
  const d=movementDemo();d.series[0].cells=[[0,0,0,8,0,0,0]];d.series[0].movementUntimedCells=[];
  d.series[0].movementTimeline=[[0,0,0,0,1],[0,0,0,114,1],[0,0,0,115,1],[0,0,0,-1,1],[0,0,0,.5,1],[0,0,0,'5',1],[0,0,0,2,NaN],[NaN,0,0,2,1],[0,0,0,3,-1]];
  const result=A.aggregate([d],{movementTime:{start:0,end:115}});
  assert.equal(result.totals.movementSeconds,2);assert.equal(result.movementCoverage.unknownSeconds,6);assert.equal(result.movementCoverage.coverage,.25);
  assert.ok(result.cells.flat().every(Number.isFinite));
});

test('worker range results equal direct aggregation and changing requests cannot reuse another range', () => {
  const messages=[],sandbox={self:{postMessage:message=>messages.push(message)},importScripts(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/analysis-core.js'),'utf8'),sandbox,{filename:'analysis-core.js'});
  const datasets=[movementDemo('one'),movementDemo('one'),demo('legacy')],cluster={landing:128,throwing:64};
  sandbox.self.onmessage({data:{type:'datasets',datasets}});
  for (const [id,movementTime] of [[1,{start:0,end:5}],[2,{start:5,end:20}],[3,null]]) {
    const filter={movementTime};sandbox.self.onmessage({data:{type:'compute',id,filter,cluster}});
    const expected=A.aggregate(datasets,filter);expected.groups=A.clusterUtilities(expected.utilities,cluster);
    assert.equal(messages.at(-1).id,id);assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).result)),JSON.parse(JSON.stringify(expected)));
  }
  assert.deepEqual(messages.map(message=>message.result.totals.movementSeconds),[2,5,18]);
});

test('rounding of legacy per-cell movement durations does not invent unknown elapsed evidence', () => {
  const d=movementDemo();d.series[0].movementUntimedCells=[];
  d.series[0].cells=[[0,0,0,1.0001,0,0,0],[64,0,0,2.0001,0,0,0],[128,0,0,3.0001,0,0,0]];
  d.series[0].movementTimeline=[[0,0,0,0,1.000051],[64,0,0,0,2.000051],[128,0,0,0,3.000051]];
  const result=A.aggregate([d],{movementTime:{start:0,end:115}});
  assert.equal(result.movementCoverage.unknownSeconds,0);assert.equal(result.movementCoverage.coverage,1);assert.equal(result.movementCoverage.status,'ready');
  assert.ok(Math.abs(A.aggregate([d]).totals.movementSeconds-6.0003)<1e-10);
});

function eventDemo(id='events', overrides={}) {
  const d=movementDemo(id);
  d.eventTimingVersion=1;
  d.series[0].cells=[[0,0,0,16,9,6,15]];
  d.series[0].eventTimeline=[
    [0,0,0,0,2,0,0],[0,0,0,5,0,0,3],[0,0,0,5,0,1,0],
    [0,0,0,19,4,0,0],[0,0,0,20,0,2,0],[0,0,0,114,0,0,5],
  ];
  d.series[0].eventUntimedCells=[[0,0,0,1,0,0,2,0,0],[0,0,0,0,2,0,0,1,0],[0,0,0,0,0,3,0,0,4]];
  return {...d,...overrides};
}
const eventTotals = result => ['engagements','deaths','shots'].map(metric=>result.totals[metric]);

test('the existing time range filters all four heatmap layers with half-open boundaries and independent event counts', () => {
  const d=eventDemo(),before=structuredClone(d);
  const ranges=[[0,5],[5,20],[20,115]].map(([start,end])=>A.aggregate([d],{movementTime:{start,end}}));
  assert.deepEqual(ranges.map(eventTotals),[[2,0,0],[4,1,3],[0,2,5]]);
  assert.deepEqual(ranges.map(r=>r.totals.movementSeconds),[2,5,5]);
  assert.deepEqual(eventTotals(A.aggregate([d],{movementTime:{start:114,end:115}})),[0,0,5]);
  const all=A.aggregate([d],{movementTime:{start:0,end:115}});
  assert.deepEqual(eventTotals(all),[6,3,8]);
  for(const metric of ['engagements','deaths','shots']) {
    assert.equal(ranges.reduce((sum,result)=>sum+result.totals[metric],0),all.totals[metric]);
    const coverage=all.heatmapCoverage[metric];
    assert.equal(coverage.timedCount+coverage.unknownCount+coverage.beyondCount,A.aggregate([d]).totals[metric]);
    assert.equal(coverage.selectedCount,coverage.timedCount);assert.equal(coverage.status,'partial');
  }
  assert.deepEqual(all.heatmapCoverage.engagements,{status:'partial',selectedDemos:1,timedDemos:1,missingDemos:0,missingDemoIds:[],totalCount:9,timedCount:6,unknownCount:1,beyondCount:2,selectedCount:6,coverage:8/9});
  assert.equal(all.heatmapCoverage.movement,all.movementCoverage);
  assert.deepEqual(d,before);
});

test('full mode keeps exact legacy cell values and movement timing evidence remains unchanged when event timing is added', () => {
  const d=eventDemo(),legacy=structuredClone(d);delete legacy.eventTimingVersion;delete legacy.series[0].eventTimeline;delete legacy.series[0].eventUntimedCells;
  assert.deepEqual(A.aggregate([d]),A.aggregate([legacy]));
  assert.deepEqual(A.aggregate([d]).cells,[[0,0,0,16,9,6,15]]);
  assert.equal(A.aggregate([d]).heatmapCoverage,null);
  const filter={movementTime:{start:5,end:20}},modern=A.aggregate([d],filter),old=A.aggregate([legacy],filter);
  assert.equal(modern.totals.movementSeconds,old.totals.movementSeconds);assert.deepEqual(modern.movementCoverage,old.movementCoverage);
  assert.deepEqual(eventTotals(old),[0,0,0]);assert.equal(old.heatmapCoverage.deaths.status,'missing');
});

test('event time filtering preserves source scope and utility buckets, list and clustering under an independent utility time filter', () => {
  const d=eventDemo();d.utilities=[timedUtility('early',3),timedUtility('middle',15),timedUtility('late',60)];
  for(const utilityTime of ['all','0-5','5-20','50+','unknown']) {
    const full=A.aggregate([d],{utilityTime}),range=A.aggregate([d],{utilityTime,movementTime:{start:50,end:60}});
    assert.deepEqual(eventTotals(range),[0,0,0]);assert.equal(range.totals.movementSeconds,0);
    for(const metric of ['demos','players','teams','rounds','utilities']) assert.equal(range.totals[metric],full.totals[metric]);
    assert.deepEqual(range.utilities,full.utilities);assert.deepEqual(range.utilityTimeCounts,full.utilityTimeCounts);
    assert.deepEqual(A.clusterUtilities(range.utilities),A.clusterUtilities(full.utilities));
  }
});

test('event timelines and coverage obey map, deduplicated recordings, player IDs, team aliases, sides and floors together', () => {
  const makeSeries=(overrides={})=>({playerId:'76561198000000001',teamId:'name:a',side:3,cells:[[0,0,-500,0,2,1,3]],movementTimeline:[],movementUntimedCells:[],eventTimeline:[[0,0,-500,5,2,0,0],[0,0,-500,5,0,1,0],[0,0,-500,5,0,0,3]],eventUntimedCells:[],...overrides});
  const one=eventDemo('one',{series:[makeSeries(),makeSeries({playerId:'76561198000000002'}),makeSeries({side:2}),makeSeries({teamId:'name:other'}),makeSeries({cells:[[0,0,100,0,2,1,3]],eventTimeline:[[0,0,100,5,2,1,3]]})]});
  const two=eventDemo('two',{series:[makeSeries({teamId:'name:variant'})]}),nuke=eventDemo('nuke',{map:'de_nuke'}),excluded=eventDemo('excluded');
  const filter={map:'de_mirage',demoIds:['one','two','nuke'],playerIds:['76561198000000001'],teamAliases:{'name:a':'Team','name:variant':'TEAM'},teamIds:['alias:team'],sides:[3],floor:'lower',lowerMaxZ:0,movementTime:{start:5,end:6}};
  const result=A.aggregate([one,two,one,nuke,excluded],filter);
  assert.deepEqual(result.cells,[[0,0,-500,0,4,2,6]]);assert.deepEqual(eventTotals(result),[4,2,6]);
  assert.equal(result.totals.demos,2);assert.equal(result.totals.players,1);assert.equal(result.totals.teams,1);
  for(const metric of ['engagements','deaths','shots']) {const c=result.heatmapCoverage[metric];assert.equal(c.status,'ready');assert.equal(c.selectedDemos,2);assert.equal(c.timedDemos,2);assert.equal(c.coverage,1);}
  for(const empty of [{sides:[]},{demoIds:[]},{playerIds:[]},{teamIds:[]}]) {
    const result=A.aggregate([one,two],{...filter,...empty});
    assert.deepEqual(eventTotals(result),[0,0,0]);assert.equal(result.heatmapCoverage.deaths.status,'empty');assert.equal(result.heatmapCoverage.deaths.coverage,null);
  }
});

test('event floor evidence is independent for engagements, deaths and shots instead of inheriting mixed-metric legacy elevations', () => {
  const d=eventDemo();d.series[0].cells=[[0,0,-490,0,3,4,6]];d.series[0].movementTimeline=[];d.series[0].movementUntimedCells=[];
  d.series[0].eventTimeline=[[0,0,-500,5,2,0,0],[0,0,-480,5,0,3,0],[0,0,-500,5,0,0,4]];
  d.series[0].eventUntimedCells=[[0,0,-500,1,0,0,0,0,0],[0,0,-480,0,0,0,0,1,0],[0,0,-480,0,0,2,0,0,0]];
  const filter={lowerMaxZ:-495,movementTime:{start:5,end:6}},lower=A.aggregate([d],{...filter,floor:'lower'}),upper=A.aggregate([d],{...filter,floor:'upper'});
  assert.deepEqual(eventTotals(lower),[2,0,4]);assert.deepEqual(eventTotals(upper),[0,3,0]);
  assert.equal(lower.heatmapCoverage.deaths.status,'empty');assert.equal(lower.heatmapCoverage.shots.coverage,1);
  assert.equal(upper.heatmapCoverage.shots.status,'missing');assert.equal(upper.heatmapCoverage.shots.unknownCount,2);
  assert.equal(upper.heatmapCoverage.deaths.beyondCount,1);assert.equal(upper.heatmapCoverage.deaths.status,'ready');
  for(const metric of ['engagements','deaths','shots']) assert.equal(lower.heatmapCoverage[metric].totalCount+upper.heatmapCoverage[metric].totalCount,A.aggregate([d]).totals[metric]);
});

test('mixed upgraded and old caches do not reuse full event counts and report only metrics with observed records', () => {
  const modern=eventDemo('modern'),old=eventDemo('old');delete old.eventTimingVersion;
  const future=eventDemo('future',{eventTimingVersion:2}),sparse=eventDemo('sparse');sparse.series[0].cells=[[0,0,0,0,0,0,0]];sparse.series[0].eventTimeline=[];sparse.series[0].eventUntimedCells=[];sparse.series[0].movementTimeline=[];sparse.series[0].movementUntimedCells=[];
  const result=A.aggregate([modern,old,old,future,sparse],{movementTime:{start:5,end:20}});
  assert.deepEqual(eventTotals(result),[4,1,3]);
  const c=result.heatmapCoverage.deaths;assert.equal(c.selectedDemos,3);assert.equal(c.timedDemos,1);assert.equal(c.missingDemos,2);assert.deepEqual(c.missingDemoIds,['old','future']);assert.equal(c.unknownCount,14);assert.equal(c.status,'partial');
  assert.equal(A.aggregate([sparse],{movementTime:{start:0,end:115}}).heatmapCoverage.deaths.status,'empty');
  const missing=eventDemo('missing');delete missing.series[0].eventTimeline;delete missing.series[0].eventUntimedCells;
  const missingResult=A.aggregate([missing],{movementTime:{start:0,end:115}});assert.deepEqual(eventTotals(missingResult),[0,0,0]);assert.equal(missingResult.heatmapCoverage.deaths.unknownCount,6);assert.equal(missingResult.heatmapCoverage.deaths.status,'missing');
});

test('known events outside the interval and after countdown are distinct from unknown timing in each layer', () => {
  const d=eventDemo();d.series[0].cells=[[0,0,0,0,2,1,3]];d.series[0].eventTimeline=[[0,0,0,5,2,0,0]];d.series[0].eventUntimedCells=[[0,0,0,0,0,0,0,1,3]];d.series[0].movementTimeline=[];d.series[0].movementUntimedCells=[];
  const r=A.aggregate([d],{movementTime:{start:20,end:30}});
  assert.deepEqual(eventTotals(r),[0,0,0]);
  for(const metric of ['engagements','deaths','shots']) {const c=r.heatmapCoverage[metric];assert.equal(c.status,'ready');assert.equal(c.coverage,1);assert.equal(c.unknownCount,0);}
  assert.equal(r.heatmapCoverage.deaths.beyondCount,1);assert.equal(r.heatmapCoverage.deaths.timedCount,0);
});

test('invalid event bins and coordinates cannot leak counts, and missing rows remain unknown rather than falsely complete', () => {
  const d=eventDemo();d.series[0].cells=[[0,0,0,0,8,4,6]];d.series[0].eventUntimedCells=[];d.series[0].movementTimeline=[];d.series[0].movementUntimedCells=[];
  d.series[0].eventTimeline=[[0,0,0,0,1,0,0],[0,0,0,114,0,1,2],[0,0,0,115,1,1,1],[0,0,0,-1,1,1,1],[0,0,0,.5,1,1,1],[0,0,0,'5',1,1,1],[NaN,0,0,5,1,1,1],[0,0,0,5,NaN,-1,Infinity]];
  const r=A.aggregate([d],{movementTime:{start:0,end:115}});
  assert.deepEqual(eventTotals(r),[1,1,2]);assert.deepEqual(['engagements','deaths','shots'].map(metric=>r.heatmapCoverage[metric].unknownCount),[7,3,4]);
  assert.ok(r.cells.flat().every(Number.isFinite));
});

test('worker and direct shared-range aggregation produce identical independent layer coverage', () => {
  const messages=[],sandbox={self:{postMessage:message=>messages.push(message)},importScripts(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/analysis-core.js'),'utf8'),sandbox,{filename:'analysis-core.js'});
  const datasets=[eventDemo(),eventDemo(),movementDemo('old')],filter={movementTime:{start:5,end:20}},cluster={landing:128,throwing:64};
  sandbox.self.onmessage({data:{type:'datasets',datasets}});sandbox.self.onmessage({data:{type:'compute',id:4,filter,cluster}});
  const expected=A.aggregate(datasets,filter);expected.groups=A.clusterUtilities(expected.utilities,cluster);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].result)),JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(eventTotals(expected),[4,1,3]);assert.equal(expected.heatmapCoverage.deaths.missingDemos,1);
});
