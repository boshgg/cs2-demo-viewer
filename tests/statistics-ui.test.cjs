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
    click() { return this.dispatch('click'); }
    get childElementCount() { return this.children.length; }
    querySelectorAll(tag) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tag)]).filter(child => child.tagName === tag); }
    setAttribute(key, value) { this[key] = value; }
  }
  const elements = new Map(), requests = [], payloads = [], data = new Map((options.datasets || [fixture()]).map(item => [item.id, item]));
  const catalog = options.catalog || [...data.values()].map(item => ({ id: item.id, name: item.name, map: item.map, status: 'ready', sources: [{ path: `2026/nested/${item.name}`, kind: 'dem' }], sourceCount: 1, available: true }));
  const gates = new Map(), location = { href: options.href || 'http://127.0.0.1:9999/statistics.html' };
  let refreshError = '';
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
    if (url === '/api/library/demos') return good({ demos: catalog, scanning: false });
    if (url === '/api/library') return good({ enabled: true, directory: 'F:\\viewer\\demo', scanning: false });
    if (url === '/api/library/refresh') return refreshError ? rejected(refreshError, 500) : good({ scanning: false });
    const parse = /^\/api\/library\/demos\/([^/]+)\/parse$/.exec(url);
    if (parse) { const id = decodeURIComponent(parse[1]); payloads.push([id, JSON.parse(init.body)]); return options.parseError ? rejected(options.parseError) : good({ id, status: 'queued', cached: false }); }
    const demo = /^\/api\/demos\/([^/]+)\/(statistics|status)$/.exec(url);
    if (demo) {
      if (demo[2] === 'status') return good({ id: demo[1], status: 'ready', progress: 1 });
      if (options.statisticsError) return rejected(options.statisticsError, 500);
      return data.has(demo[1]) ? good(data.get(demo[1])) : rejected('录像不存在', 404);
    }
    throw new Error(`Unexpected API ${url}`);
  };
  const app = statistics.create({ document: { getElementById: get, createElement: tag => new Element(tag) }, window: { ReplayLibrary: library, location, history: { state: null, replaceState: (_state, _title, url) => { location.href = String(url); } } }, fetch: fetcher, sleep: async () => {} });
  await app.ready; await settle();
  return { get, requests, payloads, href: () => location.href,
    async choose(id) { const button = get('stats-library-list').querySelectorAll('button').find(button => button.dataset.demoId === id); assert.ok(button); await button.click(); await settle(); },
    async change(id, value) { get(id).value = value; await get(id).dispatch('change'); await settle(); },
    async search(query) { get('stats-library-search').value = query; await get('stats-library-search').dispatch('input'); },
    block(url) { let release; gates.set(url, new Promise(resolve => { release = () => { gates.delete(url); resolve(); }; })); return release; },
    setRefreshError(message) { refreshError = message; },
  };
}

test('statistical totals are sums, include zero and negative scores, and retain exclusions', () => {
  const data = fixture(), total = statistics.summarize(data.kills);
  assert.deepEqual(total, { kills: 6, scoredKills: 4, excludedKills: 2, score: 4, deaths: 6, headshots: 1 });
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
