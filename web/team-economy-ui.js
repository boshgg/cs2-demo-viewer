(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./team-economy.js'));
  else root.TeamEconomyUI = factory(root.ReplayTeamEconomy);
})(typeof window === 'object' ? window : globalThis, function (economy) {
  'use strict';

  function render(doc, container, teams, { side } = {}) {
    const element = (tag, text) => {
      const el = doc.createElement(tag);
      if (text != null) el.textContent = String(text);
      return el;
    };
    const note = element('p');
    note.className = 'micro team-economy-note';
    if (!teams.length) {
      note.textContent = '当前范围没有选中队伍的回合记录。';
      container.replaceChildren(note);
      return;
    }
    note.textContent = '按冻结结束时全队的装备和余钱统计。手枪局单列，其余每回合只计入一个经济主分类。';
    const scroll = element('div'), table = element('table'), head = element('thead'), header = element('tr');
    scroll.className = 'table-scroll';
    table.setAttribute('aria-label', '各队非手枪局的起枪回合数');
    const columns = [
      { key: 'rounds', label: '非手枪局' }, ...economy.categories,
      { key: 'longGun', label: '长枪局' }, { key: 'pistols', label: '已排除手枪局' },
    ];
    for (const label of ['队伍', '阵营', ...columns.map(c => c.label)]) {
      const cell = element('th', label);
      cell.scope = 'col';
      header.append(cell);
    }
    head.append(header);
    table.append(head);
    const sides = [['ct', 'CT'], ['t', 'T'], ['total', '合计']];
    const rows = String(side) === '3' ? [sides[0]] : String(side) === '2' ? [sides[1]] : sides;
    for (const team of teams) {
      const body = element('tbody');
      body.dataset.teamKey = team.key;
      for (const [index, [key, label]] of rows.entries()) {
        const row = element('tr'), counts = team[key];
        row.dataset.side = key;
        if (index === 0) {
          const name = element('th', team.name);
          name.scope = 'rowgroup';
          name.rowSpan = rows.length;
          name.append(element('small', `${team.demos} 场比赛`));
          row.append(name);
        }
        const sideLabel = element('th', label);
        sideLabel.scope = 'row';
        row.append(sideLabel);
        for (const column of columns) {
          const cell = element('td', counts[column.key].toLocaleString('zh-CN'));
          cell.dataset.metric = column.key;
          if (column.key === 'longGun' && counts.longGunUnknown) {
            cell.append(element('small', `另有 ${counts.longGunUnknown} 局待判定`));
          }
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body);
    }
    scroll.append(table);
    const rule = element('p', '满起含全起和全起有狙。五人装备记录完整且至少 3 人持步枪或狙击枪，另计一次长枪局，可与经济主分类重合。装备记录不完整的回合列为待判定。');
    rule.className = 'micro team-economy-method';
    container.replaceChildren(note, scroll, rule);
  }

  return { render };
});
