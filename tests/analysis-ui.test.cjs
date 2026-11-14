const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const analysis = require('../web/analysis-core.js');
const heatmap = require('../web/heatmap.js');
const replayLibrary = require('../web/replay-library.js');

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

function folderDemo(id, paths, map = 'de_mirage') {
  return { ...dataset(id, map), sources: paths.map(source => typeof source === 'string' ? { path: source, kind: 'dem', available: true } : source), sourceCount: paths.length };
}

function viewIndependentSettings(settings) {
  return Object.fromEntries(['ids', 'selectedDemos', 'selectedTeams', 'selectedPlayers', 'aliases', 'map', 'side', 'floor', 'utilityTime', 'query'].map(key => [key, settings[key]]));
}

async function page(datasets = [dataset('one')], pageOptions = {}) {
  const elements = new Map(), canvases = [], downloads = [], downloadBlobs = new Map(), requests = [], timers = new Map(), parseBodies = [], reparseBodies = [], summaryFailures = new Map();
  const mapGates = new Map(), resizeObservers = [], timerDelays = new Map(), savedWrites = [];
  let nextTimer = 0, analysisCalls = 0, refreshError = '', reparseRequestError = '';
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
    click() { if (this.tagName === 'a') downloads.push({ href: this.href, filename: this.download, blob: downloadBlobs.get(this.href) }); return this.dispatch('click'); }
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
  const libraryInfo = { enabled: true, directory: 'F:\\viewer\\demo', ...(pageOptions.library || {}) };
  const scanned = new Set(source.keys());
  const catalogDemos = () => [...new Map([...libraryFiles, ...source]).values()].map(d => ({
    id: d.id, name: d.name, map: source.has(d.id) || d.jobStatus === 'ready' ? d.map : d.catalogMap || '', status: d.jobStatus || (source.has(d.id) ? 'ready' : 'discovered'),
    revision: d.revision, error: d.parseError, analysis: source.has(d.id) && d.analysis !== false, reparse: d.reparse,
    available: d.available !== false, sourceCount: d.sourceCount || 1,
    sources: d.sources || [{ path: d.name, kind: 'dem', available: d.available !== false }],
  }));
  const stored = new Map(pageOptions.saved ? [['cs2-analysis-v4', JSON.stringify(pageOptions.saved)]] : []);
  const location = { href: pageOptions.href || 'http://127.0.0.1:8765/analysis.html' };
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/api/session-settings') return response(pageOptions.session || { sessionId: '', settings: null });
    if (url === '/api/library') return response({ count: libraryFiles.size, ...libraryInfo });
    if (url === '/api/library/demos') return response({ demos: catalogDemos(), scanning: libraryInfo.scanning === true });
    if (url === '/api/library/reparse' && options.method === 'POST') {
      const body = JSON.parse(options.body); reparseBodies.push(body);
      if (pageOptions.reparseGate) await pageOptions.reparseGate;
      if (reparseRequestError) return { ok: false, status: 503, json: async () => ({ error: reparseRequestError }) };
      const result = { queued: [], active: [], skipped: [] };
      for (const id of body.ids) {
        const demo = source.get(id);
        if (!demo || demo.reparseSkip) {
          result.skipped.push({ id, name: demo?.name || id, error: demo?.reparseSkip || '录像不存在' });
          if (demo) source.set(id, { ...demo, reparse: { status: 'error', error: demo.reparseSkip } });
        }
        else if (['queued', 'parsing'].includes(demo.reparse?.status)) result.active.push(id);
        else { result.queued.push(id); source.set(id, { ...demo, reparse: { status: 'queued', progress: 0, message: '等待重新解析', revision: `${id}-next` } }); }
      }
      return response(result);
    }
    const parsing = /^\/api\/library\/demos\/([^/]+)\/parse$/.exec(url);
    if (parsing && options.method === 'POST') {
      const id = decodeURIComponent(parsing[1]), demo = source.get(id) || libraryFiles.get(id);
      parseBodies.push([id, JSON.parse(options.body)]);
      if (pageOptions.parseGate) await pageOptions.parseGate;
      if (!demo || demo.requestError) return { ok: false, status: 409, json: async () => ({ error: demo?.requestError || '源文件不可用' }) };
      const cached = catalogDemos().find(d => d.id === id).status === 'ready';
      const status = cached ? 'ready' : demo.afterParseStatus || 'ready';
      source.set(id, { ...demo, analysis: true, jobStatus: status });
      return response({ id, status, cached, analysis: true, revision: demo.revision });
    }
    if (url === '/api/library/refresh' && options.method === 'POST') {
      if (refreshError) return { ok: false, status: 500, json: async () => ({ error: refreshError }) };
      if (pageOptions.asyncScan) { libraryInfo.scanning = true; return response({ scanning: true, added: 0, unchanged: 0, queued: 0, errors: [] }); }
      let added = 0;
      for (const id of libraryFiles.keys()) if (!scanned.has(id)) { scanned.add(id); added++; }
      return response({ added, unchanged: libraryFiles.size - added, queued: [...source.values()].filter(d => d.jobStatus === 'queued').length, directory: 'F:\\viewer\\demo', errors: pageOptions.libraryErrors || [] });
    }
    if (url === '/api/analyses') return response([...source.values()].filter(d => d.analysis !== false && d.jobStatus !== 'discovered').map(d => ({ id: d.id, name: d.name, map: d.map, status: d.jobStatus || 'ready', revision: d.revision, error: d.parseError, reparse: d.reparse })));
    const removingAnalysis = /^\/api\/analyses\/([^/]+)$/.exec(url);
    if (removingAnalysis && options.method === 'DELETE') {
      const id = decodeURIComponent(removingAnalysis[1]);
      if (source.has(id)) source.set(id, { ...source.get(id), analysis: false });
      return response({});
    }
    if (url === '/api/demos?mode=analysis' && options.method === 'POST') {
      const file = options.body.get('demo'), demo = uploads.get(file.name);
      assert.ok(demo, `Unexpected uploaded fixture ${file.name}`); source.set(demo.id, { ...demo, analysis: true }); return response({ id: demo.id, shared: demo.shared === true });
    }
    const match = /^\/api\/demos\/([^/]+)(\/(?:analysis|status))?$/.exec(url);
    if (match) {
      if (options.method === 'DELETE') { source.delete(match[1]); return response({}); }
      if (match[2] === '/analysis' && summaryFailures.has(match[1])) return { ok: false, status: 503, json: async () => ({ error: summaryFailures.get(match[1]) }) };
      if (match[2] === '/analysis' && source.has(match[1])) return response(source.get(match[1]));
      if (match[2] === '/status' && source.has(match[1])) {
        const demo = source.get(match[1]);
        if (demo.blockStatus) await new Promise((resolve, reject) => { if (options.signal.aborted) reject(new DOMException('Cancelled', 'AbortError')); else options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); });
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
    static createObjectURL(blob) { const url = `blob:test-${downloadBlobs.size}`; downloadBlobs.set(url, blob); return url; }
    static revokeObjectURL() {}
  }
  const sandbox = {
    window: { ReplayAnalysis: { ...analysis, aggregate: (...args) => { analysisCalls++; return analysis.aggregate(...args); } }, ReplayHeatmap: heatmap, ReplayLibrary: replayLibrary, history: { state: null, replaceState: (_state, _title, url) => { location.href = String(url); } } }, document: { getElementById: get, createElement: create, addEventListener: noop },
    Option: function (text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    Image: class { decode() { return Promise.resolve(); } },
    ImageData: class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } },
    ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); if (key === 'cs2-analysis-v4') savedWrites.push(JSON.parse(value)); } }, location,
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
  return { get, main, canvases, downloads, requests, parseBodies, reparseBodies, renderedHeat, hasVisibleHeat, href: () => location.href,
    saved: () => JSON.parse(stored.get('cs2-analysis-v4') || '{}'),
    savedWrites, analysisCalls: () => analysisCalls,
    setLibraryFiles(demos) { libraryFiles.clear(); for (const demo of demos) libraryFiles.set(demo.id, demo); },
    setLibraryInfo(info) { Object.assign(libraryInfo, info); },
    setJob(demo) { source.set(demo.id, demo); },
    failRefresh(message) { refreshError = message; },
    failReparseRequest(message) { reparseRequestError = message; },
    failSummary(id, message) { if (message) summaryFailures.set(id, message); else summaryFailures.delete(id); },
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
  assert.ok(ui.requests.some(([url, method]) => url === '/api/analyses/one' && method === 'DELETE'));
  assert.equal(ui.requests.some(([url, method]) => url === '/api/demos/one' && method === 'DELETE'), false);
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
function visibleDemoNames(ui, id = 'demo-list') { return ui.get(id).querySelectorAll('input').map(input => input['aria-label'].replace(/^叠加 /, '')); }
function savedDemoChecked(ui, id) { const selected = ui.saved().selectedDemos; return selected === null || selected.includes(id); }
function catalogCheckbox(ui, id) {
  const input = ui.get('analysis-library-list').querySelectorAll('input').find(input => input.dataset.demoId === id);
  assert.ok(input, `Missing catalog checkbox ${id}`); return input;
}
async function chooseLibrary(ui, ids, add = true) {
  await clickAndSettle(ui, 'open-analysis-library');
  for (const id of ids) { const input = catalogCheckbox(ui, id); input.checked = true; await input.dispatch('change'); }
  if (add) await clickAndSettle(ui, 'analysis-library-add');
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
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(savedDemoChecked(ui, anubis.id));
  assert.deepEqual(visibleDemoNames(ui), [ancient.name]);
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
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(savedDemoChecked(ui, later.id));
  assert.ok(ui.requests.some(([url, method]) => url === '/api/demos/bad-upload' && method === 'DELETE'));
  assert.deepEqual(visibleDemoNames(ui), [ancient.name]); assert.equal(ui.saved().ids.length, 3); assert.equal(ui.get('upload-status').hidden, true);
});

