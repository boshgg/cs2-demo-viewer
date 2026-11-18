const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const library = require('../web/replay-library.js');
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const demo = (id, status = 'discovered', extra = {}) => ({ id, name: `${id}.dem`, status, available: true, sources: [{ path: `season/${id}.dem`, kind: 'dem' }], ...extra });

function page(initial = [], options = {}) {
  const elements = new Map(), requests = [], timers = new Map(), selected = [];
  const stored = options.stored || new Map();
  const storage = options.storage || { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  let demos = initial, scanning = false, nextTimer = 0, refreshError = '', gate = null;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.classList = { toggle() {} }; this.value = ''; this.open = false; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type, args = {}) { for (const listener of this.listeners[type] || []) listener({ target: this, preventDefault() {}, ...args }); }
    click() { if (!this.disabled) this.dispatch('click'); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
  }
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)) elements.set(match[2], new Element(match[1]));
  const get = id => { assert.ok(elements.has(id), `missing #${id}`); return elements.get(id); };
  const document = { getElementById: get, createElement: tag => new Element(tag), activeElement: get('open-replay-library'), querySelector: () => null, addEventListener() {} };
  const fetch = async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    const custom = options.request?.(url, init);
    if (custom !== undefined) return custom;
    if (url === '/api/library/demos') { if (gate) await gate.promise; return response({ demos, scanning }); }
    if (url === '/api/library') return response({ enabled: true, directory: 'F:\\viewer\\demo', scanning });
    if (url === '/api/library/refresh' && init.method === 'POST') {
      if (refreshError) return response({ error: refreshError }, 500);
      scanning = true; return response({ scanning: true });
    }
    throw new Error(`Unexpected library request ${url}`);
  };
  const injected = { document, fetch, storage,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) };
  let api, location = { href: options.href || 'http://127.0.0.1:8771/' };
  if (options.application) {
    const noop = () => {};
    const window = { location, history: { replaceState: (_, __, url) => { location.href = String(url); } }, addEventListener: noop,
      ReplayRadar: { create: () => ({ resize: noop, draw: noop, reset: noop }) },
      ReplayLibrary: { ...library, loadReplay: (id, args) => library.loadReplay(id, { ...args, fetch }), create: args => { api = library.create({ ...args, ...injected }); return api; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8'), {
      document, window, fetch, AbortController, DOMException, URL, FormData, console,
      performance: { now: () => 1000 }, requestAnimationFrame: noop, ResizeObserver: class { observe() {} },
      setTimeout, Image: class {}, Option: function(text, value) { this.textContent = text; this.value = value; },
    }, { filename: 'app.js' });
  } else api = library.create({ ...injected, onSelect: item => selected.push(item), onOpen: options.onOpen });
  const text = element => element.textContent + element.children.map(text).join(' ');
  const descend = element => element.children.flatMap(child => [child, ...descend(child)]);
  return { api, get, requests, selected, timers, document, location, stored,
    rows: () => descend(get('replay-library-list')).filter(child => child.dataset.demoId),
    groups: () => get('replay-library-list').children.filter(child => child.dataset.folder),
    toggle: key => descend(get('replay-library-list')).find(child => child.dataset.folderToggle === key),
    body: key => descend(get('replay-library-list')).find(child => child.dataset.folderBody === key),
    change: (id, value) => { get(id).value = value; get(id).dispatch('change'); },
    text: () => text(get('replay-library-list')),
    search: query => { get('replay-library-search').value = query; get('replay-library-search').dispatch('input'); },
    setDemos: value => { demos = value; }, setScanning: value => { scanning = value; }, setRefreshError: value => { refreshError = value; }, gate: value => { gate = value; },
    async tick() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
  };
}

test('search covers relative directories, archive members, maps and multiple terms', () => {
  const item = demo('match', 'ready', { map: 'de_anubis', sources: [{ path: '2026/Final.zip', member: 'maps/Grand Final.DEM', kind: 'zip' }] });
  assert.equal(library.matches(item, 'ANUBIS final'), true);
  assert.equal(library.matches(item, '2026 maps/Grand'), true);
  assert.equal(library.matches(item, 'mirage'), false);
  assert.deepEqual(library.sourcePaths(item), ['2026/Final.zip › maps/Grand Final.DEM']);
});

