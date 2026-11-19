'use strict';

(() => {
  const el = id => document.getElementById(id);
  const selected = new Set();
  let matches = [];
  let config = { configured: false };
  let evidence = null;
  let evidenceRequest = null;
  let answerRequest = null;
  let mcpConfig = '';
  const focus = el('subject');
  const question = el('question');
  const attachments = [];
  const attachmentTypes = ['image/png', 'image/jpeg', 'image/gif'];
  const mib = 1024 * 1024;
  const imageQuestion = '结合所选比赛证据，分析我附上的图片。';
  const provider = el('provider');
  const baseUrl = el('base-url');
  const model = el('model-name');
  const apiKey = el('api-key');
  const presets = {
    glm: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', name: '智谱 GLM' },
    deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-flash', name: 'DeepSeek' }
  };
  let connectionEdited = false;
  const preferenceKey = 'cs2-insights-model-connection';
  let preferences = {};
  try {
    const saved = JSON.parse(window.localStorage?.getItem(preferenceKey) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) preferences = saved;
  } catch { /* Browser storage can be unavailable. */ }
  let keyVersion = 0, keySaved = false, keyBusy = false;

  function destinationURL(value) {
    try {
      const url = new URL(value);
      const local = ['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
      if (!url.username && !url.password && !url.search && !url.hash &&
          (url.protocol === 'https:' || (local && url.protocol === 'http:'))) return url;
    } catch { /* Incomplete address while editing. */ }
    return null;
  }

  function rememberConnection() {
    const value = provider.value;
    preferences.provider = value;
    if (value !== 'server') {
      const url = presets[value]?.url || baseUrl.value.trim();
      if (destinationURL(url)) preferences[value] = { url, model: model.value.trim() };
    }
    try { window.localStorage?.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* Optional display preferences. */ }
  }

  function keyTarget() {
    const value = provider.value, url = presets[value]?.url || baseUrl.value.trim();
    return value !== 'server' && destinationURL(url) ? { provider: value, baseUrl: url } : null;
  }

  function renderKeyActions() {
    el('save-key').disabled = keyBusy || !apiKey.value.trim() || !keyTarget();
    el('forget-key').hidden = !keySaved;
    el('forget-key').disabled = keyBusy;
    apiKey.required = Boolean(presets[provider.value]) && !keySaved;
    apiKey.placeholder = keySaved ? '已保存 · 输入新密钥可替换' : presets[provider.value] ? '填写 ' + presets[provider.value].name + ' API 密钥' : '本机免密模型可留空';
  }

  async function lookupKey() {
    const version = ++keyVersion, target = keyTarget();
    keySaved = false;
    keyBusy = Boolean(target);
    renderKeyActions();
    message('key-status', target ? '正在检查本机保存的密钥…' : '');
    syncActions();
    if (!target) return;
    try {
      const data = await api('/api/insights/credential', { action: 'status', ...target });
      if (version !== keyVersion) return;
      keySaved = data.saved === true;
      message('key-status', keySaved ? '已保存在本机，可直接使用。' : '可立即保存，也可在分析成功后自动保存。');
    } catch (error) {
      if (version === keyVersion) message('key-status', '无法读取已保存的密钥：' + error.message, true);
    } finally {
      if (version === keyVersion) { keyBusy = false; renderKeyActions(); syncActions(); }
    }
  }

  async function updateKey(action, key = '') {
    const target = keyTarget();
    if (!target || (action === 'save' && !key)) return;
    const version = ++keyVersion;
    keyBusy = true; renderKeyActions(); syncActions();
    message('key-status', action === 'save' ? '正在保存密钥…' : '正在移除密钥…');
    try {
      const payload = { ...target, action };
      if (action === 'save') payload.apiKey = key;
      const data = await api('/api/insights/credential', payload);
      if (version !== keyVersion) return;
      keySaved = data.saved === true;
      if (action === 'save' && keySaved && apiKey.value.trim() === key) apiKey.value = '';
      message('key-status', keySaved ? '已保存在本机，刷新或更新后可继续使用。' : '已移除此地址的密钥。');
      rememberConnection();
    } catch (error) {
      if (version === keyVersion) message('key-status', '密钥操作失败：' + error.message, true);
    } finally {
      if (version === keyVersion) { keyBusy = false; renderKeyActions(); syncActions(); }
    }
  }

  async function api(path, payload, signal) {
    const options = { cache: 'no-store', signal };
    if (payload !== undefined) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(path, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    if (!data) throw new Error('服务响应不完整，请重试。');
    return data;
  }

  function message(id, text, error = false) {
    const item = el(id);
    item.textContent = text;
    item.classList.toggle('is-error', error);
  }

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function scope() {
    const body = { demoIds: [...selected] };
    const current = focus.selectedOptions[0];
    if (current?.dataset.kind) body[current.dataset.kind] = current.dataset.id;
    return body;
  }

  function selectProvider(value) {
    provider.value = value;
    const preset = presets[value];
    const system = value === 'server';
    apiKey.value = '';
    const stored = preferences[value];
    baseUrl.value = preset?.url || (value === 'custom' && destinationURL(stored?.url) ? stored.url : '');
    baseUrl.readOnly = Boolean(preset);
    model.value = typeof stored?.model === 'string' ? stored.model : preset?.model || '';
    el('model-choices').replaceChildren(...(value === 'glm' ? [preset.model, 'glm-4.6v-flash'] : preset ? [preset.model] : []).map(id => {
      const option = node('option'); option.value = id; return option;
    }));
    el('provider-fields').hidden = system;
    el('image-output-option').hidden = Boolean(preset);
    el('image-output').checked = false;
    el('server-config').hidden = false;
    if (value === 'glm') message('server-config', '看图复盘可在模型名称中选择 glm-4.6v-flash。');
    if (value === 'deepseek') message('server-config', 'deepseek-flash 支持将截图与比赛数据一起分析。');
    if (system) message('server-config', `使用查看器启动时配置的 ${config.model} @ ${config.endpoint}。`);
    if (value === 'custom') message('server-config', '填写兼容 Chat Completions 的服务地址和模型 ID。');
    void lookupKey();
    cancelAnswer();
  }

  function providerOptions() {
    if (provider.value === 'server' && config.configured) {
      return { label: `${config.model} @ ${config.endpoint}`, fields: {} };
    }
    const preset = presets[provider.value];
    const url = preset?.url || baseUrl.value.trim();
    const name = model.value.trim();
    const key = apiKey.value.trim();
    if (!url || !name) return { error: '请在「模型连接」填写 API 基础地址和模型名称。' };
    if (!key && keyBusy) return { error: '正在读取或更新此地址的本机密钥…' };
    if (preset && !key && !keySaved) return { error: `请在「模型连接」填写 ${preset.name} 的 API 密钥。` };
    const endpoint = destinationURL(url);
    if (!endpoint) {
      return { error: '请使用 HTTPS 基础地址或本机 HTTP 地址，移除地址中的凭据、查询参数和片段。' };
    }
    const auth = !key && keySaved ? { provider: provider.value, useSavedKey: true } : { apiKey: key };
    return { label: `${name} @ ${endpoint.origin}`, fields: { baseUrl: url, model: name, ...auth } };
  }

  function syncActions() {
    const connection = providerOptions();
    const reading = attachments.some(item => !item.url);
    const imageInfo = attachments.length ? `、${attachments.length} 张图片` : '';
    el('destination').textContent = connection.error ||
      `点击发送后，问题${imageInfo}及所选比赛的统计证据（含玩家标识）将发送至 ${connection.label}。`;
    question.required = !attachments.length;
    el('ask').disabled = !evidence || (!question.value.trim() && !attachments.length) || reading || !!answerRequest || !!connection.error;
    el('add-input-images').disabled = !!answerRequest || attachments.length >= 4;
    for (const item of attachments) item.removeButton.disabled = !!answerRequest;
    el('cancel-analysis').hidden = !answerRequest;
  }

  function removeAttachment(item) {
    const index = attachments.indexOf(item);
    if (index === -1) return;
    attachments.splice(index, 1);
    el('input-image-list').replaceChildren(...attachments.map(entry => entry.row));
    syncActions();
  }

  function readAttachment(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('无法读取文件。'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('无法识别图片内容。'));
        img.onload = () => {
          if (img.naturalWidth > 8192 || img.naturalHeight > 8192 || img.naturalWidth * img.naturalHeight > 16 * 1024 * 1024) {
            reject(new Error('请将宽高缩小到 8192 像素以内，且总像素不超过 16777216。'));
          } else resolve(reader.result);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  async function addAttachments(files) {
    if (answerRequest || !files.length) return;
    const errors = [];
    const reads = [];
    for (const file of files) {
      const name = file.name || '粘贴的截图';
      if (attachments.length >= 4) { errors.push('每次最多发送 4 张图片。'); break; }
      const mime = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' })[name.split('.').pop().toLowerCase()];
      if (!attachmentTypes.includes(mime)) { errors.push(`${name}：请选择 PNG、JPEG 或 GIF。`); continue; }
      if (!file.size || file.size > 6 * mib) { errors.push(`${name}：文件为空或超过 6 MiB。`); continue; }
      if (attachments.reduce((n, item) => n + item.size, file.size) > 12 * mib) { errors.push(`${name}：图片合计超过 12 MiB。`); continue; }

      const row = node('li', undefined, 'input-image-item');
      const preview = node('button', '读取中', 'input-image-preview');
      preview.type = 'button';
      preview.disabled = true;
      preview.setAttribute('aria-label', `查看大图：${name}`);
      const removeButton = node('button', '移除', 'text-button');
      removeButton.type = 'button';
      removeButton.setAttribute('aria-label', `移除图片：${name}`);
      const item = { size: file.size, row, removeButton, url: '' };
      removeButton.addEventListener('click', () => {
        removeAttachment(item);
        message('input-image-status', '');
        el('add-input-images').focus();
      });
      row.append(preview, node('span', name), removeButton);
      attachments.push(item);
      el('input-image-list').append(row);
      reads.push(readAttachment(file.type ? file : file.slice(0, file.size, mime)).then(url => {
        if (!attachments.includes(item)) return;
        item.url = url;
        const img = node('img');
        img.alt = '';
        img.src = url;
        preview.replaceChildren(img);
        preview.disabled = false;
        preview.addEventListener('click', () => showLargeImage({ url }, name));
      }).catch(error => {
        if (!attachments.includes(item)) return;
        removeAttachment(item);
        errors.push(`${name}：${error.message}`);
      }));
    }
    syncActions();
    message('input-image-status', errors.join(' '), !!errors.length);
    await Promise.all(reads);
    if (errors.length) message('input-image-status', errors.join(' '), true);
    syncActions();
  }

  function cancelAnswer() {
    answerRequest?.abort();
    answerRequest = null;
    el('result').hidden = true;
    el('answer').textContent = '';
    if (el('image-viewer').open) el('image-viewer').close();
    el('viewer-content').replaceChildren();
    el('model-images').hidden = true;
    el('image-warning').hidden = true;
    el('image-gallery').replaceChildren();
    message('analysis-status', '');
    syncActions();
  }

  function renderMatches() {
    const items = document.createDocumentFragment();
    for (const match of matches) {
      const label = node('label', undefined, 'demo-choice');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(match.id);
      checkbox.disabled = !checkbox.checked && selected.size >= 8;
      checkbox.addEventListener('change', () => {
        selected.delete('sample');
        if (checkbox.checked) selected.add(match.id);
        else selected.delete(match.id);
        updateScope(true);
      });
      label.append(checkbox, node('span', `${match.name || match.id}${match.map ? ' · ' + match.map : ''}`));
      items.append(label);
    }
    el('demo-list').replaceChildren(items);
    el('use-sample').setAttribute('aria-pressed', String(selected.has('sample')));
    el('use-sample').textContent = selected.has('sample') ? '取消合成示例' : '使用合成示例';
    el('scope-summary').textContent = selected.has('sample') ? '正在使用合成示例。' :
      selected.size ? `已选择 ${selected.size} 场录像。` : '尚未选择比赛。';
    if (matches.length) message('library-message', `可用录像 ${matches.length} 场。`);
  }

  function populateSubjects(report) {
    const all = node('option', '全部选中比赛');
    all.value = '';
    focus.replaceChildren(all);
    for (const [kind, rows, groupName] of [['playerId', report?.players, '玩家'], ['team', report?.teams, '战队']]) {
      if (!rows?.length) continue;
      const group = document.createElement('optgroup');
      group.label = groupName;
      for (const row of rows) {
        const name = row.name && row.name !== row.id ? `${row.name} · ${row.id}` : row.id;
        const option = node('option', name);
        option.value = `${kind}:${row.id}`;
        option.dataset.kind = kind;
        option.dataset.id = row.id;
        group.append(option);
      }
      focus.append(group);
    }
    focus.disabled = focus.options.length <= 1;
  }

  function metricTable(columns, rows) {
    const table = node('table');
    const header = node('tr');
    for (const column of columns) {
      const th = node('th', column);
      th.scope = 'col';
      header.append(th);
    }
    const head = node('thead');
    const body = node('tbody');
    head.append(header);
    for (const values of rows) {
      const line = node('tr');
      values.forEach(value => line.append(node('td', value ?? '未知')));
      body.append(line);
    }
    table.append(head, body);
    return table;
  }

  function renderMetrics(report) {
    const metrics = el('metrics');
    metrics.replaceChildren();
    if (report.players?.length) {
      const rows = report.players.map(p => [p.name || p.id, p.matches, p.observedRounds, p.recordedKills, p.recordedDeaths, p.gunNetScore]);
      metrics.append(metricTable(['玩家', '场次', '观察回合', '记录击杀', '记录死亡', '枪械净值'], rows));
    }
    if (report.teams?.length) {
      const wins = (won, total) => total > 0 ? `${won} / ${total}` : '无样本';
      const rows = report.teams.map(t => [t.name || t.id, t.matches, wins(t.ct?.wonRounds, t.ct?.decidedRounds),
        wins(t.t?.wonRounds, t.t?.decidedRounds), wins(t.afterOpeningKill?.wins, t.afterOpeningKill?.rounds),
        wins(t.afterOpeningDeath?.wins, t.afterOpeningDeath?.rounds)]);
      metrics.append(metricTable(['战队', '场次', 'CT 赢 / 已判定', 'T 赢 / 已判定', '首杀后赢 / 样本', '首死后赢 / 样本'], rows));
    }
    el('metric-details').hidden = !report.players?.length && !report.teams?.length;
    el('metric-details').open = Boolean(focus.value);
  }

  function renderEvidence(report) {
    const rows = document.createDocumentFragment();
    for (const match of report.matches || []) {
      const source = matches.find(item => item.id === match.demoId);
      const title = [source?.name || (report.synthetic ? '合成比赛' : match.demoId), match.map].filter(Boolean).join(' · ');
      const row = node('div', title, 'match-evidence-row');
      row.append(node('small', `${match.roundCount ?? '未知'} 回合 · 比赛 ID ${match.demoId}`));
      if (!report.synthetic && match.openingExamples?.length) {
        const examples = node('div', undefined, 'round-examples');
        for (const event of match.openingExamples) {
          if (!Number.isFinite(event.demoSeconds)) continue;
          const link = node('a', `回放第 ${event.round} 回合首杀 ↗`);
          link.href = `/?demo=${encodeURIComponent(match.demoId)}&t=${Math.max(0, event.demoSeconds).toFixed(2)}`;
          link.target = '_blank';
          link.rel = 'noopener';
          examples.append(link);
        }
        row.append(examples);
      }
      rows.append(row);
    }
    el('match-evidence').replaceChildren(rows);
    renderMetrics(report);
    el('evidence-json').textContent = JSON.stringify(report, null, 2);
    el('synthetic').hidden = !report.synthetic;
    el('evidence-content').hidden = false;
    message('evidence-status', `已读取 ${report.matches?.length ?? 0} 场比赛的统计证据。`);
    el('charts-panel').hidden = false;
    window.InsightsCharts.render(el('local-charts'), report, scope());
  }

  async function updateScope(resetSubject = false) {
    evidenceRequest?.abort();
    evidenceRequest = null;
    evidence = null;
    cancelAnswer();
    if (resetSubject) populateSubjects(null);
    renderMatches();
    el('evidence-content').hidden = true;
    el('charts-panel').hidden = true;
    el('local-charts').replaceChildren();
    el('retry-evidence').hidden = true;
    el('synthetic').hidden = !selected.has('sample');
    if (!selected.size) {
      message('evidence-status', '选择比赛后可在本机查看统计。');
      return;
    }
    const request = new AbortController();
    evidenceRequest = request;
    message('evidence-status', '正在读取本地统计…');
    try {
      const report = await api('/api/insights/evidence', scope(), request.signal);
      if (request !== evidenceRequest) return;
      if (!focus.value) populateSubjects(report);
      evidence = report;
      renderEvidence(report);
    } catch (error) {
      if (request !== evidenceRequest) return;
      el('retry-evidence').hidden = false;
      message('evidence-status', error.message, true);
    } finally {
      if (request === evidenceRequest) {
        evidenceRequest = null;
        syncActions();
      }
    }
  }

  async function loadLibrary(initial) {
    el('reload-library').disabled = true;
    message('library-message', '正在读取录像库…');
    try {
      const data = await api('/api/library/demos');
      matches = (data.demos || []).filter(item => item.status === 'ready');
      const wanted = initial && new URLSearchParams(location.search).get('demo');
      const usable = new Set(matches.map(match => match.id));
      let changed = false;
      for (const id of selected) {
        if (id !== 'sample' && !usable.has(id)) { selected.delete(id); changed = true; }
      }
      if (wanted && (wanted === 'sample' || usable.has(wanted))) {
        selected.clear();
        selected.add(wanted);
        changed = true;
      }
      message('library-message', matches.length ? `可用录像 ${matches.length} 场。` : '暂无已解析录像。可先使用合成示例，或去比赛回放打开一场录像。');
      if (changed || (!initial && selected.size)) await updateScope(true);
      else renderMatches();
    } catch (error) {
      message('library-message', `读取录像库失败：${error.message}`, true);
    } finally {
      el('reload-library').disabled = false;
    }
  }

  async function loadConfig() {
    try {
      config = await api('/api/insights/config');
      if (config.configured) {
        el('server-option').disabled = false;
        el('server-option').hidden = false;
        if (!connectionEdited && (!Object.hasOwn(presets, preferences.provider) && preferences.provider !== 'custom')) selectProvider('server');
      }
    } catch (error) {
      el('server-config').hidden = false;
      message('server-config', `读取系统默认配置失败：${error.message}。仍可选择模型厂商。`, true);
    }
    if (!config.configured) el('connection').open = true;
    syncActions();
  }

  function imageSource(value) {
    if (typeof value !== 'string') return null;
    const embedded = /^data:image\/(png|jpeg|gif|webp);base64,/i.exec(value);
    if (embedded) return { url: value, extension: embedded[1].toLowerCase() };
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return { url: url.href, host: url.host };
    } catch { /* Skip unsupported image references. */ }
    return null;
  }

  function picture(source, alt) {
    const img = document.createElement('img');
    img.alt = alt;
    img.referrerPolicy = 'no-referrer';
    if (source.host) img.crossOrigin = 'anonymous';
    return img;
  }

  function showLargeImage(source, alt) {
    const dialog = el('image-viewer');
    const content = el('viewer-content');
    const img = picture(source, alt);
    img.addEventListener('error', () => {
      if (content.contains(img)) content.replaceChildren(node('p', '图片加载失败，请关闭后重试。', 'hint'));
    });
    el('viewer-caption').textContent = alt;
    content.replaceChildren(img);
    dialog.showModal();
    img.src = source.url;
  }

  function renderModelImages(items) {
    const figures = [];
    for (const item of Array.isArray(items) ? items : []) {
      const source = imageSource(item?.url);
      if (!source) continue;
      const index = figures.length + 1;
      const alt = typeof item.alt === 'string' && item.alt.trim() || `模型配图 ${index}`;
      const figure = node('figure');
      const img = picture(source, alt);
      const actions = node('div', undefined, 'image-actions');
      const zoom = node('button', '查看大图');
      zoom.type = 'button';
      zoom.addEventListener('click', () => showLargeImage(source, alt));
      actions.append(zoom);
      if (source.extension) {
        const save = node('a', '保存图片');
        save.href = source.url;
        save.download = `cs2-review-${index}.${source.extension}`;
        actions.append(save);
      }
      const load = node('button', '加载外部图片');
      load.type = 'button';
      const copy = node('button', '复制图片链接');
      copy.type = 'button';
      copy.hidden = true;
      const status = node('p', source.host ? `图片来源：${source.host}` : '', 'hint');
      status.setAttribute('role', 'status');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(source.url);
          status.textContent = '已复制图片链接，可粘贴到浏览器单独查看。';
        } catch {
          const field = document.createElement('input');
          field.readOnly = true;
          field.value = source.url;
          field.setAttribute('aria-label', '图片链接');
          status.replaceChildren(field);
          field.focus();
          field.select();
        }
      });
      actions.hidden = true;
      img.hidden = true;
      const loadPicture = () => {
        load.hidden = true;
        copy.hidden = true;
        status.textContent = '正在加载图片…';
        img.src = source.url;
      };
      load.addEventListener('click', loadPicture);
      img.addEventListener('load', () => {
        img.hidden = false;
        actions.hidden = false;
        status.textContent = source.host ? `图片来源：${source.host}` : '';
      });
      img.addEventListener('error', () => {
        img.hidden = true;
        actions.hidden = true;
        status.textContent = source.host ? `无法加载来自 ${source.host} 的图片，链接可能已过期，或图片服务限制了跨站读取。` : '无法读取模型返回的图片。';
        load.textContent = '重试加载';
        load.hidden = !source.host;
        copy.hidden = !source.host;
      });
      figure.append(node('figcaption', alt), status, img, load, copy, actions);
      figures.push(figure);
      if (!source.host) loadPicture();
    }
    el('image-gallery').replaceChildren(...figures);
    el('model-images').hidden = !figures.length;
    return figures.length;
  }

  async function submit(event) {
    event.preventDefault();
    const connection = providerOptions();
    const prompt = question.value.trim() || (attachments.length ? imageQuestion : '');
    if (!evidence || !prompt || attachments.some(item => !item.url) || connection.error || answerRequest) return;
    const currentScope = scope();
    const description = `${el('scope-summary').textContent} ${focus.selectedOptions[0]?.textContent || ''}${attachments.length ? ` · 附图 ${attachments.length} 张` : ''} · ${connection.label}`;
    cancelAnswer();
    const request = new AbortController();
    answerRequest = request;
    syncActions();
    message('analysis-status', '模型正在分析所选比赛…');
    try {
      const payload = { ...currentScope, ...connection.fields, question: prompt };
      if (attachments.length) payload.inputImages = attachments.map(item => item.url);
      const chartContext = window.InsightsCharts.describe?.(el('local-charts'));
      if (chartContext) payload.chartContext = chartContext;
      if (el('image-output').checked && !el('image-output-option').hidden) payload.imageOutput = true;
      const result = await api('/api/insights/ask', payload, request.signal);
      if (answerRequest !== request) return;
      const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
      const imageCount = renderModelImages(result.images);
      if (!answer && !imageCount) throw new Error('模型未返回可显示的文字或图片。');
      if (connection.fields.apiKey && apiKey.value.trim() === connection.fields.apiKey) {
        await updateKey('save', connection.fields.apiKey);
        if (answerRequest !== request) return;
      }
      if (result.evidence) { evidence = result.evidence; renderEvidence(result.evidence); }
      el('result-context').textContent = description;
      el('result-question').textContent = prompt;
      el('answer').textContent = answer;
      el('answer').hidden = !answer;
      el('image-warning').textContent = typeof result.imageWarning === 'string' ? result.imageWarning : '';
      el('image-warning').hidden = !el('image-warning').textContent;
      el('result').hidden = false;
      message('analysis-status', '分析完成。');
    } catch (error) {
      if (answerRequest === request) message('analysis-status', error.message, true);
    } finally {
      if (answerRequest === request) { answerRequest = null; syncActions(); }
    }
  }

  el('reload-library').addEventListener('click', () => loadLibrary(false));
  el('use-sample').addEventListener('click', () => {
    const add = !selected.has('sample');
    selected.clear();
    if (add) selected.add('sample');
    updateScope(true);
  });
  focus.addEventListener('change', () => updateScope());
  el('retry-evidence').addEventListener('click', () => updateScope());
  question.addEventListener('input', syncActions);
  el('add-input-images').addEventListener('click', () => el('input-image-files').click());
  el('input-image-files').addEventListener('change', event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    return addAttachments(files);
  });
  question.addEventListener('paste', event => {
    const clipboard = event.clipboardData;
    let files = Array.from(clipboard?.files || []).filter(file => file.type.startsWith('image/'));
    if (!files.length) {
      files = Array.from(clipboard?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile()).filter(Boolean);
    }
    if (!files.length) return;
    event.preventDefault();
    return addAttachments(files);
  });
  provider.addEventListener('change', () => {
    connectionEdited = true;
    selectProvider(provider.value);
    rememberConnection();
  });
  el('image-output').addEventListener('change', cancelAnswer);
  el('close-image').addEventListener('click', () => el('image-viewer').close());
  el('image-viewer').addEventListener('close', () => {
    if (!el('image-viewer').open) el('viewer-content').replaceChildren();
  });
  baseUrl.addEventListener('input', () => {
    connectionEdited = true;
    apiKey.value = '';
    void lookupKey();
    cancelAnswer();
  });
  baseUrl.addEventListener('change', rememberConnection);
  model.addEventListener('change', rememberConnection);
  el('save-key').addEventListener('click', () => updateKey('save', apiKey.value.trim()));
  el('forget-key').addEventListener('click', () => {
    apiKey.value = '';
    cancelAnswer();
    return updateKey('delete');
  });
  [model, apiKey].forEach(input => input.addEventListener('input', () => {
    connectionEdited = true;
    renderKeyActions();
    cancelAnswer();
  }));
  window.addEventListener('pagehide', () => {
    apiKey.value = '';
    if (answerRequest) cancelAnswer();
    else syncActions();
  });
  el('analysis-form').addEventListener('submit', submit);
  el('cancel-analysis').addEventListener('click', () => { cancelAnswer(); message('analysis-status', '已取消。'); });
  el('mcp-connection').addEventListener('toggle', async () => {
    if (!el('mcp-connection').open || mcpConfig) return;
    try {
      const settings = await api('/api/insights/mcp-config');
      mcpConfig = JSON.stringify(settings, null, 2);
      el('mcp-config').textContent = mcpConfig;
      el('copy-mcp').disabled = false;
      message('mcp-status', '');
    } catch (error) { message('mcp-status', error.message, true); }
  });
  el('copy-mcp').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(mcpConfig); message('mcp-status', '已复制。'); }
    catch { message('mcp-status', '浏览器无法访问剪贴板，请手动选中并复制上方配置。', true); }
  });
  selectProvider(Object.hasOwn(presets, preferences.provider) || preferences.provider === 'custom' ? preferences.provider : 'glm');
  void loadConfig();
  void loadLibrary(true);
})();