test('restoring stale demo selections drops expired IDs but preserves an explicit empty selection', async () => {
  const anubis = ladderDemo('new-anubis-id', 'de_anubis'), ancient = ladderDemo('new-ancient-id', 'de_ancient');
  const stale = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: ['expired-server-id'] } });
  assert.equal(stale.saved().selectedDemos, null); assert.equal(deaths(stale), 10);
  assert.ok(demoCheckbox(stale, anubis.name).checked); assert.ok(savedDemoChecked(stale, ancient.id));
  const partial = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: [anubis.id, 'expired-server-id'] } });
  assert.deepEqual(partial.saved().selectedDemos, [anubis.id]); assert.ok(demoCheckbox(partial, anubis.name).checked); assert.equal(savedDemoChecked(partial, ancient.id), false);
  assert.equal(deaths(partial), 10);
  const empty = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: [] } });
  assert.deepEqual(empty.saved().selectedDemos, []); assert.equal(deaths(empty), 0); assert.deepEqual(selectedPlayerIds(empty), []);
  assert.equal(demoCheckbox(empty, anubis.name).checked, false); assert.equal(savedDemoChecked(empty, ancient.id), false);
});

test('a URL for an already cached demo overrides the old map and includes its roster in the selection', async () => {
  const anubis = ladderDemo('anubis', 'de_anubis'), ancient = ladderDemo('ancient', 'de_ancient');
  const ui = await page([anubis, ancient], { saved: { map: 'de_anubis', selectedDemos: ['anubis'] }, href: 'http://127.0.0.1:8765/analysis.html?demo=ancient' });
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(ui.get('canvas-map-name').textContent, 'de_ancient');
  assert.equal(deaths(ui), 10); assert.deepEqual(selectedPlayerIds(ui), ancient.players.map(player => player.id).sort());
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(savedDemoChecked(ui, anubis.id)); assert.deepEqual(visibleDemoNames(ui), [ancient.name]);
  assert.equal(ui.saved().map, 'de_ancient');
});

test('viewing a demo row resets hidden player filters without discarding other selected demos on that map', async () => {
  const anubis = ladderDemo('anubis', 'de_anubis'), ancient = ladderDemo('ancient', 'de_ancient'), second = ladderDemo('ancient-two', 'de_ancient');
  const ui = await page([anubis, ancient, second], { saved: { map: 'de_ancient', selectedDemos: ['anubis', 'ancient-two'] } });
  await clickAndSettle(ui, 'players-none'); await clickAndSettle(ui, 'teams-none'); await searchPlayers(ui, 'not in this match');
  await focusDemoRow(ui, ancient.name);
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(ui.get('player-search').value, ''); assert.equal(ui.get('analysis-floor').value, 'all');
  assert.equal(deaths(ui), 20); assert.equal(selectedPlayerIds(ui).length, 20); assert.equal(ui.get('team-list').querySelectorAll('input').length, 4);
  assert.ok(demoCheckbox(ui, ancient.name).checked); assert.ok(demoCheckbox(ui, second.name).checked); assert.ok(savedDemoChecked(ui, anubis.id));
});

