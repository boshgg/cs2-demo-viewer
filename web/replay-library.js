(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayLibrary = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `本地服务返回错误（${response.status}）`);
    return body;
  }
  function stopped(options) {
    if (options.signal?.aborted || options.isCurrent?.() === false) throw new DOMException('已停止等待', 'AbortError');
  }
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('已停止等待', 'AbortError')); return; }
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('已停止等待', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  // A catalog request owns only its wait, never the shared persisted parse job.
  async function loadReplay(id, options = {}) {
    const fetcher = options.fetch || fetch, sleep = options.sleep || wait;
    stopped(options);
    const selected = await json(await fetcher(`/api/library/demos/${encodeURIComponent(id)}/parse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'playback' }), signal: options.signal,
    }));
    stopped(options);
    if (!selected.id) throw new Error('本地录像库没有返回任务编号，请刷新后重试。');
    let status = selected;
    while (status.status !== 'ready') {
      if (status.status === 'error') throw new Error(status.error || status.message || '录像解析失败，请检查文件是否完整。');
      options.onProgress?.(status);
      status = await json(await fetcher(`/api/demos/${encodeURIComponent(selected.id)}/status`, { cache: 'no-store', signal: options.signal }));
      stopped(options);
      if (status.status !== 'ready' && status.status !== 'error') await sleep(650, options.signal);
      stopped(options);
    }
    options.onProgress?.({ ...status, progress: 1, message: selected.cached ? '正在读取已解析的回放…' : '解析完成，正在载入回放…' });
    const data = await json(await fetcher(`/api/demos/${encodeURIComponent(selected.id)}`, { signal: options.signal }));
    stopped(options);
    return { id: selected.id, data };
  }
  function sourcePaths(demo) {
    return (Array.isArray(demo.sources) ? demo.sources : []).map(source => `${source.path || ''}${source.member ? ` › ${source.member}` : ''}`).filter(Boolean);
  }
  function matches(demo, query) {
    const words = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const text = [demo.name, demo.map, ...sourcePaths(demo)].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }
  const statusLabels = { discovered: '未解析', queued: '等待解析', parsing: '正在解析', ready: '已有缓存', error: '解析失败' };
  function create({ document: doc = document, fetch: fetcher = fetch, onSelect, onOpen, setTimeout: schedule = setTimeout, clearTimeout: unschedule = clearTimeout } = {}) {
    const $ = id => doc.getElementById(id), dialog = $('replay-library'), list = $('replay-library-list');
    let demos = [], scanning = false, open = false, loading = false, refreshing = false, timer = null, request = 0, previousFocus = null;
    const make = (tag, text, className) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
    function render() {
      const shown = demos.filter(demo => matches(demo, $('replay-library-search').value));
      $('replay-library-count').textContent = `${shown.length} / ${demos.length} 场`;
      $('replay-library-refresh').disabled = loading || refreshing || scanning;
      list.replaceChildren();
      for (const demo of shown) {
        const row = make('article', null, 'replay-library-row'), details = make('div', null, 'replay-library-details');
        row.dataset.demoId = demo.id;
        const heading = make('div', null, 'replay-library-row-heading'), title = make('strong', demo.name || '未命名录像'); title.title = demo.name || '';
        const status = make('span', statusLabels[demo.status] || '等待确认', `replay-library-status status-${demo.status || 'unknown'}`);
        heading.append(title, status); details.append(heading);
        const paths = sourcePaths(demo), path = make('p', paths[0] || '已保存的本机回放', 'replay-library-source'); path.title = paths.join('\n'); details.append(path);
        const sourceCount = Number(demo.sourceCount) || paths.length;
        details.append(make('small', `${demo.map || '解析后识别地图'}${sourceCount > 1 ? ` · ${sourceCount} 个来源，已去重` : ''}`));
        if (demo.status === 'error' && demo.error) details.append(make('p', demo.error, 'replay-library-row-error'));
        else if (demo.status === 'queued' || demo.status === 'parsing') details.append(make('p', `${demo.message || statusLabels[demo.status]}${demo.progress > 0 ? ` · ${Math.round(demo.progress * 100)}%` : ''}`, 'replay-library-row-progress'));
        const unavailable = demo.available === false && demo.status !== 'ready' && demo.status !== 'queued' && demo.status !== 'parsing';
        const action = make('button', unavailable ? '源文件不可用' : demo.status === 'ready' ? '播放' : demo.status === 'error' ? '重试播放' : demo.status === 'queued' || demo.status === 'parsing' ? '查看进度' : '解析并播放', 'button secondary compact replay-library-play');
        action.type = 'button'; action.disabled = unavailable; action.setAttribute('aria-label', `播放 ${demo.name || '录像'}`);
        action.addEventListener('click', () => { close(); onSelect?.(demo); });
        row.append(details, action); list.append(row);
      }
      if (!shown.length) list.append(make('p', demos.length ? '没有匹配的录像，请修改搜索条件。' : scanning ? '正在发现录像，请稍候…' : '把 .dem 或 .zip 放入 demo 文件夹或其子文件夹，再点击刷新。', 'replay-library-empty'));
    }
    function poll() {
      unschedule(timer); timer = null;
      if (open && (scanning || demos.some(demo => demo.status === 'queued' || demo.status === 'parsing'))) timer = schedule(() => { void reload(); }, 1200);
    }
    async function reload() {
      const current = ++request; loading = true; render();
      try {
        const [catalog, info] = await Promise.all([
          fetcher('/api/library/demos', { cache: 'no-store' }).then(json),
          fetcher('/api/library', { cache: 'no-store' }).then(json),
        ]);
        if (!open || current !== request) return;
        demos = Array.isArray(catalog) ? catalog : Array.isArray(catalog.demos) ? catalog.demos : [];
        scanning = catalog.scanning === true || info.scanning === true;
        $('replay-library-directory').textContent = info.directory || '本地 Demo 文件夹';
        const errors = Array.isArray(info.result?.errors) ? info.result.errors : [];
        $('replay-library-message').textContent = scanning ? '正在扫描文件夹及所有子文件夹，校验并合并相同录像…' : errors.length ? errors.map(item => typeof item === 'string' ? item : item.message || item.error || '读取失败').join('；') : '只在选择后解析；已有缓存直接载入，其他录像不会自动解析。';
        $('replay-library-message').classList.toggle('is-error', errors.length > 0);
      } catch (error) {
        if (open && current === request) { $('replay-library-message').textContent = `无法读取本地录像库：${error.message}。可点击刷新重试。`; $('replay-library-message').classList.toggle('is-error', true); }
      } finally { if (current === request) { loading = false; if (open) { render(); poll(); } } }
    }
    async function refresh() {
      if (loading || refreshing || scanning) return;
      refreshing = true; render(); $('replay-library-message').textContent = '正在刷新文件夹…';
      try { const result = await json(await fetcher('/api/library/refresh', { method: 'POST' })); scanning = result.scanning === true; await reload(); }
      catch (error) { if (open) { $('replay-library-message').textContent = `刷新失败：${error.message}。已有录像仍可选择，可再次刷新重试。`; $('replay-library-message').classList.toggle('is-error', true); } }
      finally { refreshing = false; if (open) { render(); poll(); } }
    }
    function close() {
      open = false; ++request; loading = false; unschedule(timer); timer = null;
      if (dialog.open && typeof dialog.close === 'function') dialog.close(); else dialog.hidden = true;
      $('open-replay-library').setAttribute('aria-expanded', 'false'); previousFocus?.focus?.();
    }
    function show() {
      if (open) return;
      open = true; previousFocus = doc.activeElement; onOpen?.();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.hidden = false;
      $('open-replay-library').setAttribute('aria-expanded', 'true'); $('replay-library-search').focus();
      void reload();
    }
    $('open-replay-library').addEventListener('click', show);
    $('empty-replay-library').addEventListener('click', show);
    $('replay-library-close').addEventListener('click', close);
    $('replay-library-search').addEventListener('input', render);
    $('replay-library-refresh').addEventListener('click', () => { void refresh(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    return { show, close, refresh, reload, isOpen: () => open };
  }
  return { create, loadReplay, matches, sourcePaths };
});
