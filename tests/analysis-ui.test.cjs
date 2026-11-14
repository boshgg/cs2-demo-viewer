const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const analysis = require('../web/analysis-core.js');
const heatmap = require('../web/heatmap.js');

// Run the actual page script and its DOM events. Canvas records the actual
// ImageData produced by the renderer; no private page state is exposed.
const html = fs.readFileSync(path.join(__dirname, '../web/analysis.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../web/analysis.js'), 'utf8');
const noop = () => {};
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
function dataset(id, map = 'de_mirage', x = 256, y = 768) {
  return { id, name: `${id}.dem`, map, roundCount: 1,
    players: [{ id: '76561198000000001', name: 'Player', stable: true }],
    teams: [{ id: 'team-a', name: 'Team A', playerIds: ['76561198000000001'] }],
    series: [{ playerId: '76561198000000001', teamId: 'team-a', side: 3,
      cells: [[x, y, 0, 100, 5, 1, 10], [x + 128, y, 0, 1, 0, 0, 0]] }], utilities: [] };
}

async function page(datasets = [dataset('one')]) {
  const elements = new Map(), canvases = [], downloads = [], requests = [], timers = new Map();
  const mapGates = new Map(), resizeObservers = [];
  let nextTimer = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.listeners = {}; this.style = {}; this.dataset = {};
      this.value = ''; this.hidden = false; this.checked = false; this.disabled = false; this.textContent = '';
      this.offsetWidth = 180; this.offsetHeight = 90; this.classList = { toggle: noop };
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type, args = {}) {
      const event = { target: this, currentTarget: this, preventDefault: noop, ...args };
      return Promise.all((this.listeners[type] || []).map(listener => listener(event)));
    }
    click() { if (this.tagName === 'a') downloads.push({ href: this.href, filename: this.download }); return this.dispatch('click'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get childElementCount() { return this.children.length; }
    get selectedOptions() { return this.children.filter(child => child.value === this.value); }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll(tag) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tag)]).filter(child => child.tagName === tag); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    setPointerCapture() {}
  }
  class Canvas extends Element {
    constructor() {
      super('canvas'); this.width = 300; this.height = 150; this.imageData = null;
      const context = { draws: [], texts: [], gradients: [],
        clearRect: () => { context.draws = []; },
        drawImage: (...args) => context.draws.push(args),
        putImageData: data => { this.imageData = data; },
        fillText: (...args) => context.texts.push(args),
        createLinearGradient: (...args) => {
          const gradient = { args, stops: [], addColorStop: (at, color) => gradient.stops.push([at, color]) };
          context.gradients.push(gradient); return gradient;
        },
      };
      this.context = new Proxy(context, { get: (object, key) => key in object ? object[key] : noop });
      canvases.push(this);
    }
    getContext() { return this.context; }
    toBlob(callback) { callback(new Blob(['stub png'], { type: 'image/png' })); }
  }
  const create = tag => tag === 'canvas' ? new Canvas() : new Element(tag);
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match, element = create(tag);
    element.id = id; element.hidden = /\bhidden\b/.test(attributes); element.checked = /\bchecked\b/.test(attributes);
    element.disabled = /\bdisabled\b/.test(attributes); element.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '';
    elements.set(id, element);
  }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const element = elements.get(match[1]);
    for (const option of match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
      const child = new Element('option'); child.value = option[1]; child.textContent = option[2]; element.append(child);
    }
    element.value = element.children[0]?.value || '';
  }
  const get = id => { assert.ok(elements.has(id), `HTML is missing #${id}`); return elements.get(id); };
  const response = data => ({ ok: true, json: async () => data });
  const source = new Map(datasets.map(demo => [demo.id, demo]));
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/api/analyses') return response([...source.values()].map(d => ({ id: d.id, name: d.name, map: d.map, status: 'ready' })));
    const match = /^\/api\/demos\/([^/]+)(\/analysis)?$/.exec(url);
    if (match) {
      if (options.method === 'DELETE') { source.delete(match[1]); return response({}); }
      if (match[2] && source.has(match[1])) return response(source.get(match[1]));
    }
    if (url.startsWith('/api/maps/')) {
      const name = decodeURIComponent(url.slice('/api/maps/'.length));
      if (mapGates.has(name)) await mapGates.get(name);
      return response({ posX: 0, posY: 1024, scale: 1, radarSize: 1024, radar: `/maps/${name}.png` });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  class PageURL extends URL {
    static createObjectURL() { return 'blob:test-png'; }
    static revokeObjectURL() {}
  }
  const sandbox = {
    window: { ReplayAnalysis: analysis, ReplayHeatmap: heatmap }, document: { getElementById: get, createElement: create, addEventListener: noop },
    Option: function (text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    Image: class { decode() { return Promise.resolve(); } },
    ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } },
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} },
    localStorage: { getItem: () => null, setItem: noop }, location: { href: 'http://127.0.0.1:8765/analysis.html' },
    devicePixelRatio: 2, URL: PageURL, Blob, fetch, console,
    setTimeout: (callback, delay = 0) => { const id = ++nextTimer; timers.set(id, callback); if (!delay) queueMicrotask(() => { if (timers.has(id)) { timers.delete(id); callback(); } }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(script, sandbox, { filename: 'analysis.js' });
  await settle();
  assert.equal(get('global-error').textContent, '', 'page initialization must not report an error');
  const main = get('analysis-canvas');
  const renderedHeat = () => main.context.draws.map(args => args[0]).find(image => image.imageData) || null;
  const hasVisibleHeat = () => renderedHeat()?.imageData.data.some((value, index) => index % 4 === 3 && value > 0) || false;
  return { get, main, canvases, downloads, requests, renderedHeat, hasVisibleHeat,
    async change(id, value) { get(id).value = value; await get(id).dispatch('change'); await settle(); },
    blockMap(name) { let release; mapGates.set(name, new Promise(resolve => { release = resolve; })); return release; },
    resize() { for (const callback of resizeObservers) callback(); },
  };
}

test('removing the last demo then changing color scale cannot resurrect its heatmap', async () => {
  const ui = await page();
  assert.ok(ui.hasVisibleHeat());
  const row = ui.get('demo-list').children[0];
  await row.children.find(child => child.tagName === 'button').click(); await settle();
  assert.equal(ui.get('analysis-empty').hidden, false);
  assert.equal(ui.hasVisibleHeat(), false);
  await ui.change('heat-scale', 'linear');
  assert.equal(ui.hasVisibleHeat(), false);
  assert.equal(ui.get('export-image').disabled, true);
  assert.ok(ui.requests.some(([url, method]) => url === '/api/demos/one' && method === 'DELETE'));
});

test('changing maps clears the old raster while the next map is loading', async () => {
  const ui = await page([dataset('one'), dataset('two', 'de_nuke', 768, 256)]);
  assert.ok(ui.hasVisibleHeat());
  const release = ui.blockMap('de_nuke');
  ui.get('analysis-map').value = 'de_nuke';
  const changing = ui.get('analysis-map').dispatch('change'); await settle();
  await ui.change('heat-scale', 'linear');
  assert.equal(ui.hasVisibleHeat(), false, 'old heat must not be redrawn over the next map');
  release(); await changing; await settle();
  assert.ok(ui.hasVisibleHeat());
  assert.equal(ui.get('canvas-map-name').textContent, 'de_nuke');
  const pixels = ui.renderedHeat().imageData.data, center = value => Math.round(value * 383);
  assert.equal(pixels[(center(.25) * 384 + center(.25)) * 4 + 3], 0, 'the previous map hotspot is absent');
  assert.ok(pixels[(center(.75) * 384 + center(.75)) * 4 + 3] > 0);
});

test('clearing all metric layers removes the raster and selecting a layer restores it', async () => {
  const ui = await page();
  ui.get('layer-movement').checked = false; await ui.get('layer-movement').dispatch('change');
  assert.equal(ui.hasVisibleHeat(), false);
  assert.match(ui.get('heat-legend-note').textContent, /未选择图层/);
  await ui.change('heat-scale', 'linear'); assert.equal(ui.hasVisibleHeat(), false);
  ui.get('layer-deaths').checked = true; await ui.get('layer-deaths').dispatch('change');
  assert.ok(ui.hasVisibleHeat()); assert.match(ui.get('heat-legend-note').textContent, /死亡/);
});

test('scale switching recolors the raster and keeps page and PNG legends consistent', async () => {
  const ui = await page();
  const logarithmic = ui.renderedHeat().imageData.data;
  assert.deepEqual(ui.get('heat-ticks').children.map(tick => tick.textContent), ['0%', '1%', '5%', '20%', '50%', '100%']);
  const lowTick = ui.get('heat-ticks').children[1];
  assert.ok(Math.abs(parseFloat(lowTick.style.left) - heatmap.scaleValue(.01, 'log') * 100) < 1e-9);
  await ui.change('heat-scale', 'linear');
  const linear = ui.renderedHeat().imageData.data;
  assert.ok(linear.some((value, i) => i % 4 !== 3 && value !== logarithmic[i]), 'the actual raster changes color');
  assert.deepEqual(ui.get('heat-ticks').children.map(tick => tick.textContent), ['0%', '20%', '40%', '60%', '80%', '100%']);
  assert.equal(ui.get('heat-ticks').children[2].style.left, '40%');
  await ui.get('export-image').click();
  assert.equal(ui.downloads.length, 1); assert.equal(ui.downloads[0].filename, 'de_mirage-analysis.png');
  const output = ui.canvases.at(-1), context = output.context;
  assert.equal(output.width, 1600); assert.equal(output.height, 1604);
  assert.equal(context.draws[0][0], ui.main);
  assert.deepEqual(context.draws[0].slice(1), [0, 80, 800, 600]);
  assert.match(context.texts.map(item => item[0]).join('\n'), /移动 · 线性 · 相对当前筛选峰值/);
  assert.deepEqual(context.gradients[0].stops, heatmap.stops.map(([at, rgb]) => [at, `rgb(${rgb.join(',')})`]));
  const forty = context.texts.find(([text]) => text === '40%');
  assert.equal(forty[1], 232);
  assert.ok(context.texts.every(([, , y]) => y < 802), 'export labels fit in the output');
});

test('hover density is cleared when zoom, reset, resize or the selected layer changes', async () => {
  const ui = await page(), tip = ui.get('heat-tooltip');
  const hover = () => ui.main.dispatch('pointermove', { clientX: 255.5, clientY: 155.5 });
  await hover(); assert.equal(tip.hidden, false);
  assert.match(tip.children.map(child => child.textContent).join(' '), /移动 100\.0%/);
  await ui.main.dispatch('wheel', { clientX: 255.5, clientY: 155.5, deltaY: -1 }); assert.equal(tip.hidden, true);
  await ui.get('fit-map').click(); await hover(); assert.equal(tip.hidden, false);
  await ui.main.dispatch('keydown', { key: '+' }); assert.equal(tip.hidden, true);
  await ui.get('fit-map').click(); await hover(); ui.resize(); assert.equal(tip.hidden, true);
  await hover(); ui.get('layer-movement').checked = false; await ui.get('layer-movement').dispatch('change');
  assert.equal(tip.hidden, true);
});