test('restoring more than ten cached demos loads every summary once and computes one batch', async () => {
  const demos = Array.from({ length: 24 }, (_, index) => dataset(`cached-${index}`));
  const ui = await page(demos, { saved: { ids: demos.map(demo => demo.id), map: 'de_mirage' } });
  assert.equal(ui.get('demo-count').textContent, '本图 24 / 共 24 场'); assert.equal(deaths(ui), 24);
  assert.equal(ui.analysisCalls(), 1, 'restoration does not repeatedly aggregate growing datasets');
  for (const demo of demos) assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${demo.id}/analysis`).length, 1);
  assert.ok(ui.savedWrites.length > 0); assert.ok(ui.savedWrites.every(saved => saved.ids.length === 24), 'no partial restore overwrites preferences');
  assert.equal(ui.saved().selectedDemos, null);
});

test('manual upload accepts a batch larger than ten demos', async () => {
  const demos = Array.from({ length: 12 }, (_, index) => dataset(`upload-${index}`));
  const ui = await page([dataset('existing')], { uploads: demos });
  await ui.upload(...demos.map(demo => demo.name));
  assert.equal(ui.get('demo-count').textContent, '本图 13 / 共 13 场'); assert.equal(deaths(ui), 13);
  assert.equal(ui.get('global-error').textContent, ''); assert.equal(ui.get('upload-status').hidden, true);
  assert.equal(ui.requests.filter(([url, method]) => url === '/api/demos?mode=analysis' && method === 'POST').length, 12);
});

test('folder refresh only discovers demos and preserves the explicit subset, map, roster and display filters', async () => {
  const old = rosterDemo('old', 'de_nuke'), incoming = rosterDemo('incoming', 'de_ancient');
  const saved = { ids: ['old'], selectedDemos: ['old'], selectedTeams: ['alias:squad'], selectedPlayers: ['p1'], aliases: { alpha: 'Squad' }, map: 'de_nuke', side: '3', floor: 'lower', query: 'Alice', layers: ['deaths'], radius: 224, opacity: 85, scale: 'linear', utilityType: 'smoke', utilitySort: 'rare', landingDistance: 192, throwDistance: 96 };
  const ui = await page([old], { saved, libraryDemos: [old, incoming], mapInfo: { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' } });
  const before = ui.saved();
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 1 场'); assert.equal(ui.get('analysis-map').value, 'de_nuke');
  assert.equal(ui.get('analysis-floor').value, 'lower'); assert.equal(ui.get('analysis-side').value, '3');
  assert.deepEqual(selectedPlayerIds(ui), ['p1']); assert.equal(deaths(ui), 1);
  assert.equal(savedDemoChecked(ui, incoming.id), false); assert.deepEqual(visibleDemoNames(ui), [old.name]); assert.equal(demoCheckbox(ui, old.name).checked, true);
  assert.match(ui.get('library-status').textContent, /新增 1 场/); assert.equal(ui.get('refresh-library').disabled, false);
  for (const key of Object.keys(before).filter(key => key !== 'ids')) assert.deepEqual(ui.saved()[key], before[key], `${key} must survive folder refresh`);
  const calls = ui.analysisCalls();
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.analysisCalls(), calls, 'unchanged refresh needs no aggregation');
  assert.match(ui.get('library-status').textContent, /新增 0 场 · 2 场已在库中/);
  assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${old.id}/analysis`).length, 1);
  assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${incoming.id}/analysis`).length, 0);
  assert.equal(ui.parseBodies.length, 0);
});

test('default all applies only to added analyses and selecting one catalog demo never parses its neighbors', async () => {
  const old = dataset('old'), added = dataset('added'), untouched = dataset('untouched', 'de_nuke');
  const ui = await page([old], { libraryDemos: [old, added, untouched] });
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(deaths(ui), 1); assert.equal(ui.parseBodies.length, 0);
  await chooseLibrary(ui, ['added']);
  assert.equal(deaths(ui), 2); assert.equal(ui.saved().selectedDemos, null); assert.ok(demoCheckbox(ui, added.name).checked);
  assert.equal(ui.get('library-directory').textContent, 'F:\\viewer\\demo');
  assert.deepEqual(ui.parseBodies, [['added', { mode: 'analysis' }]]);
  assert.equal(ui.requests.filter(([url]) => url.includes('/untouched/')).length, 0);
  assert.deepEqual(ui.get('analysis-map').children.map(item => item.value), ['de_mirage']);
});

test('queued folder demos update when parsing finishes and do not repeatedly load cached summaries', async () => {
  const old = dataset('old'), queued = { ...dataset('pending'), afterParseStatus: 'queued', revision: 'first' };
  const ui = await page([old], { libraryDemos: [old, queued] });
  await clickAndSettle(ui, 'refresh-library');
  await chooseLibrary(ui, ['pending']);
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
  assert.deepEqual(ui.saved().selectedDemos, ['old']); assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 1 场');
  ui.failRefresh(''); await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 1 场'); assert.equal(deaths(ui), 1);
  assert.match(ui.get('library-status').textContent, /copying.dem 尚在写入/);
  assert.equal(ui.get('global-error').textContent, '');
});

test('a ready-to-ready revision change refreshes only that demo and replaces its old analysis', async () => {
  const old = { ...dataset('edited'), revision: 'v1' }, other = { ...dataset('untouched'), revision: 'v1' };
  const ui = await page([old, other]);
  const updated = { ...dataset('edited'), revision: 'v2' }; updated.series[0].cells[0][5] = 9;
  ui.setJob(updated); await clickAndSettle(ui, 'refresh-library');
  assert.equal(deaths(ui), 10); assert.equal(ui.get('demo-count').textContent, '本图 2 / 共 2 场');
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

test('match sources follow the selected map and preserve hidden-map checkbox choices and aliases', async () => {
  const demos = [dataset('anubis-one', 'de_anubis'), dataset('anubis-two', 'de_anubis'), dataset('ancient-one', 'de_ancient')];
  const ui = await page(demos, { saved: { map: 'de_anubis', selectedDemos: ['anubis-one', 'ancient-one'], aliases: { 'team-a': 'Saved squad' } } });
  assert.deepEqual(visibleDemoNames(ui), ['anubis-one.dem', 'anubis-two.dem']);
  assert.equal(ui.get('demo-count').textContent, '本图 2 / 共 3 场'); assert.match(ui.get('demo-scope').textContent, /de_anubis/);
  assert.equal(demoCheckbox(ui, 'anubis-two.dem').checked, false);
  await ui.change('analysis-map', 'de_ancient');
  assert.deepEqual(visibleDemoNames(ui), ['ancient-one.dem']); assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 3 场');
  assert.ok(demoCheckbox(ui, 'ancient-one.dem').checked);
  const ancient = demoCheckbox(ui, 'ancient-one.dem'); ancient.checked = false; await ancient.dispatch('change'); await settle();
  await ui.change('analysis-map', 'de_anubis');
  assert.ok(demoCheckbox(ui, 'anubis-one.dem').checked); assert.equal(demoCheckbox(ui, 'anubis-two.dem').checked, false);
  assert.deepEqual(ui.saved().selectedDemos, ['anubis-one']); assert.deepEqual(ui.saved().aliases, { 'team-a': 'Saved squad' });
  await ui.change('analysis-map', 'de_ancient'); assert.equal(demoCheckbox(ui, 'ancient-one.dem').checked, false);
  assert.deepEqual(ui.saved().ids.sort(), demos.map(d => d.id).sort(), 'filtering the list never removes hidden library records');
});

test('unknown-map tasks stay in a separate visible queue and move to their map after parsing', async () => {
  const current = dataset('anubis', 'de_anubis'), other = dataset('ancient', 'de_ancient');
  const queued = { ...dataset('zip-member', ''), jobStatus: 'queued' }, failed = { ...dataset('broken', ''), jobStatus: 'error', parseError: '损坏的 Demo' };
  const ui = await page([current, other, queued, failed], { saved: { map: 'de_anubis' } });
  assert.deepEqual(visibleDemoNames(ui), [current.name]); assert.deepEqual(visibleDemoNames(ui, 'unmapped-demo-list'), [queued.name, failed.name]);
  assert.equal(ui.get('unmapped-demos').hidden, false); assert.equal(ui.get('unmapped-demo-count').textContent, '待识别地图 · 2 场');
  assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 4 场');
  assert.ok(ui.get('unmapped-demo-list').querySelectorAll('small').some(node => node.textContent === '损坏的 Demo'));
  assert.ok(ui.get('unmapped-demo-list').querySelectorAll('input').every(input => input.disabled));
  ui.setJob(dataset('zip-member', 'de_ancient')); await ui.pollLibrary();
  assert.deepEqual(visibleDemoNames(ui), [current.name]); assert.deepEqual(visibleDemoNames(ui, 'unmapped-demo-list'), [failed.name]);
  assert.equal(ui.get('analysis-map').value, 'de_anubis', 'background completion does not switch the selected map');
  await ui.change('analysis-map', 'de_ancient'); assert.deepEqual(visibleDemoNames(ui), [other.name, queued.name]);
});

test('deleting the last match on a map renders the fallback map list without losing its matches', async () => {
  const current = dataset('ancient', 'de_ancient'), other = dataset('anubis', 'de_anubis');
  const ui = await page([current, other], { saved: { map: 'de_ancient' } });
  await ui.get('demo-list').querySelectorAll('button').find(button => button.className === 'demo-remove').click(); await settle();
  assert.equal(ui.get('analysis-map').value, 'de_anubis'); assert.deepEqual(visibleDemoNames(ui), [other.name]);
  assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 1 场'); assert.deepEqual(ui.saved().ids, [other.id]); assert.equal(deaths(ui), 1);
});

test('background ZIP scanning is polled before jobs exist but waits for a selection before parsing', async () => {
  const ui = await page([], { library: { scanning: true } });
  assert.equal(ui.get('refresh-library').disabled, true); assert.match(ui.get('library-status').textContent, /扫描.*ZIP/);
  const before = ui.requests.filter(([url]) => url === '/api/library').length;
  await ui.pollLibrary(); assert.equal(ui.requests.filter(([url]) => url === '/api/library').length, before + 1);
  ui.setLibraryFiles([dataset('from-archive', 'de_ancient')]); ui.setLibraryInfo({ scanning: false, result: { added: 1, unchanged: 0, queued: 0, errors: [] } });
  await ui.pollLibrary();
  assert.deepEqual(visibleDemoNames(ui), []); assert.equal(ui.parseBodies.length, 0); assert.equal(ui.get('analysis-map').value, '');
  await chooseLibrary(ui, ['from-archive']);
  assert.equal(ui.get('refresh-library').disabled, false); assert.deepEqual(visibleDemoNames(ui), ['from-archive.dem']);
  assert.equal(ui.get('analysis-map').value, 'de_ancient'); assert.equal(deaths(ui), 1); assert.match(ui.get('library-status').textContent, /新增 1 场/);
});

test('an async refresh with only duplicates or ZIP errors still finishes and shows its result', async () => {
  const original = dataset('original', 'de_anubis');
  const ui = await page([original], { asyncScan: true, saved: { map: 'de_anubis', selectedDemos: ['original'], side: '3' } });
  const before = ui.saved(); await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.get('refresh-library').disabled, true); assert.match(ui.get('library-status').textContent, /扫描/);
  await ui.pollLibrary(); assert.equal(ui.get('refresh-library').disabled, true, 'no queued jobs does not end an active ZIP scan');
  ui.setLibraryInfo({ scanning: false, result: { added: 0, unchanged: 2, queued: 0, errors: ['broken.zip：压缩包损坏'] } }); await ui.pollLibrary();
  assert.equal(ui.get('refresh-library').disabled, false); assert.match(ui.get('library-status').textContent, /新增 0 场 · 2 场已在库中/);
  assert.match(ui.get('library-status').textContent, /broken.zip：压缩包损坏/); assert.deepEqual(ui.saved(), before);
  const calls = ui.requests.length; await ui.pollLibrary(); assert.equal(ui.requests.length, calls, 'idle completed scans stop polling');
});

test('a failed job whose map has no ready dataset remains accessible outside the current-map list', async () => {
  const known = dataset('anubis', 'de_anubis'), failed = { ...dataset('failed-ancient', 'de_ancient'), jobStatus: 'error', parseError: '摘要写入失败' };
  const ui = await page([known, failed], { saved: { map: 'de_anubis' } });
  assert.deepEqual(visibleDemoNames(ui), [known.name]); assert.deepEqual(visibleDemoNames(ui, 'unmapped-demo-list'), [failed.name]);
  assert.equal(ui.get('unmapped-demos').hidden, false); assert.equal(ui.get('unmapped-demo-count').textContent, '待完成分析 · 1 场');
  assert.ok(ui.get('unmapped-demo-list').querySelectorAll('small').some(node => node.textContent === 'de_ancient · 摘要写入失败'));
  await ui.get('unmapped-demo-list').querySelectorAll('button').find(button => button.className === 'demo-remove').click(); await settle();
  assert.deepEqual(ui.saved().ids, [known.id]); assert.equal(ui.get('unmapped-demos').hidden, true);
});

async function searchLibrary(ui, query) {
  ui.get('analysis-library-search').value = query;
  await ui.get('analysis-library-search').dispatch('input'); await settle();
}

test('library search matches nested ZIP paths, keeps hidden choices, and batches only selected unique recordings', async () => {
  const first = { ...dataset('quarter'), sources: [{ path: '2026/赛事/quarter.zip', member: 'matches/first.dem', kind: 'zip', available: true }], sourceCount: 3 };
  const second = { ...dataset('final', 'de_nuke'), sources: [{ path: '2026/总决赛/final.dem', kind: 'dem', available: true }] };
  const unused = dataset('unused', 'de_ancient'), ui = await page([], { libraryDemos: [first, second, unused] });
  assert.equal(ui.hasVisibleHeat(), false); assert.equal(ui.parseBodies.length, 0);
  await clickAndSettle(ui, 'open-analysis-library');
  assert.ok(ui.get('analysis-library-list').querySelectorAll('small').some(item => item.textContent.includes('3 个来源已去重')));
  assert.ok(ui.get('analysis-library-list').querySelectorAll('small').some(item => item.textContent.includes('地图待解析')));
  assert.equal(ui.get('analysis-map').value, '');
  await searchLibrary(ui, '赛事/quarter.zip'); await clickAndSettle(ui, 'analysis-library-all');
  await searchLibrary(ui, '总决赛'); await clickAndSettle(ui, 'analysis-library-all');
  assert.match(ui.get('analysis-library-count').textContent, /显示 1 \/ 3 场 · 已选 2 场/);
  await searchLibrary(ui, 'matches/first.dem'); assert.equal(catalogCheckbox(ui, first.id).checked, true);
  await clickAndSettle(ui, 'analysis-library-add');
  assert.deepEqual(ui.parseBodies.map(([id]) => id), ['quarter', 'final']);
  assert.equal(ui.requests.filter(([url]) => url.includes('/unused/')).length, 0);
  assert.equal(ui.get('analysis-library-dialog').hidden, true);
  assert.equal(ui.get('demo-count').textContent, '本图 1 / 共 2 场'); assert.equal(deaths(ui), 1);
  await ui.change('analysis-map', 'de_nuke'); assert.deepEqual(visibleDemoNames(ui), [second.name]);
});

test('source folder classification uses catalog paths and leaves the heatmap and all selections unchanged', async () => {
  const shared = folderDemo('shared', ['赛事/A/shared.dem', { path: '练习/B/bundle.zip', member: 'inside/match.dem', kind: 'zip', available: true }]);
  const root = folderDemo('root', ['root.dem']), missing = folderDemo('cache-only', [{ path: 'gone/old.dem', available: false }]);
  const other = folderDemo('other-map', ['赛事/A/other.dem'], 'de_nuke');
  const ui = await page([shared, root, missing, other], { saved: { map: 'de_mirage', selectedDemos: ['shared', 'other-map'], selectedTeams: ['team-a'], selectedPlayers: ['76561198000000001'], side: '3' } });
  const initial = viewIndependentSettings(ui.saved()), calls = ui.analysisCalls(), total = deaths(ui);
  assert.ok(html.indexOf('src="/replay-library.js"') < html.indexOf('src="/analysis.js"'), 'shared helper loads before the page');
  await ui.change('demo-view-mode', 'folders');
  assert.deepEqual(visibleDemoNames(ui).sort(), ['shared.dem', 'shared.dem', 'root.dem', 'cache-only.dem'].sort());
  assert.deepEqual(ui.get('demo-list').children.map(group => group.dataset.folderKey).sort(), ['root', 'path:赛事/A', 'path:练习/B', 'unavailable'].sort());
  assert.equal(ui.get('demo-folder-field').hidden, false);
  assert.ok(ui.get('demo-folder').children.every(option => !option.value.includes('inside')), 'ZIP member directories are not physical folder categories');
  await ui.change('demo-folder', 'path:赛事/A'); assert.deepEqual(visibleDemoNames(ui), ['shared.dem']);
  ui.get('demo-search').value = 'inside/match.dem'; await ui.get('demo-search').dispatch('input'); await settle();
  assert.deepEqual(visibleDemoNames(ui), ['shared.dem'], 'search and physical folder are intersected on the same canonical record');
  ui.get('demo-search').value = 'root.dem'; await ui.get('demo-search').dispatch('input'); await settle();
  assert.deepEqual(visibleDemoNames(ui), []);
  assert.deepEqual(viewIndependentSettings(ui.saved()), initial); assert.equal(ui.analysisCalls(), calls); assert.equal(deaths(ui), total);
  await ui.change('demo-view-mode', 'all'); assert.deepEqual(visibleDemoNames(ui), ['root.dem']);
  assert.equal(ui.get('demo-folder-field').hidden, true, 'flat mode ignores its remembered folder filter');
  ui.get('demo-search').value = ''; await ui.get('demo-search').dispatch('input'); await settle();
  assert.deepEqual(visibleDemoNames(ui), ['shared.dem', 'root.dem', 'cache-only.dem']);
  assert.deepEqual(viewIndependentSettings(ui.saved()), initial);
});

test('source bulk selection acts once per visible ID and leaves hidden map, folder and roster choices intact', async () => {
  const shared = folderDemo('shared', ['A/shared.dem', 'B/shared.dem']), one = folderDemo('one', ['B/one.dem']);
  const hidden = folderDemo('hidden', ['A/hidden.dem'], 'de_nuke');
  const ui = await page([shared, one, hidden], { saved: { map: 'de_mirage', selectedTeams: ['team-a'], selectedPlayers: ['76561198000000001'] } });
  await ui.change('demo-view-mode', 'folders');
  await clickAndSettle(ui, 'demos-invert');
  assert.deepEqual(ui.saved().selectedDemos, ['hidden'], 'shared record is not toggled twice because it appears in two folders');
  assert.ok(ui.get('demo-list').querySelectorAll('input').every(input => !input.checked));
  assert.deepEqual(ui.saved().selectedTeams, ['team-a']); assert.deepEqual(ui.saved().selectedPlayers, ['76561198000000001']);
  await clickAndSettle(ui, 'demos-all'); assert.deepEqual(ui.saved().selectedDemos.sort(), ['hidden', 'one', 'shared']); assert.equal(deaths(ui), 2);
  await ui.change('demo-folder', 'path:A'); await clickAndSettle(ui, 'demos-invert');
  assert.deepEqual(ui.saved().selectedDemos.sort(), ['hidden', 'one']); assert.equal(deaths(ui), 1);
  await ui.change('demo-folder', 'all');
  const sharedRows = ui.get('demo-list').querySelectorAll('input').filter(input => input.dataset.demoId === 'shared');
  assert.equal(sharedRows.length, 2); assert.ok(sharedRows.every(input => !input.checked));
  sharedRows[0].checked = true; await sharedRows[0].dispatch('change'); await settle();
  assert.ok(ui.get('demo-list').querySelectorAll('input').filter(input => input.dataset.demoId === 'shared').every(input => input.checked), 'individual selection updates every visible copy');
  ui.get('demo-search').value = 'one.dem'; await ui.get('demo-search').dispatch('input'); await settle();
  await clickAndSettle(ui, 'demos-none'); assert.deepEqual(ui.saved().selectedDemos.sort(), ['hidden', 'shared']);
  assert.equal(deaths(ui), 1); assert.equal(ui.parseBodies.length, 0);
});

test('library map, search and folder views intersect while selection and per-ID add requests remain unique', async () => {
  const shared = { ...folderDemo('shared', ['A/shared.dem', 'B/shared.dem']), catalogMap: 'de_mirage' };
  const second = { ...folderDemo('second', ['B/second.dem'], 'de_nuke'), catalogMap: 'de_nuke' };
  const unknown = folderDemo('unknown', ['root.dem']);
  const ui = await page([], { libraryDemos: [shared, second, unknown] });
  await clickAndSettle(ui, 'open-analysis-library'); await ui.change('analysis-library-view-mode', 'folders');
  assert.equal(ui.get('analysis-library-list').querySelectorAll('input').filter(input => input.dataset.demoId === 'shared').length, 2);
  assert.match(ui.get('analysis-library-count').textContent, /显示 3 \/ 3 场/);
  await ui.change('analysis-library-folder', 'path:A'); await clickAndSettle(ui, 'analysis-library-all');
  assert.match(ui.get('analysis-library-count').textContent, /已选 1 场/);
  await ui.change('analysis-library-folder', 'all'); await clickAndSettle(ui, 'analysis-library-invert');
  assert.ok(ui.get('analysis-library-list').querySelectorAll('input').filter(input => input.dataset.demoId === 'shared').every(input => !input.checked));
  assert.equal(catalogCheckbox(ui, 'second').checked, true); assert.equal(catalogCheckbox(ui, 'unknown').checked, true);
  await ui.change('analysis-library-map', 'de_mirage'); await ui.change('analysis-library-folder', 'path:B');
  await searchLibrary(ui, 'shared'); assert.equal(ui.get('analysis-library-list').querySelectorAll('input').length, 1);
  await clickAndSettle(ui, 'analysis-library-all'); assert.match(ui.get('analysis-library-count').textContent, /已选 3 场/);
  await clickAndSettle(ui, 'analysis-library-clear'); assert.match(ui.get('analysis-library-count').textContent, /已选 2 场/, 'clearing visible results retains choices hidden by map or folder');
  await ui.change('analysis-library-map', 'unknown'); await ui.change('analysis-library-folder', 'all'); await searchLibrary(ui, '');
  assert.equal(catalogCheckbox(ui, 'unknown').checked, true); await clickAndSettle(ui, 'analysis-library-clear');
  await ui.change('analysis-library-map', 'de_mirage'); await clickAndSettle(ui, 'analysis-library-all');
  await ui.change('analysis-library-view-mode', 'all'); await ui.change('analysis-library-map', 'all');
  assert.equal(ui.get('analysis-library-list').querySelectorAll('input').length, 3, 'flat view shows each canonical recording once');
  await clickAndSettle(ui, 'analysis-library-add');
  assert.deepEqual(ui.parseBodies.map(([id]) => id).sort(), ['second', 'shared']);
  assert.equal(ui.requests.some(([url]) => url.includes('/unknown/')), false);
});

test('folder view preferences restore independently without changing existing analysis groups or selections', async () => {
  const first = folderDemo('first', ['中文/比赛/first.dem']), second = folderDemo('second', ['训练/second.dem'], 'de_nuke');
  const ui = await page([first, second], { saved: { map: 'de_mirage', selectedDemos: ['first', 'second'], selectedTeams: ['team-a'], selectedPlayers: ['76561198000000001'], aliases: { saved: 'My squad' }, side: '3' } });
  const initial = viewIndependentSettings(ui.saved());
  await ui.change('demo-view-mode', 'folders'); await ui.change('demo-folder', 'path:中文/比赛');
  ui.get('demo-search').value = 'first'; await ui.get('demo-search').dispatch('input'); await settle();
  await ui.change('analysis-library-view-mode', 'folders'); await ui.change('analysis-library-folder', 'path:训练'); await ui.change('analysis-library-map', 'de_nuke'); await searchLibrary(ui, 'second');
  const saved = ui.saved(), restored = await page([first, second], { saved });
  assert.deepEqual(restored.saved().sourceView, { mode: 'folders', folder: 'path:中文/比赛', query: 'first' });
  assert.deepEqual(restored.saved().libraryView, { mode: 'folders', folder: 'path:训练', query: 'second', map: 'de_nuke' });
  assert.deepEqual(viewIndependentSettings(restored.saved()), initial);
  assert.deepEqual(visibleDemoNames(restored), ['first.dem']);
  assert.deepEqual(restored.get('analysis-library-list').querySelectorAll('input').map(input => input.dataset.demoId), ['second']);
  assert.equal(restored.parseBodies.length, 0);
});

test('refresh updates folder metadata for cached IDs without reparsing or losing hidden selections', async () => {
  const original = folderDemo('same-id', ['old/sub/match.zip']);
  const ui = await page([original], { saved: { selectedDemos: ['same-id'], selectedTeams: ['team-a'], selectedPlayers: ['76561198000000001'], aliases: { saved: 'Saved group' } } });
  await ui.change('demo-view-mode', 'folders'); await ui.change('demo-folder', 'path:old/sub');
  await clickAndSettle(ui, 'open-analysis-library'); await ui.change('analysis-library-view-mode', 'folders'); await ui.change('analysis-library-folder', 'path:old/sub'); await clickAndSettle(ui, 'analysis-library-all');
  const prior = viewIndependentSettings(ui.saved()), count = deaths(ui), summaryReads = ui.requests.filter(([url]) => url === '/api/demos/same-id/analysis').length;
  ui.setJob(folderDemo('same-id', [{ path: 'new/中文/match.zip', member: 'not/a/folder/demo.dem', kind: 'zip', available: true }]));
  await clickAndSettle(ui, 'refresh-library');
  assert.deepEqual(visibleDemoNames(ui), []); assert.equal(ui.get('analysis-library-list').querySelectorAll('input').length, 0);
  assert.ok(ui.get('demo-folder').children.some(option => option.value === 'path:new/中文'));
  assert.ok(ui.get('demo-folder').children.some(option => option.value === 'path:old/sub' && option.textContent.includes('暂无录像')));
  assert.match(ui.get('analysis-library-count').textContent, /已选 1 场/);
  assert.equal(deaths(ui), count); assert.deepEqual(viewIndependentSettings(ui.saved()), prior);
  await ui.change('demo-folder', 'path:new/中文'); await ui.change('analysis-library-folder', 'path:new/中文');
  assert.equal(demoCheckbox(ui, original.name).checked, true); assert.equal(catalogCheckbox(ui, original.id).checked, true);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/same-id/analysis').length, summaryReads); assert.equal(ui.parseBodies.length, 0);
});

test('ready playback caches are absent from analysis until chosen and are promoted without queuing a reparse', async () => {
  const old = dataset('old'), cached = { ...dataset('played'), analysis: false, available: false };
  const ui = await page([old, cached]);
  assert.equal(deaths(ui), 1); assert.equal(ui.requests.filter(([url]) => url === '/api/demos/played/analysis').length, 0);
  await chooseLibrary(ui, ['played'], false);
  assert.equal(catalogCheckbox(ui, 'played').disabled, false, 'a missing source does not prevent using its ready cache');
  assert.ok(ui.get('analysis-library-list').querySelectorAll('small').some(item => item.textContent.includes('可直接加入')));
  await clickAndSettle(ui, 'analysis-library-add');
  assert.equal(deaths(ui), 2); assert.deepEqual(ui.parseBodies, [['played', { mode: 'analysis' }]]);
  assert.equal(ui.get('library-progress').textContent, '');
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(deaths(ui), 2); assert.equal(ui.requests.filter(([url]) => url === '/api/demos/played/analysis').length, 1);
});

test('a playback-to-analysis URL explicitly promotes only the linked cache before loading its summary', async () => {
  const linked = { ...dataset('linked', 'de_nuke'), analysis: false }, other = { ...dataset('other', 'de_ancient'), analysis: false };
  const ui = await page([dataset('existing'), linked, other], { href: 'http://127.0.0.1:8766/analysis.html?demo=linked', saved: { map: 'de_mirage', selectedDemos: ['existing'] } });
  assert.deepEqual(ui.parseBodies, [['linked', { mode: 'analysis' }]]);
  assert.deepEqual(visibleDemoNames(ui), ['linked.dem']); assert.equal(ui.get('analysis-map').value, 'de_nuke');
  const parseIndex = ui.requests.findIndex(([url]) => url === '/api/library/demos/linked/parse');
  const summaryIndex = ui.requests.findIndex(([url]) => url === '/api/demos/linked/analysis');
  assert.ok(parseIndex >= 0 && summaryIndex > parseIndex);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/other/analysis').length, 0);
  await clickAndSettle(ui, 'refresh-library');
  assert.deepEqual(visibleDemoNames(ui), ['linked.dem']); assert.equal(deaths(ui), 1);
});

test('adding a previously excluded ready analysis checks it without downloading another summary', async () => {
  const ui = await page([dataset('first'), dataset('second')], { saved: { selectedDemos: ['first'] } });
  assert.equal(deaths(ui), 1);
  await chooseLibrary(ui, ['second']);
  assert.equal(deaths(ui), 2); assert.deepEqual(ui.saved().selectedDemos, ['first', 'second']);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/second/analysis').length, 1);
});

test('a repeated add click while submission is pending cannot enqueue the same recording twice', async () => {
  let release; const parseGate = new Promise(resolve => { release = resolve; });
  const ui = await page([], { libraryDemos: [dataset('chosen')], parseGate });
  await chooseLibrary(ui, ['chosen'], false);
  const adding = ui.get('analysis-library-add').click(); await settle();
  assert.equal(ui.get('analysis-library-add').disabled, true);
  await ui.get('analysis-library-add').click(); await settle();
  assert.equal(ui.parseBodies.length, 1);
  release(); await adding; await settle();
  assert.equal(deaths(ui), 1); assert.equal(ui.parseBodies.length, 1);
  await chooseLibrary(ui, ['chosen']);
  assert.equal(deaths(ui), 1, 'choosing an existing analysis again does not duplicate its heatmap');
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/chosen/analysis').length, 1);
});

test('one failed catalog selection keeps only that choice for retry while the successful analysis remains usable', async () => {
  const first = dataset('good'), broken = { ...dataset('broken'), requestError: '源文件正在变动，请刷新' };
  const ui = await page([], { libraryDemos: [first, broken] });
  await chooseLibrary(ui, ['good', 'broken']);
  assert.equal(deaths(ui), 1); assert.equal(ui.get('analysis-library-dialog').hidden, false);
  assert.equal(catalogCheckbox(ui, 'good').checked, false); assert.equal(catalogCheckbox(ui, 'broken').checked, true);
  assert.match(ui.get('analysis-library-error').textContent, /已加入 1 场.*源文件正在变动/);
  ui.setLibraryFiles([first, { ...broken, requestError: '' }]);
  await clickAndSettle(ui, 'analysis-library-refresh'); await clickAndSettle(ui, 'analysis-library-add');
  assert.equal(deaths(ui), 2); assert.deepEqual(ui.parseBodies.map(([id]) => id), ['good', 'broken', 'broken']);
  assert.equal(ui.get('analysis-library-dialog').hidden, true);
});

test('missing unparsed sources cannot be selected and clearing library choices never clears analysis filters', async () => {
  const ui = await page([dataset('old')], { libraryDemos: [{ ...dataset('missing'), available: false }], saved: { selectedDemos: ['old'], side: '3' } });
  const before = ui.saved(); await clickAndSettle(ui, 'open-analysis-library');
  assert.equal(catalogCheckbox(ui, 'missing').disabled, true);
  await clickAndSettle(ui, 'analysis-library-all');
  assert.equal(catalogCheckbox(ui, 'missing').checked, false); assert.equal(catalogCheckbox(ui, 'old').checked, true);
  await clickAndSettle(ui, 'analysis-library-clear');
  assert.equal(ui.get('analysis-library-add').disabled, true); assert.deepEqual(ui.saved(), before);
  await clickAndSettle(ui, 'analysis-library-close'); assert.equal(ui.parseBodies.length, 0);
});

test('a modified source drops its stale heatmap but retains map, floor, grouping and selection until explicitly reparsed', async () => {
  const old = { ...rosterDemo('edited', 'de_nuke'), revision: 'v1' };
  const saved = { map: 'de_nuke', floor: 'lower', selectedDemos: ['edited'], selectedPlayers: ['p1'], selectedTeams: ['alias:squad'], aliases: { alpha: 'Squad' }, query: 'Alice' };
  const options = { saved, mapInfo: { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' } };
  const ui = await page([old], options);
  ui.setJob({ ...old, revision: 'v2', jobStatus: 'discovered' });
  await clickAndSettle(ui, 'refresh-library');
  assert.equal(ui.hasVisibleHeat(), false); assert.equal(ui.parseBodies.length, 0);
  for (const [key, value] of Object.entries(saved)) assert.deepEqual(ui.saved()[key], value, key);
  const requestCount = ui.requests.length; await ui.pollLibrary(); assert.equal(ui.requests.length, requestCount, 'a discovered source does not keep parser polling alive');
  await chooseLibrary(ui, ['edited']);
  assert.equal(ui.hasVisibleHeat(), true); assert.equal(ui.get('analysis-floor').value, 'lower');
  assert.deepEqual(ui.saved().selectedPlayers, ['p1']); assert.deepEqual(ui.saved().aliases, { alpha: 'Squad' });
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/edited/analysis').length, 2);
  const restored = await page([{ ...old, revision: 'v2', jobStatus: 'discovered' }], options);
  assert.deepEqual(restored.saved().selectedDemos, ['edited'], 'startup pruning must retain a known source absent from /api/analyses');
  assert.equal(restored.hasVisibleHeat(), false); assert.equal(restored.parseBodies.length, 0);
});

test('removing an analysis keeps its catalog cache available and can add it back without reparsing', async () => {
  const ui = await page([dataset('shared')]);
  await ui.get('demo-list').querySelectorAll('button').find(button => button.className === 'demo-remove').click(); await settle();
  assert.equal(ui.hasVisibleHeat(), false);
  await clickAndSettle(ui, 'refresh-library');
  assert.deepEqual(visibleDemoNames(ui), []);
  await clickAndSettle(ui, 'open-analysis-library');
  assert.equal(catalogCheckbox(ui, 'shared').disabled, false);
  assert.ok(ui.get('analysis-library-list').querySelectorAll('small').some(item => item.textContent.includes('已解析缓存 · 可直接加入')));
  assert.equal(ui.requests.some(([url, method]) => url === '/api/demos/shared' && method === 'DELETE'), false);
  await chooseLibrary(ui, ['shared']);
  assert.equal(deaths(ui), 1); assert.equal(ui.get('library-progress').textContent, '');
});

test('consuming a playback link preserves other URL parameters and reload retains subsequently selected filters', async () => {
  const demo = rosterDemo('played', 'de_nuke'), mapInfo = { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' };
  const ui = await page([demo], { href: 'http://127.0.0.1:8766/analysis.html?keep=yes&demo=played&t=42#heatmap', mapInfo });
  assert.equal(ui.href(), 'http://127.0.0.1:8766/analysis.html?keep=yes&t=42#heatmap');
  await clickAndSettle(ui, 'teams-none'); await clickAndSettle(ui, 'players-none');
  await ui.change('analysis-floor', 'lower'); await searchPlayers(ui, 'Alice');
  const saved = ui.saved(), reloaded = await page([demo], { saved, href: ui.href(), mapInfo });
  assert.deepEqual(reloaded.saved().selectedTeams, []); assert.deepEqual(reloaded.saved().selectedPlayers, []);
  assert.equal(reloaded.saved().floor, 'lower'); assert.equal(reloaded.saved().query, 'Alice');
  assert.equal(reloaded.href(), ui.href()); assert.equal(reloaded.parseBodies.length, 0);
});

test('stopping a shared upload wait leaves the library job and its analysis membership intact', async () => {
  const demo = { ...dataset('shared'), shared: true, jobStatus: 'queued', blockStatus: true };
  const ui = await page([], { uploads: [demo] });
  const importing = ui.upload(demo.name); await settle();
  assert.equal(ui.get('upload-status').hidden, false);
  await clickAndSettle(ui, 'cancel-upload'); await importing;
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
  assert.deepEqual(ui.saved().ids, ['shared']); assert.equal(ui.get('upload-status').hidden, true);
  assert.match(ui.get('global-error').textContent, /共享录像的后台任务与已有分析仍保留/);
  ui.setJob({ ...demo, jobStatus: 'ready', blockStatus: false }); await ui.pollLibrary();
  assert.equal(deaths(ui), 1); assert.deepEqual(visibleDemoNames(ui), [demo.name]);
});

test('a shared upload parser error retains the retryable catalog record without deleting a shared cache', async () => {
  const demo = { ...dataset('broken-shared'), shared: true, jobStatus: 'error', parseError: '录像读取失败' };
  const ui = await page([], { uploads: [demo] });
  await ui.upload(demo.name);
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
  assert.deepEqual(ui.saved().ids, ['broken-shared']);
  assert.match(ui.get('global-error').textContent, /录像读取失败/);
  await clickAndSettle(ui, 'open-analysis-library');
  assert.equal(catalogCheckbox(ui, 'broken-shared').disabled, false);
});

test('bulk reparse includes every imported ready match across maps but excludes discovered and playback-only records', async () => {
  const chosen = { ...rosterDemo('chosen', 'de_nuke'), revision: 'v1' }, hidden = { ...rosterDemo('hidden', 'de_ancient'), revision: 'v1' };
  const playback = { ...dataset('playback'), analysis: false }, discovered = { ...dataset('interrupted'), jobStatus: 'discovered' }, failed = { ...dataset('failed'), jobStatus: 'error', parseError: '首次解析失败' };
  const saved = { selectedDemos: ['chosen'], selectedTeams: ['alias:squad'], selectedPlayers: ['p1'], aliases: { alpha: 'Squad' }, map: 'de_nuke', floor: 'lower', side: '3', query: 'Alice', layers: ['deaths'], scale: 'linear' };
  const ui = await page([chosen, hidden, playback, discovered, failed], { saved, libraryDemos: [dataset('unselected')], mapInfo: { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' } });
  const before = ui.saved(), calls = ui.requests.filter(([url]) => url.endsWith('/analysis')).length;
  await clickAndSettle(ui, 'reparse-analyses');
  assert.deepEqual(ui.reparseBodies, [{ ids: ['chosen', 'hidden'] }]);
  assert.equal(deaths(ui), 1); assert.deepEqual(ui.saved(), before);
  assert.equal(ui.requests.filter(([url]) => url.endsWith('/analysis')).length, calls, 'queued replacement does not fetch or discard the current summary');
  assert.equal(ui.get('reparse-analyses').disabled, true);
  assert.match(ui.get('analysis-reparse-summary').textContent, /等待 2/);
  assert.equal(ui.get('analysis-reparse-status').hidden, false);
  assert.equal(ui.parseBodies.length, 0);
});

test('successful replacement reloads only changed revisions and preserves player groups, filters, map, floor, zoom and pan', async () => {
  const original = { ...rosterDemo('selected', 'de_nuke'), revision: 'v1' }, other = { ...rosterDemo('other', 'de_ancient'), revision: 'v1' };
  const saved = { selectedDemos: ['selected'], selectedTeams: ['alias:squad'], selectedPlayers: ['p1'], aliases: { alpha: 'Squad' }, map: 'de_nuke', floor: 'lower', side: '3', query: 'Alice', layers: ['deaths'], radius: 224, opacity: 75, scale: 'linear' };
  const ui = await page([original, other], { saved, mapInfo: { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' } });
  await ui.main.dispatch('keydown', { key: '+' });
  await ui.main.dispatch('pointerdown', { pointerId: 1, clientX: 200, clientY: 200 });
  await ui.main.dispatch('pointermove', { pointerId: 1, clientX: 237, clientY: 219 });
  await ui.main.dispatch('pointerup', { pointerId: 1 });
  const before = ui.saved(), projection = ui.main.context.draws[0].slice(1), zoom = ui.get('zoom-value').textContent;
  await clickAndSettle(ui, 'reparse-analyses');
  ui.setJob({ ...original, reparse: { status: 'parsing', progress: .45, message: '提取精确事件' } }); await ui.pollLibrary();
  assert.equal(deaths(ui), 1); assert.ok(ui.get('analysis-reparse-details').children.some(item => /45%/.test(item.textContent)));
  const updated = { ...rosterDemo('selected', 'de_nuke'), revision: 'v2', reparse: { status: 'ready', progress: 1, revision: 'v2' } }; updated.series[0].cells[0][5] = 9;
  ui.setJob(updated); ui.setJob({ ...other, revision: 'v2', reparse: { status: 'ready', progress: 1, revision: 'v2' } }); await ui.pollLibrary();
  assert.equal(deaths(ui), 9); assert.deepEqual(ui.saved(), before);
  assert.equal(ui.get('analysis-map').value, 'de_nuke'); assert.equal(ui.get('analysis-floor').value, 'lower');
  assert.equal(ui.get('zoom-value').textContent, zoom); assert.deepEqual(ui.main.context.draws[0].slice(1), projection);
  assert.equal(ui.get('reparse-analyses').disabled, false); assert.match(ui.get('analysis-reparse-summary').textContent, /完成 2/);
  for (const id of ['selected', 'other']) assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${id}/analysis`).length, 2);
  const count = ui.requests.length; await ui.pollLibrary(); assert.equal(ui.requests.length, count, 'a finished replacement does not poll indefinitely');
});

