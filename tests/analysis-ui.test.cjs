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

async function page(datasets = [dataset('one')], pageOptions = {}) {
  const elements = new Map(), canvases = [], downloads = [], requests = [], timers = new Map();
  const mapGates = new Map(), resizeObservers = [], timerDelays = new Map(), savedWrites = [];
  let nextTimer = 0, analysisCalls = 0, refreshError = '';
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
  const uploads = new Map((pageOptions.uploads || []).map(demo => [demo.name, demo]));
  const libraryFiles = new Map((pageOptions.libraryDemos || []).map(demo => [demo.id, demo]));
  const stored = new Map(pageOptions.saved ? [['cs2-analysis-v4', JSON.stringify(pageOptions.saved)]] : []);
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/api/session-settings') return response(pageOptions.session || { sessionId: '', settings: null });
    if (url === '/api/library') return response({ enabled: true, directory: 'F:\\viewer\\demo', count: libraryFiles.size, ...(pageOptions.library || {}) });
    if (url === '/api/library/refresh' && options.method === 'POST') {
      if (refreshError) return { ok: false, status: 500, json: async () => ({ error: refreshError }) };
      let added = 0;
      for (const [id, demo] of libraryFiles) if (!source.has(id)) { source.set(id, demo); added++; }
      return response({ added, unchanged: libraryFiles.size - added, queued: [...source.values()].filter(d => d.jobStatus === 'queued').length, directory: 'F:\\viewer\\demo', errors: pageOptions.libraryErrors || [] });
    }
    if (url === '/api/analyses') return response([...source.values()].map(d => ({ id: d.id, name: d.name, map: d.map, status: d.jobStatus || 'ready', revision: d.revision })));
    if (url === '/api/demos?mode=analysis' && options.method === 'POST') {
      const file = options.body.get('demo'), demo = uploads.get(file.name);
      assert.ok(demo, `Unexpected uploaded fixture ${file.name}`); source.set(demo.id, demo); return response({ id: demo.id });
    }
    const match = /^\/api\/demos\/([^/]+)(\/(?:analysis|status))?$/.exec(url);
    if (match) {
      if (options.method === 'DELETE') { source.delete(match[1]); return response({}); }
      if (match[2] === '/analysis' && source.has(match[1])) return response(source.get(match[1]));
      if (match[2] === '/status' && source.has(match[1])) {
        const demo = source.get(match[1]);
        return response({ status: demo.parseError ? 'error' : 'ready', progress: 1, error: demo.parseError || '', map: demo.map });
      }
    }
    if (url.startsWith('/api/maps/')) {
      const name = decodeURIComponent(url.slice('/api/maps/'.length));
      if (mapGates.has(name)) await mapGates.get(name);
      return response({ posX: 0, posY: 1024, scale: 1, radarSize: 1024, radar: `/maps/${name}.png`, ...pageOptions.mapInfo });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  class PageURL extends URL {
    static createObjectURL() { return 'blob:test-png'; }
    static revokeObjectURL() {}
  }
  const sandbox = {
    window: { ReplayAnalysis: { ...analysis, aggregate: (...args) => { analysisCalls++; return analysis.aggregate(...args); } }, ReplayHeatmap: heatmap }, document: { getElementById: get, createElement: create, addEventListener: noop },
    Option: function (text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    Image: class { decode() { return Promise.resolve(); } },
    ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } },
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); if (key === 'cs2-analysis-v4') savedWrites.push(JSON.parse(value)); } }, location: { href: pageOptions.href || 'http://127.0.0.1:8765/analysis.html' },
    FormData: class { constructor() { this.values = new Map(); } append(key, value) { this.values.set(key, value); } get(key) { return this.values.get(key); } },
    AbortController, DOMException, devicePixelRatio: 2, URL: PageURL, Blob, fetch, console,
    setTimeout: (callback, delay = 0) => { const id = ++nextTimer; timers.set(id, callback); timerDelays.set(id, delay); if (!delay) queueMicrotask(() => { if (timers.has(id)) { timers.delete(id); timerDelays.delete(id); callback(); } }); return id; },
    clearTimeout: id => { timers.delete(id); timerDelays.delete(id); },
  };
  vm.runInNewContext(script, sandbox, { filename: 'analysis.js' });
  await settle();
  assert.equal(get('global-error').textContent, '', 'page initialization must not report an error');
  const main = get('analysis-canvas');
  const renderedHeat = () => main.context.draws.map(args => args[0]).find(image => image.imageData) || null;
  const hasVisibleHeat = () => renderedHeat()?.imageData.data.some((value, index) => index % 4 === 3 && value > 0) || false;
  return { get, main, canvases, downloads, requests, renderedHeat, hasVisibleHeat,
    saved: () => JSON.parse(stored.get('cs2-analysis-v4') || '{}'),
    savedWrites, analysisCalls: () => analysisCalls,
    setLibraryFiles(demos) { libraryFiles.clear(); for (const demo of demos) libraryFiles.set(demo.id, demo); },
    setJob(demo) { source.set(demo.id, demo); },
    failRefresh(message) { refreshError = message; },
    async pollLibrary() { for (const [id, callback] of [...timers]) if (timerDelays.get(id) === 1200) { timers.delete(id); timerDelays.delete(id); callback(); } await settle(); },
    async upload(...names) { get('analysis-files').files = names.map(name => ({ name, size: 1024 })); await get('analysis-files').dispatch('change'); await settle(); },
    async change(id, value) { get(id).value = value; await get(id).dispatch('change'); await settle(); },
    blockMap(name) { let release; mapGates.set(name, new Promise(resolve => { release = resolve; })); return release; },
    resize() { for (const callback of resizeObservers) callback(); },
  };
}

