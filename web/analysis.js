(() => {
  'use strict';
  const $ = id => document.getElementById(id), core = window.ReplayAnalysis, heat = window.ReplayHeatmap, library = window.ReplayLibrary, playback = window.ReplayHeatmapPlayback;
  const state = { jobs: new Map(), demos: new Map(), selectedDemos: null, selectedTeams: null, selectedPlayers: null, aliases: {}, map: '', mapInfo: null, image: null, result: null, worker: null, request: 0, mapRequest: 0, uploading: false, cancelled: false, controller: null, currentJob: null, queued: [], pendingCount: 0, selectedGroup: null, selectedThrow: null, zoom: 1, panX: 0, panY: 0, layers: new Map(), fallbackBounds: { minX: -3000, maxX: 3000, minY: -3000, maxY: 3000 } };
  const storageKey = 'cs2-analysis-v4';
  const movementDuration = 115;
  let movementTimer, movementPending = false, workerBusy = false, workerPending = null;
  let playbackRunning = false, playbackTimer = null, playbackGeneration = 0, playbackPending = null, playbackStartedAt = 0, analysisPending = false;
  let playbackLength = playback.defaultWindowLength, playbackSpeed = 1, playbackMessage = '已暂停。固定窗口逐秒前进，计算完成后再更新下一帧。';
  state.movementTime = null;
  let initializing = true, migratedSessionId = '', libraryEnabled = false, libraryRefreshing = false, libraryScanning = false, syncPromise = null, libraryTimer, restoredView = null;
  let libraryInfoRequest = 0;
  const loadingJobs = new Map();
  const catalog = new Map(), catalogSelection = new Set();
  const sourceView = { mode: 'all', folder: 'all', query: '' }, libraryView = { mode: 'all', folder: 'all', query: '', map: 'all' };
  let sourceExpansion = library.createFolderExpansion(), libraryExpansion = library.createFolderExpansion();
  let catalogAdding = false, catalogLoading = false, catalogOpener = null;
  let reparseSubmitting = false, reparseRequestError = '';
  const reparseSkipped = new Map();
  const metricNames = { movement: '移动', engagements: '交火', deaths: '死亡', shots: '开火' };
  const heatResolution = 384;
  const metrics = ['movement', 'engagements', 'deaths', 'shots'];
  const utilityNames = { smoke: '烟雾弹', flash: '闪光弹', he: '高爆手雷', molotov: '燃烧瓶', incendiary: '燃烧弹', decoy: '诱饵弹', unknown: '未知道具' };
  const utilityIcons = { smoke: 'smokegrenade', flash: 'flashbang', he: 'hegrenade', molotov: 'molotov', incendiary: 'incgrenade', decoy: 'decoy' };
  const canvas = $('analysis-canvas'), ctx = canvas.getContext('2d');
  const number = n => Math.round(Number(n) || 0).toLocaleString('zh-CN');
  const seconds = n => n >= 60 ? `${(n / 60).toFixed(1)} 分钟` : `${n.toFixed(1)} 秒`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function message(text, error = true) { $('global-error').hidden = !text; $('global-error').textContent = text || ''; $('global-error').classList.toggle('error', error); }
  async function json(response) { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || body.message || `请求失败（${response.status}）`); return body; }
  function save() {
    if (initializing) return;
    const settings = { ids: [...state.jobs.keys()], selectedDemos: state.selectedDemos && [...state.selectedDemos], selectedTeams: state.selectedTeams && [...state.selectedTeams], selectedPlayers: state.selectedPlayers && [...state.selectedPlayers], map: state.map, aliases: state.aliases, side: $('analysis-side').value, floor: $('analysis-floor').value, utilityType: $('analysis-utility-type').value, utilityTime: $('analysis-utility-time').value, utilitySort: $('utility-sort').value, query: $('player-search').value, layers: metrics.filter(name => $(`layer-${name}`).checked), radius: Number($('heat-radius').value), opacity: Number($('heat-opacity').value), scale: heatMode(), landingDistance: Number($('landing-distance').value), throwDistance: Number($('throw-distance').value), migratedSessionId };
    settings.sourceView = { ...sourceView, folderExpansion: sourceExpansion.snapshot() }; settings.libraryView = { ...libraryView, folderExpansion: libraryExpansion.snapshot() };
    settings.movementTime = state.movementTime;
    settings.heatmapPlayback = { windowLength: playbackLength, speed: playbackSpeed };
    if (restoredView) { settings.map = restoredView.map; settings.floor = restoredView.floor; }
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Private browsing may not offer localStorage. */ }
  }
  function restoreSettings(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    state.aliases = saved.aliases && typeof saved.aliases === 'object' && !Array.isArray(saved.aliases) ? Object.fromEntries(Object.entries(saved.aliases).filter(([, value]) => typeof value === 'string')) : {};
    state.map = typeof saved.map === 'string' ? saved.map : '';
    for (const [key, view, prefix] of [['sourceView', sourceView, 'demo'], ['libraryView', libraryView, 'analysis-library']]) {
      const stored = saved[key];
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        view.mode = stored.mode === 'folders' ? 'folders' : 'all';
        for (const field of ['folder', 'query']) if (typeof stored[field] === 'string') view[field] = stored[field];
        if (key === 'libraryView' && typeof stored.map === 'string') view.map = stored.map;
      }
      if (key === 'sourceView') sourceExpansion = library.createFolderExpansion(stored?.folderExpansion);
      else libraryExpansion = library.createFolderExpansion(stored?.folderExpansion);
      $(`${prefix}-view-mode`).value = view.mode; $(`${prefix}-search`).value = view.query;
    }
    for (const key of ['selectedDemos', 'selectedTeams', 'selectedPlayers']) state[key] = Array.isArray(saved[key]) ? new Set(saved[key].filter(id => typeof id === 'string')) : null;
    for (const [key, id, choices] of [['side', 'analysis-side', ['all', '2', '3']], ['floor', 'analysis-floor', ['all', 'upper', 'lower']], ['utilityType', 'analysis-utility-type', ['all', ...Object.keys(utilityNames)]], ['utilityTime', 'analysis-utility-time', ['all', ...core.utilityTimeBuckets.map(bucket => bucket.key)]], ['utilitySort', 'utility-sort', ['common', 'rare']], ['scale', 'heat-scale', ['log', 'linear']]]) if (choices.includes(saved[key])) $(id).value = saved[key];
    if (typeof saved.query === 'string') $('player-search').value = saved.query;
    if (Array.isArray(saved.layers)) for (const name of metrics) $(`layer-${name}`).checked = saved.layers.includes(name);
    for (const [key, id, min, max] of [['radius', 'heat-radius', 64, 384], ['opacity', 'heat-opacity', 15, 100], ['landingDistance', 'landing-distance', 16, 512], ['throwDistance', 'throw-distance', 16, 256]]) if (Number.isFinite(saved[key])) $(id).value = String(Math.max(min, Math.min(max, saved[key])));
    $('radius-value').textContent = `${$('heat-radius').value} 单位`; $('opacity-value').textContent = `${$('heat-opacity').value}%`;
    migratedSessionId = typeof saved.migratedSessionId === 'string' ? saved.migratedSessionId : '';
    state.movementTime = sanitizeMovementTime(saved.movementTime);
    playbackLength = state.movementTime ? state.movementTime.end - state.movementTime.start : playback.normalizeWindowLength(saved.heatmapPlayback?.windowLength);
    playbackSpeed = playback.normalizeSpeed(saved.heatmapPlayback?.speed); renderMovementTime(); renderPlayback();
  }
  function sanitizeMovementTime(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(value.start) || !Number.isFinite(value.end)) return null;
    const start = Math.max(0, Math.min(movementDuration - 1, Math.round(value.start))), end = Math.max(1, Math.min(movementDuration, Math.round(value.end)));
    return start < end ? { start, end } : null;
  }
  function countdown(elapsed) { const remaining = movementDuration - elapsed; return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`; }
  function movementRangeLabel() { return state.movementTime ? `${countdown(state.movementTime.start)} → ${countdown(state.movementTime.end)}` : '全部时段（含倒计时结束后）'; }
  const playbackNow = () => typeof performance === 'object' ? performance.now() : Date.now();
  function hasPlaybackEvidence() {
    if (!state.result || !state.map || state.result.map !== state.map || !currentDemos().length || !(state.result.totals?.players > 0)) return false;
    if (state.result.heatmapCoverage) return metrics.some(metric => { const evidence = timeCoverage(metric); return evidence && (evidence.timedSeconds || evidence.timedCount || 0) > 0; });
    return currentDemos().some(demo => demo.movementTimingVersion === 1 || demo.eventTimingVersion === 1);
  }
  function canStartPlayback() { return !initializing && !document.hidden && !analysisPending && !movementPending && !libraryRefreshing && !state.uploading && !catalogAdding && playbackLength < movementDuration && hasPlaybackEvidence(); }
  function refreshPlaybackAvailability() {
    const disabled = !playbackRunning && !canStartPlayback();
    $('heatmap-time-play').disabled = disabled; $('heatmap-time-restart').disabled = disabled;
  }
  function renderPlayback() {
    const play = $('heatmap-time-play'), atEnd = state.movementTime?.end === movementDuration;
    refreshPlaybackAvailability(); play.textContent = playbackRunning ? '暂停' : atEnd ? '重新播放' : '播放'; play.setAttribute('aria-pressed', String(playbackRunning));
    $('heatmap-time-window').value = String(playbackLength); $('heatmap-time-speed').value = String(playbackSpeed);
    $('movement-time-label').setAttribute('aria-live', playbackRunning ? 'off' : 'polite'); $('movement-time-coverage').setAttribute('aria-live', playbackRunning ? 'off' : 'polite');
    let status = playbackRunning ? `正在播放 · 固定 ${playbackLength} 秒 · ${playbackSpeed}×。每帧计算完成后推进，道具时段不变。` : playbackMessage;
    if (!playbackRunning && !state.map) status = '选择有回合时间记录的比赛后，可播放热力图。';
    else if (!playbackRunning && playbackLength === movementDuration) status = '窗口已覆盖全部 115 秒；缩短窗口后可播放。';
    else if (!playbackRunning && !analysisPending && !movementPending && !hasPlaybackEvidence()) status = '所选数据缺少可播放的回合时间记录；可调整筛选或重新解析。';
    if ($('heatmap-playback-status').textContent !== status) $('heatmap-playback-status').textContent = status;
  }
  function pausePlayback(reason = '已暂停。可继续播放当前窗口。', force = false) {
    const active = playbackRunning || playbackTimer != null || playbackPending;
    playbackRunning = false; ++playbackGeneration; clearTimeout(playbackTimer); playbackTimer = null;
    if (playbackPending) {
      if (playbackPending.id === state.request) { ++state.request; analysisPending = false; $('computing').hidden = true; $('export-image').disabled = !currentDemos().length; $('export-csv').disabled = !state.result?.utilities?.length; }
      if (workerPending?.id === playbackPending.id) workerPending = null;
      playbackPending = null;
    }
    if (active || force) playbackMessage = reason;
    renderPlayback();
  }
  function schedulePlayback() {
    if (!playbackRunning || playbackTimer != null || playbackPending || workerBusy || analysisPending || movementPending) return;
    if (!hasPlaybackEvidence()) { pausePlayback('缺少可播放的时间记录，已暂停。', true); return; }
    const generation = playbackGeneration, wait = Math.max(0, playback.stepDelay(playbackSpeed) - (playbackNow() - playbackStartedAt));
    playbackTimer = setTimeout(() => {
      playbackTimer = null; if (!playbackRunning || generation !== playbackGeneration) return;
      const next = playback.advanceRange(state.movementTime);
      if (!next) { pausePlayback('已到 0:00。再次播放将从 1:55 开始。', true); return; }
      requestPlaybackFrame(next);
    }, wait);
  }
  function requestPlaybackFrame(range) { playbackStartedAt = playbackNow(); requestAnalysis({ autoplay: true, movementOnly: true, range }); }
  function startPlayback(restart = false) {
    if (playbackRunning && !restart) { pausePlayback(); return; }
    if (!canStartPlayback() && !playbackRunning) return;
    pausePlayback('已暂停。', false);
    const start = playback.prepareStart(restart ? null : state.movementTime, playbackLength);
    playbackLength = start.length; if (!start.canPlay) { renderPlayback(); return; }
    playbackRunning = true; ++playbackGeneration; playbackStartedAt = playbackNow(); renderPlayback(); save();
    if (!state.movementTime || start.range.start !== state.movementTime.start || start.range.end !== state.movementTime.end || movementPending) requestPlaybackFrame(start.range);
    else schedulePlayback();
  }
  function renderMovementTime() {
    const range = state.movementTime || { start: 0, end: movementDuration };
    for (const edge of ['start', 'end']) { const input = $(`movement-time-${edge}`); input.value = String(range[edge]); input.setAttribute('aria-valuetext', `倒计时 ${countdown(range[edge])}，开局后 ${range[edge]} 秒`); $(`movement-time-${edge}-value`).textContent = countdown(range[edge]); }
    $('movement-time-fill').style.left = `${range.start / movementDuration * 100}%`; $('movement-time-fill').style.width = `${(range.end - range.start) / movementDuration * 100}%`;
    $('movement-time-label').textContent = movementRangeLabel(); $('movement-time-all').setAttribute('aria-pressed', String(!state.movementTime));
    $('movement-time-help').textContent = state.movementTime ? `开局后 ${range.start}–${range.end} 秒，含开始、不含结束；冻结结束为 0 秒。移动、交火、死亡、开火同步筛选，道具投掷时段独立。可用方向键每次调整 1 秒。` : '拖动两个手柄选择任意时段；冻结结束为开局 0 秒。当前显示移动、交火、死亡、开火的全部时段（也含倒计时结束后）；道具投掷时段独立设置。';
    if (state.movementTime) playbackLength = range.end - range.start;
    renderPlayback();
  }
  function timeCoverage(metric) { return state.result?.heatmapCoverage?.[metric] || (metric === 'movement' ? state.result?.movementCoverage : null); }
  function missingTime(metric) { return !!state.movementTime && (!timeCoverage(metric) || timeCoverage(metric).status === 'missing'); }
  function timeCoverageLines() {
    return metrics.map(metric => {
      const coverage = timeCoverage(metric), label = metricNames[metric], amount = value => metric === 'movement' ? seconds(value) : `${number(value)} 次`;
      if (!coverage) return `${label}：缺少回合时间证据；不使用整场数据代替，需重新解析。`;
      const unknown = metric === 'movement' ? coverage.unknownSeconds : coverage.unknownCount, beyond = metric === 'movement' ? coverage.beyondSeconds : coverage.beyondCount;
      if (coverage.status === 'missing') return `${label}：缺少时段记录（${coverage.missingDemos > 0 ? `${number(coverage.missingDemos)} 场旧缓存` : '时间来源未知'}）；未用整场数据代替，请重新解析。`;
      if (coverage.status === 'empty') return `${label}：当前筛选没有记录。`;
      if (coverage.status === 'partial') return `${label}：仅显示有时间依据的记录（${number(coverage.timedDemos)} / ${number(coverage.selectedDemos)} 场${unknown > 0 ? `；${amount(unknown)}时间未知` : ''}）；缺失部分未用整场数据代替，可重新解析补齐。`;
      return `${label}：时间记录完整（${number(coverage.timedDemos)} 场）${beyond > 0 ? `；${amount(beyond)}位于 1:55 倒计时之后，切回全部时段可查看` : ''}。`;
    });
  }
  function renderMovementCoverage() {
    const note = $('movement-time-coverage');
    note.hidden = !state.movementTime;
    if (!state.movementTime) { note.textContent = ''; return; }
    if (movementPending) { note.textContent = '正在更新移动、交火、死亡和开火时段…'; return; }
    note.textContent = timeCoverageLines().join('\n');
  }
  function invalidateHeatmapTime() {
    ++state.request; movementPending = true; analysisPending = true; $('computing').hidden = false; $('export-image').disabled = true;
    for (const metric of metrics) $(`metric-${metric}`).textContent = '计算中…';
    renderMovementCoverage(); rebuildHeat();
  }
  function setMovementEdge(edge, flush = false) {
    pausePlayback('已暂停：已手动调整时间窗口。');
    const current = state.movementTime || { start: 0, end: movementDuration }, raw = Number($(`movement-time-${edge}`).value);
    const value = Math.max(0, Math.min(movementDuration, Math.round(Number.isFinite(raw) ? raw : current[edge])));
    const next = { ...current, [edge]: edge === 'start' ? Math.min(value, current.end - 1) : Math.max(value, current.start + 1) };
    const changed = !state.movementTime || next.start !== current.start || next.end !== current.end;
    if (changed) {
      state.movementTime = next; renderMovementTime(); invalidateHeatmapTime(); save();
    }
    else renderMovementTime();
    if (flush) { if (movementTimer || changed) requestAnalysis({ movementOnly: true }); }
    else if (changed && !movementTimer) movementTimer = setTimeout(() => { movementTimer = null; requestAnalysis({ movementOnly: true }); }, 100);
  }
  function sendWorkerRequest(job) { workerBusy = true; state.worker.postMessage(job); }
  function currentDemos() { return [...state.demos.values()].filter(d => d.map === state.map && (!state.selectedDemos || state.selectedDemos.has(d.id))); }
  function updateWorkerData() { pausePlayback('已暂停：比赛数据已更新。'); state.worker?.postMessage({ type: 'datasets', datasets: [...state.demos.values()] }); }
  function requestAnalysis(options = {}) {
    if (!options.autoplay) pausePlayback('已暂停：筛选已更新。');
    clearTimeout(movementTimer); movementTimer = null;
    if (!state.map) {
      movementPending = false; analysisPending = false; workerPending = null;
      ++state.request; state.result = null; state.selectedGroup = state.selectedThrow = null; clearHeat(); renderLegend();
      $('computing').hidden = true; $('analysis-empty').hidden = false; $('selection-empty').hidden = true;
      $('selection-summary').textContent = '选择比赛、队伍或玩家，开始分析。';
      for (const id of ['metric-movement', 'metric-engagements', 'metric-deaths', 'metric-shots', 'metric-utilities']) $(id).textContent = '—';
      $('export-image').disabled = $('export-csv').disabled = true; renderMovementCoverage(); renderUtilityGroups(); draw(); save(); renderPlayback(); return;
    }
    const filter = { map: state.map, demoIds: state.selectedDemos && [...state.selectedDemos], teamIds: state.selectedTeams && [...state.selectedTeams], playerIds: state.selectedPlayers && [...state.selectedPlayers], sides: $('analysis-side').value === 'all' ? [2, 3] : [Number($('analysis-side').value)], floor: $('analysis-floor').value, lowerMaxZ: state.mapInfo?.lowerMaxZ, teamAliases: state.aliases, utilityType: $('analysis-utility-type').value, utilityTime: $('analysis-utility-time').value };
    const cluster = { landing: Number($('landing-distance').value) || 128, throwing: Number($('throw-distance').value) || 64, lowerMaxZ: state.mapInfo?.lowerMaxZ };
    filter.movementTime = options.autoplay ? options.range : state.movementTime;
    const id = ++state.request;
    analysisPending = true;
    if (options.autoplay) playbackPending = { id, range: { ...options.range } };
    $('computing').hidden = false;
    $('export-image').disabled = $('export-csv').disabled = true;
    if (!options.movementOnly) { state.selectedGroup = null; state.selectedThrow = null; }
    if (state.worker) { const job = { type: 'compute', id, filter, cluster }; if (workerBusy) workerPending = job; else sendWorkerRequest(job); }
    else {
      setTimeout(() => {
        if (id !== state.request) return;
        try { const result = core.aggregate([...state.demos.values()], filter); result.groups = core.clusterUtilities(result.utilities, cluster); applyAnalysis(id, result); }
        catch (error) { analysisFailed(error.message); }
      }, 0);
    }
    save(); renderPlayback();
  }
  function analysisFailed(error) { analysisPending = false; pausePlayback('计算失败，播放已暂停。可调整筛选后重试。', true); message(`分析失败：${error}`); $('computing').hidden = true; }
  function applyAnalysis(id, result) {
    if (id !== state.request) return;
    if (playbackPending?.id === id) { state.movementTime = playbackPending.range; playbackPending = null; renderMovementTime(); save(); }
    analysisPending = false;
    state.result = result; $('computing').hidden = true;
    movementPending = false; renderMovementCoverage();
    const total = result.totals;
    $('metric-movement').textContent = missingTime('movement') ? '缺少时间记录' : seconds(total.movementSeconds);
    for (const metric of ['engagements', 'deaths', 'shots']) $(`metric-${metric}`).textContent = missingTime(metric) ? '缺少时间记录' : number(total[metric]);
    $('metric-utilities').textContent = number(total.utilities);
    const available = currentDemos();
    $('selection-summary').textContent = `${available.length} 场已选比赛 · ${total.players} 名有记录玩家 · ${total.teams} 支队伍 · ${$('analysis-side').selectedOptions[0].textContent}${available.some(d => d.synthetic) ? ' · 含合成示例' : ''}`;
    $('analysis-empty').hidden = !!state.demos.size;
    $('selection-empty').hidden = !state.demos.size || result.cells.length > 0 || result.utilities.length > 0;
    $('export-image').disabled = !available.length;
    $('export-csv').disabled = !result.utilities.length;
    renderUtilityGroups(); rebuildHeat();
    if (playbackRunning && state.movementTime?.end === movementDuration) pausePlayback('已到 0:00。再次播放将从 1:55 开始。', true);
    else { renderPlayback(); schedulePlayback(); }
  }
  function toggleSet(key, id, allIds, checked) {
    if (!state[key]) state[key] = new Set(allIds);
    if (checked) state[key].add(id); else state[key].delete(id);
  }
  function sourceDemo(job) {
    const source = catalog.get(job.id);
    return { ...source, ...job, sources: source ? source.sources : job.sources, sourceCount: source ? source.sourceCount : job.sourceCount, available: source ? source.available : job.available, map: job.map || state.demos.get(job.id)?.map || source?.map || '' };
  }
  function filterList(demos, view) {
    return demos.filter(demo => library.matches(demo, view.query) && (view.mode !== 'folders' || library.inFolder(demo, view.folder)));
  }
  function renderFolderControls(prefix, demos, view) {
    const select = $(`${prefix}-folder`), options = library.folderOptions(demos); select.replaceChildren(new Option('全部文件夹', 'all'));
    for (const option of options) select.append(new Option(`${option.label} · ${number(option.count)} 场`, option.key));
    if (view.folder !== 'all' && !options.some(option => option.key === view.folder)) select.append(new Option(`${library.folderLabel(view.folder)} · 当前范围暂无录像`, view.folder));
    select.value = view.folder; $(`${prefix}-folder-field`).hidden = view.mode !== 'folders'; $(`${prefix}-view-mode`).value = view.mode;
    $(`${prefix}-folder-expansion-actions`).hidden = view.mode !== 'folders';
  }
  function folderMembers(scope, key) {
    const demos = scope === 'catalog' ? [...catalog.values()] : [...state.jobs.values()].map(sourceDemo);
    return [...new Map(demos.filter(demo => library.inFolder(demo, key)).map(demo => [demo.id, demo])).values()];
  }
  function folderSelectable(scope, demo) { return scope === 'catalog' ? catalogSelectable(demo) : state.demos.has(demo.id); }
  function folderSelectionBusy(scope) { return state.uploading || catalogAdding || scope === 'catalog' && catalogLoading; }
  function folderSelected(scope, id) { return scope === 'catalog' ? catalogSelection.has(id) : !state.selectedDemos || state.selectedDemos.has(id); }
  function changeFolderSelection(scope, key, action) {
    if (folderSelectionBusy(scope) || !['all', 'none', 'invert'].includes(action)) return;
    const members = folderMembers(scope, key);
    if (scope !== 'catalog' && !state.selectedDemos) state.selectedDemos = new Set(state.jobs.keys());
    const selection = scope === 'catalog' ? catalogSelection : state.selectedDemos;
    for (const demo of members) {
      if (action === 'none' || action === 'invert' && selection.has(demo.id)) selection.delete(demo.id);
      else if (folderSelectable(scope, demo)) selection.add(demo.id);
    }
    if (scope === 'catalog') renderCatalog();
    else { renderJobs(); renderFilters(); requestAnalysis(); }
  }
  function folderExpansion(scope) { return scope === 'catalog' ? libraryExpansion : sourceExpansion; }
  function changeFolderExpansion(scope, key, expanded) {
    const expansion = folderExpansion(scope);
    if (key == null) expansion.setAll(expanded); else expansion.setExpanded(key, expanded);
    if (scope === 'catalog') renderCatalog(); else renderJobs();
    save();
  }
  function appendFolderGroups(list, demos, view, appendRow, scope) {
    for (const group of library.groupByFolder(demos, view.mode, view.folder)) {
      let target = list;
      if (view.mode === 'folders') {
        target = node('section', null, 'analysis-folder-group'); target.dataset.folderKey = group.key;
        const members = folderMembers(scope, group.key), count = members.length, shown = new Set(group.demos.map(demo => demo.id)).size;
        const expanded = folderExpansion(scope).isExpanded(group.key), body = node('div', null, 'analysis-folder-body');
        body.id = `${list.id}-folder-${encodeURIComponent(group.key)}`; body.dataset.folderBody = group.key; body.hidden = !expanded;
        const header = node('header', null, 'analysis-folder-header'), heading = node('h3', null, 'analysis-folder-heading'); heading.title = group.label;
        const toggle = node('button', `${expanded ? '▾' : '▸'} ${group.label}`, 'analysis-folder-toggle'); toggle.type = 'button'; toggle.dataset.folderToggle = group.key;
        toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-controls', body.id); toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'}文件夹 ${group.label}`);
        toggle.addEventListener('click', () => {
          changeFolderExpansion(scope, group.key, !folderExpansion(scope).isExpanded(group.key));
          [...list.querySelectorAll('button')].find(button => button.dataset.folderToggle === group.key)?.focus?.();
        });
        heading.append(toggle);
        const explanation = `本文件夹共 ${number(count)} 场 · 当前显示 ${number(shown)} 场；操作包含地图或搜索隐藏项，只添加可选录像。`;
        const note = node('p', explanation, 'analysis-folder-scope');
        const actions = node('div', null, 'analysis-folder-actions');
        for (const [action, label] of [['all', '全选'], ['none', '清空'], ['invert', '反选']]) {
          const button = node('button', label, 'text-button'); button.type = 'button'; button.dataset.folderAction = action; button.dataset.folderKey = group.key;
          button.title = `${label}本文件夹。${explanation}其他文件夹独有录像保持勾选状态。`;
          button.setAttribute('aria-label', `${label}文件夹 ${group.label} 中的录像（包括地图或搜索隐藏项）`);
          button.disabled = folderSelectionBusy(scope) || !members.some(demo => action === 'none' ? folderSelected(scope, demo.id) : folderSelectable(scope, demo) || action === 'invert' && folderSelected(scope, demo.id));
          button.addEventListener('click', () => changeFolderSelection(scope, group.key, action)); actions.append(button);
        }
        header.append(heading, note, actions); target.append(header, body); list.append(target); target = body;
      }
      for (const demo of group.demos) appendRow(demo, target, group.key);
    }
  }
  function groupSourcePaths(demo, key) {
    if (key === 'all') return library.sourcePaths(demo);
    return library.sourcePaths({ sources: (Array.isArray(demo.sources) ? demo.sources : []).filter(source => library.folderKeys({ sources: [source] }).includes(key)) });
  }
  function sourceScope() {
    const activeMap = state.map || restoredView?.map || '', jobs = [...state.jobs.values()].map(sourceDemo);
    const availableMaps = new Set([...state.demos.values()].map(demo => demo.map));
    return { activeMap, jobs, current: jobs.filter(job => activeMap && job.map === activeMap), unmapped: jobs.filter(job => !job.map || (job.map !== activeMap && !availableMaps.has(job.map))) };
  }
  function visibleSourceJobs() { const scope = sourceScope(); return [...new Map(filterList([...scope.current, ...scope.unmapped], sourceView).map(job => [job.id, job])).values()]; }
  function changeSourceSelection(action) {
    const visible = visibleSourceJobs().filter(job => state.demos.has(job.id));
    if (!state.selectedDemos) state.selectedDemos = new Set(state.jobs.keys());
    for (const job of visible) {
      if (action === 'all' || action === 'invert' && !state.selectedDemos.has(job.id)) state.selectedDemos.add(job.id);
      else state.selectedDemos.delete(job.id);
    }
    renderJobs(); renderFilters(); requestAnalysis();
  }
  function renderJobs() {
    const scope = sourceScope(), { activeMap, jobs } = scope, mapOf = job => job.map;
    renderFolderControls('demo', [...scope.current, ...scope.unmapped], sourceView);
    const current = filterList(scope.current, sourceView), unmapped = filterList(scope.unmapped, sourceView);
    $('demo-count').textContent = `本图 ${number(scope.current.length)} / 共 ${number(state.jobs.size + state.pendingCount)} 场`;
    $('demo-scope').textContent = (activeMap ? `只显示 ${activeMap}；切换下方地图查看其他比赛。` : '选择下方地图查看对应比赛；地图未识别的任务列在下面。') + ` 当前列表 ${number(new Set([...current, ...unmapped].map(job => job.id)).size)} 场；列表分类与搜索不会改变分析勾选。`;
    const list = $('demo-list'), pendingList = $('unmapped-demo-list'); list.replaceChildren(); pendingList.replaceChildren();
    $('unmapped-demos').hidden = !unmapped.length;
    $('unmapped-demo-count').textContent = `${unmapped.some(job => mapOf(job)) ? '待完成分析' : '待识别地图'} · ${number(unmapped.length)} 场`;
    const appendRow = (job, target, groupKey) => {
      const row = node('div', null, 'check-item'), label = node('label'), check = document.createElement('input'), words = node('span');
      row.dataset.demoId = job.id; label.style.display = 'contents'; check.type = 'checkbox'; check.dataset.demoId = job.id; check.checked = !state.selectedDemos || state.selectedDemos.has(job.id); check.disabled = !state.demos.has(job.id); check.setAttribute('aria-label', `叠加 ${job.name || job.id}`);
      check.addEventListener('change', () => { toggleSet('selectedDemos', job.id, [...state.jobs.keys()], check.checked); state.selectedTeams = null; state.selectedPlayers = null; renderJobs(); renderFilters(); requestAnalysis(); });
      const title = node('strong', job.name || '解析中的比赛'); title.title = job.name || '';
      const info = node('small', job.status === 'ready' ? `${job.map || ''}${job.synthetic ? ' · 合成示例' : ''}` : [mapOf(job), job.error || job.message || '正在处理…'].filter(Boolean).join(' · '), job.synthetic ? 'badge-synthetic' : job.status === 'error' ? 'status-error' : '');
      words.append(title, info);
      const paths = library.sourcePaths(job);
      if (paths.length) { const source = node('small', groupSourcePaths(job, groupKey)[0] || paths[0], 'demo-source-path'); source.title = paths.join('\n'); words.append(source); }
      if (job.summaryError) words.append(node('small', `新摘要读取失败，暂用旧结果：${job.summaryError}`, 'warning-inline'));
      if (job.warnings?.length) { const warning = node('small', `⚠ ${job.warnings[0]}${job.warnings.length > 1 ? `（另有 ${job.warnings.length - 1} 条提示）` : ''}`, 'warning-inline'); warning.title = job.warnings.join('\n'); words.append(warning); }
      label.append(check, words); row.append(label);
      const focus = node('button', '查看', 'text-button demo-focus'); focus.type = 'button'; focus.disabled = !state.demos.has(job.id); focus.title = '切换到这场 Demo 的地图并显示其队伍与玩家'; focus.setAttribute('aria-label', `查看 ${job.name || '比赛'} 所在地图`);
      focus.addEventListener('click', () => { const data = state.demos.get(job.id); if (data) void focusDemo(data); }); row.append(focus);
      const remove = node('button', '×', 'demo-remove'); remove.title = '从分析移除，保留录像库与回放缓存'; remove.setAttribute('aria-label', `移除 ${job.name || '比赛'}`); remove.disabled = state.uploading && state.currentJob === job.id; remove.addEventListener('click', () => removeJob(job.id)); row.append(remove); target.append(row);
    };
    appendFolderGroups(list, current, sourceView, appendRow, 'source'); appendFolderGroups(pendingList, unmapped, sourceView, appendRow, 'source');
    for (const action of ['all', 'none', 'invert']) $(`demos-${action}`).disabled = ![...current, ...unmapped].some(job => state.demos.has(job.id));
    if (!current.length) list.append(node('p', activeMap ? '当前地图、文件夹或搜索没有匹配比赛；已有勾选仍保留。' : jobs.length ? '等待识别地图，或在下方选择已有地图。' : '从本地录像库选择比赛，加入后才开始分析。', 'muted'));
    $('sample-analysis').disabled = state.uploading || catalogAdding;
    $('refresh-library').disabled = !libraryEnabled || libraryRefreshing || libraryScanning || state.uploading || catalogAdding;
    renderCatalog();
    renderReparse();
    // Refresh/import/catalog completion all render jobs after clearing their
    // busy flags, even when compute finished first or the operation failed.
    refreshPlaybackAvailability();
  }
  function importedReadyJobs() { return [...state.jobs.values()].filter(job => job.owned && !job.synthetic && job.status === 'ready'); }
  function reparseActive(job) { return ['queued', 'parsing'].includes(job.reparse?.status); }
  function reparseFailures() {
    const failures = new Map([...reparseSkipped].filter(([id]) => state.jobs.has(id)));
    for (const job of state.jobs.values()) if (job.reparse?.status === 'error' && !failures.has(job.id)) failures.set(job.id, { id: job.id, name: job.name, error: job.reparse.error || job.reparse.message || '重新解析失败' });
    return failures;
  }
  function renderReparse() {
    const jobs = importedReadyJobs(), active = jobs.filter(reparseActive), failures = reparseFailures();
    $('reparse-analyses').textContent = reparseSubmitting ? '正在提交重新解析…' : active.length ? `重新解析中（${active.length} 场）` : `重新解析已导入（${jobs.length} 场）`;
    $('reparse-analyses').disabled = reparseSubmitting || state.uploading || catalogAdding || !!active.length || !jobs.length;
    $('retry-reparse-failures').hidden = !failures.size;
    $('retry-reparse-failures').disabled = reparseSubmitting || state.uploading || catalogAdding || !!active.length || !jobs.some(job => failures.has(job.id));
    const attempts = jobs.filter(job => job.reparse && !reparseSkipped.has(job.id));
    const queued = attempts.filter(job => job.reparse.status === 'queued').length, parsing = attempts.filter(job => job.reparse.status === 'parsing').length, completed = attempts.filter(job => job.reparse.status === 'ready').length;
    $('analysis-reparse-status').hidden = !reparseSubmitting && !attempts.length && !failures.size && !reparseRequestError;
    $('analysis-reparse-summary').textContent = reparseRequestError || (reparseSubmitting ? '正在提交已加入分析的比赛…' : `重新解析：等待 ${queued} · 进行 ${parsing} · 完成 ${completed} · 失败 / 跳过 ${failures.size}`);
    const progress = attempts.reduce((sum, job) => sum + (['ready', 'error'].includes(job.reparse.status) ? 1 : Math.max(0, Math.min(1, Number(job.reparse.progress) || 0))), 0);
    $('analysis-reparse-progress').value = attempts.length ? progress / attempts.length : 0;
    $('analysis-reparse-progress').hidden = !active.length;
    const details = $('analysis-reparse-details'); details.replaceChildren();
    for (const job of active) details.append(node('li', `${job.name || job.id}：${job.reparse.message || (job.reparse.status === 'queued' ? '等待重新解析' : '正在重新解析')}${job.reparse.status === 'parsing' ? ` · ${Math.round((Number(job.reparse.progress) || 0) * 100)}%` : ''}`));
    for (const failure of failures.values()) details.append(node('li', `${failure.name || failure.id}：${failure.error}。旧结果仍保留。`, 'status-error'));
    details.hidden = !details.childElementCount;
  }
  async function requestReparse(ids) {
    if (reparseSubmitting || state.uploading || catalogAdding || importedReadyJobs().some(reparseActive)) return;
    const eligible = new Set(importedReadyJobs().map(job => job.id)), selected = [...new Set(ids)].filter(id => eligible.has(id));
    if (!selected.length) return;
    pausePlayback('已暂停：正在更新比赛解析数据。');
    reparseSubmitting = true; reparseRequestError = ''; renderReparse();
    try {
      const result = await json(await fetch('/api/library/reparse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected }) }));
      for (const id of selected) reparseSkipped.delete(id);
      for (const id of result.queued || []) { const job = state.jobs.get(id); if (job) job.reparse = { status: 'queued', progress: 0, message: '等待重新解析' }; }
      for (const id of result.active || []) { const job = state.jobs.get(id); if (job && !reparseActive(job)) job.reparse = { status: 'parsing', progress: 0, message: '已有重新解析任务，继续等待' }; }
      for (const skipped of result.skipped || []) reparseSkipped.set(skipped.id, skipped);
      renderReparse();
      if (syncPromise) await syncPromise;
      await syncServerJobs();
    } catch (error) { reparseRequestError = `重新解析请求失败：${error.message}。旧缓存与筛选仍保留，可重试。`; }
    finally { reparseSubmitting = false; renderReparse(); scheduleLibraryPoll(); }
  }
  async function removeJob(id) {
    pausePlayback('已暂停：比赛选择已更新。');
    const job = state.jobs.get(id);
    if (!job) return;
    if (job.owned) {
      try { const response = await fetch(`/api/analyses/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!response.ok) throw new Error('从分析移除比赛失败'); }
      catch (error) { message(error.message); return; }
    }
    if (catalog.has(id)) catalog.get(id).analysis = false;
    state.jobs.delete(id); state.demos.delete(id); state.selectedDemos?.delete(id); updateWorkerData(); renderJobs(); await refreshMaps(); renderFilters(); requestAnalysis(); save();
  }
  function availableTeams() {
    const teams = new Map();
    for (const d of currentDemos()) for (const t of d.teams || []) {
      const key = core.teamKey(d.id, t.id, state.aliases);
      if (!teams.has(key)) teams.set(key, { id: key, name: state.aliases[`${d.id}|${t.id}`] || state.aliases[t.id] || t.name || '未命名队伍', demos: new Set(), playerIds: new Set(), source: t.identitySource });
      const team = teams.get(key); team.demos.add(d.id); (t.playerIds || []).forEach(id => team.playerIds.add(id));
    }
    return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function renderFilters() {
    const teams = availableTeams(), list = $('team-list'); list.replaceChildren();
    for (const team of teams) {
      const label = node('label', null, 'check-item'), check = document.createElement('input'), text = node('span');
      check.type = 'checkbox'; check.checked = !state.selectedTeams || state.selectedTeams.has(team.id); check.setAttribute('aria-label', `筛选队伍 ${team.name}`);
      check.addEventListener('change', () => { toggleSet('selectedTeams', team.id, teams.map(t => t.id), check.checked); renderPlayers(); requestAnalysis(); });
      const identity = team.source === 'clan' ? '队名识别' : team.source === 'roster' ? '阵容识别' : team.source === 'ambiguous' ? '身份有歧义 · 未跨场合并' : '单场身份';
      text.append(node('strong', team.name), node('small', `${team.demos.size} 场 · ${team.playerIds.size} 个 ID${team.id.startsWith('alias:') ? ' · 手动分组' : ` · ${identity}`}`)); label.append(check, text); list.append(label);
    }
    if (!teams.length) list.append(node('p', '当前地图没有可选队伍', 'muted'));
    const aliasList = $('team-aliases'); aliasList.replaceChildren();
    const rawTeams = new Map();
    for (const d of currentDemos()) for (const t of d.teams || []) if (!rawTeams.has(t.id)) rawTeams.set(t.id, t);
    for (const t of rawTeams.values()) {
      const label = node('label', t.name || t.id, 'alias-row'), input = document.createElement('input'); input.type = 'text'; input.maxLength = 70; input.placeholder = '同一分组名 = 同一队伍'; input.value = state.aliases[t.id] || ''; input.dataset.teamId = t.id; input.setAttribute('aria-label', `${t.name || t.id} 的合并分组`); label.append(input); aliasList.append(label);
    }
    renderPlayers();
  }
  function availablePlayers() {
    const players = new Map();
    for (const d of currentDemos()) for (const p of d.players || []) {
      if (!players.has(p.id)) players.set(p.id, { ...p, names: new Set(), demos: new Set() });
      players.get(p.id).names.add(p.name); players.get(p.id).demos.add(d.id);
    }
    return [...players.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  function selectTeamPlayers(ids, invert) {
    if (!state.selectedPlayers) state.selectedPlayers = new Set(availablePlayers().map(p => p.id));
    for (const id of ids) {
      if (invert && state.selectedPlayers.has(id)) state.selectedPlayers.delete(id);
      else state.selectedPlayers.add(id);
    }
    renderPlayers(); requestAnalysis();
  }
  function renderPlayers() {
    const all = availablePlayers(), query = $('player-search').value.trim().toLocaleLowerCase(), list = $('player-list'); list.replaceChildren();
    const allIds = all.map(p => p.id), checked = id => !state.selectedPlayers || state.selectedPlayers.has(id);
    $('player-selection-count').textContent = `已勾选 ${allIds.filter(checked).length} / ${all.length} 个 ID`;
    for (const id of ['players-all', 'players-none', 'players-invert']) $(id).disabled = !all.length;
    const groups = availableTeams().map(team => ({ ...team, members: all.filter(p => team.playerIds.has(p.id)) }));
    const grouped = new Set(groups.flatMap(group => group.members.map(p => p.id)));
    const unassigned = all.filter(p => !grouped.has(p.id));
    if (unassigned.length) groups.push({ id: 'unassigned', name: '未分组', members: unassigned });
    for (const group of groups) {
      const visible = group.members.filter(player => !query || group.name.toLocaleLowerCase().includes(query) || `${[...player.names].join(' / ')} ${player.id}`.toLocaleLowerCase().includes(query));
      if (!visible.length) continue;
      const excluded = group.id !== 'unassigned' && state.selectedTeams && !state.selectedTeams.has(group.id);
      const section = node('section', null, `player-group${excluded ? ' is-excluded' : ''}`); section.dataset.teamId = group.id;
      const header = node('div', null, 'player-group-header'), title = node('strong', group.name), count = node('span', `${group.members.filter(p => checked(p.id)).length} / ${group.members.length} 已选`, 'player-group-count'); title.title = group.name;
      const actions = node('div', null, 'selection-actions');
      for (const [action, label] of [['all', '全选'], ['invert', '反选']]) {
        const button = node('button', label, 'text-button'); button.type = 'button'; button.dataset.action = action;
        button.setAttribute('aria-label', `${label} ${group.name} 的队员`); button.title = `${label}该队全部 ${group.members.length} 个 ID，包含搜索隐藏的队员`;
        button.addEventListener('click', () => selectTeamPlayers(group.members.map(p => p.id), action === 'invert')); actions.append(button);
      }
      header.append(title, count, actions); section.append(header);
      if (excluded) section.append(node('p', '队伍筛选已排除此队；勾选上方队伍后生效。', 'player-group-excluded'));
      for (const player of visible) {
        const names = [...player.names].filter(Boolean).join(' / ');
        const label = node('label', null, 'check-item'), check = document.createElement('input'), text = node('span'); check.type = 'checkbox'; check.checked = !state.selectedPlayers || state.selectedPlayers.has(player.id); check.setAttribute('aria-label', `筛选玩家 ${names} ${player.id}`);
        check.dataset.playerId = player.id;
        check.addEventListener('change', () => { toggleSet('selectedPlayers', player.id, allIds, check.checked); renderPlayers(); requestAnalysis(); });
        const title = node('strong', names || '未知玩家'); title.title = names;
        const detail = node('small', `${player.stable ? player.id : '非稳定 ID · 单场隔离'} · ${player.demos.size} 场`); detail.title = player.id;
        text.append(title, detail); label.append(check, text); section.append(label);
      }
      list.append(section);
    }
    if (!list.childElementCount) list.append(node('p', query ? '没有匹配的玩家' : '当前地图没有可选玩家', 'muted'));
  }
  async function refreshMaps(preferredMap) {
    const names = [...new Set([...state.demos.values()].map(d => d.map))].sort();
    const select = $('analysis-map'); select.replaceChildren();
    for (const name of names) select.append(new Option(`${name} · ${[...state.demos.values()].filter(d => d.map === name).length} 场`, name));
    select.disabled = !names.length;
    if (!names.length) select.append(new Option('等待导入', ''));
    const waitingForSavedMap = restoredView && !names.includes(restoredView.map) && [...state.jobs.values()].some(job => job.status !== 'ready' && job.status !== 'error');
    const preferred = preferredMap || restoredView?.map;
    const next = waitingForSavedMap ? '' : names.includes(preferred) ? preferred : names.includes(state.map) ? state.map : names[0] || '';
    select.value = next;
    if (next !== state.map || !state.mapInfo) await loadMap(next);
    if (restoredView && !waitingForSavedMap) {
      if (next === restoredView.map && restoredView.floor !== 'all' && Number.isFinite(state.mapInfo?.lowerMaxZ)) { $('analysis-floor').value = restoredView.floor; await loadMapImage(); }
      else if (next && next !== restoredView.map) { state.selectedTeams = state.selectedPlayers = null; $('player-search').value = ''; }
      restoredView = null;
    }
    $('map-hint').textContent = names.length > 1 ? `${names.length} 张地图已分组；只叠加当前地图。` : '不同地图分开统计，不会混合坐标。';
    renderJobs();
  }
  async function loadMap(name) {
    pausePlayback('已暂停：地图已切换。');
    const request = ++state.mapRequest;
    ++state.request; state.result = null; state.selectedGroup = state.selectedThrow = null;
    state.map = name; state.mapInfo = null; state.image = null; state.zoom = 1; state.panX = 0; state.panY = 0; clearHeat();
    renderJobs();
    const sameMap = [...state.demos.values()].filter(d => d.map === name);
    const bounds = sameMap.map(d => d.bounds).filter(b => b && [b.minX, b.maxX, b.minY, b.maxY].every(Number.isFinite));
    if (bounds.length) state.fallbackBounds = { minX: Math.min(...bounds.map(b => b.minX)) - 256, maxX: Math.max(...bounds.map(b => b.maxX)) + 256, minY: Math.min(...bounds.map(b => b.minY)) - 256, maxY: Math.max(...bounds.map(b => b.maxY)) + 256 };
    $('map-title').textContent = name ? name.replace(/^de_/, '').toUpperCase() : '让习惯浮出地图'; $('canvas-map-name').textContent = name || 'NO MAP';
    $('analysis-floor').value = 'all'; $('analysis-floor').disabled = true; $('canvas-floor').textContent = name ? '全部楼层 · 坐标网格' : '等待数据';
    if (name) {
      try {
        const map = await json(await fetch(`/api/maps/${encodeURIComponent(name)}`));
        if (request !== state.mapRequest) return;
        state.mapInfo = map; $('analysis-floor').disabled = !Number.isFinite(map.lowerMaxZ); await loadMapImage();
      } catch { if (request === state.mapRequest) $('canvas-floor').textContent = '坐标网格 · 此地图暂无底图'; }
    }
    if (request === state.mapRequest) draw();
  }
  async function loadMapImage() {
    pausePlayback('已暂停：地图楼层已更新。');
    const map = state.mapInfo; if (!map) return;
    const request = state.mapRequest, floor = $('analysis-floor').value, image = new Image();
    image.src = floor === 'lower' && map.lowerRadar ? map.lowerRadar : map.radar;
    try { await image.decode(); if (request === state.mapRequest && floor === $('analysis-floor').value) state.image = image; }
    catch { if (request === state.mapRequest) state.image = null; }
    if (request !== state.mapRequest) return;
    $('canvas-floor').textContent = `${floor === 'lower' ? '下层' : floor === 'upper' ? '上层' : '全部楼层'}${floor === 'all' && map.lowerRadar ? ' · 上层底图' : ''} · ${state.image ? '雷达底图' : '坐标网格'}`;
    draw();
  }
  async function loadJob(id, options = {}) {
    let pending = loadingJobs.get(id);
    if (!pending) {
      pending = fetch(`/api/demos/${encodeURIComponent(id)}/analysis`, { signal: options.signal }).then(json);
      loadingJobs.set(id, pending);
    }
    let data;
    try { data = await pending; } finally { if (loadingJobs.get(id) === pending) loadingJobs.delete(id); }
    if (!data || !Array.isArray(data.series) || !Array.isArray(data.players)) throw new Error('分析摘要格式不完整，请重新导入 Demo。');
    if (options.batch && !state.jobs.has(id)) return null;
    const existing = state.jobs.get(id);
    state.jobs.set(id, { ...existing, ...options, id, name: data.name, map: data.map, status: 'ready', synthetic: data.synthetic, warnings: data.warnings, loadedRevision: existing?.revision, summaryError: '' }); state.demos.set(id, data);
    if (options.batch) return data;
    updateWorkerData(); renderJobs();
    if (options.focus) await focusDemo(data);
    else { await refreshMaps(); renderFilters(); requestAnalysis(); }
    return data;
  }
  function scheduleLibraryPoll() {
    clearTimeout(libraryTimer);
    if (!state.uploading && (libraryScanning || [...state.jobs.values()].some(job => job.owned && (!['ready', 'error', 'discovered'].includes(job.status) || reparseActive(job) || job.summaryError)))) {
      libraryTimer = setTimeout(async () => {
        try { await loadLibraryInfo(true); await syncServerJobs(); }
        catch (error) { $('library-status').textContent = `更新解析进度失败：${error.message}。正在重试…`; scheduleLibraryPoll(); }
      }, 1200);
    }
  }
  async function syncServerJobs(options = {}) {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const [response, library] = await Promise.all([json(await fetch('/api/analyses', { cache: 'no-store' })), json(await fetch('/api/library/demos', { cache: 'no-store' }))]);
      catalog.clear();
      for (const demo of library.demos || []) catalog.set(demo.id, demo);
      if (!library.scanning) {
        for (const id of catalogSelection) if (!catalog.has(id)) catalogSelection.delete(id);
      }
      const jobs = Array.isArray(response) ? response : response.demos || [];
      // Keep changed, previously selected sources visible without reusing their stale summary.
      for (const demo of catalog.values()) if (demo.analysis && demo.status === 'discovered' && !jobs.some(job => job.id === demo.id)) jobs.push({ ...demo, message: '来源已更新，请从录像库选择后重新解析' });
      const known = new Set(jobs.map(job => job.id)), knownSources = new Set([...known, ...catalog.keys()]);
      let changed = false;
      if (options.pruneSelection && state.selectedDemos) {
        const hadSelection = state.selectedDemos.size > 0;
        state.selectedDemos = new Set([...state.selectedDemos].filter(id => knownSources.has(id)));
        if (hadSelection && !state.selectedDemos.size) state.selectedDemos = null;
      }
      for (const [id, job] of state.jobs) if (job.owned && !known.has(id)) {
        state.jobs.delete(id); changed = state.demos.delete(id) || changed; if (!catalog.has(id)) state.selectedDemos?.delete(id);
      }
      const ready = [];
      for (const job of jobs) {
        const existing = state.jobs.get(job.id);
        if (['queued', 'parsing', 'ready'].includes(job.reparse?.status)) reparseSkipped.delete(job.id);
        state.jobs.set(job.id, { ...existing, ...job, owned: true });
        if (job.status !== 'ready') changed = state.demos.delete(job.id) || changed;
        else if (!state.demos.has(job.id) || (job.revision && job.revision !== existing?.loadedRevision)) ready.push(job.id);
      }
      // Bound browser fetch/decode work; recompute once for the complete batch.
      if (changed || ready.length) pausePlayback('已暂停：比赛数据已更新。');
      for (let offset = 0; offset < ready.length; offset += 3) {
        await Promise.all(ready.slice(offset, offset + 3).map(async id => {
          try { await loadJob(id, { owned: true, batch: true }); changed = true; }
          catch (error) {
            if (state.jobs.has(id)) Object.assign(state.jobs.get(id), state.demos.has(id) ? { summaryError: error.message } : { status: 'error', error: error.message });
          }
        }));
      }
      renderJobs();
      if (options.render !== false && (changed || !state.result)) {
        if (!restoredView && state.map && ![...state.demos.values()].some(demo => demo.map === state.map)) restoredView = { map: state.map, floor: $('analysis-floor').value };
        if (changed) updateWorkerData();
        await refreshMaps(); renderFilters(); requestAnalysis();
      }
      const pending = [...state.jobs.values()].filter(job => !['ready', 'error', 'discovered'].includes(job.status)).length;
      $('library-progress').textContent = pending ? `${pending} 场等待或正在解析 · 完成后自动更新` : '';
      scheduleLibraryPoll();
      return jobs;
    })();
    try { return await syncPromise; } finally { syncPromise = null; }
  }
  function libraryResultText(result) {
    const errors = Array.isArray(result.errors) ? result.errors.map(item => typeof item === 'string' ? item : item.message || item.error || '文件暂不可读取') : [];
    return `发现新增 ${number(result.added)} 场 · ${number(result.unchanged)} 场已在库中。选择录像后才解析${errors.length ? `。${errors.join('；')}` : '；已有筛选已保留。'}`;
  }
  async function loadLibraryInfo(strict = false) {
    const request = ++libraryInfoRequest;
    try {
      const info = await json(await fetch('/api/library', { cache: 'no-store' }));
      if (request !== libraryInfoRequest) return;
      libraryEnabled = info.enabled === true;
      libraryScanning = info.scanning === true;
      for (const id of ['library-directory', 'analysis-dialog-directory']) {
        $(id).textContent = info.directory || '未配置录像文件夹';
        $(id).title = info.directory || '';
      }
      $('library-status').textContent = libraryScanning ? '正在递归扫描子文件夹、读取 ZIP 并检查重复录像；扫描不会解析比赛…' : info.result ? libraryResultText(info.result) : libraryEnabled ? '自动扫描所有子文件夹中的 .dem 和 .zip；新增后点击刷新，再从录像库选择要分析的比赛。' : info.message || '此服务未启用文件夹读取。';
    } catch (error) { if (request !== libraryInfoRequest) return; if (strict) throw error; $('library-status').textContent = '无法读取文件夹信息；仍可手动导入 Demo。'; }
    $('refresh-library').disabled = !libraryEnabled || libraryRefreshing || libraryScanning || state.uploading || catalogAdding;
    renderCatalog();
  }
  async function refreshLibrary() {
    if (!libraryEnabled || libraryRefreshing || libraryScanning || state.uploading || catalogAdding) return;
    pausePlayback('已暂停：正在刷新比赛数据。');
    libraryRefreshing = true; refreshPlaybackAvailability(); $('refresh-library').disabled = true; $('library-status').textContent = '正在检查文件夹…';
    try {
      const result = await json(await fetch('/api/library/refresh', { method: 'POST' }));
      if (result.directory) { $('library-directory').textContent = result.directory; $('library-directory').title = result.directory; }
      libraryScanning = result.scanning === true;
      if (libraryScanning) await loadLibraryInfo(true);
      // An earlier progress request may predate this scan; fetch a fresh snapshot.
      if (syncPromise) await syncPromise;
      await syncServerJobs();
      if (result.scanning !== true) $('library-status').textContent = libraryResultText(result);
    } catch (error) { $('library-status').textContent = `刷新失败：${error.message}。已有比赛仍可查看，可再次点击重试。`; }
    finally { libraryRefreshing = false; renderJobs(); scheduleLibraryPoll(); }
  }
  function catalogSelectable(demo) { return demo.status === 'ready' || demo.available !== false; }
  function catalogMapScope() { return [...catalog.values()].filter(demo => libraryView.map === 'all' || (demo.map || 'unknown') === libraryView.map); }
  function visibleCatalog() {
    return filterList(catalogMapScope(), libraryView);
  }
  function changeCatalogSelection(action) {
    if (catalogAdding || state.uploading) return;
    for (const demo of visibleCatalog()) if (catalogSelectable(demo)) {
      if (action === 'all' || action === 'invert' && !catalogSelection.has(demo.id)) catalogSelection.add(demo.id);
      else catalogSelection.delete(demo.id);
    }
    renderCatalog();
  }
  function renderCatalog() {
    const maps = new Map(); for (const demo of catalog.values()) maps.set(demo.map || 'unknown', (maps.get(demo.map || 'unknown') || 0) + 1);
    const select = $('analysis-library-map'); select.replaceChildren(new Option('全部地图', 'all'));
    for (const [map, count] of [...maps].sort(([a], [b]) => a.localeCompare(b))) select.append(new Option(`${map === 'unknown' ? '地图待解析' : map} · ${number(count)} 场`, map));
    if (libraryView.map !== 'all' && !maps.has(libraryView.map)) select.append(new Option(`${libraryView.map} · 暂无录像`, libraryView.map));
    select.value = libraryView.map; renderFolderControls('analysis-library', catalogMapScope(), libraryView);
    const visible = visibleCatalog(), list = $('analysis-library-list'); list.replaceChildren();
    const busy = catalogAdding || state.uploading;
    $('open-analysis-library').disabled = busy;
    $('empty-open-analysis-library').disabled = busy;
    $('analysis-library-count').textContent = `显示 ${visible.length} / ${catalog.size} 场 · 已选 ${catalogSelection.size} 场`;
    $('analysis-library-add').textContent = catalogAdding ? '正在加入…' : `加入分析（${catalogSelection.size}）`;
    $('analysis-library-add').disabled = busy || !catalogSelection.size;
    $('analysis-library-all').disabled = busy || !visible.some(catalogSelectable);
    $('analysis-library-invert').disabled = busy || !visible.some(catalogSelectable);
    $('analysis-library-clear').disabled = busy || !visible.some(demo => catalogSelection.has(demo.id));
    $('analysis-library-refresh').disabled = busy || !libraryEnabled || libraryRefreshing || libraryScanning || catalogLoading;
    appendFolderGroups(list, visible, libraryView, (demo, target, groupKey) => {
      const row = node('label', null, 'analysis-library-row'), check = document.createElement('input'), words = node('span', null, 'analysis-library-words');
      row.dataset.demoId = demo.id; check.type = 'checkbox'; check.dataset.demoId = demo.id; check.checked = catalogSelection.has(demo.id); check.disabled = busy || !catalogSelectable(demo);
      check.setAttribute('aria-label', `选择 ${demo.name || demo.id} 加入分析`);
      check.addEventListener('change', () => { if (check.checked) catalogSelection.add(demo.id); else catalogSelection.delete(demo.id); renderCatalog(); });
      const title = node('strong', demo.name || demo.id); title.title = demo.name || demo.id;
      const sources = library.sourcePaths(demo), path = node('small', groupSourcePaths(demo, groupKey)[0] || sources[0] || '本机已解析记录', 'analysis-library-path'); path.title = sources.join('\n');
      const statuses = { discovered: '待选择解析', queued: '等待解析', parsing: '正在解析', error: '解析失败，可重试' };
      const status = demo.status === 'ready' ? demo.analysis ? '已加入分析 · 可直接复用' : '已解析缓存 · 可直接加入' : statuses[demo.status] || demo.message || '等待处理';
      const detail = node('small', `${demo.map || '地图待解析'} · ${status}${demo.sourceCount > 1 ? ` · ${demo.sourceCount} 个来源已去重` : ''}`, demo.status === 'error' ? 'status-error' : '');
      words.append(title, path, detail);
      if (demo.error) words.append(node('small', demo.error, 'status-error'));
      if (demo.available === false) words.append(node('small', demo.status === 'ready' ? '源文件已移走，仍可使用解析缓存' : '源文件不可用，请恢复文件后刷新', 'micro'));
      row.append(check, words); target.append(row);
    }, 'catalog');
    if (!visible.length) list.append(node('p', catalogLoading ? '正在读取录像库…' : catalog.size ? '当前地图、文件夹或搜索没有匹配录像；已选录像仍保留。' : '录像库为空。请选择存放 .dem 或 .zip 的文件夹，系统会递归扫描。', 'muted'));
  }
  async function openCatalog(event) {
    if (catalogAdding || state.uploading) return;
    catalogOpener = event?.currentTarget || $('open-analysis-library');
    $('analysis-library-error').hidden = true;
    const dialog = $('analysis-library-dialog'); dialog.hidden = false; if (!dialog.open) dialog.showModal?.();
    catalogLoading = true; renderCatalog(); $('analysis-library-search').focus?.();
    try { await syncServerJobs(); }
    catch (error) { $('analysis-library-error').textContent = `读取录像库失败：${error.message}`; $('analysis-library-error').hidden = false; }
    finally { catalogLoading = false; renderCatalog(); }
  }
  function closeCatalog() {
    const dialog = $('analysis-library-dialog'); dialog.close?.(); dialog.hidden = true; catalogOpener?.focus?.();
  }
  async function addCatalogDemos(ids = [...catalogSelection], options = {}) {
    pausePlayback('已暂停：比赛选择已更新。');
    if (catalogAdding || state.uploading || !ids.length) return;
    catalogAdding = true; $('analysis-library-error').hidden = true; renderJobs();
    const errors = []; let added = 0;
    try {
      for (const id of new Set(ids)) {
        try {
          const result = await json(await fetch(`/api/library/demos/${encodeURIComponent(id)}/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'analysis' }) }));
          state.selectedDemos?.add(result.id); catalogSelection.delete(id); added++;
        } catch (error) { errors.push(`${catalog.get(id)?.name || id}：${error.message}`); }
      }
      if (syncPromise) await syncPromise;
      await syncServerJobs();
      // A ready cache may already be loaded but excluded by an explicit subset.
      renderJobs(); renderFilters(); requestAnalysis(); save();
      if (options.focus && state.demos.has(ids[0])) await focusDemo(state.demos.get(ids[0]));
      if (!errors.length && !options.keepOpen) closeCatalog();
    } catch (error) { errors.push(`更新分析列表失败：${error.message}。已提交的任务仍会继续，请刷新重试。`); }
    finally {
      catalogAdding = false; renderJobs(); scheduleLibraryPoll();
      if (errors.length) {
        const text = `${added ? `已加入 ${added} 场。` : ''}${errors.join('；')}`;
        $('analysis-library-error').textContent = text; $('analysis-library-error').hidden = false;
        if ($('analysis-library-dialog').hidden) message(text);
      }
    }
  }
  async function focusDemo(data) {
    pausePlayback('已暂停：比赛选择已更新。');
    restoredView = null;
    state.selectedDemos?.add(data.id); state.selectedTeams = state.selectedPlayers = null;
    $('player-search').value = ''; $('analysis-floor').value = 'all';
    const previousMap = state.map;
    await refreshMaps(data.map);
    if (previousMap === data.map) await loadMapImage();
    renderJobs(); renderFilters(); requestAnalysis(); save();
    // A link is a one-time navigation intent, not a filter reset on every reload.
    const url = new URL(location.href);
    if (url.searchParams.get('demo') === data.id) {
      url.searchParams.delete('demo');
      window.history.replaceState(window.history.state, '', url);
    }
  }
  async function pollJob(id, signal, focus = false) {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const status = await json(await fetch(`/api/demos/${encodeURIComponent(id)}/status`, { cache: 'no-store', signal }));
      const job = state.jobs.get(id); if (!job) return;
      Object.assign(job, status);
      if (state.currentJob === id) { $('upload-message').textContent = `${job.name} · ${status.message || '解析中'}`; $('upload-progress').value = Number(status.progress) || 0; }
      renderJobs();
      if (status.status === 'error') throw new Error(status.error || '解析失败，请重新选择此文件。');
      if (status.status === 'ready') return loadJob(id, { signal, owned: true, focus });
      await sleep(650);
    }
  }
  async function importFiles(files) {
    pausePlayback('已暂停：正在导入比赛。');
    if (state.uploading || catalogAdding) { message('正在加入这一批比赛，请完成后再添加文件。'); return; }
    const list = [...files]; if (!list.length) return;
    const invalid = list.find(f => !/\.dem$/i.test(f.name) || f.size === 0 || f.size > 2 * 1024 ** 3);
    if (invalid) { message(`${invalid.name} 不是可导入的 .dem 文件：请先解压，文件必须非空且不超过 2 GiB。`); return; }
    message(''); state.uploading = true; state.cancelled = false; state.queued = list; state.pendingCount = list.length; state.controller = new AbortController();
    clearTimeout(libraryTimer);
    $('upload-status').hidden = false; $('cancel-upload').disabled = false; $('analysis-files').disabled = true; renderJobs();
    const failures = []; let focused = false, hadShared = false;
    for (let i = 0; i < list.length && !state.cancelled; i++) {
      const file = list[i]; state.currentJob = null; let shared = false;
      $('upload-message').textContent = `上传 ${i + 1}/${list.length} · ${file.name}`; $('upload-progress').value = 0;
      try {
        const form = new FormData(); form.append('demo', file);
        const job = await json(await fetch('/api/demos?mode=analysis', { method: 'POST', body: form, signal: state.controller.signal }));
        shared = job.shared === true; hadShared ||= shared;
        state.currentJob = job.id; state.pendingCount--;
        state.jobs.set(job.id, { ...state.jobs.get(job.id), id: job.id, name: file.name, status: job.status || 'queued', owned: true });
        if (state.selectedDemos) state.selectedDemos.add(job.id);
        renderJobs(); save();
        await pollJob(job.id, state.controller.signal, !focused); focused = true;
      } catch (error) {
        if (!state.cancelled) failures.push(`${file.name}：${error.message}`);
        if (state.currentJob && !shared) {
          const failedId = state.currentJob;
          try { await fetch(`/api/demos/${encodeURIComponent(failedId)}`, { method: 'DELETE' }); } catch { /* Restore can expose a server-side job if offline. */ }
          state.jobs.delete(failedId); state.demos.delete(failedId); state.selectedDemos?.delete(failedId);
        } else if (!state.currentJob) state.pendingCount--;
        renderJobs();
      }
    }
    state.uploading = false; state.currentJob = null; state.pendingCount = 0; state.controller = null; state.queued = [];
    if (hadShared) {
      try { await syncServerJobs(); } catch { /* Keep shared jobs intact if the service is temporarily unavailable. */ }
    }
    $('upload-status').hidden = true; $('analysis-files').disabled = false; $('analysis-files').value = ''; renderJobs(); save(); scheduleLibraryPoll();
    if (failures.length) message(`部分比赛未导入，可重新选择重试。${failures.join('；')}`);
    else if (state.cancelled) message(hadShared ? '已停止等待并取消后续导入；共享录像的后台任务与已有分析仍保留。' : '已取消剩余导入；已经完成的比赛仍保留。', false);
  }
  async function sample() {
    pausePlayback('已暂停：正在载入示例。');
    if (state.uploading) return;
    try {
      message(''); const data = await json(await fetch('/api/sample/analysis'));
      data.synthetic = true; state.jobs.set(data.id, { id: data.id, name: data.name || '合成示例', map: data.map, status: 'ready', synthetic: true, owned: false }); state.demos.set(data.id, data); state.selectedDemos?.add(data.id);
      updateWorkerData(); renderJobs(); await refreshMaps(); renderFilters(); requestAnalysis(); save();
    } catch (error) { message(`示例载入失败：${error.message}`); }
  }
  function projection(p) {
    const map = state.mapInfo;
    if (map && Number.isFinite(map.scale) && map.scale > 0) return { x: (p.x - map.posX) / (map.scale * (map.radarSize || 1024)), y: (map.posY - p.y) / (map.scale * (map.radarSize || 1024)) };
    const b = state.fallbackBounds, size = Math.max(1, b.maxX - b.minX, b.maxY - b.minY);
    return { x: (p.x - (b.minX + b.maxX - size) / 2) / size, y: ((b.minY + b.maxY + size) / 2 - p.y) / size };
  }
  function worldSize() { return state.mapInfo ? state.mapInfo.scale * (state.mapInfo.radarSize || 1024) : Math.max(1, state.fallbackBounds.maxX - state.fallbackBounds.minX, state.fallbackBounds.maxY - state.fallbackBounds.minY); }
  function clearHeat() {
    state.layers.clear(); state.heatValues = null; state.heatCanvas = null; $('heat-tooltip').hidden = true;
  }
  function rebuildHeat() {
    clearHeat();
    const rows = state.result?.cells || [], resolution = heatResolution;
    const radius = Math.max(2, Math.min(70, Number($('heat-radius').value) / worldSize() * resolution));
    for (let metric = 0; metric < metrics.length; metric++) {
      if (!$(`layer-${metrics[metric]}`).checked) continue;
      if (movementPending || missingTime(metrics[metric])) continue;
      const points = rows.filter(row => row[metric + 3] > 0).map(row => ({ ...projection({ x: row[0], y: row[1] }), weight: row[metric + 3] }));
      state.layers.set(metrics[metric], heat.normalize(heat.density(points, resolution, radius)).values);
    }
    state.heatValues = heat.combine([...state.layers.values()]);
    colorHeat();
  }
  function heatMode() { return $('heat-scale').value; }
  function legendTicks() { return heatMode() === 'linear' ? [0, .2, .4, .6, .8, 1] : [0, .01, .05, .2, .5, 1]; }
  function selectedLayers() { return metrics.filter(name => $(`layer-${name}`).checked).map(name => metricNames[name]).join(' + ') || '未选择图层'; }
  function renderLegend() {
    $('heat-gradient').style.background = `linear-gradient(to right, ${heat.stops.map(([at, rgb]) => `rgb(${rgb.join(',')}) ${at * 100}%`).join(',')})`;
    const ticks = $('heat-ticks'); ticks.replaceChildren();
    for (const value of legendTicks()) {
      const tick = node('span', `${Math.round(value * 100)}%`); tick.style.left = `${heat.scaleValue(value, heatMode()) * 100}%`; ticks.append(tick);
    }
    $('heat-legend-note').textContent = `${selectedLayers()} · 相对当前筛选峰值${state.layers.size > 1 ? ' · 各层独立归一化，重叠处取最高密度' : ''}`;
  }
  function colorHeat() {
    state.heatCanvas = null; $('heat-tooltip').hidden = true;
    if (state.heatValues?.length) {
      const layer = document.createElement('canvas'); layer.width = layer.height = heatResolution;
      layer.getContext('2d').putImageData(new ImageData(heat.colorize(state.heatValues, heatMode()), heatResolution, heatResolution), 0, 0);
      state.heatCanvas = layer;
    }
    renderLegend(); draw();
  }
  function dimensions() {
    const rect = canvas.getBoundingClientRect(), width = rect.width, height = rect.height, size = Math.min(width - 22, height - 22) * state.zoom;
    return { width, height, size, x: (width - size) / 2 + state.panX, y: (height - size) / 2 + state.panY };
  }
  function draw() {
    $('heat-tooltip').hidden = true;
    const d = dimensions(), scale = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(d.width * scale) || canvas.height !== Math.round(d.height * scale)) { canvas.width = Math.round(d.width * scale); canvas.height = Math.round(d.height * scale); }
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, d.width, d.height); ctx.fillStyle = '#13181e'; ctx.fillRect(0, 0, d.width, d.height);
    if (state.image) { ctx.globalAlpha = .65; ctx.drawImage(state.image, d.x, d.y, d.size, d.size); ctx.globalAlpha = 1; }
    else {
      ctx.strokeStyle = '#26343e'; ctx.lineWidth = .5;
      for (let i = 0; i <= 16; i++) { ctx.beginPath(); ctx.moveTo(d.x + d.size * i / 16, d.y); ctx.lineTo(d.x + d.size * i / 16, d.y + d.size); ctx.moveTo(d.x, d.y + d.size * i / 16); ctx.lineTo(d.x + d.size, d.y + d.size * i / 16); ctx.stroke(); }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = Number($('heat-opacity').value) / 100;
    if (state.heatCanvas) ctx.drawImage(state.heatCanvas, d.x, d.y, d.size, d.size);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (state.selectedGroup) drawUtility(d);
    $('zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  }
  function drawUtility(d) {
    const group = state.selectedGroup, selected = state.selectedThrow, items = selected ? selected.items : group.items;
    const toScreen = p => { const q = projection(p); return { x: d.x + q.x * d.size, y: d.y + q.y * d.size }; };
    for (const item of items) {
      const end = toScreen(item.end); ctx.beginPath(); ctx.arc(end.x, end.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#ffca76'; ctx.fill();
      if (item.start) { const start = toScreen(item.start); ctx.beginPath(); ctx.arc(start.x, start.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#7fe8dc'; ctx.fill(); }
    }
    const representative = items.find(u => u.path?.length > 1) || items[0];
    if (representative?.path?.length > 1) {
      ctx.beginPath(); representative.path.forEach((point, index) => { const p = toScreen(point); if (!index) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }); ctx.strokeStyle = '#e7f0d5'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    const label = toScreen(group.end); ctx.font = '10px "Segoe UI",sans-serif'; ctx.fillStyle = '#ffdc9b'; ctx.fillText(`${utilityNames[group.type] || group.type} · ${items.length} 次`, label.x + 10, label.y - 9);
    $('map-status').textContent = '青色：出手点 · 金色：落点 · 虚线：一条观测轨迹';
  }
  function renderUtilityTimeCounts() {
    const counts = state.result?.utilityTimeCounts || {}, selected = $('analysis-utility-time').value;
    const all = core.utilityTimeBuckets.reduce((sum, bucket) => sum + (counts[bucket.key] || 0), 0);
    const list = $('utility-time-counts'); list.replaceChildren();
    for (const { key, label } of [{ key: 'all', label: core.utilityTimeLabel('all') }, ...core.utilityTimeBuckets]) {
      const count = key === 'all' ? all : counts[key] || 0;
      const button = node('button', null, `utility-time-count${selected === key ? ' selected' : ''}`);
      button.type = 'button'; button.dataset.timeBucket = key; button.dataset.count = String(count); button.setAttribute('aria-pressed', String(selected === key));
      button.setAttribute('aria-label', `${label}，${number(count)} 次投掷`);
      button.append(node('span', label), node('strong', number(count)));
      button.addEventListener('click', () => { $('analysis-utility-time').value = key; requestAnalysis(); }); list.append(button);
    }
  }
  function utilityTimeDescription(item) {
    const bucket = item.timeBucket || core.utilityTimeBucket(item);
    return bucket === 'unknown' ? '投掷时段未知（缺少出手或冻结结束记录）' : `开打后 ${item.roundElapsed.toFixed(2)} 秒 · ${core.utilityTimeLabel(bucket)}`;
  }
  function renderUtilityGroups() {
    renderUtilityTimeCounts();
    const groups = [...(state.result?.groups || [])];
    if ($('utility-sort').value === 'rare') groups.sort((a, b) => a.count - b.count || a.id.localeCompare(b.id));
    $('utility-group-count').textContent = `${groups.length} 类落点 · ${state.result?.utilities.length || 0} 次`;
    const list = $('utility-groups'); list.replaceChildren();
    const max = Number(list.dataset.limit) || 80;
    for (const group of groups.slice(0, max)) {
      const button = node('button', null, `utility-card${state.selectedGroup?.id === group.id ? ' selected' : ''}`); button.setAttribute('aria-pressed', String(state.selectedGroup?.id === group.id));
      const image = document.createElement('img'); image.src = `/icons/${utilityIcons[group.type] || 'unknown'}.svg`; image.alt = '';
      const timeLabel = $('analysis-utility-time').value === 'all' ? '' : ` · ${core.utilityTimeLabel($('analysis-utility-time').value)}`;
      const text = node('span'); text.append(node('strong', `${utilityNames[group.type] || group.type} · 落点 ${group.id.split('-')[1]}`), node('small', `${group.demoCount} 场 · ${group.playerCount} 人 · ${group.throws.filter(g => !g.unknown).length} 种已知投法${group.unknownStarts ? ` · ${group.unknownStarts} 次出手点未知` : ''}${timeLabel}`));
      const count = node('span', null, 'utility-card-count'); count.append(node('b', group.count), node('em', `${group.percent.toFixed(1)}%`));
      button.append(image, text, count); button.addEventListener('click', () => { state.selectedGroup = group; state.selectedThrow = null; renderUtilityGroups(); renderUtilityDetail(); draw(); }); list.append(button);
    }
    if (groups.length > max) { const more = node('button', `显示更多（还有 ${groups.length - max} 类）`, 'cluster-more'); more.addEventListener('click', () => { list.dataset.limit = String(max + 80); renderUtilityGroups(); }); list.append(more); }
    if (!groups.length) list.append(node('div', '当前筛选没有已观测到落点的道具。切换投掷时段、道具类型或扩大筛选范围。', 'utility-empty'));
    $('clear-utility').hidden = !state.selectedGroup;
    if (!state.selectedGroup) { $('utility-detail').hidden = true; $('map-status').textContent = '滚轮缩放 · 拖拽平移 · 点击右侧落点定位'; }
  }
  function renderUtilityDetail() {
    const group = state.selectedGroup, detail = $('utility-detail'); detail.replaceChildren(); detail.hidden = !group; if (!group) return;
    detail.append(node('h3', `${utilityNames[group.type] || group.type} · ${group.count} 次观测`), node('p', `${core.utilityTimeLabel($('analysis-utility-time').value)} · 占当前道具筛选 ${group.percent.toFixed(1)}%。下列投法同时比较出手点和落点；位置接近不代表视角、速度与按键完全相同。`));
    for (const [index, subgroup] of group.throws.entries()) {
      const block = node('div', null, 'throw-group'), button = node('button', `${subgroup.unknown ? '出手点未知（不归并投法）' : `投法 ${index + 1}`} · ${subgroup.count} 次`, state.selectedThrow?.id === subgroup.id ? 'selected' : '');
      button.addEventListener('click', () => { state.selectedThrow = subgroup; renderUtilityDetail(); draw(); }); block.append(button);
      if (subgroup.start) block.append(node('small', `出手 ${Math.round(subgroup.start.x)}, ${Math.round(subgroup.start.y)} → 落点 ${Math.round(subgroup.end.x)}, ${Math.round(subgroup.end.y)}`));
      const details = document.createElement('details'); details.append(node('summary', `查看 ${subgroup.count} 次投掷与回放`)); const list = document.createElement('ul');
      for (const item of subgroup.items) {
        const li = document.createElement('li'); li.append(node('span', `${item.owner || item.playerId || '未知投掷者'} · ${item.demoName} · R${item.round} `));
        li.append(node('small', utilityTimeDescription(item), 'throw-time'));
        if (!state.demos.get(item.demoId)?.synthetic) { const link = node('a', '回放 ↗'); link.href = `/?demo=${encodeURIComponent(item.demoId)}&t=${Math.max(0, Number(item.time) || 0).toFixed(2)}`; link.target = '_blank'; link.rel = 'noopener'; li.append(link); }
        else li.append(node('span', '合成示例'));
        list.append(li);
      }
      details.append(list); block.append(details); detail.append(block);
    }
  }
  function download(blob, filename) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  $('analysis-files').addEventListener('change', event => importFiles(event.target.files));
  document.addEventListener?.('library-directory-change', async () => {
    try {
      await loadLibraryInfo(true);
      // Finish any snapshot of the old folder before fetching the new catalog.
      if (syncPromise) await syncPromise;
      await syncServerJobs();
    } catch (error) { $('library-status').textContent = `更新录像库失败：${error.message}`; }
  });
  $('refresh-library').addEventListener('click', refreshLibrary);
  $('reparse-analyses').addEventListener('click', () => requestReparse(importedReadyJobs().map(job => job.id)));
  $('retry-reparse-failures').addEventListener('click', () => requestReparse([...reparseFailures().keys()]));
  $('open-analysis-library').addEventListener('click', openCatalog);
  $('empty-open-analysis-library').addEventListener('click', openCatalog);
  $('analysis-library-close').addEventListener('click', closeCatalog);
  $('analysis-library-dialog').addEventListener('cancel', event => { event.preventDefault(); closeCatalog(); });
  for (const [prefix, view, render] of [['demo', sourceView, renderJobs], ['analysis-library', libraryView, renderCatalog]]) {
    $(`${prefix}-search`).addEventListener('input', () => { view.query = $(`${prefix}-search`).value; render(); save(); });
    $(`${prefix}-view-mode`).addEventListener('change', () => { view.mode = $(`${prefix}-view-mode`).value === 'folders' ? 'folders' : 'all'; render(); save(); });
    $(`${prefix}-folder`).addEventListener('change', () => { view.folder = $(`${prefix}-folder`).value; render(); save(); });
    const scope = prefix === 'demo' ? 'source' : 'catalog';
    $(`${prefix}-collapse-all`).addEventListener('click', () => changeFolderExpansion(scope, null, false));
    $(`${prefix}-expand-all`).addEventListener('click', () => changeFolderExpansion(scope, null, true));
  }
  $('analysis-library-map').addEventListener('change', () => { libraryView.map = $('analysis-library-map').value; renderCatalog(); save(); });
  for (const action of ['all', 'none', 'invert']) $(`demos-${action}`).addEventListener('click', () => changeSourceSelection(action));
  $('analysis-library-refresh').addEventListener('click', refreshLibrary);
  $('analysis-library-all').addEventListener('click', () => changeCatalogSelection('all'));
  $('analysis-library-clear').addEventListener('click', () => changeCatalogSelection('none'));
  $('analysis-library-invert').addEventListener('click', () => changeCatalogSelection('invert'));
  $('analysis-library-add').addEventListener('click', () => addCatalogDemos());
  $('cancel-upload').addEventListener('click', () => { state.cancelled = true; state.controller?.abort(); $('cancel-upload').disabled = true; $('upload-message').textContent = '正在停止等待…'; });
  $('sample-analysis').addEventListener('click', sample);
  $('analysis-map').addEventListener('change', async event => { restoredView = null; state.selectedTeams = null; state.selectedPlayers = null; await loadMap(event.target.value); renderFilters(); requestAnalysis(); });
  $('analysis-side').addEventListener('change', requestAnalysis);
  $('analysis-floor').addEventListener('change', async () => { await loadMapImage(); requestAnalysis(); });
  $('analysis-utility-type').addEventListener('change', requestAnalysis);
  $('analysis-utility-time').addEventListener('change', requestAnalysis);
  for (const edge of ['start', 'end']) {
    $(`movement-time-${edge}`).addEventListener('input', () => setMovementEdge(edge));
    $(`movement-time-${edge}`).addEventListener('change', () => setMovementEdge(edge, true));
  }
  $('movement-time-all').addEventListener('click', () => { pausePlayback('已暂停：已切回全部时段。'); state.movementTime = null; renderMovementTime(); invalidateHeatmapTime(); requestAnalysis({ movementOnly: true }); });
  $('heatmap-time-play').addEventListener('click', () => startPlayback());
  $('heatmap-time-restart').addEventListener('click', () => startPlayback(true));
  $('heatmap-time-window').addEventListener('focus', () => pausePlayback('已暂停：正在调整窗口跨度。'));
  $('heatmap-time-window').addEventListener('input', () => { const draft = $('heatmap-time-window').value; pausePlayback('已暂停：正在调整窗口跨度。'); $('heatmap-time-window').value = draft; });
  $('heatmap-time-window').addEventListener('change', () => {
    const requestedLength = Number($('heatmap-time-window').value);
    pausePlayback('已暂停：窗口跨度已更新。', true);
    playbackLength = playback.normalizeWindowLength(requestedLength);
    state.movementTime = playback.rangeForStart(state.movementTime?.start || 0, playbackLength); renderMovementTime(); invalidateHeatmapTime(); requestAnalysis({ movementOnly: true });
  });
  $('heatmap-time-speed').addEventListener('change', () => {
    playbackSpeed = playback.normalizeSpeed(Number($('heatmap-time-speed').value)); ++playbackGeneration; clearTimeout(playbackTimer); playbackTimer = null; playbackStartedAt = playbackNow();
    renderPlayback(); save(); schedulePlayback();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pausePlayback('已暂停：页面已转到后台。'); else renderPlayback(); });
  window.addEventListener('pagehide', () => pausePlayback('已暂停：已离开当前页面。'));
  window.addEventListener('pageshow', renderPlayback);
  $('utility-sort').addEventListener('change', () => { renderUtilityGroups(); save(); });
  for (const id of ['landing-distance', 'throw-distance']) $(id).addEventListener('change', event => { const input = event.target; input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) || Number(input.defaultValue)))); requestAnalysis(); });
  $('teams-all').addEventListener('click', () => { state.selectedTeams = null; renderFilters(); requestAnalysis(); });
  $('teams-none').addEventListener('click', () => { state.selectedTeams = new Set(); renderFilters(); requestAnalysis(); });
  $('teams-invert').addEventListener('click', () => { state.selectedTeams = new Set(availableTeams().map(t => t.id).filter(id => state.selectedTeams && !state.selectedTeams.has(id))); renderFilters(); requestAnalysis(); });
  $('players-all').addEventListener('click', () => { state.selectedPlayers = null; renderPlayers(); requestAnalysis(); });
  $('players-none').addEventListener('click', () => { state.selectedPlayers = new Set(); renderPlayers(); requestAnalysis(); });
  $('players-invert').addEventListener('click', () => { state.selectedPlayers = new Set(availablePlayers().map(p => p.id).filter(id => state.selectedPlayers && !state.selectedPlayers.has(id))); renderPlayers(); requestAnalysis(); });
  $('player-search').addEventListener('input', () => { renderPlayers(); save(); });
  $('apply-aliases').addEventListener('click', () => { $('team-aliases').querySelectorAll('input').forEach(input => { const value = input.value.trim(); if (value) state.aliases[input.dataset.teamId] = value; else delete state.aliases[input.dataset.teamId]; }); state.selectedTeams = null; renderFilters(); requestAnalysis(); });
  $('clear-selection').addEventListener('click', () => { state.selectedDemos = state.selectedTeams = state.selectedPlayers = null; state.movementTime = null; renderMovementTime(); $('analysis-side').value = 'all'; $('analysis-floor').value = 'all'; $('analysis-utility-type').value = 'all'; $('analysis-utility-time').value = 'all'; $('player-search').value = ''; renderJobs(); renderFilters(); void loadMapImage(); requestAnalysis(); });
  $('clear-utility').addEventListener('click', () => { state.selectedGroup = state.selectedThrow = null; renderUtilityGroups(); draw(); });
  for (const name of metrics) $(`layer-${name}`).addEventListener('change', () => { rebuildHeat(); save(); });
  let radiusTimer;
  $('heat-radius').addEventListener('input', () => { $('radius-value').textContent = `${$('heat-radius').value} 单位`; clearTimeout(radiusTimer); radiusTimer = setTimeout(rebuildHeat, 75); save(); });
  $('heat-opacity').addEventListener('input', () => { $('opacity-value').textContent = `${$('heat-opacity').value}%`; draw(); save(); });
  $('heat-scale').addEventListener('change', () => { colorHeat(); save(); });
  function fit() { state.zoom = 1; state.panX = state.panY = 0; draw(); }
  $('fit-map').addEventListener('click', fit);
  canvas.addEventListener('wheel', event => { event.preventDefault(); const before = dimensions(), rect = canvas.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top, old = state.zoom; state.zoom = Math.max(1, Math.min(5, state.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12))); const ratio = state.zoom / old; state.panX = (state.panX + before.width / 2 - px) * ratio - before.width / 2 + px; state.panY = (state.panY + before.height / 2 - py) * ratio - before.height / 2 + py; draw(); }, { passive: false });
  let dragging;
  canvas.addEventListener('pointerdown', event => { $('heat-tooltip').hidden = true; dragging = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => {
    if (!dragging) { showHeatValue(event); return; }
    if (dragging.id !== event.pointerId) return;
    state.panX += event.clientX - dragging.x; state.panY += event.clientY - dragging.y; dragging.x = event.clientX; dragging.y = event.clientY; draw();
  });
  canvas.addEventListener('pointerleave', () => { $('heat-tooltip').hidden = true; });
  function showHeatValue(event) {
    const tip = $('heat-tooltip'), rect = canvas.getBoundingClientRect(), d = dimensions(), mx = event.clientX - rect.left, my = event.clientY - rect.top;
    const u = (mx - d.x) / d.size, v = (my - d.y) / d.size;
    tip.hidden = true;
    if (!state.heatCanvas || u < 0 || u > 1 || v < 0 || v > 1) return;
    const index = Math.round(v * (heatResolution - 1)) * heatResolution + Math.round(u * (heatResolution - 1));
    const values = [...state.layers].filter(([, layer]) => layer[index] > 0);
    if (!values.length) return;
    tip.replaceChildren(node('strong', '相对本层峰值'));
    for (const [name, layer] of values) tip.append(node('span', `${metricNames[name]} ${layer[index] < .001 ? '< 0.1' : (layer[index] * 100).toFixed(1)}%`));
    tip.append(node('small', '扩散后密度 · 非事件占比')); tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(mx + 16, d.width - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(my + 16, d.height - tip.offsetHeight - 8))}px`;
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { dragging = null; });
  canvas.addEventListener('keydown', event => { if (['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); if (event.key === '0') fit(); else { state.zoom = Math.max(1, Math.min(5, state.zoom * (event.key === '-' ? 1 / 1.2 : 1.2))); draw(); } } });
  new ResizeObserver(draw).observe($('heatmap-stage'));
  $('export-image').addEventListener('click', () => {
    const output = document.createElement('canvas'), ratio = canvas.width / canvas.getBoundingClientRect().width, width = canvas.width / ratio, height = canvas.height / ratio;
    const coverageLines = state.movementTime ? timeCoverageLines() : [], extraHeight = 202 + coverageLines.length * 17;
    output.width = canvas.width; output.height = Math.round((height + extraHeight) * ratio);
    const c = output.getContext('2d'); c.scale(ratio, ratio); c.fillStyle = '#141b23'; c.fillRect(0, 0, width, height + extraHeight); c.drawImage(canvas, 0, 80, width, height);
    c.fillStyle = '#e5eef4'; c.font = '18px sans-serif'; c.fillText(`CS2 Replay · ${state.map} · ${$('analysis-side').selectedOptions[0].textContent}`, 18, 28, width - 36);
    c.fillStyle = '#91a9b8'; c.font = '12px sans-serif'; c.fillText($('selection-summary').textContent, 18, 49, width - 36);
    c.fillText(`移动 ${$('metric-movement').textContent} / 交火 ${$('metric-engagements').textContent} / 死亡 ${$('metric-deaths').textContent} / 开火 ${$('metric-shots').textContent} · 热力图 ${movementRangeLabel()}`, 18, 68, width - 36);
    const y = height + 105, barWidth = Math.min(500, width - 64), gradient = c.createLinearGradient(32, 0, 32 + barWidth, 0);
    for (const [at, rgb] of heat.stops) gradient.addColorStop(at, `rgb(${rgb.join(',')})`);
    c.fillStyle = '#d8e5ed'; c.fillText(`${selectedLayers()} · ${$('heat-scale').selectedOptions[0].textContent} · 相对当前筛选峰值`, 18, y, width - 36);
    c.fillStyle = gradient; c.fillRect(32, y + 12, barWidth, 12); c.fillStyle = '#d8e5ed'; c.textAlign = 'center';
    for (const value of legendTicks()) c.fillText(`${Math.round(value * 100)}%`, 32 + heat.scaleValue(value, heatMode()) * barWidth, y + 42);
    c.textAlign = 'left'; c.fillStyle = '#91a9b8'; c.fillText('蓝 → 青 → 绿 → 黄 → 红：密度从低到高；零记录透明。', 18, y + 65, width - 36);
    c.fillText(state.movementTime ? `四图层范围：开局后 ${state.movementTime.start}–${state.movementTime.end} 秒 [含开始，不含结束]；道具时段独立。` : '各图层独立归一化，重叠处取最高密度；百分比为相对密度，非事件占比。', 18, y + 83, width - 36);
    coverageLines.forEach((line, index) => c.fillText(line, 18, y + 100 + index * 17, width - 36));
    output.toBlob(blob => { if (blob) download(blob, `${state.map}-analysis.png`); });
  });
  $('export-csv').addEventListener('click', () => {
    const rows = [['地图', '落点分类', '投法分类', '道具', '落点次数', '占当前道具百分比', '比赛', '玩家', '玩家ID', '队伍分组', '阵营', '回合', '秒', '回合开打后秒数', '投掷时段', '出手X', '出手Y', '出手Z', '落点X', '落点Y', '落点Z']];
    for (const g of state.result?.groups || []) for (const t of g.throws) for (const u of t.items) rows.push([u.map, g.id, t.unknown ? '未知出手点' : t.id, utilityNames[u.type] || u.type, g.count, g.percent.toFixed(2), u.demoName, u.owner, u.playerId, u.teamId, u.side === 3 ? 'CT' : 'T', u.round, u.time, u.timeBucket === 'unknown' ? '' : u.roundElapsed, core.utilityTimeLabel(u.timeBucket), u.start?.x ?? '', u.start?.y ?? '', u.start?.z ?? '', u.end.x, u.end.y, u.end.z]);
    download(new Blob([core.csv(rows)], { type: 'text/csv;charset=utf-8' }), `${state.map}-utilities.csv`);
  });
  document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); void importFiles(event.dataTransfer.files); } });
  async function init() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { /* Ignore malformed local UI preferences. */ }
    try {
      const session = await json(await fetch('/api/session-settings', { cache: 'no-store' }));
      if (session.sessionId && session.sessionId !== saved.migratedSessionId && session.settings && typeof session.settings === 'object' && !Array.isArray(session.settings)) saved = { ...session.settings, migratedSessionId: session.sessionId };
    } catch { /* A viewer without a restored session still uses browser settings. */ }
    restoreSettings(saved);
    if (state.map) restoredView = { map: state.map, floor: $('analysis-floor').value };
    try {
      state.worker = new Worker('/analysis-core.js');
      state.worker.onmessage = ({ data }) => {
        workerBusy = false;
        if (data.error) { if (data.id === state.request) analysisFailed(data.error); }
        else applyAnalysis(data.id, data.result);
        const pending = workerPending; workerPending = null;
        if (pending?.id === state.request) sendWorkerRequest(pending);
        else schedulePlayback();
      };
      state.worker.onerror = () => { pausePlayback('计算进程中断，播放已暂停。', true); state.worker.terminate(); state.worker = null; workerBusy = false; workerPending = null; requestAnalysis(); };
    } catch { state.worker = null; }
    try {
      await Promise.all([syncServerJobs({ render: false, pruneSelection: true }), loadLibraryInfo()]);
      updateWorkerData(); await refreshMaps();
      const currentId = new URL(location.href).searchParams.get('demo');
      if (currentId && !state.demos.has(currentId)) await addCatalogDemos([currentId], { focus: true });
      else if (currentId && state.demos.has(currentId)) await focusDemo(state.demos.get(currentId));
      initializing = false; renderJobs(); renderFilters(); requestAnalysis(); save(); scheduleLibraryPoll();
    } catch (error) { message(`无法恢复本机分析：${error.message}。仍可尝试导入新的 Demo。`); }
    finally { initializing = false; }
  }
  void init();
})();
