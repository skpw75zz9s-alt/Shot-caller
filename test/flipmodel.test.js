import test from 'node:test';
import assert from 'node:assert/strict';
import { FLIP, chartFeatures, chartSamples, evaluate, flipCheck, flowSamples, mathFlip } from '../public/flipmodel.js';
import { createFlipFeed } from '../flipfeed.js';

const T0 = Date.UTC(2026, 9, 1), MIN = 60000;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; }
// 1-minute candles; ar > 0: each minute carries part of the last one (momentum), which the bot's random-walk math misses
function bars(n, { ar = 0, seed = 4 } = {}) {
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r()), out = [];
  let p = 100000, prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = ar * prev + 0.0008 * g(), o = p; p *= Math.exp(ret); prev = ret;
    out.push({ t: T0 + i * MIN, o, h: Math.max(o, p) * (1 + 0.0002 * r()), l: Math.min(o, p) * (1 - 0.0002 * r()), c: p, v: 1 + r() });
  }
  return out;
}

test('the chart reads point toward a flip: momentum against the leader, a rejection wick', () => {
  const b = bars(100), i = 99, base = { sigma: 0.0008, roundStart: b[90].t };
  const fall = b.map((x, k) => (k >= 96 ? { ...x, c: b[95].c * (1 - 0.002 * (k - 95)) } : x));
  assert.ok(chartFeatures(fall, i, { ...base, lead: 1 })[0] > 0, 'falling while UP leads: toward a flip');
  assert.ok(chartFeatures(fall, i, { ...base, lead: -1 })[0] < 0, 'falling while DOWN leads: away from one');
  assert.ok(Math.abs(mathFlip(101, 100, 0.001, 4) - 0.0) < 1e-6 && Math.abs(mathFlip(100.01, 100, 0.001, 4) - 0.48) < 0.01);
});

test('a fair random walk: the bot\'s math is right, the flip check proves nothing and changes nothing', () => {
  const ss = chartSamples(bars(30240, { seed: 11 }));
  assert.ok(ss.length > 5000);
  const e = evaluate(ss, FLIP.minChart);
  assert.ok(Math.abs(e.flipRate - e.mathRate) < 0.03, `${e.flipRate} vs ${e.mathRate}`);
  assert.equal(e.proven, false, JSON.stringify({ z: e.z, gain: e.gain }));
  const fc = flipCheck({ pLead: 0.8, chart: e, chartX: ss[0].x });
  assert.ok(Math.abs(fc.p - 0.2) < 1e-9 && !fc.used, 'unproven: the bot\'s own 20%');
});

test('history the bot\'s math gets wrong (trending minutes): caught on rounds it never saw, and corrected', () => {
  const ss = chartSamples(bars(60480, { ar: 0.4, seed: 7 })), e = evaluate(ss, FLIP.minChart);
  assert.ok(e.proven && e.gain > 0.01, JSON.stringify({ z: e.z, gain: e.gain, nTest: e.nTest }));
  assert.ok(e.flipRate - e.mathRate > 0.03, `leaders lose more often than the math says: ${e.flipRate} vs ${e.mathRate}`);
  const fitted = ss.reduce((a, s) => a + flipCheck({ pLead: 1 - s.base, chart: e, chartX: s.x }).p, 0) / ss.length;
  assert.ok(Math.abs(fitted - e.flipRate) < Math.abs(e.mathRate - e.flipRate) / 3, `fitted ${fitted} vs actual ${e.flipRate}`);
  const fc = flipCheck({ pLead: 0.8, chart: e, chartX: ss[5].x });
  assert.ok(fc.used && fc.parts.length && fc.p !== 0.2);
});

test('buyers and sellers: the tape\'s graded samples, turned against the leader, learned only when they predict', () => {
  const r = rng(3), ss = [];
  for (let i = 0; i < 1500; i++) {
    const pModel = 0.55 + 0.4 * r(), flowYes = (r() - 0.5) * 2, lead = 1; // YES leads; flow toward YES
    const pYes = 1 / (1 + Math.exp(-(Math.log(pModel / (1 - pModel)) + 1.5 * flowYes)));
    ss.push({ closeTime: T0 + i * 900000, cp: 6, pModel, x: [flowYes, ...new Array(12).fill(0)], y: r() < pYes ? 1 : 0, lead });
  }
  const fs = flowSamples(ss);
  assert.equal(fs.length, 1500); assert.ok(fs[0].x[0] === -ss[0].x[0], 'buying toward the leader points away from a flip');
  const e = evaluate(fs, FLIP.minFlow);
  assert.ok(e.proven && e.w[0] > 0.5, JSON.stringify({ z: e.z, w0: e.w[0] }));
  const noise = evaluate(flowSamples(ss.map((s) => ({ ...s, x: [r() - 0.5, ...new Array(12).fill(0)] }))), FLIP.minFlow);
  assert.equal(noise.proven, false);
});

test('the server\'s flip check: learns hourly, checks the live round, nudges and gates only once proven', () => {
  const b = bars(60480, { ar: 0.4, seed: 7 }), now = b.at(-1).t + 30000, open = Math.floor(now / 900000) * 900000;
  const feed = createFlipFeed({ playbook: { bars: () => b }, scanFeed: null, clock: () => now, log: { warn() {} } });
  const live = (pPre) => ({ snap: { sigmaMin: 0.0008, live: { m: { ticker: 'T', strike_type: 'greater', open_time: new Date(open).toISOString() }, ev: { minutesLeft: 7, pYes: pPre }, pPre, sigma: 0.0008 } } });
  feed.observe(live(0.75), now);
  const a = feed.api(now);
  assert.ok(a.chart.proven && a.live && a.live.lead === 'YES' && a.live.used);
  assert.ok(Math.abs(a.live.pLose.YES + a.live.pLose.NO - 1) < 1e-9 && Math.abs(a.live.base - 0.25) < 1e-9);
  const sh = feed.shifts(now);
  if (sh) assert.ok(Math.abs(sh.T) <= FLIP.cap + 1e-12 && Math.sign(sh.T) === -Math.sign(a.live.p - a.live.base));
  assert.equal(feed.check(now).ticker, 'T');
  const quiet = createFlipFeed({ playbook: { bars: () => bars(30240, { seed: 11 }) }, clock: () => now, log: { warn() {} } });
  quiet.observe(live(0.75), now);
  assert.equal(quiet.check(now), null, 'unproven: never reaches the calls'); assert.equal(quiet.shifts(now), null);
  assert.ok(quiet.api(now).live && !quiet.api(now).live.used, 'still shown, as learning');
});
