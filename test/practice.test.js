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

test('Range watch reads ceiling and floor rejections like the chart guideline', async () => {
  const { rangeRead } = await import('../public/practice.js');
  // 20 candles bouncing between a 100 floor and a 110 ceiling, each touched several times
  const bars = Array.from({ length: 20 }, (_, i) => { const up = i % 4 === 0, dn = i % 4 === 2; return { t: i * 60000, o: 105, h: up ? 110 : 106, l: dn ? 100 : 104, c: 105 }; });
  const ceilRej = rangeRead([...bars, { t: 20 * 60000, o: 107, h: 110.2, l: 106, c: 107 }]);
  assert.equal(ceilRej.ranged, true);
  assert.equal(ceilRej.dir, -1);
  assert.match(ceilRej.why, /ceiling \$110: expect down/);
  assert.equal(rangeRead([...bars, { t: 20 * 60000, o: 103, h: 104, l: 99.9, c: 103 }]).dir, 1);
  assert.equal(rangeRead([...bars, { t: 20 * 60000, o: 105, h: 106, l: 104, c: 105 }]).dir, 0);
  // a trend with no repeated touches is not a range
  const trend = Array.from({ length: 21 }, (_, i) => ({ t: i * 60000, o: 100 + i, h: 101 + i, l: 99.5 + i, c: 100.8 + i }));
  assert.equal(rangeRead(trend).ranged, false);
});

test('Range watch paper-trades its own book: ceiling rejection buys NO once per window, settles separately', async () => {
  const { rangeStep, rangeStats, newPractice, practiceSettle } = await import('../public/practice.js');
  const t0 = Date.parse('2026-10-04T12:08:30Z');
  const bars = Array.from({ length: 20 }, (_, i) => { const up = i % 4 === 0, dn = i % 4 === 2; return { t: t0 - (21 - i) * 60000, o: 105, h: up ? 110 : 106, l: dn ? 100 : 104, c: 105 }; });
  bars.push({ t: t0 - 60000, o: 107, h: 110.2, l: 106, c: 107 }); // last closed candle: rejected at the ceiling
  bars.push({ t: t0, o: 107, h: 107, l: 107, c: 107 });             // live candle (ignored)
  const r = { m: { ticker: 'KXBTC15M-R', close_time: new Date(t0 + 6 * 60000).toISOString() }, ev: { open: true, quote: { yesBid: 0.55, yesAsk: 0.57, noBid: 0.43, noAsk: 0.45 } } };
  const pr = newPractice();
  const { actions, read } = rangeStep(pr, { snap: { bars }, row: r, cfg: { on: true }, now: t0 });
  assert.equal(read.dir, -1);
  assert.equal(actions[0].side, 'NO');
  assert.equal(actions[0].price, 0.45);
  assert.equal(pr.positions.length, 0, "the bot's own practice book is untouched");
  assert.equal(rangeStep(pr, { snap: { bars }, row: r, cfg: { on: true }, now: t0 + 5000 }).actions.length, 0, 'once per window');
  assert.equal(rangeStep(newPractice(), { snap: { bars }, row: r, cfg: { on: false }, now: t0 }).actions.length, 0, 'off = nothing');
  practiceSettle(pr, 'KXBTC15M-R', 'no', t0 + 600000);
  const st = rangeStats(pr);
  assert.equal(st.trades, 1);
  assert.equal(st.wins, 1);
  assert.ok(st.pnl > 0);
});

test('Range watch uses the exact rule from the offline study (same events on the real-candle sample)', async () => {
  const { rangeRead } = await import('../public/practice.js');
  const { STUDY_SAMPLE, STUDY_EVENTS } = await import('./fixtures/range-sample.js');
  let events = 0;
  for (const series of STUDY_SAMPLE) {
    const B = series.map(([o, h, l, c], i) => ({ t: i * 60000, o, h, l, c }));
    for (let i = 20; i < B.length - 1; i++) if (rangeRead(B.slice(0, i + 1))?.dir) events++;
  }
  assert.equal(events, STUDY_EVENTS);
});