test('parser failure and missing source retain old heatmaps and offer a retry limited to failed or skipped IDs', async () => {
  const bad = { ...dataset('bad'), revision: 'old' }, missing = { ...dataset('missing'), revision: 'old', reparseSkip: '原始录像不可用；请放回 demo 文件夹并刷新' }, good = { ...dataset('good'), revision: 'old' };
  const ui = await page([bad, missing, good]); const before = ui.saved();
  await clickAndSettle(ui, 'reparse-analyses');
  ui.setJob({ ...bad, reparse: { status: 'error', error: '完整录像校验失败', revision: 'failed-attempt' } });
  ui.setJob({ ...good, revision: 'new', reparse: { status: 'ready', revision: 'new' } }); await ui.pollLibrary();
  assert.equal(deaths(ui), 3); assert.deepEqual(ui.saved(), before);
  assert.ok(ui.get('analysis-reparse-details').children.some(item => /完整录像校验失败.*旧结果仍保留/.test(item.textContent)));
  assert.ok(ui.get('analysis-reparse-details').children.some(item => /原始录像不可用.*旧结果仍保留/.test(item.textContent)));
  assert.equal(ui.get('retry-reparse-failures').hidden, false); assert.equal(ui.get('retry-reparse-failures').disabled, false);
  for (const id of ['bad', 'missing']) assert.equal(ui.requests.filter(([url]) => url === `/api/demos/${id}/analysis`).length, 1);
  ui.setJob({ ...missing, reparseSkip: '' }); await clickAndSettle(ui, 'retry-reparse-failures');
  assert.deepEqual([...ui.reparseBodies[1].ids].sort(), ['bad', 'missing']);
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
});

