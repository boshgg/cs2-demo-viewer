/* Shared, evidence-first impact presentation for single and cross-demo reports. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayImpactUI = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = value => finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
  const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${format(value)}` : '—';
  const color = value => finite(value) ? value > 0 ? 'value-positive' : value < 0 ? 'value-negative' : 'value-zero' : '';
  const clock = value => finite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '—';
  const percent = value => finite(value) ? `${format(value * 100)}%` : '—';
  const pageSize = 30;
  function create({ document: doc, root, prefix, replayLink, multi = false }) {
    const make = (tag, text, className) => { const node = doc.createElement(tag); if (text != null) node.textContent = String(text); if (className) node.className = className; return node; };
    const identify = (node, suffix) => { node.id = `${prefix}-impact-${suffix}`; return node; };
    const cell = (row, text, className) => { const node = make('td', text, className); row.append(node); return node; };
    const section = title => { const node = make('section', null, 'impact-section'); node.append(make('h3', title)); return node; };
    const table = (parent, headings, suffix) => {
      const wrap = make('div', null, 'table-scroll impact-table-scroll'), table = make('table'), head = make('thead'), row = make('tr'), body = identify(make('tbody'), suffix);
      for (const text of headings) row.append(make('th', text)); head.append(row); table.append(head, body); wrap.append(table); parent.append(wrap); return body;
    };
    const empty = (body, columns, text) => { const row = make('tr'), item = cell(row, text, 'empty-row'); item.colSpan = columns; body.append(row); };
    const heading = make('div', null, 'section-heading'), titles = make('div'); titles.append(make('span', 'IMPACT / MODEL 1', 'eyebrow'), make('h2', '死亡影响与综合表现')); heading.append(titles);
    const intro = make('p', '综合影响 = 击杀贡献 + 死亡扣分。先按完整回合计算，再应用当前筛选；折叠或隐藏录像不会改变计分依据。', 'impact-intro');
    const unavailable = identify(make('p', null, 'notice warning'), 'unavailable'), content = make('div');
    const grid = make('div', null, 'summary-grid impact-summary'), values = {};
    for (const [key, title, help] of [['killContribution', '击杀贡献', '基础击杀贡献 + 枪械对位奖励'], ['deathPenalty', '死亡扣分', '战局扣分 + 次回合装备变化关联'], ['combined', '综合影响总分', '可跨场累加；不同场数请比较每回合'], ['perRound', '每回合综合分', '总分 ÷ 所选玩家有效参赛回合数']]) {
      const card = make('article'), value = identify(make('strong', '—'), key); values[key] = value; card.append(make('span', title), value, make('small', help)); grid.append(card);
    }
    const quality = identify(make('p', null, 'impact-quality'), 'quality'), rating = identify(make('p', null, 'impact-rating'), 'rating'); quality.setAttribute('role', 'status');
    const warnings = identify(make('details', null, 'impact-methodology'), 'warnings'), warningTitle = make('summary'), warningBody = make('div'); warnings.append(warningTitle, warningBody);
    const methodology = make('details', null, 'impact-methodology'); methodology.append(make('summary', '查看公式、基准线与适用范围'));
    for (const text of [
      '击杀贡献 = 1,000 + 125 × 原加权击杀净值。同档击杀 +1,000，手枪杀狙 +4,000，长枪杀手枪 +500。有效敌方枪械击杀遇到对手手持刀或道具时，保留基础贡献，但不增加枪械对位奖励；未知证据会单独标记。道具、刀与电击枪击杀不计击杀贡献。原有击杀净值保持原口径。',
      '基础死亡扣分 = 四舍五入[1,000 × 首死倍率 × 枪差倍率 × 人数倍率 × 胜负倍率 ÷ (1 + 0.6 × 死前敌方击杀数)]。首死是本回合双方第一起有效死亡，倍率 2，其余 1；枪差倍率为 2 的“本人手持档位 − 对手击杀枪档位”次方；档位为手枪 1、冲锋枪 2、长枪 3、狙击枪 4。死亡前人数含本人，相等 ×1.25，不等 ×0.75；回合输 ×1，赢 ×0.35。非枪对位使用中性枪差，不推测背包武器。',
      '次回合装备变化关联：仅比较同玩家、连续回合、同一半场与阵营。枪械取本次死亡时实际手持的枪，对比下一回合开打时的主武器；降档按 150 × 降档数 × max(1, 枪差倍率)。若下一回合枪械同档或更好，再比较本回合与下一回合开打时携带的道具数，减少时按 60 × 少带颗数 × max(1, 枪差倍率)。附加总额不超过本次基础死亡扣分的 20%。道具携带数量不等于购买数量，这不是死亡导致经济变化的因果证明。死亡时手持非枪械或未知、末回合、换边、加时重置或资料不足时不追加经济扣分。',
      '每回合基准（暂定规则线）：≥ +500 优秀；+200 至 < +500 良好；0 至 < +200 轻度正向；> −300 且 < 0 负向；≤ −300 明显负向。0 是本模型贡献与扣分的平衡线，不是全体玩家平均值。多名玩家合并时，分母是各自有效回合的总和。正式评级需要至少 30 个有效回合、回合覆盖率达到 90%、至少一个可计分事件且所选比赛没有缺失影响报告，否则显示样本不足或证据不足。',
      '这是复盘用启发式指标，尚未用竞技总体样本校准，不表示真实胜率改变。补枪价值、牺牲拉枪线、残局目标、伤害、助攻与道具支援未被完整衡量；请结合逐次依据和回放判断。胜负确定后的追杀仍保留在原击杀净值中，但不计入这里的战局影响。'
    ]) methodology.append(make('p', text));
    const examples = make('p', '5v5 首死并输局、无经济附加：手枪被狙杀约 −313；同档约 −2,500；长枪被手枪杀约 −10,000；狙被手枪杀约 −20,000。', 'impact-example'); methodology.append(examples);
    const players = section('玩家综合表现'), playerNote = make('p', '按每回合综合分排序；同时显示样本量，避免场数更多天然排名更高。', 'micro'); players.append(playerNote);
    const playerBody = table(players, ['玩家 / ID', '击杀贡献', '死亡扣分', '综合总分', '每回合', '有效 / 观察回合', '规则评级'], 'players');
    const splits = section('分项综合表现'), splitLabel = make('label', '分组查看', 'impact-group-label'), splitSelect = identify(make('select'), 'group'); splitSelect.setAttribute('aria-label', '综合影响分组方式');
    for (const [key, text] of (multi ? [['byDemo', '比赛'], ['byMap', '地图'], ['bySide', 'CT / T'], ['byRound', '回合']] : [['byRound', '回合'], ['bySide', 'CT / T'], ['byHalf', '半场']])) { const option = make('option', text); option.value = key; splitSelect.append(option); }
    splitSelect.value = multi ? 'byDemo' : 'byRound'; splitLabel.append(splitSelect); splits.append(splitLabel);
    const splitBody = table(splits, ['范围', '击杀贡献', '死亡扣分', '综合总分', '每回合', '有效 / 观察玩家回合'], 'groups');
    const deathSection = section('逐次死亡与扣分依据'); deathSection.append(make('p', '按死亡玩家筛选。展开“计算依据”可查看首死、枪械差距、死前击杀、人数、胜负以及次回合装备变化；未计分记录保留原因。', 'micro'));
    const deathControls = make('div', null, 'impact-death-controls'); deathControls.setAttribute('role', 'group'); deathControls.setAttribute('aria-label', '死亡明细排序与筛选');
    const deathSortLabel = make('label', '排列方式', 'impact-death-sort-label'), deathSort = identify(make('select'), 'death-sort'); deathSort.setAttribute('aria-label', '死亡明细排列方式');
    for (const [value, title] of [['time', multi ? '时间顺序（逐场）' : '时间顺序'], ['penalty', '扣分最多优先']]) { const option = make('option', title); option.value = value; deathSort.append(option); }
    deathSort.value = 'time'; deathSortLabel.append(deathSort); deathControls.append(deathSortLabel);
    function deathToggle(suffix, title) { const label = make('label', null, 'impact-death-toggle'), check = identify(make('input'), suffix); check.type = 'checkbox'; check.checked = false; label.append(check, make('span', title)); deathControls.append(label); return check; }
    const deathFirstOnly = deathToggle('death-first-only', '只看首死'), deathLossOnly = deathToggle('death-loss-only', '只看输局死亡');
    const deathCount = identify(make('p', null, 'micro impact-death-count'), 'death-count'); deathCount.setAttribute('role', 'status'); deathCount.setAttribute('aria-live', 'polite');
    deathSection.append(deathControls, make('p', '以上条件仅改变死亡明细；综合分、排行、分项与击杀贡献明细保持当前统计范围。', 'micro'), deathCount);
    const deathBody = table(deathSection, ['来源 / 回合 / 时间', '死亡玩家 ← 对手', '本人手持 / 击杀枪', '死亡前局势', '死亡影响', '计算依据', '回放'], 'death-rows');
    const killSection = make('details', null, 'impact-kill-audit'); killSection.append(make('summary', '逐次击杀贡献与综合分关联')); const killBody = table(killSection, ['来源 / 回合 / 时间', '玩家', '击杀贡献', '依据', '回放'], 'kill-rows');
    let result = null, deathPage = 0, killPage = 0, signature = '';
    function pagination(parent, type) {
      const bar = make('div', null, 'pagination'), prev = identify(make('button', '上一页', 'button secondary'), `${type}-prev`), info = identify(make('span', null, 'micro'), `${type}-page`), next = identify(make('button', '下一页', 'button secondary'), `${type}-next`);
      prev.type = next.type = 'button'; prev.setAttribute('aria-label', `${type === 'death' ? '死亡' : '击杀贡献'}记录上一页`); next.setAttribute('aria-label', `${type === 'death' ? '死亡' : '击杀贡献'}记录下一页`);
      prev.addEventListener('click', () => { if (type === 'death') deathPage--; else killPage--; renderAudit(type); }); next.addEventListener('click', () => { if (type === 'death') deathPage++; else killPage++; renderAudit(type); });
      bar.append(prev, info, next); parent.append(bar); return { prev, next, info };
    }
    const deathPaging = pagination(deathSection, 'death'), killPaging = pagination(killSection, 'kill');
    for (const control of [deathSort, deathFirstOnly, deathLossOnly]) control.addEventListener('change', () => { deathPage = 0; renderAudit('death'); });
    content.append(grid, rating, quality, warnings, methodology, players, splits, deathSection, killSection); root.replaceChildren(heading, intro, unavailable, content);
    function sourceCell(row, item) { const td = cell(row, `R${item.round} · ${clock(item.time)}`); if (multi) td.append(make('small', `${item.demoName || item.demoId} · ${item.map || '地图未知'}`)); return td; }
    function linkCell(row, item) { const link = make('a', '回放 ↗', 'text-button'); link.href = replayLink(item.demoId, Math.max(0, (item.time || 0) - 2)); link.target = '_blank'; link.rel = 'noopener'; cell(row).append(link); }
    function scoreCells(row, summary) { for (const key of ['killContribution', 'deathPenalty', 'combined', 'perRound']) cell(row, signed(summary[key]), color(summary[key])); cell(row, `${format(summary.playerRounds)} / ${format(summary.observedPlayerRounds)}`); }
    function deathEvidence(death) {
      const detail = make('details', null, 'impact-evidence'); detail.append(make('summary', '计算依据'));
      const lines = [];
      if (death.included) {
        lines.push(`战局扣分：1,000 × 首死 ${format(death.firstFactor)} × 枪差 ${format(death.weaponFactor)} × 人数 ${format(death.balanceFactor)} × 胜负 ${format(death.resultFactor)} ÷ (1 + 0.6 × ${format(death.killsBefore)}) = ${format(death.corePenalty)}（四舍五入）`);
        lines.push(`死亡影响 = −(${format(death.corePenalty)} + ${format(death.economyPenalty)}) = ${signed(death.penalty)}`);
      } else lines.push(death.aggregationExcludedReason || death.excludedReason || '资料不足，未计入综合分。');
      if (death.next) {
        const next = death.next;
        lines.push(`次回合装备变化关联：${next.reason || next.status || '未知'}`);
        if (next.currentWeapon || next.nextWeapon) lines.push(`死亡时手持 → 次回合开打主武器：${next.currentWeapon || '未知'} → ${next.nextWeapon || '未知'}${next.round ? `（R${next.round}）` : ''}。`);
        if (finite(next.currentGrenades) || finite(next.nextGrenades)) lines.push(`本回合开打 → 次回合开打携带道具：${format(next.currentGrenades)} → ${format(next.nextGrenades)} 颗（不是购买数量）。`);
        if (finite(next.weaponPenalty) || finite(next.utilityPenalty)) lines.push(`关联附加：枪械 ${format(next.weaponPenalty)} + 道具 ${format(next.utilityPenalty)}；附加合计上限为基础死亡扣分的 20%。`);
      }
      for (const note of death.notes || []) if (typeof note === 'string') lines.push(note);
      if (death.approx) lines.push('近似记录：部分证据由邻近帧或事件重建，需结合回放。');
      for (const text of lines) detail.append(make('p', text)); return detail;
    }
    function visibleDeaths() {
      const demos = new Map();
      const records = (result?.deaths || []).map((item, ordinal) => { if (!demos.has(item.demoId)) demos.set(item.demoId, demos.size); return { item, ordinal }; }).filter(({ item }) => (!deathFirstOnly.checked || item.firstDeath === true) && (!deathLossOnly.checked || item.outcome === 'loss'));
      records.sort((a, b) => {
        if (deathSort.value === 'penalty') {
          const validA = a.item.included === true && finite(a.item.penalty) && a.item.penalty <= 0, validB = b.item.included === true && finite(b.item.penalty) && b.item.penalty <= 0;
          if (validA !== validB) return validA ? -1 : 1;
          if (validA && a.item.penalty !== b.item.penalty) return a.item.penalty - b.item.penalty;
        } else {
          const demoOrder = demos.get(a.item.demoId) - demos.get(b.item.demoId); if (demoOrder) return demoOrder;
          const aTime = finite(a.item.time) ? a.item.time : Infinity, bTime = finite(b.item.time) ? b.item.time : Infinity;
          if (aTime !== bTime) return aTime - bTime;
        }
        return a.ordinal - b.ordinal;
      });
      return records.map(({ item }) => item);
    }
    function renderAudit(type) {
      const deaths = type === 'death', records = deaths ? visibleDeaths() : result?.kills || [], pages = Math.max(1, Math.ceil(records.length / pageSize));
      if (deaths) deathCount.textContent = `显示 ${records.length} / ${(result?.deaths || []).length} 条死亡记录${deathFirstOnly.checked || deathLossOnly.checked ? ' · 已应用明细筛选' : ''}`;
      let page = deaths ? deathPage : killPage; page = Math.max(0, Math.min(page, pages - 1)); if (deaths) deathPage = page; else killPage = page;
      const body = deaths ? deathBody : killBody, paging = deaths ? deathPaging : killPaging; body.replaceChildren(); paging.prev.disabled = page === 0; paging.next.disabled = page >= pages - 1; paging.info.textContent = `${records.length} 条 · ${page + 1} / ${pages} 页 · 每页 ${pageSize} 条`;
      for (const item of records.slice(page * pageSize, (page + 1) * pageSize)) {
        const row = make('tr', null, deaths && item.firstDeath ? 'impact-first-death' : ''); row.dataset.impactKey = item.key; row.dataset.included = String(item.included); sourceCell(row, item);
        if (deaths) {
          const who = cell(row, `${item.player || item.playerId || '未知'} ← ${item.killer || '世界 / 未知'}`); who.append(make('small', item.side === 3 ? 'CT' : item.side === 2 ? 'T' : '阵营未知'));
          if (item.firstDeath) who.append(make('span', '回合首死', 'impact-first-badge'));
          cell(row, `${item.weapon || '未知'} / ${item.killerWeapon || '未知'}`);
          const situation = cell(row, `${format(item.alliesBefore)} v ${format(item.enemiesBefore)}（含本人）`); situation.append(make('small', `死前 ${format(item.killsBefore)} 杀 · ${item.outcome === 'win' ? '本回合胜' : item.outcome === 'loss' ? '本回合负' : '胜负未知'}`));
          const score = cell(row, item.included ? signed(item.penalty) : '未计分', item.included ? color(item.penalty) : ''); if (item.included) score.append(make('small', `战局 −${format(item.corePenalty)} · 关联 −${format(item.economyPenalty)}`));
          cell(row, null, 'impact-evidence-cell').append(deathEvidence(item));
        } else {
          cell(row, item.player || item.playerId || '未知'); cell(row, item.included ? signed(item.score) : '未计分', item.included ? color(item.score) : '');
          const why = cell(row, item.included ? item.reason || '基础击杀贡献与枪械对位奖励' : item.aggregationExcludedReason || item.excludedReason || '资料不足', 'impact-evidence-cell'); if (item.approx) why.append(make('span', '近似证据', 'approx-badge'));
        }
        linkCell(row, item); body.append(row);
      }
      if (!records.length) empty(body, deaths ? 7 : 5, deaths ? deathFirstOnly.checked || deathLossOnly.checked ? '没有符合首死 / 回合胜负条件的死亡记录；可取消明细筛选。' : '当前筛选没有死亡记录。' : '当前筛选没有击杀贡献记录。');
    }
    function renderGroups() {
      splitBody.replaceChildren(); const grouping = splitSelect.value;
      for (const item of result?.[grouping] || []) {
        const row = make('tr'); let title = item.label || item.map || item.demoName || item.demoId || '未知';
        if (grouping === 'byRound') title = `${multi ? `${item.demoName || item.demoId} · ` : ''}R${item.round}`;
        else if (grouping === 'byDemo') title = `${item.demoName || item.demoId} · ${item.map || '地图未知'}`;
        else if (grouping === 'byHalf') title = item.label || `阶段 ${item.half}`;
        cell(row, title); scoreCells(row, item.summary); splitBody.append(row);
      }
      if (!splitBody.childElementCount) empty(splitBody, 6, '当前范围没有可用的玩家回合。');
    }
    splitSelect.addEventListener('change', renderGroups);
    function render(nextResult) {
      result = nextResult; const summary = result?.summary, usable = summary && (result.demos || []).length > 0 && result.status !== 'unavailable';
      unavailable.hidden = !!usable; content.hidden = !usable;
      unavailable.textContent = '当前报告没有死亡影响数据。请确认本地程序已更新，再重新读取该比赛；现有缓存会自动补算，无需删除录像。';
      if (!usable) return;
      const newSignature = [...(result.deaths || []), ...(result.kills || [])].map(item => item.key).join('|'); if (newSignature !== signature) { deathPage = killPage = 0; signature = newSignature; }
      const measurable = summary.playerRounds > 0;
      for (const [key, el] of Object.entries(values)) { el.textContent = measurable ? signed(summary[key]) : '—'; el.className = measurable ? color(summary[key]) : ''; }
      rating.textContent = `${summary.rating?.label || '未评级'}：${summary.rating?.description || '请结合有效回合与证据完整性判断。'}`;
      quality.textContent = `有效 / 观察玩家回合 ${format(summary.playerRounds)} / ${format(summary.observedPlayerRounds)} · 回合覆盖 ${percent(summary.coverage)} · 事件覆盖 ${percent(summary.eventCoverage)} · ${format(summary.scoredDeaths)} 次已计分死亡 / ${format(summary.excludedDeaths)} 次未计分 · ${format(summary.approximateEvents)} 条近似事件${result.unavailableDemos?.length ? ` · ${result.unavailableDemos.length} 场缺少影响数据` : ''}`;
      const notes = (result.warnings || []).filter(note => typeof note === 'string'); warnings.hidden = !notes.length; warningTitle.textContent = `影响分数据说明（${notes.length} 项）`; warningBody.replaceChildren(...notes.map(note => make('p', note)));
      playerBody.replaceChildren();
      for (const player of result.players || []) { const row = make('tr'); row.dataset.playerId = player.id; const who = cell(row, player.name || player.id); who.append(make('small', player.id)); scoreCells(row, player.summary); const grade = cell(row, player.summary.rating?.label || '未评级'); grade.append(make('small', player.summary.rating?.description || '')); playerBody.append(row); }
      if (!playerBody.childElementCount) empty(playerBody, 7, '当前筛选没有玩家。');
      renderGroups(); renderAudit('death'); renderAudit('kill');
    }
    return { render };
  }
  return { create };
});