test('folder keys use normalized physical parents, preserve nested directories and never use ZIP members', () => {
  const item = demo('paths', 'ready', { sources: [
    { path: 'root.dem' },
    { path: '.\\练习\\上周\\match.dem', available: true },
    { path: '练习//上周/archive.zip', member: 'different/map/deep/final.dem', kind: 'zip' },
    { path: '练习/临时/../上周/other.dem' },
    { path: './archive.zip', member: 'remote/folder/third.dem', kind: 'zip' },
  ] });
  assert.deepEqual(library.folderKeys(item), ['root', 'path:练习/上周']);
  assert.equal(library.folderLabel('root'), '录像根目录');
  assert.equal(library.folderLabel('path:练习/上周'), '练习/上周');
  assert.equal(library.inFolder(item, 'path:different/map/deep'), false);
  assert.equal(library.inFolder(item, 'path:练习/上周'), true);
  assert.equal(library.inFolder(item, 'root'), true);
  assert.equal(library.inFolder(item, 'all'), true);
  assert.deepEqual(library.folderKeys(demo('named', 'ready', { sources: [{ path: 'root/a.dem' }, { path: 'unavailable/b.zip' }] })), ['path:root', 'path:unavailable']);
});

test('only available local sources determine folders while cache-only and invalid physical paths get a separate group', () => {
  const unavailable = [undefined, null, {}, { sources: [] }, { sources: [{ path: 'old/match.dem', available: false }] },
    { sources: [{ member: 'inside/final.dem', kind: 'zip' }] }, { sources: [{ path: '../outside.dem' }, { path: '/absolute/a.dem' }, { path: 'F:\\outside\\a.dem' }, { path: '\\\\server\\share\\a.dem' }] },
    { sources: [null, { path: '' }, { path: '.' }, { path: 'folder/' }] }];
  for (const item of unavailable) assert.deepEqual(library.folderKeys(item), ['unavailable']);
  assert.equal(library.folderLabel('unavailable'), '仅缓存或源文件不可用');
  assert.deepEqual(library.folderKeys({ available: true, sources: [{ path: 'old/a.dem', available: false }, { path: '新目录/a.zip', available: true }] }), ['path:新目录']);
  assert.deepEqual(library.folderKeys({ available: false, sources: [{ path: 'current/a.dem' }] }), ['path:current'], 'per-source availability is authoritative, not the aggregate cache flag');
});

test('folder options and grouping count each ID once per physical folder and support multiple valid aliases', () => {
  const same = demo('same', 'ready', { sources: [{ path: 'one.dem' }, { path: '赛事/one.dem' }, { path: '赛事/second.zip', member: 'one.dem' }, { path: '练习/one.zip', member: 'nested/one.dem' }] });
  const other = demo('other', 'ready', { sources: [{ path: '赛事/other.dem' }] });
  const cached = demo('cache', 'ready', { sources: [], available: true });
  const input = [same, same, other, cached], before = JSON.stringify(input);
  const options = library.folderOptions(input);
  assert.equal(options[0].key, 'root'); assert.equal(options.at(-1).key, 'unavailable');
  assert.deepEqual(Object.fromEntries(options.map(item => [item.key, item.count])), { root: 1, 'path:练习': 1, 'path:赛事': 2, unavailable: 1 });
  const grouped = library.groupByFolder(input, 'folders');
  assert.deepEqual(grouped.find(group => group.key === 'path:赛事').demos.map(demo => demo.id), ['same', 'other']);
  assert.equal(grouped.filter(group => group.demos.some(demo => demo.id === 'same')).length, 3);
  assert.deepEqual(library.groupByFolder(input, 'folders', 'path:练习').map(group => group.key), ['path:练习']);
  assert.deepEqual(library.groupByFolder(input, 'folders', 'path:missing'), []);
  assert.deepEqual(library.groupByFolder(input, 'all', 'path:练习').map(group => [group.key, group.label, group.demos.length]), [['all', '', 3]], 'flat view ignores the hidden folder preference');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(library.folderOptions(null), []); assert.deepEqual(library.groupByFolder([], 'all'), [{ key: 'all', label: '', demos: [] }]);
});

test('folder expansion defaults, individual exceptions and global defaults apply to future folders', () => {
  const state = library.createFolderExpansion();
  assert.equal(state.isExpanded('root'), true);
  state.setExpanded('path:A', false);
  assert.equal(state.isExpanded('path:A'), false); assert.equal(state.isExpanded('path:B'), true);
  assert.deepEqual(state.snapshot(), { defaultExpanded: true, overrides: { 'path:A': false } });
  state.setExpanded('path:A', true); assert.deepEqual(state.snapshot().overrides, {});
  state.setAll(false);
  assert.equal(state.isExpanded('path:added-later'), false);
  state.setExpanded('path:B', true);
  assert.deepEqual(state.snapshot(), { defaultExpanded: false, overrides: { 'path:B': true } });
  state.setAll(false); assert.deepEqual(state.snapshot(), { defaultExpanded: false, overrides: {} });
  state.setAll(true); assert.equal(state.isExpanded('unavailable'), true);
  assert.equal(state.isExpanded('path:another-new-folder'), true);
});

