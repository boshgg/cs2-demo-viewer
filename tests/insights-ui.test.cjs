const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../web/insights.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../web/insights.js'), 'utf8');
const settle = () => new Promise(setImmediate);

function element() {
  const handlers = new Map();
  return {
    children: [], value: '', textContent: '', dataset: {}, classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; },
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
      return new Promise(resolve => { reply = answer => resolve(ok({ answer, evidence: sample })); });
    }
    throw new Error('unexpected request ' + url);
  };
  vm.runInNewContext(script, { document: { getElementById: get, createElement: element, createDocumentFragment: element },
    window, URL, URLSearchParams, AbortController, location: { search: '?demo=sample' }, fetch: api });
  await settle();
  get('question').value = 'Which rounds should we review?';
  get('question').fire('input');
  const set = (id, value) => {
    get(id).value = value;
    get(id).fire(id === 'provider' ? 'change' : 'input');
  };
  return { get, set, payloads, window, reply: text => reply(text) };
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
