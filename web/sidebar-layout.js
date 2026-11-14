/* Independent, local-only layout preferences for the analysis filters. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ReplaySidebarLayout = api; api.install(root, root.document); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const storageKey = 'cs2-analysis-sidebar-v1';
  const defaults = Object.freeze({ width: 320, teams: 320, players: 480 });
  const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));
  function limits(viewportWidth) {
    const width = Math.max(360, finite(viewportWidth, 1280));
    const reserved = width >= 1600 ? 940 : width > 1150 ? 720 : 420;
    const max = Math.max(260, Math.min(560, width - reserved));
    return { width: { min: 260, max, enabled: width > 700 }, teams: { min: 140, max: 900 }, players: { min: 180, max: 1200 } };
  }
  function sanitize(value) {
    const source = value && typeof value === 'object' ? value : {}, bounds = limits(2560);
    return Object.fromEntries(Object.keys(defaults).map(key => [key, clamp(finite(source[key], defaults[key]), bounds[key].min, bounds[key].max)]));
  }
  function install(win, doc) {
    const workspace = doc.getElementById('analysis-workspace');
    if (!workspace) return null;
    const handles = { width: doc.getElementById('sidebar-width-handle'), teams: doc.getElementById('team-height-handle'), players: doc.getElementById('player-height-handle') };
    if (Object.values(handles).some(handle => !handle)) return null;
    let saved;
    try { saved = JSON.parse(win.localStorage.getItem(storageKey) || '{}'); } catch { saved = {}; }
    const preferences = sanitize(saved), current = { ...preferences };
    let dragging = null;
    function persist() { try { win.localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Layout still works with storage disabled. */ } }
    function apply() {
      const bounds = limits(win.innerWidth);
      for (const key of Object.keys(defaults)) {
        const { min, max } = bounds[key], handle = handles[key];
        current[key] = clamp(preferences[key], min, max);
        workspace.style.setProperty(`--filter-${key}`, `${current[key]}px`);
        handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max));
        handle.setAttribute('aria-valuenow', String(current[key])); handle.setAttribute('aria-valuetext', `${current[key]} 像素`);
      }
      handles.width.disabled = !bounds.width.enabled;
      handles.width.setAttribute('aria-disabled', String(!bounds.width.enabled));
    }
    function set(key, value) { const { min, max } = limits(win.innerWidth)[key]; preferences[key] = clamp(value, min, max); apply(); }
    function end(event) {
      if (!dragging || (event && event.pointerId !== undefined && event.pointerId !== dragging.id)) return;
      dragging = null; doc.documentElement.removeAttribute('data-filter-resizing'); persist();
    }
    for (const [key, handle] of Object.entries(handles)) {
      const horizontal = key === 'width';
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || handle.disabled) return;
        event.preventDefault(); handle.focus();
        dragging = { key, id: event.pointerId, origin: horizontal ? event.clientX : event.clientY, size: current[key] };
        handle.setPointerCapture(event.pointerId);
        doc.documentElement.setAttribute('data-filter-resizing', horizontal ? 'width' : 'height');
      });
      handle.addEventListener('pointermove', event => {
        if (!dragging || dragging.id !== event.pointerId || dragging.key !== key) return;
        set(key, dragging.size + (horizontal ? event.clientX : event.clientY) - dragging.origin);
      });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, end);
      handle.addEventListener('dblclick', () => { if (!handle.disabled) { set(key, defaults[key]); persist(); } });
      handle.addEventListener('keydown', event => {
        if (handle.disabled) return;
        const negative = horizontal ? 'ArrowLeft' : 'ArrowUp', positive = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (![negative, positive, 'Home', 'End', 'Enter'].includes(event.key)) return;
        event.preventDefault(); const { min, max } = limits(win.innerWidth)[key], step = event.shiftKey ? 48 : 16;
        set(key, event.key === 'Home' ? min : event.key === 'End' ? max : event.key === 'Enter' ? defaults[key] : current[key] + (event.key === negative ? -step : step)); persist();
      });
    }
    win.addEventListener('resize', () => { end(); apply(); });
    win.addEventListener('blur', () => end());
    apply();
    return { values: () => ({ ...current }) };
  }
  return { defaults, limits, sanitize, install };
});
