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
  const uploads = new Map((pageOptions.uploads || []).map(demo => [demo.name, demo]));
  const stored = new Map(pageOptions.saved ? [['cs2-analysis-v4', JSON.stringify(pageOptions.saved)]] : []);
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/api/analyses') return response([...source.values()].map(d => ({ id: d.id, name: d.name, map: d.map, status: 'ready' })));
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
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, location: { href: pageOptions.href || 'http://127.0.0.1:8765/analysis.html' },
    FormData: class { constructor() { this.values = new Map(); } append(key, value) { this.values.set(key, value); } get(key) { return this.values.get(key); } },
    AbortController, DOMException, devicePixelRatio: 2, URL: PageURL, Blob, fetch, console,
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
    saved: () => JSON.parse(stored.get('cs2-analysis-v4') || '{}'),
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
