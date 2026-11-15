/* Fixed elapsed-time windows. Scheduling and analysis requests belong to the UI. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayHeatmapPlayback = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const duration = 115, defaultWindowLength = 10;
  const speeds = Object.freeze([.25, .5, 1, 2, 4, 8]);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function normalizeWindowLength(value) {
    return finite(value) ? clamp(Math.round(value), 1, duration) : defaultWindowLength;
  }
  function normalizeSpeed(value) { return speeds.includes(value) ? value : 1; }
  function stepDelay(speed) { return 1000 / normalizeSpeed(speed); }
  function rangeForStart(start, length = defaultWindowLength) {
    const width = normalizeWindowLength(length);
    const first = finite(start) ? clamp(Math.round(start), 0, duration - width) : 0;
    return { start: first, end: first + width };
  }
  function validRange(range) {
    if (!range || typeof range !== 'object' || Array.isArray(range) || !finite(range.start) || !finite(range.end)) return null;
    const start = clamp(Math.round(range.start), 0, duration), end = clamp(Math.round(range.end), 0, duration);
    return start < end ? { start, end } : null;
  }
  function prepareStart(range, length = defaultWindowLength) {
    const current = validRange(range), width = current ? current.end - current.start : normalizeWindowLength(length);
    // A finished range restarts on Play. Pausing elsewhere resumes the
    // displayed interval, including its width after a manual adjustment.
    const next = current && current.end < duration ? current : rangeForStart(0, width);
    return { range: next, length: width, canPlay: width < duration };
  }
  function advanceRange(range) {
    const current = validRange(range);
    if (!current || current.end >= duration) return null;
    return rangeForStart(current.start + 1, current.end - current.start);
  }

  return { duration, defaultWindowLength, speeds, normalizeWindowLength, normalizeSpeed, rangeForStart, prepareStart, advanceRange, stepDelay };
});
