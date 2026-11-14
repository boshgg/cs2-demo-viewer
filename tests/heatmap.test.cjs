const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../web/heatmap.js');
const pixel = (data, i) => Array.from(data.slice(i * 4, i * 4 + 4));

test('empty and invalid observations stay transparent, without inventing hotspots', () => {
  const raw = [0, -5, NaN, Infinity, -Infinity];
  const normalized = H.normalize(raw);
  assert.equal(normalized.peak, 0);
  assert.deepEqual(Array.from(H.colorize(raw)), Array(raw.length * 4).fill(0));
  assert.deepEqual(Array.from(H.colorize(normalized.values)), Array(raw.length * 4).fill(0));
  assert.equal(H.combine([]).length, 0);
});

test('rare and low observations have distinct visible hues even under one strong peak', () => {
  const { values, peak } = H.normalize([1, 5, 100]);
  assert.equal(peak, 100);
  const image = H.colorize(values), rare = pixel(image, 0), low = pixel(image, 1), high = pixel(image, 2);
  assert.ok(rare[3] >= 165 && low[3] >= 165, 'low frequency must not disappear through low alpha');
  const colorDistance = Math.hypot(...rare.slice(0, 3).map((v, i) => v - low[i]));
  assert.ok(colorDistance > 70, '1% and 5% must be distinguishable by hue, not just opacity');
  assert.ok(rare[2] > rare[0] && high[0] > high[1] * 3 && high[0] > high[2] * 3, 'low blue and high red');
  assert.ok(high[1] < 80 && high[2] < 80, 'peak must remain red instead of washing out to white');
});

test('scale preserves ordering and legend inverse values round-trip for both modes', () => {
  for (const mode of ['log', 'linear', { scale: 'log', boost: 999 }]) {
    const samples = [0, .0001, .001, .01, .05, .2, .5, 1];
    let previous = -1;
    for (const value of samples) {
      const scaled = H.scaleValue(value, mode);
      assert.ok(scaled > previous);
      assert.ok(Math.abs(H.inverseScale(scaled, mode) - value) < 1e-12);
      previous = scaled;
    }
  }
  assert.ok(H.scaleValue(.01) > H.scaleValue(.01, 'linear') * 10);
  assert.equal(H.scaleValue(NaN), 0);
  assert.equal(H.inverseScale(Infinity), 0);
});

test('overlaid metrics preserve hotspots independently of selection order and unit scale', () => {
  const movement = H.normalize([10000, 2000, 0]).values;
  const deaths = H.normalize([0, 1, 5]).values;
  const mixed = H.combine([movement, deaths]);
  assert.deepEqual(mixed, H.combine([deaths, movement]));
  assert.deepEqual(mixed, H.combine([movement, deaths, new Float32Array(3)]));
  assert.deepEqual(mixed, H.combine([movement, movement, deaths]));
  assert.deepEqual(H.colorize(mixed), H.colorize(H.combine([H.normalize([10, 2, 0]).values, deaths])));
  assert.equal(mixed[0], 1);
  assert.equal(mixed[2], 1);
  assert.ok(Math.abs(mixed[1] - .2) < 1e-7, 'independent seconds and counts must not add together');
  assert.throws(() => H.combine([movement, [1, 2]]), /same raster size/);
});

test('Gaussian density accumulates repeated observations while retaining distinct isolated weights', () => {
  const raw = H.density([{ x: .25, y: .5, weight: 1 }, { x: .75, y: .5, weight: 5 }], 101, 6);
  assert.equal(raw[50 * 101 + 25], 1);
  assert.equal(raw[50 * 101 + 75], 5);
  assert.equal(raw[50 * 101 + 50], 0);
  assert.equal(raw[0], 0);
  const repeated = H.density([{ x: .25, y: .5, weight: 1 }, { x: .25, y: .5, weight: 4 }], 101, 6);
  assert.equal(repeated[50 * 101 + 25], 5);
  const ignored = H.density([{ x: NaN, y: .5, weight: 2 }, { x: .5, y: .5, weight: Infinity }, { x: 99, y: 99, weight: 5 }], 101, 6);
  assert.ok(ignored.every(value => value === 0));
});

test('only the outer fringe fades: visible sparse colors keep their frequency hues', () => {
  const image = H.colorize([0, .00001, .0001, .001, .01]);
  const alpha = Array.from({ length: 5 }, (_, i) => pixel(image, i)[3]);
  assert.equal(alpha[0], 0);
  assert.ok(alpha[1] < alpha[2] && alpha[2] < alpha[3]);
  assert.ok(alpha[3] >= 165 && alpha[4] >= 165);
});

test('density falls to zero at the kernel boundary without changing center weights', () => {
  const size = 101, radius = 10, raw = H.density([{ x: .5, y: .5, weight: 7 }], size, radius);
  const at = dx => raw[50 * size + 50 + dx];
  assert.equal(at(0), 7);
  assert.equal(at(radius), 0);
  assert.equal(at(radius + 1), 0);
  assert.ok(at(radius - 1) > 0 && at(radius - 1) < at(radius - 2));
  assert.ok(raw.every(value => value >= 0 && Number.isFinite(value)));
  const pixels = H.colorize(H.normalize(raw).values);
  assert.equal(pixels[(50 * size + 50 + radius) * 4 + 3], 0);
});

test('isolated 1, 3, 10, 100 observation centers preserve strength and input records', () => {
  const points = [1, 3, 10, 100].map((weight, i) => Object.freeze({ x: (20 + i * 50) / 200, y: .5, weight }));
  points.push(Object.freeze({ x: .5, y: .5, weight: -100 }), Object.freeze({ x: .5, y: .5, weight: NaN }));
  Object.freeze(points);
  const raw = H.density(points, 201, 8);
  const centers = [20, 70, 120, 170].map(x => raw[100 * 201 + x]);
  assert.deepEqual(centers, [1, 3, 10, 100]);
  const colors = H.colorize(H.normalize(centers).values);
  assert.equal(new Set(Array.from({ length: 4 }, (_, i) => pixel(colors, i).slice(0, 3).join(','))).size, 4);
  assert.deepEqual(points.slice(0, 4).map(p => p.weight), [1, 3, 10, 100]);
  assert.equal(raw[100 * 201 + 100], 0, 'negative and invalid weights cannot create density');
});
