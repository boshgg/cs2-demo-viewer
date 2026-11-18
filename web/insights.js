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
  const provider = el('provider');
  const baseUrl = el('base-url');
  const model = el('model-name');
  const apiKey = el('api-key');
  const presets = {
    glm: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', name: '智谱 GLM' },
    deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-flash', name: 'DeepSeek' }
  };
  let connectionEdited = false;

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
    apiKey.required = Boolean(preset);
    apiKey.placeholder = preset ? `填写 ${preset.name} API 密钥` : '本机免密模型可留空';
    baseUrl.value = preset?.url || '';
    baseUrl.readOnly = Boolean(preset);
    model.value = preset?.model || '';
    el('provider-fields').hidden = system;
    el('server-config').hidden = !system && value !== 'custom';
    if (system) message('server-config', `使用查看器启动时配置的 ${config.model} @ ${config.endpoint}。`);
    if (value === 'custom') message('server-config', '填写兼容 Chat Completions 的服务地址和模型 ID。');
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
    if (preset && !key) return { error: `请在「模型连接」填写 ${preset.name} 的 API 密钥。` };
    let endpoint;
    try { endpoint = new URL(url); } catch { return { error: '请输入完整的 API 地址。' }; }
    const local = ['localhost', '[::1]'].includes(endpoint.hostname) || /^127\.\d+\.\d+\.\d+$/.test(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !(endpoint.protocol === 'https:' || (local && endpoint.protocol === 'http:'))) {
      return { error: '请使用 HTTPS 基础地址或本机 HTTP 地址，移除地址中的凭据、查询参数和片段。' };
    }
    return { label: `${name} @ ${endpoint.origin}`, fields: { baseUrl: url, model: name, apiKey: key } };
  }

  function syncActions() {
    const connection = providerOptions();
    el('destination').textContent = connection.error ||
      `点击发送后，问题及所选比赛的统计证据（含玩家标识）将发送至 ${connection.label}。`;
    el('ask').disabled = !evidence || !question.value.trim() || !!answerRequest || !!connection.error;
    el('cancel-analysis').hidden = !answerRequest;
  }

  function cancelAnswer() {
    answerRequest?.abort();
    answerRequest = null;
    el('result').hidden = true;
    el('answer').textContent = '';
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
  }

  async function updateScope(resetSubject = false) {
    evidenceRequest?.abort();
    evidenceRequest = null;
    evidence = null;
    cancelAnswer();
    if (resetSubject) populateSubjects(null);
    renderMatches();
    el('evidence-content').hidden = true;
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
        if (!connectionEdited) selectProvider('server');
      }
    } catch (error) {
      el('server-config').hidden = false;
      message('server-config', `读取系统默认配置失败：${error.message}。仍可选择模型厂商。`, true);
    }
    if (!config.configured) el('connection').open = true;
    syncActions();
  }

  async function submit(event) {
    event.preventDefault();
    const connection = providerOptions();
    const prompt = question.value.trim();
    if (!evidence || !prompt || connection.error || answerRequest) return;
    const currentScope = scope();
    const description = `${el('scope-summary').textContent} ${focus.selectedOptions[0]?.textContent || ''} · ${connection.label}`;
    cancelAnswer();
    const request = new AbortController();
    answerRequest = request;
    syncActions();
    message('analysis-status', '模型正在分析所选比赛…');
    try {
      const result = await api('/api/insights/ask', { ...currentScope, ...connection.fields, question: prompt }, request.signal);
      if (answerRequest !== request) return;
      if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('模型未返回分析正文，请重新发送。');
      if (result.evidence) { evidence = result.evidence; renderEvidence(result.evidence); }
      el('result-context').textContent = description;
      el('result-question').textContent = prompt;
      el('answer').textContent = result.answer;
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
  provider.addEventListener('change', () => {
    connectionEdited = true;
    selectProvider(provider.value);
  });
  baseUrl.addEventListener('input', () => {
    connectionEdited = true;
    apiKey.value = '';
    cancelAnswer();
  });
  [model, apiKey].forEach(input => input.addEventListener('input', () => {
    connectionEdited = true;
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
  selectProvider('glm');
  void loadConfig();
  void loadLibrary(true);
})();
