const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../web/library-directory.js'), 'utf8');
const settle = () => new Promise(setImmediate);

function page(picked) {
  function element() {
    const events = new Map();
    return {
      children: [], value: '', setAttribute() {}, focus() {}, select() {},
      append(...children) { this.children.push(...children); },
      addEventListener(key, fn) { events.set(key, fn); },
      fire(key) { return events.get(key)({ preventDefault() {} }); }
    };
  }
  const picker = element(), edit = element(), container = element();
  container.dataset = { directoryControl: 'current' };
  container.querySelector = selector => selector === '[data-pick-directory]' ? picker : edit;
  const display = { id: 'current', title: '/matches/old' };
  const updates = [], calls = [];
  vm.runInNewContext(script, {
    Event, document: {
      querySelectorAll: () => [container], getElementById: () => display, createElement: element,
      dispatchEvent: event => updates.push(event.type)
    },
    BroadcastChannel: class { postMessage(msg) { updates.push(msg); } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (url.endsWith('/pick')) return { ok: true, json: async () => ({ directory: picked }) };
      const valid = body.directory !== 'missing';
      return { ok: valid, json: async () => valid ? body : { error: '目录不存在' } };
    }
  });
  const [form, status] = container.children;
  return { picker, edit, form, status, field: form.children[1], display, updates, calls };
}

test('selecting in the native picker switches once and notifies this page and other tabs', async () => {
  const ui = page('/录像/另一场');
  assert.deepEqual(ui.calls, []);
  const done = ui.picker.fire('click');
  await ui.picker.fire('click');
  await done;
  assert.deepEqual(ui.calls, [
    { url: '/api/library/directory/pick', body: {} },
    { url: '/api/library/directory', body: { directory: '/录像/另一场' } }
  ]);
  assert.equal(ui.display.title, '/录像/另一场');
  assert.deepEqual(ui.updates, ['library-directory-change', 'changed']);
});

test('cancelling the native picker leaves the current directory in place', async () => {
  const ui = page('');
  await ui.picker.fire('click');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.display.title, '/matches/old');
  assert.equal(ui.form.hidden, true);
  assert.deepEqual(ui.updates, []);
});

test('a typed path can be corrected and retried without opening the native picker', async () => {
  const ui = page('');
  ui.edit.fire('click');
  assert.equal(ui.field.value, '/matches/old');
  ui.field.value = 'missing';
  ui.form.fire('submit');
  await settle();
  assert.equal(ui.status.textContent, '目录不存在');
  assert.equal(ui.form.hidden, false);
  assert.equal(ui.display.title, '/matches/old');
  ui.field.value = '/matches/比赛录像';
  ui.form.fire('submit');
  await settle();
  assert.equal(ui.display.textContent, '/matches/比赛录像');
  assert.equal(ui.form.hidden, true);
  assert.ok(ui.calls.every(call => call.url === '/api/library/directory'));
});
