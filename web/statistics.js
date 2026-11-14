(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ReplayStatistics = api; api.create(); }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const pageSize = 60;
  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const emptySummary = () => ({ kills: 0, scoredKills: 0, excludedKills: 0, score: 0, deaths: 0, headshots: 0 });
  const scopeMatches = (kill, filter) => (!filter.round || String(kill.round) === String(filter.round)) && (!filter.half || String(kill.half) === String(filter.half));
  const participantMatches = (kill, role, filter) => (!filter.side || String(kill[`${role}Side`]) === String(filter.side)) && (!filter.player || kill[`${role}Id`] === filter.player) && (!filter.team || kill[`${role}TeamKey`] === filter.team);
  function scoreKill(summary, kill) {
    summary.kills++;
    if (kill.excludedReason || !isNumber(kill.score)) summary.excludedKills++;
    else { summary.scoredKills++; summary.score += kill.score; }
    if (kill.headshot) summary.headshots++;
  }
  function summarize(kills, filter = {}) {
    const summary = emptySummary();
    for (const kill of kills) {
      if (!scopeMatches(kill, filter)) continue;
      if (participantMatches(kill, 'killer', filter)) scoreKill(summary, kill);
      if (kill.victimId && participantMatches(kill, 'victim', filter)) summary.deaths++;
    }
    return summary;
  }
  function rankPlayers(data, filter = {}) {
    const players = new Map();
    const add = (id, name) => { if (id && !players.has(id)) players.set(id, { id, name: name || id, summary: emptySummary() }); return players.get(id); };
    const groups = [
      [filter.team, (data.teams || []).find(group => group.teamKey === filter.team)],
      [filter.side, (data.sides || []).find(group => String(group.side) === String(filter.side))],
      [filter.half, (data.halves || []).find(group => String(group.half) === String(filter.half))],
      [filter.round, (data.rounds || []).find(group => String(group.number) === String(filter.round))],
    ].filter(([selected]) => selected).map(([, group]) => group);
    for (const player of data.players || []) if ((!filter.player || filter.player === player.id) && groups.every(group => Array.isArray(group?.players) && group.players.some(member => member.id === player.id))) add(player.id, player.name);
    // Keep zero-score players visible when they belong to the selected scope.
    for (const round of data.rounds || []) {
      if (!scopeMatches({ round: round.number, half: round.half }, filter)) continue;
      for (const team of [round.ct, round.t].filter(Boolean)) {
        if ((filter.side && String(team.side) !== String(filter.side)) || (filter.team && team.teamKey !== filter.team)) continue;
        for (const player of team.players || []) if (!filter.player || filter.player === player.id) add(player.id, player.name);
      }
    }
    for (const kill of data.kills || []) {
      if (!scopeMatches(kill, filter)) continue;
      if (kill.killerId && participantMatches(kill, 'killer', filter)) scoreKill(add(kill.killerId, kill.killer).summary, kill);
      if (kill.victimId && participantMatches(kill, 'victim', filter)) add(kill.victimId, kill.victim).summary.deaths++;
    }
    return [...players.values()].sort((a, b) => b.summary.score - a.summary.score || b.summary.scoredKills - a.summary.scoredKills || a.name.localeCompare(b.name));
  }
  function visibleKills(kills, filter = {}) { return kills.filter(kill => scopeMatches(kill, filter) && participantMatches(kill, 'killer', filter)); }
  async function json(response) { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || body.message || `本地服务返回错误（${response.status}）`); return body; }
  function checkActive(options) { if (options.signal?.aborted || options.isCurrent?.() === false) throw new DOMException('已停止等待', 'AbortError'); }
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('已停止等待', 'AbortError')); return; }
      const aborted = () => { clearTimeout(timer); reject(new DOMException('已停止等待', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  async function loadStatistics(demo, options = {}) {
    const fetcher = options.fetch || fetch, sleep = options.sleep || wait;
    checkActive(options);
    let status = demo;
    if (demo.status !== 'ready') {
      status = await json(await fetcher(`/api/library/demos/${encodeURIComponent(demo.id)}/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'playback' }), signal: options.signal }));
      checkActive(options);
    }
    if (!status.id) throw new Error('录像编号无效，请刷新录像库后重试。');
    const id = status.id;
    while (status.status !== 'ready') {
      if (status.status === 'error') throw new Error(status.error || status.message || '录像解析失败。');
      options.onProgress?.(status);
      status = await json(await fetcher(`/api/demos/${encodeURIComponent(id)}/status`, { signal: options.signal, cache: 'no-store' }));
      checkActive(options);
      if (!['ready', 'error'].includes(status.status)) await sleep(650, options.signal);
      checkActive(options);
    }
    options.onProgress?.({ progress: 1, message: '正在计算回合经济与击杀净值…' });
    const data = await json(await fetcher(`/api/demos/${encodeURIComponent(id)}/statistics`, { signal: options.signal, cache: 'no-store' }));
    checkActive(options);
    if (!data || !Array.isArray(data.rounds) || !Array.isArray(data.kills)) throw new Error('统计数据不完整，请确认本地程序已更新。');
    return { id, data, revision: status.revision || demo.revision || '' };
  }
  function create(options = {}) {
    const doc = options.document || document, fetcher = options.fetch || fetch, win = options.window || window;
    const $ = id => doc.getElementById(id), make = (tag, text, className) => { const element = doc.createElement(tag); if (text != null) element.textContent = String(text); if (className) element.className = className; return element; };
    const schedule = options.setTimeout || setTimeout, unschedule = options.clearTimeout || clearTimeout;
    const state = { catalog: [], data: null, selected: '', loading: '', request: 0, controller: null, scanning: false, refreshing: false, catalogRequest: 0, catalogTimer: null, page: 0, detailRound: '', loadedRevision: '', failedRevision: '', reparseSubmitting: false, reparseAttempted: false, reparseTracked: new Map(), reparseSkipped: [], reparseError: '' };
    const money = value => isNumber(value) ? `$${value.toLocaleString('en-US')}` : '未知';
    const format = value => isNumber(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    const signed = value => isNumber(value) ? `${value > 0 ? '+' : ''}${format(value)}` : '—';
    const valueClass = value => isNumber(value) ? value > 0 ? 'value-positive' : value < 0 ? 'value-negative' : 'value-zero' : '';
    const clock = value => isNumber(value) ? `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}` : '—';
    const halfLabel = half => (state.data?.halves || []).find(item => String(item.half) === String(half))?.label || String(half || '阶段未知');
    const ruleLabel = code => (state.data?.rules || []).find(rule => rule.code === code)?.label || code;
    const sourceLabels = { freeze_end: '冻结结束快照', sampled_cache: '旧缓存采样推断', sampled_frame: '冻结结束邻近帧推断', unknown: '数据未知', death_event: '击杀事件手持记录', previous_tick: '前一 tick 手持记录' };
    const equipmentLabels = { pistol: '手枪', smg: '冲锋枪', rifle: '长枪', sniper: '狙击枪', shotgun: '霰弹枪', machinegun: '机枪', machine_gun: '机枪', unknown: '未知', smoke: '烟雾弹', smokegrenade: '烟雾弹', flash: '闪光弹', flashbang: '闪光弹', he: '高爆手雷', hegrenade: '高爆手雷', molotov: '燃烧瓶', incendiary: '燃烧弹', incgrenade: '燃烧弹', decoy: '诱饵弹' };
    function setError(text) { $('stats-error').hidden = !text; $('stats-error').textContent = text || ''; }
    function filter() { return Object.fromEntries(['team', 'player', 'side', 'half', 'round'].map(key => [key, $(`stats-${key}`).value === 'all' ? '' : $(`stats-${key}`).value])); }
    function replayLink(time) { const url = new URL('/', win.location.href); url.searchParams.set('demo', state.selected); if (isNumber(time)) url.searchParams.set('t', String(Math.max(0, time))); return `${url.pathname}${url.search}`; }
    function option(select, value, label) { const item = make('option', label); item.value = String(value); select.append(item); }
    function emptyRow(body, columns, text = '当前筛选没有记录。') { const row = make('tr'), cell = make('td', text, 'empty-row'); cell.colSpan = columns; row.append(cell); body.append(row); }
    function cell(row, text, className) { const td = make('td', text, className); row.append(td); return td; }
    function linkCell(row, time, text = '回放 ↗') { const td = cell(row), link = make('a', text, 'text-button'); link.href = replayLink(time); td.append(link); }
    function setOptions(id, items, allLabel) { const select = $(id); select.replaceChildren(); if (allLabel) option(select, 'all', allLabel); for (const [value, label] of items) option(select, value, label); select.value = allLabel ? 'all' : String(items[0]?.[0] ?? ''); }
    const reparseActive = demo => ['queued', 'parsing'].includes(demo?.reparse?.status);
    const knownReparseActive = demo => reparseActive(demo) || reparseActive(state.reparseTracked.get(demo?.id));
    function renderReparse() {
      const current = state.catalog.find(demo => demo.id === state.selected), ready = state.catalog.filter(demo => demo.status === 'ready');
      $('stats-reparse-current').disabled = state.reparseSubmitting || !!state.loading || !state.data || current?.status !== 'ready' || knownReparseActive(current);
      $('stats-reparse-current').textContent = knownReparseActive(current) ? '正在重新解析当前比赛…' : '重新解析当前比赛';
      $('stats-reparse-all').disabled = state.reparseSubmitting || !ready.some(demo => !knownReparseActive(demo));
      const tracked = state.reparseAttempted ? [...state.reparseTracked.values()] : state.catalog.filter(demo => demo.reparse?.status);
      const counts = { queued: 0, parsing: 0, ready: 0, error: 0 };
      for (const demo of tracked) { if (demo.reparse?.status in counts) counts[demo.reparse.status]++; }
      const done = counts.ready + counts.error, errors = counts.error + state.reparseSkipped.length;
      $('stats-reparse-status').hidden = !state.reparseSubmitting && !tracked.length && !state.reparseSkipped.length && !state.reparseError;
      $('stats-reparse-summary').textContent = state.reparseSubmitting ? '正在提交重新解析任务…旧统计仍可查看。' : `重新解析：已更新 ${counts.ready} 场 · 等待 ${counts.queued} 场 · 正在解析 ${counts.parsing} 场 · 未更新 ${errors} 场。${counts.queued + counts.parsing ? '后台处理期间可继续查看旧统计。' : '未更新的录像继续保留旧缓存。'}`;
      const progress = $('stats-reparse-progress'); progress.max = Math.max(1, tracked.length + state.reparseSkipped.length); progress.value = done + state.reparseSkipped.length;
      const results = $('stats-reparse-results'); results.replaceChildren();
      for (const demo of tracked) {
        const job = demo.reparse || {}, labels = { queued: '等待重新解析', parsing: '正在重新解析', ready: '已更新缓存', error: '重新解析失败，保留旧缓存' };
        const detail = job.status === 'error' ? job.error || job.message : job.message;
        results.append(make('li', `${demo.name || demo.id}：${labels[job.status] || '等待状态更新'}${job.status === 'parsing' && isNumber(job.progress) ? ` ${Math.round(job.progress * 100)}%` : ''}${detail ? ` · ${detail}` : ''}`, job.status === 'error' ? 'reparse-error' : ''));
      }
      for (const item of state.reparseSkipped) results.append(make('li', `${item.name || item.id || '录像'}：${item.error || '无法重新解析'}；旧缓存保留。`, 'reparse-error'));
      if (state.reparseError) results.append(make('li', state.reparseError, 'reparse-error'));
    }
    function renderLibrary() {
      const query = $('stats-library-search').value;
      const shown = state.catalog.filter(demo => win.ReplayLibrary.matches(demo, query));
      $('stats-library-count').textContent = `${shown.length} / ${state.catalog.length} 场`;
      $('stats-refresh-library').disabled = state.refreshing || state.scanning;
      const list = $('stats-library-list'); list.replaceChildren();
      for (const demo of shown) {
        const row = make('article', null, `library-item${state.selected === demo.id || state.loading === demo.id ? ' is-selected' : ''}`); row.dataset.demoId = demo.id;
        row.append(make('strong', demo.name || demo.id));
        const paths = win.ReplayLibrary.sourcePaths(demo), detail = make('small', `${demo.map || '地图待解析'}${demo.sourceCount > 1 ? ` · ${demo.sourceCount} 个来源已去重` : ''}\n${paths[0] || '本机缓存'}`); detail.title = paths.join('\n'); row.append(detail);
        if (demo.reparse?.status) {
          const job = demo.reparse, text = job.status === 'error' ? `重新解析失败，旧缓存保留 · ${job.error || job.message || '请恢复源文件后重试'}` : job.status === 'ready' ? '已完成重新解析' : `${job.status === 'queued' ? '等待重新解析' : '正在重新解析'}${isNumber(job.progress) ? ` · ${Math.round(job.progress * 100)}%` : ''} · 仍可查看旧统计`;
          row.append(make('small', text, job.status === 'error' ? 'reparse-error' : 'reparse-label'));
        }
        const button = make('button', state.loading === demo.id ? '正在读取…' : state.selected === demo.id ? '重新读取统计' : demo.status === 'ready' ? '查看数据分析' : '解析并查看数据', 'button secondary'); button.type = 'button'; button.dataset.demoId = demo.id;
        button.disabled = state.loading === demo.id || (demo.available === false && !['ready', 'queued', 'parsing'].includes(demo.status));
        if (button.disabled && state.loading !== demo.id) button.textContent = '源文件不可用';
        button.addEventListener('click', () => selectDemo(demo)); row.append(button); list.append(row);
      }
      if (!shown.length) list.append(make('p', state.catalog.length ? '没有匹配的录像。' : '将 .dem 或 .zip 放入 demo 文件夹或其子文件夹，再点击刷新。', 'micro'));
      renderReparse();
    }
    function pollCatalog() {
      unschedule(state.catalogTimer);
      if (state.scanning || state.catalog.some(reparseActive) || [...state.reparseTracked.values()].some(reparseActive)) state.catalogTimer = schedule(() => { void reloadLibrary(); }, 1200);
    }
    async function reloadLibrary() {
      const request = ++state.catalogRequest;
      try {
        const [catalog, info] = await Promise.all([json(await fetcher('/api/library/demos', { cache: 'no-store' })), json(await fetcher('/api/library', { cache: 'no-store' }))]);
        if (request !== state.catalogRequest) return;
        state.catalog = Array.isArray(catalog.demos) ? catalog.demos : []; state.scanning = catalog.scanning === true || info.scanning === true;
        for (const demo of state.catalog) if (state.reparseTracked.has(demo.id) && demo.reparse) state.reparseTracked.set(demo.id, demo);
        $('stats-library-directory').textContent = info.directory || '本地 Demo 文件夹';
        const errors = (info.result?.errors || []).map(error => typeof error === 'string' ? error : error.message || error.error || '文件读取失败');
        $('stats-library-message').textContent = state.scanning ? '正在扫描子文件夹与 ZIP；扫描不会解析比赛。' : errors.length ? errors.join('；') : '选择一场后解析；已有缓存直接读取统计。';
        const current = state.catalog.find(demo => demo.id === state.selected);
        if (state.data && !state.loading && current?.status === 'ready' && current.revision && current.revision !== state.loadedRevision && state.failedRevision !== `${current.id}|${current.revision}`) await selectDemo(current, { background: true });
      } catch (error) { if (request === state.catalogRequest) $('stats-library-message').textContent = `读取录像库失败：${error.message}`; }
      finally { if (request === state.catalogRequest) { renderLibrary(); pollCatalog(); } }
    }
    async function refreshLibrary() {
      if (state.refreshing || state.scanning) return;
      state.refreshing = true; renderLibrary();
      try { const result = await json(await fetcher('/api/library/refresh', { method: 'POST' })); state.scanning = result.scanning === true; await reloadLibrary(); }
      catch (error) { $('stats-library-message').textContent = `刷新失败：${error.message}。已有录像仍可选择。`; }
      finally { state.refreshing = false; renderLibrary(); pollCatalog(); }
    }
    async function requestReparse(ids) {
      if (state.reparseSubmitting) return;
      const requested = new Set(ids), eligible = [...new Set(state.catalog.filter(demo => demo.status === 'ready' && requested.has(demo.id)).map(demo => demo.id))];
      if (!eligible.length) return;
      state.reparseSubmitting = true; state.reparseSkipped = []; state.reparseError = ''; renderReparse();
      try {
        const result = await json(await fetcher('/api/library/reparse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: eligible }) }));
        state.reparseAttempted = true;
        state.reparseTracked.clear();
        for (const id of new Set([...(result.queued || []), ...(result.active || [])])) state.reparseTracked.set(id, { id, name: state.catalog.find(demo => demo.id === id)?.name, reparse: { status: 'queued' } });
        state.reparseSkipped = Array.isArray(result.skipped) ? result.skipped : [];
        state.failedRevision = '';
        await reloadLibrary();
      } catch (error) { state.reparseError = `提交重新解析失败：${error.message}。原有统计和缓存保持可用，可再次重试。`; }
      finally { state.reparseSubmitting = false; renderLibrary(); pollCatalog(); }
    }
    function currentView() { return { filters: Object.fromEntries(['team', 'player', 'side', 'half', 'round'].map(key => [key, $(`stats-${key}`).value])), page: state.page, detailRound: state.detailRound }; }
    function restoreView(view) {
      if (!view) return;
      for (const [key, value] of Object.entries(view.filters)) {
        const select = $(`stats-${key}`);
        if (![...select.children].some(item => item.value === value)) option(select, value, `${value}（本次暂无记录）`);
        select.value = value;
      }
      state.page = view.page; state.detailRound = view.detailRound;
      const detail = $('stats-detail-round');
      if (view.detailRound && ![...detail.children].some(item => item.value === view.detailRound)) option(detail, view.detailRound, `第 ${view.detailRound} 回合（本次暂无记录）`);
      detail.value = view.detailRound;
    }
    async function selectDemo(demo, selection = {}) {
      const request = ++state.request; state.controller?.abort(); state.controller = new AbortController(); state.loading = demo.id;
      if (!selection.background) state.failedRevision = '';
      setError(''); $('stats-loading').hidden = false; $('stats-loading-title').textContent = demo.name || '所选录像'; $('stats-loading-message').textContent = '准备读取所选比赛…'; $('stats-loading-progress').value = 0;
      $('stats-empty').hidden = true; $('stats-content').hidden = state.selected !== demo.id || !state.data; renderLibrary();
      try {
        const result = await loadStatistics(demo, { fetch: fetcher, sleep: options.sleep, signal: state.controller.signal, isCurrent: () => request === state.request, onProgress: status => { if (request === state.request) { $('stats-loading-message').textContent = status.message || '正在解析所选比赛…'; $('stats-loading-progress').value = isNumber(status.progress) ? status.progress : 0; } } });
        if (request !== state.request) return;
        const view = state.data && state.selected === result.id ? currentView() : null;
        state.data = result.data; state.selected = result.id; state.loadedRevision = result.revision; state.failedRevision = ''; state.page = 0; state.detailRound = String(result.data.rounds[0]?.number ?? '');
        initializeData(); restoreView(view); render();
        const url = new URL(win.location.href); url.searchParams.set('demo', result.id); win.history.replaceState(win.history.state, '', url);
        if (!selection.background) void reloadLibrary();
      } catch (error) { if (request === state.request) { if (selection.background) state.failedRevision = `${demo.id}|${demo.revision}`; setError(`${selection.background ? '缓存已更新，但读取新版统计失败；仍显示原有统计，可点击重新读取重试' : '读取数据分析失败'}：${error.message}`); } }
      finally { if (request === state.request) { state.loading = ''; $('stats-loading').hidden = true; $('stats-content').hidden = !state.data; $('stats-empty').hidden = !!state.data; renderLibrary(); } }
    }
    function initializeData() {
      const data = state.data;
      $('stats-match-name').textContent = data.name || '所选比赛'; $('stats-match-meta').textContent = `${data.map || '地图未知'} · ${data.rounds.length} 回合 · 规则版本 ${data.ruleVersion || '未知'}`;
      $('stats-open-replay').href = replayLink();
      const economySources = data.rounds.flatMap(round => [round.ct?.source, round.t?.source]), inferenceSources = [];
      if (economySources.includes('sampled_cache') || data.kills.some(kill => kill.weaponSource === 'sampled_cache')) inferenceSources.push('旧缓存采样');
      if (economySources.includes('sampled_frame') || data.kills.some(kill => kill.weaponSource === 'sampled_frame')) inferenceSources.push('冻结结束邻近帧推断');
      if (data.kills.some(kill => kill.weaponSource === 'previous_tick')) inferenceSources.push('前一 tick 推断');
      const approximated = inferenceSources.length > 0 || data.kills.some(kill => kill.approx);
      const incomplete = data.rounds.some(round => [round.ct, round.t].some(team => !team || team.source === 'unknown' || team.complete === false)) || data.kills.some(kill => kill.weaponSource === 'unknown');
      $('stats-quality').textContent = approximated ? `近似数据 · 部分记录采用${inferenceSources.join('、') || '观测推断'}，可能与冻结结束或击杀时刻的实际状态不同；每条明细标明来源。` : incomplete ? '存在缺失记录 · 无法确认的装备或手持武器保留未知；请查看每条分类与排除原因。' : '事件与冻结结束记录 · 经济取冻结结束装备及余钱，击杀计分使用事件关联的手持武器记录。';
      $('stats-quality').className = `notice${approximated || incomplete ? ' warning' : ''}`;
      $('stats-warnings').hidden = !data.warnings?.length; $('stats-warnings').textContent = (data.warnings || []).join('；');
      setOptions('stats-team', (data.teams || []).map(team => [team.teamKey, team.label || team.teamKey]), '全部队伍');
      setOptions('stats-player', (data.players || []).map(player => [player.id, `${player.name || player.id} · ${player.id}`]), '全部玩家');
      setOptions('stats-half', (data.halves || []).map(half => [half.half, half.label]), '全场');
      setOptions('stats-round', data.rounds.map(round => [round.number, `第 ${round.number} 回合`]), '全部回合');
      setOptions('stats-detail-round', data.rounds.map(round => [round.number, `第 ${round.number} 回合`]));
      $('stats-side').value = 'all';
      const rules = $('stats-rules'); rules.replaceChildren();
      for (const rule of data.rules || []) { const article = make('article'); article.append(make('h3', rule.label), make('p', rule.description)); rules.append(article); }
    }
    function render() {
      if (!state.data) return;
      const data = state.data, selected = filter(), total = summarize(data.kills, selected), players = rankPlayers(data, selected);
      $('stats-total-score').textContent = signed(total.score); $('stats-total-score').className = valueClass(total.score);
      $('stats-scored-kills').textContent = format(total.scoredKills); $('stats-all-kills').textContent = `${total.kills} 次击杀记录`;
      $('stats-excluded-kills').textContent = format(total.excludedKills); $('stats-deaths').textContent = format(total.deaths);
      $('stats-filter-note').textContent = '累计净值、排行与击杀明细按击杀者筛选；死亡按受害者筛选。队伍通过阵容身份关联，回合双方装备明细始终保留双方。';
      const body = $('stats-player-rows'); body.replaceChildren();
      players.forEach((player, index) => { const row = make('tr'); cell(row, index + 1); const name = cell(row, player.name); name.append(make('small', player.id)); cell(row, signed(player.summary.score), valueClass(player.summary.score)); cell(row, player.summary.scoredKills); cell(row, player.summary.excludedKills); cell(row, player.summary.deaths); body.append(row); });
      if (!players.length) emptyRow(body, 6);
      renderSplits('stats-side-rows', [{ key: 3, label: 'CT' }, { key: 2, label: 'T' }], 'side', selected);
      renderSplits('stats-half-rows', (data.halves || []).map(half => ({ key: half.half, label: half.label })), 'half', selected);
      const rounds = $('stats-round-rows'); rounds.replaceChildren();
      for (const round of data.rounds) {
        if (!scopeMatches({ round: round.number, half: round.half }, selected)) continue;
        const summary = summarize(data.kills, { ...selected, round: String(round.number) }), row = make('tr'), first = cell(row), button = make('button', `第 ${round.number} 回合`, 'text-button');
        button.type = 'button'; button.addEventListener('click', () => { state.detailRound = String(round.number); renderEconomy(); $('stats-economy-teams').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }); first.append(button);
        cell(row, halfLabel(round.half)); cell(row, round.ct?.label || '未知'); cell(row, round.t?.label || '未知'); cell(row, signed(summary.score), valueClass(summary.score)); cell(row, `${summary.scoredKills} / ${summary.excludedKills}`); linkCell(row, round.start); rounds.append(row);
      }
      if (!rounds.childElementCount) emptyRow(rounds, 7);
      renderEconomy(); renderKills();
    }
    function renderSplits(id, entries, key, selected) {
      const body = $(id); body.replaceChildren();
      for (const entry of entries) {
        if (selected[key] && String(selected[key]) !== String(entry.key)) continue;
        const summary = summarize(state.data.kills, { ...selected, [key]: String(entry.key) }), row = make('tr');
        cell(row, entry.label); cell(row, signed(summary.score), valueClass(summary.score)); cell(row, `${summary.scoredKills} / ${summary.excludedKills}`); cell(row, summary.deaths); body.append(row);
      }
      if (!body.childElementCount) emptyRow(body, 4);
    }
    function renderEconomy() {
      const rounds = state.data?.rounds || [], index = rounds.findIndex(round => String(round.number) === state.detailRound), round = rounds[index], teams = $('stats-economy-teams'); teams.replaceChildren();
      $('stats-detail-round').value = state.detailRound; $('stats-previous-round').disabled = index <= 0; $('stats-next-round').disabled = index < 0 || index >= rounds.length - 1;
      if (!round) { teams.append(make('p', '没有可用的回合装备记录。', 'micro')); return; }
      $('stats-round-replay').href = replayLink(round.start);
      const halfSource = String(round.halfSource || ''), halfNotes = [];
      if (halfSource.startsWith('default_mr12')) halfNotes.push('半场按默认 MR12 推断');
      else if (halfSource.startsWith('roster_swap')) halfNotes.push('常规半场按阵容换边识别');
      if (halfSource.includes('overtime_mr3')) halfNotes.push('加时按默认每半场 3 回合推断');
      else if (halfSource.includes('overtime_observed')) halfNotes.push('加时半场按阵容换边记录推断');
      $('stats-economy-note').textContent = [`第 ${round.number} 回合`, halfLabel(round.half), `冻结结束 ${clock(round.freezeEnd)}`, ...halfNotes].join(' · ');
      for (const [side, team] of [[3, round.ct], [2, round.t]]) {
        const article = make('article', null, `economy-team${side === 2 ? ' side-t' : ''}`), header = make('div', null, 'economy-team-header'), title = make('h3', `${side === 3 ? 'CT' : 'T'} · ${team?.name || '未命名队伍'}`);
        title.append(make('span', team?.label || '未知', 'economy-label')); header.append(title);
        if (team?.source === 'sampled_cache') header.append(make('span', '近似 · 旧缓存采样', 'approx-badge'));
        else if (team?.source === 'sampled_frame') header.append(make('span', '近似 · 冻结结束邻近帧', 'approx-badge'));
        else if (!team || team.source === 'unknown' || team.complete === false) header.append(make('span', '记录不完整', 'approx-badge unknown-badge'));
        header.append(make('p', `${sourceLabels[team?.source] || '数据未知'} · 记录时间 ${clock(team?.time)}`, 'evidence-source'));
        header.append(make('p', team?.reason || '资料不足，无法确认经济分类。', 'evidence-note'));
        if (team?.matchedTypes?.length > 1 || team?.overlap) header.append(make('p', `命中类别：${(team.matchedTypes || []).map(ruleLabel).join('、') || '详见分类依据'}；按规则优先级归类为${team.label || '未知'}。`, 'evidence-note'));
        if (typeof team?.overlap === 'string' && team.overlap) header.append(make('p', team.overlap, 'evidence-note'));
        article.append(header);
        const scroller = make('div', null, 'table-scroll'), table = make('table', null, 'evidence-table'), head = make('thead'), headRow = make('tr');
        for (const name of ['玩家', '装备 / 护甲', '余钱', '道具', '判断依据']) headRow.append(make('th', name)); head.append(headRow); table.append(head);
        const body = make('tbody');
        for (const player of team?.players || []) {
          const row = make('tr'); const who = cell(row, player.name || player.id || '未知玩家'); who.append(make('small', player.id || 'ID 未知'));
          const equipment = cell(row, player.weapon || '武器未知', 'equipment'); equipment.append(make('small', `${equipmentLabels[player.weaponClass] || player.weaponClass || '类别未知'} · 护甲 ${isNumber(player.armor) ? player.armor : '未知'}`));
          cell(row, money(player.money)); const utilities = cell(row, isNumber(player.grenades) ? `${player.grenades} 个` : '未知');
          if (Array.isArray(player.inventory) && player.inventory.length) utilities.append(make('small', player.inventory.map(item => `${equipmentLabels[item.type] || item.type} ×${item.count}`).join('、')));
          const evidence = cell(row, [player.reason, player.utilityReason].filter(Boolean).join('；') || '没有足够依据', 'evidence-explain');
          if (typeof player.utilityReady === 'boolean') evidence.append(make('small', player.utilityReady ? '道具满足满配口径' : '道具尚未满足满配口径'));
          body.append(row);
        }
        if (!body.childElementCount) emptyRow(body, 5, '缺少冻结结束的玩家装备记录。');
        table.append(body); scroller.append(table); article.append(scroller); teams.append(article);
      }
    }
    function renderKills() {
      const kills = visibleKills(state.data.kills, filter()), pages = Math.max(1, Math.ceil(kills.length / pageSize)); state.page = Math.min(state.page, pages - 1);
      $('stats-kill-count').textContent = `${kills.length} 条记录`; $('stats-kills-page').textContent = `${state.page + 1} / ${pages} 页 · 每页 ${pageSize} 条`;
      $('stats-kills-prev').disabled = state.page <= 0; $('stats-kills-next').disabled = state.page >= pages - 1;
      const body = $('stats-kill-rows'); body.replaceChildren();
      for (const kill of kills.slice(state.page * pageSize, (state.page + 1) * pageSize)) {
        const row = make('tr'); cell(row, `R${kill.round} · ${clock(kill.time)}`); const names = cell(row, `${kill.killer || '世界 / 未知'} → ${kill.victim || '未知'}`); names.append(make('small', `${kill.killerSide === 3 ? 'CT' : kill.killerSide === 2 ? 'T' : '未知阵营'}${kill.headshot ? ' · 爆头' : ''}`));
        cell(row, `${kill.weapon || '未知'} / ${format(kill.killerValue)}`); cell(row, `${kill.victimWeapon || '未知'} / ${format(kill.victimValue)}`);
        cell(row, kill.excludedReason ? '不计分' : signed(kill.score), kill.excludedReason ? '' : valueClass(kill.score));
        const reason = cell(row, kill.excludedReason || '计入累计净值', 'reason'); reason.append(make('small', `${sourceLabels[kill.weaponSource] || '来源未知'}${isNumber(kill.weaponTime) ? ` · ${clock(kill.weaponTime)}` : ''}`));
        if (kill.approx || ['sampled_cache', 'sampled_frame'].includes(kill.weaponSource)) reason.append(make('span', kill.weaponSource === 'previous_tick' ? '近似 · 前一 tick' : kill.weaponSource === 'sampled_frame' ? '近似 · 邻近帧' : '近似 · 采样推断', 'approx-badge'));
        linkCell(row, Math.max(0, (kill.time || 0) - 2)); body.append(row);
      }
      if (!kills.length) emptyRow(body, 7);
    }
    $('stats-library-search').addEventListener('input', renderLibrary);
    $('stats-refresh-library').addEventListener('click', refreshLibrary);
    $('stats-reparse-current').addEventListener('click', () => requestReparse([state.selected]));
    $('stats-reparse-all').addEventListener('click', () => requestReparse(state.catalog.filter(demo => demo.status === 'ready').map(demo => demo.id)));
    $('stats-stop').addEventListener('click', () => { ++state.request; state.controller?.abort(); state.loading = ''; $('stats-loading').hidden = true; $('stats-content').hidden = !state.data; $('stats-empty').hidden = !!state.data; setError(''); $('stats-library-message').textContent = '已停止等待，后台共享任务仍保留；可重新选择录像查看进度。'; renderLibrary(); });
    for (const key of ['team', 'player', 'side', 'half', 'round']) $(`stats-${key}`).addEventListener('change', () => { state.page = 0; if (key === 'round' && $('stats-round').value !== 'all') state.detailRound = $('stats-round').value; render(); });
    $('stats-reset').addEventListener('click', () => { for (const key of ['team', 'player', 'side', 'half', 'round']) $(`stats-${key}`).value = 'all'; state.page = 0; render(); });
    $('stats-detail-round').addEventListener('change', event => { state.detailRound = event.target.value; renderEconomy(); });
    for (const [id, step] of [['stats-previous-round', -1], ['stats-next-round', 1]]) $(id).addEventListener('click', () => { const rounds = state.data?.rounds || [], index = rounds.findIndex(round => String(round.number) === state.detailRound); if (rounds[index + step]) { state.detailRound = String(rounds[index + step].number); renderEconomy(); } });
    $('stats-kills-prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); renderKills(); });
    $('stats-kills-next').addEventListener('click', () => { state.page++; renderKills(); });
    const ready = reloadLibrary().then(async () => { const id = new URL(win.location.href).searchParams.get('demo'); if (id) { const demo = state.catalog.find(item => item.id === id); if (demo) await selectDemo(demo); else setError('链接中的录像不在本地资料库，请刷新后重新选择。'); } });
    return { ready };
  }
  return { summarize, rankPlayers, visibleKills, loadStatistics, create };
});