test('reparse progress and failure are recovered from server metadata after page reload', async () => {
  const ongoing = { ...dataset('ongoing'), revision: 'old', reparse: { status: 'parsing', progress: .3, message: '后台重解析' } };
  const failed = { ...dataset('failed'), revision: 'old', reparse: { status: 'error', error: '上次解析已中断' } };
  const ui = await page([ongoing, failed], { saved: { selectedDemos: ['ongoing'] } });
  assert.equal(deaths(ui), 1); assert.equal(ui.get('reparse-analyses').disabled, true); assert.equal(ui.reparseBodies.length, 0);
  assert.match(ui.get('analysis-reparse-summary').textContent, /进行 1/); assert.ok(ui.get('analysis-reparse-details').children.some(item => /上次解析已中断/.test(item.textContent)));
  const calls = ui.requests.filter(([url]) => url === '/api/analyses').length; await ui.pollLibrary();
  assert.equal(ui.requests.filter(([url]) => url === '/api/analyses').length, calls + 1);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/ongoing/analysis').length, 1);
});

test('duplicate reparse clicks are ignored while submitting and while server replacements are active', async () => {
  let release; const reparseGate = new Promise(resolve => { release = resolve; });
  const ui = await page([dataset('one')], { reparseGate });
  const pending = ui.get('reparse-analyses').click(); await settle();
  await ui.get('reparse-analyses').click(); assert.equal(ui.reparseBodies.length, 1);
  release(); await pending; await settle();
  await ui.get('reparse-analyses').click(); assert.equal(ui.reparseBodies.length, 1);
  assert.equal(deaths(ui), 1);
});

