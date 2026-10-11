import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE, calP, evidenceAt, forecastFrom, guideBacktest, guideNow, guidePrep, guideReport, guideShift } from '../public/guide.js';
import { to15 } from '../public/reversal.js';
import { createPlaybook } from '../playbookfeed.js';
import { kalshiFee } from '../public/model.js';

const T0 = Date.UTC(2026, 0, 1);
function walk({ days = 3, drift = 0, seed = 7, vol = 0.0008 } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32), g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const bars = []; let p = 80000;
  for (let i = 0; i < days * 1440; i++) { const o = p; p *= Math.exp(vol * g() + drift); bars.push({ t: T0 + i * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 + rnd() }); }
  return bars;
}
const cal = (over = {}) => Object.fromEntries([-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => [k, over[k] ?? { n: 0, up: 0 }]));

test('a steady climb reads as an UP candidate most of the time (above VWAP, 20 EMA over 50, RSI over 50, bullish structure); a slide as DOWN', () => {
  const share = (bars, want) => { const B = to15(bars), G = guidePrep(B); let n = 0, hit = 0; for (let k = 60; k < B.length; k++) { const e = evidenceAt(G, k); if (!e) continue; n++; if (e.sum === want) hit++; } return hit / n; };
  assert.ok(share(walk({ drift: 0.00004, days: 4 }), 4) > 0.5);
  assert.ok(share(walk({ drift: -0.00004, days: 4 }), -4) > 0.5);
  assert.equal(share(walk({ drift: 0.00004, days: 4 }), -4), 0);
});

test('NO CALL reasons: conflicting, untested, not backed by history, low volatility; otherwise the call with its invalidation', () => {
  const e = { sum: 4, lowVol: false, close: 80000, atr: 100, lastLo: 79900, lastHi: 80300 };
  assert.match(forecastFrom({ ...e, sum: 2 }, cal()).reason, /conflicting/);
  assert.match(forecastFrom(e, cal()).reason, /untested/);
  assert.match(forecastFrom(e, cal({ 4: { n: 200, up: 90 } })).reason, /doesn't back it/);
  assert.match(forecastFrom({ ...e, lowVol: true }, cal({ 4: { n: 200, up: 120 } })).reason, /volatility/);
  const f = forecastFrom(e, cal({ 4: { n: 200, up: 120 } }));
  assert.equal(f.call, 'UP'); assert.ok(Math.abs(f.pUp - (120 + 5) / 210) < 1e-12, 'shrunk toward 50%');
  assert.equal(f.invalidation, 79900, 'the latest higher low');
  assert.equal(forecastFrom({ ...e, lastLo: 79000 }, cal({ 4: { n: 200, up: 120 } })).invalidation, 80000 - 150, 'kept within 1.5 ATR');
  assert.equal(forecastFrom({ ...e, sum: -4 }, cal({ '-4': { n: 200, up: 70 } })).call, 'DOWN');
  assert.equal(calP({ n: 0, up: 0 }), 0.5);
});

test('walk-forward: each prediction only knows rounds that had already finished', () => {
  const bt = guideBacktest(walk({ days: 4 }));
  const seen = {};
  for (const r of bt.rows) {
    const c = (seen[r.sum] ||= { n: 0, up: 0 });
    assert.ok(Math.abs(r.pUp - calP(c)) < 1e-12, 'pUp from earlier rounds only');
    c.n++; if (r.up) c.up++;
  }
});

test('pure noise is never proven; a real edge is, and calibration beats a 50% guess', () => {
  for (const seed of [3, 9, 21]) assert.equal(guideReport(guideBacktest(walk({ days: 21, seed }))).proven, false, `seed ${seed}`);
  // momentum: each 15 minutes leans the way the last hour went (a real edge the trend signals can catch)
  let s = 4; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32), g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const bars = [], r = []; let p = 80000, m = 0;
  for (let i = 0; i < 21 * 1440; i++) { const ret = 0.0008 * g() + 0.6 * m / 60; r.push(ret); m += ret; if (r.length > 60) m -= r[r.length - 61]; const o = p; p *= Math.exp(ret); bars.push({ t: T0 + i * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 + rnd() }); }
  const rep = guideReport(guideBacktest(bars));
  assert.ok(rep.proven && rep.accuracy > 0.55, `acc ${rep.accuracy} z ${rep.z} calls ${rep.calls}`);
  assert.ok(rep.brier < 0.25, `brier ${rep.brier}`);
  assert.ok(rep.calibration.length >= 2 && rep.skipped['conflicting indicators'] > 0);
});

