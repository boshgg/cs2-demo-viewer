'use strict';

(() => {
  const phases = new Map([['opening', '开局 0–20 秒'], ['mid', '中期 20–60 秒'], ['late', '后期 60 秒以后'], ['unknown', '时间未知']]);
  const metrics = [
    ['存活停留', '秒', 3, '#63e2d2'], ['交火参与', '次', 4, '#ffbd6d'],
    ['死亡位置', '次', 5, '#ff8197'], ['击杀位置', '次', 6, '#95da84'],
    ['开火位置', '次', 7, '#ffd47c'], ['道具位置', '次', 8, '#bea2ff']
  ];
  const maps = new Map(), images = new Map();
  const number = n => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function getMap(name) {
    if (!maps.has(name)) maps.set(name, fetch('/api/maps/' + encodeURIComponent(name))
      .then(r => r.ok ? r.json() : null).catch(() => { maps.delete(name); return null; }));
    return maps.get(name);
  }
  function background(path) {
    if (!path || !/^\/maps\/[\w.-]+\.png$/.test(path)) return Promise.resolve(null);
    if (!images.has(path)) images.set(path, new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => { images.delete(path); resolve(null); };
      image.src = path;
    }));
    return images.get(path);
  }
  function choices(select, rows, preferred) {
    const previous = select.value;
    select.replaceChildren(...rows.map(([value, label]) => new Option(label, String(value))));
    const values = rows.map(([v]) => String(v));
    select.value = values.includes(previous) ? previous : values.includes(preferred) ? preferred : (values[0] || '');
    select.disabled = rows.length <= 1;
  }
  function figure(container) {
    const wrapper = element('figure', null, 'spatial-figure');
    const canvas = element('canvas');
    canvas.width = 900; canvas.height = 650;
    canvas.setAttribute('role', 'img');
    const foot = element('figcaption', null, 'spatial-footer');
    const summary = element('span', '', 'hint'), download = element('button', '保存 PNG');
    download.type = 'button'; download.disabled = true;
    download.addEventListener('click', () => {
      canvas.toBlob(blob => {
        if (!blob) { summary.textContent = '未能导出图片，请重试。'; return; }
        const url = URL.createObjectURL(blob), link = element('a');
        link.href = url; link.download = 'CS2-复盘图.png'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }, 'image/png');
    });
    foot.append(summary, download); wrapper.append(canvas, foot); container.append(wrapper);
    return { canvas, ctx: canvas.getContext('2d'), summary, download };
  }
  function label(ctx, text, x, y, size = 16, color = '#ced8dc', max = 850) {
    ctx.font = size + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = color; ctx.fillText(String(text), x, y, max);
  }
  function title(plot, heading, detail) {
    const { ctx, canvas } = plot;
    ctx.fillStyle = '#121920'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    label(ctx, heading, 20, 33, 23, '#eef5f4'); label(ctx, detail, 20, 59, 15);
    canvas.setAttribute('aria-label', heading + '。' + detail);
  }
  function statChart(container, report) {
    const players = (report.players || []).filter(p => Number.isFinite(p.recordedKills) && Number.isFinite(p.recordedDeaths))
      .sort((a, b) => b.recordedKills - a.recordedKills).slice(0, 10);
    if (!players.length) { container.append(element('p', '这组录像缺少可绘图的位置和选手统计。', 'hint')); return; }
    const plot = figure(container), { ctx, canvas } = plot;
    canvas.height = 115 + players.length * 37;
    title(plot, '选手击杀与死亡' + (report.synthetic ? ' · 合成示例' : ''), '所选比赛 · 按记录击杀排序，最多列出十名选手');
    const max = Math.max(1, ...players.flatMap(p => [p.recordedKills, p.recordedDeaths]));
    players.forEach((p, i) => {
      const y = 83 + i * 37;
      label(ctx, p.name || p.id, 20, y + 12, 15, '#eef5f4', 185);
      ctx.fillStyle = '#63e2d2'; ctx.fillRect(215, y, 490 * p.recordedKills / max, 7);
      ctx.fillStyle = '#ff8197'; ctx.fillRect(215, y + 10, 490 * p.recordedDeaths / max, 7);
      label(ctx, p.recordedKills + ' 杀 / ' + p.recordedDeaths + ' 死', 730, y + 12, 15);
    });
    plot.summary.textContent = '该范围缺少可用空间记录。绿色为击杀，粉色为死亡。';
    plot.download.disabled = false;
  }
  // A missing calibrated radar gets an equal-scale world-coordinate grid.
  function projection(map, points, cellSize) {
    if (map && map.scale > 0 && Number.isFinite(map.posX) && Number.isFinite(map.posY))
      return [map.posX, map.posY, map.scale * (map.radarSize || 1024)];
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = xs.length ? Math.min(...xs) : 0, minY = ys.length ? Math.min(...ys) : 0;
    const maxX = xs.length ? Math.max(...xs) : minX, maxY = ys.length ? Math.max(...ys) : minY;
    const span = Math.max(maxX - minX, maxY - minY, cellSize) + cellSize * 2;
    return [(minX + maxX - span) / 2, (minY + maxY + span) / 2, span];
  }
  function draw(plot, settings) {
    const { group, map, image, metric, floor, player, synthetic, cellSize, landmarks, moves, snapshot } = settings;
    const [name, unit, column, color] = metric;
    const side = group.side === 3 ? 'CT' : 'T';
    const detail = [group.map, group.teamName || group.teamId, player, side, phases.get(group.phase) || group.phase,
      floor === 'upper' ? '上层' : floor === 'lower' ? '下层' : ''].filter(Boolean).join(' · ');
    title(plot, (moves ? '开局至中期的主要换位' : name + '分布') + (synthetic ? ' · 合成示例' : ''), detail);
    const ctx = plot.ctx, left = 16, top = 78, size = 536;
    const fitsFloor = z => floor === 'all' || (floor === 'lower') === (z < map.lowerMaxZ);
    const sourceCells = snapshot ? group.openingAt15.cells : group.cells;
    const cells = sourceCells.filter(c => fitsFloor(c[2]) && c[column] > 0).sort((a, b) => b[column] - a[column]);
    // Show only same-floor transitions on a layered map.
    const routes = (group.moves || []).filter(r => fitsFloor(r[2]) && fitsFloor(r[5])).slice().sort((a,b) => b[6] - a[6]);
    const points = [...sourceCells, ...routes, ...routes.map(r => r.slice(3, 6))];
    const [x0, y0, span] = projection(map, points, cellSize);
    const point = (x, y) => [left + (x - x0) * size / span, top + (y0 - y) * size / span];
    ctx.fillStyle = '#203039'; ctx.fillRect(left, top, size, size);
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, size, size); ctx.clip();
    if (image) { ctx.globalAlpha = .85; ctx.drawImage(image, left, top, size, size); ctx.globalAlpha = 1; }
    else {
      ctx.strokeStyle = '#40545c'; ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const d = i * size / 8;
        ctx.beginPath(); ctx.moveTo(left + d, top); ctx.lineTo(left + d, top + size);
        ctx.moveTo(left, top + d); ctx.lineTo(left + size, top + d); ctx.stroke();
      }
    }
    const stamp = (x,y,text,accent) => {
      ctx.fillStyle = '#182026'; ctx.strokeStyle = accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x,y,10,0,Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.textAlign = 'center'; label(ctx, text, x, y+4, 12, '#ffffff', 17); ctx.textAlign = 'left';
    };
    const displayed = (moves ? routes : cells).slice(0, 6);
    const markers = [];
    displayed.slice().reverse().forEach((row, reversed) => {
      const rank = displayed.length - reversed;
      const [x, y] = point(row[0], row[1]);
      if (moves) {
        const [toX, toY] = point(row[3], row[4]), angle = Math.atan2(toY-y, toX-x);
        ctx.strokeStyle = '#ffca78'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(toX, toY); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(toX - 12*Math.cos(angle-.45),toY - 12*Math.sin(angle-.45)); ctx.lineTo(toX,toY);
        ctx.lineTo(toX - 12*Math.cos(angle+.45),toY - 12*Math.sin(angle+.45)); ctx.stroke();
        markers.push({x:x + .57*(toX-x), y:y + .57*(toY-y), rank});
      } else {
        const width = size * cellSize / span;
        ctx.fillStyle = color; ctx.globalAlpha = .18 + .40 * row[column]/displayed[0][column];
        ctx.fillRect(x - width/2, y - width/2, width, width); ctx.globalAlpha = 1;
        markers.push({x,y,rank});
      }
    });
    const placed = [];
    for (const m of markers.reverse()) {
      let px = m.x, py = m.y;
      for (const [dx, dy] of [[0,0],[17,-17],[17,17],[-17,-17],[-17,17],[0,25]]) {
        px = m.x + dx; py = m.y + dy;
        if (placed.every(p => Math.hypot(px-p.x,py-p.y) >= 21)) break;
      }
      if (px !== m.x || py !== m.y) {
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(px,py); ctx.stroke();
      }
      stamp(px,py,m.rank,color);
      placed.push({x:px,y:py});
    }
    for (const mark of landmarks || []) {
      if (mark.map !== group.map || !fitsFloor(mark.z)) continue;
      const [x,y]=point(mark.x,mark.y);
      ctx.lineWidth = 4; ctx.strokeStyle='#14171b'; ctx.font='bold 14px sans-serif';
      ctx.strokeText(mark.site,x+9,y-10); label(ctx,mark.site,x+9,y-10,14,'#ffdd91');
    }
    ctx.restore();
    label(ctx, moves ? '换位次数' : '代表网格', 580, 105, 19, '#eef5f4');
    label(ctx, (group.demoIds || []).length + ' 场 · ' + (snapshot ? '有站位记录的 ' + group.openingAt15.rounds : '本阶段观察到 ' + group.rounds) + ' 回合', 580, 134, 15);
    if (!displayed.length) label(ctx, '此层和指标没有可显示记录', 580, 184, 17);
    displayed.forEach((r, i) => {
      const y = 180 + 66*i;
      label(ctx, (i+1) + '   ' + number(moves ? r[6] : r[column]) + ' ' + unit, 580, y, 19, moves ? '#ffca78' : color);
      label(ctx, moves ? `(${r[0]}, ${r[1]}, ${r[2]}) → (${r[3]}, ${r[4]}, ${r[5]})` : `X ${r[0]}   Y ${r[1]}   Z ${r[2]}`, 580, y+24, 14, '#d5dce0', 302);
    });
    let caption = `按${name}排列的代表网格，单格宽 ${cellSize} 游戏单位。`;
    if (snapshot) caption = '冻结结束后第 15 秒，每位有位置记录的存活选手每回合计一次。';
    if (moves) caption = '箭头连接同一玩家开局与中期的主要停留区。';
    label(ctx,(image ? '校准雷达' : '世界坐标网格') + '  ·  ' + caption,18,638,15);
    plot.summary.textContent = detail + '。' + caption;
    const positions = displayed.map((r,i) => {
      const target = moves ? ` → (${r[3]}, ${r[4]}, ${r[5]})` : '';
      return `第${i+1}位 (${r[0]}, ${r[1]}, ${r[2]})${target}，${number(moves ? r[6] : r[column])}${unit}`;
    });
    plot.canvas.setAttribute('aria-label', name + '。' + plot.summary.textContent + ' ' + positions.join('；'));
    plot.download.disabled = false;
  }
  function render(container, report, scope = {}) {
    const previous = Object.fromEntries(Array.from(container.querySelectorAll('select'), s => [s.id, s.value]));
    container.replaceChildren();
    const spatial = report.spatial, groups = spatial?.groups || [];
    if (!groups.length) { statChart(container, report); return; }
    const controls = element('div', null, 'spatial-controls'); container.append(controls);
    const fields = {};
    for (const [key, text] of Object.entries({map:'地图', team:'战队', side:'阵营', phase:'回合阶段', metric:'图层', floor:'楼层'})) {
      const labelNode = element('label', text), select = element('select');
      select.id = 'spatial-' + key; labelNode.append(select); controls.append(labelNode); fields[key] = select;
      select.addEventListener('change', update);
    }
    function setChoices(key, rows, preferred) {
      choices(fields[key], rows, previous[fields[key].id] || preferred);
    }
    setChoices('map', [...new Set(groups.map(g => g.map))].sort().map(m => [m,m]));
    const plot = figure(container);
    let revision = 0;
    async function update() {
      const token = ++revision;
      plot.download.disabled = true;
      const byMap = groups.filter(g => g.map === fields.map.value);
      const teams = new Map();
      for (const g of byMap) {
        if (!teams.has(g.teamId)) teams.set(g.teamId,{name:g.teamName || g.teamId, matches:new Set()});
        for (const id of g.demoIds || []) teams.get(g.teamId).matches.add(id);
      }
      setChoices('team', [...teams].sort((a,b) => b[1].matches.size-a[1].matches.size || a[1].name.localeCompare(b[1].name)).map(([id,t]) => [id,t.name]), scope.team);
      const byTeam = byMap.filter(g => g.teamId === fields.team.value);
      setChoices('side',[...new Set(byTeam.map(g => g.side))].sort((a,b) => b-a).map(s => [s,s === 3 ? 'CT' : 'T']));
      const bySide = byTeam.filter(g => String(g.side) === fields.side.value);
      setChoices('phase',[...phases].filter(([p]) => bySide.some(g => g.phase === p)));
      const group = bySide.find(g => g.phase === fields.phase.value);
      if (!group) return;
      const layers = metrics.map((m,i) => [i,m[0]]);
      if (group.openingAt15?.cells?.length) layers.unshift(['at15','第 15 秒站位']);
      if (group.moves?.length) layers.push(['moves','开局 → 中期换位']);
      setChoices('metric',layers);
      const map = await getMap(group.map);
      if (revision !== token || !container.contains(plot.canvas)) return;
      const split = map?.lowerRadar && Number.isFinite(map?.lowerMaxZ);
      setChoices('floor', split ? [['upper','上层'],['lower','下层']] : [['all','单层']]);
      fields.floor.parentElement.hidden = !split;
      const image = await background(fields.floor.value === 'lower' ? map.lowerRadar : map?.radar);
      if (revision !== token || !container.contains(plot.canvas)) return;
      const player = scope.playerId && report.players?.find(p => p.id === scope.playerId);
      const layer = fields.metric.value;
      const metric = layer === 'at15' ? ['第 15 秒站位','人次',3,'#68decf'] :
        layer === 'moves' ? ['换位','次',3,'#ffca78'] : metrics[Number(layer)];
      draw(plot,{group,map,image,metric,snapshot:layer === 'at15',
        floor:fields.floor.value,player:player?.name || scope.playerId,synthetic:report.synthetic,
        cellSize:spatial.cellSize,landmarks:spatial.landmarks,moves:fields.metric.value === 'moves'});
    }
    void update();
  }
  function describe(container) {
    if (!container.querySelector('.spatial-footer button:enabled')) return '';
    return container.querySelector('canvas')?.getAttribute('aria-label') || '';
  }
  window.InsightsCharts = { render, describe };
})();
