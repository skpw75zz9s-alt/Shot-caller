import test from 'node:test';
import assert from 'node:assert/strict';
import { PRED, FACTORS, factorsAt, fit, predictNow, predictorReport, predictorShift, samples, series, walkForward } from '../public/predictor.js';
import { createPlaybook } from '../playbookfeed.js';

const T0 = Date.UTC(2026, 0, 1);
function market({ days = 21, edge = 0, seed = 4 } = {}) {
  // mulberry32: a simple LCG has serial correlation (consecutive draws ~-0.04), which is a real pattern the model finds
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  const g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const bars = [], r = []; let p = 80000, m = 0;
  for (let i = 0; i < days * 1440; i++) { const ret = 0.0008 * g() + edge * m / 60; r.push(ret); m += ret; if (r.length > 60) m -= r[r.length - 61]; const o = p; p *= Math.exp(ret); bars.push({ t: T0 + i * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 + rnd() }); }
  return bars;
}

test('factors use only candles closed by then (changing the future changes nothing)', () => {
  const bars = market({ days: 4 }), S = series(bars), i = 4000;
  const f1 = factorsAt(S, i);
  const later = bars.map((b, j) => (j > i ? { ...b, c: b.c * 1.05, h: b.h * 1.05, l: b.l * 1.05, o: b.o * 1.05 } : b));
  assert.deepEqual(factorsAt(series(later), i), f1);
  assert.deepEqual(Object.keys(f1), FACTORS);
  for (const v of Object.values(f1)) assert.ok(Number.isFinite(v) && Math.abs(v) <= 3);
});

test('samples: 15, 10, 5 and 2 minutes before each close; at the open the distance odds are 50/50', () => {
  const ss = samples(market({ days: 4 }));
  assert.deepEqual([...new Set(ss.map((s) => s.m))].sort((a, b) => a - b), [2, 5, 10, 15]);
  assert.ok(ss.filter((s) => s.m === 15).every((s) => Math.abs(s.base - 0.5) < 1e-9));
});

test('pure noise: never beats the distance odds, so it never touches the calls; momentum at the open is a coin flip', () => {
  for (const seed of [3, 11]) {
    const rep = predictorReport(walkForward(market({ seed })).rows);
    assert.equal(rep.proven, false, `seed ${seed} z ${rep.z}`);
    assert.ok(Math.abs(rep.momentum.accuracy - 0.5) < 0.06, `momentum ${rep.momentum.accuracy}`);
  }
});

test('a real edge is found walk-forward and beats the distance odds', () => {
  const rep = predictorReport(walkForward(market({ edge: 0.6 })).rows);
  assert.ok(rep.proven && rep.brier < rep.brierDistance, `z ${rep.z} ${rep.brier} vs ${rep.brierDistance}`);
});

test('90%+ calls: accurate only late in the round, and the distance odds alone get the same accuracy', () => {
  const rep = predictorReport(walkForward(market({ seed: 3 })).rows);
  const at = (m) => rep.byCheckpoint[m].thresholds.find((x) => x.t === 0.9);
  assert.equal(at(15).model.n, 0, 'nobody is 90% sure at the open');
  assert.ok(at(2).model.n > 100 && at(2).model.accuracy >= 0.9, `2 min: ${at(2).model.accuracy}`);
  assert.ok(Math.abs(at(2).model.accuracy - at(2).distance.accuracy) < 0.03, 'the distance odds do just as well');
});

test('live: needs fresh candles; gives P(UP) and P(DOWN) from the nearest checkpoint model', () => {
  const bars = market({ days: 4 }), S = series(bars), models = Object.fromEntries(PRED.checkpoints.map((m) => [m, fit(samples(bars, S).filter((s) => s.m === m))]));
  const now = bars.at(-1).t + 60000 + 5000, strike = bars.at(-8).c;
  const p = predictNow(S, models, { price: bars.at(-1).c, strike, minutesLeft: 6, now });
  assert.equal(p.checkpoint, 5); assert.ok(Math.abs(p.pUp + p.pDown - 1) < 1e-12);
  assert.equal(predictNow(S, models, { price: bars.at(-1).c, strike, minutesLeft: 6, now: now + 10 * 60000 }), null, 'stale candles are not a live signal');
  assert.equal(predictNow(S, models, { price: bars.at(-1).c, strike, minutesLeft: 20, now }), null);
});

test('the call nudge: only once proven; flipped on "less than" markets; capped', () => {
  const live = { pUp: 0.7, base: 0.6 };
  assert.equal(predictorShift(live, { proven: false }), 0);
  assert.equal(predictorShift(live, { proven: true }), PRED.cap);
  assert.equal(predictorShift(live, { proven: true }, 'less'), -PRED.cap);
  assert.ok(Math.abs(predictorShift({ pUp: 0.61, base: 0.6 }, { proven: true }) - 0.01) < 1e-12);
});

test('playbook feed: serves the live forecast with Kalshi\'s prices and records a read at each checkpoint', async () => {
  const bars = market({ days: 4 }), close = Math.floor(bars.at(-1).t / 900000) * 900000 + 900000;
  let now = close - 10 * 60000 + 2000;
  const pb = createPlaybook({ coinbase: 'x', file: '/nonexistent/dir/bars.json', fetchJSON: async () => [], clock: () => now, log: { error() {}, warn() {} } });
  pb.merge(bars.filter((b) => b.t + 60000 <= now)); pb.rerun();
  const m = { ticker: 'P1', strike_type: 'greater', open_time: new Date(close - 900000).toISOString(), close_time: new Date(close).toISOString(), yes_ask: 60, yes_bid: 58, no_ask: 42 };
  pb.observe({ snap: { spot: bars.at(-1).c, sigmaMin: 0.0008, live: { m, strike: bars.at(-1).c - 20, ev: { minutesLeft: 10 } } } }, now);
  const api = pb.api();
  assert.ok(api.predictor && api.predictor.kalshi.UP.contract === 'YES' && api.predictor.kalshi.DOWN.contract === 'NO');
  assert.equal(api.predictor.invalidation, bars.at(-1).c - 20);
  assert.ok(api.report.predictor.byCheckpoint[10]);
  assert.equal(api.predictorLive.reads, 0, 'graded only after the close');
});
