import test from 'node:test';
import assert from 'node:assert/strict';
import { PG, dailyLoss, profitGuard } from '../public/profitguard.js';
import { pnl10 } from '../public/model.js';
import { accuracyRows } from '../public/accuracy.js';

const call = (price, won) => ({ side: 'YES', price, result: won ? 'yes' : 'no' });
const calls = (n, losses, price = 0.93) => Array.from({ length: n }, (_, i) => call(price, i >= losses));

test('the profit guard: a level that wins 92% at 93c still loses money, and its alerts pause', () => {
  const r = profitGuard(calls(40, 3)); // 37 of 40 won (92.5%)
  assert.ok(Math.abs(r.usd - (37 * pnl10(0.93, true) + 3 * pnl10(0.93, false))) < 1e-9);
  assert.ok(r.usd < 0 && r.paused, `won 92.5% and still ${r.usd.toFixed(2)}`);
  assert.equal(profitGuard(calls(40, 1)).paused, false, '39 of 40 at 93c makes money: alerts on');
  assert.equal(profitGuard(calls(19, 5)).paused, false, `under ${PG.min} graded calls: too early to judge`);
  // it judges only the last 40, so paper calls that make money bring the alerts back
  const recovering = [...calls(40, 6), ...calls(40, 1)];
  assert.equal(profitGuard(recovering).paused, false);
  assert.equal(profitGuard([{ side: 'NO', price: 0.9, result: null }]).n, 0, 'unsettled calls don\'t count');
  assert.equal(profitGuard(calls(40, 6, 0.55)).paused, false, 'cheaper calls: 34 of 40 at 55c is a big profit');
});

test('the daily loss limit: today\'s closed trades past the limit stop buys until midnight', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime(), today = now - 3600000, yesterday = now - 30 * 3600000;
  const trades = [{ closedAt: today, pnl: -15 }, { closedAt: today, pnl: -12 }, { closedAt: today, pnl: 4 }, { closedAt: yesterday, pnl: -100 }];
  const r = dailyLoss(trades, 20, now);
  assert.deepEqual([r.pnl, r.trades, r.hit], [-23, 3, true], 'yesterday doesn\'t count');
  assert.equal(r.until, new Date(2026, 9, 13).getTime(), 'until the next midnight');
  assert.equal(dailyLoss(trades, 25, now).hit, false, 'down $23 with a $25 limit: still on');
  assert.equal(dailyLoss(trades, 0, now).hit, false, '0 = off');
  assert.equal(dailyLoss([{ closedAt: today, pnl: -25 }], 25, now).hit, true, 'exactly at the limit counts');
});

test('the accuracy card: levels judged by profit, the guard and your trades shown', () => {
  const rows = accuracyRows({
    bot: { graded: 40, wins: 37, usd: -2.1, level: '90% target', guard: { floor: 0.9, n: 40, wins: 37 } },
    guard: { level: '90% target', n: 40, usd: -2.1, paused: true },
    trades: { n: 12, total: -18.5, today: { pnl: -8, limit: 25, hit: false } },
  });
  const v = Object.fromEntries(rows.map((r) => [r.key, r.verdict]));
  assert.equal(v.calls, 'bad', 'won 92.5% but lost money: red');
  assert.equal(v.profit, 'bad'); assert.match(rows.find((r) => r.key === 'profit').metric, /PAUSED/);
  assert.equal(v.trades, 'wait', '12 trades: too few to judge');
  assert.match(rows.find((r) => r.key === 'trades').vs, /daily loss limit/);
});