test('folder expansion restores strict boolean own values and rejects malformed saved state', () => {
  for (const invalid of [null, undefined, false, 'false', [], { defaultExpanded: 'false', overrides: [] }, { defaultExpanded: 0, overrides: 'root' }]) {
    assert.deepEqual(library.createFolderExpansion(invalid).snapshot(), { defaultExpanded: true, overrides: {} });
  }
  const inherited = Object.create({ defaultExpanded: false, overrides: { root: false } });
  assert.deepEqual(library.createFolderExpansion(inherited).snapshot(), { defaultExpanded: true, overrides: {} });
  const state = library.createFolderExpansion({ defaultExpanded: false, overrides: { root: true, 'path:A': false, 'path:B': 1, unavailable: 'true', '': true } });
  assert.deepEqual(state.snapshot(), { defaultExpanded: false, overrides: { root: true } });
  state.setAll('true'); state.setExpanded(null, true); state.setExpanded('path:B', 'true');
  assert.deepEqual(state.snapshot(), { defaultExpanded: false, overrides: { root: true } });
  const restored = library.createFolderExpansion(JSON.parse(JSON.stringify(state.snapshot())));
  assert.equal(restored.isExpanded('root'), true); assert.equal(restored.isExpanded('path:new'), false);
});

test('folder expansion is safe for prototype-like keys and snapshots cannot mutate another module', () => {
  const saved = JSON.parse('{"defaultExpanded":true,"overrides":{"__proto__":false,"constructor":false,"path:__proto__":false}}');
  const first = library.createFolderExpansion(saved), second = library.createFolderExpansion(saved);
  assert.equal(first.isExpanded('__proto__'), false); assert.equal(first.isExpanded('constructor'), false);
  const snapshot = first.snapshot();
  assert.equal(Object.getPrototypeOf(snapshot.overrides), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.overrides, '__proto__'), true);
  snapshot.overrides.__proto__ = true; snapshot.overrides['path:__proto__'] = true; snapshot.defaultExpanded = false;
  assert.equal(first.isExpanded('__proto__'), false); assert.equal(first.isExpanded('path:new'), true);
  first.setAll(false); second.setExpanded('path:__proto__', true);
  assert.equal(second.isExpanded('path:new'), true); assert.equal(first.isExpanded('path:__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('playback group toggles retain native button focus and never select or parse a recording', async () => {
  const p = page([demo('one'), demo('two', 'ready', { sources: [{ path: 'other/two.dem' }] })]);
  p.api.show(); await settle();
  assert.equal(p.get('replay-library-expansion-controls').hidden, true);
  p.change('replay-library-mode', 'folders'); assert.equal(p.get('replay-library-expansion-controls').hidden, false);
  const toggle = p.toggle('path:season'), body = p.body('path:season'), requests = p.requests.length;
  assert.equal(toggle.tagName, 'button'); assert.equal(toggle.type, 'button');
  assert.equal(toggle['aria-controls'], body.id); assert.equal(toggle['aria-expanded'], 'true'); assert.equal(body.hidden, false);
  toggle.focus(); toggle.click();
  assert.equal(p.document.activeElement, toggle, 'keyboard focus stays on the same mounted toggle');
  assert.equal(toggle['aria-expanded'], 'false'); assert.equal(body.hidden, true); assert.match(toggle['aria-label'], /展开/);
  assert.equal(p.body('path:other').hidden, false); assert.equal(p.get('replay-library-count').textContent, '2 / 2 场');
  assert.equal(p.rows().length, 2, 'folded content remains in the catalog');
  assert.deepEqual(p.selected, []); assert.equal(p.requests.length, requests);
  p.groups().find(group => group.dataset.folder === 'path:season').click();
  assert.equal(body.hidden, true, 'section clicks do not accidentally toggle or play');
  toggle.click(); assert.equal(body.hidden, false); assert.match(toggle['aria-label'], /折叠/);
  p.rows().find(row => row.dataset.demoId === 'one').children[1].click();
  assert.equal(p.selected[0].id, 'one', 'explicit replay button still selects the original ID');
});

test('playback collapse survives search, mode changes, reopen and browser preference restoration', async () => {
  const stored = new Map([['cs2-analysis-v4', '{"selectedDemos":["kept"]}'], ['cs2-statistics-multi-v1', '{"folderExpansion":{"defaultExpanded":false,"overrides":{}}}']]);
  const demos = [demo('one'), demo('two', 'ready', { sources: [{ path: 'other/two.dem' }] })];
  const p = page(demos, { stored }); p.api.show(); await settle(); p.change('replay-library-mode', 'folders'); p.toggle('path:season').click();
  p.search('two'); assert.equal(p.toggle('path:season'), undefined);
  p.search(''); assert.equal(p.body('path:season').hidden, true);
  p.change('replay-library-mode', 'all'); assert.equal(p.get('replay-library-expansion-controls').hidden, true); assert.equal(p.rows().length, 2);
  p.change('replay-library-mode', 'folders'); assert.equal(p.body('path:season').hidden, true);
  p.api.close(); p.api.show(); await settle(); assert.equal(p.body('path:season').hidden, true);
  const restored = page(demos, { stored }); restored.api.show(); await settle();
  assert.equal(restored.body('path:season').hidden, true); assert.equal(restored.body('path:other').hidden, false);
  assert.deepEqual(JSON.parse(stored.get(library.viewStorageKey)).folderExpansion, { defaultExpanded: true, overrides: { 'path:season': false } });
  assert.equal(stored.get('cs2-analysis-v4'), '{"selectedDemos":["kept"]}');
  assert.equal(stored.get('cs2-statistics-multi-v1'), '{"folderExpansion":{"defaultExpanded":false,"overrides":{}}}');
  assert.ok([...p.requests, ...restored.requests].every(([, method]) => method === 'GET'));
});

test('playback all-folder controls cover hidden groups, clear exceptions and govern refreshed new folders', async () => {
  const original = [demo('one'), demo('two', 'ready', { sources: [{ path: 'other/two.dem' }] })];
  const p = page(original); p.api.show(); await settle(); p.change('replay-library-mode', 'folders'); p.search('one');
  p.get('replay-library-collapse-all').focus(); p.get('replay-library-collapse-all').click();
  assert.equal(p.document.activeElement, p.get('replay-library-collapse-all'));
  p.search(''); assert.ok(p.groups().every(group => p.body(group.dataset.folder).hidden));
  p.toggle('path:season').click(); assert.equal(p.body('path:season').hidden, false);
  await p.api.refresh(); p.setDemos([...original, demo('new', 'ready', { sources: [{ path: 'new/fresh.zip', member: 'inside/new.dem', kind: 'zip' }] })]);
  p.setScanning(false); await p.tick();
  assert.equal(p.body('path:new').hidden, true, 'new folders obey the global collapsed default');
  assert.equal(p.body('path:season').hidden, false, 'an explicit exception survives refresh');
  p.get('replay-library-collapse-all').click(); assert.equal(p.body('path:season').hidden, true);
  assert.deepEqual(JSON.parse(p.stored.get(library.viewStorageKey)).folderExpansion, { defaultExpanded: false, overrides: {} });
  p.get('replay-library-expand-all').click(); assert.ok(p.groups().every(group => !p.body(group.dataset.folder).hidden));
  p.setDemos([...original, demo('later', 'ready', { sources: [{ path: 'later/final.dem' }] })]); await p.api.reload();
  assert.equal(p.body('path:later').hidden, false); assert.deepEqual(p.selected, []);
  assert.deepEqual(p.requests.filter(([, method]) => method !== 'GET'), [['/api/library/refresh', 'POST']]);
});

test('playback folding remains usable with malformed JSON and blocked local storage', async () => {
  for (const options of [
    { stored: new Map([[library.viewStorageKey, '{bad']]) },
    { stored: new Map([[library.viewStorageKey, JSON.stringify({ mode: 'folders', folderExpansion: { defaultExpanded: 'false', overrides: { 'path:season': 'false' } } })]]) },
    { storage: { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('quota'); } } },
  ]) {
    const p = page([demo('one')], options); p.api.show(); await settle(); p.change('replay-library-mode', 'folders');
    assert.equal(p.body('path:season').hidden, false);
    p.toggle('path:season').click(); assert.equal(p.body('path:season').hidden, true);
    p.get('replay-library-expand-all').click(); assert.equal(p.body('path:season').hidden, false);
    p.get('replay-library-collapse-all').click(); assert.equal(p.body('path:season').hidden, true);
    assert.ok(p.requests.every(([, method]) => method === 'GET')); assert.deepEqual(p.selected, []);
  }
});

