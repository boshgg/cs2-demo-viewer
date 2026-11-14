const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const uiModule = require('../web/statistics-multi.js');
const statistics = require('../web/statistics.js');
const core = require('../web/statistics-multi-core.js');
const library = require('../web/replay-library.js');
const impact = require('../web/impact-core.js');
const impactUI = require('../web/impact-ui.js');
const html = fs.readFileSync(path.join(__dirname, '../web/statistics.html'), 'utf8');
const impactNode = (root, suffix) => { const walk = node => [node, ...node.children.flatMap(walk)]; const node = walk(root).find(item => item.id === `multi-impact-${suffix}`); assert.ok(node, suffix); return node; };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const p1 = '76561198000000001', p2 = '76561198000000002', p3 = '76561198000000003';
function fixture(id, map = 'de_anubis', partner = p2) {
  const unique = '76561198000000' + String(100 + id.charCodeAt(0)).padStart(3, '0');
  return { id, name: `${id}.dem`, map, revision: `${id}-v1`, ruleVersion: '2', rounds: [], players: [{ id: p1, name: `Alice ${id}` }, { id: partner, name: partner === p2 ? 'Bob' : 'Cathy' }, { id: unique, name: 'One match only' }], warnings: [], kills: [
    { index: 0, round: 1, half: 1, time: 42, killerId: p1, killer: `Alice ${id}`, victimId: unique, victim: 'One match only', killerSide: 3, victimSide: 2, weapon: 'Glock-18', victimWeapon: 'AWP', killerValue: 1, victimValue: 7, baseScore: 6, scoreMultiplier: 4, score: 24, weaponSource: 'death_event' },
    { index: 1, round: 1, half: 1, time: 58, killerId: partner, killer: partner === p2 ? 'Bob' : 'Cathy', victimId: p1, victim: `Alice ${id}`, killerSide: 2, victimSide: 3, weapon: 'MP9', victimWeapon: 'Glock-18', killerValue: 2, victimValue: 1, baseScore: -1, scoreMultiplier: 1, score: -1, weaponSource: 'previous_tick', approx: true },
    { index: 2, round: 1, half: 1, time: 60, killerId: '', killer: '', victimId: p1, victim: `Alice ${id}`, killerSide: 0, victimSide: 3, score: null, baseScore: null, scoreMultiplier: null, excludedReason: '世界伤害', weaponSource: 'unknown' },
  ] };
}
const fixtures = () => [fixture('a'), fixture('b'), fixture('c', 'de_ancient', p3), fixture('d', 'de_ancient', p3)];
function content(el) { return [el.textContent, ...el.children.map(content)].join(' '); }
async function page(options = {}) {
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type) { return Promise.all((this.listeners[type] || []).map(listener => listener({ target: this, preventDefault() {} }))); }
    click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
    get childElementCount() { return this.children.length; }
    querySelectorAll(tag) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tag)]).filter(child => child.tagName === tag); }
    setAttribute(key, value) { this[key] = value; }
  }
  const elements = new Map(), requests = [], parsed = [], timers = new Map(), snapshots = new Map(), errors = new Map(), gates = new Map(); let timerId = 0, refreshError = '', scanning = false;
  const data = new Map((options.datasets || fixtures()).map(demo => [demo.id, structuredClone(demo)]));
  let catalog = structuredClone(options.catalog || [...data.values()].map(demo => ({ id: demo.id, name: demo.name, map: demo.map, revision: demo.revision, status: 'ready', available: true, sources: [{ path: `nested/${demo.name}`, kind: 'dem' }] })));
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) { const [, tag, attrs, id] = match, el = new Element(tag); el.hidden = /\bhidden\b/.test(attrs); el.disabled = /\bdisabled\b/.test(attrs); elements.set(id, el); }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) { const el = elements.get(match[1]); for (const m of match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) { const opt = new Element('option'); opt.value = m[1]; opt.textContent = m[2]; el.append(opt); } el.value = el.children[0]?.value || ''; }
  const get = id => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); };
  const location = { href: options.href || 'http://127.0.0.1:9999/statistics.html?mode=multi' };
  const stored = new Map(options.saved ? [[uiModule.storageKey, JSON.stringify(options.saved)]] : []);
  const fetcher = async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    const snapshot = snapshots.get(url)?.shift(); if (gates.has(url)) await gates.get(url);
    if (errors.has(url)) return { ok: false, status: 500, json: async () => ({ error: errors.get(url) }) };
    const ok = body => ({ ok: true, json: async () => structuredClone(body) });
    if (snapshot) return ok(snapshot);
    if (url === '/api/library/demos') return ok({ demos: catalog, scanning });
    if (url === '/api/library') return ok({ directory: 'F:\\viewer\\demo', scanning });
    if (url === '/api/library/refresh') { if (refreshError) return { ok: false, status: 500, json: async () => ({ error: refreshError }) }; return ok({ scanning }); }
    const parse = /^\/api\/library\/demos\/([^/]+)\/parse$/.exec(url);
    if (parse) { parsed.push([parse[1], JSON.parse(init.body)]); const job = catalog.find(item => item.id === parse[1]); if (job) { job.status = 'ready'; job.map = data.get(job.id)?.map; } return ok({ id: parse[1], status: 'queued', revision: data.get(parse[1])?.revision }); }
    const demo = /^\/api\/demos\/([^/]+)\/(statistics|status)$/.exec(url);
    if (demo) return ok(demo[2] === 'status' ? { id: demo[1], status: 'ready', revision: data.get(demo[1])?.revision } : data.get(demo[1]));
    throw new Error(`Unexpected ${url}`);
  };
  const app = uiModule.create({ impact, impactUI, document: { getElementById: get, createElement: tag => new Element(tag) }, window: { location, history: { state: null, replaceState(_state, _title, url) { location.href = String(url); } } }, core, statistics, library, fetch: fetcher, storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, sleep: async () => {}, setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  await app.ready; await settle();
  return { get, requests, parsed, timers, href: () => location.href, saved: () => JSON.parse(stored.get(uiModule.storageKey) || '{}'),
    async click(id) { await get(id).click(); await settle(); }, async change(id, value) { get(id).value = value; await get(id).dispatch('change'); await settle(); },
    async search(id, value) { get(id).value = value; await get(id).dispatch('input'); await settle(); },
    async checkDemo(id, value = true) { const el = get('multi-demo-list').querySelectorAll('input').find(el => el.dataset.demoId === id); assert.ok(el, id); assert.equal(el.disabled, false); el.checked = value; await el.dispatch('change'); await settle(); },
    async checkPlayer(id, value = true) { const el = get('multi-player-list').querySelectorAll('input').find(el => el.dataset.playerId === id); assert.ok(el, id); el.checked = value; await el.dispatch('change'); await settle(); },
    block(url, snapshot) { if (snapshot) { const queue = snapshots.get(url) || []; queue.push(snapshot); snapshots.set(url, queue); } let release; gates.set(url, new Promise(resolve => { release = () => { gates.delete(url); resolve(); }; })); return release; },
    fail(url, message) { if (message) errors.set(url, message); else errors.delete(url); },
    setCatalog(items) { catalog = structuredClone(items); }, patch(id, values) { Object.assign(catalog.find(item => item.id === id), values); }, setData(demo) { data.set(demo.id, structuredClone(demo)); },
    setScanning(value) { scanning = value; }, async poll() { const callbacks = [...timers.values()]; timers.clear(); for (const cb of callbacks) cb(); await settle(); },
  };
}
const candidates = ui => ui.get('multi-player-list').querySelectorAll('input').map(input => input.dataset.playerId).sort();
const checkedPlayers = ui => ui.get('multi-player-list').querySelectorAll('input').filter(input => input.checked).map(input => input.dataset.playerId).sort();
const reportRequests = ui => ui.requests.filter(([url]) => url.endsWith('/statistics'));

test('cross-demo impact only aggregates selected repeated players and follows map and side scopes', async () => {
  const data = fixtures();
  for (const demo of data) {
    demo.impact = { version: '1', warnings: [], rounds: demo.players.map(player => ({ playerId: player.id, player: player.name, round: 1, half: 1, side: player.id === p1 ? 3 : 2, teamKey: player.id === p1 ? 'ct' : 't', eligible: true })),
      kills: demo.kills.filter(kill => kill.killerId).map(kill => ({ playerId: kill.killerId, player: kill.killer, round: 1, half: 1, side: kill.killerSide, teamKey: kill.killerSide === 3 ? 'ct' : 't', index: kill.index, time: kill.time, score: kill.killerId === p1 ? 4000 : 875 })),
      deaths: demo.kills.map(kill => ({ playerId: kill.victimId, player: kill.victim, round: 1, half: 1, side: kill.victimSide, teamKey: kill.victimSide === 3 ? 'ct' : 't', index: kill.index, time: kill.time, penalty: kill.killerId ? -1000 : null, corePenalty: kill.killerId ? 1000 : null, economyPenalty: 0, excludedReason: kill.killerId ? '' : '世界伤害不计个人惩罚' })) };
  }
  const view = await page({ datasets: data }); await view.click('multi-demos-all'); await view.click('multi-analyze');
  const root = view.get('multi-impact'); assert.equal(impactNode(root, 'combined').textContent, '+15,500');
  assert.equal(impactNode(root, 'players').children.length, 3); assert.doesNotMatch(content(impactNode(root, 'players')), /One match only/);
  await view.click('multi-players-none'); await view.checkPlayer(p1); assert.equal(impactNode(root, 'combined').textContent, '+12,000');
  await view.change('multi-map', 'de_anubis'); assert.equal(impactNode(root, 'combined').textContent, '+6,000'); assert.match(content(impactNode(root, 'death-rows')), /a.dem/); assert.doesNotMatch(content(impactNode(root, 'death-rows')), /c.dem/);
  await view.change('multi-side', '2'); assert.equal(impactNode(root, 'combined').textContent, '—');
  assert.equal(view.parsed.length, 0); assert.equal(view.requests.filter(([url]) => url.endsWith('/statistics')).length, 4);
});

test('cross-demo zero-adjusted mismatch scores retain counts and independently combine death impacts', async () => {
  const data = [fixture('a'), fixture('b')];
  for (const demo of data) {
    demo.ruleVersion = '4'; Object.assign(demo.kills[0], { weapon: 'AK-47', victimWeapon: 'Glock-18', killerValue: 5, victimValue: 1, baseScore: -4, scoreMultiplier: 1 });
    for (const kill of demo.kills.filter(kill => kill.killerId)) Object.assign(kill, { score: 0, scoreAdjustment: 'pistol_mismatch_zero', scoreReason: '特了几个：净值记 0；死亡由死亡影响模块计算。' });
    const event = kill => ({ index: kill.index, time: kill.time, round: 1, half: 1, playerId: kill.killerId, player: kill.killer, side: kill.killerSide, teamKey: kill.killerSide === 3 ? 'ct' : 't' });
    demo.impact = { version: '1', warnings: [], rounds: demo.kills.filter(kill => kill.killerId).map(kill => ({ ...event(kill), eligible: true })), kills: demo.kills.filter(kill => kill.killerId).map(kill => ({ ...event(kill), score: 1000, reason: '1,000 + 125 × 最终净值 0' })), deaths: [{ ...event(demo.kills[0]), index: 1, penalty: -1000, corePenalty: 1000, economyPenalty: 0 }] };
  }
  const ui = await page({ datasets: data }); await ui.click('multi-demos-all'); await ui.click('multi-analyze');
  assert.equal(ui.get('multi-total-score').textContent, '0'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '4'); assert.equal(ui.get('multi-scored').textContent, '4');
  const rows = ui.get('multi-kill-rows').children, highlights = rows.filter(row => row.className === 'pistol-mismatch-row'); assert.equal(highlights.length, 4);
  for (const row of highlights) { assert.equal(row.children[4].textContent, '0'); assert.match(content(row), /基础 -[14] × 1 = -[14] → 特殊规则归零 → 最终 0/); assert.match(content(row), /死亡由死亡影响模块计算/); assert.doesNotMatch(content(row), /基础 -[14] × 1 = 0/); }
  const root = ui.get('multi-impact'); assert.equal(impactNode(root, 'killContribution').textContent, '+4,000'); assert.equal(impactNode(root, 'deathPenalty').textContent, '-2,000'); assert.equal(impactNode(root, 'combined').textContent, '+2,000');
  await ui.change('multi-side', '2'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '2'); assert.equal(ui.get('multi-total-score').textContent, '0'); assert.equal(impactNode(root, 'deathPenalty').textContent, '0'); assert.equal(impactNode(root, 'combined').textContent, '+2,000');
});

test('cross-demo legacy mismatch scores remain authoritative without a zero-adjustment marker', async () => {
  const data = [fixture('a'), fixture('b')]; Object.assign(data[0].kills[1], { score: 0, scoreAdjustment: 'pistol_mismatch_zero' });
  const ui = await page({ datasets: data }); await ui.click('multi-demos-all'); await ui.click('multi-analyze');
  assert.equal(ui.get('multi-total-score').textContent, '+47'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '2');
  const rows = ui.get('multi-kill-rows').children.filter(row => row.className === 'pistol-mismatch-row'); assert.equal(rows[0].children[4].textContent, '0'); assert.match(content(rows[0]), /特殊规则归零/);
  assert.equal(rows[1].children[4].textContent, '-1'); assert.match(content(rows[1]), /基础 -1 × 1 = -1/); assert.doesNotMatch(content(rows[1]), /特殊规则归零/);
});

test('single mode remains separate and multi mode never parses or reads reports until an explicit selection', async () => {
  const ui = await page({ href: 'http://127.0.0.1:9999/statistics.html?demo=a&view=stats#chart' });
  assert.equal(ui.get('stats-single-view').hidden, false); assert.equal(ui.requests.length, 0);
  await ui.click('stats-mode-multi'); assert.equal(ui.get('stats-single-view').hidden, true); assert.equal(ui.get('stats-multi-view').hidden, false);
  assert.match(ui.href(), /mode=multi/); assert.doesNotMatch(ui.href(), /demo=/); assert.match(ui.href(), /view=stats.*#chart/);
  await ui.search('multi-library-search', 'nested a.dem'); await ui.click('multi-refresh-library'); assert.equal(reportRequests(ui).length, 0); assert.equal(ui.parsed.length, 0);
  assert.equal(ui.get('multi-demo-list').querySelectorAll('input').length, 1);
});

test('explicitly loading one then two demos produces repeat candidates only after two distinct successful reports', async () => {
  const ui = await page(); await ui.checkDemo('a'); await ui.click('multi-analyze'); assert.equal(reportRequests(ui).length, 1); assert.match(ui.get('multi-empty').textContent, /需要至少 2 场/);
  await ui.checkDemo('b'); assert.equal(reportRequests(ui).length, 1); assert.match(ui.get('multi-incomplete').textContent, /还有 1 场/);
  await ui.click('multi-analyze'); assert.deepEqual(reportRequests(ui).map(([url]) => url), ['/api/demos/a/statistics', '/api/demos/b/statistics']);
  assert.deepEqual(candidates(ui), [p1, p2]); assert.equal(ui.get('multi-total-score').textContent, '+46'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '2'); assert.equal(ui.get('multi-deaths').textContent, '4');
  assert.equal(ui.parsed.length, 0); await ui.click('multi-analyze'); assert.equal(reportRequests(ui).length, 2, 'unchanged ready reports are reused after checking catalog revision');
  assert.match(content(ui.get('multi-player-list')), /出现 2 场/); assert.match(content(ui.get('multi-player-list')), /Alice a.*Alice b/);
});

test('all-map and single-map scope recalculates qualification without altering hidden demo or player selections', async () => {
  const ui = await page(); await ui.click('multi-demos-all'); await ui.click('multi-analyze');
  assert.deepEqual(candidates(ui), [p1, p2, p3]); assert.equal(ui.get('multi-total-score').textContent, '+92');
  await ui.click('multi-players-none'); await ui.checkPlayer(p1); await ui.checkPlayer(p3); assert.equal(ui.get('multi-total-score').textContent, '+94');
  const selected = ui.saved().playerIds.slice().sort(); await ui.change('multi-map', 'de_anubis');
  assert.deepEqual(candidates(ui), [p1, p2]); assert.deepEqual(checkedPlayers(ui), [p1]); assert.equal(ui.get('multi-total-score').textContent, '+48'); assert.deepEqual(ui.saved().playerIds.slice().sort(), selected); assert.equal(ui.saved().demoIds.length, 4);
  await ui.change('multi-map', 'de_ancient'); assert.deepEqual(candidates(ui), [p1, p3]); assert.deepEqual(checkedPlayers(ui), [p1, p3]); assert.equal(ui.get('multi-total-score').textContent, '+46');
  await ui.change('multi-side', '2'); assert.deepEqual(candidates(ui), [p1, p3]); assert.equal(ui.get('multi-total-score').textContent, '-2'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '2'); assert.equal(ui.get('multi-deaths').textContent, '0');
  assert.equal(reportRequests(ui).length, 4, 'map/player/side changes aggregate cached reports only');
});

test('demo and player all, none, invert and search preserve hidden choices and do not filter candidates by name equality', async () => {
  const ui = await page(); await ui.search('multi-library-search', 'a.dem'); await ui.click('multi-demos-all'); assert.deepEqual(ui.saved().demoIds, ['a']);
  await ui.search('multi-library-search', 'b.dem'); await ui.click('multi-demos-invert'); assert.deepEqual(ui.saved().demoIds, ['a', 'b']); await ui.click('multi-demos-invert'); assert.deepEqual(ui.saved().demoIds, ['a']);
  await ui.search('multi-library-search', ''); await ui.click('multi-demos-all'); await ui.click('multi-analyze');
  await ui.search('multi-player-search', 'Alice b'); assert.deepEqual(candidates(ui), [p1]); await ui.click('multi-players-none'); assert.deepEqual(ui.saved().playerIds, []);
  await ui.click('multi-players-invert'); assert.equal(ui.saved().playerIds.length, 3, 'player bulk actions apply to the complete current scope even when search hides rows');
  await ui.search('multi-player-search', ''); assert.deepEqual(checkedPlayers(ui), [p1, p2, p3]); await ui.click('multi-players-invert'); assert.deepEqual(checkedPlayers(ui), []); assert.equal(ui.get('multi-results').hidden, true);
});

test('unknown-map selected files parse serially while unselected files remain untouched then belong to their real map', async () => {
  const data = fixtures(), catalog = data.map(demo => ({ id: demo.id, name: demo.name, status: 'discovered', available: true, revision: demo.revision }));
  const ui = await page({ datasets: data, catalog }); await ui.checkDemo('a'); await ui.checkDemo('b'); await ui.click('multi-analyze');
  assert.deepEqual(ui.parsed, [['a', { mode: 'playback' }], ['b', { mode: 'playback' }]]); assert.equal(reportRequests(ui).length, 2);
  assert.ok(ui.get('multi-map').children.some(option => option.value === 'de_anubis')); assert.deepEqual(candidates(ui), [p1, p2]);
  assert.equal(ui.requests.some(([url]) => /\/demos\/(c|d)\//.test(url)), false);
});

test('partial failures are explicit, do not contribute eligibility, and a retry loads only the failed report', async () => {
  const ui = await page(); await ui.checkDemo('a'); await ui.checkDemo('b'); ui.fail('/api/demos/b/statistics', '测试缓存读取失败'); await ui.click('multi-analyze');
  assert.match(ui.get('multi-batch-result').textContent, /成功读取 1 \/ 2 场，失败 1 场/); assert.equal(ui.get('multi-failures').hidden, false); assert.match(content(ui.get('multi-failure-list')), /b.dem.*测试缓存读取失败/); assert.deepEqual(candidates(ui), []);
  ui.fail('/api/demos/b/statistics', ''); await ui.click('multi-analyze'); assert.equal(ui.get('multi-failures').hidden, true); assert.deepEqual(candidates(ui), [p1, p2]);
  assert.equal(reportRequests(ui).filter(([url]) => url.includes('/a/')).length, 1); assert.equal(reportRequests(ui).filter(([url]) => url.includes('/b/')).length, 2); assert.equal(ui.get('multi-total-score').textContent, '+46');
});

test('cancel or mode switching ignores late responses and never deletes shared parsing jobs', async () => {
  const ui = await page({ catalog: [{ id: 'a', name: 'a.dem', status: 'discovered', available: true }] }); await ui.checkDemo('a');
  const release = ui.block('/api/library/demos/a/parse'); const analyzing = ui.get('multi-analyze').click(); await settle();
  await ui.click('multi-stop'); release(); await analyzing; await settle();
  assert.equal(reportRequests(ui).length, 0); assert.match(ui.get('multi-batch-result').textContent, /已停止等待/); assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
  const late = ui.block('/api/demos/a/statistics'); const second = ui.get('multi-analyze').click(); await settle(); await ui.click('stats-mode-single'); late(); await second; await settle();
  assert.equal(ui.get('stats-single-view').hidden, false); assert.equal(ui.get('multi-loading').hidden, true); assert.equal(ui.saved().analyzedIds.length, 0);
});

test('reload restores independent preferences and only rereads selected previously analyzed ready caches', async () => {
  const ui = await page(); await ui.click('multi-demos-all'); await ui.click('multi-analyze'); await ui.click('multi-players-none'); await ui.checkPlayer(p1); await ui.change('multi-map', 'de_anubis'); await ui.change('multi-side', '3');
  const saved = ui.saved(), restored = await page({ saved }); assert.deepEqual(restored.saved(), saved); assert.deepEqual(checkedPlayers(restored), [p1]); assert.equal(restored.get('multi-total-score').textContent, '+48'); assert.equal(reportRequests(restored).length, 2); assert.equal(restored.parsed.length, 0);
  const catalog = fixtures().map(demo => ({ id: demo.id, name: demo.name, map: demo.map, status: demo.id === 'b' ? 'discovered' : 'ready', revision: demo.revision, available: true }));
  const pending = await page({ saved, catalog }); assert.equal(reportRequests(pending).length, 1); assert.equal(pending.parsed.length, 0); assert.match(pending.get('multi-incomplete').textContent, /尚未载入/);
});

test('each kill retains its source link, formula and approximation with full-scope counts across pagination', async () => {
  const data = [fixture('a'), fixture('b')]; data[0].kills = Array.from({ length: 125 }, (_, index) => ({ ...data[0].kills[1], index, time: 58 + index }));
  const ui = await page({ datasets: data }); await ui.click('multi-demos-all'); await ui.click('multi-analyze'); await ui.click('multi-players-none'); await ui.checkPlayer(p2);
  assert.equal(ui.get('multi-pistol-mismatch').textContent, '126'); assert.equal(ui.get('multi-total-score').textContent, '-126'); assert.equal(ui.get('multi-kill-rows').children.length, 60);
  let row = ui.get('multi-kill-rows').children[0]; assert.equal(row.dataset.demoId, 'a'); assert.equal(row.dataset.pistolMismatch, 'true'); assert.equal(row.className, 'pistol-mismatch-row'); assert.match(content(row), /基础 -1 × 1 = -1.*近似/); assert.equal(row.querySelectorAll('a')[0].href, '/?demo=a&t=56');
  await ui.click('multi-kills-next'); await ui.click('multi-kills-next'); assert.equal(ui.get('multi-kill-rows').children.length, 6); row = ui.get('multi-kill-rows').children.at(-1); assert.equal(row.dataset.demoId, 'b'); assert.equal(row.querySelectorAll('a')[0].href, '/?demo=b&t=56'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '126');
  assert.equal(new Set(ui.get('multi-kill-rows').children.map(row => row.dataset.killKey)).size, 6);
});

test('selection changes immediately remove old scopes and show missing new reports rather than relabel old data', async () => {
  const ui = await page(); await ui.checkDemo('a'); await ui.checkDemo('b'); await ui.click('multi-analyze');
  await ui.checkDemo('b', false); await ui.checkDemo('c'); assert.equal(ui.get('multi-results').hidden, true); assert.deepEqual(candidates(ui), []); assert.match(ui.get('multi-incomplete').textContent, /还有 1 场/); assert.equal(reportRequests(ui).length, 2);
  await ui.click('multi-analyze'); assert.deepEqual(candidates(ui), [p1]); assert.equal(ui.get('multi-total-score').textContent, '+48');
});

test('explicit analyze and returning to multi invalidate external cache revisions without reparsing ready files', async () => {
  const ui = await page(); await ui.checkDemo('a'); await ui.checkDemo('b'); await ui.click('multi-analyze');
  const newer = fixture('a'); newer.revision = 'a-v2'; newer.kills[0].score = 30; ui.setData(newer); ui.patch('a', { revision: 'a-v2' }); await ui.click('multi-analyze'); assert.equal(ui.get('multi-total-score').textContent, '+52');
  await ui.click('stats-mode-single'); const third = { ...newer, revision: 'a-v3' }; third.kills = [{ ...newer.kills[0], score: 40 }]; ui.setData(third); ui.patch('a', { revision: 'a-v3' }); await ui.click('stats-mode-multi'); assert.equal(ui.get('multi-results').hidden, true); assert.match(ui.get('multi-incomplete').textContent, /还有 1 场/);
  await ui.click('multi-analyze'); assert.equal(ui.get('multi-total-score').textContent, '+63'); assert.equal(ui.parsed.length, 0);
});

test('an older statistics response is rejected if a concurrent catalog refresh already observed a replacement revision', async () => {
  const ui = await page(); await ui.checkDemo('a'); await ui.checkDemo('b');
  const old = fixture('a'), release = ui.block('/api/demos/a/statistics', old); const loading = ui.get('multi-analyze').click(); await settle();
  const newer = fixture('a'); newer.revision = 'a-v2'; newer.kills[0].score = 50; ui.setData(newer); ui.patch('a', { revision: 'a-v2' });
  await ui.click('stats-mode-multi'); release(); await loading; await settle();
  assert.equal(ui.get('multi-failures').hidden, false); assert.match(content(ui.get('multi-failure-list')), /缓存已更新.*旧响应未计入/); assert.deepEqual(candidates(ui), []);
  await ui.click('multi-analyze'); assert.equal(ui.get('multi-total-score').textContent, '+72'); assert.equal(ui.parsed.length, 0);
});

test('a catalog response made before report commit is refreshed instead of erasing the newly parsed data', async () => {
  const data = [fixture('a'), fixture('b')], catalog = data.map(demo => ({ id: demo.id, name: demo.name, status: 'discovered', available: true, revision: demo.revision }));
  const ui = await page({ datasets: data, catalog }); await ui.click('multi-demos-all');
  const releaseReport = ui.block('/api/demos/a/statistics'), loading = ui.get('multi-analyze').click(); await settle();
  const releaseCatalog = ui.block('/api/library/demos', { demos: catalog, scanning: false }), updating = ui.get('stats-mode-multi').click(); await settle();
  releaseReport(); await loading; await settle(); assert.equal(ui.get('multi-total-score').textContent, '+46');
  releaseCatalog(); await updating; await settle(); assert.equal(ui.get('multi-total-score').textContent, '+46'); assert.equal(ui.get('multi-incomplete').hidden, true); assert.equal(ui.get('multi-results').hidden, false);
  assert.equal(reportRequests(ui).length, 2);
});

function multiFolderCatalog() {
  return fixtures().map(demo => ({ id: demo.id, name: demo.name, map: demo.map, revision: demo.revision, status: 'ready', available: demo.id !== 'd', sources: demo.id === 'a' ? [{ path: '赛事/决赛/a.dem', kind: 'dem', available: true }, { path: '备份/a.zip', member: '内部/a.dem', kind: 'zip', available: true }] : demo.id === 'b' ? [{ path: '赛事/决赛/b.dem', kind: 'dem', available: true }] : demo.id === 'c' ? [{ path: 'c.zip', member: '比赛/c.dem', kind: 'zip', available: true }] : [{ path: '已移动/d.dem', kind: 'dem', available: false }] }));
}
function visibleMultiIds(ui) { return ui.get('multi-demo-list').querySelectorAll('input').map(input => input.dataset.demoId); }

test('multi folder grouping repeats display rows but synchronizes one selection and applies invert once per visible ID', async () => {
  const ui = await page({ catalog: multiFolderCatalog() }); await ui.change('multi-library-view', 'folders');
  assert.equal(visibleMultiIds(ui).filter(id => id === 'a').length, 2); assert.match(ui.get('multi-demo-count').textContent, /显示 4 \/ 4/);
  await ui.checkDemo('a'); assert.ok(ui.get('multi-demo-list').querySelectorAll('input').filter(input => input.dataset.demoId === 'a').every(input => input.checked)); assert.deepEqual(ui.saved().demoIds, ['a']);
  await ui.click('multi-demos-invert'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['b', 'c', 'd']);
  await ui.click('multi-demos-invert'); assert.deepEqual(ui.saved().demoIds, ['a']);
  await ui.click('multi-demos-all'); await ui.click('multi-analyze'); assert.equal(reportRequests(ui).length, 4); assert.equal(ui.get('multi-total-score').textContent, '+92'); assert.equal(ui.get('multi-pistol-mismatch').textContent, '4');
});

test('multi folder and search are list-only intersections while map still defines statistics and hidden selections survive bulk actions', async () => {
  const ui = await page({ catalog: multiFolderCatalog() }); await ui.click('multi-demos-all'); await ui.click('multi-analyze');
  const chosen = ui.saved().demoIds.slice(), score = ui.get('multi-total-score').textContent, ids = candidates(ui);
  await ui.change('multi-library-view', 'folders'); await ui.change('multi-library-folder', 'path:赛事/决赛');
  assert.deepEqual(visibleMultiIds(ui), ['a', 'b']); assert.deepEqual(ui.saved().demoIds, chosen); assert.deepEqual(candidates(ui), ids); assert.equal(ui.get('multi-total-score').textContent, score);
  await ui.search('multi-library-search', 'a.dem'); assert.deepEqual(visibleMultiIds(ui), ['a']); await ui.click('multi-demos-none'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['b', 'c', 'd']);
  await ui.click('multi-demos-invert'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'b', 'c', 'd']);
  await ui.search('multi-library-search', ''); await ui.change('multi-map', 'de_ancient'); assert.deepEqual(visibleMultiIds(ui), []); assert.equal(ui.get('multi-total-score').textContent, '+46');
  await ui.change('multi-library-folder', 'root'); assert.deepEqual(visibleMultiIds(ui), ['c']); assert.equal(ui.get('multi-total-score').textContent, '+46');
  await ui.change('multi-library-folder', 'unavailable'); assert.deepEqual(visibleMultiIds(ui), ['d']); assert.equal(ui.get('multi-total-score').textContent, '+46');
  await ui.change('multi-library-view', 'all'); assert.deepEqual(visibleMultiIds(ui), ['c', 'd']); assert.equal(ui.get('multi-library-folder-field').hidden, true); assert.equal(reportRequests(ui).length, 4);
});

test('multi folder preferences and hidden selected IDs restore without restricting eligibility or auto-parsing unavailable inputs', async () => {
  const catalog = multiFolderCatalog(), ui = await page({ catalog }); await ui.click('multi-demos-all'); await ui.click('multi-analyze'); await ui.click('multi-players-none'); await ui.checkPlayer(p1);
  await ui.change('multi-library-view', 'folders'); await ui.change('multi-library-folder', 'path:备份'); const saved = ui.saved();
  const restored = await page({ catalog, saved }); assert.deepEqual(restored.saved(), saved); assert.deepEqual(visibleMultiIds(restored), ['a']); assert.deepEqual(checkedPlayers(restored), [p1]); assert.equal(restored.get('multi-total-score').textContent, '+96'); assert.equal(restored.parsed.length, 0);
  const missing = await page({ catalog, saved: { ...saved, libraryFolder: 'path:temporarily-moved' } }); assert.deepEqual(visibleMultiIds(missing), []); assert.equal(missing.get('multi-library-folder').value, 'path:temporarily-moved'); assert.deepEqual(missing.saved().demoIds, saved.demoIds); assert.equal(missing.get('multi-total-score').textContent, '+96');
  const fresh = await page({ catalog: catalog.map(item => ({ ...item, status: 'discovered' })), saved: { ...saved, analyzedIds: [] } }); assert.equal(reportRequests(fresh).length, 0); assert.equal(fresh.parsed.length, 0); assert.equal(fresh.saved().libraryFolder, 'path:备份');
});

function folderAction(ui, key, action) {
  const button = ui.get('multi-demo-list').querySelectorAll('button').find(button => button.dataset.folderKey === key && button.dataset.folderAction === action);
  assert.ok(button, `Missing ${key} ${action}`); return button;
}
async function useFolderAction(ui, key, action) { await folderAction(ui, key, action).click(); await settle(); }
function folderBulkFixtures() {
  const data = [...fixtures(), fixture('e')], catalog = multiFolderCatalog();
  catalog.find(demo => demo.id === 'c').sources = [{ path: '赛事/决赛/c.dem', kind: 'dem', available: true }];
  catalog.push({ id: 'e', name: 'e.dem', map: 'de_anubis', revision: 'e-v1', status: 'ready', available: true, sources: [{ path: '备份/e.dem', kind: 'dem', available: true }] });
  return { datasets: data, catalog };
}

test('folder actions include search and map hidden members while preserving selected and unselected IDs unique to other folders', async () => {
  const ui = await page({ ...folderBulkFixtures(), saved: { demoIds: ['d'], map: 'de_anubis', libraryView: 'folders', libraryQuery: 'a.dem', playerIds: [p1], side: '3' } });
  const key = 'path:赛事/决赛', requests = ui.requests.length;
  assert.deepEqual(visibleMultiIds(ui), ['a', 'a']);
  assert.match(folderAction(ui, key, 'all').title, /全部 3 场.*隐藏的 2 场/);
  await useFolderAction(ui, key, 'all'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'b', 'c', 'd']);
  assert.ok(ui.get('multi-demo-list').querySelectorAll('input').filter(input => input.dataset.demoId === 'a').every(input => input.checked), 'shared demo checkboxes stay in sync in both folders');
  await useFolderAction(ui, key, 'invert'); assert.deepEqual(ui.saved().demoIds, ['d']);
  await useFolderAction(ui, key, 'invert'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'b', 'c', 'd']);
  await useFolderAction(ui, key, 'none'); assert.deepEqual(ui.saved().demoIds, ['d']);
  assert.equal(ui.saved().demoIds.includes('e'), false, 'unselected ID unique to another folder stays unselected');
  assert.equal(ui.get('multi-map').value, 'de_anubis'); assert.equal(ui.get('multi-side').value, '3'); assert.deepEqual(ui.saved().playerIds, [p1]);
  assert.equal(ui.requests.length, requests); assert.equal(ui.parsed.length, 0); assert.equal(reportRequests(ui).length, 0);
});

test('visible-list bulk remains limited to visible demos while folder actions invert shared IDs once and persist hidden choices', async () => {
  const options = folderBulkFixtures(), ui = await page({ ...options, saved: { demoIds: ['d'], libraryView: 'folders', libraryQuery: 'a.dem', map: 'de_anubis' } });
  await ui.click('multi-demos-all'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'd']);
  await useFolderAction(ui, 'path:赛事/决赛', 'invert'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['b', 'c', 'd'], 'shared a is inverted once even though visible in two groups');
  await useFolderAction(ui, 'path:备份', 'all'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'b', 'c', 'd', 'e']);
  const saved = ui.saved(), restored = await page({ ...options, saved }); assert.deepEqual(restored.saved(), saved); assert.equal(restored.parsed.length, 0); assert.equal(reportRequests(restored).length, 0);
  await restored.click('multi-analyze'); assert.deepEqual(reportRequests(restored).map(([url]) => url).sort(), ['/api/demos/a/statistics', '/api/demos/b/statistics', '/api/demos/e/statistics']);
  assert.equal(restored.saved().demoIds.includes('c'), true, 'the hidden-map selection survives analysis but is not parsed for the current map');
});