test('a failed refresh of a newly published summary preserves the previous data until replacement succeeds', async () => {
  const old = { ...dataset('one'), revision: 'old' }, ui = await page([old]);
  await clickAndSettle(ui, 'reparse-analyses');
  const updated = { ...dataset('one'), revision: 'new', reparse: { status: 'ready', revision: 'new' } }; updated.series[0].cells[0][5] = 8;
  ui.setJob(updated); ui.failSummary('one', '读取新缓存暂时失败'); await ui.pollLibrary();
  assert.equal(deaths(ui), 1); assert.ok(ui.hasVisibleHeat());
  assert.ok(ui.get('demo-list').querySelectorAll('small').some(item => /暂用旧结果/.test(item.textContent)));
  ui.failSummary('one', ''); await ui.pollLibrary();
  assert.equal(deaths(ui), 8); assert.equal(ui.get('demo-list').querySelectorAll('small').some(item => /暂用旧结果/.test(item.textContent)), false);
});

test('a rejected bulk request leaves cached data and explicit empty selections untouched and can be retried', async () => {
  const ui = await page([dataset('one')], { saved: { selectedDemos: [], selectedTeams: [], selectedPlayers: [] } }); const before = ui.saved();
  ui.failReparseRequest('服务暂不可用'); await clickAndSettle(ui, 'reparse-analyses');
  assert.equal(deaths(ui), 0); assert.deepEqual(ui.saved(), before); assert.match(ui.get('analysis-reparse-summary').textContent, /服务暂不可用.*旧缓存与筛选仍保留/);
  assert.equal(ui.get('reparse-analyses').disabled, false);
  ui.failReparseRequest(''); await clickAndSettle(ui, 'reparse-analyses'); assert.equal(ui.reparseBodies.length, 2); assert.deepEqual(ui.saved().selectedDemos, []);
});