test('playback folder controls filter and group the same catalog without parsing or changing the selected recording identity', async () => {
  const same = demo('same', 'ready', { sources: [{ path: '训练/one.zip', member: 'maps/match.dem' }, { path: '比赛/one.dem' }] });
  const p = page([same, demo('root', 'ready', { sources: [{ path: 'root.dem' }] })]);
  p.api.show(); await settle(); assert.equal(p.rows().length, 2); assert.equal(p.get('replay-library-folder-field').hidden, true);
  p.change('replay-library-mode', 'folders'); assert.equal(p.get('replay-library-folder-field').hidden, false);
  assert.equal(p.groups().length, 3); assert.equal(p.rows().length, 3); assert.equal(p.get('replay-library-count').textContent, '2 / 2 场');
  p.change('replay-library-folder', 'path:比赛'); assert.equal(p.groups().length, 1); assert.equal(p.rows()[0].dataset.demoId, 'same');
  assert.match(p.rows()[0].children[0].children[1].textContent, /比赛\/one.dem/, 'a group row displays its own physical source first');
  p.search('maps match'); assert.equal(p.rows().length, 1, 'member search still works without creating member folders');
  p.change('replay-library-mode', 'all'); p.search(''); assert.equal(p.rows().length, 2); assert.equal(p.groups().length, 0);
  p.change('replay-library-mode', 'folders'); assert.equal(p.get('replay-library-folder').value, 'path:比赛'); assert.equal(p.rows().length, 1);
  assert.ok(p.requests.every(([, method]) => method === 'GET'));
  p.rows()[0].children[1].click(); assert.equal(p.selected.length, 1); assert.equal(p.selected[0].id, 'same');
});

