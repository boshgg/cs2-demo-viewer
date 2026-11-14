const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const statistics = require('../web/statistics.js');
const library = require('../web/replay-library.js');
const html = fs.readFileSync(path.join(__dirname, '../web/statistics.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const good = body => ({ ok: true, json: async () => body });
const rejected = (error, status = 409) => ({ ok: false, status, json: async () => ({ error }) });
function fixture(id = 'match') {
  const player = (id, name) => ({ id, name, money: 150, armor: 100, weapon: 'AK-47', weaponClass: 'rifle', grenades: 3, inventory: [{ type: 'smoke', count: 1 }, { type: 'flash', count: 2 }], utilityReady: true, utilityReason: '余钱不足购买任何可携带道具', eco: false, reason: '主武器步枪，护甲完整' });
  const a = [player('p1', 'Alice'), player('p2', 'Bob')], b = [player('v1', 'Cathy'), player('v2', 'David')];
  const economy = (side, key, name, players, source = 'freeze_end') => ({ side, teamKey: key, name, type: 'full', label: '全起', matchedTypes: ['full', 'mixed'], source, time: 15, complete: true, reason: '至少 3 人满足装备与道具条件（测试证据）', overlap: true, players });
  const rounds = [{ number: 1, start: 0, end: 100, freezeEnd: 15, half: 'first', halfSource: 'convar', ct: economy(3, 'alpha', 'Alpha', a), t: economy(2, 'beta', 'Beta', b, 'sampled_cache') }, { number: 13, start: 1200, end: 1300, freezeEnd: 1215, half: 'second', halfSource: 'default_mr12', ct: economy(3, 'beta', 'Beta', b), t: economy(2, 'alpha', 'Alpha', a) }];
  const kill = (index, round, killerId, victimId, weapon, victimWeapon, killerValue, victimValue, score, excludedReason = '') => {
    const second = round === 13, killerAlpha = killerId.startsWith('p'), victimAlpha = victimId.startsWith('p');
    const name = id => [...a, ...b].find(player => player.id === id)?.name || '';
    return { index, round, time: (second ? 1200 : 0) + index * 10 + 20, half: second ? 'second' : 'first', killerId, killer: name(killerId), victimId, victim: name(victimId), killerTeamKey: killerAlpha ? 'alpha' : 'beta', victimTeamKey: victimAlpha ? 'alpha' : 'beta', killerSide: killerAlpha !== second ? 3 : 2, victimSide: victimAlpha !== second ? 3 : 2, weapon, victimWeapon, killerValue, victimValue, score, excludedReason, weaponSource: 'death_event', weaponTime: 20, approx: false, headshot: index === 1 };
  };
  const kills = [kill(1, 1, 'p1', 'v1', 'Glock-18', 'AWP', 1, 7, 6), kill(2, 1, 'p1', 'v2', 'AK-47', 'Knife', 5, null, null, '受害者当时手持刀，不能按背包武器计分'), { ...kill(3, 1, 'p2', 'v1', 'AK-47', 'MP9', 5, 2, -3), approx: true, weaponSource: 'sampled_cache' }, kill(4, 13, 'v1', 'p1', 'AWP', 'AK-47', 7, 5, -2), { ...kill(5, 13, 'p1', 'v2', 'MP9', 'M4A1-S', 2, 5, 3), approx: true, weaponSource: 'previous_tick' }, kill(6, 13, 'p1', 'v1', 'Knife', 'AWP', null, 7, null, '击杀武器为刀，不计分')];
  return { id, name: `${id}.dem`, map: 'de_mirage', ruleVersion: '1', warnings: [], rules: [{ code: 'full', label: '全起', priority: 2, description: '多数满足完整装备条件。' }, { code: 'mixed', label: '混合起', priority: 4, description: '双方装备类型不同。' }], rounds, kills, players: [...a, ...b].map(({ id, name }) => ({ id, name })), teams: [{ teamKey: 'alpha', label: 'Alpha' }, { teamKey: 'beta', label: 'Beta' }], halves: [{ half: 'first', label: '上半场' }, { half: 'second', label: '下半场' }] };
}
function content(element) { return [element.textContent, ...element.children.map(content)].filter(Boolean).join(' '); }
async function page(options = {}) {
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
    dispatch(event) { return Promise.all((this.listeners[event] || []).map(callback => callback({ target: this }))); }
    click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
    get childElementCount() { return this.children.length; }
    querySelectorAll(tag) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tag)]).filter(child => child.tagName === tag); }
    setAttribute(key, value) { this[key] = value; }
  }
  const elements = new Map(), requests = [], payloads = [], reparses = [], timers = new Map(), data = new Map((options.datasets || [fixture()]).map(item => [item.id, item]));
  const catalog = options.catalog || [...data.values()].map(item => ({ id: item.id, name: item.name, map: item.map, status: 'ready', sources: [{ path: `2026/nested/${item.name}`, kind: 'dem' }], sourceCount: 1, available: true }));
  const gates = new Map(), location = { href: options.href || 'http://127.0.0.1:9999/statistics.html' };
  const preferences = new Map(options.folderSaved ? [['cs2-statistics-library-view-v1', JSON.stringify(options.folderSaved)]] : []);
  let refreshError = '', reparseError = '', catalogError = '', nextTimer = 0, statisticsError = options.statisticsError || '';
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match, element = new Element(tag);
    element.hidden = /\bhidden\b/.test(attributes); element.disabled = /\bdisabled\b/.test(attributes); element.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '';
    elements.set(id, element);
  }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const element = elements.get(match[1]);
    for (const option of match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) { const child = new Element('option'); child.value = option[1]; child.textContent = option[2]; element.append(child); }
    element.value = element.children[0]?.value || '';
  }
  const get = id => { assert.ok(elements.has(id), `Missing HTML #${id}`); return elements.get(id); };
  const fetcher = async (url, init = {}) => {
    requests.push([url, init.method || 'GET']);
    if (gates.has(url)) await gates.get(url);
    if (url === '/api/library/demos') return catalogError ? rejected(catalogError, 500) : good(structuredClone({ demos: catalog, scanning: false }));
    if (url === '/api/library') return good({ enabled: true, directory: 'F:\\viewer\\demo', scanning: false });
    if (url === '/api/library/refresh') return refreshError ? rejected(refreshError, 500) : good({ scanning: false });
    if (url === '/api/library/reparse') {
      const body = JSON.parse(init.body); reparses.push(body);
      if (reparseError) return rejected(reparseError, 500);
      const result = options.reparseResponse || { queued: body.ids, active: [], skipped: [] };
      for (const id of [...(result.queued || []), ...(result.active || [])]) { const item = catalog.find(demo => demo.id === id); if (item) item.reparse = { status: 'queued', progress: 0 }; }
      for (const skipped of result.skipped || []) { const item = catalog.find(demo => demo.id === skipped.id); if (item) item.reparse = { status: 'error', error: skipped.error }; }
      if (options.failCatalogAfterReparse) catalogError = '暂时无法读取目录状态';
      return good(result);
    }
    const parse = /^\/api\/library\/demos\/([^/]+)\/parse$/.exec(url);
    if (parse) { const id = decodeURIComponent(parse[1]); payloads.push([id, JSON.parse(init.body)]); return options.parseError ? rejected(options.parseError) : good({ id, status: 'queued', cached: false }); }
    const demo = /^\/api\/demos\/([^/]+)\/(statistics|status)$/.exec(url);
    if (demo) {
      if (demo[2] === 'status') return good({ id: demo[1], status: 'ready', progress: 1 });
      if (statisticsError) return rejected(statisticsError, 500);
      return data.has(demo[1]) ? good(data.get(demo[1])) : rejected('录像不存在', 404);
    }
    throw new Error(`Unexpected API ${url}`);
  };
  const app = statistics.create({ document: { getElementById: get, createElement: tag => new Element(tag) }, window: { ReplayLibrary: library, location, history: { state: null, replaceState: (_state, _title, url) => { location.href = String(url); } } }, storage: { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) }, fetch: fetcher, sleep: async () => {}, setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  await app.ready; await settle();
  return { get, requests, payloads, reparses, timers, href: () => location.href, folderSaved: () => JSON.parse(preferences.get('cs2-statistics-library-view-v1') || '{}'),
    async choose(id) { const button = get('stats-library-list').querySelectorAll('button').find(button => button.dataset.demoId === id); assert.ok(button); await button.click(); await settle(); },
    async change(id, value) { get(id).value = value; await get(id).dispatch('change'); await settle(); },
    async search(query) { get('stats-library-search').value = query; await get('stats-library-search').dispatch('input'); },
    block(url) { let release; gates.set(url, new Promise(resolve => { release = () => { gates.delete(url); resolve(); }; })); return release; },
    setRefreshError(message) { refreshError = message; },
    setStatisticsError(message) { statisticsError = message; },
    setReparseError(message) { reparseError = message; },
    setCatalogError(message) { catalogError = message; },
    setDataset(item) { data.set(item.id, item); },
    setCatalog(id, patch) { const item = catalog.find(demo => demo.id === id); assert.ok(item); Object.assign(item, patch); },
    async poll() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
  };
}

