const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/labels.js'), 'utf8'), sandbox);
const place = sandbox.window.ReplayLabels.place;
const overlaps = (a, b) => a.x < b.x + b.w - .001 && a.x + a.w > b.x + .001 && a.y < b.y + b.h - .001 && a.y + a.h > b.y + .001;
function validate(items, placements, width, height, obstacles) {
  assert.equal(placements.length, items.length, 'no label is discarded');
  placements.forEach((p, i) => {
    assert.equal(p.id, items[i].id);
    assert.equal(p.anchor.x, items[i].anchor.x, 'true x is untouched');
    assert.equal(p.anchor.y, items[i].anchor.y, 'true y is untouched');
    assert.equal(p.w, items[i].w); assert.equal(p.h, items[i].h);
    assert.equal(p.overflow, false, `unexpected overflow for ${p.id}`);
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= width + .001 && p.y + p.h <= height + .001, 'label stays inside viewport');
    for (const obstacle of obstacles) assert.ok(!overlaps(p, obstacle), `label ${p.id} covers a true position`);
    for (let j = 0; j < i; j++) assert.ok(!overlaps(p, placements[j]), `labels ${p.id}/${placements[j].id} overlap`);
    assert.equal(p.leader[0].x, items[i].anchor.x); assert.equal(p.leader[0].y, items[i].anchor.y);
    const end = p.leader.at(-1);
    assert.ok(end.x >= p.x - .001 && end.x <= p.x + p.w + .001 && end.y >= p.y - .001 && end.y <= p.y + p.h + .001, 'leader reaches label');
  });
}
function group(anchors, w = 160) {
  return anchors.map((anchor, i) => ({ id: `p${i}`, anchor, w: typeof w === 'function' ? w(i) : w, h: 18, order: i }));
}
const obstaclesFor = items => items.map(p => ({ x: p.anchor.x - 7, y: p.anchor.y - 7, w: 14, h: 14 }));
test('ten completely coincident long name + gun labels fit without moving players', () => {
  const items = group(Array.from({ length: 10 }, () => ({ x: 250, y: 250 })));
  const obstacles = obstaclesFor(items), original = JSON.stringify(items);
  validate(items, place(items, { width: 500, height: 500, obstacles }), 500, 500, obstacles);
  assert.equal(JSON.stringify(items), original);
});
test('dense mixed widths, selected priority, and nearby non-player obstacles', () => {
  const items = group(Array.from({ length: 10 }, (_, i) => ({ x: 250 + Math.cos(i * .8) * 17, y: 250 + Math.sin(i * .8) * 12 })), i => 74 + i * 9);
  items[7].priority = 10;
  const obstacles = [...obstaclesFor(items), { x: 200, y: 180, w: 80, h: 28 }];
  validate(items, place(items, { width: 500, height: 500, obstacles }), 500, 500, obstacles);
});
test('ten 160px labels fit the 320×300 viewport at each corner and center', () => {
  for (const anchor of [{ x: 2, y: 2 }, { x: 318, y: 2 }, { x: 2, y: 298 }, { x: 318, y: 298 }, { x: 160, y: 150 }]) {
    const items = group(Array.from({ length: 10 }, () => ({ ...anchor }))), obstacles = obstaclesFor(items);
    validate(items, place(items, { width: 320, height: 300, obstacles }), 320, 300, obstacles);
  }
});
test('distributed edge positions and central cluster remain legible together', () => {
  const items = group([{ x: 1, y: 1 }, { x: 499, y: 1 }, { x: 1, y: 499 }, { x: 499, y: 499 }, { x: 250, y: 3 }, { x: 250, y: 497 }, { x: 247, y: 248 }, { x: 251, y: 252 }, { x: 249, y: 251 }, { x: 253, y: 250 }], i => 85 + i * 8);
  const obstacles = obstaclesFor(items);
  validate(items, place(items, { width: 500, height: 500, obstacles }), 500, 500, obstacles);
});
test('one-pixel frame jitter preserves most existing placements', () => {
  const items = group(Array.from({ length: 10 }, (_, i) => ({ x: 250 + Math.cos(i) * 9, y: 250 + Math.sin(i) * 9 })), 130);
  const first = place(items, { width: 500, height: 500, obstacles: obstaclesFor(items) });
  const shifted = items.map(p => ({ ...p, anchor: { x: p.anchor.x + 1, y: p.anchor.y + .5 } }));
  const second = place(shifted, { width: 500, height: 500, obstacles: obstaclesFor(shifted), previous: new Map(first.map(p => [p.id, p])) });
  validate(shifted, second, 500, 500, obstaclesFor(shifted));
  assert.ok(second.filter((p, i) => Math.hypot(p.x - first[i].x, p.y - first[i].y) < 6).length >= 8, 'labels should not shuffle under tiny movement');
});
test('previous positions outside a resized viewport are recomputed', () => {
  const items = group(Array.from({ length: 10 }, (_, i) => ({ x: 160 + (i % 3), y: 150 + (i % 2) })), 130);
  const previous = new Map(items.map(p => [p.id, { ...p, x: 800, y: 800 }]));
  const obstacles = obstaclesFor(items);
  validate(items, place(items, { width: 320, height: 300, obstacles, previous }), 320, 300, obstacles);
});
test('new obstacles invalidate otherwise stable previous-frame positions', () => {
  const items = group(Array.from({ length: 10 }, (_, i) => ({ x: 245 + i, y: 250 })), 125);
  const obstacles = obstaclesFor(items);
  const first = place(items, { width: 500, height: 500, obstacles });
  obstacles.push({ x: first[0].x, y: first[0].y, w: first[0].w, h: first[0].h });
  const previous = new Map(first.map(p => [p.id, p]));
  validate(items, place(items, { width: 500, height: 500, obstacles, previous }), 500, 500, obstacles);
});
test('seeded realistic mixed-width moving groups fit both viewport sizes', () => {
  let seed = 731;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let n = 0; n < 30; n++) {
    const width = n % 2 ? 500 : 320, height = n % 2 ? 500 : 300;
    const cx = random() * width, cy = random() * height;
    const items = group(Array.from({ length: 10 }, () => ({ x: Math.max(0, Math.min(width, cx + (random() - .5) * 80)), y: Math.max(0, Math.min(height, cy + (random() - .5) * 80)) })), () => 80 + Math.round(random() * 80));
    const obstacles = obstaclesFor(items);
    validate(items, place(items, { width, height, obstacles }), width, height, obstacles);
  }
});
test('explicit order makes layouts deterministic independent of input order', () => {
  const items = group(Array.from({ length: 10 }, (_, i) => ({ x: 245 + i, y: 250 })), 110);
  const options = { width: 500, height: 500, obstacles: obstaclesFor(items) };
  const first = place(items, options), reverse = place(items.slice().reverse(), options);
  first.forEach(p => { const q = reverse.find(q => q.id === p.id); assert.equal(p.x, q.x); assert.equal(p.y, q.y); });
});
test('impossible viewport reports overflow and retains every identity', () => {
  const items = group(Array.from({ length: 20 }, () => ({ x: 40, y: 30 })), 120);
  const out = place(items, { width: 120, height: 70, obstacles: [{ x: 0, y: 0, w: 120, h: 70 }] });
  assert.equal(out.length, items.length);
  assert.ok(out.every(p => p.overflow && p.y > 70));
  out.forEach((p, i) => { assert.equal(p.id, items[i].id); for (let j = 0; j < i; j++) assert.ok(!overlaps(p, out[j])); });
});