test('removing the last demo then changing color scale cannot resurrect its heatmap', async () => {
  const ui = await page();
  assert.ok(ui.hasVisibleHeat());
  const row = ui.get('demo-list').children[0];
  await row.querySelectorAll('button').find(child => child.className === 'demo-remove').click(); await settle();
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

function rosterDemo(id = 'roster', map = 'de_mirage') {
  const players = [
    ['p1', 'Alice'], ['p2', 'Bob'], ['p3', 'Cara'], ['p4', 'Dan'], ['p5', 'Orphan'], ['p6', 'Shared'],
  ].map(([id, name]) => ({ id, name, stable: true }));
  const teams = [
    { id: 'alpha', name: 'Alpha', playerIds: ['p1', 'p2', 'p6'] },
    { id: 'beta', name: 'Beta', playerIds: ['p3', 'p4', 'p6'] },
  ];
  const series = [
    ['p1', 'alpha', 3, 1], ['p2', 'alpha', 2, 2], ['p3', 'beta', 3, 4],
    ['p4', 'beta', 2, 8], ['p5', 'unknown', 3, 16], ['p6', 'alpha', 3, 32], ['p6', 'beta', 2, 64],
  ].map(([playerId, teamId, side, weight], index) => ({ playerId, teamId, side,
    cells: [[128 + index * 64, 768, 0, weight, weight, weight, weight]] }));
  return { id, name: `${id}.dem`, map, roundCount: 1, players, teams, series, utilities: [] };
}
function playerInputs(ui, root = ui.get('player-list')) {
  return root.querySelectorAll('input').filter(input => input.dataset.playerId);
}
function group(ui, teamId) {
  const result = ui.get('player-list').children.find(child => child.dataset.teamId === teamId);
  assert.ok(result, `Missing player group ${teamId}`); return result;
}
function selectedPlayerIds(ui) { return [...new Set(playerInputs(ui).filter(input => input.checked).map(input => input.dataset.playerId))].sort(); }
async function clickGroup(ui, teamId, action) {
  const button = group(ui, teamId).querySelectorAll('button').find(button => button.dataset.action === action);
  assert.ok(button, `Missing ${action} button in ${teamId}`); await button.click(); await settle();
}
async function selectPlayer(ui, id, checked, teamId) {
  const input = playerInputs(ui, teamId ? group(ui, teamId) : ui.get('player-list')).find(input => input.dataset.playerId === id);
  assert.ok(input, `Missing player ${id}`); input.checked = checked; await input.dispatch('change'); await settle();
}
function deaths(ui) { return Number(ui.get('metric-deaths').textContent.replaceAll(',', '')); }
async function clickAndSettle(ui, id) { await ui.get(id).click(); await settle(); }
async function searchPlayers(ui, query) { ui.get('player-search').value = query; await ui.get('player-search').dispatch('input'); await settle(); }

test('global player inversion complements both implicit-all and partial selections, and two inversions restore them', async () => {
  const ui = await page([rosterDemo()]);
  assert.equal(deaths(ui), 127);
  await clickAndSettle(ui, 'players-invert');
  assert.deepEqual(selectedPlayerIds(ui), []); assert.equal(deaths(ui), 0); assert.equal(ui.get('selection-empty').hidden, false);
  await clickAndSettle(ui, 'players-invert');
  assert.deepEqual(selectedPlayerIds(ui), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']); assert.equal(deaths(ui), 127);
  await selectPlayer(ui, 'p2', false);
  await clickAndSettle(ui, 'players-invert'); assert.deepEqual(selectedPlayerIds(ui), ['p2']); assert.equal(deaths(ui), 2);
  await clickAndSettle(ui, 'players-invert'); assert.equal(deaths(ui), 125);
  await clickAndSettle(ui, 'players-all'); assert.equal(deaths(ui), 127);
  await clickAndSettle(ui, 'players-none'); assert.deepEqual(selectedPlayerIds(ui), []); assert.equal(deaths(ui), 0);
});

test('team player actions affect only that roster and preserve other players, including unassigned IDs', async () => {
  const ui = await page([rosterDemo()]);
  assert.deepEqual(playerInputs(ui, group(ui, 'unassigned')).map(input => input.dataset.playerId), ['p5']);
  await clickGroup(ui, 'alpha', 'invert');
  assert.deepEqual(selectedPlayerIds(ui), ['p3', 'p4', 'p5']); assert.equal(deaths(ui), 28);
  assert.match(group(ui, 'alpha').querySelectorAll('span').find(span => span.className === 'player-group-count').textContent, /0\s*\/\s*3/);
  await clickGroup(ui, 'alpha', 'invert'); assert.equal(deaths(ui), 127);
  await selectPlayer(ui, 'p2', false);
  await clickGroup(ui, 'alpha', 'all'); assert.equal(deaths(ui), 127);
  await clickAndSettle(ui, 'players-none'); await clickGroup(ui, 'unassigned', 'all');
  assert.deepEqual(selectedPlayerIds(ui), ['p5']); assert.equal(deaths(ui), 16);
  await clickGroup(ui, 'unassigned', 'invert'); assert.equal(deaths(ui), 0);
});

test('search hides rows without restricting team or global bulk-selection membership', async () => {
  const ui = await page([rosterDemo()]);
  await clickAndSettle(ui, 'players-none'); await searchPlayers(ui, 'Alice');
  assert.deepEqual(playerInputs(ui).map(input => input.dataset.playerId), ['p1']);
  await clickGroup(ui, 'alpha', 'all'); assert.equal(deaths(ui), 99);
  await searchPlayers(ui, ''); assert.deepEqual(selectedPlayerIds(ui), ['p1', 'p2', 'p6']);
  await searchPlayers(ui, 'Alice'); await clickAndSettle(ui, 'players-invert');
  await searchPlayers(ui, ''); assert.deepEqual(selectedPlayerIds(ui), ['p3', 'p4', 'p5']); assert.equal(deaths(ui), 28);
});

test('a shared player ID stays linked in every roster after individual and group changes', async () => {
  const ui = await page([rosterDemo()]);
  assert.equal(playerInputs(ui).filter(input => input.dataset.playerId === 'p6').length, 2);
  await selectPlayer(ui, 'p6', false, 'alpha');
  assert.ok(playerInputs(ui).filter(input => input.dataset.playerId === 'p6').every(input => !input.checked)); assert.equal(deaths(ui), 31);
  for (const teamId of ['alpha', 'beta']) assert.match(group(ui, teamId).querySelectorAll('span').find(span => span.className === 'player-group-count').textContent, /2\s*\/\s*3/);
  await clickGroup(ui, 'beta', 'all');
  assert.ok(playerInputs(ui).filter(input => input.dataset.playerId === 'p6').every(input => input.checked)); assert.equal(deaths(ui), 127);
});

test('cross-demo rosters deduplicate IDs while bulk selection still includes all of their observations', async () => {
  const second = rosterDemo('second'); second.players[0].name = 'Alice Alternate';
  second.players.push({ id: 'p7', name: 'Extra', stable: true }); second.teams[0].playerIds.push('p7');
  second.series.push({ playerId: 'p7', teamId: 'alpha', side: 3, cells: [[576, 768, 0, 128, 128, 128, 128]] });
  const otherMap = rosterDemo('other-map', 'de_nuke'); otherMap.players.push({ id: 'not-this-map', name: 'Different map', stable: true }); otherMap.teams[0].playerIds.push('not-this-map');
  const ui = await page([rosterDemo('first'), second, otherMap]);
  assert.deepEqual(playerInputs(ui, group(ui, 'alpha')).map(input => input.dataset.playerId).sort(), ['p1', 'p2', 'p6', 'p7']);
  assert.equal(playerInputs(ui).filter(input => input.dataset.playerId === 'p1').length, 1);
  assert.ok(!playerInputs(ui).some(input => input.dataset.playerId === 'not-this-map'));
  await clickAndSettle(ui, 'players-none'); await clickGroup(ui, 'alpha', 'all');
  assert.deepEqual(selectedPlayerIds(ui), ['p1', 'p2', 'p6', 'p7']); assert.equal(deaths(ui), 326);
  const secondDemoCheck = ui.get('demo-list').children.find(row => row.querySelectorAll('input')[0]?.['aria-label'] === '叠加 second.dem').querySelectorAll('input')[0];
  secondDemoCheck.checked = false; await secondDemoCheck.dispatch('change'); await settle();
  assert.ok(!playerInputs(ui).some(input => input.dataset.playerId === 'p7'));
  await clickAndSettle(ui, 'players-none'); await clickGroup(ui, 'alpha', 'all'); assert.equal(deaths(ui), 99);
});

test('team filters remain an independent intersection and CT/T changes do not split the roster', async () => {
  const ui = await page([rosterDemo()]);
  await clickAndSettle(ui, 'players-none'); await clickAndSettle(ui, 'teams-none');
  await clickGroup(ui, 'alpha', 'all'); assert.equal(deaths(ui), 0);
  assert.ok(group(ui, 'alpha').querySelectorAll('p').some(element => element.className === 'player-group-excluded'));
  const alphaFilter = ui.get('team-list').querySelectorAll('input').find(input => input['aria-label'] === '筛选队伍 Alpha');
  alphaFilter.checked = true; await alphaFilter.dispatch('change'); await settle();
  assert.equal(deaths(ui), 35); assert.deepEqual(selectedPlayerIds(ui), ['p1', 'p2', 'p6']);
  await ui.change('analysis-side', '3'); assert.equal(deaths(ui), 33); assert.equal(playerInputs(ui, group(ui, 'alpha')).length, 3);
  await ui.change('analysis-side', '2'); assert.equal(deaths(ui), 2); assert.equal(playerInputs(ui, group(ui, 'alpha')).length, 3);
  await ui.change('analysis-side', 'all'); await clickAndSettle(ui, 'teams-invert'); assert.equal(deaths(ui), 64);
  await clickAndSettle(ui, 'teams-invert'); assert.equal(deaths(ui), 35);
  await clickAndSettle(ui, 'teams-all'); assert.equal(deaths(ui), 99);
});

test('bulk controls are safe with no imported demos and leave the analysis empty', async () => {
  const ui = await page([]);
  for (const id of ['players-invert', 'players-all', 'players-none', 'teams-invert', 'teams-all', 'teams-none']) await clickAndSettle(ui, id);
  assert.deepEqual(selectedPlayerIds(ui), []); assert.equal(ui.hasVisibleHeat(), false);
  assert.equal(ui.get('analysis-empty').hidden, false); assert.equal(ui.get('global-error').textContent, '');
});

function ladderDemo(id, map) {
  const players = Array.from({ length: 10 }, (_, index) => ({ id: `${id}-player-${index}`, name: `Player ${index + 1}`, stable: true }));
  const teams = [0, 1].map(index => ({ id: `${id}-roster-${index}`, name: '', identitySource: 'roster', playerIds: players.slice(index * 5, index * 5 + 5).map(player => player.id) }));
  const series = players.map((player, index) => ({ playerId: player.id, teamId: teams[index < 5 ? 0 : 1].id, side: index < 5 ? 3 : 2,
    cells: [[128 + index * 32, 768, 0, 1, 1, 1, 1]] }));
  return { id, name: `${id}.dem`, map, roundCount: 1, players, teams, series, utilities: [] };
}
function demoCheckbox(ui, name) {
  const input = ui.get('demo-list').querySelectorAll('input').find(input => input['aria-label'] === `叠加 ${name}`);
  assert.ok(input, `Missing demo checkbox ${name}`); return input;
}
async function focusDemoRow(ui, name) {
  const button = ui.get('demo-list').querySelectorAll('button').find(button => button['aria-label'] === `查看 ${name} 所在地图`);
  assert.ok(button, `Missing focus button ${name}`); await button.click(); await settle();
}

test('uploading Ancient after Anubis focuses the imported map and restores both anonymous rosters', async () => {
  const anubis = ladderDemo('anubis', 'de_anubis'), ancient = ladderDemo('ancient', 'de_ancient');
  const ui = await page([anubis], { uploads: [ancient], saved: { map: 'de_anubis', selectedDemos: ['anubis'] } });
  await clickAndSettle(ui, 'players-none'); await clickAndSettle(ui, 'teams-none'); await searchPlayers(ui, 'old player search');
  ui.get('analysis-floor').value = 'lower';
  await ui.upload(ancient.name);
  assert.equal(ui.get('global-error').textContent, ''); assert.equal(ui.get('canvas-map-name').textContent, 'de_ancient');
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(ui.get('player-search').value, ''); assert.equal(ui.get('analysis-floor').value, 'all');
  assert.equal(playerInputs(ui).length, 10); assert.equal(ui.get('team-list').querySelectorAll('input').length, 2);
  assert.deepEqual(selectedPlayerIds(ui), ancient.players.map(player => player.id).sort()); assert.equal(deaths(ui), 10);
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(demoCheckbox(ui, anubis.name).checked);
  assert.equal(ui.saved().map, 'de_ancient'); assert.ok(ui.saved().selectedDemos.includes('ancient'));
});

test('a multi-map upload batch focuses only its first successful demo even when an earlier parse fails', async () => {
  const anubis = ladderDemo('old-anubis', 'de_anubis'), bad = { ...ladderDemo('bad-upload', 'de_mirage'), parseError: 'Fixture parse failure' };
  const ancient = ladderDemo('first-good', 'de_ancient'), later = ladderDemo('later-anubis', 'de_anubis');
  const ui = await page([anubis], { uploads: [bad, ancient, later] });
  await ui.upload(bad.name, ancient.name, later.name);
  assert.match(ui.get('global-error').textContent, /Fixture parse failure/);
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(ui.get('canvas-map-name').textContent, 'de_ancient');
  assert.deepEqual(selectedPlayerIds(ui), ancient.players.map(player => player.id).sort()); assert.equal(deaths(ui), 10);
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(demoCheckbox(ui, later.name).checked);
  assert.ok(ui.requests.some(([url, method]) => url === '/api/demos/bad-upload' && method === 'DELETE'));
  assert.equal(ui.get('demo-list').children.length, 3); assert.equal(ui.get('upload-status').hidden, true);
});

test('restoring stale demo selections drops expired IDs but preserves an explicit empty selection', async () => {
  const anubis = ladderDemo('new-anubis-id', 'de_anubis'), ancient = ladderDemo('new-ancient-id', 'de_ancient');
  const stale = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: ['expired-server-id'] } });
  assert.equal(stale.saved().selectedDemos, null); assert.equal(deaths(stale), 10);
  assert.ok(demoCheckbox(stale, anubis.name).checked); assert.ok(demoCheckbox(stale, ancient.name).checked);
  const partial = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: [anubis.id, 'expired-server-id'] } });
  assert.deepEqual(partial.saved().selectedDemos, [anubis.id]); assert.ok(demoCheckbox(partial, anubis.name).checked); assert.equal(demoCheckbox(partial, ancient.name).checked, false);
  assert.equal(deaths(partial), 10);
  const empty = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: [] } });
  assert.deepEqual(empty.saved().selectedDemos, []); assert.equal(deaths(empty), 0); assert.deepEqual(selectedPlayerIds(empty), []);
  assert.equal(demoCheckbox(empty, anubis.name).checked, false); assert.equal(demoCheckbox(empty, ancient.name).checked, false);
});