test('folder actions skip unreadable unselected jobs, allow clearing unreadable selected jobs and retain ready cache eligibility', async () => {
  const catalog = multiFolderCatalog();
  catalog.push({ id: 'u', name: 'u.dem', status: 'discovered', available: false, sources: [{ path: 'lost/u.dem', available: false }] }, { id: 'f', name: 'f.dem', status: 'error', available: false, sources: [{ path: 'lost/f.dem', available: false }] });
  const ui = await page({ catalog, saved: { demoIds: ['f'], libraryView: 'folders', libraryFolder: 'unavailable' } });
  await useFolderAction(ui, 'unavailable', 'all'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['d', 'f'], 'ready d has usable cache, unavailable u is not newly selected');
  await useFolderAction(ui, 'unavailable', 'invert'); assert.deepEqual(ui.saved().demoIds, []);
  await useFolderAction(ui, 'unavailable', 'invert'); assert.deepEqual(ui.saved().demoIds, ['d']);
  await useFolderAction(ui, 'unavailable', 'none'); assert.deepEqual(ui.saved().demoIds, []); assert.equal(ui.parsed.length, 0); assert.equal(reportRequests(ui).length, 0);
});

test('busy folder buttons are disabled and guarded against dispatched events until loading and scanning finish', async () => {
  const ui = await page({ catalog: multiFolderCatalog(), saved: { demoIds: ['a', 'b'], libraryView: 'folders' } });
  const release = ui.block('/api/demos/a/statistics'), loading = ui.get('multi-analyze').click(); await settle();
  const before = ui.saved().demoIds.slice(), key = 'path:赛事/决赛';
  for (const action of ['all', 'none', 'invert']) { const button = folderAction(ui, key, action); assert.equal(button.disabled, true); await button.dispatch('click'); }
  assert.deepEqual(ui.saved().demoIds, before); release(); await loading; await settle(); assert.equal(folderAction(ui, key, 'none').disabled, false);
  ui.setScanning(true); await ui.click('multi-refresh-library'); const button = folderAction(ui, key, 'none'); assert.equal(button.disabled, true); await button.dispatch('click'); assert.deepEqual(ui.saved().demoIds, before);
  ui.setScanning(false); await ui.poll(); assert.equal(folderAction(ui, key, 'none').disabled, false); await useFolderAction(ui, key, 'none'); assert.deepEqual(ui.saved().demoIds, []);
});

