const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../web/impact-ui.js');
const core = require('../web/impact-core.js');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false; this.textContent = ''; this.value = ''; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  setAttribute(key, value) { this[key] = value; }
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  get childElementCount() { return this.children.length; }
}
const all = node => [node, ...node.children.flatMap(all)];
const text = node => [node.textContent, ...node.children.map(text)].join(' ');
function fixture(id = 'demo-a') {
  const player = { playerId: 'p1', player: 'Alice', side: 3, teamKey: 'a', half: 1, round: 1 };
  return { id, name: `${id}.dem`, map: 'de_anubis', impact: { version: '1', warnings: ['测试数据包含近似证据'], rounds: [{ ...player, eligible: true }],
    kills: [{ ...player, index: 1, time: 40, score: 1000, reason: '同档枪械击杀：1,000 + 125 × 0 = 1,000' }],
    deaths: [{ ...player, index: 2, time: 52, killerId: 'enemy', killer: '对手', weapon: 'AWP', killerWeapon: 'Glock-18', firstDeath: true, killsBefore: 1, alliesBefore: 5, enemiesBefore: 5, outcome: 'loss', weaponGap: 3, weaponFactor: 8, balanceFactor: 1.25, firstFactor: 2, resultFactor: 1, killMitigation: 1.6, corePenalty: 12500, economyPenalty: 1200, penalty: -13700, approx: true, notes: ['人数按事件重建'], next: { status: 'compared', reason: '同半场相邻回合，装备降档', round: 2, currentWeapon: 'AWP', nextWeapon: 'AK-47', currentGrenades: 4, nextGrenades: 3, weaponDrop: 1, utilityDrop: 0, weaponPenalty: 1200, utilityPenalty: 0 } }],
  } };
}
function page(multi = false) {
  const root = new Element('section');
  const panel = ui.create({ document: { createElement: tag => new Element(tag) }, root, prefix: 'test', multi, replayLink: (demoId, time) => `/?demo=${encodeURIComponent(demoId)}&t=${time}` });
  return { ...panel, root, get: suffix => { const node = all(root).find(node => node.id === `test-impact-${suffix}`); assert.ok(node, suffix); return node; } };
}

test('impact presentation connects signed totals, per-round denominator and full death evidence', () => {
  const view = page(), result = core.aggregate([fixture()]); view.render(result);
  assert.equal(view.get('killContribution').textContent, '+1,000'); assert.equal(view.get('deathPenalty').textContent, '-13,700'); assert.equal(view.get('combined').textContent, '-12,700'); assert.equal(view.get('perRound').textContent, '-12,700');
  assert.match(text(view.get('rating')), /样本不足/); assert.match(text(view.get('quality')), /回合覆盖 100%/);
  const row = view.get('death-rows').children[0]; assert.equal(row.dataset.included, 'true');
  assert.match(text(row), /回合首死/); assert.match(text(row), /5 v 5（含本人）/); assert.match(text(row), /死前 1 杀 · 本回合负/);
  const details = all(row).find(item => item.tagName === 'details'); assert.ok(details); assert.match(text(details), /枪差 8/); assert.match(text(details), /1 \+ 0.6 × 1/); assert.match(text(details), /关联附加：枪械 1,200/); assert.match(text(details), /近似记录/);
  assert.match(text(details), /死亡时手持 → 次回合开打主武器：AWP → AK-47/); assert.match(text(details), /本回合开打 → 次回合开打携带道具：4 → 3 颗（不是购买数量）/);
  assert.equal(all(row).find(item => item.tagName === 'a').href, '/?demo=demo-a&t=50');
  assert.match(text(view.root), /不是死亡导致经济变化的因果证明/); assert.match(text(view.root), /不表示真实胜率改变/);
});

test('unknown and ineligible deaths retain exclusions rather than displaying a raw penalty as counted', () => {
  const demo = fixture(); demo.impact.deaths[0].excludedReason = '胜负确定后死亡';
  const view = page(); view.render(core.aggregate([demo]));
  const row = view.get('death-rows').children[0]; assert.equal(row.dataset.included, 'false'); assert.match(text(row), /未计分/); assert.match(text(row), /胜负确定后死亡/); assert.doesNotMatch(text(row), /-13,700/);
  assert.equal(view.get('deathPenalty').textContent, '0');
  demo.impact.rounds[0].eligible = false; demo.impact.rounds[0].reason = '冻结人数不完整'; view.render(core.aggregate([demo]));
  assert.equal(view.get('combined').textContent, '—'); assert.equal(view.get('perRound').textContent, '—'); assert.match(text(view.get('rating')), /证据不足/);
});

test('older reports show an upgrade message instead of zero scores or an excellent rating', () => {
  const view = page(); view.render(core.aggregate([{ id: 'old', name: 'old.dem', kills: [], rounds: [] }]));
  assert.equal(view.get('unavailable').hidden, false); assert.match(view.get('unavailable').textContent, /现有缓存会自动补算/);
  const content = view.root.children[3]; assert.equal(content.hidden, true);
});

test('cross-demo audit preserves source links, scoped group selector and pagination', () => {
  const a = fixture('a'), b = fixture('b');
  a.impact.deaths = Array.from({ length: 33 }, (_, index) => ({ ...a.impact.deaths[0], index, firstDeath: index === 0, time: 30 + index }));
  const view = page(true), result = core.aggregate([a, b]); view.render(result);
  assert.equal(view.get('death-rows').children.length, 30); assert.match(view.get('death-page').textContent, /34 条 · 1 \/ 2 页/);
  view.get('death-next').click(); assert.equal(view.get('death-rows').children.length, 4); assert.equal(view.get('death-next').disabled, true);
  const last = view.get('death-rows').children.at(-1); assert.match(text(last), /b.dem · de_anubis/); assert.match(all(last).find(item => item.tagName === 'a').href, /demo=b/);
  view.render(result); assert.match(view.get('death-page').textContent, /2 \/ 2 页/, 'unchanged reports keep pagination');
  view.get('group').value = 'bySide'; view.get('group').dispatch('change'); assert.match(text(view.get('groups')), /CT/);
  view.render(core.aggregate([b])); assert.match(view.get('death-page').textContent, /1 \/ 1 页/, 'new scope resets pagination');
});

test('names and reasons remain literal text, never HTML injection', () => {
  const demo = fixture(); demo.impact.deaths[0].player = '<img src=x onerror=alert(1)>'; demo.impact.deaths[0].notes = ['<script>throw new Error()</script>'];
  const view = page(); view.render(core.aggregate([demo]));
  assert.match(text(view.get('death-rows')), /<img src=x onerror=alert\(1\)>/); assert.equal(all(view.root).some(node => node.tagName === 'img' || node.tagName === 'script'), false);
});