test('cross-demo mode never auto-parses the single-demo URL in the hidden panel', async () => {
  const view = await page({ href: 'http://127.0.0.1:9999/statistics.html?mode=multi&demo=match', catalog: [{ id: 'match', name: 'match.dem', status: 'discovered', available: true }] });
  assert.equal(view.payloads.length, 0);
  assert.ok(!view.requests.some(([url]) => url.endsWith('/statistics')));
});

test('a statistics response identifies its own revision when the catalog predates a completed reparse', async () => {
  const data = { ...fixture(), revision: 'match-new' };
  const loaded = await statistics.loadStatistics({ id: 'match', status: 'ready', revision: 'match-old' }, { fetch: async url => { assert.equal(url, '/api/demos/match/statistics'); return good(data); } });
  assert.equal(loaded.revision, 'match-new');
});

test('statistical totals are sums, include zero and negative scores, and retain exclusions', () => {
  const data = fixture(), total = statistics.summarize(data.kills);
  assert.deepEqual(total, { kills: 6, scoredKills: 4, excludedKills: 2, score: 4, deaths: 6, headshots: 1, pistolMismatchKills: 0 });
  assert.equal(statistics.summarize([...data.kills, { ...data.kills[0], score: 0 }]).scoredKills, 5);
  assert.equal(statistics.summarize(data.kills, { team: 'alpha' }).score, 6);
  assert.equal(statistics.summarize(data.kills, { player: 'p1' }).score, 9);
  assert.equal(statistics.summarize(data.kills, { player: 'p1' }).deaths, 1);
  assert.equal(statistics.summarize(data.kills, { team: 'alpha', half: 'second', side: '2' }).score, 3);
});

test('player ranking follows stable player/team IDs across side changes and preserves zero-score players', () => {
  const data = fixture(), players = statistics.rankPlayers(data, { team: 'alpha' });
  assert.deepEqual(players.map(player => [player.id, player.summary.score]), [['p1', 9], ['p2', -3]]);
  assert.deepEqual(statistics.rankPlayers(data, { player: 'v2' }).map(player => [player.id, player.summary.score, player.summary.deaths]), [['v2', 0, 2]]);
  assert.equal(statistics.visibleKills(data.kills, { round: '1', player: 'p1' }).length, 2);
});

test('statistics page initialization, library search and refresh never parse or load an unselected match', async () => {
  const ui = await page({ datasets: [fixture('first'), fixture('other')] });
  assert.equal(ui.get('stats-content').hidden, true); assert.equal(ui.get('stats-empty').hidden, false);
  await ui.search('nested other'); assert.equal(ui.get('stats-library-list').children.length, 1);
  await ui.get('stats-refresh-library').click(); await settle();
  assert.equal(ui.requests.some(([url]) => /\/statistics$|\/parse$/.test(url)), false);
});

test('selecting a ready match loads only its statistics, without a full replay or a parse request', async () => {
  const ui = await page({ datasets: [fixture('one'), fixture('two')] });
  await ui.choose('one');
  assert.equal(ui.get('stats-total-score').textContent, '+4'); assert.equal(ui.get('stats-scored-kills').textContent, '4');
  assert.equal(ui.get('stats-excluded-kills').textContent, '2'); assert.equal(ui.get('stats-content').hidden, false);
  assert.deepEqual(ui.requests.filter(([url]) => url.startsWith('/api/demos/')), [['/api/demos/one/statistics', 'GET']]);
  assert.equal(ui.payloads.length, 0); assert.match(ui.href(), /demo=one/);
});

test('unparsed selections request playback mode, poll only that recording, then fetch statistics', async () => {
  const data = fixture('chosen'), ui = await page({ datasets: [data], catalog: [{ id: data.id, name: data.name, status: 'discovered', available: true }] });
  await ui.choose('chosen');
  assert.deepEqual(ui.payloads, [['chosen', { mode: 'playback' }]]);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/chosen/status').length, 1);
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/chosen/statistics').length, 1);
  assert.equal(ui.requests.some(([url]) => url === '/api/demos/chosen'), false);
  assert.equal(ui.get('stats-content').hidden, false);
});

