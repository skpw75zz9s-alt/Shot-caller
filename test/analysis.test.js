import test from 'node:test';
import assert from 'node:assert/strict';
import { deepDive, freshRejection, quoteTrend, rejections } from '../public/analysis.js';
import { evaluate } from '../public/model.js';
import { buySignal } from '../public/engine.js';

const OPEN = 1_700_000_040_000; // window open, on a minute boundary
const K = 100000;
// 20 quiet bars before the window so ATR is ~20
const pre = [...Array(20)].map((_, i) => ({ t: OPEN - (20 - i) * 60000, o: 99950, c: 99952, h: 99962, l: 99942 }));
const at = (i) => OPEN + i * 60000;
const bar = (i, o, h, l, c) => ({ t: at(i), o, h, l, c });
const afterAll = (bars) => bars[bars.length - 1].t + 60000;

test('counts target rejections from below while price stays under it', () => {
  const w = [
    bar(0, 99950, 99965, 99940, 99960), bar(1, 99960, 100003, 99955, 99962), // wick up to target, closed below
    bar(2, 99962, 99970, 99945, 99950), bar(3, 99950, 99999, 99945, 99958),
    bar(4, 99958, 99965, 99940, 99948), bar(5, 99948, 100004, 99944, 99955),
  ];
  const r = rejections([...pre, ...w], K, OPEN, afterAll(w));
  assert.equal(r.strikeCaps, 3);
  assert.equal(r.bias, 'bearish');
  assert.ok(r.tilt < 0);
  assert.match(r.summary[0], /rejected 3× from below/);
  assert.equal(freshRejection(r, 'YES', afterAll(w)), 'Rejected at the target');
  assert.equal(r.lowHolds >= 1, true); // lows ~99,940 were retested and held: correctly a warning for NO
  assert.equal(freshRejection(r, 'NO', afterAll(w)), 'Bounced off the window low');
});

test('a close through the target breaks the old rejections (breakout)', () => {
  const w = [
    bar(0, 99950, 99965, 99940, 99960), bar(1, 99960, 100003, 99955, 99962),
    bar(2, 99962, 99970, 99945, 99950), bar(3, 99950, 99999, 99945, 99958),
    bar(4, 99958, 100060, 99955, 100050),
  ];
  const r = rejections([...pre, ...w], K, OPEN, afterAll(w));
  assert.equal(r.strikeCaps, 0);
  assert.equal(r.broken, 'caps');
  assert.ok(r.summary.some((s) => /breakout/.test(s)));
  assert.ok(r.tilt > -0.008, 'no longer bearish');
});

test('target holding as support from above is bullish', () => {
  const w = [
    bar(0, 100050, 100060, 100040, 100045), bar(1, 100045, 100050, 99997, 100040),
    bar(2, 100040, 100055, 100035, 100048), bar(3, 100048, 100052, 100001, 100042),
    bar(4, 100042, 100058, 100036, 100050),
  ];
  const r = rejections([...pre, ...w], K, OPEN, afterAll(w));
  assert.equal(r.strikeFloors, 2);
  assert.equal(r.bias, 'bullish');
  assert.equal(freshRejection(r, 'NO', afterAll(w)), 'Target held as support');
});

test('wick pressure and structure', () => {
  const up = [...Array(8)].map((_, i) => { const o = 99900 + i * 15; return bar(i, o, o + 18, o - 30, o + 12); });
  const r = rejections([...pre, ...up], K, OPEN, afterAll(up));
  assert.ok(r.wickBias > 0.25);
  assert.equal(r.structure, 'higher highs & lows');
  assert.ok(r.summary.some((s) => /Buyers absorbing dips/.test(s)));
  assert.deepEqual(rejections(pre, K, OPEN, OPEN + 30000).summary, ['Window just opened: watching for rejections']);
});

test('quoteTrend measures how Kalshi moved over ~2 minutes', () => {
  const now = OPEN + 10 * 60000;
  const log = [{ t: now - 110000, yesAsk: 0.45, noAsk: 0.57 }, { t: now - 50000, yesAsk: 0.42, noAsk: 0.60 }, { t: now, yesAsk: 0.38, noAsk: 0.64 }];
  assert.ok(Math.abs(quoteTrend(log, 'YES', now) + 0.07) < 1e-9);
  assert.ok(Math.abs(quoteTrend(log, 'NO', now) - 0.07) < 1e-9);
  assert.equal(quoteTrend(log.slice(-1), 'YES', now), null);
});

const market = (min, yb, ya) => ({ close_time: new Date(OPEN + min * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya });

test('deepDive grades a strong call A and a weak one D, with reasons', () => {
  const now = OPEN;
  const strongEv = evaluate({ market: market(2, 52, 53), strike: K, spot: 100080, sigmaMin: 0.0006, now });
  const strong = deepDive({ ev: strongEv, side: 'YES', rej: { tilt: 0.03, summary: ['Target held 2× as support'] }, timing: { state: 'NOW' },
    sigmaMin: 0.0006, sigmaLong: 0.0008, driftMin: 0.0001, spot: 100080, strike: K, kalshiDrift: 0.04 });
  assert.equal(strong.grade, 'A');
  assert.ok(strong.checks.some((c) => c.ok && /Rejections favor YES/.test(c.label)));

  const weakEv = evaluate({ market: market(13, 40, 41), strike: K, spot: 99990, sigmaMin: 0.0012, now });
  const weak = deepDive({ ev: weakEv, side: 'YES', rej: { tilt: -0.03, summary: ['Target rejected 3× from below'] }, timing: { state: 'CHASE' },
    sigmaMin: 0.0012, sigmaLong: 0.0005, driftMin: -0.0001, spot: 99990, strike: K, kalshiDrift: -0.05 });
  assert.equal(weak.grade, 'D');
  assert.equal(weak.sizeMult, 0);
  for (const label of [/Rejections against YES/, /momentum is against/, /Chasing/, /Volatility spiking/, /Early in the window/, /Kalshi moving against/]) {
    assert.ok(weak.checks.some((c) => c.ok === false && label.test(c.label)), String(label));
  }
});

test('buySignal only fires when the deep dive clears minConfidence', () => {
  const now = OPEN;
  const ev = evaluate({ market: market(6, 44, 45), strike: K, spot: 100030, sigmaMin: 0.0006, now });
  assert.equal(ev.side, 'YES');
  const row = { m: { ticker: 'T1' }, strike: K, ev, rej: { tilt: -0.04, summary: ['Target rejected 2× from below'], events: [] } };
  const snap = { now, bars: pre, sigmaMin: 0.0006, sigmaLong: 0.0006, driftMin: -0.0001, spot: 100030, quoteLog: {} };
  const strict = buySignal(row, snap, { minConfidence: 90 }, now);
  assert.equal(strict.fire, false);
  assert.ok(strict.deep.score < 90);
  const loose = buySignal(row, snap, { minConfidence: 0 }, now);
  assert.equal(loose.fire, true);
  assert.ok(loose.contracts >= 1 && loose.contracts <= ev.contracts);
});
