const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../web/insights-charts.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function mount(fetchMap) {
  const downloads = [];
  let lastBlob;

  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.value = '';
      this.disabled = false;
    }
    append(...children) {
      this.children.push(...children);
      for (const child of children) child.parentElement = this;
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.append(...children);
    }
    contains(node) {
      return this === node || this.children.some(child => child.contains(node));
    }
    querySelectorAll(tag) {
      return this.children.flatMap(child =>
        (child.tag === tag ? [child] : []).concat(child.querySelectorAll(tag)));
    }
    querySelector(selector) {
      if (selector === '.spatial-footer button:enabled') {
        return this.querySelectorAll('button').find(b => b.parentElement.className === 'spatial-footer' && !b.disabled);
      }
      return this.querySelectorAll(selector)[0];
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    click() {
      if (this.disabled) return;
      if (this.tag === 'a') downloads.push({ blob: lastBlob, file: this.download, href: this.href });
      this.listeners.get('click')?.();
    }
  }
  class Canvas extends Element {
    constructor() {
      super('canvas');
      this.labels = [];
      this.radar = undefined;
      this.ctx = {
        fillRect: (x, y, w, h) => {
          if (x === 0 && y === 0 && w === this.width && h === this.height) {
            this.labels = [];
            this.radar = undefined;
          }
        },
        fillText: text => this.labels.push(text),
        drawImage: image => { this.radar = image.src; }
      };
      for (const method of ['save','beginPath','rect','clip','moveTo','lineTo','stroke','arc','fill','strokeText','restore']) {
        this.ctx[method] = () => {};
      }
    }
    getContext(kind) { assert.equal(kind, '2d'); return this.ctx; }
    toBlob(done, type) { done({ type, labels: [...this.labels], radar: this.radar }); }
  }
  class Option extends Element {
    constructor(label, value) { super('option'); this.textContent = label; this.value = value; }
  }
  class Radar {
    set src(path) { this.path = path; queueMicrotask(() => this.onload()); }
    get src() { return this.path; }
  }

  const window = {};
  vm.runInNewContext(script, {
    window, Option, Image: Radar, fetch: fetchMap,
    document: { createElement: tag => tag === 'canvas' ? new Canvas() : new Element(tag) },
    URL: { createObjectURL: blob => { lastBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() {}
  });
  const root = new Element('section');
  const select = key => root.querySelectorAll('select').find(node => node.id === 'spatial-' + key);
  return {
    downloads, root, select,
    render: (report, scope) => window.InsightsCharts.render(root, report, scope),
    describe: () => window.InsightsCharts.describe(root),
    save: () => root.querySelector('button'),
    choose(key, value) {
      const field = select(key);
      assert.equal(field.disabled, false, key + ' must be interactive');
      assert.ok(field.children.some(option => option.value === value), key + ' must offer ' + value);
      field.value = value;
      return field.listeners.get('change')();
    }
  };
}

const radarMap = { posX: -512, posY: 512, scale: 1, radarSize: 1024,
  radar: '/maps/test.png', lowerRadar: '/maps/test_lower.png', lowerMaxZ: 0 };
const okMap = () => ({ ok: true, json: () => radarMap });
const fetchKnownMap = async () => okMap();
const group = {
  map: 'de_test', teamId: 'team', teamName: 'Test Team', side: 3, phase: 'opening',
  rounds: 4, demoIds: ['demo'], cells: [[16, 48, 32, 24, 1, 0, 0, 0, 0]],
  openingAt15: { rounds: 3, cells: [[80, 144, 32, 7], [-80, -144, -64, 5]] },
  moves: [[16, 48, 32, 176, 208, 32, 3], [-16, -48, -64, -176, -208, -64, 2]]
};
const report = { players: [{ id: 'p', name: '选手 P' }], spatial: { cellSize: 32, groups: [group] } };

test('15-second positions and opening-to-mid moves export the currently drawn radar and coordinates', async () => {
  const ui = mount(fetchKnownMap);
  ui.render(report);
  assert.equal(ui.save().disabled, true);
  assert.equal(ui.describe(), '');
  ui.save().click();
  assert.deepEqual(ui.downloads, []);
  await settle();
  assert.equal(ui.select('metric').value, 'at15');
  assert.match(ui.describe(), /第 15 秒站位.*\(80, 144, 32\).*7人次/);
  ui.save().click();
  let output = ui.downloads[0];
  assert.equal(output.file, 'CS2-复盘图.png');
  assert.equal(output.blob.type, 'image/png');
  assert.equal(output.blob.radar, radarMap.radar);
  assert.ok(output.blob.labels.includes('X 80   Y 144   Z 32'));
  assert.ok(!output.blob.labels.includes('X -80   Y -144   Z -64'));

  const changing = ui.choose('metric', 'moves');
  assert.equal(ui.save().disabled, true);
  assert.equal(ui.describe(), '');
  ui.save().click();
  assert.equal(ui.downloads.length, 1, 'a previous frame cannot be exported during the change');
  await changing;
  await ui.choose('floor', 'lower');
  assert.match(ui.describe(), /换位.*下层.*\(-16, -48, -64\) → \(-176, -208, -64\).*2次/);
  assert.doesNotMatch(ui.describe(), /\(16, 48, 32\)/);
  ui.save().click();
  output = ui.downloads[1];
  assert.equal(output.blob.radar, radarMap.lowerRadar);
  assert.ok(output.blob.labels.includes('(-16, -48, -64) → (-176, -208, -64)'));
  assert.ok(!output.blob.labels.includes('X 80   Y 144   Z 32'));
});

test('rerendering the same scope restores selections and describes the visible player, phase, metric and world coordinates', async () => {
  const ui = mount(fetchKnownMap);
  const multiPhase = { ...report, spatial: { ...report.spatial, groups: [
    group, { ...group, phase: 'mid', openingAt15: undefined, moves: [],
      cells: [[-176, -80, -64, 12, 4, 2, 1, 2, 0], [208, 144, 32, 0, 0, 8, 0, 0, 0]] }
  ] } };
  const scope = { team: 'team', playerId: 'p' };
  ui.render(multiPhase, scope);
  await settle();
  await ui.choose('phase', 'mid');
  await ui.choose('metric', '2');
  await ui.choose('floor', 'lower');
  const previous = ui.describe();
  assert.match(previous, /死亡位置.*选手 P.*CT.*中期.*下层.*\(-176, -80, -64\).*2次/);
  const oldCanvas = ui.root.querySelector('canvas');
  ui.render(multiPhase, scope);
  assert.notEqual(ui.root.querySelector('canvas'), oldCanvas);
  assert.equal(ui.describe(), '');
  await settle();
  assert.deepEqual(['phase','metric','floor'].map(k => ui.select(k).value), ['mid','2','lower']);
  assert.equal(ui.describe(), previous);
});

test('a slow previous map cannot replace an unknown map’s world-grid drawing or its export', async () => {
  let releaseMap;
  const unknown = { ...group, map: 'zz_unknown', openingAt15: undefined, moves: [],
    cells: [[400, 320, 88, 12, 0, 0, 0, 0, 0]] };
  const ui = mount(url => {
    if (url === '/api/maps/de_test') return new Promise(resolve => { releaseMap = resolve; });
    assert.equal(url, '/api/maps/zz_unknown');
    return Promise.resolve({ ok: false });
  });
  ui.render({ spatial: { cellSize: 32, groups: [group, unknown] } });
  await ui.choose('map', unknown.map);
  assert.equal(ui.select('floor').parentElement.hidden, true);
  const ready = ui.describe();
  assert.match(ready, /zz_unknown.*\(400, 320, 88\).*12秒/);
  releaseMap(okMap());
  await settle();
  assert.equal(ui.describe(), ready);
  assert.equal(ui.select('floor').value, 'all');
  ui.save().click();
  assert.equal(ui.downloads[0].blob.radar, undefined);
  assert.ok(ui.downloads[0].blob.labels.some(s => s.includes('世界坐标网格')));
});