test('refresh exposes new physical folders and reclassifies unavailable aliases without duplicating a demo', async () => {
  const p = page([demo('one', 'ready', { sources: [{ path: '旧文件夹/one.dem' }] })]); p.api.show(); await settle(); p.change('replay-library-mode', 'folders');
  await p.api.refresh();
  p.setDemos([demo('one', 'ready', { sources: [{ path: '旧文件夹/one.dem', available: false }, { path: '新文件夹/one.zip', member: 'inside/one.dem', available: true }] }), demo('second', 'ready', { sources: [{ path: '新文件夹/second.dem' }] })]);
  p.setScanning(false); await p.tick();
  assert.deepEqual(p.groups().map(group => group.dataset.folder), ['path:新文件夹']); assert.equal(p.rows().length, 2);
  const keys = p.get('replay-library-folder').children.map(option => option.value); assert.deepEqual(keys, ['all', 'path:新文件夹']);
  assert.equal(p.get('replay-library-count').textContent, '2 / 2 场'); assert.deepEqual(p.requests.filter(([, method]) => method !== 'GET'), [['/api/library/refresh', 'POST']]);
});

test('playback view preferences survive reopening independently of analysis selections and tolerate unavailable storage', async () => {
  const stored = new Map([['cs2-analysis-session', '{"players":["keep"],"teams":["kept"]}'], ['cs2-statistics-multi-v1', '{"demoIds":["keep"]}']]);
  const p = page([demo('one')], { stored }); p.api.show(); await settle(); p.change('replay-library-mode', 'folders'); p.change('replay-library-folder', 'path:season');
  const restored = page([demo('one')], { stored }); restored.api.show(); await settle();
  assert.equal(restored.get('replay-library-mode').value, 'folders'); assert.equal(restored.get('replay-library-folder').value, 'path:season'); assert.equal(restored.rows().length, 1);
  assert.equal(stored.get('cs2-analysis-session'), '{"players":["keep"],"teams":["kept"]}'); assert.equal(stored.get('cs2-statistics-multi-v1'), '{"demoIds":["keep"]}');
  assert.deepEqual([...stored.keys()].sort(), ['cs2-analysis-session', 'cs2-statistics-multi-v1', library.viewStorageKey].sort());
  const blocked = page([demo('one')], { storage: { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } } });
  blocked.api.show(); await settle(); blocked.change('replay-library-mode', 'folders'); assert.equal(blocked.rows().length, 1);
  const invalid = page([demo('one')], { stored: new Map([[library.viewStorageKey, '{broken json']]) }); invalid.api.show(); await settle(); assert.equal(invalid.get('replay-library-mode').value, 'all');
});