test('economy overlap, cash, carried weapon, grenade sufficiency and sampled approximations remain visible', async () => {
  const ui = await page(); await ui.choose('match');
  const economy = content(ui.get('stats-economy-teams'));
  assert.match(economy, /至少 3 人/); assert.match(economy, /命中类别：全起、混合起/);
  assert.match(economy, /余钱不足购买任何可携带道具/); assert.match(economy, /AK-47/); assert.match(economy, /\$150/); assert.match(economy, /3 个/); assert.match(economy, /烟雾弹 ×1/);
  assert.match(economy, /近似 · 旧缓存采样/); assert.match(ui.get('stats-quality').textContent, /近似数据/);
  const kills = content(ui.get('stats-kill-rows'));
  assert.match(kills, /受害者当时手持刀，不能按背包武器计分/); assert.match(kills, /近似 · 前一 tick/); assert.match(kills, /Knife \/ —/);
  assert.equal(ui.get('stats-kill-rows').children.length, 6);
});

test('team, player, side, half and round filters form an intersection while deaths use victim identity', async () => {
  const ui = await page(); await ui.choose('match');
  await ui.change('stats-team', 'alpha'); assert.equal(ui.get('stats-total-score').textContent, '+6');
  await ui.change('stats-half', 'second'); await ui.change('stats-side', '2'); assert.equal(ui.get('stats-total-score').textContent, '+3');
  await ui.change('stats-player', 'p1'); assert.equal(ui.get('stats-deaths').textContent, '1');
  await ui.change('stats-round', '1'); assert.equal(ui.get('stats-total-score').textContent, '0'); assert.match(content(ui.get('stats-kill-rows')), /没有记录/);
  await ui.get('stats-reset').click(); await settle(); assert.equal(ui.get('stats-total-score').textContent, '+4');
  assert.equal(ui.get('stats-player-rows').children.length, 4);
});

test('round details display half inference and link back to the selected recording at its start', async () => {
  const ui = await page(); await ui.choose('match');
  await ui.change('stats-detail-round', '13');
  assert.match(ui.get('stats-economy-note').textContent, /默认 MR12 推断/);
  assert.equal(ui.get('stats-round-replay').href, '/?demo=match&t=1200');
  assert.equal(ui.get('stats-next-round').disabled, true);
  await ui.get('stats-previous-round').click(); assert.equal(ui.get('stats-detail-round').value, '1');
  const killLinks = ui.get('stats-kill-rows').querySelectorAll('a'); assert.equal(killLinks[0].href, '/?demo=match&t=28');
});

test('empty and unknown equipment remain unknown rather than becoming a false eco or zero cash', async () => {
  const data = fixture(); data.rounds[0].ct = { name: '', side: 3, type: 'unknown', label: '未知', source: 'unknown', complete: false, reason: '缺少完整冻结快照', players: [{ id: 'p1', name: 'Alice', money: null, armor: null, weapon: '', grenades: null, utilityReady: null }] };
  data.kills = data.kills.map(kill => ({ ...kill, approx: false, weaponSource: 'death_event' })); data.rounds[0].t.source = 'freeze_end';
  const ui = await page({ datasets: [data] }); await ui.choose('match');
  assert.match(ui.get('stats-quality').textContent, /存在缺失记录/);
  const text = content(ui.get('stats-economy-teams')); assert.match(text, /缺少完整冻结快照/); assert.match(text, /武器未知/); assert.match(text, /护甲 未知/);
  assert.equal(content(ui.get('stats-economy-teams').children[0]).includes('$0'), false);
});

test('kill detail pagination keeps all entries and resets when filters change', async () => {
  const data = fixture(); data.kills = Array.from({ length: 125 }, (_, index) => ({ ...data.kills[index % 6], index }));
  const ui = await page({ datasets: [data] }); await ui.choose('match');
  assert.equal(ui.get('stats-kill-rows').children.length, 60); assert.match(ui.get('stats-kills-page').textContent, /1 \/ 3/);
  await ui.get('stats-kills-next').click(); await ui.get('stats-kills-next').click(); assert.equal(ui.get('stats-kill-rows').children.length, 5);
  await ui.change('stats-player', 'v1'); assert.match(ui.get('stats-kills-page').textContent, /1 \/ 1/); assert.equal(ui.get('stats-kills-next').disabled, true);
});

test('switching A to B ignores a late statistics response and never deletes a shared job', async () => {
  const ui = await page({ datasets: [fixture('a'), fixture('b')] });
  const release = ui.block('/api/demos/a/statistics'), choosingA = ui.choose('a'); await settle();
  await ui.choose('b'); release(); await choosingA;
  assert.equal(ui.get('stats-match-name').textContent, 'b.dem'); assert.match(ui.href(), /demo=b/);
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
});

test('stopping an unparsed wait cannot load a late result or remove the library record', async () => {
  const ui = await page({ catalog: [{ id: 'match', name: 'match.dem', status: 'discovered', available: true }] });
  const release = ui.block('/api/library/demos/match/parse'), selecting = ui.choose('match'); await settle();
  await ui.get('stats-stop').click(); release(); await selecting;
  assert.equal(ui.get('stats-empty').hidden, false); assert.equal(ui.get('stats-loading').hidden, true);
  assert.equal(ui.requests.some(([url]) => url.endsWith('/statistics')), false);
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
});

test('server and refresh errors stay readable without deleting available recordings', async () => {
  const ui = await page({ statisticsError: '统计缓存读取失败' }); await ui.choose('match');
  assert.match(ui.get('stats-error').textContent, /统计缓存读取失败/); assert.equal(ui.get('stats-content').hidden, true);
  ui.setRefreshError('目录不可读'); await ui.get('stats-refresh-library').click(); await settle();
  assert.match(ui.get('stats-library-message').textContent, /目录不可读/); assert.equal(ui.get('stats-library-list').children.length, 1);
});

