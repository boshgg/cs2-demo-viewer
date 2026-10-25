/* Deterministic screen-space label placement. Anchors always remain untouched. */
(() => {
  'use strict';
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const intersect = (a, b, gap = 0) => a.x < b.x + b.w + gap - .001 && a.x + a.w + gap > b.x + .001 && a.y < b.y + b.h + gap - .001 && a.y + a.h + gap > b.y + .001;
  function rectangle(value) {
    const x = finite(value.x, finite(value.left)), y = finite(value.y, finite(value.top));
    return { x, y, w: Math.max(0, finite(value.w, finite(value.width, finite(value.right) - x))), h: Math.max(0, finite(value.h, finite(value.height, finite(value.bottom) - y))) };
  }
  function crosses(a, b, c, d) {
    // Shared origins are expected for perfectly overlapping players, and are
    // not treated as avoidable crossings.
    if (distance(a, c) < 2 || distance(a, d) < 2 || distance(b, c) < 2 || distance(b, d) < 2) return false;
    const turn = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return turn(a, b, c) * turn(a, b, d) < -.001 && turn(c, d, a) * turn(c, d, b) < -.001;
  }
  function cutsRectangle(a, b, r) {
    if (a.x > r.x && a.x < r.x + r.w && a.y > r.y && a.y < r.y + r.h) return true;
    if (b.x > r.x && b.x < r.x + r.w && b.y > r.y && b.y < r.y + r.h) return true;
    const tl = { x: r.x, y: r.y }, tr = { x: r.x + r.w, y: r.y };
    const bl = { x: r.x, y: r.y + r.h }, br = { x: r.x + r.w, y: r.y + r.h };
    return crosses(a, b, tl, tr) || crosses(a, b, tr, br) || crosses(a, b, br, bl) || crosses(a, b, bl, tl);
  }
  function route(anchor, box, placed) {
    const target = { x: clamp(anchor.x, box.x, box.x + box.w), y: clamp(anchor.y, box.y, box.y + box.h) };
    const candidates = [[{ ...anchor }, target]];
    if (Math.abs(target.x - anchor.x) > 2 && Math.abs(target.y - anchor.y) > 2) {
      candidates.push([{ ...anchor }, { x: target.x, y: anchor.y }, target]);
      candidates.push([{ ...anchor }, { x: anchor.x, y: target.y }, target]);
    }
    let best = null;
    for (const points of candidates) {
      let cost = points.length === 3 ? 2 : 0;
      for (let i = 1; i < points.length; i++) {
        cost += distance(points[i - 1], points[i]);
        for (const other of placed) {
          if (cutsRectangle(points[i - 1], points[i], other)) cost += 65;
          for (let j = 1; j < other.leader.length; j++) if (crosses(points[i - 1], points[i], other.leader[j - 1], other.leader[j])) cost += 24;
        }
      }
      if (!best || cost < best.cost) best = { points, cost };
    }
    return best;
  }
  function place(items, options = {}) {
    const width = Math.max(1, finite(options.width, 500)), height = Math.max(1, finite(options.height, 500));
    const obstacles = (options.obstacles || []).map(rectangle).filter(r => r.w > 0 && r.h > 0 && r.x < width && r.y < height && r.x + r.w > 0 && r.y + r.h > 0);
    const previous = options.previous;
    const old = id => previous?.get ? (previous.get(id) || previous.get(String(id))) : previous?.[id];
    const normalized = (items || []).map((item, index) => ({ ...item, anchor: { ...item.anchor, x: finite(item.anchor?.x), y: finite(item.anchor?.y) }, w: Math.max(1, finite(item.w, 80)), h: Math.max(1, finite(item.h, 18)), _index: index }));
    const ordered = normalized.slice().sort((a, b) => finite(b.priority) - finite(a.priority) || finite(a.order, a._index) - finite(b.order, b._index) || String(a.id).localeCompare(String(b.id)));
    const fits = (box, placed, gap) => box.x >= -.001 && box.y >= -.001 && box.x + box.w <= width + .001 && box.y + box.h <= height + .001 && !obstacles.some(r => intersect(box, r, 1)) && !placed.some(r => intersect(box, r, gap));
    // Most animation frames merely translate an already-valid arrangement.
    // Preserve its relative geometry in O(n²), avoiding candidate generation and
    // leader-routing searches at 60 FPS. Every rectangle is revalidated against
    // current obstacles, so converging players still trigger a fresh layout.
    if (previous && normalized.length) {
      const translated = [];
      for (const item of ordered) {
        const before = old(item.id);
        if (!before || before.overflow || !before.anchor || Math.abs(before.w - item.w) > .01 || Math.abs(before.h - item.h) > .01 || distance(before.anchor, item.anchor) > 12) break;
        const dx = item.anchor.x - before.anchor.x, dy = item.anchor.y - before.anchor.y;
        const candidate = { ...item, x: before.x + dx, y: before.y + dy, overflow: false };
        if (!fits(candidate, translated, 1)) break;
        candidate.leader = Array.isArray(before.leader) ? before.leader.map(p => ({ x: p.x + dx, y: p.y + dy })) : route(item.anchor, candidate, translated).points;
        translated.push(candidate);
      }
      if (translated.length === normalized.length) return translated.sort((a, b) => a._index - b._index).map(({ _index, ...placement }) => placement);
    }
    function geometricScore(item, box, stable) {
      const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      const target = { x: clamp(item.anchor.x, box.x, box.x + box.w), y: clamp(item.anchor.y, box.y, box.y + box.h) };
      let score = distance(item.anchor, target) + Math.abs(center.x - item.anchor.x) * .13 + (center.y > item.anchor.y ? 4 : 0);
      const before = stable && old(item.id);
      if (before && before.anchor && distance(before.anchor, item.anchor) < 42 && Math.abs(before.w - item.w) < 1 && Math.abs(before.h - item.h) < 1) {
        const shift = Math.hypot(box.x - before.x, box.y - before.y);
        score += shift * .75;
        if (shift < .6) score -= 12;
      }
      return score;
    }
    function candidateScore(item, box, placed, stable = true) {
      const leader = route(item.anchor, box, placed);
      const direct = distance(item.anchor, leader.points.at(-1));
      return { score: geometricScore(item, box, stable) + leader.cost - direct, leader: leader.points };
    }
    function search(item, placed, gap, scan, stable = true, packing = false) {
      if (item.w > width || item.h > height) return null;
      const maxX = width - item.w, maxY = height - item.h, seen = new Set();
      let best = null;
      const add = (x, y) => {
        x = Math.round(clamp(x, 0, maxX) * 2) / 2; y = Math.round(clamp(y, 0, maxY) * 2) / 2;
        const key = `${x},${y}`;
        if (seen.has(key)) return;
        seen.add(key);
        const box = { x, y, w: item.w, h: item.h };
        if (!fits(box, placed, gap)) return;
        // Routing cannot improve on straight-line distance. Reject a worse
        // geometric lower bound before checking every existing leader segment.
        if (!packing && best && geometricScore(item, box, stable) > best.score + .001) return;
        const scored = packing ? { score: y * (width + 1) + x, leader: null } : candidateScore(item, box, placed, stable);
        if (!best || scored.score < best.score - .001 || (Math.abs(scored.score - best.score) < .001 && (y < best.y || (y === best.y && x < best.x)))) best = { ...box, ...scored };
      };
      const before = old(item.id);
      if (stable && !packing && before && !before.overflow && before.anchor && Math.abs(before.w - item.w) < .01 && Math.abs(before.h - item.h) < .01 && distance(before.anchor, item.anchor) <= 12) {
        const translated = { ...item, x: before.x + item.anchor.x - before.anchor.x, y: before.y + item.anchor.y - before.anchor.y, overflow: false };
        if (fits(translated, placed, gap)) {
          translated.leader = route(item.anchor, translated, placed).points;
          return translated;
        }
      }
      if (before && before.anchor) {
        add(before.x, before.y);
        if (distance(before.anchor, item.anchor) < 80) add(before.x + item.anchor.x - before.anchor.x, before.y + item.anchor.y - before.anchor.y);
      }
      add(item.anchor.x - item.w / 2, item.anchor.y - item.h - 13);
      add(item.anchor.x - item.w / 2, item.anchor.y + 13);
      const step = item.h + gap + 4;
      for (let ring = 0; ring < 9; ring++) {
        const radius = 18 + item.h / 2 + ring * step;
        for (let n = 0; n < 16; n++) {
          const angle = -Math.PI / 2 + n * Math.PI / 8;
          add(item.anchor.x + Math.cos(angle) * radius - item.w / 2, item.anchor.y + Math.sin(angle) * radius - item.h / 2);
        }
      }
      if (scan) {
        // Critical edges find exact narrow gaps; the regular sweep also finds
        // free space far from crowded anchor clusters.
        const xs = new Set([0, maxX, clamp(item.anchor.x - item.w / 2, 0, maxX)]), ys = new Set([0, maxY, clamp(item.anchor.y - item.h - 13, 0, maxY)]);
        for (const r of [...obstacles, ...placed]) {
          xs.add(clamp(r.x - item.w - gap - 1, 0, maxX)); xs.add(clamp(r.x + r.w + gap + 1, 0, maxX));
          ys.add(clamp(r.y - item.h - gap - 1, 0, maxY)); ys.add(clamp(r.y + r.h + gap + 1, 0, maxY));
        }
        for (let x = 0; x < maxX; x += 8) xs.add(x);
        for (let y = 0; y < maxY; y += 4) ys.add(y);
        for (const y of ys) for (const x of xs) add(x, y);
      }
      if (!best) return null;
      return { ...item, x: best.x, y: best.y, leader: best.leader || route(item.anchor, best, placed).points, overflow: false };
    }
    function attempt(order, gap, packing = false) {
      const placed = [];
      for (const item of order) {
        const result = search(item, placed, gap, false, !packing, packing) || search(item, placed, gap, true, !packing, packing);
        if (!result) return { placed, complete: false };
        placed.push(result);
      }
      return { placed, complete: true };
    }
    let result = attempt(ordered, 3);
    if (!result.complete) {
      // Repack instead of dropping a label when an earlier greedy choice
      // fragmented a small viewport. Larger labels go first in the last pass.
      for (const pass of [() => attempt(ordered, 0), () => attempt(ordered.slice().sort((a, b) => b.w * b.h - a.w * a.h || a._index - b._index), 0, true)]) {
        const next = pass();
        if (next.complete || next.placed.length > result.placed.length) result = next;
        if (result.complete) break;
      }
    }
    const placedIDs = new Set(result.placed.map(p => p._index));
    let overflowY = height + 4;
    for (const item of ordered) if (!placedIDs.has(item._index)) {
      // Geometrically impossible layouts are explicit, never silently hidden.
      const box = { ...item, x: clamp(item.anchor.x - item.w / 2, 0, Math.max(0, width - item.w)), y: overflowY, overflow: true };
      box.leader = route(item.anchor, box, result.placed).points;
      result.placed.push(box); overflowY += item.h + 3;
    }
    return result.placed.sort((a, b) => a._index - b._index).map(({ _index, ...placement }) => placement);
  }
  window.ReplayLabels = { place };
})();
