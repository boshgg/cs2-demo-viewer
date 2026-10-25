(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const info = {
    smoke: { name: '烟雾弹' },
    flash: { name: '闪光弹' },
    he: { name: '高爆手雷' },
    molotov: { name: '燃烧道具' },
    decoy: { name: '诱饵弹' },
    unknown: { name: '未知道具' }
  };
  const cache = { data: null, roundKey: '', rosterKey: '', detailKey: '', liveKey: '', roundButtons: [], selectedId: null, tab: 'kills', kills: [], utilities: [], killRows: [], utilityRows: [], context: null };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const icon = (name, className, title) => window.ReplayIcons.element(name || 'unknown', { className, title });
  function setPanel(name, open) {
    const panel = $(name === 'settings' ? 'settings-panel' : 'review-drawer');
    panel.hidden = !open;
    $(`${name}-toggle`).setAttribute('aria-expanded', String(open));
    if (open) {
      const other = name === 'settings' ? 'review' : 'settings';
      $(other === 'settings' ? 'settings-panel' : 'review-drawer').hidden = true;
      $(`${other}-toggle`).setAttribute('aria-expanded', 'false');
    }
  }
  for (const name of ['settings', 'review']) {
    $(`${name}-toggle`).addEventListener('click', () => setPanel(name, $(`${name}-toggle`).getAttribute('aria-expanded') !== 'true'));
    $(`${name}-close`).addEventListener('click', () => setPanel(name, false));
  }
  document.addEventListener('keydown', event => {
    if (event.code === 'Escape') { setPanel('settings', false); setPanel('review', false); }
  });
  const teamOf = (team) => team === 3 || /^(ct|counter)/i.test(String(team)) ? 'ct' : team === 2 || /^(t|terror)/i.test(String(team)) ? 't' : 'other';
  const fmt = (seconds) => {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  };
  function utilityType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('smoke')) return 'smoke';
    if (t.includes('flash')) return 'flash';
    if (/molotov|incendiary|inferno|fire/.test(t)) return 'molotov';
    if (t === 'he' || /hegrenade|he grenade|high explosive|high-explosive/.test(t)) return 'he';
    if (t.includes('decoy')) return 'decoy';
    return 'unknown';
  }
  function utilityName(type) {
    const raw = String(type || '').toLowerCase();
    if (/incendiary/.test(raw)) return '燃烧弹';
    if (/molotov/.test(raw)) return '燃烧瓶';
    if (/inferno|fire/.test(raw)) return '燃烧区域';
    return info[utilityType(type)].name;
  }
  const meta = (context, id) => context.players instanceof Map ? context.players.get(String(id)) : (Array.isArray(context.players) ? context.players : context.data.players || []).find((p) => String(p.id) === String(id));
  const slot = (context, id) => context.slots instanceof Map ? context.slots.get(String(id)) : context.slots?.[String(id)];
  const playerName = (context, id, fallback) => fallback || meta(context, id)?.name || (id ? '未知玩家' : '环境');
  const inRound = (event, round, timeKey = 't') => {
    if (!round) return true;
    if (Number.isFinite(event.round) && event.round !== round.number) return false;
    const t = Number(event[timeKey]);
    return t >= round.start - 0.001 && t <= (Number.isFinite(round.end) ? round.end : Infinity) + 0.001;
  };
  function rosterPlayers(context) {
    const players = new Map((context.frame.players || []).filter(p => p.connected !== false).map(p => [String(p.id), p]));
    // A player entity can disappear after death or disconnect. Keep only the
    // identity and side established by this round's actual death event; missing
    // equipment and money are deliberately left unknown.
    for (const event of context.data.killEvents || context.data.events || []) {
      if (!/kill|death/i.test(event.type) || !event.victimId || event.t > context.time + .001 || !inRound(event, context.round)) continue;
      const id = String(event.victimId);
      if (players.has(id)) continue;
      players.set(id, { id, name: playerName(context, id, event.victim), team: event.victimTeam || meta(context, id)?.team, alive: false, hp: 0, missingFrame: true });
    }
    return [...players.values()];
  }
  const chip = (type, count = 1, compact = false) => {
    const kind = utilityType(type);
    const node = el('span', `utility-chip utility-${kind}${compact ? ' compact' : ''}`);
    node.append(icon(type, 'utility-icon', utilityName(type)));
    if (!compact) node.append(el('span', '', utilityName(type)));
    if (count > 1) node.append(el('span', 'utility-count', compact ? count : `×${count}`));
    node.title = `${utilityName(type)}${count > 1 ? ` × ${count}` : ''}`;
    return node;
  };
  function inventory(container, items, compact) {
    const valid = Array.isArray(items) ? items.filter((item) => (Number(item.count) || 0) > 0) : [];
    if (!valid.length) return;
    const line = el('div', 'inventory');
    for (const item of valid) line.append(chip(item.type, item.count, compact));
    container.append(line);
  }
  function showTab(tab) {
    cache.tab = tab;
    for (const item of ['kills', 'utilities']) {
      const button = $(`${item}-tab`);
      button.classList.toggle('active', item === tab);
      button.setAttribute('aria-selected', String(item === tab));
    }
    $('kill-feed').hidden = tab !== 'kills';
    $('utility-feed').hidden = tab !== 'utilities';
  }
  for (const button of document.querySelectorAll('[data-review-tab]')) button.addEventListener('click', () => showTab(button.dataset.reviewTab));
  $('utility-filter').addEventListener('change', () => {
    cache.roundKey = '';
    if (cache.context) render(cache.context);
  });
  function renderRoster(context) {
    const list = rosterPlayers(context);
    const signature = JSON.stringify([context.selectedId, context.frame.ctName, context.frame.tName, list.map((p) => [p.id, p.hp, p.armor, p.helmet, p.defuseKit, p.money, p.alive, p.team, p.weapon, p.weapons, p.hasBomb, p.connected, p.ammo, Math.ceil(p.flash || 0), p.inventory])]);
    if (signature === cache.rosterKey) return;
    cache.rosterKey = signature;
    for (const team of ['ct', 't']) {
      const teamPlayers = list.filter((p) => teamOf(p.team) === team && p.connected !== false).sort((a, b) => (slot(context, a.id) || 0) - (slot(context, b.id) || 0));
      $(`alive-${team}`).textContent = `${teamPlayers.filter((p) => p.alive).length} / ${teamPlayers.length}`;
      $(`team-name-${team}`).textContent = context.frame[`${team}Name`] || (team === 'ct' ? '反恐精英' : '恐怖分子');
      const container = $(`roster-${team}`);
      container.replaceChildren();
      if (!teamPlayers.length) container.append(el('div', 'feed-empty', '暂无玩家数据'));
      for (const p of teamPlayers) {
        const selected = String(context.selectedId) === String(p.id);
        const row = el('button', `player-row team-${team}${p.alive ? '' : ' dead'}${selected ? ' selected' : ''}`);
        row.type = 'button';
        row.setAttribute('aria-pressed', String(selected));
        row.setAttribute('aria-label', `查看 ${playerName(context, p.id, p.name)} 的详情`);
        row.addEventListener('click', () => cache.context?.onSelect?.(selected ? null : String(p.id)));
        row.style.setProperty('--health', `${Math.max(0, Math.min(100, Number(p.hp) || 0))}%`);
        const top = el('div', 'player-top');
        const number = el('span', 'player-number', slot(context, p.id) || '·');
        const name = el('span', 'player-name', playerName(context, p.id, p.name));
        name.title = name.textContent;
        top.append(number, name);
        if (p.alive && p.flash > 0.1) top.append(icon('flashbang', 'player-gear-icon', `致盲 ${p.flash.toFixed(1)} 秒`));
        top.append(el('span', 'player-money', Number.isFinite(p.money) ? `$${p.money}` : '—'));
        const health = el('span', 'player-health', p.alive ? p.hp || 0 : '×');
        health.title = p.alive ? `生命 ${p.hp || 0} / 100` : '已阵亡';
        top.append(health);
        const equipment = el('div', 'player-loadout');
        const armor = el('span', 'player-armor');
        armor.title = `护甲 ${p.armor || 0}${p.helmet ? ' · 头盔' : ''}`;
        if (p.armor > 0 || p.helmet) { armor.append(icon(p.helmet ? 'armorhelmet' : 'armor', 'player-gear-icon', armor.title)); armor.append(el('span', '', p.armor || 0)); }
        equipment.append(armor);
        const weapons = Array.isArray(p.weapons) && p.weapons.length ? p.weapons.filter(w => ['primary', 'secondary', 'equipment'].includes(w.slot)) : (p.weapon ? [{ name: p.weapon, slot: 'equipment', active: true }] : []);
        const guns = el('div', 'player-guns');
        for (const weapon of weapons.slice(0, 3)) {
          const active = weapon.active || window.ReplayIcons.key(weapon.name) === window.ReplayIcons.key(p.weapon);
          const gun = el('span', `loadout-weapon ${weapon.slot}${active ? ' active' : ''}`);
          gun.append(icon(weapon.name, 'weapon-icon', `${active ? '当前持有 · ' : ''}${weapon.name}`)); guns.append(gun);
        }
        equipment.append(guns);
        if (p.alive && Number.isFinite(p.ammo) && p.ammo >= 0) equipment.append(el('span', 'player-ammo', p.ammo));
        inventory(equipment, p.inventory, true);
        if (p.defuseKit) equipment.append(icon('kit', 'player-gear-icon', '拆包钳'));
        if (p.hasBomb) equipment.append(icon('c4', 'player-bomb', '携带 C4'));
        row.append(top, equipment); container.append(row);
      }
    }
  }
  function renderDetail(context) {
    const p = rosterPlayers(context).find((item) => String(item.id) === String(context.selectedId));
    const signature = p ? JSON.stringify([p.id, p.hp, p.armor, p.weapon, p.ammo, p.reserve, p.money, p.helmet, p.defuseKit, p.alive, p.missingFrame, p.scoped, p.crouching, Math.ceil(p.flash || 0), p.inventory, p.hasBomb, context.round?.number, Math.floor(context.time)]) : 'empty';
    if (signature === cache.detailKey) return;
    cache.detailKey = signature;
    const container = $('player-detail');
    container.hidden = !p;
    container.replaceChildren();
    if (!p) {
      container.append(el('div', 'section-label', '玩家详情'), el('div', 'feed-empty', '点击地图上的玩家或名单，查看装备、状态与本回合投掷。'));
      return;
    }
    const heading = el('div', 'detail-title');
    const number = el('span', 'player-number', slot(context, p.id) || '·');
    const name = el('strong', `${teamOf(p.team)}-text`, playerName(context, p.id, p.name));
    const close = el('button', 'detail-close', '×');
    close.type = 'button'; close.title = '取消选择玩家'; close.setAttribute('aria-label', '取消选择玩家');
    close.addEventListener('click', () => cache.context?.onSelect?.(null));
    heading.append(number, name, close); container.append(heading);
    const grid = el('div', 'detail-grid');
    const numberOrDash = (value) => Number.isFinite(value) && value >= 0 ? value : '—';
    const kills = (context.data.events || []).filter((e) => /kill|death/i.test(e.type) && e.t <= context.time + 0.001);
    const count = (key) => kills.filter((e) => String(e[key] || '') === String(p.id)).length;
    const stats = [
      ['生命 / 护甲', `${p.alive ? p.hp || 0 : 0} / ${numberOrDash(p.armor)}`],
      ['弹匣 / 备弹', `${numberOrDash(p.ammo)} / ${numberOrDash(p.reserve)}`],
      ['经济', Number.isFinite(p.money) ? `$${p.money.toLocaleString()}` : '—'],
      ['主手武器', p.weapon || '—'],
      ['头盔 / 拆包钳', p.missingFrame ? '— / —' : `${p.helmet ? '有' : '无'} / ${p.defuseKit ? '有' : '无'}`],
      ['K / A / D', `${count('killerId')} / ${count('assisterId')} / ${count('victimId')}`]
    ];
    for (const [label, value] of stats) {
      const stat = el('div', 'detail-stat', label); stat.append(el('strong', '', value)); grid.append(stat);
    }
    container.append(grid);
    const states = [];
    if (!p.alive) states.push('已阵亡');
    if (p.missingFrame) states.push('当前装备数据缺失');
    if (p.alive && p.flash > 0.1) states.push(`致盲 ${Number(p.flash).toFixed(1)} 秒`);
    if (p.scoped) states.push('开镜');
    if (p.crouching) states.push('蹲伏');
    if (p.hasBomb) states.push('携带 C4');
    if (!states.length) states.push('存活');
    container.append(el('div', 'detail-status', states.join(' · ')));
    if (p.missingFrame) container.append(el('div', 'detail-empty', '当前帧没有此玩家实体；姓名与阵营保留自本回合死亡记录，未知装备和经济显示为 —。'));
    container.append(el('div', 'detail-empty', '当前突出此玩家，并筛选其地图道具；点 × 恢复全部。'));
    inventory(container, p.inventory, false);
    const thrown = (context.data.utilities || []).filter((u) => String(u.ownerId) === String(p.id) && inRound(u, context.round, 'start'));
    container.append(el('div', 'detail-utility-title', `本回合投掷 · ${thrown.filter((u) => u.start <= context.time).length} / ${thrown.length}`));
    if (!thrown.length) container.append(el('div', 'detail-empty', '本回合没有投掷记录'));
    for (const u of thrown) {
      const link = el('button', 'detail-utility-link');
      link.type = 'button';
      link.append(chip(u.type), el('span', '', `${u.throwObserved === false ? '首次观测 ' : ''}+${fmt(u.start - (context.round?.start || 0))} →`));
      link.addEventListener('click', () => { cache.context?.onUtilitySelect?.(String(u.id)); cache.context?.onSeek?.(u.start); });
      container.append(link);
    }
  }
  function makeKillRow(event, context) {
    const row = el('button', 'review-kill'); row.type = 'button';
    row.title = '跳到这次击杀前 1.5 秒';
    const t = el('span', 'kill-time', `+${fmt(event.t - (context.round?.start || 0))}`);
    const content = el('div', 'kill-main'), names = el('div', 'kill-names');
    const killer = el('span', `kill-name ${teamOf(event.killerTeam ?? meta(context, event.killerId)?.team)}-text`, playerName(context, event.killerId, event.killer));
    const victim = el('span', `kill-name ${teamOf(event.victimTeam ?? meta(context, event.victimId)?.team)}-text`, playerName(context, event.victimId, event.victim));
    killer.title = killer.textContent; victim.title = victim.textContent;
    names.append(killer, icon(event.weapon, 'kill-weapon-icon', event.weapon || '环境击杀'), victim);
    const details = el('div', 'kill-meta'); details.append(el('span', '', event.weapon || '环境击杀'));
    const flags = [
      [event.headshot, '爆头'], [event.throughSmoke, '穿烟'], [event.penetrated > 0 || event.penetratedObjects > 0, '穿墙'],
      [event.noScope || event.noscope, '盲狙'], [event.attackerBlind, '致盲击杀'], [event.assistedFlash, '闪光助攻']
    ];
    for (const [yes, label] of flags) if (yes) details.append(el('span', 'kill-flag', label));
    if (event.assister || event.assisterId) details.append(el('span', 'kill-assist', `助攻 ${playerName(context, event.assisterId, event.assister)}`));
    content.append(names, details); row.append(t, content);
    row.addEventListener('click', () => {
      cache.context?.onUtilitySelect?.(null);
      cache.context?.onSeek?.(Math.max(context.round?.start || 0, event.t - 1.5));
    });
    return row;
  }
  function makeUtilityRow(u, context) {
    const type = utilityType(u.type);
    const row = el('div', 'utility-event');
    const title = el('div', 'utility-event-title');
    title.append(chip(u.type));
    const owner = el('span', `utility-owner ${teamOf(u.team)}-text`, playerName(context, u.ownerId, u.owner)); owner.title = owner.textContent;
    const map = el('button', 'utility-map-button', '定位'); map.type = 'button';
    map.setAttribute('aria-label', `定位 ${owner.textContent} 的${utilityName(u.type)}`);
    map.addEventListener('click', () => { cache.context?.onUtilitySelect?.(String(u.id)); cache.context?.onSeek?.(u.detonated ? u.detonate : u.start); });
    title.append(owner, map);
    const times = el('div', 'utility-event-times');
    const throwLink = el('button', 'utility-time-link', `${u.throwObserved === false ? '首次观测' : '投掷'} +${fmt(u.start - (context.round?.start || 0))}`); throwLink.type = 'button';
    throwLink.addEventListener('click', () => { cache.context?.onUtilitySelect?.(String(u.id)); cache.context?.onSeek?.(u.start); });
    times.append(throwLink);
    if (u.detonated && Number.isFinite(u.detonate)) {
      const detonateLink = el('button', 'utility-time-link', `${type === 'smoke' ? '成烟' : type === 'molotov' ? '落火' : '爆开'} +${fmt(u.detonate - (context.round?.start || 0))}`); detonateLink.type = 'button';
      detonateLink.addEventListener('click', () => { cache.context?.onUtilitySelect?.(String(u.id)); cache.context?.onSeek?.(u.detonate); });
      times.append(detonateLink);
    }
    const status = el('div', 'utility-event-state');
    row.append(title, times, status);
    if (u.sourceInferred) row.append(el('div', 'utility-event-state', '燃烧来源按时间与位置关联'));
    return { row, status };
  }
  function renderEvents(context) {
    const filter = $('utility-filter').value;
    const key = `${context.round?.index ?? context.round?.number ?? 'all'}:${filter}`;
    if (key !== cache.roundKey) {
      cache.roundKey = key;
      cache.kills = (context.data.events || []).filter((e) => /kill|death/i.test(e.type) && inRound(e, context.round));
      cache.utilities = (context.data.utilities || []).filter((u) => inRound(u, context.round, 'start') && (filter === 'all' || utilityType(u.type) === filter)).sort((a, b) => a.start - b.start);
      cache.killRows = []; cache.utilityRows = [];
      $('kill-feed').replaceChildren(); $('utility-feed').replaceChildren();
      if (!cache.kills.length) $('kill-feed').append(el('div', 'feed-empty', '本回合没有击杀记录'));
      if (!cache.utilities.length) $('utility-feed').append(el('div', 'feed-empty', filter === 'all' ? '本回合没有道具记录' : `本回合没有${info[filter]?.name || '此类道具'}记录`));
      for (const event of cache.kills) { const row = makeKillRow(event, context); cache.killRows.push(row); $('kill-feed').append(row); }
      for (const utility of cache.utilities) { const entry = makeUtilityRow(utility, context); cache.utilityRows.push(entry); $('utility-feed').append(entry.row); }
      const markers = $('round-event-markers');
      markers.replaceChildren();
      if (context.round) {
        const duration = Math.max(0.01, context.round.end - context.round.start);
        const addMarker = (time, className, label) => {
          const marker = el('span', `event-marker ${className}`);
          marker.style.left = `${Math.max(0, Math.min(100, (time - context.round.start) / duration * 100))}%`;
          marker.title = label;
          markers.append(marker);
        };
        if (context.round.freezeEnd > context.round.start) addMarker(context.round.freezeEnd, 'freeze', '冻结阶段结束');
        for (const e of cache.kills) addMarker(e.t, 'kill', `${e.killer || '环境'} → ${e.victim || '玩家'}`);
        for (const u of cache.utilities) if (u.detonated) addMarker(u.detonate, `utility utility-${utilityType(u.type)}`, `${u.owner || '未知玩家'} · ${utilityName(u.type)}爆点`);
      }
    }
    $('round-timeline-label').textContent = context.round ? `第 ${context.round.number} 回合` : '本回合';
    $('round-timeline-time').textContent = context.round ? `${fmt(context.time - context.round.start)} / ${fmt(context.round.end - context.round.start)}` : '00:00 / 00:00';
    const occurred = cache.kills.filter((e) => e.t <= context.time + 0.001).length;
    const thrown = cache.utilities.filter((u) => u.start <= context.time + 0.001).length;
    $('kill-count').textContent = `${occurred}/${cache.kills.length}`;
    $('utility-count').textContent = `${thrown}/${cache.utilities.length}`;
    $('review-round-number').textContent = context.round ? `第 ${context.round.number} 回合` : '全场';
    const phase = context.round?.freezeEnd > context.time ? '冻结阶段' : context.round?.endedAt && context.time >= context.round.endedAt ? '回合结束' : '回合进行中';
    const result = context.round?.winner ? ` · ${teamOf(context.round.winner).toUpperCase()} 获胜` : '';
    $('round-summary').textContent = `${phase} · 已发生 ${occurred} 次击杀${context.round?.endedAt && context.time >= context.round.endedAt ? result : ''}`;
    cache.killRows.forEach((row, i) => {
      row.classList.toggle('future', cache.kills[i].t > context.time + 0.001);
      row.classList.toggle('current', context.time >= cache.kills[i].t && context.time < cache.kills[i].t + 3);
    });
    cache.utilityRows.forEach(({ row, status }, i) => {
      const u = cache.utilities[i], type = utilityType(u.type);
      row.classList.toggle('future', u.start > context.time + 0.001);
      row.classList.toggle('selected', String(context.utilityId) === String(u.id));
      const active = context.time >= u.start && context.time < u.end;
      row.classList.toggle('current', active);
      if (context.time < u.start) status.textContent = '尚未投掷';
      else if (!u.detonated || context.time < u.detonate) status.textContent = context.time >= u.end ? '飞行结束 · 未记录爆点' : '飞行中';
      else if (active && ['smoke', 'molotov', 'decoy'].includes(type)) {
        const latestFire = type === 'molotov' ? u.fireFrames?.findLast(f => f.t <= context.time) : null;
        status.textContent = latestFire && !latestFire.points.length ? '当前未观测到燃烧点' : `${type === 'smoke' ? '烟雾持续' : type === 'molotov' ? '燃烧中' : '诱饵生效'} · ${u.endObserved ? '剩余' : '预计剩余'} ${Math.max(0, u.end - context.time).toFixed(1)} 秒`;
      }
      else status.textContent = '已爆开 / 已结束';
    });
  }
  function renderLiveKills(context) {
    const occurred = cache.kills.filter(e => e.t <= context.time + 0.001).slice(-6);
    const key = `${context.round?.number}:${occurred.map(e => `${e.t}:${e.victimId}`).join('|')}`;
    if (key === cache.liveKey) return;
    cache.liveKey = key;
    $('live-kill-feed').replaceChildren();
    for (const event of occurred) {
      const row = el('button', `live-kill${context.time < event.t + 1 ? ' recent' : ''}`);
      row.type = 'button';
      const killerName = playerName(context, event.killerId, event.killer), victimName = playerName(context, event.victimId, event.victim);
      row.title = `${killerName} ${event.weapon || '击杀'} ${victimName}${event.headshot ? ' · 爆头' : ''} · 点击回看`;
      row.append(el('span', `kill-name ${teamOf(event.killerTeam ?? meta(context, event.killerId)?.team)}-text`, killerName));
      row.append(icon(event.weapon, 'kill-weapon-icon', event.weapon || '环境击杀'));
      if (event.headshot) row.append(icon('headshot', 'headshot-icon', '爆头'));
      if (event.throughSmoke) row.append(icon('smokekill', 'headshot-icon', '穿烟'));
      row.append(el('span', `kill-name ${teamOf(event.victimTeam ?? meta(context, event.victimId)?.team)}-text`, victimName));
      row.addEventListener('click', () => cache.context?.onSeek?.(Math.max(context.round?.start || 0, event.t - 1.5)));
      $('live-kill-feed').append(row);
    }
  }
  function renderRounds(context) {
    if (!cache.roundButtons.length) {
      $('round-strip').replaceChildren();
      for (const round of context.data.rounds || []) {
        const winner = teamOf(round.winner);
        const button = el('button', `round-number${winner !== 'other' ? ` winner-${winner}` : ''}`, String(round.number).padStart(2, '0'));
        button.type = 'button';
        button.setAttribute('aria-label', `第 ${round.number} 回合${winner !== 'other' ? ` · ${winner.toUpperCase()} 获胜` : ''}`);
        button.title = `第 ${round.number} 回合${winner !== 'other' ? ` · ${winner.toUpperCase()} 获胜` : ''}`;
        button.addEventListener('click', () => { cache.context?.onUtilitySelect?.(null); cache.context?.onSeek?.(round.start); });
        $('round-strip').append(button);
        cache.roundButtons.push({ button, round });
      }
    }
    for (const { button, round } of cache.roundButtons) {
      const active = context.round?.number === round.number && Math.abs((context.round?.start || 0) - round.start) < .01;
      const wasActive = button.classList.contains('active');
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'step' : 'false');
      if (active && !wasActive) {
        const strip = $('round-strip');
        const desired = button.offsetLeft - strip.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2;
        strip.scrollLeft = desired;
      }
    }
    const round = context.round, clock = $('round-clock');
    let text = fmt(context.time - (round?.start || 0)), phase = '回合已进行', className = 'match-clock';
    if (round?.freezeEnd > context.time) {
      text = fmt(Math.ceil(round.freezeEnd - context.time)); phase = '冻结时间'; className += ' freeze';
    } else if (round?.endedAt > 0 && context.time >= round.endedAt) {
      text = round.winner ? `${teamOf(round.winner).toUpperCase()} WIN` : 'END'; phase = '回合结束'; className += ' ended';
    } else if (context.frame.bomb?.state === 'planted') {
      const planted = (context.data.events || []).findLast(e => e.type === 'bomb_planted' && e.t <= context.time && inRound(e, round));
      text = planted ? `+${fmt(context.time - planted.t)}` : 'C4'; phase = '炸弹已安放'; className += ' bomb';
    } else if (round?.timeLimit > 0 && round.freezeEnd >= round.start) {
      text = fmt(Math.ceil(round.freezeEnd + round.timeLimit - context.time)); phase = '回合剩余';
    }
    clock.textContent = text;
    $('clock-phase').textContent = phase;
    clock.parentElement.className = className;
  }
  function reset() {
    cache.data = null; cache.roundKey = ''; cache.rosterKey = ''; cache.detailKey = ''; cache.liveKey = ''; cache.roundButtons = []; cache.selectedId = null; cache.kills = []; cache.utilities = []; cache.killRows = []; cache.utilityRows = []; cache.context = null;
    $('live-kill-feed').replaceChildren();
    $('round-strip').replaceChildren(el('span', 'round-strip-empty', '导入 Demo 后选择回合'));
    for (const id of ['kill-feed', 'utility-feed']) $(id).replaceChildren(el('div', 'feed-empty', '等待比赛数据'));
    $('kill-count').textContent = '0'; $('utility-count').textContent = '0';
    $('review-round-number').textContent = '—'; $('round-summary').textContent = '导入比赛后查看本回合的全部交锋与道具。';
    showTab('kills');
  }
  function render(context) {
    if (!context?.data || !context.frame) return;
    if (cache.data !== context.data) { reset(); cache.data = context.data; }
    cache.context = context;
    if (context.selectedId && String(context.selectedId) !== String(cache.selectedId)) setPanel('review', true);
    cache.selectedId = context.selectedId || null;
    renderRoster(context);
    renderDetail(context);
    renderEvents(context);
    renderLiveKills(context);
    renderRounds(context);
  }
  window.ReplayReview = { render, reset };
})();