test('a direct statistics link loads exactly its selected match and preserves unrelated URL fields', async () => {
  const ui = await page({ datasets: [fixture('a'), fixture('b')], href: 'http://127.0.0.1:9999/statistics.html?view=stats&demo=b#rounds' });
  assert.equal(ui.get('stats-match-name').textContent, 'b.dem');
  assert.deepEqual(ui.requests.filter(([url]) => url.endsWith('/statistics')), [['/api/demos/b/statistics', 'GET']]);
  assert.match(ui.href(), /view=stats&demo=b#rounds/);
});

test('numeric half IDs and sparse snapshots preserve real zero-score players from backend rosters', async () => {
  const data = fixture();
  for (const round of data.rounds) round.half = round.half === 'first' ? 1 : 2;
  for (const kill of data.kills) kill.half = kill.half === 'first' ? 1 : 2;
  data.halves = [{ half: 1, label: '上半场', players: data.players }, { half: 2, label: '下半场', players: data.players }];
  const quiet = { id: 'quiet', name: 'No events', summary: { score: 0 } }; data.players.push(quiet);
  data.teams[0].players = [data.players[0], data.players[1], quiet];
  assert.ok(statistics.rankPlayers(data).some(player => player.id === 'quiet' && player.summary.score === 0));
  assert.ok(statistics.rankPlayers(data, { team: 'alpha' }).some(player => player.id === 'quiet'));
  const ui = await page({ datasets: [data] }); await ui.choose('match'); await ui.change('stats-half', '2');
  assert.equal(ui.get('stats-total-score').textContent, '+1'); assert.equal(ui.get('stats-round-rows').children.length, 1);
});

test('overtime half provenance keeps the default three-round assumption visible for roster and convar sources', async () => {
  for (const source of ['roster_swap_overtime_mr3', 'convar_overtime_mr3', 'roster_swap_overtime_observed']) {
    const data = fixture(); data.rounds[1].halfSource = source;
    const ui = await page({ datasets: [data] }); await ui.choose('match'); await ui.change('stats-detail-round', '13');
    assert.match(ui.get('stats-economy-note').textContent, source.endsWith('observed') ? /加时半场按阵容换边记录推断/ : /加时按默认每半场 3 回合推断/);
    if (source.startsWith('roster_swap')) assert.match(ui.get('stats-economy-note').textContent, /常规半场按阵容换边识别/);
  }
});

function readyCatalog(...ids) { return ids.map(id => ({ id, name: `${id}.dem`, status: 'ready', revision: `${id}-old`, available: true })); }
function detailedFixture(id = 'match', amount = 125) {
  const data = fixture(id); data.kills = Array.from({ length: amount }, (_, index) => ({ ...data.kills[4], index })); return data;
}

test('reparse completion refreshes only the current revision and preserves every filter, detail round and page', async () => {
  const ui = await page({ datasets: [detailedFixture()], catalog: readyCatalog('match') }); await ui.choose('match');
  for (const [key, value] of [['team','alpha'],['player','p1'],['side','2'],['half','second'],['round','13']]) await ui.change(`stats-${key}`, value);
  await ui.change('stats-detail-round', '1'); await ui.get('stats-kills-next').click(); await ui.get('stats-kills-next').click();
  await ui.get('stats-reparse-current').click(); await settle();
  assert.deepEqual(ui.reparses, [{ ids: ['match'] }]); assert.equal(ui.get('stats-content').hidden, false); assert.equal(ui.timers.size, 1);
  assert.match(ui.get('stats-quality').textContent, /近似数据/); assert.equal(ui.get('stats-reparse-current').disabled, true);
  const updated = detailedFixture('match', 130); for (const round of updated.rounds) for (const side of ['ct','t']) round[side].source = 'freeze_end'; for (const kill of updated.kills) { kill.approx = false; kill.weaponSource = 'death_event'; kill.score = 6; }
  ui.setDataset(updated); ui.setCatalog('match', { revision: 'match-new', reparse: { status: 'ready', progress: 1 } }); await ui.poll();
  for (const [key, value] of [['team','alpha'],['player','p1'],['side','2'],['half','second'],['round','13']]) assert.equal(ui.get(`stats-${key}`).value, value);
  assert.equal(ui.get('stats-detail-round').value, '1'); assert.match(ui.get('stats-kills-page').textContent, /3 \/ 3/);
  assert.equal(ui.get('stats-total-score').textContent, '+780'); assert.match(ui.get('stats-quality').textContent, /事件与冻结结束记录/);
  assert.match(ui.get('stats-reparse-summary').textContent, /已更新 1 场/); assert.equal(ui.timers.size, 0);
  await ui.get('stats-refresh-library').click(); await settle();
  assert.equal(ui.requests.filter(([url]) => url === '/api/demos/match/statistics').length, 2, 'one automatic reload per successful revision');
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
});

test('batch reparse submits unique ready IDs only, including playback-only caches, and reports missing sources', async () => {
  const catalog = [...readyCatalog('one', 'played', 'one'), { id: 'new', status: 'discovered', available: true }, { id: 'broken', status: 'error' }];
  const ui = await page({ datasets: [fixture('one'), fixture('played')], catalog, reparseResponse: { queued: ['played'], active: [], skipped: [{ id: 'one', name: 'one.dem', error: '原始文件已移动，请恢复后刷新' }] } });
  await ui.choose('one'); await ui.get('stats-reparse-all').click(); await settle();
  assert.deepEqual(ui.reparses, [{ ids: ['one', 'played'] }]); assert.equal(ui.get('stats-total-score').textContent, '+4');
  assert.match(content(ui.get('stats-reparse-results')), /one.dem.*原始文件已移动.*旧缓存保留/);
  assert.equal(ui.get('stats-content').hidden, false);
  assert.equal(ui.requests.some(([url]) => /new.*parse|broken.*parse/.test(url)), false);
});

test('failed background reparse retains old statistics and filters without requesting a replacement report', async () => {
  const ui = await page({ catalog: readyCatalog('match') }); await ui.choose('match'); await ui.change('stats-player', 'p1');
  await ui.get('stats-reparse-current').click();
  ui.setCatalog('match', { reparse: { status: 'error', progress: .4, error: 'Demo 已损坏，重新解析失败' } }); await ui.poll();
  assert.equal(ui.get('stats-player').value, 'p1'); assert.equal(ui.get('stats-total-score').textContent, '+9'); assert.equal(ui.get('stats-content').hidden, false);
  assert.match(content(ui.get('stats-reparse-results')), /Demo 已损坏/); assert.match(ui.get('stats-reparse-summary').textContent, /未更新 1 场.*保留旧缓存/);
  assert.equal(ui.requests.filter(([url]) => url.endsWith('/statistics')).length, 1); assert.equal(ui.timers.size, 0); assert.equal(ui.get('stats-reparse-current').disabled, false);
});

test('a reparse submission error keeps the current report usable and allows retry', async () => {
  const ui = await page({ catalog: readyCatalog('match') }); await ui.choose('match'); ui.setReparseError('目录被占用');
  await ui.get('stats-reparse-current').click(); await settle();
  assert.match(content(ui.get('stats-reparse-results')), /提交重新解析失败.*目录被占用/);
  assert.equal(ui.get('stats-total-score').textContent, '+4'); assert.equal(ui.get('stats-reparse-current').disabled, false);
  ui.setReparseError(''); await ui.get('stats-reparse-current').click(); await settle(); assert.equal(ui.reparses.length, 2); assert.equal(ui.timers.size, 1);
});

test('late automatic report refresh after a reparse cannot override a newer selected match', async () => {
  const ui = await page({ datasets: [fixture('a'),fixture('b')], catalog: readyCatalog('a','b') }); await ui.choose('a');
  await ui.get('stats-reparse-current').click(); const release = ui.block('/api/demos/a/statistics');
  ui.setCatalog('a', { revision: 'a-new', reparse: { status: 'ready', progress: 1 } }); await ui.poll();
  assert.equal(ui.get('stats-content').hidden, false, 'old report remains visible while its replacement loads');
  await ui.choose('b'); release(); await settle();
  assert.equal(ui.get('stats-match-name').textContent, 'b.dem'); assert.match(ui.href(), /demo=b/); assert.equal(ui.get('stats-content').hidden, false);
  assert.equal(ui.requests.some(([, method]) => method === 'DELETE'), false);
});

test('filter edits made during automatic reparse refresh are preserved at commit time', async () => {
  const ui = await page({ catalog: readyCatalog('match') }); await ui.choose('match'); await ui.get('stats-reparse-current').click();
  const release = ui.block('/api/demos/match/statistics'); ui.setCatalog('match', { revision: 'match-new', reparse: { status: 'ready', progress: 1 } }); await ui.poll();
  await ui.change('stats-player', 'p1'); await ui.change('stats-side', '2'); await ui.change('stats-detail-round', '13');
  release(); await settle(); assert.equal(ui.get('stats-player').value, 'p1'); assert.equal(ui.get('stats-side').value, '2'); assert.equal(ui.get('stats-detail-round').value, '13'); assert.equal(ui.get('stats-total-score').textContent, '+3');
});

test('failed replacement report does not loop and manual reread preserves the current view', async () => {
  const ui = await page({ datasets: [detailedFixture()], catalog: readyCatalog('match') }); await ui.choose('match'); await ui.change('stats-player', 'p1'); await ui.change('stats-detail-round', '13'); await ui.get('stats-kills-next').click();
  await ui.get('stats-reparse-current').click(); ui.setStatisticsError('临时读取失败'); ui.setCatalog('match', { revision: 'match-new', reparse: { status: 'ready', progress: 1 } }); await ui.poll();
  assert.match(ui.get('stats-error').textContent, /仍显示原有统计/); assert.equal(ui.get('stats-content').hidden, false);
  await ui.get('stats-refresh-library').click(); await settle();
  assert.equal(ui.requests.filter(([url]) => url.endsWith('/statistics')).length, 2, 'failed revision is not retried in a loop');
  ui.setStatisticsError(''); await ui.choose('match');
  assert.equal(ui.get('stats-player').value, 'p1'); assert.equal(ui.get('stats-detail-round').value, '13'); assert.match(ui.get('stats-kills-page').textContent, /2 \/ 3/);
});

test('same-ID reread retains explicit filters no longer in the report and clamps pagination only', async () => {
  const ui = await page({ datasets: [detailedFixture()], catalog: readyCatalog('match') }); await ui.choose('match');
  await ui.change('stats-player', 'p1'); await ui.change('stats-round', '13'); await ui.change('stats-detail-round', '13'); await ui.get('stats-kills-next').click();
  const updated = fixture(); updated.rounds = updated.rounds.slice(0,1); updated.players = updated.players.filter(player => player.id !== 'p1'); updated.kills = []; ui.setDataset(updated);
  await ui.choose('match');
  assert.equal(ui.get('stats-player').value, 'p1'); assert.equal(ui.get('stats-round').value, '13'); assert.equal(ui.get('stats-detail-round').value, '13');
  assert.match(ui.get('stats-kills-page').textContent, /1 \/ 1/); assert.match(content(ui.get('stats-economy-teams')), /没有可用的回合装备记录/);
});

test('accepted reparse keeps polling after a temporary catalog read failure', async () => {
  const ui = await page({ catalog: readyCatalog('match'), failCatalogAfterReparse: true }); await ui.choose('match');
  await ui.get('stats-reparse-current').click(); await settle();
  assert.equal(ui.timers.size, 1); assert.equal(ui.get('stats-content').hidden, false);
  assert.equal(ui.get('stats-reparse-current').disabled, true);
  assert.match(ui.get('stats-library-message').textContent, /暂时无法读取目录状态/);
  ui.setCatalogError(''); ui.setCatalog('match', { revision: 'match-new', reparse: { status: 'ready', progress: 1 } }); await ui.poll();
  assert.equal(ui.requests.filter(([url]) => url.endsWith('/statistics')).length, 2); assert.equal(ui.timers.size, 0);
  assert.match(ui.get('stats-reparse-summary').textContent, /已更新 1 场/);
});

test('an all-skipped reparse reports each missing recording once despite its catalog error status', async () => {
  const ui = await page({ catalog: readyCatalog('match'), reparseResponse: { queued: [], active: [], skipped: [{ id: 'match', name: 'match.dem', error: '原始录像不存在' }] } });
  await ui.choose('match'); await ui.get('stats-reparse-current').click(); await settle();
  assert.match(ui.get('stats-reparse-summary').textContent, /未更新 1 场/);
  assert.equal(ui.get('stats-reparse-results').children.length, 1);
  assert.match(content(ui.get('stats-reparse-results')), /原始录像不存在.*旧缓存保留/);
  assert.equal(ui.get('stats-total-score').textContent, '+4'); assert.equal(ui.timers.size, 0);
});

test('newly reparsed neighboring frames and previous ticks are approximate without being called old cache', async () => {
  const ui = await page({ catalog: readyCatalog('match') }); await ui.choose('match'); assert.match(ui.get('stats-quality').textContent, /旧缓存采样/);
  await ui.get('stats-reparse-current').click();
  const updated = fixture(); for (const round of updated.rounds) for (const side of ['ct','t']) round[side].source = 'freeze_end'; updated.rounds[0].t.source = 'sampled_frame';
  for (const kill of updated.kills) if (kill.weaponSource === 'sampled_cache') { kill.weaponSource = 'death_event'; kill.approx = false; }
  ui.setDataset(updated); ui.setCatalog('match', { revision: 'match-new', reparse: { status: 'ready' } }); await ui.poll();
  assert.match(ui.get('stats-quality').textContent, /近似数据.*冻结结束邻近帧推断.*前一 tick 推断/);
  assert.doesNotMatch(ui.get('stats-quality').textContent, /旧缓存/);
  assert.match(content(ui.get('stats-economy-teams')), /近似 · 冻结结束邻近帧/); assert.doesNotMatch(content(ui.get('stats-economy-teams')), /旧缓存/);
});

test('previous-tick-only reports name that inference without claiming legacy cache or neighboring economy frames', async () => {
  const data = fixture(); for (const round of data.rounds) for (const side of ['ct','t']) round[side].source = 'freeze_end';
  for (const kill of data.kills) if (kill.weaponSource === 'sampled_cache') { kill.weaponSource = 'death_event'; kill.approx = false; }
  const ui = await page({ datasets: [data] }); await ui.choose('match');
  assert.match(ui.get('stats-quality').textContent, /近似数据.*前一 tick 推断/);
  assert.doesNotMatch(ui.get('stats-quality').textContent, /旧缓存|冻结结束邻近帧/);
});

function mismatchFixture() {
  const data = fixture();
  const specs = [
    ['p1', 'v1', 1, 'AK-47', 'Glock-18', 5, 1, -4],
    ['p2', 'v2', 1, 'MP9', 'USP-S', 2, 1, -1],
    ['v1', 'p2', 13, 'XM1014', 'P250', 5, 1, -4],
    ['p1', 'v2', 13, 'M249', 'Five-Seven', 5, 1, -4],
    ['p1', 'v1', 1, 'AWP', 'Glock-18', 7, 1, -6],
    ['p1', 'v2', 1, 'Glock-18', 'P250', 1, 1, 0],
    ['p1', 'p2', 1, 'AK-47', 'USP-S', 5, 1, -4, '友军击杀不计分'],
    ['p1', 'v1', 1, 'Knife', 'Glock-18', null, 1, null, '击杀武器为刀'],
    ['p1', 'v2', 1, 'HE Grenade', 'P250', null, 1, null, '击杀武器为道具'],
    ['p1', 'v1', 1, 'AK-47', 'Knife', 5, null, null, '受害者手持刀'],
    ['p1', 'v2', 1, 'MP9', 'Flashbang', 2, null, null, '受害者手持道具'],
    ['p1', 'v1', 1, 'AK-47', '', 5, null, null, '受害者手持未知'],
  ];
  for (const [offset, [killerId, victimId, round, weapon, victimWeapon, killerValue, victimValue, score, excludedReason = '']] of specs.entries()) {
    const second = round === 13, alpha = id => id.startsWith('p');
    data.kills.push({ ...data.kills[0], index: 100 + offset, killerId, victimId, killer: data.players.find(player => player.id === killerId).name, victim: data.players.find(player => player.id === victimId).name,
      killerTeamKey: alpha(killerId) ? 'alpha' : 'beta', victimTeamKey: alpha(victimId) ? 'alpha' : 'beta', killerSide: alpha(killerId) !== second ? 3 : 2, victimSide: alpha(victimId) !== second ? 3 : 2,
      half: second ? 'second' : 'first', round, time: (second ? 1200 : 0) + 40 + offset,
      weapon, victimWeapon, killerValue, victimValue, score, excludedReason, approx: offset === 1, weaponSource: offset === 1 ? 'sampled_cache' : 'death_event', headshot: false,
    });
  }
  return data;
}
function mismatchCellValue(row) { return Number(row.children.find(cell => cell.dataset.metric === 'pistol-mismatch')?.textContent); }
function highlightedKills(ui) { return ui.get('stats-kill-rows').children.filter(row => row.dataset.pistolMismatch === 'true'); }

test('pistol mismatch requires a valid SMG or five-point gun kill against an active pistol and ignores flags or negative score alone', () => {
  const base = { killerValue: 5, victimValue: 1, score: -4, excludedReason: '' };
  for (const killerValue of [2, 5]) assert.equal(statistics.isPistolMismatch({ ...base, killerValue, pistolMismatch: false }), true);
  for (const changed of [
    { killerValue: 7, score: -6 }, { killerValue: 1, score: 0 }, { killerValue: null, score: null }, { killerValue: '5' },
    { victimValue: 2, score: -3 }, { victimValue: 5, score: -2 }, { victimValue: 7 }, { victimValue: null }, { victimValue: '1' },
    { excludedReason: '友军击杀' }, { excludedReason: '自杀' }, { score: null }, { score: undefined }, { score: '-4' }, { score: NaN }, { score: Infinity },
  ]) assert.equal(statistics.isPistolMismatch({ ...base, pistolMismatch: true, ...changed }), false, JSON.stringify(changed));
  const data = mismatchFixture(), summary = statistics.summarize(data.kills);
  assert.equal(summary.pistolMismatchKills, 4); assert.equal(summary.score, -15); assert.equal(summary.kills, data.kills.length);
  assert.equal(summary.scoredKills + summary.excludedKills, data.kills.length);
  assert.equal(statistics.summarize(data.kills, { team: 'alpha' }).pistolMismatchKills, 3);
  assert.equal(statistics.summarize(data.kills, { player: 'p1' }).pistolMismatchKills, 2);
});

test('pistol mismatch card, player ranking, side, half and round columns agree while only qualifying kill rows receive a frame', async () => {
  const data = mismatchFixture(), ui = await page({ datasets: [data] }); await ui.choose('match');
  assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '4'); assert.match(ui.get('stats-pistol-mismatch-card').className, /has-mismatch/);
  assert.equal(ui.get('stats-total-score').textContent, '-15');
  const rank = Object.fromEntries(ui.get('stats-player-rows').children.map(row => [row.dataset.playerId, mismatchCellValue(row)]));
  assert.deepEqual(rank, { p1: 2, p2: 1, v1: 1, v2: 0 });
  assert.deepEqual(ui.get('stats-side-rows').children.map(row => [row.dataset.side, mismatchCellValue(row)]), [['3', 3], ['2', 1]]);
  assert.deepEqual(ui.get('stats-half-rows').children.map(row => [row.dataset.half, mismatchCellValue(row)]), [['first', 2], ['second', 2]]);
  assert.deepEqual(ui.get('stats-round-rows').children.map(row => [row.dataset.round, mismatchCellValue(row)]), [['1', 2], ['13', 2]]);
  assert.deepEqual(highlightedKills(ui).map(row => row.dataset.killIndex), ['100', '101', '102', '103']);
  for (const row of highlightedKills(ui)) { assert.equal(row.className, 'pistol-mismatch-row'); assert.match(content(row), /特了1个/); }
  assert.match(content(highlightedKills(ui)[1]), /近似 · 采样推断/);
  for (const row of ui.get('stats-kill-rows').children.filter(row => row.dataset.pistolMismatch !== 'true')) { assert.notEqual(row.className, 'pistol-mismatch-row'); assert.doesNotMatch(content(row), /特了1个/); }
});

