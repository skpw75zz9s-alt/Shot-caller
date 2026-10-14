import test from 'node:test';
import assert from 'node:assert/strict';
import { EVERGREEN, MAP, coachTips, stopDays, successMap, youStats } from '../public/success.js';

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime(), H = 3600000, D = 24 * H;
// newest first, like state.trades; stake = contracts × price
const trade = (i, { price = 0.75, contracts = 4, won = true, ago = i * H } = {}) => {
  const closedAt = NOW - ago, pnl = won ? (1 - price) * contracts - 0.05 : -price * contracts - 0.05;
  return { at: closedAt - 10 * 60000, closedAt, price, contracts, side: 'YES', how: 'settled', exit: won ? 1 : 0, pnl };
};
const step = (m, id) => m.steps.find((s) => s.id === id);

test('a new user starts at the guardrails, with every step carrying a tip', () => {
  const m = successMap({ now: NOW });
  assert.equal(m.at, 0); assert.equal(m.done, 0); assert.equal(m.steps.length, 9);
  for (const s of m.steps) { assert.ok(s.tip.length > 40, `${s.id} has a real tip`); assert.ok(s.progress >= 0 && s.progress <= 1); }
  assert.match(step(m, 'guard').value, /0 of 3/);
  assert.match(step(m, 'small').value, /daily loss limit first/);
  assert.equal(m.coach.length, 3, 'always three tips');
  assert.ok(m.coach.some((t) => t.title === 'No daily loss limit'));
});

test('guardrails fill as push, the daily limit and the Profit level are set', () => {
  assert.equal(step(successMap({ pushOn: true, settings: { dailyLossLimit: 20 }, level: 'profit', now: NOW }), 'guard').done, true);
  const two = step(successMap({ pushOn: false, settings: { dailyLossLimit: 20 }, level: 'profit', now: NOW }), 'guard');
  assert.equal(two.done, false); assert.ok(Math.abs(two.progress - 2 / 3) < 1e-9); assert.match(two.value, /push alerts on/);
});

test('a disciplined record walks the whole road', () => {
  const trades = Array.from({ length: 120 }, (_, i) => trade(i, { won: i % 5 !== 0, ago: Math.floor(i / 10) * D + (i % 10) * 600000 + H }));
  const m = successMap({ trades, settings: { dailyLossLimit: 20 }, level: 'profit', pushOn: true, now: NOW });
  assert.ok(m.you.pnl > 0);
  for (const id of ['guard', 'watch', 'first', 'small', 'band', 'stop', 'solid', 'green', 'pro']) assert.equal(step(m, id).done, true, id);
  assert.equal(m.at, m.steps.length); assert.equal(m.done, 9);
});

test('stakes over a third of the daily limit and buys outside 60-90c hold their steps back', () => {
  const trades = Array.from({ length: 20 }, (_, i) => trade(i, { price: i % 2 ? 0.95 : 0.75, contracts: i < 3 ? 20 : 4 }));
  const m = successMap({ trades, settings: { dailyLossLimit: 15 }, level: 'profit', pushOn: true, now: NOW });
  assert.equal(step(m, 'small').done, false); assert.match(step(m, 'small').value, /7 of 10 within \$5\.00/);
  assert.equal(step(m, 'band').done, false); assert.match(step(m, 'band').value, /10 of 20/);
  assert.ok(m.coach.some((t) => /cost over 90¢/.test(t.title)), 'the coach names the 90c+ buys');
});

test('stopDays finds trading past the limit, and only that', () => {
  const lost = [{ at: NOW - 5 * H, closedAt: NOW - 4 * H, pnl: -12 }, { at: NOW - 4 * H + 1, closedAt: NOW - 3 * H, pnl: -9 }];
  assert.deepEqual(stopDays(lost, 20, NOW), { days: 1, clean: 1, broke: 0 }, 'the limit hit on the last trade: fine');
  const chased = [...lost, { at: NOW - 2 * H, closedAt: NOW - H, pnl: -5 }];
  assert.deepEqual(stopDays(chased, 20, NOW), { days: 1, clean: 0, broke: 1 }, 'a buy after the limit hit');
  assert.equal(step(successMap({ trades: chased, settings: { dailyLossLimit: 20 }, now: NOW }), 'stop').done, false);
});

test('the coach warns at the limit, on loss streaks and on climbing stakes, most urgent first', () => {
  const losing = [trade(0, { won: false, contracts: 12 }), trade(1, { won: false, contracts: 12 }), trade(2, { won: false, contracts: 12 }), trade(3, { won: false, contracts: 12 }),
    ...Array.from({ length: 6 }, (_, i) => trade(i + 4, { contracts: 2, ago: (i + 4) * H + D }))];
  const m = successMap({ trades: losing, settings: { dailyLossLimit: 30 }, level: 'profit', now: NOW });
  assert.equal(m.you.today.hit, true);
  assert.deepEqual(m.coach.map((t) => t.kind), ['warn', 'warn', 'warn']);
  assert.equal(m.coach[0].title, 'Done for today');
  assert.ok(m.coach.some((t) => t.title === '4 losses in a row'));
  assert.ok(m.coach.some((t) => t.title === 'Your stakes are climbing'));
});

test('the coach reads the 10-minute pick and fills in with a tip of the day', () => {
  const pick = { closeTime: new Date(NOW + 5 * 60000).toISOString(), locksAt: NOW - 1, live: { side: 'NO', p: 0.7, buy: false, price: 0.7, closeTime: new Date(NOW + 5 * 60000).toISOString() }, stats: { graded: 4, wins: 3 }, last: { side: 'YES', result: 'yes' } };
  const m = successMap({ settings: { dailyLossLimit: 20 }, level: 'profit', pick, now: NOW });
  assert.ok(m.coach.some((t) => t.title === "This round's pick is PICK ONLY"));
  assert.equal(m.coach.at(-1).kind, 'tip'); assert.ok(EVERGREEN.includes(m.coach.at(-1).text));
  assert.deepEqual(m.pick, { locked: true, side: 'NO', buy: false, price: 0.7, locksAt: NOW - 1, last: 'won', graded: 4, wins: 3 });
});

test('youStats: profit after fees, win rate against break-even, and the running curve', () => {
  const trades = [trade(0), trade(1, { won: false }), trade(2)];
  const y = youStats(trades, 0, NOW);
  assert.equal(y.n, 3); assert.equal(y.wins, 2); assert.ok(Math.abs(y.pnl - trades.reduce((a, t) => a + t.pnl, 0)) < 1e-9);
  assert.ok(y.breakEven > 0.75 && y.breakEven < 0.8, 'the price plus its fee');
  assert.equal(y.curve.length, 3); assert.ok(Math.abs(y.curve.at(-1) - y.pnl) < 1e-9, 'the curve ends at the total');
  assert.ok(coachTips({ trades, you: y, limit: 20, level: 'profit', now: NOW }).length <= 3);
  assert.equal(MAP.stakeShare, 1 / 3);
});