test('a URL for an already cached demo overrides the old map and includes its roster in the selection', async () => {
  const anubis = ladderDemo('anubis', 'de_anubis'), ancient = ladderDemo('ancient', 'de_ancient');
  const ui = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: ['anubis'] }, href: 'http://127.0.0.1:8765/analysis.html?demo=ancient' });
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(ui.get('canvas-map-name').textContent, 'de_ancient');
  assert.equal(deaths(ui), 10); assert.deepEqual(selectedPlayerIds(ui), ancient.players.map(player => player.id).sort());
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(demoCheckbox(ui, anubis.name).checked);
  assert.equal(ui.saved().map, 'de_ancient');
});

test('viewing a demo row resets hidden player filters without discarding other selected demos on that map', async () => {
  const anubis = ladderDemo('anubis', 'de_anubis'), ancient = ladderDemo('ancient', 'de_ancient'), second = ladderDemo('ancient-two', 'de_ancient');
  const ui = await page([anubis, ancient, second], { saved: { map: 'de_anubis', selectedDemos: ['anubis', 'ancient-two'] } });
  await clickAndSettle(ui, 'players-none'); await clickAndSettle(ui, 'teams-none'); await searchPlayers(ui, 'not in this match');
  await focusDemoRow(ui, ancient.name);
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(ui.get('player-search').value, ''); assert.equal(ui.get('analysis-floor').value, 'all');
  assert.equal(deaths(ui), 20); assert.equal(selectedPlayerIds(ui).length, 20); assert.equal(ui.get('team-list').querySelectorAll('input').length, 4);
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(demoCheckbox(ui, second.name).checked); assert.ok(demoCheckbox(ui, anubis.name).checked);
});

