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
  for (const label of [/Rejections against YES/, /momentum is against/, /Chasing/, /Volatility spiking/]) {
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

// ---------- v3.1: fairer confidence ----------
test('Kalshi dipping while the bot holds is the low, not a penalty; both fading still counts against', () => {
  const ev = { pYes: 0.62, evYes: 0.18, evNo: -0.3, minutesLeft: 6, quote: { yesBid: 0.40, yesAsk: 0.42 } };
  const base = { ev, side: 'YES', rej: { tilt: 0, summary: [] }, timing: { state: 'WAIT' }, sigmaMin: 0.0006, sigmaLong: 0.0006, spot: 100030, strike: 100000, kalshiDrift: -0.06, now: NOW2 };
  const holding = deepDive({ ...base, log: logOf([...Array(60)].map(() => 0.62)) });
  assert.ok(holding.checks.some((c) => c.pts === 0 && /that's the low/.test(c.label)));
  assert.ok(!holding.checks.some((c) => c.pts < 0 && /Kalshi/.test(c.label)));
  const fading = deepDive({ ...base, log: logOf([...Array(60)].map((_, i) => 0.7 - i * 0.002)) });
  assert.ok(fading.checks.some((c) => c.pts === -5 && /both moving against/.test(c.label)));
  assert.ok(holding.score > fading.score);
});

test('stress test rewards robust edges and flags fragile ones', () => {
  const ev = { pYes: 0.62, evYes: 0.18, evNo: -0.3, minutesLeft: 6, quote: { yesBid: 0.40, yesAsk: 0.42 } };
  const base = { ev, side: 'YES', rej: { tilt: 0, summary: [] }, sigmaMin: 0.0006, sigmaLong: 0.0006, spot: 100030, strike: 100000, now: NOW2 };
  const robust = deepDive({ ...base, stressEdge: 0.09 });
  const fragile = deepDive({ ...base, stressEdge: -0.05 });
  assert.ok(robust.checks.some((c) => c.pts === 6 && /holds under a stress test/.test(c.label)));
  assert.ok(fragile.checks.some((c) => c.pts === -4 && /flips negative under a stress test/.test(c.label)));
  const thin = deepDive({ ...base, stressEdge: 0.01 });
  assert.ok(thin.checks.some((c) => c.pts === 2 && /survives a stress test/.test(c.label)));
  assert.equal(robust.score - fragile.score, 10);
});

test('buySignal runs the stress test with the real market and fallback sizing is honest', async () => {
  const ev = evaluate({ market: market(6, 44, 45), strike: K, spot: 100030, sigmaMin: 0.0006, now: OPEN });
  const row = { m: { ...market(6, 44, 45), ticker: 'T1' }, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } };
  const snap = { now: OPEN, bars: pre, sigmaMin: 0.0006, sigmaLong: 0.0006, driftMin: 0, spot: 100030, quoteLog: {} };
  const sig = buySignal(row, snap, {}, OPEN);
  assert.ok(sig.deep.checks.some((c) => /stress test/.test(c.label)), 'stress test ran');
});

test('stress test never makes a call look better than the real edge', () => {
  // Momentum and rejections working AGAINST a YES call must stay in the stressed price
  const m = { ...market(6, 44, 45), ticker: 'T2' };
  const evAdverse = evaluate({ market: m, strike: K, spot: 100030, sigmaMin: 0.0006, driftMin: -0.0002, pShift: -0.03, now: OPEN, settings: { momentumWeight: 0.25 } });
  const row = { m, strike: K, ev: evAdverse, rej: { tilt: -0.03, summary: ['x'], events: [] } };
  const snap = { now: OPEN, bars: pre, sigmaMin: 0.0006, sigmaLong: 0.0006, driftMin: -0.0002, spot: 100030, quoteLog: {} };
  const sig = buySignal(row, snap, { momentumWeight: 0.25 }, OPEN);
  const st = sig.deep.checks.find((c) => /stress test/.test(c.label));
  const realEdge = evAdverse.evYes;
  const m2 = st.label.match(/\+([\d.]+) pts/);
  if (m2) assert.ok(Number(m2[1]) / 100 <= realEdge + 1e-9, `stressed ${m2[1]} pts must not exceed real ${(realEdge * 100).toFixed(1)} pts`);
});

test('robust edge: no call when the gap only exists at one volatility guess', async () => {
  const { snapshot, buySignal } = await import('../public/engine.js');
  const OPEN2 = Date.parse('2026-10-04T12:00:00Z'), now = OPEN2 + 8 * 60000;
  const bars = Array.from({ length: 130 }, (_, i) => { const t = now - (130 - i) * 60000, c = 100000 + Math.sin(i) * 12; return { t, o: c - 3, h: c + 8, l: c - 8, c }; });
  const mk = (yb) => [{ ticker: 'R1', open_time: new Date(OPEN2).toISOString(), close_time: new Date(OPEN2 + 900000).toISOString(), strike_type: 'greater_or_equal', floor_strike: 100000, yes_bid: yb, yes_ask: yb + 2 }];
  const at = (yb) => { const snap = snapshot({ markets: mk(yb), candles: bars, spot: 100060, settings: {}, now }); return buySignal(snap.live, snap, {}, now); };
  // Find a price where the point estimate clears 8 pts but the robust edge doesn't
  let thin = null;
  for (let yb = 90; yb >= 40 && !thin; yb--) { const s = at(yb); if (s.side && s.robustEdge != null && s.robustEdge < 0.08) { const snap = snapshot({ markets: mk(yb), candles: bars, spot: 100060, settings: {}, now }); if (snap.live.ev.edge >= 0.08) thin = s; } }
  assert.ok(thin, 'found a gap that only exists at the point estimate');
  assert.equal(thin.fire, false);
  assert.equal(thin.robust, false);
});

test('sticks with its call: holds at a lower bar, and switching sides needs clearly stronger evidence', async () => {
  const { snapshot, buySignal } = await import('../public/engine.js');
  const OPEN3 = Date.parse('2026-10-04T13:00:00Z'), now = OPEN3 + 8 * 60000;
  const bars = Array.from({ length: 130 }, (_, i) => { const t = now - (130 - i) * 60000, c = 100000 + Math.sin(i) * 12; return { t, o: c - 3, h: c + 8, l: c - 8, c }; });
  const mk = (yb) => [{ ticker: 'S1', open_time: new Date(OPEN3).toISOString(), close_time: new Date(OPEN3 + 900000).toISOString(), strike_type: 'greater_or_equal', floor_strike: 100000, yes_bid: yb, yes_ask: yb + 2 }];
  const S = { minConfidence: 0 };
  const run = (yb, memory, spot = 100015) => { const snap = snapshot({ markets: mk(yb), candles: bars, spot, settings: S, now }); return buySignal(snap.live, snap, S, now, memory); };
  const memory = {};
  const first = run(20, memory);
  assert.equal(first.callSide, 'YES');
  assert.equal(first.fire, true);
  assert.equal(memory.S1.side, 'YES');
  // Max price: at or above today's price, and buying there still clears half the min gap with vol 20% off
  assert.ok(first.limit >= first.price, `limit ${first.limit} vs price ${first.price}`);
  const { kalshiFee, DEFAULTS: D0 } = await import('../public/model.js');
  const half = D0.minEdge * D0.limitEdgeFrac;
  const pRobust = first.robustEdge + first.price + kalshiFee(first.price);
  assert.ok(pRobust - first.limit - kalshiFee(first.limit) >= half - 1e-9);
  assert.ok(pRobust - (first.limit + 0.01) - kalshiFee(first.limit + 0.01) < half, 'and it is the highest such price');
  // Raise Kalshi's YES price until a fresh call would no longer fire; the existing call still stands
  let held = null;
  for (let yb = 20; yb <= 90 && !held; yb++) {
    const fresh = run(yb, {});
    const sticky = run(yb, memory);
    if (!fresh.callSide && sticky.callSide === 'YES') held = sticky;
  }
  assert.ok(held, 'call held where a fresh call would not fire');
  assert.equal(held.stance, 'holding');
  assert.equal(held.fire, false, 'holding does not re-alert');
  // With BTC dropping under the target, NO looks a little cheap: not enough to flip the call
  const { DEFAULTS } = await import('../public/model.js');
  const SWITCH = DEFAULTS.minEdge + DEFAULTS.switchEdgeExtra;
  let flipped = false, sawSmallNo = false;
  for (let yb = 30; yb <= 70; yb++) {
    const fresh = run(yb, {}, 99990), sticky = run(yb, structuredClone(memory), 99990);
    if (fresh.callSide === 'NO' && sticky.callSide !== 'NO') sawSmallNo = true;
    if (sticky.callSide === 'NO' && sticky.stance === 'switching' && (sticky.edge < SWITCH - 1e-9)) flipped = true;
  }
  assert.ok(sawSmallNo, 'a NO edge that would be a fresh call is not enough to switch');
  assert.equal(flipped, false, 'switching needs min gap + 4 pts');
});

test('re-entry: after a sale the call is released, blocked for the cooldown, then a new call can fire', async () => {
  const { snapshot, buySignal, releaseCall } = await import('../public/engine.js');
  const OPEN4 = Date.parse('2026-10-04T14:00:00Z'), now = OPEN4 + 7 * 60000;
  const bars = Array.from({ length: 130 }, (_, i) => { const t = now - (130 - i) * 60000, c = 100000 + Math.sin(i) * 12; return { t, o: c - 3, h: c + 8, l: c - 8, c }; });
  const mk = [{ ticker: 'RE1', open_time: new Date(OPEN4).toISOString(), close_time: new Date(OPEN4 + 900000).toISOString(), strike_type: 'greater_or_equal', floor_strike: 100000, yes_bid: 20, yes_ask: 22 }];
  const S = { minConfidence: 0 };
  const run = (t, memory) => { const snap = snapshot({ markets: mk, candles: bars, spot: 100015, settings: S, now: t }); return buySignal(snap.live, snap, S, t, memory); };
  const memory = {};
  const a = run(now, memory);
  assert.equal(a.fire, true); assert.equal(a.callN, 1);
  assert.equal(run(now + 2000, memory).fire, false, 'holding: no re-alert');
  releaseCall(memory, 'RE1', now + 3000);
  assert.equal(run(now + 10000, memory).fire, false, 'cooling down for 15s after the sale');
  const b = run(now + 19000, memory);
  assert.equal(b.fire, true, 'a fresh call after the cooldown');
  assert.equal(b.callN, 2, 'counted, so its alert is not deduped against the first');
});

test('Aggressive scale-in: one add per tier as the gap grows, none on Safe', async () => {
  const { snapshot, buySignal } = await import('../public/engine.js');
  const { RISK_LEVELS } = await import('../public/model.js');
  const OPEN5 = Date.parse('2026-10-04T15:00:00Z'), now = OPEN5 + 7 * 60000;
  const bars = Array.from({ length: 130 }, (_, i) => { const t = now - (130 - i) * 60000, c = 100000 + Math.sin(i) * 12; return { t, o: c - 3, h: c + 8, l: c - 8, c }; });
  const mk = (yb) => [{ ticker: 'SC1', open_time: new Date(OPEN5).toISOString(), close_time: new Date(OPEN5 + 900000).toISOString(), strike_type: 'greater_or_equal', floor_strike: 100000, yes_bid: yb, yes_ask: yb + 2 }];
  const fair = snapshot({ markets: mk(50), candles: bars, spot: 100015, settings: {}, now }).live.ev.pYes;
  const go = (S, yb, memory, t) => { const snap = snapshot({ markets: mk(yb), candles: bars, spot: 100015, settings: S, now: t }); return buySignal(snap.live, snap, S, t, memory); };
  for (const [level, expectAdds] of [['aggressive', true], ['safe', false]]) {
    const r = RISK_LEVELS[level], S = { minEdge: r.minEdge, minConfidence: 0, scaleIn: !!r.scaleIn };
    const memory = {}; let fired = 0, adds = 0, t = now;
    // Kalshi's YES price falls step by step: the gap widens from just over the min gap to ~15 pts
    for (let yb = Math.round(fair * 100) - 2 - Math.round(r.minEdge * 100) - 3; yb >= Math.round(fair * 100) - 20; yb--) {
      const sg = go(S, yb, memory, (t += 3000)); if (sg.fire) fired++; if (sg.add) adds++;
    }
    assert.equal(fired, 1, `${level}: one call`);
    if (expectAdds) assert.ok(adds >= 2 && adds <= 3, `aggressive adds once per tier (${adds})`);
    else assert.equal(adds, 0, 'safe never adds');
  }
});
