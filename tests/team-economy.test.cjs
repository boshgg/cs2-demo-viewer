const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, categories } = require('../web/team-economy.js');

const weapons = {
  rifle: ['rifle', 'AK-47'], m4: ['rifle', 'weapon_m4a1_silencer'], shotgun: ['rifle', 'MAG-7'],
  machine: ['rifle', 'M249'], sniper: ['sniper', 'AWP'], pistol: ['pistol', 'Desert Eagle'], smg: ['smg', 'MP9'],
};
function team(teamKey, type, guns = ['rifle', 'm4', 'sniper', 'pistol', 'smg']) {
  return {
    teamKey, name: teamKey, type, complete: true, matchedTypes: [type, 'force', 'eco'],
    players: guns.map((key, i) => ({ id: String(i), weaponClass: weapons[key][0], weapon: weapons[key][1] })),
  };
}
const a = 'name:falcons', b = 'name:furia';
const round = (number, half, ct, t, pistol = false) => ({ number, half, ct, t, pistol });
const mirage = { id: 'm', map: 'de_mirage', name: 'Match one', teams: [{ teamKey: a, label: 'Falcons' }], rounds: [
  round(1, 1, team(a, 'pistol'), team(b, 'pistol'), true),
  round(2, 1, team(a, 'full_sniper'), team(b, 'force')),
  round(16, 2, team(b, 'pistol'), team(a, 'pistol'), true),
  round(17, 2, team(b, 'full'), team(a, 'mixed')),
  round(31, 3, team(a, 'full'), team(b, 'disorder')),
] };
const nuke = { id: 'n', name: 'Match two', map: 'de_nuke', rounds: [
  round(13, 1, team(a, 'eco', ['smg','shotgun','machine','rifle','sniper']), team(b, 'mixed')),
  round(14, 1, { ...team(a, 'unknown'), complete: false }, team(b, 'hero')),
] };

test('team economies aggregate by actual side across swaps and demos, with exclusive buys and overlapping long gun counts', () => {
  const result = summarize([mirage, mirage, nuke]);
  assert.equal(result.length, 2);
  const { name, demos, total, ct, t } = result.find(row => row.key === a);
  assert.equal(name, 'Falcons');
  assert.equal(demos, 2);
  assert.deepEqual(total, { rounds: 5, pistols: 2, full: 2, force: 0, eco: 1, mixed: 1, hero: 0, disorder: 0, unknown: 1, longGun: 3, longGunUnknown: 1 });
  assert.equal(ct.rounds, 4);
  assert.equal(t.rounds, 1);
  for (const key of Object.keys(total)) assert.equal(ct[key] + t[key], total[key]);
  for (const row of result) assert.equal(categories.reduce((sum,c) => sum + row.total[c.key], 0), row.total.rounds);
});

test('map, team, side, half and round scope use the match report; player filters leave the full economy intact', () => {
  const filter = { map: nuke.map, teamKeys: new Set([a]), side: '3', half: '1', round: '13', player: 'absent' };
  const rows = summarize([mirage,nuke],filter);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].demos, 1);
  assert.equal(rows[0].ct.eco, 1); // MR15 R13 isn't inferred to be a pistol round.
  assert.equal(rows[0].total.longGun, 0); // MAG-7 and M249 are outside the rifle/precision-rifle grouping.
  assert.equal(rows[0].t.rounds, 0);
  assert.equal(summarize([mirage], { teamKeys: [], side: 'all' }).length, 0);
  assert.equal(summarize([mirage], { round: 16, teamKeys: [a] })[0].total.pistols, 1);
  assert.equal(summarize([mirage], { round: 16, teamKeys: [a] })[0].total.rounds, 0);
  assert.equal(summarize([nuke], { round: 14, teamKeys: [a] })[0].total.longGunUnknown, 1);
});

test('unresolved identities stay local and duplicate round rows cannot inflate totals', () => {
  const copies = ['one','two'].map(id => {
    const r = round(3, 1, { ...team('', 'unknown'), complete: false }, { ...team('demo:'+id+':team:1', 'force'), name: '临时队伍' });
    return { id, name: '同一文件名', rounds: [r,r] };
  });
  const teams = summarize(copies);
  assert.equal(teams.length, 4);
  assert.equal(new Set(teams.map(row => row.name)).size, 4);
  assert.ok(teams.every(row => row.demos === 1 && row.total.rounds === 1));
});