test('restoring more than ten cached demos loads every summary once and computes one batch', async () => {
  const demos = Array.from({ length: 24 }, (_, index) => dataset(`cached-${index}`));
  const ui = await page(demos, { saved: { ids: demos.map(demo => demo.id), map: 'de_mirage' } });
  assert.equal(ui.get('demo-count').textContent, '24 场'); assert.equal(deaths(ui), 24);
  assert.equal(ui.analysisCalls(), 1, 'restoration does not repeatedly aggregate growing datasets');
  for (const demo of demos) assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${demo.id}/analysis`).length, 1);
  assert.ok(ui.savedWrites.length > 0); assert.ok(ui.savedWrites.every(saved => saved.ids.length === 24), 'no partial restore overwrites preferences');
  assert.equal(ui.saved().selectedDemos, null);
});

test('manual upload accepts a batch larger than ten demos', async () => {
  const demos = Array.from({ length: 12 }, (_, index) => dataset(`upload-${index}`));
  const ui = await page([dataset('existing')], { uploads: demos });
  await ui.upload(...demos.map(demo => demo.name));
  assert.equal(ui.get('demo-count').textContent, '13 场'); assert.equal(deaths(ui), 13);
  assert.equal(ui.get('global-error').textContent, ''); assert.equal(ui.get('upload-status').hidden, true);
  assert.equal(ui.requests.filter(([url, method]) => url === '/api/demos?mode=analysis' && method === 'POST').length, 12);
});

test('folder refresh adds demos without changing an explicit subset, map, roster or display filters', async () => {
  const old = rosterDemo('old', 'de_nuke'), incoming = rosterDemo('incoming', 'de_ancient');
  const saved = { ids: ['old'], selectedDemos: ['old'], selectedTeams: ['alias:squad'], selectedPlayers: ['p1'], aliases: { alpha: 'Squad' }, map: 'de_nuke', side: '3', floor: 'lower', query: 'Alice', layers: ['deaths'], radius: 224, opacity: 85, scale: 'linear', utilityType: 'smoke', utilitySort: 'rare', landingDistance: 192, throwDistance: 96 };
  const ui = await page([old], { saved, libraryDemos: [old, incoming], mapInfo: { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' } });
  const before = ui.saved();
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.get('demo-count').textContent, '2 场'); assert.equal(ui.get('analysis-map').value, 'de_nuke');
  assert.equal(ui.get('analysis-floor').value, 'lower'); assert.equal(ui.get('analysis-side').value, '3');
  assert.deepEqual(selectedPlayerIds(ui), ['p1']); assert.equal(deaths(ui), 1);
  assert.equal(demoCheckbox(ui, incoming.name).checked, false); assert.equal(demoCheckbox(ui, old.name).checked, true);
  assert.match(ui.get('library-status').textContent, /新增 1 场/); assert.equal(ui.get('refresh-library').disabled, false);
  for (const key of Object.keys(before).filter(key => key !== 'ids')) assert.deepEqual(ui.saved()[key], before[key], `${key} must survive folder refresh`);
  const calls = ui.analysisCalls();
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.analysisCalls(), calls, 'unchanged refresh needs no aggregation');
  assert.match(ui.get('library-status').textContent, /新增 0 场 · 2 场无需重复解析/);
  for (const demo of [old, incoming]) assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${demo.id}/analysis`).length, 1);
});

