const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../web/sidebar-layout.js');

function page(saved = null, width = 1440, blockedStorage = false) {
  class Element {
    constructor() { this.listeners = {}; this.attributes = {}; this.disabled = false; this.style = { values: {}, setProperty: (key, value) => { this.style.values[key] = value; } }; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    fire(name, args = {}) { const event = { pointerId: 1, button: 0, clientX: 0, clientY: 0, preventDefault() {}, ...args }; for (const listener of this.listeners[name] || []) listener(event); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() { this.focused = true; }
    setPointerCapture(id) { this.captured = id; }
  }
  const ids = ['analysis-workspace', 'sidebar-width-handle', 'team-height-handle', 'player-height-handle'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const win = new Element(), root = new Element(), writes = [];
  win.innerWidth = width;
  win.localStorage = {
    getItem: () => { if (blockedStorage) throw Error('Storage unavailable'); return saved; },
    setItem: (key, value) => { if (blockedStorage) throw Error('Storage unavailable'); writes.push([key, JSON.parse(value)]); },
  };
  const installed = layout.install(win, { getElementById: id => elements[id], documentElement: root });
  return { elements, root, win, writes, installed };
}

test('sidebar preferences reject malformed data and clamp saved sizes', () => {
  assert.deepEqual(layout.sanitize({ width: '500', teams: Infinity, players: null }), layout.defaults);
  assert.deepEqual(layout.sanitize({ width: -2, teams: 2000, players: 9000 }), { width: 260, teams: 900, players: 1200 });
  assert.deepEqual(page('{broken').installed.values(), layout.defaults);
});

test('sidebar width protects map space and retains the preferred size across viewport changes', () => {
  const p = page(JSON.stringify({ width: 560, teams: 500, players: 720 }), 1920);
  assert.equal(p.installed.values().width, 560);
  p.win.innerWidth = 1180; p.win.fire('resize');
  assert.equal(p.installed.values().width, 460);
  assert.ok(1180 - p.installed.values().width - 300 >= 420);
  p.win.innerWidth = 701; p.win.fire('resize');
  assert.equal(p.installed.values().width, 281);
  p.win.innerWidth = 600; p.win.fire('resize');
  assert.equal(p.elements['sidebar-width-handle'].disabled, true);
  p.elements['sidebar-width-handle'].fire('keydown', { key: 'End' });
  p.win.innerWidth = 1920; p.win.fire('resize');
  assert.equal(p.installed.values().width, 560);
  assert.equal(p.elements['sidebar-width-handle'].disabled, false);
});

test('dragging adjusts only the targeted dimension and persists on release', () => {
  const p = page(), handle = p.elements['team-height-handle'];
  handle.fire('pointerdown', { clientY: 300, pointerId: 8 });
  handle.fire('pointermove', { clientY: 700, pointerId: 2 });
  assert.equal(p.installed.values().teams, 320, 'another pointer cannot resize the list');
  handle.fire('pointermove', { clientY: 700, pointerId: 8 });
  assert.deepEqual(p.installed.values(), { width: 320, teams: 720, players: 480 });
  assert.equal(handle.attributes['aria-valuenow'], '720');
  assert.equal(p.elements['analysis-workspace'].style.values['--filter-teams'], '720px');
  assert.equal(p.root.attributes['data-filter-resizing'], 'height');
  assert.equal(p.writes.length, 0);
  handle.fire('pointerup', { pointerId: 8 });
  assert.equal(p.root.attributes['data-filter-resizing'], undefined);
  assert.equal(p.writes.at(-1)[1].teams, 720);
  handle.fire('pointermove', { clientY: 1000, pointerId: 8 });
  assert.equal(p.installed.values().teams, 720);
});

test('resize handles support keyboard limits, coarse steps and reset', () => {
  const p = page(), handle = p.elements['player-height-handle'];
  handle.fire('keydown', { key: 'ArrowDown' }); assert.equal(p.installed.values().players, 496);
  handle.fire('keydown', { key: 'ArrowDown', shiftKey: true }); assert.equal(p.installed.values().players, 544);
  handle.fire('keydown', { key: 'End' }); assert.equal(p.installed.values().players, 1200);
  handle.fire('keydown', { key: 'ArrowDown' }); assert.equal(p.installed.values().players, 1200);
  handle.fire('keydown', { key: 'Home' }); assert.equal(p.installed.values().players, 180);
  handle.fire('keydown', { key: 'Enter' }); assert.equal(p.installed.values().players, 480);
  handle.fire('keydown', { key: 'ArrowUp' }); handle.fire('dblclick'); assert.equal(p.installed.values().players, 480);
  assert.equal(handle.attributes['aria-valuetext'], '480 像素');
});

test('cancelled drags and disabled storage do not leave the page in resize mode', () => {
  const p = page(null, 1440, true), handle = p.elements['sidebar-width-handle'];
  handle.fire('pointerdown', { clientX: 320 });
  handle.fire('pointermove', { clientX: 500 }); assert.equal(p.installed.values().width, 500);
  handle.fire('pointercancel'); assert.equal(p.root.attributes['data-filter-resizing'], undefined);
  handle.fire('pointerdown', { clientX: 500 }); p.win.fire('blur');
  handle.fire('pointermove', { clientX: 560 }); assert.equal(p.installed.values().width, 500);
  handle.fire('dblclick'); assert.equal(p.installed.values().width, 320);
});