test('every statistics filter intersects pistol mismatch counts and highlighted entries without changing score formulas', async () => {
  const data = mismatchFixture(), ui = await page({ datasets: [data] }); await ui.choose('match');
  const steps = [['stats-team', 'alpha', 3], ['stats-player', 'p1', 2], ['stats-side', '2', 1], ['stats-half', 'second', 1], ['stats-round', '13', 1], ['stats-round', '1', 0]];
  for (const [id, value, expected] of steps) {
    await ui.change(id, value); assert.equal(Number(ui.get('stats-pistol-mismatch-kills').textContent), expected);
    assert.equal(highlightedKills(ui).length, expected);
    for (const body of ['stats-player-rows', 'stats-side-rows', 'stats-half-rows', 'stats-round-rows']) assert.equal(ui.get(body).children.reduce((sum, row) => sum + (Number.isFinite(mismatchCellValue(row)) ? mismatchCellValue(row) : 0), 0), expected);
    const selected = Object.fromEntries(['team','player','side','half','round'].map(key => [key, ui.get(`stats-${key}`).value === 'all' ? '' : ui.get(`stats-${key}`).value]));
    const score = statistics.visibleKills(data.kills, selected).filter(kill => !kill.excludedReason && typeof kill.score === 'number').reduce((sum, kill) => sum + kill.score, 0);
    assert.equal(ui.get('stats-total-score').textContent, score > 0 ? `+${score}` : String(score));
  }
  assert.doesNotMatch(ui.get('stats-pistol-mismatch-card').className, /has-mismatch/);
  await ui.get('stats-reset').click(); await settle(); assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '4'); assert.equal(highlightedKills(ui).length, 4);
});