test('opening and searching the actual library dialog never starts parsing', async () => {
  const p = page([demo('one'), demo('two', 'ready', { map: 'de_mirage' })]);
  p.get('empty-replay-library').click(); await settle();
  assert.equal(p.get('replay-library').open, true);
  assert.equal(p.document.activeElement, p.get('replay-library-search'));
  assert.equal(p.rows().length, 2);
  p.search('mirage');
  assert.deepEqual(p.rows().map(row => row.dataset.demoId), ['two']);
  assert.ok(p.requests.every(([, method]) => method === 'GET'));
  p.rows()[0].children[1].click();
  assert.equal(p.get('replay-library').open, false);
  assert.equal(p.selected[0].id, 'two');
  assert.equal(p.document.activeElement, p.get('open-replay-library'));
});

test('deduplicated sources are visible and missing sources only disable unparsed recordings', async () => {
  const p = page([demo('same', 'discovered', { sourceCount: 3 }), demo('lost', 'discovered', { available: false }), demo('cached', 'ready', { available: false })]);
  p.api.show(); await settle();
  assert.match(p.text(), /3 个来源，已去重/);
  assert.equal(p.rows()[1].children[1].disabled, true);
  assert.equal(p.rows()[2].children[1].disabled, false);
  p.rows()[1].children[1].click(); assert.equal(p.selected.length, 0);
  p.rows()[2].children[1].click(); assert.equal(p.selected[0].id, 'cached');
});

test('refresh polls an initially empty scanning library until discoveries arrive without parsing', async () => {
  const p = page(); p.api.show(); await settle();
  await p.api.refresh();
  assert.equal(p.timers.size, 1);
  assert.equal(p.get('replay-library-refresh').disabled, true);
  assert.match(p.text(), /正在发现录像/);
  p.setDemos([demo('nested')]); p.setScanning(false); await p.tick();
  assert.equal(p.rows()[0].dataset.demoId, 'nested');
  assert.equal(p.get('replay-library-refresh').disabled, false);
  assert.equal(p.timers.size, 0);
  assert.deepEqual(p.requests.filter(([, method]) => method !== 'GET'), [['/api/library/refresh', 'POST']]);
});

test('refresh errors retain playable entries and can be retried', async () => {
  const p = page([demo('one', 'ready')]); p.api.show(); await settle();
  p.setRefreshError('文件夹暂不可读'); await p.api.refresh();
  assert.match(p.get('replay-library-message').textContent, /刷新失败.*文件夹暂不可读/);
  assert.equal(p.rows().length, 1); assert.equal(p.get('replay-library-refresh').disabled, false);
  p.setRefreshError(''); await p.api.refresh(); assert.equal(p.timers.size, 1);
});

test('closing stops polling and ignores late catalog results', async () => {
  const p = page([demo('old')]); p.api.show(); await settle();
  const gate = deferred(); p.gate(gate); p.setDemos([demo('late')]);
  const pending = p.api.reload(); p.api.close(); gate.resolve(); await pending;
  assert.equal(p.api.isOpen(), false); assert.equal(p.timers.size, 0);
  assert.equal(p.rows()[0].dataset.demoId, 'old');
  assert.ok(!p.requests.some(([, method]) => method === 'DELETE'));
});

test('cached selection only loads the chosen replay, with playback mode and no polling', async () => {
  const requests = [];
  const result = await library.loadReplay('selected', { fetch: async (url, init = {}) => {
    requests.push([url, init]);
    if (url.endsWith('/parse')) return response({ id: 'selected', status: 'ready', cached: true });
    return response({ id: 'selected', frames: [{ t: 0 }] });
  } });
  assert.equal(result.data.id, 'selected');
  assert.deepEqual(requests.map(([url]) => url), ['/api/library/demos/selected/parse', '/api/demos/selected']);
  assert.deepEqual(JSON.parse(requests[0][1].body), { mode: 'playback' });
  assert.ok(!requests.some(([, init]) => init.method === 'DELETE'));
});

test('on-demand parse reports progress and loads canonical job returned by the server', async () => {
  const requests = [], progress = []; let polls = 0;
  const result = await library.loadReplay('source/id', { sleep: async () => {}, onProgress: value => progress.push(value), fetch: async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    if (url.endsWith('/parse')) return response({ id: 'canonical', status: 'queued' });
    if (url.endsWith('/status')) return response(++polls === 1 ? { status: 'parsing', progress: .45 } : { status: 'ready', progress: 1 });
    return response({ id: 'canonical', frames: [{ t: 0 }] });
  } });
  assert.equal(result.id, 'canonical'); assert.equal(polls, 2);
  assert.ok(progress.some(value => value.progress === .45));
  assert.deepEqual(requests.map(([url]) => url), ['/api/library/demos/source%2Fid/parse', '/api/demos/canonical/status', '/api/demos/canonical/status', '/api/demos/canonical']);
});

