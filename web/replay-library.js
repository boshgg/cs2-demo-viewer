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
    return (Array.isArray(demo?.sources) ? demo.sources : []).map(source => `${source?.path || ''}${source?.member ? ` › ${source.member}` : ''}`).filter(Boolean);
  }
  function matches(demo, query) {
    const words = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const text = [demo.name, demo.map, ...sourcePaths(demo)].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }
  function sourceFolder(source) {
    if (!source || source.available === false || typeof source.path !== 'string') return null;
    const path = source.path.replace(/\\/g, '/');
    // Catalog paths are relative to the selected library root. A missing/invalid path must
    // not be classified using a ZIP member name or a cached display name.
    if (!path.trim() || path.startsWith('/') || /^[a-z]:/i.test(path) || path.endsWith('/')) return null;
    const parts = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    if (!parts.length) return null;
    parts.pop();
    return parts.length ? `path:${parts.join('/')}` : 'root';
  }
  function folderLabel(key) {
    if (key === 'root') return '录像根目录';
    if (key === 'unavailable') return '仅缓存或源文件不可用';
    if (typeof key === 'string' && key.startsWith('path:')) return key.slice(5);
    return key === 'all' ? '全部文件夹' : '未知文件夹';
  }
  function compareFolders(a, b) {
    const rank = key => key === 'root' ? 0 : key === 'unavailable' ? 2 : 1;
    return rank(a) - rank(b) || folderLabel(a).localeCompare(folderLabel(b), 'zh-CN') || a.localeCompare(b);
  }
  function folderKeys(demo, includeAncestors = false) {
    const keys = new Set();
    for (const source of Array.isArray(demo?.sources) ? demo.sources : []) {
      const key = sourceFolder(source);
      if (!key) continue;
      keys.add(key);
      if (includeAncestors) {
        for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) keys.add(key.slice(0, slash));
      }
    }
    return keys.size ? [...keys].sort(compareFolders) : ['unavailable'];
  }
  function matchesFolderKey(key, folder, includeDescendants) {
    return key === folder || (includeDescendants && key.startsWith(folder + '/'));
  }
  function inFolder(demo, folder = 'all', includeDescendants = false) {
    return folder === 'all' || folderKeys(demo).some(key => matchesFolderKey(key, folder, includeDescendants));
  }
  function uniqueDemos(demos) {
    const unique = new Map();
    for (const demo of Array.isArray(demos) ? demos : []) if (demo && typeof demo.id === 'string' && demo.id) unique.set(demo.id, demo);
    return [...unique.values()];
  }
  function folderGroups(demos, includeAncestors = false) {
    const groups = new Map();
    for (const demo of Array.isArray(demos) ? demos : []) {
      if (!demo || typeof demo.id !== 'string' || !demo.id) continue;
      for (const key of folderKeys(demo, includeAncestors)) {
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key).set(demo.id, demo);
      }
    }
    return [...groups].sort(([a], [b]) => compareFolders(a, b)).map(([key, values]) => ({ key, label: folderLabel(key), demos: [...values.values()] }));
  }
  function folderOptions(demos, includeAncestors = false) {
    return folderGroups(demos, includeAncestors).map(group => ({ key: group.key, label: group.label, count: group.demos.length }));
  }
  function groupByFolder(demos, mode = 'all', folder = 'all', includeDescendants = false) {
    if (mode !== 'folders') return [{ key: 'all', label: '', demos: uniqueDemos(demos) }];
    return folderGroups(demos).filter(group => folder === 'all' || matchesFolderKey(group.key, folder, includeDescendants));
  }
  function viewFolderGroups(demos, mode, folder) {
    if (mode !== 'folders' || folder === 'all') return groupByFolder(demos, mode);
    const members = uniqueDemos(demos).filter(demo => inFolder(demo, folder, true));
    return members.length ? [{ key: folder, label: folderLabel(folder), demos: members }] : [];
  }
  function folderSourcePaths(demo, folder, includeDescendants = false) {
    if (folder === 'all') return sourcePaths(demo);
    const sources = Array.isArray(demo?.sources) ? demo.sources : [];
    return sourcePaths({ sources: sources.filter(source => matchesFolderKey(sourceFolder(source) || 'unavailable', folder, includeDescendants)) });
  }
  function createFolderExpansion(saved) {
    const record = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    let defaultExpanded = own(record, 'defaultExpanded') && typeof record.defaultExpanded === 'boolean' ? record.defaultExpanded : true;
    const overrides = new Map();
    const validKey = key => typeof key === 'string' && key.length > 0;
    if (own(record, 'overrides') && record.overrides && typeof record.overrides === 'object' && !Array.isArray(record.overrides)) {
      for (const [key, value] of Object.entries(record.overrides)) if (validKey(key) && typeof value === 'boolean' && value !== defaultExpanded) overrides.set(key, value);
    }
    return {
      isExpanded: key => overrides.has(key) ? overrides.get(key) : defaultExpanded,
      setExpanded(key, value) {
        if (!validKey(key) || typeof value !== 'boolean') return;
        if (value === defaultExpanded) overrides.delete(key); else overrides.set(key, value);
      },
      setAll(value) { if (typeof value === 'boolean') { defaultExpanded = value; overrides.clear(); } },
      // Object.fromEntries creates own data properties even for "__proto__".
      // Returning a new record also prevents callers from mutating this state.
      snapshot: () => ({ defaultExpanded, overrides: Object.fromEntries(overrides) }),
    };
  }
  const viewStorageKey = 'cs2-replay-library-view-v1';
  const statusLabels = { discovered: '未解析', queued: '等待解析', parsing: '正在解析', ready: '已有缓存', error: '解析失败' };
  function create({ document: doc = document, fetch: fetcher = fetch, storage, onSelect, onOpen, setTimeout: schedule = setTimeout, clearTimeout: unschedule = clearTimeout } = {}) {
    const $ = id => doc.getElementById(id), dialog = $('replay-library'), list = $('replay-library-list');
    let demos = [], scanning = false, open = false, loading = false, refreshing = false, timer = null, request = 0, previousFocus = null;
    let preferences = {}; try { storage ??= globalThis.localStorage; preferences = JSON.parse(storage?.getItem(viewStorageKey) || '{}') || {}; } catch { /* Private/disabled storage does not prevent local playback. */ }
    let mode = preferences.mode === 'folders' ? 'folders' : 'all', folder = typeof preferences.folder === 'string' && /^(root|unavailable|path:.+)$/.test(preferences.folder) ? preferences.folder : 'all';
    const expansion = createFolderExpansion(preferences.folderExpansion), renderedGroups = new Map();
    const saveView = () => { try { storage?.setItem(viewStorageKey, JSON.stringify({ mode, folder, folderExpansion: expansion.snapshot() })); } catch { /* Optional view preference. */ } };
    const make = (tag, text, className) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
    function render() {
      $('replay-library-mode').value = mode;
      $('replay-library-folder-field').hidden = mode !== 'folders';
      $('replay-library-folder-note').hidden = mode !== 'folders';
      $('replay-library-expansion-controls').hidden = mode !== 'folders';
      const folders = $('replay-library-folder'), options = folderOptions(demos, true); folders.replaceChildren();
      const addOption = (value, label) => { const option = make('option', label); option.value = value; folders.append(option); };
      addOption('all', '全部文件夹'); for (const option of options) addOption(option.key, `${option.label} · ${option.count} 场`);
      if (folder !== 'all' && !options.some(option => option.key === folder)) addOption(folder, `${folderLabel(folder)} · 暂无录像`);
      folders.value = folder;
      const shown = demos.filter(demo => matches(demo, $('replay-library-search').value) && (mode !== 'folders' || inFolder(demo, folder, true)));
      $('replay-library-count').textContent = `${uniqueDemos(shown).length} / ${uniqueDemos(demos).length} 场`;
      $('replay-library-refresh').disabled = loading || refreshing || scanning;
      list.replaceChildren();
      renderedGroups.clear();
      for (const group of viewFolderGroups(shown, mode, folder)) {
        let container = list;
        if (mode === 'folders') {
          const section = make('section', null, 'replay-library-folder-group'), heading = make('h3', null, 'replay-library-folder-heading');
          section.dataset.folder = group.key;
          const toggle = make('button', null, 'replay-library-folder-toggle'), caret = make('span', null, 'replay-library-folder-caret');
          toggle.type = 'button'; toggle.dataset.folderToggle = group.key; caret.setAttribute('aria-hidden', 'true');
          toggle.append(caret, make('span', `${group.label} · ${group.demos.length} 场`));
          container = make('div', null, 'replay-library-folder-body'); container.dataset.folderBody = group.key;
          container.id = `replay-library-folder-body-${renderedGroups.size}`; toggle.setAttribute('aria-controls', container.id);
          const update = () => {
            const expanded = expansion.isExpanded(group.key);
            container.hidden = !expanded; toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'} ${group.label}，${group.demos.length} 场录像`);
            caret.textContent = expanded ? '▾' : '▸';
          };
          toggle.addEventListener('click', () => { expansion.setExpanded(group.key, !expansion.isExpanded(group.key)); saveView(); update(); });
          renderedGroups.set(group.key, update); update();
          heading.append(toggle); section.append(heading, container); list.append(section);
        }
        for (const demo of group.demos) {
        const row = make('article', null, 'replay-library-row'), details = make('div', null, 'replay-library-details');
        row.dataset.demoId = demo.id;
        const heading = make('div', null, 'replay-library-row-heading'), title = make('strong', demo.name || '未命名录像'); title.title = demo.name || '';
        const status = make('span', statusLabels[demo.status] || '等待确认', `replay-library-status status-${demo.status || 'unknown'}`);
        heading.append(title, status); details.append(heading);
        const paths = sourcePaths(demo), groupedPaths = folderSourcePaths(demo, group.key, folder === group.key);
        const path = make('p', groupedPaths[0] || paths[0] || '已保存的本机回放', 'replay-library-source'); path.title = paths.join('\n'); details.append(path);
        const sourceCount = Number(demo.sourceCount) || paths.length;
        details.append(make('small', `${demo.map || '解析后识别地图'}${sourceCount > 1 ? ` · ${sourceCount} 个来源，已去重` : ''}`));
        if (demo.status === 'error' && demo.error) details.append(make('p', demo.error, 'replay-library-row-error'));
        else if (demo.status === 'queued' || demo.status === 'parsing') details.append(make('p', `${demo.message || statusLabels[demo.status]}${demo.progress > 0 ? ` · ${Math.round(demo.progress * 100)}%` : ''}`, 'replay-library-row-progress'));
        const unavailable = demo.available === false && demo.status !== 'ready' && demo.status !== 'queued' && demo.status !== 'parsing';
        const action = make('button', unavailable ? '源文件不可用' : demo.status === 'ready' ? '播放' : demo.status === 'error' ? '重试播放' : demo.status === 'queued' || demo.status === 'parsing' ? '查看进度' : '解析并播放', 'button secondary compact replay-library-play');
        action.type = 'button'; action.disabled = unavailable; action.setAttribute('aria-label', `播放 ${demo.name || '录像'}`);
        action.addEventListener('click', () => { close(); onSelect?.(demo); });
        row.append(details, action); container.append(row);
        }
      }
      if (!shown.length) list.append(make('p', demos.length ? '当前文件夹或搜索没有匹配的录像，可切换文件夹或显示全部。' : scanning ? '正在发现录像，请稍候…' : '选择存放 .dem 或 .zip 的文件夹，或在添加录像后点击刷新。', 'replay-library-empty'));
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
        $('replay-library-directory').textContent = info.directory || '本地录像文件夹';
        $('replay-library-directory').title = info.directory || '';
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
    $('replay-library-mode').addEventListener('change', () => { mode = $('replay-library-mode').value === 'folders' ? 'folders' : 'all'; saveView(); render(); });
    $('replay-library-folder').addEventListener('change', () => { folder = $('replay-library-folder').value || 'all'; saveView(); render(); });
    const setAllExpanded = value => { expansion.setAll(value); saveView(); for (const update of renderedGroups.values()) update(); };
    $('replay-library-collapse-all').addEventListener('click', () => setAllExpanded(false));
    $('replay-library-expand-all').addEventListener('click', () => setAllExpanded(true));
    doc.addEventListener?.('library-directory-change', () => { if (open) void reload(); });
    $('replay-library-refresh').addEventListener('click', () => { void refresh(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    return { show, close, refresh, reload, isOpen: () => open };
  }
  return { create, loadReplay, matches, sourcePaths, folderSourcePaths, folderKeys, folderLabel, folderOptions, inFolder, groupByFolder, viewFolderGroups, createFolderExpansion, viewStorageKey };
});