function multiFolder(ui, key) {
  const list = ui.get('multi-demo-list'), button = list.querySelectorAll('button').find(el => el.dataset.folderToggle === key), body = list.querySelectorAll('div').find(el => el.dataset.folderBody === key);
  assert.ok(button && body, `Missing folder ${key}`); return { button, body };
}

test('multi folder folding changes no loaded scope, metrics, selections or result nodes and survives search, refresh and mode changes', async () => {
  const catalog = multiFolderCatalog(), ui = await page({ catalog }); await ui.click('multi-demos-all'); await ui.click('multi-analyze'); await ui.click('multi-players-none'); await ui.checkPlayer(p1); await ui.change('multi-map', 'de_anubis'); await ui.change('multi-side', '3'); await ui.change('multi-library-view', 'folders');
  const before = ui.saved(), row = ui.get('multi-kill-rows').children[0], requests = ui.requests.length, key = 'path:赛事/决赛', group = multiFolder(ui, key);
  assert.equal(group.button.type, 'button'); assert.equal(group.button['aria-controls'], group.body.id); assert.equal(group.button['aria-expanded'], 'true');
  await group.button.click(); assert.equal(group.body.hidden, true); assert.equal(group.button['aria-expanded'], 'false'); assert.equal(multiFolder(ui, 'path:备份').body.hidden, false);
  await ui.click('multi-library-collapse-all'); assert.equal(ui.get('multi-kill-rows').children[0], row, 'folding never re-aggregates or redraws result rows');
  assert.equal(ui.get('multi-total-score').textContent, '+48'); assert.equal(ui.get('multi-side').value, '3'); assert.equal(ui.get('multi-map').value, 'de_anubis');
  for (const field of ['demoIds', 'playerIds', 'analyzedIds']) assert.deepEqual(ui.saved()[field], before[field]); assert.equal(ui.requests.length, requests);
  await ui.search('multi-library-search', 'a.dem'); assert.equal(multiFolder(ui, key).body.hidden, true); await ui.search('multi-library-search', '');
  await ui.click('multi-refresh-library'); assert.equal(multiFolder(ui, key).body.hidden, true); assert.equal(reportRequests(ui).length, 4);
  await ui.change('multi-library-view', 'all'); assert.equal(ui.get('multi-library-fold-controls').hidden, true); await ui.change('multi-library-view', 'folders');
  await ui.click('stats-mode-single'); await ui.click('stats-mode-multi'); assert.equal(multiFolder(ui, key).body.hidden, true); assert.equal(ui.get('multi-library-fold-controls').hidden, false);
  const restored = await page({ catalog, saved: ui.saved() }); assert.equal(multiFolder(restored, key).body.hidden, true); assert.deepEqual(checkedPlayers(restored), [p1]); assert.equal(restored.get('multi-total-score').textContent, '+48'); assert.equal(restored.parsed.length, 0);
});