test('parser failures and missing sources are surfaced without deleting shared jobs', async () => {
  for (const sourceMissing of [false, true]) {
    const requests = [];
    await assert.rejects(library.loadReplay('failed', { fetch: async (url, init = {}) => {
      requests.push([url, init.method || 'GET']);
      if (sourceMissing) return response({ error: '源文件已移动' }, 409);
      if (url.endsWith('/parse')) return response({ id: 'failed', status: 'queued' });
      return response({ status: 'error', error: '录像损坏' });
    } }), sourceMissing ? /源文件已移动/ : /录像损坏/);
    assert.ok(!requests.some(([, method]) => method === 'DELETE'));
    assert.ok(!requests.some(([url]) => url === '/api/demos/failed'));
  }
});

test('rapid A → B selection prevents stale A from loading and leaves shared jobs intact', async () => {
  const gate = deferred(), requests = []; let selected = 'a';
  const fetch = async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    if (url.includes('/a/parse')) { await gate.promise; return response({ id: 'a', status: 'ready' }); }
    if (url.endsWith('/parse')) return response({ id: 'b', status: 'ready' });
    return response({ id: 'b', frames: [{ t: 0 }] });
  };
  const pendingA = library.loadReplay('a', { fetch, isCurrent: () => selected === 'a' });
  const rejectedA = assert.rejects(pendingA, { name: 'AbortError' });
  selected = 'b'; const b = await library.loadReplay('b', { fetch, isCurrent: () => selected === 'b' });
  gate.resolve(); await rejectedA;
  assert.equal(b.data.id, 'b');
  assert.ok(!requests.some(([url]) => url === '/api/demos/a'));
  assert.ok(!requests.some(([, method]) => method === 'DELETE'));
});

