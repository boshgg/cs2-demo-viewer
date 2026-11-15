const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const playback = require('../web/heatmap-playback.js');

test('window lengths use one-second precision and sanitize untrusted saved values', () => {
  assert.equal(playback.duration,115);assert.equal(playback.defaultWindowLength,10);
  for(const value of [undefined,null,false,true,'20','',NaN,Infinity,-Infinity,{},[]]) assert.equal(playback.normalizeWindowLength(value),10);
  for(const [value,expected] of [[-10,1],[0,1],[1,1],[1.4,1],[1.5,2],[10.4,10],[10.5,11],[114.9,115],[115,115],[200,115]]) assert.equal(playback.normalizeWindowLength(value),expected);
});

test('supported fractional and integer speeds set exact one-second-step delays', () => {
  assert.deepEqual(playback.speeds,[.25,.5,1,2,4,8]);
  for(const [speed,delay] of [[.25,4000],[.5,2000],[1,1000],[2,500],[4,250],[8,125]]) {
    assert.equal(playback.normalizeSpeed(speed),speed);assert.equal(playback.stepDelay(speed),delay);
  }
  for(const value of [undefined,null,true,'2',0,-1,.1,3,16,NaN,Infinity,{}]) {
    assert.equal(playback.normalizeSpeed(value),1);assert.equal(playback.stepDelay(value),1000);
  }
  assert.ok(Object.isFrozen(playback.speeds));
});

test('positioning a fixed window clamps its start instead of shortening it near either endpoint', () => {
  for(const [start,length,expected] of [[0,10,{start:0,end:10}],[50,10,{start:50,end:60}],[112,10,{start:105,end:115}],[-5,10,{start:0,end:10}],[115,1,{start:114,end:115}],[50,115,{start:0,end:115}],[10.7,5,{start:11,end:16}],[NaN,10,{start:0,end:10}]]) assert.deepEqual(playback.rangeForStart(start,length),expected);
  for(const length of [1,2,10,30,114,115]) for(const start of [-1,0,15,114,115,120]) {
    const range=playback.rangeForStart(start,length);
    assert.equal(range.end-range.start,length);assert.ok(range.start>=0);assert.ok(range.end<=115);
  }
});

test('play begins from all with the chosen length and resumes a partial interval using its existing width', () => {
  assert.deepEqual(playback.prepareStart(null),{range:{start:0,end:10},length:10,canPlay:true});
  assert.deepEqual(playback.prepareStart(null,20),{range:{start:0,end:20},length:20,canPlay:true});
  assert.deepEqual(playback.prepareStart({start:15,end:35},10),{range:{start:15,end:35},length:20,canPlay:true});
  assert.deepEqual(playback.prepareStart({start:14.6,end:34.6},10),{range:{start:15,end:35},length:20,canPlay:true});
  const range={start:20,end:21};const before={...range};const prepared=playback.prepareStart(range,30);
  assert.deepEqual(prepared,{range:{start:20,end:21},length:1,canPlay:true});assert.notEqual(prepared.range,range);assert.deepEqual(range,before);
});

test('terminal playback restarts while a full 115-second window cannot progress', () => {
  assert.deepEqual(playback.prepareStart({start:105,end:115},20),{range:{start:0,end:10},length:10,canPlay:true});
  assert.deepEqual(playback.prepareStart({start:114,end:115}),{range:{start:0,end:1},length:1,canPlay:true});
  for(const prepared of [playback.prepareStart(null,115),playback.prepareStart({start:0,end:115},10)]) {
    assert.deepEqual(prepared,{range:{start:0,end:115},length:115,canPlay:false});assert.equal(playback.advanceRange(prepared.range),null);
  }
});

test('every advance shifts exactly one elapsed second, preserves duration and renders the terminal window once', () => {
  for(const length of [1,5,10,30,114,115]) {
    let range=playback.rangeForStart(0,length),steps=0;
    for(;;) {
      const before={...range},next=playback.advanceRange(range);
      assert.deepEqual(range,before,'advancing must not mutate the displayed interval');
      if(!next) break;
      assert.equal(next.start,range.start+1);assert.equal(next.end,range.end+1);assert.equal(next.end-next.start,length);assert.ok(next.end<=115);
      range=next;steps++;
      assert.ok(steps<=115,'a terminal range must stop, not wrap automatically');
    }
    assert.equal(steps,115-length);assert.deepEqual(range,{start:115-length,end:115});assert.equal(playback.advanceRange(range),null);
  }
});

test('malformed persisted ranges start safely without treating equal or inverted bounds as a resumable window', () => {
  for(const range of [undefined,null,false,'all',{},[],[0,10],{start:'0',end:10},{start:0,end:NaN},{start:Infinity,end:20},{start:20,end:5},{start:5,end:5},{start:-20,end:-5},{start:120,end:130}]) {
    assert.deepEqual(playback.prepareStart(range,7),{range:{start:0,end:7},length:7,canPlay:true});assert.equal(playback.advanceRange(range),null);
  }
  assert.deepEqual(playback.prepareStart({start:-10,end:20}),{range:{start:0,end:20},length:20,canPlay:true});
  assert.deepEqual(playback.prepareStart({start:105,end:130}),{range:{start:0,end:10},length:10,canPlay:true});
});

test('speed changes cannot alter spatial interval progression or its fixed elapsed duration', () => {
  let range={start:3,end:13};
  for(const speed of [.25,8,.5,4,1,2]) {
    const next=playback.advanceRange(range),delay=playback.stepDelay(speed);
    assert.equal(next.start,range.start+1);assert.equal(next.end-next.start,10);assert.equal(delay*speed,1000);
    range=next;
  }
  assert.deepEqual(range,{start:9,end:19});
});

test('browser UMD exposes the same pure API with no dependency on clocks, DOM or a worker', () => {
  const sandbox={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/heatmap-playback.js'),'utf8'),sandbox,{filename:'heatmap-playback.js'});
  const browser=sandbox.ReplayHeatmapPlayback;
  assert.equal(typeof browser.prepareStart,'function');assert.equal(browser.stepDelay(.25),4000);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.prepareStart({start:105,end:115}))),playback.prepareStart({start:105,end:115}));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.advanceRange({start:104,end:114}))),{start:105,end:115});
  assert.equal(browser.advanceRange({start:105,end:115}),null);
});
