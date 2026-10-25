(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('radar');
  const controls = ['play-button', 'previous-round', 'next-round', 'backward', 'forward', 'timeline', 'speed-select', 'round-select', 'round-timeline', 'skip-freeze'];
  const state = { data: null, map: null, images: {}, t: 0, speed: 1, playing: false, frameIndex: 0, generation: 0, activeJob: null, controller: null, loading: false, players: new Map(), slots: new Map(), bounds: null, lastUI: 0, lastRoster: '', lastFeed: '', lastRound: null, mapLoad: 0 };
  let dragDepth = 0;
  let lastTime = 0;
  state.selectedId = null;
  state.utilityId = null;
  const radar = window.ReplayRadar.create({ canvas, getState: () => state, onSelect: selectPlayer, onUtilitySelect: selectUtility });

  function selectPlayer(id) {
    state.selectedId = id ? String(id) : null;
    state.utilityId = null;
    if (id) radar.revealPlayer(String(id));
    updateUI(true);
  }
  function selectUtility(id) {
    state.utilityId = id || null;
    state.selectedId = null;
    if (id && $('utility-filter')) $('utility-filter').value = 'all';
    if (id) {
      const u = state.data.utilities.find(u => u.id === id);
      if (u && state.images.lower && Number.isFinite(state.map?.lowerMaxZ)) $('floor-select').value = u.z < state.map.lowerMaxZ ? 'lower' : 'upper';
      radar.focusUtility(id);
    }
    updateUI(true);
  }
  function updateReview(frame, round) {
    window.ReplayReview?.render({ data: state.data, frame, round, time: state.t,
      selectedId: state.selectedId, utilityId: state.utilityId, slots: state.slots, players: state.players,
      onSeek: seek, onSelect: selectPlayer, onUtilitySelect: selectUtility });
    const slider = $('round-timeline');
    if (slider && round) {
      slider.max = String(Math.max(.01, round.end - round.start));
      slider.value = String(state.t - round.start);slider.disabled = state.loading;
      const pct = clamp((state.t - round.start) / Math.max(.01, round.end - round.start) * 100, 0, 100);
      slider.style.background = `linear-gradient(to right, var(--accent) ${pct}%, #35412f ${pct}%)`;
      slider.setAttribute('aria-valuetext', `本回合 ${fmt(state.t - round.start)} / ${fmt(round.end - round.start)}`);
    }
    if ($('skip-freeze')) $('skip-freeze').disabled = state.loading || !round?.freezeEnd || state.t >= round.freezeEnd;
  }

  function teamOf(team) {
    if (team === 3 || /^(ct|counter.?terrorists?|counter.?terrorist)$/i.test(String(team))) return 'ct';
    if (team === 2 || /^(t|terrorists?)$/i.test(String(team))) return 't';
    return 'other';
  }
  function fmt(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(seconds / 3600);
    return `${h ? `${h}:` : ''}${String(Math.floor(seconds / 60) % (h ? 60 : 100000)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const finite = (n) => Number.isFinite(n);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function error(message) { $('error-text').textContent = message; $('error-box').hidden = false; }
  function clearError() { $('error-box').hidden = true; }
  function setLoading(loading, message = '', progress = 0) {
    state.loading = loading;
    $('loading-state').hidden = !loading;
    $('empty-state').hidden = loading || !!state.data;
    $('loading-message').textContent = message;
    $('loading-progress').style.width = `${clamp(progress, 0, 1) * 100}%`;
    $('loading-percent').textContent = progress > 0 ? `${Math.round(clamp(progress, 0, 1) * 100)}%` : '请稍候';
    $('cancel-import').hidden = !loading;
    controls.forEach((id) => { $(id).disabled = loading || !state.data; });
  }
  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `本地服务返回错误（${response.status}）`);
    return body;
  }
  async function discardJob(id) {
    if (!id) return;
    try { await fetch(`/api/demos/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* The server may already have stopped. */ }
  }
  function beginRequest() {
    const generation = ++state.generation;
    state.controller?.abort();
    state.controller = new AbortController();
    const previousJob = state.activeJob;
    state.activeJob = null;
    void discardJob(previousJob);
    setPlaying(false);
    clearError();
    return { generation, signal: state.controller.signal };
  }
  function setDemoQuery(id) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('demo', id);
    else url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
  }
  async function importFile(file) {
    if (!file) return;
    if (!/\.dem$/i.test(file.name)) { error('请选择 .dem 格式的 CS2 Demo 文件。压缩包请先解压。'); return; }
    if (!file.size) { error('这个文件是空的，请选择完整的 .dem 文件。'); return; }
    if (file.size > 2 * 1024 * 1024 * 1024) { error('这个 Demo 超过 2 GB，当前版本支持导入不大于 2 GB 的 .dem 文件。'); return; }
    const { generation, signal } = beginRequest();
    $('loading-title').textContent = '正在导入 Demo';
    setLoading(true, `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · 传送至本机解析器`);
    try {
      const form = new FormData();
      form.append('demo', file);
      const result = await json(await fetch('/api/demos', { method: 'POST', body: form, signal }));
      if (!result.id) throw new Error('解析器没有返回任务编号，请重试。');
      if (generation !== state.generation) { void discardJob(result.id); return; }
      state.activeJob = result.id;
      $('loading-title').textContent = '正在解析比赛';
      setLoading(true, '提取玩家位置与回合数据…');
      while (generation === state.generation) {
        const status = await json(await fetch(`/api/demos/${encodeURIComponent(result.id)}/status`, { cache: 'no-store', signal }));
        if (generation !== state.generation) return;
        if (status.status === 'error') throw new Error(status.error || status.message || 'Demo 解析失败，请检查文件是否完整。');
        if (status.status === 'ready') {
          setLoading(true, '解析完成，正在载入回放…', 1);
          const data = await json(await fetch(`/api/demos/${encodeURIComponent(result.id)}`, { signal }));
          if (generation !== state.generation) return;
          state.activeJob = null;
          await loadDemo(data, generation, signal);
          if (generation === state.generation) setDemoQuery(result.id);
          return;
        }
        setLoading(true, status.message || (status.status === 'queued' ? '正在排队等待解析…' : '提取玩家位置与回合数据…'), Number(status.progress) || 0);
        await sleep(650);
      }
    } catch (err) {
      if (generation !== state.generation) return;
      const job = state.activeJob;
      state.activeJob = null;
      state.controller = null;
      void discardJob(job);
      setLoading(false);
      error(`导入失败：${err.message || '无法连接本地解析服务，请确认程序正在运行。'}`);
    }
  }
  async function loadSample() {
    const { generation, signal } = beginRequest();
    setDemoQuery(null);
    $('loading-title').textContent = '正在载入交互示例';
    setLoading(true, '示例是合成数据，用于体验播放操作。');
    try {
      const data = await json(await fetch('/api/sample', { signal }));
      if (generation !== state.generation) return;
      data.synthetic = true;
      await loadDemo(data, generation, signal);
    } catch (err) {
      if (generation !== state.generation) return;
      state.controller = null;
      setLoading(false);
      error(`示例载入失败：${err.message}`);
    }
  }
  async function restoreDemo(id) {
    const { generation, signal } = beginRequest();
    $('loading-title').textContent = '正在恢复比赛';
    setLoading(true, '从本机缓存载入上次导入的 Demo…');
    try {
      const response = await fetch(`/api/demos/${encodeURIComponent(id)}`, { signal });
      if (response.status === 404 || response.status === 410) throw new Error('本机比赛缓存已过期或已被清理，请重新导入 .dem 文件。');
      const data = await json(response);
      if (generation !== state.generation) return;
      await loadDemo(data, generation, signal);
    } catch (err) {
      if (generation !== state.generation) return;
      state.controller = null;
      setLoading(false);
      setDemoQuery(null);
      error(`无法恢复比赛：${err.message || '请确认本地服务正在运行，然后重新导入 .dem 文件。'}`);
    }
  }
  async function loadDemo(data, generation, signal) {
    if (!Array.isArray(data.frames) || !data.frames.length) throw new Error('Demo 中没有可回放的玩家帧。');
    if (!data.frames.every((frame, i) => finite(frame.t) && (!i || frame.t >= data.frames[i - 1].t))) throw new Error('Demo 的时间数据不完整，无法建立回放。');
    state.data = data;
    state.t = 0;
    state.frameIndex = 0;
    state.speed = 1;
    state.map = null;
    state.images = {};
    state.lastFeed = null;
    state.lastRoster = '';
    state.lastRound = null;
    state.selectedId = null;
    state.utilityId = null;
    window.ReplayReview?.reset();
    $('speed-select').value = '1';
    $('floor-select').value = 'upper';
    $('floor-select').hidden = true;
    state.players = new Map((data.players || []).map((p) => [String(p.id), p]));
    state.slots = new Map();
    let ctIndex = 0;
    let tIndex = 0;
    for (const p of data.players || []) state.slots.set(String(p.id), teamOf(p.team) === 'ct' ? ++ctIndex : ++tIndex + 5);
    data.frames.forEach((frame) => {
      (frame.players || []).forEach((p) => {
        const id = String(p.id);
        if (!state.players.has(id)) state.players.set(id, { id, name: p.name || `玩家 ${state.players.size + 1}`, team: p.team });
        if (!state.slots.has(id)) state.slots.set(id, state.slots.size + 1);
      });
    });
    data.duration = Math.max(Number(data.duration) || 0, data.frames[data.frames.length - 1].t, 0.01);
    data.rounds = Array.isArray(data.rounds) ? data.rounds : [];
    data.events = Array.isArray(data.events) ? data.events.slice().sort((a, b) => a.t - b.t) : [];
    data.killEvents = data.events.filter((e) => /kill|death/i.test(e.type));
    data.utilities = Array.isArray(data.utilities) ? data.utilities : [];
    data.shots = Array.isArray(data.shots) ? data.shots.slice().sort((a, b) => a.t - b.t) : [];
    computeBounds();
    $('match-title').textContent = data.synthetic ? '交互示例 · Mirage' : (data.name || 'CS2 比赛回放');
    $('match-subtitle').textContent = `${data.synthetic ? '合成数据示例' : '本地 Demo'} · ${data.map || '未知地图'} · ${fmt(data.duration)} · ${state.players.size} 名玩家`;
    $('demo-label').hidden = !data.synthetic;
    $('map-name').textContent = data.map || '未知地图';
    $('map-mode').textContent = '2D 回放';
    $('time-duration').textContent = fmt(data.duration);
    $('tick-label').textContent = data.tickRate ? `${Math.round(data.tickRate)} TICK` : '';
    $('sample-rate').textContent = `${data.frames.length.toLocaleString()} 帧`;
    $('round-count').textContent = `${data.rounds.filter((r) => r.number > 0 && !r.warmup).length} 回合`;
    $('timeline').max = String(data.duration);
    const select = $('round-select');
    select.replaceChildren();
    data.rounds.forEach((round, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${round.warmup || round.number === 0 ? '热身' : `第 ${round.number} 回合`} · ${fmt(round.start)}`;
      select.append(option);
    });
    if (!data.rounds.length) select.append(new Option('完整回放', '-1'));
    const markers = $('round-markers');
    markers.replaceChildren();
    data.rounds.forEach((round) => {
      const mark = document.createElement('span');
      mark.className = 'round-marker';
      mark.style.left = `${clamp(round.start / data.duration * 100, 0, 100)}%`;
      markers.append(mark);
    });
    await loadMap(data.map, generation, signal);
    if (generation !== state.generation) return;
    radar.reset();
    const warnings = (data.warnings || []).filter(Boolean);
    $('warning-box').textContent = warnings.join('；');
    $('warning-box').hidden = !warnings.length;
    state.controller = null;
    setLoading(false);
    setPlaying(false);
    updateUI(true);
  }
  function computeBounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const frame of state.data.frames) for (const p of frame.players || []) {
      if (!finite(p.x) || !finite(p.y) || (!p.x && !p.y) || p.connected === false) continue;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (!finite(minX)) { minX = -2000; maxX = 2000; minY = -2000; maxY = 2000; }
    const extent = Math.max(maxX - minX, maxY - minY, 1000) * 1.15;
    state.bounds = { x: (minX + maxX) / 2 - extent / 2, y: (minY + maxY) / 2 + extent / 2, scale: extent / 1024 };
  }
  async function loadMap(mapName, generation, signal) {
    const loadNumber = ++state.mapLoad;
    const loadImage = (src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    try {
      const map = await json(await fetch(`/api/maps/${encodeURIComponent(mapName || 'unknown')}`, { signal }));
      if (!finite(map.posX) || !finite(map.posY) || !(map.scale > 0) || !map.radar) throw new Error('地图坐标不可用');
      const [upper, lower] = await Promise.all([loadImage(map.radar), map.lowerRadar ? loadImage(map.lowerRadar) : Promise.resolve(null)]);
      if (generation !== state.generation || loadNumber !== state.mapLoad) return;
      if (!upper) throw new Error('底图读取失败');
      state.map = map;
      state.images = { upper, lower };
      $('map-name').textContent = map.displayName || mapName;
      $('floor-select').hidden = !lower;
      $('map-note').textContent = lower ? '滚轮缩放 · 拖动平移 · 另一楼层淡化 · 道具效果为示意' : '滚轮缩放 · 拖动平移 · 点击选中（重叠可循环）· 道具效果为示意';
    } catch {
      if (generation !== state.generation || loadNumber !== state.mapLoad) return;
      state.map = null;
      state.images = {};
      $('map-mode').textContent = '坐标视图';
      $('map-note').textContent = '此地图暂无雷达底图，已按玩家坐标范围显示网格。';
    }
  }
  function frameAt(t) {
    const frames = state.data.frames;
    let low = 0, high = frames.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (frames[mid].t <= t) low = mid; else high = mid - 1; }
    return low;
  }
  function currentRound() {
    if (!state.data) return null;
    const rounds = state.data.rounds;
    for (let i = rounds.length - 1; i >= 0; i--) if (state.t >= rounds[i].start) return { ...rounds[i], index: i };
    return rounds.length ? { ...rounds[0], index: 0 } : null;
  }
  function seek(t) {
    if (!state.data || state.loading) return;
    state.t = clamp(Number(t) || 0, 0, state.data.duration);
    state.frameIndex = frameAt(state.t);
    if (state.utilityId && !state.data.utilities.some(u => u.id === state.utilityId && u.round === state.data.frames[state.frameIndex].round)) state.utilityId = null;
    if (state.t >= state.data.duration) setPlaying(false);
    updateUI(true);
  }
  function setPlaying(playing) {
    state.playing = !!playing && !!state.data && !state.loading;
    if (state.playing && state.t >= state.data.duration) { state.t = 0; state.frameIndex = 0; }
    $('play-icon').innerHTML = state.playing ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor"/>' : '<path d="m8 5 11 7-11 7z" fill="currentColor"/>';
    $('play-button').setAttribute('aria-label', state.playing ? '暂停' : '播放');
  }
  function changeRound(delta) {
    if (!state.data || state.loading) return;
    const round = currentRound();
    if (!round) return;
    const target = state.data.rounds[clamp(round.index + delta, 0, state.data.rounds.length - 1)];
    seek(target.start);
  }
  function resize() { radar.resize(); }
  function draw() { radar.draw(); }
  function updateUI(force = false) {
    if (!state.data) return;
    const now = performance.now();
    if (!force && now - state.lastUI < 100) return;
    state.lastUI = now;
    const frame = state.data.frames[state.frameIndex];
    const round = currentRound();
    $('time-current').textContent = fmt(state.t);
    $('timeline').value = String(state.t);
    $('timeline').style.background = `linear-gradient(to right, var(--accent) ${state.t / state.data.duration * 100}%, #35412f ${state.t / state.data.duration * 100}%)`;
    $('timeline').setAttribute('aria-valuetext', `${fmt(state.t)} / ${fmt(state.data.duration)}`);
    $('timeline-status').textContent = `${state.playing ? '正在播放' : state.t >= state.data.duration ? '回放结束' : '已暂停'}${state.data.synthetic ? ' · 合成示例' : ''}`;
    $('frame-label').textContent = `FRAME ${String(state.frameIndex + 1).padStart(5, '0')} / ${state.data.frames.length}`;
    if (round) {
      $('current-round').textContent = round.warmup || round.number === 0 ? '热身阶段' : `第 ${round.number} 回合`;
      $('round-time').textContent = fmt(state.t - round.start);
      $('round-select').value = String(round.index);
      $('previous-round').disabled = round.index === 0 || state.loading;
      $('next-round').disabled = round.index === state.data.rounds.length - 1 || state.loading;
    } else { $('current-round').textContent = '完整回放'; $('round-time').textContent = fmt(state.t); }
    // The scoreboard belongs to the teams currently occupying each side. Summing
    // CT/T round wins would assign the wrong score after halftime or overtime.
    $('score-ct').textContent = finite(frame.ctScore) ? String(frame.ctScore) : '—';
    $('score-t').textContent = finite(frame.tScore) ? String(frame.tScore) : '—';
    $('score-ct').title = finite(frame.ctScore) ? '当前 CT 队伍比分' : '此回放没有逐帧比分数据';
    $('score-t').title = finite(frame.tScore) ? '当前 T 队伍比分' : '此回放没有逐帧比分数据';
    updateReview(frame, round);
  }
  function renderEmptyRosters() {
    for (const team of ['ct', 't']) for (let i = 0; i < 5; i++) {
      const row = document.createElement('div');row.className = 'skeleton-row';
      const icon = document.createElement('span');icon.className = 'skeleton-icon';const text = document.createElement('span');text.className = 'skeleton-text';text.style.width = `${42 + ((i * 13) % 28)}%`;
      row.append(icon, text);$(`roster-${team}`).append(row);
    }
  }
  $('file-input').addEventListener('change', (event) => { void importFile(event.target.files[0]);event.target.value = ''; });
  $('sample-button').addEventListener('click', () => void loadSample());
  $('dismiss-error').addEventListener('click', clearError);
  $('cancel-import').addEventListener('click', () => {
    ++state.generation;
    state.controller?.abort();
    state.controller = null;
    const job = state.activeJob;
    state.activeJob = null;
    void discardJob(job);
    setLoading(false);
  });
  $('play-button').addEventListener('click', () => { setPlaying(!state.playing);updateUI(true); });
  $('speed-select').addEventListener('change', (event) => { state.speed = Number(event.target.value) || 1; });
  $('timeline').addEventListener('input', (event) => seek(event.target.value));
  $('round-select').addEventListener('change', (event) => { const round = state.data?.rounds[Number(event.target.value)];if (round) seek(round.start); });
  $('previous-round').addEventListener('click', () => changeRound(-1));
  $('next-round').addEventListener('click', () => changeRound(1));
  $('backward').addEventListener('click', () => seek(state.t - 5));
  $('forward').addEventListener('click', () => seek(state.t + 5));
  $('floor-select').addEventListener('change', draw);
  $('focus-mode')?.addEventListener('click', () => {
    const focused = document.body.classList.toggle('focus-mode');
    $('focus-mode').setAttribute('aria-pressed', String(focused));
    $('focus-mode').textContent = focused ? '退出专注' : '专注地图';
    resize();
  });
  $('skip-freeze')?.addEventListener('click', () => { const round = currentRound();if (round?.freezeEnd) seek(round.freezeEnd); });
  $('round-timeline')?.addEventListener('input', e => {
    const round = currentRound();
    if (round) seek(Math.min(round.end - (round.index < state.data.rounds.length - 1 ? .001 : 0), round.start + Number(e.target.value)));
  });
  $('utility-filter')?.addEventListener('change', () => updateUI(true));
  window.addEventListener('replay-icons-ready', () => {updateUI(true);draw();});
  window.addEventListener('keydown', (event) => {
    if (!state.data || state.loading || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, select, textarea, button, a, [contenteditable="true"]')) return;
    if (event.code === 'Space') {event.preventDefault();setPlaying(!state.playing);updateUI(true);}
    else if (event.code === 'ArrowLeft') {event.preventDefault();seek(state.t - 5);}
    else if (event.code === 'ArrowRight') {event.preventDefault();seek(state.t + 5);}
    else if (event.code === 'Escape') {selectPlayer(null);}
  });
  window.addEventListener('dragenter', (event) => {if (!event.dataTransfer.types.includes('Files')) return;event.preventDefault();dragDepth++;$('drop-overlay').hidden = false;});
  window.addEventListener('dragover', (event) => {if (event.dataTransfer.types.includes('Files')) {event.preventDefault();event.dataTransfer.dropEffect = 'copy';}});
  window.addEventListener('dragleave', (event) => {event.preventDefault();dragDepth = Math.max(0, dragDepth - 1);if (!dragDepth) $('drop-overlay').hidden = true;});
  window.addEventListener('drop', (event) => {event.preventDefault();dragDepth = 0;$('drop-overlay').hidden = true;const files = event.dataTransfer.files;if (files.length > 1) error('一次请选择一个 .dem 文件。');else if (files.length) void importFile(files[0]);});
  document.addEventListener('visibilitychange', () => {lastTime = performance.now();});
  function loop(now) {
    const elapsed = lastTime ? Math.min((now - lastTime) / 1000, .25) : 0;
    lastTime = now;
    if (state.playing && !state.loading) {
      const round = currentRound();
      state.t = Math.min(state.t + elapsed * state.speed, state.data.duration);
      if ($('loop-round')?.checked && round && state.t >= round.end) state.t = round.start + (state.t - round.end) % Math.max(.01, round.end - round.start);
      state.frameIndex = frameAt(state.t);
      if (state.utilityId && !state.data.utilities.some(u => u.id === state.utilityId && u.round === state.data.frames[state.frameIndex].round)) state.utilityId = null;
      if (state.t >= state.data.duration) setPlaying(false);
      updateUI();
    }
    draw();
    requestAnimationFrame(loop);
  }
  renderEmptyRosters();
  new ResizeObserver(resize).observe($('map-stage'));
  requestAnimationFrame(loop);
  const savedDemo = new URL(window.location.href).searchParams.get('demo');
  if (savedDemo) void restoreDemo(savedDemo);
})();
