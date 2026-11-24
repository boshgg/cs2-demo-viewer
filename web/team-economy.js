/* Count one freeze-end loadout per team and round, using the statistics report. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReplayTeamEconomy = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const categories = [
    { key: 'eco', label: 'ECO' }, { key: 'force', label: '强起' },
    { key: 'full', label: '满起' }, { key: 'mixed', label: '混起' },
    { key: 'hero', label: '英雄枪' }, { key: 'disorder', label: '乱买' },
    { key: 'unknown', label: '未知' },
  ];
  const primaryKeys = new Set(categories.map(category => category.key));
  // The scoring system's "rifle" tier also contains shotguns and machine guns.
  const rifles = new Set(['ak47', 'm4a1', 'm4a4', 'm4a1s', 'm4a1silencer', 'aug', 'sg553', 'sg556', 'famas', 'galilar', 'galil']);
  const otherHeavyGuns = new Set(['nova', 'mag7', 'sawedoff', 'xm1014', 'negev', 'm249']);
  function emptyCounts() {
    return { rounds: 0, pistols: 0, full: 0, force: 0, eco: 0, mixed: 0, hero: 0, disorder: 0, unknown: 0, longGun: 0, longGunUnknown: 0 };
  }
  function longGunMajority(team) {
    const players = team.players;
    if (team.complete !== true || !Array.isArray(players) || players.length !== 5) return null;
    let long = 0, other = 0;
    for (const player of players) {
      if (player.weaponClass === 'sniper') long++;
      else if (player.weaponClass === 'pistol' || player.weaponClass === 'smg') other++;
      else if (player.weaponClass === 'rifle') {
        const key = String(player.weapon || '').toLowerCase().replace(/^weapon_/, '').replace(/[^a-z0-9]/g, '');
        if (rifles.has(key)) long++;
        else if (otherHeavyGuns.has(key)) other++;
      }
    }
    if (long >= 3) return true;
    if (other >= 3) return false;
    return null;
  }
  const matches = (value, choice) => choice == null || choice === '' || choice === 'all' || String(value) === String(choice);
  function summarize(reports, { map, side, half, round, teamKeys } = {}) {
    const teams = new Map(), visited = new Set();
    const selected = teamKeys == null ? null : new Set(typeof teamKeys === 'string' ? [teamKeys] : teamKeys);
    for (const report of reports) {
      if (!report?.id || visited.has(report.id) || !matches(report.map, map)) continue;
      visited.add(report.id);
      const counted = new Set(), countedTeams = new Set();
      const labels = new Map((report.teams || []).map(team => [team.teamKey, team.label]));
      for (const r of report.rounds || []) {
        if (!Number.isInteger(r?.number) || r.number <= 0 || counted.has(r.number) || !matches(r.number, round) || !matches(r.half, half)) continue;
        counted.add(r.number);
        const pistol = r.pistol === true || (r.pistol == null && (r.ct?.type === 'pistol' || r.t?.type === 'pistol'));
        for (const [slot, code] of [['ct', 3], ['t', 2]]) {
          if (!matches(code, side)) continue;
          const economy = r[slot];
          if (!economy) continue;
          // Missing team identity must not turn CT or T into a cross-match team.
          const key = economy.teamKey || `unresolved:${report.id}:${r.half || 0}:${slot}`;
          if (selected && !selected.has(key)) continue;
          let team = teams.get(key);
          if (!team) {
            let name = labels.get(key) || economy.name || '未识别队伍';
            if (!economy.teamKey || key.startsWith('demo:') || economy.identitySource === 'ambiguous') {
              const scope = !economy.teamKey ? ` · 阶段 ${r.half || '?'} ${slot.toUpperCase()}` : '';
              name += `（${report.name || report.id}${scope}）`;
            }
            team = { key, name, demos: 0, total: emptyCounts(), ct: emptyCounts(), t: emptyCounts() };
            teams.set(key, team);
          }
          if (!countedTeams.has(key)) {
            countedTeams.add(key);
            team.demos++;
          }
          const counts = team[slot];
          if (pistol) {
            counts.pistols++;
            continue;
          }
          counts.rounds++;
          const primary = economy.type === 'full_sniper' ? 'full' : economy.type;
          counts[primaryKeys.has(primary) ? primary : 'unknown']++;
          const majority = longGunMajority(economy);
          if (majority === true) counts.longGun++;
          else if (majority === null) counts.longGunUnknown++;
        }
      }
    }
    const rows = [...teams.values()];
    const labels = new Set(), duplicateLabels = new Set();
    for (const team of rows) {
      for (const key of Object.keys(team.total)) team.total[key] = team.ct[key] + team.t[key];
      if (labels.has(team.name)) duplicateLabels.add(team.name);
      labels.add(team.name);
    }
    for (const team of rows) if (duplicateLabels.has(team.name)) team.name += `（${team.key}）`;
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.key.localeCompare(b.key));
  }
  return { categories, summarize };
});
