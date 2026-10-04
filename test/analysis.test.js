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

test('deepDive scores a strong call high and a weak one low, with reasons', () => {
  const now = OPEN;
  const strongEv = evaluate({ market: market(2, 52, 53), strike: K, spot: 100080, sigmaMin: 0.0006, now });
  const strong = deepDive({ ev: strongEv, side: 'YES', rej: { tilt: 0.03, summary: ['Target held 2× as support'] }, timing: { state: 'NOW' },
    sigmaMin: 0.0006, sigmaLong: 0.0008, driftMin: 0.0001, spot: 100080, strike: K, kalshiDrift: 0.04 });
  assert.ok(strong.score >= 75, `score ${strong.score}`);
  assert.equal(strong.sizeMult, 1);
  assert.equal(strong.grade, undefined, 'no letter grades');
  assert.ok(strong.checks.some((c) => c.ok && /Rejections favor YES/.test(c.label)));

  const weakEv = evaluate({ market: market(13, 40, 41), strike: K, spot: 99990, sigmaMin: 0.0012, now });
  const weak = deepDive({ ev: weakEv, side: 'YES', rej: { tilt: -0.03, summary: ['Target rejected 3× from below'] }, timing: { state: 'CHASE' },
    sigmaMin: 0.0012, sigmaLong: 0.0005, driftMin: -0.0001, spot: 99990, strike: K, kalshiDrift: -0.05 });
  assert.ok(weak.score < 45, `score ${weak.score}`);
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

test('frozen tape: tiny wicks are not "pressure", and the ratio text stays sane', () => {
  const flat = [...Array(8)].map((_, i) => bar(i, 99990, 99990.01, 99989.99 - (i % 2) * 0.01, 99990));
  const r = rejections([...pre, ...flat], K, OPEN, afterAll(flat));
  assert.equal(r.wickBias, 0);
  assert.ok(!r.summary.some((s) => /wicks/.test(s)));
  const real = [...Array(6)].map((_, i) => bar(i, 99950, 99951, 99920, 99951)); // no upper wicks, ~30-long lower wicks
  const r2 = rejections([...pre, ...real], K, OPEN, afterAll(real));
  assert.ok(r2.summary.some((s) => /lower wicks far longer than upper/.test(s)));
  assert.ok(!r2.summary.some((s) => /\d{4,}\.\d×/.test(s)));
});

// ---------- v2.6: sharper deep dive ----------
const NOW2 = OPEN + 10 * 60000;
const trendBars = (dir) => [...Array(40)].map((_, i) => { const c = 100000 + dir * i * 3; return { t: NOW2 - (40 - i) * 60000, o: c - dir * 3, h: c + 2, l: c - 5, c }; });
const logOf = (ps, ask = 0.5) => ps.map((p, i) => ({ t: NOW2 - (ps.length - 1 - i) * 2000, p, yesAsk: ask, noAsk: 1 - ask + 0.02 }));

test('strong confluence scores 75+; a flip-flopping, fading read scores under 60', () => {
  const ev = evaluate({ market: market(5, 50, 52), strike: K, spot: 100070, sigmaMin: 0.0006, now: OPEN });
  const base = { ev, side: 'YES', rej: { tilt: 0.02, summary: ['Target held 2× as support'] }, timing: { state: 'WAIT' }, sigmaMin: 0.0006, sigmaLong: 0.0006, spot: 100070, strike: K, now: NOW2 };
  const strong = deepDive({ ...base, bars: trendBars(1), log: logOf([...Array(90)].map((_, i) => 0.6 + i * 0.0015)) });
  assert.ok(strong.score >= 75, JSON.stringify(strong.checks));
  for (const re of [/Trend lines up with YES on 3\/10\/30 min/, /favored YES for 3 min straight/, /Odds building toward YES/, /Edge has held for 30\+ seconds/]) {
    assert.ok(strong.checks.some((c) => c.ok && re.test(c.label)), String(re));
  }
  const choppy = deepDive({ ...base, rej: { tilt: 0, summary: [] }, bars: trendBars(-1), log: logOf([...Array(90)].map((_, i) => (i % 3 ? 0.45 : 0.6) - i * 0.0015), 0.5) });
  assert.ok(choppy.score < 60, `${choppy.score} ${JSON.stringify(choppy.checks)}`);
  for (const re of [/Trend is against YES/, /read keeps flipping/, /Odds fading/, /Edge just appeared/]) {
    assert.ok(choppy.checks.some((c) => c.ok === false && re.test(c.label)), String(re));
  }
});

test('callsByConfidence groups follow-the-bot results by confidence at entry', async () => {
  const { callsByConfidence } = await import('../public/tracker.js');
  const out = callsByConfidence([{ trades: [{ conf: 80, pts: 0.3, entry: 0.5 }, { conf: 78, pts: -0.52, entry: 0.5 }, { conf: 62, pts: 0.1, entry: 0.4 }, { conf: null, pts: 1, entry: 0.5 }] }]);
  assert.deepEqual(Object.keys(out).sort(), ['60–69', '70–79', '80+']);
  assert.equal(out['80+'].calls, 1);
  assert.equal(out['80+'].wins, 1);
  assert.equal(out['70–79'].calls, 1);
  assert.ok(Math.abs(out['70–79'].usd + 10.4) < 1e-9);
  assert.equal(out['60–69'].calls, 1);
});