test('stopping an active poll aborts only the wait and never requests cache deletion', async () => {
  const controller = new AbortController(), gate = deferred(), requests = [];
  const pending = library.loadReplay('shared', { signal: controller.signal, fetch: async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    if (url.endsWith('/parse')) return response({ id: 'shared', status: 'queued' });
    await gate.promise; return response({ status: 'parsing', progress: .1 });
  } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await settle(); controller.abort(); gate.resolve(); await rejected;
  assert.deepEqual(requests, [['/api/library/demos/shared/parse', 'POST'], ['/api/demos/shared/status', 'GET']]);
});

test('actual app selects the last library choice, starts playback and never deletes an earlier shared job', async () => {
  const a = deferred();
  const p = page([demo('a'), demo('b', 'ready')], { application: true, request: (url, init) => {
    if (url === '/api/library/demos/a/parse') return response({ id: 'a', status: 'queued' });
    if (url === '/api/demos/a/status') return a.promise;
    if (url === '/api/library/demos/b/parse') return response({ id: 'b', status: 'ready', cached: true });
    if (url === '/api/demos/b') return response({ id: 'b', name: 'Chosen B', map: 'de_mirage', frames: [{ t: 0 }, { t: 60 }], players: [] });
    if (url.startsWith('/api/maps/')) return response({ error: 'No fixture radar' }, 404);
  } });
  p.api.show(); await settle(); p.rows()[0].children[1].click(); await settle();
  assert.equal(p.get('cancel-import').textContent, '停止等待');
  p.api.show(); await settle(); p.rows()[1].children[1].click(); await settle();
  a.resolve(response({ status: 'ready' })); await settle();
  assert.equal(p.get('match-title').textContent, 'Chosen B');
  assert.equal(p.get('play-button')['aria-label'], '暂停');
  assert.equal(p.get('loading-state').hidden, true);
  assert.equal(new URL(p.location.href).searchParams.get('demo'), 'b');
  assert.ok(!p.requests.some(([, method]) => method === 'DELETE'));
  assert.ok(!p.requests.some(([url]) => url === '/api/demos/a'));
});

test('actual app stop-wait button retains the catalog record and ignores its late result', async () => {
  const gate = deferred();
  const p = page([demo('shared')], { application: true, request: url => {
    if (url.endsWith('/parse')) return response({ id: 'shared', status: 'queued' });
    if (url.endsWith('/status')) return gate.promise;
  } });
  p.api.show(); await settle(); p.rows()[0].children[1].click(); await settle();
  p.get('cancel-import').click(); gate.resolve(response({ status: 'ready' })); await settle();
  assert.equal(p.get('loading-state').hidden, true);
  assert.equal(p.get('empty-state').hidden, false);
  assert.ok(!p.requests.some(([, method]) => method === 'DELETE'));
  assert.ok(!p.requests.some(([url]) => url === '/api/demos/shared'));
});

test('a late saved-link 409 cannot override a newly selected replay', async () => {
  const stale = deferred();
  const p = page([demo('new', 'ready')], { application: true, href: 'http://127.0.0.1:8771/?demo=old&t=30', request: url => {
    if (url === '/api/demos/old') return stale.promise;
    if (url === '/api/library/demos/new/parse') return response({ id: 'new', status: 'ready' });
    if (url === '/api/demos/new') return response({ id: 'new', name: 'New match', frames: [{ t: 0 }, { t: 60 }], players: [] });
    if (url.startsWith('/api/maps/')) return response({}, 404);
  } });
  p.api.show(); await settle(); p.rows()[0].children[1].click(); await settle();
  stale.resolve(response({ error: 'not parsed' }, 409)); await settle();
  assert.equal(p.get('match-title').textContent, 'New match');
  assert.equal(new URL(p.location.href).searchParams.get('demo'), 'new');
  assert.ok(!p.requests.some(([url]) => url === '/api/library/demos/old/parse'));
});

test('canceling an upload that reused a catalog recording never deletes the shared job', async () => {
  const gate = deferred();
  const p = page([], { application: true, request: url => {
    if (url === '/api/demos') return response({ id: 'shared', shared: true });
    if (url === '/api/demos/shared/status') return gate.promise;
  } });
  p.get('file-input').files = [{ name: 'copy.dem', size: 1024 }]; p.get('file-input').dispatch('change'); await settle();
  assert.equal(p.get('cancel-import').textContent, '停止等待');
  assert.match(p.get('cancel-import').title, /继续在后台解析/);
  p.get('cancel-import').click(); gate.resolve(response({ status: 'ready' })); await settle();
  assert.equal(p.get('loading-state').hidden, true);
  assert.ok(!p.requests.some(([, method]) => method === 'DELETE'));
  assert.ok(!p.requests.some(([url]) => url === '/api/demos/shared'));
});

test('a late shared upload response after switching to a library replay cannot delete either job', async () => {
  const upload = deferred();
  const p = page([demo('chosen', 'ready')], { application: true, request: url => {
    if (url === '/api/demos') return upload.promise;
    if (url === '/api/library/demos/chosen/parse') return response({ id: 'chosen', status: 'ready' });
    if (url === '/api/demos/chosen') return response({ id: 'chosen', name: 'Chosen', frames: [{ t: 0 }, { t: 60 }], players: [] });
    if (url.startsWith('/api/maps/')) return response({}, 404);
  } });
  p.get('file-input').files = [{ name: 'copy.dem', size: 1024 }]; p.get('file-input').dispatch('change'); await settle();
  p.api.show(); await settle(); p.rows()[0].children[1].click(); await settle();
  upload.resolve(response({ id: 'shared', shared: true })); await settle();
  assert.equal(p.get('match-title').textContent, 'Chosen');
  assert.equal(new URL(p.location.href).searchParams.get('demo'), 'chosen');
  assert.ok(!p.requests.some(([, method]) => method === 'DELETE'));
});

test('shared upload parse failure surfaces the error without deleting the catalog record', async () => {
  const p = page([], { application: true, request: url => {
    if (url === '/api/demos') return response({ id: 'shared', shared: true });
    if (url === '/api/demos/shared/status') return response({ status: 'error', error: '损坏的录像' });
  } });
  p.get('file-input').files = [{ name: 'copy.dem', size: 1024 }]; p.get('file-input').dispatch('change'); await settle();
  assert.match(p.get('error-text').textContent, /损坏的录像/);
  assert.ok(!p.requests.some(([, method]) => method === 'DELETE'));
});

test('canceling a new private upload still releases its own pending job', async () => {
  const gate = deferred();
  const p = page([], { application: true, request: (url, init) => {
    if (url === '/api/demos') return response({ id: 'private', shared: false });
    if (url === '/api/demos/private/status') return gate.promise;
    if (url === '/api/demos/private' && init.method === 'DELETE') return response({});
  } });
  p.get('file-input').files = [{ name: 'new.dem', size: 1024 }]; p.get('file-input').dispatch('change'); await settle();
  assert.equal(p.get('cancel-import').textContent, '取消导入');
  assert.equal(p.get('cancel-import').title, '');
  p.get('cancel-import').click(); gate.resolve(response({ status: 'queued' })); await settle();
  assert.deepEqual(p.requests.filter(([, method]) => method === 'DELETE'), [['/api/demos/private', 'DELETE']]);
});