test('pistol mismatch highlight survives pagination and counts the full selected scope rather than the current page', async () => {
  const data = fixture(); data.kills = Array.from({ length: 125 }, (_, index) => ({ ...data.kills[0], index, weapon: 'MP9', victimWeapon: 'Glock-18', killerValue: 2, victimValue: 1, score: -1 }));
  const ui = await page({ datasets: [data] }); await ui.choose('match');
  assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '125'); assert.equal(ui.get('stats-total-score').textContent, '-125'); assert.equal(highlightedKills(ui).length, 60);
  await ui.get('stats-kills-next').click(); assert.equal(highlightedKills(ui).length, 60); assert.equal(highlightedKills(ui)[0].dataset.killIndex, '60');
  await ui.get('stats-kills-next').click(); assert.equal(highlightedKills(ui).length, 5); assert.equal(highlightedKills(ui)[0].dataset.killIndex, '120'); assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '125');
  await ui.change('stats-player', 'v1'); assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '0'); assert.equal(highlightedKills(ui).length, 0); assert.match(ui.get('stats-kills-page').textContent, /1 \/ 1/);
});

test('zero pistol mismatch counts stay neutral for normal negative scores, missing weapons and empty reports', async () => {
  for (const data of [fixture(), { ...fixture(), kills: [] }]) {
    const ui = await page({ datasets: [data] }); await ui.choose('match');
    assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '0'); assert.equal(ui.get('stats-pistol-mismatch-card').className, 'pistol-mismatch-card'); assert.equal(highlightedKills(ui).length, 0);
    for (const row of ui.get('stats-player-rows').children) { const cell = row.children.find(cell => cell.dataset.metric === 'pistol-mismatch'); assert.equal(cell.textContent, '0'); assert.equal(cell.className, 'value-zero'); }
  }
});