test('the scorecard: $10 a call at 50c plus Kalshi\'s fee, drawdown', () => {
  const rows = [{ call: 'UP', up: true, pUp: 0.6, y: 1 }, { call: 'DOWN', up: true, pUp: 0.4, y: 1 }, { call: 'NO CALL', reason: 'conflicting indicators', up: false, pUp: 0.5, y: 0 }];
  const r = guideReport({ rows });
  const fee = kalshiFee(0.5, 20); // 20 contracts for $10 at 50c: the order's fee, rounded once
  assert.equal(r.calls, 2); assert.equal(r.wins, 1); assert.equal(r.accuracy, 0.5);
  assert.ok(Math.abs(r.usd - ((10 - fee) + (-10 - fee))) < 1e-9);
  assert.ok(Math.abs(r.maxDD - (10 + fee)) < 1e-9);
  assert.deepEqual(r.skipped, { 'conflicting indicators': 1 });
});

test('the live forecast compares the calibrated chance with Kalshi\'s price and fee', () => {
  const all = walk({ drift: 0.00004, days: 4 }), B = to15(all), G = guidePrep(B), c = cal({ 4: { n: 300, up: 190 } });
  let k = B.length - 1; while (k > 60 && !(evidenceAt(G, k).sum === 4 && !evidenceAt(G, k).lowVol)) k--; // the latest UP setup
  const now = B[k].t + 900000, bars = all.filter((b) => b.t < now);
  const g = guideNow(bars, c, { now, quote: { yesAsk: 0.55, noAsk: 0.47 } });
  assert.equal(g.call, 'UP'); assert.equal(g.expiry - g.at, 900000);
  assert.equal(g.kalshi.side, 'YES'); assert.ok(Math.abs(g.kalshi.edge - (g.pUp - 0.55 - kalshiFee(0.55, 18) / 18)) < 1e-12, 'a $10 order (18 contracts) and its exact fee');
  assert.ok(g.evidence.some((x) => /^Trend:/.test(x)) && g.evidence.some((x) => /^Liquidity:/.test(x)));
});

test('the call nudge: only once proven, only for its own round, capped', () => {
  const g = { call: 'UP', at: 1000, atr: 80, entry: 80000 }, rep = { proven: true, up: { n: 400, mean: 0.3 }, down: { n: 400, mean: 0.3 } };
  const m = { spot: 80000, strike: 80000, sigmaMin: 0.0008, minutesLeft: 12, openTime: 1000 };
  const v = guideShift(g, rep, m);
  assert.ok(v > 0 && v <= GUIDE.cap);
  assert.equal(guideShift(g, { ...rep, proven: false }, m), 0);
  assert.equal(guideShift(g, rep, { ...m, openTime: 2000 }), 0);
  assert.equal(guideShift({ ...g, call: 'NO CALL' }, rep, m), 0);
});

test('live record: the forecast at each round\'s open with Kalshi\'s prices, graded at the close', async () => {
  const bars = walk({ days: 2, drift: 0.00012 });
  const open = Math.floor(bars.at(-1).t / 900000) * 900000 - 900000; // a round that opened as a 15-minute candle closed
  let now = open + 5000;
  const pb = createPlaybook({ coinbase: 'x', file: '/nonexistent/dir/bars.json', fetchJSON: async () => [], clock: () => now, log: { error() {}, warn() {} } });
  pb.merge(bars.filter((b) => b.t < open)); pb.rerun();
  const m = { ticker: 'R1', strike_type: 'greater', open_time: new Date(open).toISOString(), close_time: new Date(open + 900000).toISOString(), yes_ask: 55, yes_bid: 53 };
  const snap = { spot: 80000, sigmaMin: 0.0008, live: { m, strike: bars.find((b) => b.t === open - 60000).c, ev: { minutesLeft: 14.9 } } };
  pb.observe({ snap }, now);
  assert.equal(pb.api().guideLive.last.length, 1);
  assert.equal(pb.api().guideLive.last[0].yesAsk, 0.55);
  pb.observe({ snap }, now + 1000);
  assert.equal(pb.api().guideLive.last.length, 1, 'once per round');
  now = open + 900000 + 61000; pb.merge(bars.filter((b) => b.t < open + 900000));
  pb.observe({ snap: { spot: 80000, live: null } }, now);
  const st = pb.api().guideLive;
  assert.equal(st.rounds, 1);
  assert.ok(st.last[0].up === true || st.last[0].up === false);
});
