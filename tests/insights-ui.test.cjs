const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../web/insights.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../web/insights.js'), 'utf8');
const settle = () => new Promise(setImmediate);

function element(tagName = 'div') {
  const handlers = new Map();
  return {
    tagName, children: [], value: '', textContent: '', dataset: {}, classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; },
    contains(child) { return this.children.includes(child); },
    showModal() { this.open = true; },
    close() { this.open = false; this.fire('close'); },
    get options() { return this.children; },
    get selectedOptions() { return this.children.slice(0, 1); },
    set innerHTML(value) { assert.fail('Untrusted API content must render as text'); },
    addEventListener(type, handler) { handlers.set(type, handler); },
    fire(type) { return handlers.get(type)({ preventDefault() {} }); }
  };
}

const systemConfig = { configured: true, model: 'system', endpoint: 'https://system.example' };

async function startPage(config = systemConfig) {
  const inputs = Object.fromEntries([...html.matchAll(/\sid="([^"]+)"/g)].map(match => [match[1], element()]));
  const get = id => inputs[id];
  const window = element();
  const copied = [];
  const chartScopes = [];
  window.InsightsCharts = { render(container, report, scope) {
    chartScopes.push(scope);
    container.replaceChildren(element('figure'));
  } };
  const payloads = [];
  let reply;
  const sample = { synthetic: true, players: [], teams: [], matches: [{ demoId: 'sample', map: 'de_mirage', roundCount: 3 }] };
  const ok = data => ({ ok: true, json: async () => data });
  const api = async (url, options) => {
    if (url === '/api/library/demos') return ok({ demos: [] });
    if (url === '/api/insights/config') return ok(await config);
    const data = JSON.parse(options.body);
    payloads.push({ url, data, signal: options.signal });
    if (url === '/api/insights/evidence') return ok(sample);
    if (url === '/api/insights/ask') {
      // Deliberately resolve even after abort. A stale reply must not repaint the page.
      return new Promise(resolve => { reply = result => resolve(ok({ evidence: sample, ...result })); });
    }
    throw new Error('unexpected request ' + url);
  };
  vm.runInNewContext(script, { document: { getElementById: get, createElement: element, createDocumentFragment: element },
    window, URL, URLSearchParams, AbortController, location: { search: '?demo=sample' },
    navigator: { clipboard: { writeText: async value => copied.push(value) } }, fetch: api });
  await settle();
  get('question').value = 'Which rounds should we review?';
  get('question').fire('input');
  const set = (id, value) => {
    get(id).value = value;
    get(id).fire(id === 'provider' ? 'change' : 'input');
  };
  return { get, set, payloads, window, chartScopes, copied, reply: answer => reply({ answer }), replyParts: result => reply(result) };
}

test('custom connection keys are cleared when switching destination and on page exit', async () => {
  const { get, set, payloads, reply, window } = await startPage();
  set('provider', 'custom');
  assert.ok(!get('base-url').readOnly && !get('base-url').disabled);
  assert.equal(get('ask').disabled, true);
  set('base-url', 'http://remote.example/v1');
  set('model-name', 'match-analysis');
  assert.equal(get('ask').disabled, true);
  set('base-url', 'http://127.0.0.1:11434/v1');
  assert.equal(get('ask').disabled, false);
  set('base-url', 'https://first.example/v1');
  set('api-key', 'test-only');
  set('base-url', 'https://second.example/v1');
  assert.equal(get('api-key').value, '');
  assert.match(get('destination').textContent, /second\.example/);
  const done = get('analysis-form').fire('submit');
  assert.equal(payloads.at(-1).data.baseUrl, 'https://second.example/v1');
  assert.equal(payloads.at(-1).data.apiKey, '');
  const markup = '<img src="x" onerror="throw 1">';
  reply(markup);
  await done;
  assert.equal(get('answer').textContent, markup);
  set('api-key', 'second-test-only');
  window.fire('pagehide');
  assert.equal(get('api-key').value, '');
});

test('late model responses cannot reveal answers after leaving the selected match scope', async () => {
  const { get, payloads, reply } = await startPage();
  const done = get('analysis-form').fire('submit');
  assert.equal(get('provider').value, 'server');
  assert.equal(get('provider-fields').hidden, true);
  assert.deepEqual(payloads.at(-1).data.demoIds, ['sample']);
  assert.equal(payloads.at(-1).data.apiKey, undefined);
  assert.equal(payloads.at(-1).data.model, undefined);
  assert.equal(payloads.at(-1).data.baseUrl, undefined);
  get('use-sample').fire('click');
  reply('Answer for the previous match');
  await done;
  assert.equal(get('result').hidden, true);
  assert.equal(get('answer').textContent, '');
  assert.equal(get('ask').disabled, true);
});

test('official connections fill the address and model and only send the selected provider key', async () => {
  const { get, set, payloads, reply } = await startPage({ configured: false });
  const selector = html.match(/<select\b[^>]*\bid="provider"[^>]*>([\s\S]*?)<\/select>/)[1];
  const options = [...selector.matchAll(/<option\b[^>]*\bvalue="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options.sort(), ['custom', 'deepseek', 'glm', 'server']);
  assert.equal(get('provider').value, 'glm');
  for (const [provider, address, next] of [
    ['glm', /^https:\/\/open\.bigmodel\.cn\/api\/paas\/v4\/?$/, 'deepseek'],
    ['deepseek', /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/, 'custom']
  ]) {
    assert.equal(get('provider').value, provider);
    assert.match(get('base-url').value, address);
    assert.ok(get('base-url').readOnly || get('base-url').disabled);
    assert.ok(get('model-name').value.trim());
    assert.ok(!get('model-name').readOnly && !get('model-name').disabled);
    assert.equal(get('api-key').value, '');
    assert.equal(get('ask').disabled, true);
    const previousRequests = payloads.length;
    await get('analysis-form').fire('submit');
    assert.equal(payloads.length, previousRequests);

    set('model-name', provider + '-account-model');
    set('api-key', provider + '-test-key');
    assert.equal(get('ask').disabled, false);
    const pending = get('analysis-form').fire('submit');
    const request = payloads.at(-1);
    assert.equal(request.url, '/api/insights/ask');
    assert.match(request.data.baseUrl, address);
    assert.equal(request.data.model, provider + '-account-model');
    assert.equal(request.data.apiKey, provider + '-test-key');
    set('provider', next);
    assert.equal(request.signal.aborted, true);
    assert.equal(get('api-key').value, '');
    reply('Previous provider response');
    await pending;
    assert.equal(get('answer').textContent, '');
    assert.equal(get('result').hidden, true);
  }
  assert.equal(get('base-url').value, '');
  assert.ok(!get('base-url').readOnly && !get('base-url').disabled);
});

test('a delayed system configuration reply preserves the manually selected provider and key', async () => {
  let resolveConfig;
  const config = new Promise(resolve => { resolveConfig = resolve; });
  const { get, set } = await startPage(config);
  set('provider', 'deepseek');
  set('api-key', 'deepseek-test-key');
  resolveConfig(systemConfig);
  await settle();
  assert.equal(get('provider').value, 'deepseek');
  assert.equal(get('api-key').value, 'deepseek-test-key');
  assert.match(get('destination').textContent, /api\.deepseek\.com/);
  set('provider', 'server');
  assert.equal(get('api-key').value, '');
  assert.match(get('destination').textContent, /system\.example/);
});

const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=';

function child(parent, tag) { return parent.children.find(item => item.tagName === tag); }

test('image-only replies can be viewed and saved; changing scope clears the open image and local chart', async () => {
  const { get, payloads, chartScopes, replyParts } = await startPage();
  assert.deepEqual([...chartScopes[0].demoIds], ['sample']);
  assert.equal(get('charts-panel').hidden, false);
  assert.equal(get('image-output-option').hidden, false);
  get('image-output').checked = true;
  get('image-output').fire('change');
  const pending = get('analysis-form').fire('submit');
  assert.equal(payloads.at(-1).data.imageOutput, true);
  replyParts({ answer: '', images: [{ url: thumbnail, alt: '图 1' }] });
  await pending;
  assert.equal(get('result').hidden, false);
  assert.equal(get('answer').hidden, true);
  const figure = get('image-gallery').children[0];
  assert.equal(child(figure, 'figcaption').textContent, '图 1');
  const img = child(figure, 'img');
  assert.equal(img.src, thumbnail);
  img.fire('load');
  assert.equal(img.hidden, false);
  const actions = child(figure, 'div');
  assert.equal(actions.hidden, false);
  assert.equal(child(actions, 'a').href, thumbnail);
  assert.match(child(actions, 'a').download, /\.png$/);
  child(actions, 'button').fire('click');
  assert.equal(get('image-viewer').open, true);
  assert.equal(child(get('viewer-content'), 'img').src, thumbnail);
  get('use-sample').fire('click');
  assert.equal(get('image-viewer').open, false);
  assert.equal(get('image-gallery').children.length, 0);
  assert.equal(get('viewer-content').children.length, 0);
  assert.equal(get('local-charts').children.length, 0);
  assert.equal(get('charts-panel').hidden, true);
});

test('remote images wait for explicit loading, isolate credentials and keep accompanying text when a link fails', async () => {
  const { get, set, payloads, replyParts, copied } = await startPage({ configured: false });
  assert.equal(get('image-output-option').hidden, true);
  set('api-key', 'mock-glm-key');
  const remote = 'https://cdn.example/report.png?signature=temporary';
  const pending = get('analysis-form').fire('submit');
  assert.equal(payloads.at(-1).data.imageOutput, undefined);
  replyParts({ answer: '文字分析', imageWarning: '部分配图不可用。', images: [
    { url: thumbnail, alt: '一' }, { url: remote, alt: '<b>二</b>' },
    { url: 'javascript:alert(1)' }, { url: 'data:image/svg+xml;base64,AAAA' }, { url: 'https://key@cdn.example/path' }
  ] });
  await pending;
  assert.equal(get('answer').textContent, '文字分析');
  assert.equal(get('image-warning').textContent, '部分配图不可用。');
  assert.equal(get('image-gallery').children.length, 2);
  const external = get('image-gallery').children[1];
  const img = child(external, 'img'), load = child(external, 'button');
  assert.equal(img.src, undefined);
  assert.equal(img.alt, '<b>二</b>');
  assert.equal(img.referrerPolicy, 'no-referrer');
  assert.equal(img.crossOrigin, 'anonymous');
  assert.match(child(external, 'p').textContent, /cdn\.example/);
  assert.doesNotMatch(child(external, 'p').textContent, /signature|mock-glm-key/);
  load.fire('click');
  assert.equal(img.src, remote);
  img.fire('error');
  assert.equal(load.hidden, false);
  assert.match(child(external, 'p').textContent, /无法加载/);
  assert.equal(get('answer').textContent, '文字分析');
  const copy = external.children.find(item => item.textContent === '复制图片链接');
  assert.equal(copy.hidden, false);
  await copy.fire('click');
  assert.deepEqual(copied, [remote]);
});

test('switching away from a custom image model aborts the request and ignores its late images', async () => {
  const { get, set, payloads, replyParts } = await startPage();
  set('provider', 'custom');
  set('base-url', 'https://vendor.example/v1');
  set('model-name', 'image-capable');
  get('image-output').checked = true;
  const pending = get('analysis-form').fire('submit');
  assert.equal(payloads.at(-1).data.imageOutput, true);
  set('provider', 'deepseek');
  assert.equal(payloads.at(-1).signal.aborted, true);
  assert.equal(get('image-output').checked, false);
  assert.equal(get('image-output-option').hidden, true);
  replyParts({ images: [{ url: thumbnail }] });
  await pending;
  assert.equal(get('image-gallery').children.length, 0);
  assert.equal(get('result').hidden, true);
});
