import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATES, indicatorRead, indicatorShift, samples, signalSeries, tuneIndicators } from '../public/tune.js';
import { createTuneFeed } from '../tunefeed.js';

let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
// 21 days of 1-minute BTC; `effect` > 0 makes the last 5 minutes' move carry on a little (a real trend edge)
function market(effect = 0, days = 21, s = 3) {
  seed = s;
  const bars = [], r = []; let p = 80000;
  for (let i = 0; i < days * 1440; i++) {
    const m5 = r.slice(-5).reduce((a, b) => a + b, 0), ret = 0.0008 * gauss() + effect * m5 / 5; r.push(ret);
    const o = p; p *= Math.exp(ret);
    bars.push({ t: Date.UTC(2026, 0, 1) + i * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 + rnd() });
  }
  return bars;
}

test('samples: 10, 6 and 3 minutes before each round close, the move to the close in typical moves', () => {
  const ss = samples(market(0, 2));
  assert.deepEqual([...new Set(ss.map((s) => s.m))].sort((a, b) => a - b), [3, 6, 10]);
  assert.ok(ss.length > 500 && ss.every((s) => Number.isFinite(s.y) && s.round % 900000 === 0));
});

test('pure noise: no indicator is proven, so nothing reaches the calls', () => {
  for (const s of [3, 11, 29]) {
    const r = tuneIndicators(market(0, 21, s));
    assert.equal(r.families.filter((f) => f.proven).length, 0, `seed ${s}: ${r.families.filter((f) => f.proven).map((f) => f.setting)}`);
    assert.ok(r.families.length >= 7 && new Set(r.families.map((f) => f.family)).size === r.families.length, 'one best setting per family');
    assert.ok(r.testRounds >= 600 && r.trainRounds > r.testRounds);
  }
});

test('a real trend edge is found on rounds it never saw, the right way round, and pushes the odds its way', () => {
  const bars = market(0.3);
  const r = tuneIndicators(bars), proven = r.families.filter((f) => f.proven);
  assert.ok(proven.length >= 2, JSON.stringify(r.families.map((f) => [f.setting, f.test.z])));
  assert.ok(proven.every((f) => f.dir === 1 && f.test.hit > 0.5 && f.strength > 0), 'trend, not fade');
  // a strong recent rise: the proven trend indicators say up
  const up = bars.slice(-400).map((b) => ({ ...b }));
  for (let k = 0; k < 20; k++) { const i = up.length - 20 + k, p = up[i - 1].c * 1.0006; up[i] = { ...up[i], o: up[i - 1].c, c: p, h: p, l: up[i - 1].c }; }
  const rd = indicatorRead(r, up);
  assert.ok(rd.drift > 0 && rd.active.length >= 1, JSON.stringify(rd));
  const sh = indicatorShift(rd.drift, { spot: 80000, strike: 80000, sigmaMin: 0.0008, minutesLeft: 6 });
  assert.ok(sh > 0 && sh <= 0.04);
});

test('the call nudge: a shift in P(YES), flipped for "less than" markets, capped at 4 points, off outside the round', () => {
  const m = { spot: 80000, strike: 80000, sigmaMin: 0.0008, minutesLeft: 6 };
  const a = indicatorShift(0.2, m);
  assert.ok(a > 0 && a <= 0.04);
  assert.equal(indicatorShift(5, m), 0.04);
  assert.equal(indicatorShift(0.2, { ...m, strikeType: 'less' }), -a);
  assert.ok(indicatorShift(0.2, { ...m, strike: 81000 }) < a, 'far from the target it matters less');
  assert.equal(indicatorShift(0.2, { ...m, minutesLeft: 0.5 }), 0);
  assert.equal(indicatorShift(0, m), 0);
});

test('every candidate gives one signal per candle in -1..1', () => {
  const bars = market(0, 1);
  for (const c of CANDIDATES) {
    const s = c.bars ? null : signalSeries(c, bars);
    if (s) { assert.equal(s.length, bars.length, c.id); assert.ok(s.every((v) => v == null || [-1, 0, 1].includes(v)), c.id); }
  }
});

test('tune feed: runs on the playbook candles, nudges the live market only when proven', () => {
  let bars = market(0.3), now = bars.at(-1).t + 60000;
  const feed = createTuneFeed({ playbook: { bars: () => bars }, clock: () => now });
  const snap = { spot: bars.at(-1).c, sigmaMin: 0.0008, live: { m: { ticker: 'T1', strike_type: 'greater' }, strike: bars.at(-1).c, ev: { minutesLeft: 6 } } };
  feed.observe({ snap });
  const api = feed.api();
  assert.ok(api.report.families.some((f) => f.proven));
  if (api.read.drift) assert.ok(Object.keys(feed.shifts()).includes('T1'));
  // noise: nothing proven, no nudge
  bars = market(0, 21, 11);
  const feed2 = createTuneFeed({ playbook: { bars: () => bars }, clock: () => now });
  feed2.observe({ snap });
  assert.equal(feed2.shifts(), null);
  // too little history: no report yet
  const feed3 = createTuneFeed({ playbook: { bars: () => bars.slice(0, 500) }, clock: () => now });
  feed3.observe({ snap });
  assert.equal(feed3.api().report, null);
});
