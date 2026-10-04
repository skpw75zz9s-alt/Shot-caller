import test from 'node:test';
import assert from 'node:assert/strict';
import { newPractice, practiceSettle, practiceStep, todayStats, allStats, wouldBuy } from '../public/practice.js';
import { readFileSync } from 'node:fs';

const now = Date.now();
const c2 = (v) => Math.round(v * 100) / 100; // Kalshi quotes are whole cents
const close = new Date(now + 6 * 60000).toISOString();
const row = (yb, pYes = 0.7, ticker = 'KXBTC15M-A') => ({ m: { ticker, close_time: close }, rej: null, strike: 100000,
  ev: { pYes, quote: { yesBid: yb, yesAsk: c2(yb + 0.02), noBid: c2(1 - yb - 0.02), noAsk: c2(1 - yb) } } });
const snapOf = (r) => ({ now, bars: [], quoteLog: {}, rows: [r] });
const call = (over = {}) => ({ fire: true, callSide: 'YES', stance: 'new', deep: { score: 80 }, limit: 0.5, contracts: 50, ...over });
const cfg = { on: true, maxPerTrade: 5, dailyLoss: 20, maxTrades: 10, minConfidence: 70 };

test('practice never touches the order API', () => {
  const src = readFileSync(new URL('../public/practice.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch\(|portfolio\/orders|kalshi-auth|XMLHttpRequest/);
});

test('buys a new confident call at the ask, sized to max $ per trade', () => {
  const pr = newPractice(), r = row(0.40);
  const { actions } = practiceStep(pr, { snap: snapOf(r), row: r, sig: call(), settings: {}, cfg, now });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'buy');
  assert.equal(actions[0].price, 0.42);
  assert.equal(actions[0].contracts, 11); // $5 / (42¢ + 2¢ fee)
  assert.ok(actions[0].cost <= 5);
  assert.equal(pr.positions.length, 1);
  // same window again: no second buy
  assert.equal(practiceStep(pr, { snap: snapOf(r), row: r, sig: call(), settings: {}, cfg, now }).actions.length, 0);
});

test('skips: off, low confidence, over max price, holding calls, limits', () => {
  const r = row(0.40);
  assert.match(wouldBuy(newPractice(), { row: r, sig: call(), cfg: { ...cfg, on: false } }).why, /off/);
  assert.match(wouldBuy(newPractice(), { row: r, sig: call({ deep: { score: 65 } }), cfg }).why, /confidence 65 is under 70/);
  assert.match(wouldBuy(newPractice(), { row: r, sig: call({ limit: 0.41 }), cfg }).why, /over the 41¢ max/);
  assert.match(wouldBuy(newPractice(), { row: r, sig: call({ stance: 'holding', fire: false }), cfg }).why, /new call/);
  const pr = newPractice();
  for (let i = 0; i < 10; i++) pr.log.push({ at: now, ticker: `T${i}`, action: 'buy', cost: 1 });
  assert.match(wouldBuy(pr, { row: r, sig: call(), cfg }).why, /limit of 10 trades/);
  const pr2 = newPractice();
  pr2.log.push({ at: now, ticker: 'X', action: 'buy', cost: 20 });
  assert.match(wouldBuy(pr2, { row: r, sig: call(), cfg }).why, /\$20 loss limit/);
  // near the loss limit the size shrinks so it can't overrun it
  const pr3 = newPractice();
  pr3.log.push({ at: now, ticker: 'X', action: 'buy', cost: 18 });
  assert.equal(wouldBuy(pr3, { row: r, sig: call(), cfg }).count, 4); // $2 left / 44¢
});

test('takes profit when Kalshi pays what the bot thinks it is worth, and settles the rest', () => {
  const pr = newPractice();
  const r0 = row(0.40, 0.70);
  practiceStep(pr, { snap: snapOf(r0), row: r0, sig: call(), settings: {}, cfg, now });
  const up = row(0.75, 0.70); // bid 75¢ beats the bot's 70%
  const { actions } = practiceStep(pr, { snap: snapOf(up), row: up, sig: null, settings: {}, cfg, now: now + 5000 });
  assert.equal(actions[0].action, 'sell');
  assert.equal(actions[0].kind, 'take');
  assert.ok(actions[0].pnl > 0);
  assert.equal(pr.positions.length, 0);
  // another market held to settlement and lost
  const r1 = row(0.40, 0.70, 'KXBTC15M-B');
  practiceStep(pr, { snap: snapOf(r1), row: r1, sig: call(), settings: {}, cfg, now });
  const [s] = practiceSettle(pr, 'KXBTC15M-B', 'no', now + 600000);
  assert.equal(s.proceeds, 0);
  assert.ok(s.pnl < 0);
  const t = todayStats(pr, now + 600000), a = allStats(pr);
  assert.equal(t.closed, 2);
  assert.equal(a.trades, 2);
  assert.equal(a.wins, 1);
  assert.ok(Math.abs(a.pnl - t.pnl) < 1e-9);
});
