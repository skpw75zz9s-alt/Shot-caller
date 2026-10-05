import test from 'node:test';
import assert from 'node:assert/strict';
import { learnStep, newLearned } from '../public/learn.js';

const T0 = Date.parse('2026-10-05T14:00:00Z');
const trades = (n, f) => Array.from({ length: n }, (_, i) => ({ closedAt: T0 + i * 60000, ...f(i) }));

test('learning waits for 30 real trades, then checks every 10', () => {
  assert.deepEqual(learnStep({ botTrades: trades(29, () => ({ pnl: -1, conf: 81 })), liveBar: 80, stratBar: 80 }).changes, []);
  const r = learnStep({ botTrades: trades(30, () => ({ pnl: -1, conf: 81 })), liveBar: 80, stratBar: 80 });
  assert.equal(r.liveBar, 82, 'trades just over the bar lost: raise it 2');
  assert.equal(r.learned.sizeMult, 0.8, 'last 30 lost: bet 20% smaller');
  assert.equal(r.learned.log.length, 2);
  assert.ok(r.learned.log.some((c) => /made -\$/.test(c.why)) && r.learned.log.some((c) => /lost \$30\.00/.test(c.why)));
  assert.deepEqual(learnStep({ botTrades: trades(35, () => ({ pnl: -1, conf: 81 })), learned: r.learned, liveBar: 82, stratBar: 80 }).changes, [], 'only 5 new trades');
});

test('winning lowers the bar toward the risk level and grows size, within limits', () => {
  const win = trades(40, (i) => ({ pnl: i % 3 ? 1 : -0.5, conf: 90 }));
  const r = learnStep({ botTrades: win, learned: { ...newLearned(), seen: 30, sizeMult: 1.45 }, liveBar: 86, stratBar: 80 });
  assert.equal(r.liveBar, 84);
  assert.equal(r.learned.sizeMult, 1.5, 'capped at 1.5x');
  assert.equal(learnStep({ botTrades: win, learned: { ...newLearned(), seen: 30 }, liveBar: 80, stratBar: 80 }).liveBar, 80, 'never under the risk level bar');
  const lose = trades(40, () => ({ pnl: -1, conf: 94 }));
  assert.equal(learnStep({ botTrades: lose, learned: { ...newLearned(), seen: 30, sizeMult: 0.55 }, liveBar: 95, stratBar: 80 }).learned.sizeMult, 0.5, 'never under half size');
  assert.equal(learnStep({ botTrades: lose, learned: { ...newLearned(), seen: 30 }, liveBar: 95, stratBar: 80 }).liveBar, 95, 'never over 95');
});