function weightedFixture() {
  const data = fixture();
  const values = [
    ['Glock-18', 'MP9', 1, 2, 1, 2, 2],
    ['Glock-18', 'AK-47', 1, 5, 4, 3, 12],
    ['Glock-18', 'AWP', 1, 7, 6, 4, 24],
    ['AK-47', 'AWP', 5, 7, 2, 2, 4],
    ['MP9', 'AWP', 2, 7, 5, 3, 15],
    ['AK-47', 'M4A1-S', 5, 5, 0, 1, 0],
    ['AK-47', 'Glock-18', 5, 1, -4, 1, -4],
    ['AWP', 'Glock-18', 7, 1, -6, 1, -6],
  ];
  data.ruleVersion = '2';
  data.kills = values.map(([weapon, victimWeapon, killerValue, victimValue, baseScore, scoreMultiplier, score], index) => ({ ...data.kills[0], index, round: index < 4 ? 1 : 13, half: index < 4 ? 'first' : 'second', killerSide: index < 4 ? 3 : 2, victimSide: index < 4 ? 2 : 3, weapon, victimWeapon, killerValue, victimValue, baseScore, scoreMultiplier, score }));
  data.kills.push({ ...data.kills[0], index: 8, round: 13, half: 'second', killerSide: 2, victimSide: 3, score: null, baseScore: 6, scoreMultiplier: 4, excludedReason: '友军击杀不计分' });
  data.kills.push({ ...data.kills[0], index: 9, round: 13, half: 'second', killerSide: 2, victimSide: 3, score: null, baseScore: null, scoreMultiplier: null, excludedReason: '' });
  return data;
}
function formulaTexts(row) { return row.querySelectorAll('span').filter(item => item.dataset.scoreFormula === 'true').map(item => item.textContent); }

test('weighted kill evidence displays backend base, multiplier and final score for two-, three- and four-tier rewards, zero and negatives', async () => {
  const data = weightedFixture(), ui = await page({ datasets: [data] }); await ui.choose('match');
  const rows = ui.get('stats-kill-rows').children;
  assert.deepEqual(rows.slice(0, 8).map(row => formulaTexts(row)[0]), [
    '基础 +1 × 2 = +2', '基础 +4 × 3 = +12', '基础 +6 × 4 = +24', '基础 +2 × 2 = +4',
    '基础 +5 × 3 = +15', '基础 0 × 1 = 0', '基础 -4 × 1 = -4', '基础 -6 × 1 = -6',
  ]);
  assert.deepEqual(rows.slice(0, 8).map(row => row.children[4].textContent), ['+2', '+12', '+24', '+4', '+15', '0', '-4', '-6']);
  assert.deepEqual(formulaTexts(rows[8]), [], 'excluded records cannot display a formula even if stray metadata exists');
  assert.match(content(rows[8]), /友军击杀不计分/); assert.deepEqual(formulaTexts(rows[9]), []); assert.match(content(rows[9]), /缺少有效分数，不计分/);
  assert.equal(ui.get('stats-excluded-kills').textContent, '2'); assert.equal(ui.get('stats-scored-kills').textContent, '8');
  assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '1'); assert.deepEqual(highlightedKills(ui).map(row => row.dataset.killIndex), ['6']);
});