function utilityDemo(id = 'timed', map = 'de_mirage') {
  const demo = dataset(id, map);
  demo.utilities = [0, 5, 5.5, 30, 72, null, undefined].map((elapsed, index) => ({
    id: `grenade-${index}`, type: 'smoke', owner: 'Player', playerId: demo.players[0].id,
    teamId: 'team-a', side: 3, round: 2, time: 400 + (elapsed ?? index),
    ...(elapsed === undefined ? {} : { roundElapsed: elapsed, timeSource: elapsed === null ? 'unknown' : 'freeze_end' }),
    throwObserved: true, detonated: true, start: { x: 100, y: 500, z: 0 }, end: { x: 300, y: 650, z: 0 },
  }));
  return demo;
}
function utilityCountButton(ui, key) { return ui.get('utility-time-counts').children.find(button => button.dataset.timeBucket === key); }
function utilityCounts(ui) { return Object.fromEntries(ui.get('utility-time-counts').children.map(button => [button.dataset.timeBucket, Number(button.dataset.count)])); }
function textWithin(element) { return [element.textContent, ...element.children.map(textWithin)].join(' '); }
function csvRows(text) { return text.replace(/^\ufeff/, '').split('\r\n').map(row => row.slice(1, -1).split('","').map(cell => cell.replace(/""/g, '"'))); }

test('utility time options and clickable distribution filter groups without altering movement, combat or death heatmaps', async () => {
  const ui = await page([utilityDemo()]);
  assert.deepEqual(ui.get('analysis-utility-time').children.map(option => option.value), ['all', '0-5', '5-20', '20-50', '50+', 'unknown']);
  const counts = { all: 7, '0-5': 2, '5-20': 1, '20-50': 1, '50+': 1, unknown: 2 };
  assert.deepEqual(utilityCounts(ui), counts);
  const pixels = ui.renderedHeat().imageData.data.slice(), metrics = ['movement', 'engagements', 'deaths'].map(key => ui.get(`metric-${key}`).textContent);
  const selectionSummary = ui.get('selection-summary').textContent;
  await utilityCountButton(ui, '5-20').click(); await settle();
  assert.equal(ui.get('analysis-utility-time').value, '5-20'); assert.equal(ui.saved().utilityTime, '5-20');
  assert.equal(ui.get('metric-utilities').textContent, '1'); assert.equal(ui.get('utility-group-count').textContent, '1 类落点 · 1 次');
  await ui.get('utility-groups').children[0].click(); await settle();
  assert.match(textWithin(ui.get('utility-detail')), /开打后 5\.50 秒 · 5–20 秒/);
  assert.equal(ui.get('utility-detail').querySelectorAll('a')[0].href, '/?demo=timed&t=405.50', 'replay uses original match time, not elapsed round time');
  for (const key of ['0-5', '20-50', '50+', 'unknown', 'all']) {
    await ui.change('analysis-utility-time', key);
    assert.equal(Number(ui.get('metric-utilities').textContent), counts[key]);
    assert.deepEqual(utilityCounts(ui), counts, 'all interval counts remain visible before the active time filter');
    assert.equal(utilityCountButton(ui, key)['aria-pressed'], 'true');
    assert.equal(ui.get('utility-time-counts').children.filter(button => button['aria-pressed'] === 'true').length, 1);
    assert.deepEqual(ui.renderedHeat().imageData.data, pixels);
    assert.deepEqual(['movement', 'engagements', 'deaths'].map(metric => ui.get(`metric-${metric}`).textContent), metrics);
    assert.equal(ui.get('selection-summary').textContent, selectionSummary);
  }
});

