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
  const injected = { document, fetch,
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
  return { api, get, requests, selected, timers, document, location,
    rows: () => get('replay-library-list').children.filter(child => child.dataset.demoId),
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