test('folder refresh under the default all selection automatically includes new demos on the current map', async () => {
  const old = dataset('old'), added = dataset('added');
  const ui = await page([old], { libraryDemos: [old, added] });
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(deaths(ui), 2); assert.equal(ui.saved().selectedDemos, null); assert.ok(demoCheckbox(ui, added.name).checked);
  assert.equal(ui.get('library-directory').textContent, 'F:\\viewer\\demo');
});

test('queued folder demos update when parsing finishes and do not repeatedly load cached summaries', async () => {
  const old = dataset('old'), queued = { ...dataset('pending'), jobStatus: 'queued', revision: 'first' };
  const ui = await page([old], { libraryDemos: [old, queued] });
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(deaths(ui), 1); assert.equal(demoCheckbox(ui, queued.name).disabled, true);
  assert.match(ui.get('library-progress').textContent, /1 场等待或正在解析/);
  ui.setJob({ ...queued, jobStatus: 'ready' }); await ui.pollLibrary();
  assert.equal(deaths(ui), 2); assert.equal(demoCheckbox(ui, queued.name).disabled, false);
  assert.equal(ui.get('library-progress').textContent, '');
  await ui.pollLibrary(); await clickAndSettle(ui, 'refresh-library');
  for (const demo of [old, queued]) assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${demo.id}/analysis`).length, 1);
});

test('refresh failure keeps cached analysis and filters usable and permits retry', async () => {
  const old = dataset('old'), next = dataset('next');
  const ui = await page([old], { libraryDemos: [old, next], saved: { selectedDemos: ['old'], side: '3' }, libraryErrors: ['copying.dem 尚在写入，稍后刷新重试'] });
  ui.failRefresh('目录暂不可读取'); await clickAndSettle(ui, 'refresh-library');
  assert.match(ui.get('library-status').textContent, /刷新失败：目录暂不可读取/);
  assert.equal(ui.get('refresh-library').disabled, false); assert.equal(deaths(ui), 1);
  assert.deepEqual(ui.saved().selectedDemos, ['old']); assert.equal(ui.get('demo-count').textContent, '1 场');
  ui.failRefresh(''); await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.get('demo-count').textContent, '2 场'); assert.equal(deaths(ui), 1);
  assert.match(ui.get('library-status').textContent, /copying.dem 尚在写入/);
  assert.equal(ui.get('global-error').textContent, '');
});

test('a ready-to-ready revision change refreshes only that demo and replaces its old analysis', async () => {
  const old = { ...dataset('edited'), revision: 'v1' }, other = { ...dataset('untouched'), revision: 'v1' };
  const ui = await page([old, other]);
  const updated = { ...dataset('edited'), revision: 'v2' }; updated.series[0].cells[0][5] = 9;
  ui.setJob(updated); await clickAndSettle(ui, 'refresh-library');
  assert.equal(deaths(ui), 10); assert.equal(ui.get('demo-count').textContent, '2 场');
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/edited/analysis').length, 2);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/untouched/analysis').length, 1);
  await clickAndSettle(ui, 'refresh-library'); assert.equal(deaths(ui), 10);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/edited/analysis').length, 2);
});

test('migration applies complete settings once, preserving subsequent local edits on reload', async () => {
  const demos = [rosterDemo('restored', 'de_nuke'), rosterDemo('second', 'de_nuke')];
  const settings = { ids: demos.map(d => d.id), selectedDemos: ['restored'], selectedTeams: ['alias:squad'], selectedPlayers: ['p1'], map: 'de_nuke', aliases: { alpha: 'Squad' }, side: '3', floor: 'lower', query: 'Alice', layers: ['deaths', 'shots'], radius: 224, opacity: 80, scale: 'linear', utilityType: 'flash', utilitySort: 'rare', landingDistance: 192, throwDistance: 96 };
  const session = { sessionId: 'migration-2026', settings }, mapInfo = { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' };
  const ui = await page(demos, { session, mapInfo, saved: { ids: ['expired'], map: 'de_ancient', selectedDemos: [] } });
  assert.equal(deaths(ui), 1); assert.deepEqual(selectedPlayerIds(ui), ['p1']);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(ui.saved()[key], value, `migration must restore ${key}`);
  assert.equal(ui.saved().migratedSessionId, session.sessionId);
  assert.ok(ui.savedWrites.every(saved => saved.floor === 'lower' && saved.ids.length === 2 && saved.selectedPlayers[0] === 'p1'), 'initialization never writes half-restored settings');
  await ui.change('analysis-side', '2'); await ui.change('heat-scale', 'log'); await searchPlayers(ui, 'Squad');
  await clickAndSettle(ui, 'players-none');
  const locallyEdited = ui.saved(), reopened = await page(demos, { saved: locallyEdited, session, mapInfo });
  for (const [key, value] of Object.entries(locallyEdited)) assert.deepEqual(reopened.saved()[key], value, `same session must not overwrite updated ${key}`);
  assert.equal(deaths(reopened), 0); assert.equal(reopened.get('analysis-side').value, '2');
  assert.equal(reopened.get('heat-scale').value, 'log'); assert.equal(reopened.get('player-search').value, 'Squad');
});

test('saved map and floor wait for a queued dataset instead of being replaced by the first ready map', async () => {
  const other = dataset('other', 'de_ancient'), waiting = { ...rosterDemo('waiting', 'de_nuke'), jobStatus: 'queued' };
  const settings = { map: 'de_nuke', floor: 'lower', selectedDemos: ['waiting'], selectedTeams: ['alpha'], selectedPlayers: ['p1'], query: 'Alice', side: '3' };
  const ui = await page([other, waiting], { saved: settings, mapInfo: { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' } });
  assert.equal(ui.saved().map, 'de_nuke'); assert.equal(ui.saved().floor, 'lower');
  assert.deepEqual(ui.saved().selectedPlayers, ['p1']); assert.equal(ui.get('analysis-empty').hidden, false);
  ui.setJob({ ...waiting, jobStatus: 'ready' }); await ui.pollLibrary();
  assert.equal(ui.get('analysis-map').value, 'de_nuke'); assert.equal(ui.get('analysis-floor').value, 'lower');
  assert.equal(ui.get('player-search').value, 'Alice'); assert.deepEqual(selectedPlayerIds(ui), ['p1']); assert.equal(deaths(ui), 1);
  assert.equal(ui.saved().map, 'de_nuke'); assert.equal(ui.saved().floor, 'lower');
});

test('reparsing the only demo on the active map preserves its filters until its new revision is ready', async () => {
  const other = dataset('other', 'de_ancient'), original = { ...rosterDemo('updated', 'de_nuke'), revision: 'v1' };
  const ui = await page([other, original], { saved: { map: 'de_nuke', floor: 'lower', selectedDemos: ['updated'], selectedTeams: ['alpha'], selectedPlayers: ['p1'], query: 'Alice', side: '3' }, mapInfo: { lowerMaxZ: 100 } });
  assert.equal(deaths(ui), 1);
  ui.setJob({ ...original, jobStatus: 'parsing', revision: 'v2' }); await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.saved().map, 'de_nuke'); assert.equal(ui.saved().floor, 'lower');
  assert.equal(ui.hasVisibleHeat(), false, 'old revision is not shown as current results');
  const updated = { ...rosterDemo('updated', 'de_nuke'), revision: 'v2' }; updated.series[0].cells[0][5] = 9;
  ui.setJob(updated); await ui.pollLibrary();
  assert.equal(ui.get('analysis-map').value, 'de_nuke'); assert.equal(ui.get('analysis-floor').value, 'lower');
  assert.equal(ui.get('player-search').value, 'Alice'); assert.deepEqual(selectedPlayerIds(ui), ['p1']); assert.equal(deaths(ui), 9);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/updated/analysis').length, 2);
});
