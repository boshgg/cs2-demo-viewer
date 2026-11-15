(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ReplayMultiStatisticsUI = api; api.create(); }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const storageKey = 'cs2-statistics-multi-v1', pageSize = 60;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = value => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
  const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${format(value)}` : '—';
  async function json(response) { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || body.message || `请求失败（${response.status}）`); return body; }
  function create(options = {}) {
    const doc = options.document || document, win = options.window || window, fetcher = options.fetch || fetch;
    const core = options.core || win.ReplayMultiStatistics, statistics = options.statistics || win.ReplayStatistics, library = options.library || win.ReplayLibrary;
    const impactCore = options.impact || win.ReplayImpact, impactUI = options.impactUI || win.ReplayImpactUI;
    const storage = options.storage || win.localStorage, schedule = options.setTimeout || setTimeout, unschedule = options.clearTimeout || clearTimeout;
    const $ = id => doc.getElementById(id), node = (tag, text, className) => { const el = doc.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el; };
    const impactPanel = impactUI?.create({ document: doc, root: $('multi-impact'), prefix: 'multi', replayLink: replay, multi: true });
    let saved = {}; try { saved = JSON.parse(storage?.getItem(storageKey) || '{}') || {}; } catch { /* Ignore malformed preferences. */ }
    const folderExpansion = library.createFolderExpansion(saved.folderExpansion), folderBodies = new Map();
    const strings = values => Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
    const state = { catalog: [], reports: new Map(), revisions: new Map(), demos: new Set(strings(saved.demoIds)), players: Array.isArray(saved.playerIds) ? new Set(strings(saved.playerIds)) : null, previous: new Set(strings(saved.analyzedIds)), map: typeof saved.map === 'string' ? saved.map : 'all', side: ['all', '2', '3'].includes(saved.side) ? saved.side : 'all', active: false, initialized: false, loading: false, scanning: false, refreshing: false, run: 0, controller: null, timer: null, catalogRequest: 0, catalogGeneration: 0, reportEpoch: 0, page: 0, failures: [], result: null };
    state.libraryView = saved.libraryView === 'folders' ? 'folders' : 'all'; state.libraryFolder = typeof saved.libraryFolder === 'string' ? saved.libraryFolder : 'all';
    $('multi-library-search').value = typeof saved.libraryQuery === 'string' ? saved.libraryQuery : '';
    $('multi-player-search').value = typeof saved.playerQuery === 'string' ? saved.playerQuery : ''; $('multi-side').value = state.side;
    const isReady = demo => demo.status === 'ready';
    const available = demo => demo.available !== false || ['ready', 'queued', 'parsing'].includes(demo.status);
    const mapOf = demo => state.reports.get(demo.id)?.map || demo.map || '';
    const inMap = demo => state.map === 'all' || !mapOf(demo) || mapOf(demo) === state.map;
    const scopedCatalog = () => state.catalog.filter(demo => state.demos.has(demo.id) && inMap(demo));
    const visibleCatalog = () => state.catalog.filter(demo => inMap(demo) && library.matches({ ...demo, map: mapOf(demo) }, $('multi-library-search').value) && (state.libraryView !== 'folders' || library.inFolder(demo, state.libraryFolder)));
    const folderMembers = key => [...new Map(state.catalog.filter(demo => library.inFolder(demo, key)).map(demo => [demo.id, demo])).values()];
    const folderBusy = () => state.loading || state.refreshing || state.scanning;
    function selectFolder(key, action) {
      if (folderBusy() || !['all', 'none', 'invert'].includes(action)) return;
      for (const demo of folderMembers(key)) {
        if (action === 'none' || action === 'invert' && state.demos.has(demo.id)) state.demos.delete(demo.id);
        else if (available(demo)) state.demos.add(demo.id);
      }
      state.page = 0; save(); renderLibrary(); recompute();
    }
    function save() { try { storage?.setItem(storageKey, JSON.stringify({ demoIds: [...state.demos], playerIds: state.players && [...state.players], map: state.map, side: state.side, libraryView: state.libraryView, libraryFolder: state.libraryFolder, folderExpansion: folderExpansion.snapshot(), libraryQuery: $('multi-library-search').value, playerQuery: $('multi-player-search').value, analyzedIds: [...new Set([...state.previous, ...state.reports.keys()])] })); } catch { /* Storage can be disabled. */ } }
    function updateFolderExpansion() {
      for (const [key, { button, body, arrow }] of folderBodies) { const expanded = folderExpansion.isExpanded(key); body.hidden = !expanded; button.setAttribute('aria-expanded', String(expanded)); arrow.textContent = expanded ? '▾' : '▸'; }
    }
    function setError(message) { $('multi-error').hidden = !message; $('multi-error').textContent = message || ''; }
    function td(row, text, className) { const cell = node('td', text, className); row.append(cell); return cell; }
    function replay(demoId, time) { const url = new URL('/', win.location.href); url.searchParams.set('demo', demoId); if (finite(time)) url.searchParams.set('t', String(Math.max(0, time))); return url.pathname + url.search; }
    function replayCell(row, id, time) { const link = node('a', '回放 ↗', 'text-button'); link.href = replay(id, time); link.target = '_blank'; link.rel = 'noopener'; td(row).append(link); }
    function summaryCells(row, summary) { td(row, signed(summary.score), summary.score > 0 ? 'value-positive' : summary.score < 0 ? 'value-negative' : 'value-zero'); td(row, format(summary.pistolMismatchKills), summary.pistolMismatchKills > 0 ? 'pistol-mismatch-value' : 'value-zero'); td(row, `${summary.scoredKills} / ${summary.excludedKills}`); td(row, format(summary.deaths)); }
    function emptyRow(body, columns, message = '当前筛选没有记录。') { const row = node('tr'), cell = td(row, message, 'empty-row'); cell.colSpan = columns; body.append(row); }
    function renderMaps() {
      const counts = new Map(); for (const demo of state.catalog) { const map = mapOf(demo); if (map) counts.set(map, (counts.get(map) || 0) + 1); }
      const select = $('multi-map'); select.replaceChildren();
      const add = (value, label) => { const option = node('option', label); option.value = value; select.append(option); };
      add('all', '全部地图'); for (const [map, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) add(map, `${map} · ${count} 场`);
      if (state.map !== 'all' && !counts.has(state.map)) add(state.map, `${state.map} · 尚未读取`);
      select.value = state.map; select.disabled = state.loading;
    }
    function renderLibrary() {
      renderMaps(); const list = $('multi-demo-list'); list.replaceChildren(); folderBodies.clear();
      const folders = library.folderOptions(state.catalog), folder = $('multi-library-folder'); folder.replaceChildren();
      const addFolder = (value, label) => { const item = node('option', label); item.value = value; folder.append(item); }; addFolder('all', '全部文件夹');
      for (const item of folders) addFolder(item.key, `${item.label} · ${item.count} 场`);
      if (state.libraryFolder !== 'all' && !folders.some(item => item.key === state.libraryFolder)) addFolder(state.libraryFolder, `${library.folderLabel(state.libraryFolder)} · 当前无录像`);
      folder.value = state.libraryFolder; $('multi-library-view').value = state.libraryView; $('multi-library-folder-field').hidden = state.libraryView !== 'folders'; $('multi-library-folder-note').hidden = state.libraryView !== 'folders';
      $('multi-library-fold-controls').hidden = state.libraryView !== 'folders';
      const visible = visibleCatalog(); $('multi-demo-count').textContent = `已选 ${state.demos.size} · 显示 ${visible.length} / ${state.catalog.length}`;
      for (const group of library.groupByFolder(visible, state.libraryView, state.libraryView === 'folders' ? state.libraryFolder : 'all')) {
        let target = list;
        if (state.libraryView === 'folders') {
          const members = folderMembers(group.key), hiddenCount = Math.max(0, members.length - group.demos.length);
          target = node('section', null, 'statistics-folder-group'); target.dataset.folderKey = group.key;
          const header = node('div', null, 'multi-folder-header'), heading = node('h3'), button = node('button', null, 'statistics-folder-toggle'), arrow = node('span', null, 'statistics-folder-arrow'); arrow.setAttribute('aria-hidden', 'true');
          button.type = 'button'; button.dataset.folderToggle = group.key; button.append(arrow, node('span', `${group.label} · ${members.length} 场`)); heading.append(button); header.append(heading);
          header.append(node('small', `当前显示 ${group.demos.length} 场；本组操作含隐藏的 ${hiddenCount} 场。`));
          const actions = node('div', null, 'multi-folder-actions'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `${group.label} 文件夹选择`);
          for (const [action, label] of [['all', '全选'], ['none', '清空'], ['invert', '反选']]) {
            const button = node('button', label, 'text-button'); button.type = 'button'; button.dataset.folderAction = action; button.dataset.folderKey = group.key; button.disabled = folderBusy();
            button.title = `${label}“${group.label}”内全部 ${members.length} 场，包括被搜索或地图隐藏的 ${hiddenCount} 场。其他文件夹独有录像保持原选择；多来源同一录像联动。无法读取且未选的录像不会新增勾选。只改变勾选，点击分析后才读取。`;
            button.setAttribute('aria-label', `${label} ${group.label} 文件夹全部 ${members.length} 场（含隐藏 ${hiddenCount} 场）`);
            button.addEventListener('click', () => selectFolder(group.key, action)); actions.append(button);
          }
          header.append(actions); target.append(header); list.append(target);
          const body = node('div', null, 'statistics-folder-body'); body.dataset.folderBody = group.key; body.id = `multi-library-folder-body-${encodeURIComponent(group.key)}`; button.setAttribute('aria-controls', body.id);
          button.addEventListener('click', () => { folderExpansion.setExpanded(group.key, !folderExpansion.isExpanded(group.key)); save(); updateFolderExpansion(); });
          folderBodies.set(group.key, { button, body, arrow }); target.append(body); target = body;
        }
        for (const demo of group.demos) {
          const label = node('label', null, 'multi-demo-item'), check = node('input'); check.type = 'checkbox'; check.dataset.demoId = demo.id; check.checked = state.demos.has(demo.id); check.disabled = state.loading || !available(demo) && !check.checked; check.setAttribute('aria-label', `选择 ${demo.name || demo.id}`);
          check.addEventListener('change', () => { if (check.checked) state.demos.add(demo.id); else state.demos.delete(demo.id); state.page = 0; save(); renderLibrary(); recompute(); });
          const text = node('span'), title = node('strong', demo.name || demo.id); text.append(title);
          text.append(node('small', `${mapOf(demo) || '地图待解析'} · ${state.reports.has(demo.id) ? '已载入统计' : isReady(demo) ? '已有解析缓存' : demo.status === 'error' ? '解析失败，可重试' : '选择后解析'}${!available(demo) ? ' · 源文件不可用' : ''}`));
          const paths = library.sourcePaths(demo), groupPaths = group.key === 'all' ? paths : library.sourcePaths({ sources: (demo.sources || []).filter(source => library.folderKeys({ sources: [source] }).includes(group.key)) });
          if (paths.length) { const path = node('small', groupPaths[0] || paths[0], 'multi-source-path'); path.title = paths.join('\n'); text.append(path); }
          label.append(check, text); target.append(label);
        }
      }
      if (!visible.length) list.append(node('p', state.catalog.length ? '当前文件夹、地图或搜索没有匹配录像。其他录像的勾选仍保留。' : '将录像放入 demo 文件夹，再点击刷新。', 'micro'));
      updateFolderExpansion();
      for (const id of ['multi-demos-all', 'multi-demos-none', 'multi-demos-invert']) $(id).disabled = state.loading;
      $('multi-analyze').disabled = state.loading || !scopedCatalog().some(available);
      $('multi-refresh-library').disabled = state.loading || state.scanning || state.refreshing;
    }
    function renderPlayers(prepared) {
      const list = $('multi-player-list'); list.replaceChildren(); const candidates = prepared.candidates || [];
      const query = $('multi-player-search').value.trim().toLocaleLowerCase();
      for (const player of candidates.filter(player => !query || [player.id, player.name, ...(player.names || [])].join(' ').toLocaleLowerCase().includes(query))) {
        const label = node('label', null, 'multi-player-item'), check = node('input'); check.type = 'checkbox'; check.dataset.playerId = player.id; check.checked = !state.players || state.players.has(player.id); check.setAttribute('aria-label', `叠加玩家 ${player.name || player.id}`);
        check.addEventListener('change', () => { if (!state.players) state.players = new Set(candidates.map(player => player.id)); if (check.checked) state.players.add(player.id); else state.players.delete(player.id); state.page = 0; save(); recompute(); });
        const words = node('span'); words.append(node('strong', player.name || player.id), node('small', `${player.id} · 出现 ${player.appearances} 场`));
        if (player.names?.length > 1) words.append(node('small', `别名：${player.names.join(' / ')}`)); label.append(check, words); list.append(label);
      }
      const selected = candidates.filter(player => !state.players || state.players.has(player.id)).length; $('multi-player-count').textContent = `${candidates.length} 名重复玩家 · 已选 ${selected}`;
      if (!list.childElementCount) list.append(node('p', candidates.length ? '没有匹配的名字或 ID。搜索只隐藏列表，不改变选择。' : '此范围尚无符合条件的重复玩家。', 'micro'));
      for (const id of ['multi-players-all', 'multi-players-none', 'multi-players-invert']) $(id).disabled = !candidates.length;
    }
    function renderFailures() {
      $('multi-failures').hidden = !state.failures.length; const list = $('multi-failure-list'); list.replaceChildren();
      for (const failure of state.failures) list.append(node('li', `${failure.name || failure.id}：${failure.error}`));
    }
    function renderKills(result) {
      const kills = result.kills || [], pages = Math.max(1, Math.ceil(kills.length / pageSize)); state.page = Math.min(state.page, pages - 1);
      $('multi-kill-count').textContent = `${kills.length} 条击杀记录`; $('multi-kills-page').textContent = `${state.page + 1} / ${pages} 页 · 每页 ${pageSize} 条`;
      $('multi-kills-prev').disabled = state.page === 0; $('multi-kills-next').disabled = state.page >= pages - 1;
      const body = $('multi-kill-rows'); body.replaceChildren();
      const sourceLabels = { death_event: '击杀事件手持记录', previous_tick: '前一 tick 手持记录', sampled_cache: '旧缓存采样', sampled_frame: '邻近帧推断', unknown: '来源未知' };
      for (const kill of kills.slice(state.page * pageSize, (state.page + 1) * pageSize)) {
        const mismatch = statistics.isPistolMismatch(kill), row = node('tr', null, mismatch ? 'pistol-mismatch-row' : ''); row.dataset.demoId = kill.demoId; row.dataset.killKey = kill.key; row.dataset.killIndex = String(kill.index); row.dataset.pistolMismatch = String(mismatch);
        td(row, kill.demoName || kill.demoId).append(node('small', kill.map || '地图未知'));
        const t = finite(kill.time) ? `${Math.floor(kill.time / 60).toString().padStart(2, '0')}:${Math.floor(kill.time % 60).toString().padStart(2, '0')}` : '时间未知'; td(row, `R${kill.round} · ${t}`);
        const names = td(row, `${kill.killer || '世界 / 未知'} → ${kill.victim || '未知'}`); names.append(node('small', `${kill.killerSide === 3 ? 'CT' : kill.killerSide === 2 ? 'T' : '未知阵营'}${kill.headshot ? ' · 爆头' : ''}`)); if (mismatch) names.append(node('span', '特了1个', 'pistol-mismatch-badge'));
        td(row, `${kill.weapon || '未知'}（${format(kill.killerValue)}） → ${kill.victimWeapon || '未知'}（${format(kill.victimValue)}）`);
        td(row, kill.excludedReason ? '不计分' : signed(kill.score), kill.score > 0 ? 'value-positive' : kill.score < 0 ? 'value-negative' : 'value-zero').dataset.metric = 'score';
        const reason = td(row, kill.excludedReason || (finite(kill.score) ? '计入累计净值' : '缺少有效分数'), 'reason');
        if (!kill.excludedReason && finite(kill.score)) {
          const adjustment = statistics.scoreAdjustmentEvidence(kill);
          if (finite(kill.baseScore) && Number.isInteger(kill.scoreMultiplier) && kill.scoreMultiplier >= 1 && kill.scoreMultiplier <= 4 && finite(kill.baseScore * kill.scoreMultiplier)) {
            const original = kill.baseScore * kill.scoreMultiplier;
            let evidence = `基础 ${signed(kill.baseScore)} × ${kill.scoreMultiplier} = ${signed(original)}`;
            if (adjustment) evidence += adjustment.suffix + (adjustment.code === 'advantage_kill_round_death' ? ` → 最终 ${signed(kill.score)}` : '');
            else if (original !== kill.score) evidence += `；后端最终净值 ${signed(kill.score)}（调整依据未提供）`;
            reason.append(node('span', evidence, 'score-formula'));
          }
          else reason.append(node('small', '未提供基础分或倍数明细，沿用现有得分。'));
          if (adjustment) {
            reason.dataset.scoreAdjustment = adjustment.code; reason.append(node('small', adjustment.note, 'score-adjustment-note'));
            if (adjustment.code === 'advantage_kill_round_death') reason.append(node('small', finite(adjustment.deathTime) ? `本回合死亡时间 ${Math.floor(adjustment.deathTime / 60).toString().padStart(2, '0')}:${Math.floor(adjustment.deathTime % 60).toString().padStart(2, '0')}（Demo 时间）` : '已记录本回合死亡；死亡时间未提供。', 'score-survival-note'));
            if (adjustment.survival) reason.append(node('small', adjustment.survival, 'score-survival-note'));
          }
        }
        reason.append(node('small', sourceLabels[kill.weaponSource] || '来源未知'));
        if (kill.approx || ['previous_tick', 'sampled_cache', 'sampled_frame'].includes(kill.weaponSource)) reason.append(node('span', `近似 · ${sourceLabels[kill.weaponSource] || '观测推断'}`, 'approx-badge'));
        replayCell(row, kill.demoId, Math.max(0, (kill.time || 0) - 2)); body.append(row);
      }
      if (!kills.length) emptyRow(body, 7);
    }
    function renderResults(result) {
      const summary = result.summary; if (!summary) return;
      for (const [id, value] of [['multi-total-score', signed(summary.score)], ['multi-pistol-mismatch', format(summary.pistolMismatchKills)], ['multi-scored', format(summary.scoredKills)], ['multi-excluded', format(summary.excludedKills)], ['multi-deaths', format(summary.deaths)]]) $(id).textContent = value;
      $('multi-all-kills').textContent = `${summary.kills} 次击杀记录`; $('multi-mismatch-card').className = `pistol-mismatch-card${summary.pistolMismatchKills > 0 ? ' has-mismatch' : ''}`;
      const warnings = (result.warnings || []).map(item => typeof item === 'string' ? item : item.message || String(item));
      if ((result.kills || []).some(kill => kill.approx || ['sampled_cache', 'sampled_frame', 'previous_tick'].includes(kill.weaponSource))) warnings.push('部分手持武器采用采样或前一 tick 推断，逐次明细保留近似标记。');
      const notes = [...new Set(warnings)]; $('multi-quality').hidden = !notes.length; $('multi-quality-summary').textContent = `数据说明（${notes.length} 项）`;
      $('multi-quality-details').replaceChildren(...notes.map(note => node('p', note)));
      const players = $('multi-player-rows'); players.replaceChildren(); for (const player of result.players || []) { const row = node('tr'); row.dataset.playerId = player.id; const who = td(row, player.name || player.id); who.append(node('small', player.id)); if (player.names?.length > 1) who.append(node('small', player.names.join(' / '))); td(row, `${player.appearances} 场`); summaryCells(row, player.summary); players.append(row); } if (!players.childElementCount) emptyRow(players, 6);
      const demos = $('multi-demo-rows'); demos.replaceChildren(); for (const item of result.byDemo || []) { const row = node('tr'); row.dataset.demoId = item.demoId; td(row, item.demoName || item.demoId); td(row, item.map); summaryCells(row, item.summary); replayCell(row, item.demoId); demos.append(row); } if (!demos.childElementCount) emptyRow(demos, 7);
      for (const [id, entries, label] of [['multi-map-rows', result.byMap || [], item => item.map], ['multi-side-rows', result.bySide || [], item => item.label]]) { const body = $(id); body.replaceChildren(); for (const item of entries) { const row = node('tr'); td(row, label(item)); summaryCells(row, item.summary); body.append(row); } if (!body.childElementCount) emptyRow(body, 5); }
      const matchups = $('multi-matchup-rows'); matchups.replaceChildren(); const weaponLabels = { 1: '手枪（1 分）', 2: '冲锋枪（2 分）', 5: '长枪（5 分）', 7: '狙击枪（7 分）' };
      for (const item of result.matchups || []) { const row = node('tr'); td(row, weaponLabels[item.killerValue] || '未知'); td(row, weaponLabels[item.victimValue] || '未知'); td(row, format(item.kills)); td(row, signed(item.score)); matchups.append(row); } if (!matchups.childElementCount) emptyRow(matchups, 4);
      renderKills(result);
    }
    function recompute() {
      const filter = { demoIds: [...state.demos], map: state.map, playerIds: state.players && [...state.players], side: state.side };
      const catalogIds = new Set(state.catalog.map(demo => demo.id));
      const result = core.aggregate([...state.reports.values()].filter(demo => catalogIds.has(demo.id)), filter); state.result = result; renderPlayers(result);
      if (impactPanel && impactCore) impactPanel.render(impactCore.aggregate([...state.reports.values()].filter(demo => catalogIds.has(demo.id)), { ...filter, playerIds: result.selectedPlayerIds || [] }));
      const scoped = scopedCatalog(), loaded = scoped.filter(demo => state.reports.has(demo.id) && (state.map === 'all' || mapOf(demo) === state.map)), pending = scoped.filter(demo => !state.reports.has(demo.id));
      $('multi-scope').textContent = `已勾选 ${state.demos.size} 场 · 当前地图范围 ${scoped.length} 场 · 已载入 ${loaded.length} 场 · ${state.map === 'all' ? '全部地图' : state.map}`;
      $('multi-incomplete').hidden = !pending.length; $('multi-incomplete').textContent = `还有 ${pending.length} 场所选录像尚未载入；请点击“分析所选比赛”。下方仅使用已载入部分，重复玩家资格与统计可能随剩余比赛变化。`;
      const messages = { 'no-demos': '先从左侧勾选比赛，再点击“分析所选比赛”。', 'need-more-demos': '当前范围只载入 1 场比赛，需要至少 2 场才能寻找共同玩家。', 'no-repeat-players': '这些比赛中没有出现在至少 2 场的稳定玩家 ID。可以扩大地图或比赛范围；同名玩家不会自动合并。', 'no-players-selected': '请选择至少一名共同玩家。' };
      $('multi-empty').hidden = result.status === 'ready'; $('multi-empty').textContent = messages[result.status] || '请选择比赛与共同玩家。'; $('multi-results').hidden = result.status !== 'ready'; renderResults(result);
    }
    function pollCatalog() { unschedule(state.timer); if (state.active && state.scanning) state.timer = schedule(() => { void reloadLibrary(); }, 1200); }
    async function reloadLibrary() {
      const request = ++state.catalogRequest, epoch = state.reportEpoch;
      try {
        const [catalog, info] = await Promise.all([fetcher('/api/library/demos', { cache: 'no-store' }).then(json), fetcher('/api/library', { cache: 'no-store' }).then(json)]);
        if (request !== state.catalogRequest) return false;
        // A scan snapshot requested before a parse completed must not erase
        // the newer report; get a catalog snapshot made after that commit.
        if (epoch !== state.reportEpoch) return await reloadLibrary();
        state.catalog = [...new Map((catalog.demos || []).map(demo => [demo.id, demo])).values()]; state.scanning = catalog.scanning === true || info.scanning === true;
        state.catalogGeneration++;
        const knownIds = new Set(state.catalog.map(demo => demo.id)); state.demos = new Set([...state.demos].filter(id => knownIds.has(id))); state.previous = new Set([...state.previous].filter(id => knownIds.has(id)));
        for (const demo of state.catalog) if (state.reports.has(demo.id) && (demo.status === 'discovered' || demo.revision && demo.revision !== state.revisions.get(demo.id))) { state.reports.delete(demo.id); state.revisions.delete(demo.id); }
        save();
        $('multi-library-directory').textContent = info.directory || '本地 Demo 文件夹'; $('multi-library-message').textContent = state.scanning ? '正在扫描文件夹与 ZIP，扫描不会解析比赛。' : '只在点击分析后解析所选比赛；已有缓存直接读取。';
        const errors = info.result?.errors || []; if (errors.length) $('multi-library-message').textContent += ` ${errors.map(item => typeof item === 'string' ? item : item.error || item.message).join('；')}`;
        return true;
      } catch (error) { if (request === state.catalogRequest) $('multi-library-message').textContent = `读取录像库失败：${error.message}。已有选择保留，可重试。`; return false; }
      finally { if (request === state.catalogRequest) { renderLibrary(); recompute(); pollCatalog(); } }
    }
    async function analyze(cachedOnly = false) {
      if (state.loading) return;
      const run = ++state.run; state.controller = new AbortController(); state.loading = true; setError(''); renderLibrary();
      $('multi-loading').hidden = false; $('multi-loading-title').textContent = '核对所选比赛的最新缓存…'; $('multi-loading-message').textContent = ''; $('multi-loading-progress').value = 0;
      const current = cachedOnly || await reloadLibrary();
      if (run !== state.run || !state.active) return;
      if (!current) { state.loading = false; $('multi-loading').hidden = true; setError('未能核对录像库状态，本次未读取比赛。已有结果保留，请稍后重试。'); renderLibrary(); return; }
      const jobs = scopedCatalog().filter(demo => available(demo) && (!cachedOnly || isReady(demo) && state.previous.has(demo.id)));
      if (!jobs.length) { state.loading = false; $('multi-loading').hidden = true; renderLibrary(); return; }
      state.failures = []; state.page = 0; renderFailures(); renderLibrary();
      let successful = 0;
      for (const [index, demo] of jobs.entries()) {
        if (run !== state.run || state.controller.signal.aborted) break;
        $('multi-loading-title').textContent = `读取 ${index + 1} / ${jobs.length}：${demo.name || demo.id}`;
        $('multi-loading-progress').max = jobs.length; $('multi-loading-progress').value = index;
        try {
          if (!state.reports.has(demo.id) || state.revisions.get(demo.id) !== (demo.revision || '')) {
            const generation = state.catalogGeneration;
            const loaded = await statistics.loadStatistics(demo, { fetch: fetcher, sleep: options.sleep, signal: state.controller.signal, isCurrent: () => run === state.run, onProgress: job => { if (run === state.run) { $('multi-loading-message').textContent = job.message || '正在读取统计…'; $('multi-loading-progress').value = index + Math.max(0, Math.min(1, Number(job.progress) || 0)); } } });
            if (run !== state.run) break;
            const revision = loaded.data.revision || loaded.revision || demo.revision || '', current = state.catalog.find(item => item.id === demo.id);
            if (loaded.id !== demo.id || loaded.data.id !== demo.id) throw new Error('统计响应的录像 ID 不匹配，请重试。');
            if (generation !== state.catalogGeneration && (!current || current.status === 'discovered' || current.revision && current.revision !== revision)) throw new Error('读取期间录像缓存已更新，本次旧响应未计入，请再次分析。');
            state.reports.set(loaded.id, loaded.data); state.revisions.set(loaded.id, revision); state.previous.add(loaded.id); state.reportEpoch++;
            for (const item of [demo, current].filter(Boolean)) { item.status = 'ready'; item.map = loaded.data.map; if (revision) item.revision = revision; }
          }
          successful++;
        } catch (error) {
          if (error.name === 'AbortError' || run !== state.run) break;
          state.failures.push({ id: demo.id, name: demo.name, error: error.message });
          // A failed reread must not pass off a previous report as current.
          state.reports.delete(demo.id); state.revisions.delete(demo.id);
        }
        if (run === state.run) { save(); renderLibrary(); renderFailures(); recompute(); $('multi-batch-result').textContent = `本次已读取 ${successful} / ${jobs.length} 场；失败 ${state.failures.length} 场。`; }
      }
      if (run === state.run) { state.loading = false; $('multi-loading').hidden = true; $('multi-batch-result').textContent = `本次成功读取 ${successful} / ${jobs.length} 场${state.failures.length ? `，失败 ${state.failures.length} 场（详见下方）` : '，没有失败项'}。`; save(); renderLibrary(); renderFailures(); recompute(); }
    }
    function stop() { if (!state.loading) return; ++state.run; state.controller?.abort(); state.loading = false; $('multi-loading').hidden = true; $('multi-batch-result').textContent = '已停止等待。已读取的比赛保留，后台共享解析任务不会被删除；剩余比赛未加入本次统计。'; save(); renderLibrary(); recompute(); }
    async function mode(multi, updateURL = true) {
      state.active = multi; $('stats-single-view').hidden = multi; $('stats-multi-view').hidden = !multi; $('stats-mode-single').setAttribute('aria-pressed', String(!multi)); $('stats-mode-multi').setAttribute('aria-pressed', String(multi));
      if (updateURL) { const url = new URL(win.location.href); if (multi) { url.searchParams.set('mode', 'multi'); url.searchParams.delete('demo'); } else url.searchParams.delete('mode'); win.history.replaceState(win.history.state, '', url.toString()); }
      if (!multi) { stop(); unschedule(state.timer); ++state.catalogRequest; return; }
      if (!state.initialized) { state.initialized = true; const loaded = await reloadLibrary(); if (loaded && state.active) await analyze(true); } else { await reloadLibrary(); }
    }
    $('stats-mode-single').addEventListener('click', () => mode(false)); $('stats-mode-multi').addEventListener('click', () => mode(true));
    $('multi-analyze').addEventListener('click', () => analyze()); $('multi-stop').addEventListener('click', stop);
    $('multi-refresh-library').addEventListener('click', async () => { if (state.loading || state.scanning || state.refreshing) return; state.refreshing = true; renderLibrary(); try { const result = await json(await fetcher('/api/library/refresh', { method: 'POST' })); state.scanning = result.scanning === true; await reloadLibrary(); } catch (error) { setError(`刷新失败：${error.message}。已有选择与结果保留。`); } finally { state.refreshing = false; renderLibrary(); pollCatalog(); } });
    $('multi-library-search').addEventListener('input', () => { save(); renderLibrary(); });
    for (const [id, key] of [['multi-library-view', 'libraryView'], ['multi-library-folder', 'libraryFolder']]) $(id).addEventListener('change', () => { state[key] = $(id).value; save(); renderLibrary(); });
    for (const [id, expanded] of [['multi-library-collapse-all', false], ['multi-library-expand-all', true]]) $(id).addEventListener('click', () => { folderExpansion.setAll(expanded); save(); updateFolderExpansion(); });
    $('multi-map').addEventListener('change', () => { state.map = $('multi-map').value; state.page = 0; save(); renderLibrary(); recompute(); });
    for (const [id, action] of [['multi-demos-all', 'all'], ['multi-demos-none', 'none'], ['multi-demos-invert', 'invert']]) $(id).addEventListener('click', () => { if (state.loading) return; for (const demo of visibleCatalog().filter(demo => available(demo) || state.demos.has(demo.id))) { if (action === 'all' || action === 'invert' && !state.demos.has(demo.id)) state.demos.add(demo.id); else state.demos.delete(demo.id); } state.page = 0; save(); renderLibrary(); recompute(); });
    $('multi-player-search').addEventListener('input', () => { save(); if (state.result) renderPlayers(state.result); });
    for (const [id, action] of [['multi-players-all', 'all'], ['multi-players-none', 'none'], ['multi-players-invert', 'invert']]) $(id).addEventListener('click', () => { const ids = (state.result?.candidates || []).map(player => player.id); if (!state.players) state.players = new Set(ids); for (const id of ids) { if (action === 'all' || action === 'invert' && !state.players.has(id)) state.players.add(id); else state.players.delete(id); } state.page = 0; save(); recompute(); });
    $('multi-side').addEventListener('change', () => { state.side = $('multi-side').value; state.page = 0; save(); recompute(); });
    $('multi-kills-prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); if (state.result) renderKills(state.result); }); $('multi-kills-next').addEventListener('click', () => { state.page++; if (state.result) renderKills(state.result); });
    const ready = mode(new URL(win.location.href).searchParams.get('mode') === 'multi', false);
    return { ready };
  }
  return { create, storageKey };
});
