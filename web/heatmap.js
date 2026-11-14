/* Frequency color mapping shared by the analysis canvas and regression tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayHeatmap = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Hue expresses density, independently of opacity and the kind of event.
  const stops = Object.freeze([
    [0, [43, 80, 235]],
    [.25, [0, 200, 255]],
    [.5, [40, 220, 100]],
    [.75, [255, 220, 35]],
    [1, [240, 45, 35]],
  ].map(([at, rgb]) => Object.freeze([at, Object.freeze(rgb)])));
  const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  function options(mode) {
    const value = typeof mode === 'string' ? { scale: mode } : mode || {};
    return {
      linear: value.scale === 'linear',
      boost: Number.isFinite(value.boost) && value.boost > 0 ? Math.min(1e6, value.boost) : 99,
    };
  }
  function scaled(x, config) {
    return config.linear ? x : Math.log1p(config.boost * x) / Math.log1p(config.boost);
  }
  function scaleValue(value, mode) { return scaled(unit(value), options(mode)); }
  function inverseScale(value, mode) {
    const x = unit(value), config = options(mode);
    return config.linear ? x : Math.expm1(x * Math.log1p(config.boost)) / config.boost;
  }

  // Points use normalized map coordinates; radius is measured in raster pixels.
  function density(points, size, radius) {
    if (!Number.isInteger(size) || size < 1 || size > 4096) throw new RangeError('Invalid heatmap raster size');
    if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Invalid heatmap radius');
    radius = Math.min(size, radius);
    const result = new Float64Array(size * size), extent = Math.ceil(radius), sigma = radius / 2.5;
    const kernel = [], edge = Math.exp(-(radius * radius) / (2 * sigma * sigma));
    for (let dy = -extent; dy <= extent; dy++) for (let dx = -extent; dx <= extent; dx++) {
      const square = dx * dx + dy * dy;
      // Subtract the truncated tail so the visible boundary reaches zero,
      // while rescaling keeps each observation's center at its full weight.
      if (square <= radius * radius) kernel.push([dx, dy, Math.max(0, (Math.exp(-square / (2 * sigma * sigma)) - edge) / (1 - edge))]);
    }
    for (const point of points || []) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.weight) || point.weight <= 0) continue;
      const px = Math.round(point.x * (size - 1)), py = Math.round(point.y * (size - 1));
      if (px < -extent || py < -extent || px >= size + extent || py >= size + extent) continue;
      for (const [dx, dy, k] of kernel) {
        const x = px + dx, y = py + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) result[y * size + x] += k * point.weight;
      }
    }
    return result;
  }
  function normalize(raw) {
    let peak = 0;
    for (const value of raw) if (Number.isFinite(value) && value > peak) peak = value;
    const values = new Float32Array(raw.length);
    if (peak > 0) for (let i = 0; i < raw.length; i++) values[i] = unit(raw[i] / peak);
    return { values, peak };
  }
  // Each metric is normalized separately before combination: seconds are never
  // added to deaths or shots. An extra selected layer cannot dilute a hotspot.
  function combine(layers) {
    const size = layers[0]?.length || 0, result = new Float32Array(size);
    for (const layer of layers) {
      if (layer.length !== size) throw new RangeError('Heatmap layers must have the same raster size');
      for (let i = 0; i < size; i++) result[i] = Math.max(result[i], unit(layer[i]));
    }
    return result;
  }
  function colorize(values, mode) {
    const pixels = new Uint8ClampedArray(values.length * 4), config = options(mode);
    for (let i = 0; i < values.length; i++) {
      const relative = unit(values[i]);
      if (relative <= 0) continue;
      const level = scaled(relative, config);
      let upper = 1;
      while (upper < stops.length - 1 && level > stops[upper][0]) upper++;
      const [from, low] = stops[upper - 1], [to, high] = stops[upper];
      const mix = (level - from) / (to - from), offset = i * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = low[channel] + (high[channel] - low[channel]) * mix;
      // Rare observations retain visible color. Only the faintest Gaussian
      // fringe fades out, preventing both hard outlines and invisible low data.
      const edge = Math.min(1, relative / .001);
      pixels[offset + 3] = 255 * (.65 + .25 * level) * edge * edge * (3 - 2 * edge);
    }
    return pixels;
  }
  return { stops, density, normalize, combine, colorize, scaleValue, inverseScale };
});