test('collapsed multi groups retain accessible bulk buttons, include hidden children and shared IDs only once without parsing', async () => {
  const options = folderBulkFixtures(), ui = await page({ ...options, saved: { demoIds: ['d'], libraryView: 'folders', libraryQuery: 'a.dem', map: 'de_anubis', playerIds: [p1] } }), key = 'path:赛事/决赛';
  const requests = ui.requests.length; await ui.click('multi-library-collapse-all');
  assert.equal(multiFolder(ui, key).body.hidden, true); assert.equal(multiFolder(ui, key).body.querySelectorAll('button').some(button => button.dataset.folderAction), false, 'bulk actions remain outside collapsed children');
  assert.match(content(ui.get('multi-demo-list')), /赛事\/决赛 · 3 场/);
  await useFolderAction(ui, key, 'all'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'b', 'c', 'd']); assert.equal(multiFolder(ui, key).body.hidden, true);
  await useFolderAction(ui, key, 'invert'); assert.deepEqual(ui.saved().demoIds, ['d']);
  await ui.click('multi-demos-all'); assert.deepEqual(ui.saved().demoIds.slice().sort(), ['a', 'd'], 'global action uses list filters, not expanded DOM rows');
  await useFolderAction(ui, key, 'none'); assert.deepEqual(ui.saved().demoIds, ['d']);
  assert.deepEqual(ui.saved().playerIds, [p1]); assert.equal(ui.requests.length, requests); assert.equal(reportRequests(ui).length, 0); assert.equal(ui.parsed.length, 0);
  const restored = await page({ ...options, saved: ui.saved() }); assert.equal(multiFolder(restored, key).body.hidden, true); assert.deepEqual(restored.saved().demoIds, ['d']); assert.equal(reportRequests(restored).length, 0);
});

