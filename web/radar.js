/* Radar geometry stays in world coordinates; labels never move player positions. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const types = {
    smoke: { name: '烟雾弹', color: '#b9c8d3' },
    flash: { name: '闪光弹', color: '#fff1a0' },
    he: { name: '高爆手雷', color: '#ff9565' },
    molotov: { name: '燃烧瓶', color: '#ff9b54' },
    incendiary: { name: '燃烧弹', color: '#ff9b54' },
    fire: { name: '燃烧区域', color: '#ff9b54' },
    decoy: { name: '诱饵弹', color: '#bd9bef' },
    grenade: { name: '道具', color: '#c5d1c8' }
  };
  const validPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  function create({ canvas, getState, onSelect, onUtilitySelect }) {
    const ctx = canvas.getContext('2d');
    let width = 800, height = 600, zoom = 1, camera = { x: 512, y: 512 };
    let imageKey = null, extent = { x: 0, y: 0, w: 1024, h: 1024 };
    let pointer = null, dragging = false, hoveredId = null, hoverPoint = null, hitTargets = [], labelTargets = [], lastDrawTime = null;
    let previousLabels = new Map(), labelView = '', labelTime = null, annotationObstacles = [];
    const tooltip = document.createElement('div');
    tooltip.className = 'radar-tooltip'; tooltip.hidden = true;
    canvas.parentElement.append(tooltip);
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '战术地图：滚轮缩放，拖动平移，点击人物查看详情；加减键缩放，0 复位');
    canvas.style.touchAction = 'none';

    function meta() {
      const s = getState();
      return s.map ? { x: s.map.posX, y: s.map.posY, scale: s.map.scale } : s.bounds || { x: -2560, y: 2560, scale: 5 };
    }
    function transform() {
      const base = Math.max(.01, Math.min((width - 16) / extent.w, (height - 22) / extent.h));
      const scale = base * zoom, m = meta();
      const left = width / 2 - camera.x * scale, top = height / 2 - camera.y * scale;
      return { scale, worldScale: scale / m.scale, left, top,
        point: p => ({ x: left + (p.x - m.x) / m.scale * scale, y: top + (m.y - p.y) / m.scale * scale }),
        inverse: p => ({ x: (p.x - left) / scale, y: (p.y - top) / scale }) };
    }
    function autoExtent() {
      const s = getState(), images = [s.images.upper, s.images.lower].filter(Boolean);
      if (!images.length) { extent = { x: 0, y: 0, w: 1024, h: 1024 }; return; }
      let minX = 1024, minY = 1024, maxX = 0, maxY = 0;
      for (const img of images) {
        const scratch = document.createElement('canvas'); scratch.width = scratch.height = 1024;
        const c = scratch.getContext('2d', { willReadFrequently: true }); c.drawImage(img, 0, 0, 1024, 1024);
        try {
          const pixels = c.getImageData(0, 0, 1024, 1024).data;
          // Exclude transparent/near-black padding, retaining the actual radar artwork.
          for (let y = 0; y < 1024; y += 3) for (let x = 0; x < 1024; x += 3) {
            const i = (y * 1024 + x) * 4;
            if (pixels[i + 3] > 24 && pixels[i] + pixels[i + 1] + pixels[i + 2] > 120) {
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
        } catch { minX = minY = 0; maxX = maxY = 1024; }
      }
      if (maxX > minX && maxY > minY) extent = { x: Math.max(0, minX - 18), y: Math.max(0, minY - 18), w: maxX - minX + 36, h: maxY - minY + 36 };
    }
    function reset() {
      imageKey = getState().images.upper; autoExtent();
      camera = { x: extent.x + extent.w / 2, y: extent.y + extent.h / 2 }; zoom = 1;
      tooltip.hidden = true; hoveredId = null; hoverPoint = null; updateZoom();
      previousLabels.clear();labelView = '';labelTime = null;
    }
    function updateZoom() { if ($('zoom-label')) $('zoom-label').textContent = `${Math.round(zoom * 100)}%`; }
    function zoomAt(factor, anchor = { x: width / 2, y: height / 2 }) {
      if (!getState().data) return;
      const before = transform().inverse(anchor); zoom = clamp(zoom * factor, 1, 8);
      const after = transform().inverse(anchor); camera.x += before.x - after.x; camera.y += before.y - after.y;
      if (zoom === 1) camera = { x: extent.x + extent.w / 2, y: extent.y + extent.h / 2 };
      updateZoom(); draw();
    }
    function resize() {
      const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width; height = rect.height;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); draw();
    }
    function revealPlayer(id) {
      const s = getState(), p = s.data?.frames[s.frameIndex].players.find(p => String(p.id) === id);
      if (!validPoint(p)) return;
      const tr = transform(), pos = tr.point(p);
      if (pos.x < 25 || pos.x > width - 25 || pos.y < 25 || pos.y > height - 25) camera = tr.inverse(pos);
    }
    function focusUtility(id) {
      const u = getState().data?.utilities.find(u => u.id === id);
      if (!u || zoom === 1) return;
      const points = [...(u.path || []), ...(u.detonated ? [u] : [])].filter(validPoint);
      if (!points.length) return;
      const tr = transform(), coords = points.map(p => tr.inverse(tr.point(p)));
      const xs = coords.map(p => p.x), ys = coords.map(p => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const base = tr.scale / zoom;
      zoom = clamp(Math.min(zoom, (width - 100) / Math.max(1, x1 - x0) / base, (height - 100) / Math.max(1, y1 - y0) / base), 1, 8);
      camera = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };updateZoom();
    }
    function otherFloor(p) {
      const s = getState();
      return s.images.lower && Number.isFinite(s.map?.lowerMaxZ) && Number.isFinite(p.z) &&
        (p.z < s.map.lowerMaxZ) !== ($('floor-select').value === 'lower');
    }
    function utilityMatches(u) {
      const s = getState(), f = $('utility-filter')?.value || 'all';
      return (f === 'all' || f === u.type || f === 'molotov' && /incendiary|fire/.test(u.type)) && (!s.selectedId || u.ownerId === s.selectedId || u.id === s.utilityId);
    }
    function icon(p, type, radius = 6, selected = false) {
      const style = types[type] || types.grenade;
      if (selected) {ctx.strokeStyle = style.color;ctx.lineWidth = 1;ctx.beginPath();ctx.roundRect(p.x - radius - 5, p.y - radius - 5, radius * 2 + 10, radius * 2 + 10, 4);ctx.stroke();}
      ctx.save();ctx.shadowColor = '#111';ctx.shadowBlur = 5;
      window.ReplayIcons.draw(ctx, type, p.x, p.y, radius * 2.5, radius * 3, { color: style.color });ctx.restore();
    }
    function glow(x, y, radius, inner, outer = '#ff8a0000') {
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(.1, radius));
      g.addColorStop(0, inner);g.addColorStop(1, outer);ctx.fillStyle = g;
      ctx.beginPath();ctx.arc(x, y, radius, 0, Math.PI * 2);ctx.fill();
    }
    function burst(x, y, radius, rays, phase, color) {
      ctx.fillStyle = color;ctx.beginPath();
      for (let i = 0; i < rays * 2; i++) {
        const a = phase + i * Math.PI / rays, r = radius * (i % 2 ? .24 : 1);
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i) ctx.lineTo(px, py);else ctx.moveTo(px, py);
      }
      ctx.closePath();ctx.fill();
    }
    function flame(x, y, radius, phase) {
      const sway = Math.sin(phase) * radius * .3, h = radius * (1.6 + Math.sin(phase * 1.4) * .25);
      const g = ctx.createLinearGradient(x, y - h, x, y + radius * .4);
      g.addColorStop(0, '#ffb331aa');g.addColorStop(.55, '#ff651bcc');g.addColorStop(1, '#ffcf5499');
      ctx.fillStyle = g;ctx.beginPath();ctx.moveTo(x, y + radius * .45);
      ctx.bezierCurveTo(x - radius * 1.1, y + radius * .2, x - radius * .6, y - radius * .7, x + sway, y - h);
      ctx.bezierCurveTo(x + radius * .2, y - radius * .3, x + radius * 1.1, y - radius * .3, x, y + radius * .45);ctx.fill();
      ctx.fillStyle = '#ffe994dd';ctx.beginPath();ctx.moveTo(x, y + radius * .25);
      ctx.quadraticCurveTo(x - radius * .45, y, x + sway * .3, y - h * .55);
      ctx.quadraticCurveTo(x + radius * .55, y, x, y + radius * .25);ctx.fill();
    }
    function pathAt(path, t) {
      if (!path.length) return null;
      let low = 0, high = path.length - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (path[mid].t <= t) low = mid; else high = mid - 1; }
      const a = path[low], b = path[low + 1];
      if (!b || b.t <= a.t) return a;
      const f = clamp((t - a.t) / (b.t - a.t), 0, 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
    function effect(u, tr, selected) {
      const s = getState(), elapsed = s.t - u.detonate, remaining = Math.max(0, u.end - s.t), p = tr.point(u);
      const style = types[u.type] || types.grenade;
      ctx.save(); ctx.globalAlpha = otherFloor(u) ? .16 : 1;
      if (u.type === 'smoke') {
        // A layered tactical illustration, not the CS2 volumetric simulation.
        const r = Math.max(6, 144 * tr.worldScale) * Math.min(1, .15 + elapsed * 1.8);
        const fade = clamp(remaining / 1.5, 0, 1);ctx.globalAlpha *= fade;
        glow(p.x, p.y, r * 1.12, '#c5cbd8aa', '#a0a6ae00');
        for (let i = 0; i < 13; i++) {
          const a = i * 2.39996 + Math.sin(elapsed * .25 + i) * .07;
          const offset = r * Math.sqrt(i / 13) * .62;
          const x = p.x + Math.cos(a) * offset, y = p.y + Math.sin(a) * offset;
          const size = r * (.45 + .1 * Math.sin(i * 7 + elapsed * .7));
          glow(x, y, size, i % 3 ? '#c8cbd08c' : '#eef0f080', '#aab0b900');
        }
        ctx.strokeStyle = u.team === 3 ? '#529fe8' : '#f0af3f';ctx.lineWidth = 1.6;
        ctx.beginPath();ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(remaining / Math.max(.1, u.end - u.detonate), 0, 1));ctx.stroke();
        ctx.font = '600 11px Segoe UI';ctx.fillStyle = '#ffffffb8';ctx.textAlign = 'center';ctx.textBaseline = 'middle';
        ctx.fillText(`${u.endObserved ? '' : '≈'}${Math.ceil(remaining)}`, p.x, p.y);
      } else if (/molotov|incendiary|fire/.test(u.type)) {
        let fire = null;
        for (const f of u.fireFrames || []) { if (f.t <= s.t) fire = f; else break; }
        const points = fire?.points || [];
        if (points.length) {
          // Render only observed burning cells. An observed empty frame means extinguished.
          points.forEach((q, i) => {if (otherFloor(q)) return;const fp = tr.point(q), r = Math.max(2.5, 27 * tr.worldScale);
            glow(fp.x, fp.y, r * 1.8, '#ff722d75');flame(fp.x, fp.y, r, s.t * 9 + i * 2.4);
          });
        } else if (!fire) {
          // We know the detonation point, but not the missing flame geometry.
          icon(p, u.type, 7, selected);
        }
      } else if (u.type === 'decoy') {
        icon(p, u.type, 6, selected);
        ctx.strokeStyle = '#bc9bef99';ctx.lineWidth = 1.3;
        for (const side of [-1, 1]) for (let i = 0; i < 2; i++) {ctx.beginPath();ctx.arc(p.x, p.y, 10 + i * 5 + (elapsed % .7) * 3, side > 0 ? -.6 : Math.PI - .6, side > 0 ? .6 : Math.PI + .6);ctx.stroke();}
      } else {
        const life = clamp(1 - elapsed / Math.max(.1, u.end - u.detonate), 0, 1);
        ctx.globalAlpha *= life;
        const r = (u.type === 'flash' ? 25 : 21) * (.65 + (1 - life));
        if (u.type === 'flash') {
          glow(p.x, p.y, r * 1.8, '#fffdeab5', '#ffffee00');burst(p.x, p.y, r, 8, 0, '#fff9daa8');burst(p.x, p.y, r * .6, 4, Math.PI / 4, '#ffffff');
        } else {
          glow(p.x, p.y, r * 1.5, '#ff8c32aa');burst(p.x, p.y, r, 9, elapsed * .4, '#f975267e');
          for (let i = 0; i < 9; i++) {const a = i * 2.39996, distance = r * (.7 + (1 - life));glow(p.x + Math.cos(a) * distance, p.y + Math.sin(a) * distance, r * .33, '#6b615688', '#463d3300');}
          burst(p.x, p.y, r * .5, 7, .3, '#ffedb8dd');
        }
      }
      if (selected) {
        ctx.fillStyle = style.color;ctx.font = '10px Segoe UI';ctx.textAlign = 'center';ctx.textBaseline = 'top';
        ctx.fillText(`${u.owner || '未知投掷者'} · ${style.name} ${u.endObserved ? '' : '≈'}${remaining.toFixed(1)}s`, p.x, p.y + 25);
      }
      ctx.restore(); hitTargets.push({ ...p, kind: 'utility', data: u, radius: 12 });
    }
    function drawUtilities(tr, frame) {
      const s = getState(), list = s.data.utilities || [];
      if (!$('show-utilities')?.checked) return;
      if (!list.length) {
        for (const g of frame.grenades || []) { if (!validPoint(g)) continue; icon(tr.point(g), g.type); }
        return;
      }
      for (const u of list) {
        if (u.round !== frame.round || !utilityMatches(u)) continue;
        const selected = u.id === s.utilityId;
        const flight = s.t >= u.start && s.t < (u.detonated ? u.detonate : u.end);
        const active = u.detonated && s.t >= u.detonate && s.t < u.end;
        if (!flight && !active && !selected) continue;
        const style = types[u.type] || types.grenade, path = u.path || [];
        if ($('show-utility-paths')?.checked && path.length && (flight || selected)) {
          ctx.save();ctx.strokeStyle = style.color;ctx.lineWidth = selected ? 2 : 1.3;
          ctx.globalAlpha = otherFloor(path[0]) ? .15 : selected ? .95 : .55;
          let prev = null;
          for (const q of path) {
            if (q.t > s.t && !selected) break;
            const p = tr.point(q);
            if (prev) {ctx.setLineDash(q.t > s.t ? [3, 5] : []);ctx.beginPath();ctx.moveTo(prev.x, prev.y);ctx.lineTo(p.x, p.y);ctx.stroke();}
            if (q.bounce) {ctx.fillStyle = style.color;ctx.fillRect(p.x - 2, p.y - 2, 4, 4);}
            prev = p;
          }
          ctx.restore();
        }
        if (active && $('show-effects')?.checked) effect(u, tr, selected);
        else if (selected && u.detonated && validPoint(u)) {
          const p = tr.point(u);ctx.save();ctx.globalAlpha = .6;icon(p, u.type, 7, true);ctx.restore();
          ctx.font = '10px Microsoft YaHei';ctx.fillStyle = style.color;ctx.textAlign = 'center';
          ctx.fillText(s.t < u.detonate ? '爆点预览 · 虚线为后续轨迹' : active ? '爆点 · 特效已隐藏' : '爆点 · 效果已结束', p.x, p.y + 20);
          hitTargets.push({ ...p, kind: 'utility', data: u, radius: 12 });
        }
        if (flight) {
          const q = pathAt(path, s.t);if (!q) continue;
          const p = tr.point(q);ctx.save();ctx.globalAlpha = otherFloor(q) ? .25 : 1;icon(p, u.type, selected ? 8 : 6, selected);
          ctx.font = '10px Segoe UI';ctx.textAlign = 'center';ctx.fillStyle = style.color;
          if (selected || $('show-names')?.checked) ctx.fillText(u.owner || s.players.get(u.ownerId)?.name || '未知投掷者', p.x, p.y - 15);ctx.restore();
          if (selected || $('show-names')?.checked) {
            const text = u.owner || s.players.get(u.ownerId)?.name || '未知投掷者';ctx.font = '10px Segoe UI';
            const w = ctx.measureText(text).width + 6;annotationObstacles.push({x:p.x-w/2,y:p.y-27,w,h:14});
          }
          hitTargets.push({ ...p, kind: 'utility', data: u, radius: 12 });
        }
        if (selected && path.length) {
          const origin = tr.point(path[0]);ctx.strokeStyle = style.color;ctx.lineWidth = 1.5;ctx.beginPath();ctx.arc(origin.x, origin.y, 5, 0, Math.PI * 2);ctx.stroke();
          ctx.font = '11px Microsoft YaHei';ctx.textAlign = 'left';ctx.fillStyle = style.color;
          ctx.fillText(`${u.owner || '未知投掷者'} · ${style.name}`, origin.x + 8, origin.y - 9);
        }
      }
    }
    function drawTrails(tr, frame) {
      const s = getState(), startT = s.t - 3, starts = new Map();
      for (let i = Math.max(0, s.frameIndex - 60); i <= s.frameIndex; i += 2) {
        const past = s.data.frames[i]; if (past.round !== frame.round || past.t < startT) continue;
        for (const p of past.players || []) {
          const id = String(p.id); if (!p.alive || !validPoint(p) || p.connected === false) { starts.delete(id);continue; }
          if (s.selectedId && id !== s.selectedId) continue;
          const pos = tr.point(p), prev = starts.get(id);
          if (prev && Math.hypot(p.x - prev.wx, p.y - prev.wy) < 400) {
            ctx.strokeStyle = p.team === 3 ? '#75b9ef77' : '#efb76b77';ctx.lineWidth = s.selectedId ? 2 : 1;
            ctx.beginPath();ctx.moveTo(prev.x, prev.y);ctx.lineTo(pos.x, pos.y);ctx.stroke();
          }
          starts.set(id, { ...pos, wx: p.x, wy: p.y });
        }
      }
    }
    function drawKills(tr, frame) {
      if (!$('show-kill-lines')?.checked) return;
      const s = getState();
      for (const e of s.data.killEvents || []) {
        if (e.t > s.t || s.t - e.t > 2.5 || (e.round && e.round !== frame.round) || !validPoint(e.killerPos) || !validPoint(e.victimPos)) continue;
        const a = tr.point(e.killerPos), b = tr.point(e.victimPos);
        ctx.save();ctx.globalAlpha = (1 - (s.t - e.t) / 2.5) * (otherFloor(e.victimPos) ? .2 : .8);
        ctx.strokeStyle = e.killerTeam === 3 ? '#75b9ef' : '#efb76b';ctx.lineWidth = 1.5;ctx.setLineDash([5, 4]);
        ctx.beginPath();ctx.moveTo(a.x, a.y);ctx.lineTo(b.x, b.y);ctx.stroke();ctx.setLineDash([]);
        ctx.strokeStyle = '#ff8d8d';ctx.beginPath();ctx.arc(b.x, b.y, 9, 0, Math.PI * 2);ctx.stroke();ctx.restore();
      }
    }
    function interpolatedPlayers() {
      const s = getState(), a = s.data.frames[s.frameIndex], b = s.data.frames[Math.min(s.frameIndex + 1, s.data.frames.length - 1)];
      const f = b.t > a.t ? clamp((s.t - a.t) / (b.t - a.t), 0, 1) : 0;
      const following = new Map((b.players || []).map(p => [p.id, p]));
      return (a.players || []).map(p => {
        const n = following.get(p.id);
        if (!n || !p.alive || !n.alive || a.round !== b.round || b.t - a.t > 1 || Math.hypot(n.x - p.x, n.y - p.y) > 400) return p;
        return { ...p, x: p.x + (n.x - p.x) * f, y: p.y + (n.y - p.y) * f, z: p.z + (n.z - p.z) * f, yaw: p.yaw + (((n.yaw - p.yaw + 540) % 360) - 180) * f };
      });
    }
    function drawPlayers(tr) {
      const s = getState(), radius = Number($('marker-size')?.value) || 6;
      const round = s.data.frames[s.frameIndex].round, deaths = new Map();
      for (const e of s.data.killEvents || []) if (e.round === round && e.t <= s.t && validPoint(e.victimPos)) deaths.set(String(e.victimId), e);
      const players = interpolatedPlayers().map(p => !p.alive && deaths.has(String(p.id)) ? { ...p, ...deaths.get(String(p.id)).victimPos } : p)
        .filter(p => validPoint(p) && p.connected !== false && (p.x || p.y));
      // Dead entities can disappear or disconnect. The observed death marker
      // and name belong to this round and should survive either condition.
      const present = new Set(players.map(p => String(p.id)));
      for (const [id, e] of deaths) if (!present.has(id)) players.push({id, ...e.victimPos, name:e.victim, team:e.victimTeam || s.players.get(id)?.team, alive:false, hp:0});
      const labels = [], obstacles = [...annotationObstacles];
      const visible = players.map(p => ({p, pos:tr.point(p), id:String(p.id)})).filter(({pos}) => pos.x >= 0 && pos.x <= width && pos.y >= 0 && pos.y <= height);
      const view = `${round}:${$('floor-select').value}:${width}:${height}:${tr.scale.toFixed(4)}`;
      if (view !== labelView || labelTime !== null && (s.t < labelTime || s.t - labelTime > .75)) previousLabels.clear();
      labelView = view;labelTime = s.t;
      // Only the marker radius adapts to crowding. World/screen centers remain exact.
      for (const item of visible) {
        const nearest = Math.min(Infinity, ...visible.filter(other => other !== item).map(other => Math.hypot(item.pos.x - other.pos.x, item.pos.y - other.pos.y)));
        item.radius = Math.max(2.2, Math.min(radius, (nearest - 1.5) / 2));
        item.crowded = nearest < radius * 2 + 7;
        item.selected = item.id === s.selectedId || item.id === hoveredId;
        obstacles.push({x:item.pos.x-radius-4,y:item.pos.y-radius-4,w:radius*2+8,h:radius*2+8});
      }
      visible.sort((a,b) => Number(a.selected)-Number(b.selected));
      for (const {p, pos, id, radius:r, crowded, selected} of visible) {
        const color = p.team === 3 ? '#529fe8' : '#f0af3f', dim = otherFloor(p);
        ctx.save();ctx.globalAlpha = dim ? .22 : s.selectedId && !selected ? .5 : 1;
        ctx.translate(pos.x, pos.y);
        if (!p.alive) {
          ctx.strokeStyle = color;ctx.lineWidth = 1;ctx.beginPath();ctx.moveTo(-3, -3);ctx.lineTo(3, 3);ctx.moveTo(3, -3);ctx.lineTo(-3, 3);ctx.stroke();
        } else {
          const yaw = -(p.yaw || 0) * Math.PI / 180;
          ctx.rotate(yaw);ctx.fillStyle = color;ctx.globalAlpha *= crowded ? .05 : .15;ctx.beginPath();ctx.moveTo(0, 0);ctx.arc(0, 0, selected ? 25 : crowded ? 10 : 19, -.34, .34);ctx.closePath();ctx.fill();
          ctx.globalAlpha = dim ? .22 : s.selectedId && !selected ? .5 : 1;
          ctx.beginPath();ctx.moveTo(r + 1, -1.5);ctx.lineTo(r + (crowded ? 3 : 6), 0);ctx.lineTo(r + 1, 1.5);ctx.closePath();ctx.fill();ctx.rotate(-yaw);
          ctx.fillStyle = color;ctx.strokeStyle = '#111';ctx.lineWidth = crowded ? 1 : 1.1;ctx.beginPath();ctx.arc(0, 0, r, 0, Math.PI * 2);ctx.fill();ctx.stroke();
          ctx.fillStyle = '#ffffffdd';ctx.beginPath();ctx.arc(0, 0, Math.max(.8,r * .3), 0, Math.PI * 2);ctx.fill();
          if (!crowded && p.hp < 100) {ctx.strokeStyle = color;ctx.lineWidth = 1.5;ctx.beginPath();ctx.arc(0, 0, r + 2, -.5 * Math.PI, (-.5 + 2 * clamp(p.hp / 100, 0, 1)) * Math.PI);ctx.stroke();}
          if (!crowded && p.flash > .1) {ctx.strokeStyle = '#fffde5';ctx.lineWidth = 2;ctx.beginPath();ctx.arc(0, 0, r + 5, 0, Math.PI * 2);ctx.stroke();}
        }
        ctx.restore();hitTargets.push({ ...pos, radius: Math.max(r + 3, 6), kind: 'player', data: p });
        if ($('show-names').checked || $('map-guns')?.checked && p.alive || selected) labels.push({ pos, p, selected, color, dim });
      }
      const items = labels.map(label => {
        const {pos,p,selected} = label;
        const id = String(p.id), name = s.players.get(id)?.name || p.name || '玩家';
        const showName = $('show-names').checked || selected, showGun = p.alive && p.weapon && $('map-guns')?.checked;
        ctx.font = '500 10px Segoe UI, Microsoft YaHei';
        let text = name;while (text.length > 1 && ctx.measureText(text).width > 86) text = text.slice(0,-1);
        if (text !== name) text = text.slice(0,-1) + '…';
        const nameWidth = showName ? ctx.measureText(text).width + 6 : 0, gunWidth = showGun ? 38 : 0;
        return {...label,id,anchor:pos,showName,showGun,text,nameWidth,gunWidth,w:22+nameWidth+gunWidth,h:19,order:s.slots.get(id)||0};
      });
      const placements = window.ReplayLabels.place(items, {width,height,obstacles,previous:previousLabels});
      previousLabels = new Map(placements.map(b => [b.id,b]));
      const byId = new Map(items.map(item => [item.id,item]));
      // Connectors sit below the whole label layer, never through somebody's name/gun.
      for (const b of placements) {
        const item = byId.get(b.id), {selected,color,dim,pos} = item;
        ctx.save();ctx.globalAlpha = dim ? .3 : s.selectedId && !selected ? .35 : 1;
        ctx.beginPath();ctx.moveTo(pos.x,pos.y);for (const point of b.leader.slice(1)) ctx.lineTo(point.x,point.y);
        ctx.strokeStyle = '#161616dd';ctx.lineWidth = selected ? 4 : 2.5;ctx.stroke();
        ctx.strokeStyle = selected ? '#f4f8ff' : color+'bb';ctx.lineWidth = selected ? 1.6 : .8;ctx.stroke();ctx.restore();
      }
      for (const b of placements) {
        const {p,pos,selected,color,dim,showName,showGun,text,nameWidth} = byId.get(b.id);
        labelTargets.push({...b,id:b.id});
        ctx.save();ctx.globalAlpha = dim ? .4 : s.selectedId && !selected ? .65 : 1;
        ctx.fillStyle = selected ? '#303940f5' : '#191d21ee';ctx.strokeStyle = selected ? '#f5f8ff' : p.alive ? color+'bb' : '#777a';ctx.lineWidth = selected ? 1.4 : .7;
        ctx.beginPath();ctx.roundRect(b.x,b.y,b.w,b.h,4);ctx.fill();ctx.stroke();
        ctx.fillStyle = p.alive ? color : '#999';ctx.font = 'bold 9px Segoe UI';ctx.textAlign = 'center';ctx.textBaseline = 'middle';ctx.fillText(String(s.slots.get(b.id)||'·'),b.x+10,b.y+b.h/2);
        ctx.fillStyle = p.alive ? '#edf2f6' : '#a4a9af';ctx.font = '500 10px Segoe UI, Microsoft YaHei';ctx.textAlign = 'left';
        if (showName) ctx.fillText(text,b.x+21,b.y+b.h/2);
        if (showGun) window.ReplayIcons.draw(ctx,p.weapon,b.x+21+nameWidth+17,b.y+b.h/2,33,12,{color:'#dce3e9'});
        ctx.restore();
      }
      // Draw the exact selected/hovered coordinate last, even for identical positions.
      for (const {pos,selected,radius:r,p} of visible) if (selected) {
        ctx.save();ctx.strokeStyle = '#fff';ctx.lineWidth = 1.4;ctx.beginPath();ctx.arc(pos.x,pos.y,r+3,0,Math.PI*2);ctx.stroke();
        ctx.fillStyle = p.team === 3 ? '#529fe8' : '#f0af3f';ctx.beginPath();ctx.arc(pos.x,pos.y,1.3,0,Math.PI*2);ctx.fill();ctx.restore();
      }
    }
    function drawShots(tr, frame) {
      if (!$('show-shots')?.checked) return;
      const s = getState(), shots = s.data.shots || [], life = .15;
      let lo = 0, hi = shots.length;
      while (lo < hi) {const mid = (lo + hi) >>> 1;if (shots[mid].t < s.t - life) lo = mid + 1;else hi = mid;}
      for (let i = lo; i < shots.length && shots[i].t <= s.t; i++) {
        const shot = shots[i];if (shot.round !== frame.round || !validPoint(shot)) continue;
        const p = tr.point(shot), fade = clamp(1 - (s.t - shot.t) / life, 0, 1), radius = Number($('marker-size')?.value) || 6;
        ctx.save();ctx.globalAlpha = (otherFloor(shot) ? .15 : 1) * fade;
        ctx.translate(p.x, p.y);ctx.rotate(-(shot.yaw || 0) * Math.PI / 180);
        const x = radius + 7;glow(x, 0, 19, '#ffa338c0');
        burst(x + 2, 0, 11 * (.6 + fade * .4), 5, 0, '#ffb13fee');
        burst(x, 0, 6, 4, 0, '#fff4d1');ctx.restore();
      }
    }
    function drawBomb(tr, frame) {
      const b = frame.bomb;if (!validPoint(b) || b.state === 'carried') return;
      const s = getState(), p = tr.point(b);ctx.save();ctx.globalAlpha = otherFloor(b) ? .25 : 1;
      if (b.state === 'planted') glow(p.x, p.y, 20 + Math.sin(s.t * 7) * 3, '#ff5c3055', '#ff5c3000');
      window.ReplayIcons.draw(ctx, 'c4', p.x, p.y, 21, 23, {color:b.state === 'planted' ? '#ff6940' : '#e6cb72'});
      ctx.font = 'bold 9px Segoe UI';ctx.textAlign = 'center';ctx.fillStyle = '#f4f8e9';
      const planted = (s.data.events || []).findLast(e => e.type === 'bomb_planted' && e.t <= s.t && (!e.round || e.round === frame.round));
      const label = b.state === 'planted' ? `C4 · 已下包 ${Math.floor(s.t - (planted?.t ?? s.t))}s` : b.state === 'defused' ? 'C4 已拆除' : b.state === 'exploded' ? 'C4 已爆炸' : 'C4';
      ctx.fillText(label, p.x, p.y + 19);ctx.restore();
    }
    function draw() {
      if (!width || !height) return;
      const s = getState();ctx.clearRect(0, 0, width, height);ctx.fillStyle = '#1d1d1d';ctx.fillRect(0, 0, width, height);
      if (!s.data) return;
      if (lastDrawTime !== null && (s.t < lastDrawTime || s.t-lastDrawTime > .75)) {tooltip.hidden = true;hoveredId = null;hoverPoint = null;}
      lastDrawTime = s.t;
      if (imageKey !== s.images.upper) reset();
      const tr = transform(), frame = s.data.frames[s.frameIndex];if (!frame) return;
      hitTargets = [];labelTargets = [];annotationObstacles = [];
      const image = s.images[$('floor-select').value] || s.images.upper;
      if (image) {ctx.save();ctx.filter = 'grayscale(1) brightness(.68)';ctx.drawImage(image, tr.left, tr.top, 1024 * tr.scale, 1024 * tr.scale);ctx.restore();}
      else {
        ctx.strokeStyle = '#2b3739';ctx.lineWidth = 1;ctx.beginPath();
        const gap = 64 * tr.scale;
        for (let x = tr.left % gap; x < width; x += gap) {ctx.moveTo(x, 0);ctx.lineTo(x, height);}
        for (let y = tr.top % gap; y < height; y += gap) {ctx.moveTo(0, y);ctx.lineTo(width, y);}
        ctx.stroke();
      }
      if ($('show-trails').checked) drawTrails(tr, frame);
      drawUtilities(tr, frame);drawKills(tr, frame);drawShots(tr, frame);drawBomb(tr, frame);
      if (validPoint(frame.bomb) && frame.bomb.state !== 'carried') {const bp=tr.point(frame.bomb);annotationObstacles.push({x:bp.x-35,y:bp.y-15,w:70,h:38});}
      drawPlayers(tr);
      if (hoverPoint && !pointer) showTooltip(hoverPoint);
    }
    function eventPoint(e) { const r = canvas.getBoundingClientRect();return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function nearby(p) { return hitTargets.filter(h => Math.hypot(h.x - p.x, h.y - p.y) <= h.radius).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)); }
    function labelAt(p) {return labelTargets.find(b => p.x >= b.x && p.x <= b.x+b.w && p.y >= b.y && p.y <= b.y+b.h);}
    function showTooltip(p) {
      const s = getState(), label = labelAt(p), hits = label ? hitTargets.filter(h => h.kind === 'player' && String(h.data.id) === label.id) : nearby(p);
      hoveredId = hits.find(h => h.kind === 'player') ? String(hits.find(h => h.kind === 'player').data.id) : null;
      if (!hits.length) {tooltip.hidden = true;return;}
      tooltip.replaceChildren();
      for (const h of hits.slice(0, 8)) {
        const line = document.createElement('div'), d = h.data;
        line.textContent = h.kind === 'player' ? `#${s.slots.get(String(d.id)) || '?'} ${s.players.get(String(d.id))?.name || '玩家'} · ${d.alive ? `${d.hp} HP · ${d.weapon || '—'}` : '已阵亡'}${otherFloor(d) ? ' · 另一楼层' : ''}` : `${types[d.type]?.name || '道具'} · ${d.owner || '未知投掷者'}${otherFloor(d) ? ' · 另一楼层' : ''}`;
        tooltip.append(line);
      }
      if (hits.length > 1) {const note = document.createElement('small');note.textContent = '此处多人靠近；点击独立标签或重复点击可切换，滚轮可放大。人物坐标始终不变。';tooltip.append(note);}
      tooltip.hidden = false;tooltip.style.left = `${clamp(p.x + 14, 8, Math.max(8, width - 300))}px`;tooltip.style.top = `${clamp(p.y + 18, 8, Math.max(8, height - tooltip.offsetHeight - 10))}px`;
    }
    canvas.addEventListener('wheel', e => {if (!getState().data) return;e.preventDefault();zoomAt(Math.exp(-e.deltaY * .0015), eventPoint(e));tooltip.hidden = true;}, { passive: false });
    canvas.addEventListener('pointerdown', e => {if (!getState().data || e.button !== 0) return;pointer = { ...eventPoint(e), cx: camera.x, cy: camera.y, id: e.pointerId };dragging = false;canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove', e => {
      const p = eventPoint(e);
      if (pointer) {
        const dx = p.x - pointer.x, dy = p.y - pointer.y;
        if (Math.hypot(dx, dy) > 4) dragging = true;
        if (dragging) {const scale = transform().scale;camera.x = pointer.cx - dx / scale;camera.y = pointer.cy - dy / scale;tooltip.hidden = true;canvas.style.cursor = 'grabbing';draw();}
      } else {hoverPoint = p;canvas.style.cursor = labelAt(p) || nearby(p).length ? 'pointer' : 'grab';showTooltip(p);}
    });
    canvas.addEventListener('pointerup', e => {
      if (!pointer) return;
      if (!dragging) {
        const p = eventPoint(e), s = getState(), label = labelAt(p), hits = nearby(p);
        const current = hits.findIndex(h => h.kind === 'player' ? String(h.data.id) === s.selectedId : h.data.id === s.utilityId);
        const next = hits[(current + 1) % hits.length];
        if (label) onSelect(label.id);
        else if (next?.kind === 'player') onSelect(String(next.data.id));
        else if (next) onUtilitySelect(next.data.id);
        else onSelect(null);
      }
      pointer = null;dragging = false;canvas.style.cursor = 'grab';
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointercancel', () => { pointer = null;dragging = false; });
    canvas.addEventListener('pointerleave', () => {tooltip.hidden = true;hoveredId = null;hoverPoint = null;});
    canvas.addEventListener('dblclick', e => zoomAt(1.7, eventPoint(e)));
    canvas.addEventListener('keydown', e => {if (e.key === '+' || e.key === '=') zoomAt(1.25);else if (e.key === '-') zoomAt(.8);else if (e.key === '0') reset();else return;e.preventDefault();});
    $('zoom-in')?.addEventListener('click', () => zoomAt(1.3));
    $('zoom-out')?.addEventListener('click', () => zoomAt(1 / 1.3));
    $('zoom-reset')?.addEventListener('click', () => {reset();draw();});
    return { draw, resize, reset, revealPlayer, focusUtility };
  }
  window.ReplayRadar = { create };
})();