test('utility distribution follows other filters while changing and restoring time preserves every saved selection', async () => {
  const demo = utilityDemo('selected', 'de_nuke'), playerId = demo.players[0].id;
  const original = demo.utilities[0];
  demo.utilities.push({ ...original, id: 'other-type', type: 'flash' }, { ...original, id: 'other-player', playerId: 'other' }, { ...original, id: 'other-side', side: 2 }, { ...original, id: 'other-team', teamId: 'other-team' }, { ...original, id: 'other-floor', end: { ...original.end, z: 200 } });
  const otherMap = utilityDemo('ancient', 'de_ancient'), unchecked = utilityDemo('unchecked', 'de_nuke');
  const saved = { selectedDemos: ['selected', 'ancient'], selectedTeams: ['alias:squad'], selectedPlayers: [playerId], aliases: { 'team-a': 'Squad' }, map: 'de_nuke', floor: 'lower', side: '3', query: 'Player', layers: ['deaths', 'shots'], radius: 224, opacity: 75, scale: 'linear', utilityType: 'smoke', utilitySort: 'rare', landingDistance: 192, throwDistance: 96 };
  const mapInfo = { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' };
  const ui = await page([demo, otherMap, unchecked], { saved, mapInfo }); const before = ui.saved();
  assert.deepEqual(utilityCounts(ui), { all: 7, '0-5': 2, '5-20': 1, '20-50': 1, '50+': 1, unknown: 2 });
  await ui.change('analysis-utility-time', '20-50');
  for (const [key, value] of Object.entries(before)) if (key !== 'utilityTime') assert.deepEqual(ui.saved()[key], value, `${key} is unaffected by utility time`);
  const restored = await page([demo, otherMap, unchecked], { saved: ui.saved(), mapInfo });
  assert.equal(restored.get('analysis-utility-time').value, '20-50'); assert.equal(restored.get('metric-utilities').textContent, '1');
  assert.deepEqual(restored.saved(), ui.saved());
  await ui.change('analysis-utility-type', 'flash'); assert.deepEqual(utilityCounts(ui), { all: 1, '0-5': 1, '5-20': 0, '20-50': 0, '50+': 0, unknown: 0 });
  assert.equal(ui.get('metric-utilities').textContent, '0'); assert.equal(ui.get('export-csv').disabled, true);
  assert.match(textWithin(ui.get('utility-groups')), /切换投掷时段/);
  await utilityCountButton(ui, '0-5').click(); await settle(); assert.equal(ui.get('metric-utilities').textContent, '1');
});

test('unknown utility clocks are labeled separately and reset restores all times without dropping team aliases', async () => {
  const demo = utilityDemo(); const ui = await page([demo], { saved: { utilityTime: 'unknown', aliases: { 'team-a': 'Saved squad' } } });
  assert.equal(ui.get('metric-utilities').textContent, '2'); await ui.get('utility-groups').children[0].click(); await settle();
  const details = textWithin(ui.get('utility-detail'));
  assert.match(details, /时间未知/); assert.match(details, /缺少出手或冻结结束记录/); assert.doesNotMatch(details, /开打后 .* 秒/);
  await clickAndSettle(ui, 'clear-selection');
  assert.equal(ui.get('analysis-utility-time').value, 'all'); assert.equal(ui.saved().utilityTime, 'all'); assert.equal(ui.get('metric-utilities').textContent, '7');
  assert.deepEqual(ui.saved().aliases, { 'team-a': 'Saved squad' });
  const invalid = await page([demo], { saved: { utilityTime: 'invalid-bucket' } }); assert.equal(invalid.saved().utilityTime, 'all');
  const empty = await page([]); assert.deepEqual(utilityCounts(empty), { all: 0, '0-5': 0, '5-20': 0, '20-50': 0, '50+': 0, unknown: 0 });
  await empty.change('analysis-utility-time', 'unknown'); assert.equal(empty.saved().utilityTime, 'unknown'); assert.equal(empty.get('export-csv').disabled, true);
});

test('utility CSV uses the active time selection and exports round elapsed seconds independently of replay seconds', async () => {
  const demo = utilityDemo(); demo.utilities[2].roundElapsed = 5.001; demo.utilities[2].time = 405.001;
  const ui = await page([demo]); await ui.change('analysis-utility-time', '0-5'); await clickAndSettle(ui, 'export-csv');
  assert.equal(ui.downloads[0].filename, 'de_mirage-utilities.csv');
  let rows = csvRows(await ui.downloads[0].blob.text());
  const headings = rows[0], at = title => headings.indexOf(title);
  assert.ok(at('回合开打后秒数') >= 0); assert.ok(at('投掷时段') >= 0); assert.ok(at('秒') >= 0);
  assert.equal(rows.length, 3); assert.deepEqual(rows.slice(1).map(row => row[at('回合开打后秒数')]), ['0', '5']);
  assert.deepEqual(rows.slice(1).map(row => row[at('秒')]), ['400', '405']);
  assert.ok(rows.slice(1).every(row => row[at('投掷时段')] === '开局 0–5 秒' && row[at('落点次数')] === '2'));
  await ui.change('analysis-utility-time', '5-20'); await clickAndSettle(ui, 'export-csv'); rows = csvRows(await ui.downloads[1].blob.text());
  assert.equal(rows.length, 2); assert.equal(rows[1][at('回合开打后秒数')], '5.001'); assert.equal(rows[1][at('秒')], '405.001'); assert.equal(rows[1][at('投掷时段')], '5–20 秒');
  await ui.change('analysis-utility-time', 'unknown'); await clickAndSettle(ui, 'export-csv'); rows = csvRows(await ui.downloads[2].blob.text());
  assert.equal(rows.length, 3); assert.ok(rows.slice(1).every(row => row[at('回合开打后秒数')] === '' && row[at('投掷时段')] === '时间未知'));
  assert.deepEqual(rows.slice(1).map(row => row[at('秒')]), ['405', '406'], 'unknown round clock does not overwrite the replay timestamp');
});

test('utility time and all other preferences survive reparse queue, failure, success and page reload', async () => {
  const demo = { ...utilityDemo('selected', 'de_nuke'), revision: 'old' };
  const saved = { selectedDemos: ['selected'], selectedTeams: ['alias:squad'], selectedPlayers: [demo.players[0].id], aliases: { 'team-a': 'Squad' }, map: 'de_nuke', floor: 'lower', side: '3', query: 'Player', utilityTime: '20-50', utilityType: 'smoke', utilitySort: 'rare', layers: ['deaths'], radius: 224, opacity: 75, scale: 'linear' };
  const mapInfo = { lowerMaxZ: 100, lowerRadar: '/maps/lower.png' }, ui = await page([demo], { saved, mapInfo }); const before = ui.saved();
  await clickAndSettle(ui, 'reparse-analyses'); assert.deepEqual(ui.saved(), before); assert.equal(ui.get('metric-utilities').textContent, '1');
  ui.setJob({ ...demo, reparse: { status: 'error', error: '测试解析失败' } }); await ui.pollLibrary(); assert.deepEqual(ui.saved(), before); assert.equal(ui.get('metric-utilities').textContent, '1');
  await clickAndSettle(ui, 'retry-reparse-failures');
  const updated = { ...demo, revision: 'new', reparse: { status: 'ready', progress: 1, revision: 'new' }, utilities: [...demo.utilities, { ...demo.utilities[3], id: 'extra', roundElapsed: 42 }] };
  ui.setJob(updated); await ui.pollLibrary();
  assert.deepEqual(ui.saved(), before); assert.equal(ui.get('analysis-utility-time').value, '20-50'); assert.equal(ui.get('metric-utilities').textContent, '2');
  assert.deepEqual(utilityCounts(ui), { all: 8, '0-5': 2, '5-20': 1, '20-50': 2, '50+': 1, unknown: 2 });
  const restored = await page([updated], { saved: ui.saved(), mapInfo }); assert.deepEqual(restored.saved(), before); assert.equal(restored.get('metric-utilities').textContent, '2');
});