test('multi collapse defaults include new folders and unavailable groups while explicit overrides restore and expand-all resets them', async () => {
  const catalog = multiFolderCatalog(), ui = await page({ catalog, saved: { libraryView: 'folders', demoIds: ['a'], playerIds: [p1] } });
  await ui.search('multi-library-search', 'a.dem'); await ui.click('multi-library-collapse-all'); await multiFolder(ui, 'path:备份').button.click();
  assert.deepEqual(ui.saved().folderExpansion, { defaultExpanded: false, overrides: { 'path:备份': true } });
  await ui.search('multi-library-search', ''); assert.equal(multiFolder(ui, 'root').body.hidden, true); assert.equal(multiFolder(ui, 'unavailable').body.hidden, true);
  ui.patch('c', { sources: [{ path: '新录像/c.zip', member: '内部/c.dem', available: true }] }); await ui.click('multi-refresh-library'); assert.equal(multiFolder(ui, 'path:新录像').body.hidden, true); assert.equal(multiFolder(ui, 'path:备份').body.hidden, false);
  const restored = await page({ catalog, saved: ui.saved() }); assert.equal(multiFolder(restored, 'path:备份').body.hidden, false); assert.equal(multiFolder(restored, 'root').body.hidden, true);
  await restored.click('multi-library-expand-all'); assert.deepEqual(restored.saved().folderExpansion, { defaultExpanded: true, overrides: {} }); assert.deepEqual(restored.saved().demoIds, ['a']); assert.deepEqual(restored.saved().playerIds, [p1]);
  assert.ok(restored.get('multi-demo-list').querySelectorAll('div').filter(el => el.dataset.folderBody).every(el => !el.hidden)); assert.equal(reportRequests(restored).length, 0); assert.equal(restored.parsed.length, 0);
});

test('multi malformed expansion preferences remain usable without changing saved selections or parsing', async () => {
  for (const folderExpansion of [null, [], 'invalid', { defaultExpanded: 'false', overrides: { root: 'false' } }]) {
    const ui = await page({ catalog: multiFolderCatalog(), saved: { libraryView: 'folders', demoIds: ['a'], folderExpansion } });
    assert.equal(multiFolder(ui, 'root').body.hidden, false); await multiFolder(ui, 'root').button.click(); assert.deepEqual(ui.saved().folderExpansion, { defaultExpanded: true, overrides: { root: false } });
    assert.deepEqual(ui.saved().demoIds, ['a']); assert.equal(reportRequests(ui).length, 0); assert.equal(ui.parsed.length, 0);
  }
});