test('weighted final scores are summed exactly once in totals, ranking and filtered round or half summaries', async () => {
  const data = weightedFixture(); assert.equal(statistics.summarize(data.kills).score, 47); assert.equal(statistics.rankPlayers(data).find(player => player.id === 'p1').summary.score, 47);
  const ui = await page({ datasets: [data] }); await ui.choose('match'); assert.equal(ui.get('stats-total-score').textContent, '+47');
  assert.equal(ui.get('stats-player-rows').children.find(row => row.dataset.playerId === 'p1').children[2].textContent, '+47');
  assert.deepEqual(ui.get('stats-round-rows').children.map(row => row.children[4].textContent), ['+42', '+5']);
  assert.deepEqual(ui.get('stats-half-rows').children.map(row => row.children[1].textContent), ['+42', '+5']);
  await ui.change('stats-half', 'second'); assert.equal(ui.get('stats-total-score').textContent, '+5');
  await ui.change('stats-round', '13'); await ui.change('stats-side', '2'); await ui.change('stats-team', 'alpha'); await ui.change('stats-player', 'p1'); assert.equal(ui.get('stats-total-score').textContent, '+5');
  assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '1');
  await ui.get('stats-reset').click(); await settle(); assert.equal(ui.get('stats-total-score').textContent, '+47');
});

test('legacy or partial scoring metadata does not invent a multiplier or recalculate final scores in the browser', async () => {
  const data = fixture(); data.kills[0].baseScore = 6; data.kills[2].scoreMultiplier = 1; data.kills[4].baseScore = 3; data.kills[4].scoreMultiplier = null;
  const ui = await page({ datasets: [data] }); await ui.choose('match');
  assert.equal(ui.get('stats-total-score').textContent, '+4');
  for (const row of ui.get('stats-kill-rows').children) assert.deepEqual(formulaTexts(row), []);
  assert.match(content(ui.get('stats-kill-rows').children[0]), /未提供基础分或倍数明细，沿用现有得分/);
  assert.equal(ui.get('stats-kill-rows').children[0].children[4].textContent, '+6', 'legacy provided score stays unchanged instead of multiplying by four');
  assert.doesNotMatch(content(ui.get('stats-kill-rows').children[1]), /未提供基础分或倍数明细/);
  assert.equal(ui.get('stats-pistol-mismatch-kills').textContent, '0');
});

function folderCatalog() {
  return [
    { id: 'a', name: 'a.dem', status: 'ready', available: true, map: 'de_mirage', sourceCount: 2, sources: [{ path: '赛事/决赛/a.dem', kind: 'dem', available: true }, { path: '备份/a.zip', member: '内部/demo/a.dem', kind: 'zip', available: true }] },
    { id: 'b', name: 'b.dem', status: 'ready', available: true, map: 'de_nuke', sources: [{ path: 'b.zip', member: '赛季/正赛/b.dem', kind: 'zip', available: true }] },
    { id: 'c', name: 'c.dem', status: 'ready', available: false, map: 'de_mirage', sources: [{ path: '已移动/c.dem', kind: 'dem', available: false }] },
  ];
}
function visibleStatisticsIds(ui) { return ui.get('stats-library-list').querySelectorAll('button').map(button => button.dataset.demoId); }

test('single statistics library groups physical folders, root ZIPs and unavailable caches while counting unique demos', async () => {
  const ui = await page({ datasets: [fixture('a'), fixture('b'), fixture('c')], catalog: folderCatalog() });
  assert.deepEqual(visibleStatisticsIds(ui), ['a', 'b', 'c']); assert.equal(ui.get('stats-library-folder-field').hidden, true);
  await ui.change('stats-library-view', 'folders');
  assert.deepEqual(ui.get('stats-library-list').children.map(group => group.dataset.folderKey).sort(), ['root', 'path:赛事/决赛', 'path:备份', 'unavailable'].sort());
  assert.equal(visibleStatisticsIds(ui).filter(id => id === 'a').length, 2); assert.equal(ui.get('stats-library-count').textContent, '3 / 3 场');
  assert.equal(ui.get('stats-library-folder').children.some(option => /内部|正赛/.test(option.value)), false);
  await ui.change('stats-library-folder', 'root'); assert.deepEqual(visibleStatisticsIds(ui), ['b']);
  await ui.change('stats-library-folder', 'unavailable'); assert.deepEqual(visibleStatisticsIds(ui), ['c']); await ui.choose('c'); assert.equal(ui.get('stats-total-score').textContent, '+4'); assert.equal(ui.payloads.length, 0);
});

test('single statistics folder and search changes preserve the open report and all score filters', async () => {
  const ui = await page({ datasets: [fixture('a'), fixture('b'), fixture('c')], catalog: folderCatalog() }); await ui.choose('a'); await ui.change('stats-player', 'p1');
  const requests = ui.requests.length;
  await ui.change('stats-library-view', 'folders'); await ui.change('stats-library-folder', 'root'); await ui.search('a.dem'); assert.deepEqual(visibleStatisticsIds(ui), []);
  assert.equal(ui.get('stats-player').value, 'p1'); assert.equal(ui.get('stats-total-score').textContent, '+9'); assert.equal(ui.get('stats-match-name').textContent, 'a.dem'); assert.equal(ui.requests.length, requests);
  await ui.change('stats-library-view', 'all'); assert.deepEqual(visibleStatisticsIds(ui), ['a']); assert.equal(ui.get('stats-library-folder-field').hidden, true);
  await ui.change('stats-library-view', 'folders'); assert.deepEqual(visibleStatisticsIds(ui), []); assert.equal(ui.get('stats-library-folder').value, 'root');
  await ui.search(''); await ui.change('stats-library-folder', 'path:备份'); assert.deepEqual(visibleStatisticsIds(ui), ['a']); assert.match(content(ui.get('stats-library-list')), /备份\/a.zip/);
});

test('single statistics folder preferences survive reload and a missing saved folder stays empty without loading anything', async () => {
  const options = { datasets: [fixture('a'), fixture('b'), fixture('c')], catalog: folderCatalog() }; const ui = await page(options);
  await ui.change('stats-library-view', 'folders'); await ui.change('stats-library-folder', 'path:赛事/决赛'); const saved = ui.folderSaved();
  const restored = await page({ ...options, folderSaved: saved }); assert.equal(restored.get('stats-library-view').value, 'folders'); assert.equal(restored.get('stats-library-folder').value, 'path:赛事/决赛'); assert.deepEqual(visibleStatisticsIds(restored), ['a']);
  assert.equal(restored.requests.some(([url]) => url.endsWith('/statistics')), false);
  const missing = await page({ ...options, folderSaved: { libraryView: 'folders', libraryFolder: 'path:暂时移走' } });
  assert.deepEqual(visibleStatisticsIds(missing), []); assert.equal(missing.get('stats-library-folder').value, 'path:暂时移走'); assert.match(missing.get('stats-library-folder').children.at(-1).textContent, /当前无录像/);
});
