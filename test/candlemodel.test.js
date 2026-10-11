import test from 'node:test';
import assert from 'node:assert/strict';
import { CM, cmFit, cmLive, cmMove, cmReport, cmWalkForward } from '../public/candlemodel.js';
import { series } from '../public/predictor.js';
import { expectedPath, pathRecord, predictionLines } from '../public/predict.js';
import { createPlaybook } from '../playbookfeed.js';

const T0 = Date.UTC(2026, 0, 1);
// mulberry32 (a simple LCG's serial correlation is a real pattern a model would find)
function market({ days = 14, seed = 5, garch = false, edge = 0 } = {}) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 2 ** 32; };
  const g = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const bars = [], r = []; let p = 80000, v = 0.0008 ** 2, prev = 0, m = 0;
  for (let i = 0; i < days * 1440; i++) {
    const t = T0 + i * 60000, tod = (t % 86400000) / 86400000;
    let sd = 0.0008;
    if (garch) { v = 0.0008 ** 2 * 0.02 + 0.9 * v + 0.08 * prev * prev; sd = Math.sqrt(v) * (1 + 0.5 * Math.sin(2 * Math.PI * tod)); }
    const ret = sd * g() + edge * m / 60; r.push(ret); m += ret; if (r.length > 60) m -= r[r.length - 61];
    prev = ret / (1 + 0.5 * Math.sin(2 * Math.PI * tod));
    const o = p; p *= Math.exp(ret);
    const wick = Math.abs(sd * g()) * p * 0.6;
    bars.push({ t, o, h: Math.max(o, p) + wick * rnd(), l: Math.min(o, p) - wick * rnd(), c: p, v: 1 + rnd() });
  }
  return bars;
}

test('noise: no horizon\'s move beats "no change", so the candles get no made-up direction', () => {
  const rep = cmReport(cmWalkForward(market({ seed: 3 })).rows);
  assert.equal(rep.anyMove, false, JSON.stringify(rep.move));
  for (const h of CM.horizons) assert.ok(rep.move[h].r2 < 0.01);
});
test('a real momentum edge is found at some horizons', () => {
  const rep = cmReport(cmWalkForward(market({ edge: 0.6, seed: 4 })).rows);
  assert.ok(rep.anyMove, JSON.stringify(rep.move));
});
test('live read: proven parts only; moves start at 0 and run through the horizons; stale candles give nothing', () => {
  const bars = market({ garch: true, seed: 5, days: 8 }), wf = cmWalkForward(bars), rep = cmReport(wf.rows), W = cmFit(wf.samples), S = series(bars);
  const now = bars.at(-1).t + 60000 + 3000, live = cmLive(S, W, rep, { now, price: bars.at(-1).c });
  assert.ok(live && live.moves[0][1] === 0 && live.moves.length === CM.horizons.length + 1);
  for (const [h, v] of live.moves.slice(1)) if (!rep.move[h].proven) assert.equal(v, 0);
  assert.equal(cmMove(live, 0), 0);
  assert.equal(cmLive(S, W, rep, { now: now + 10 * 60000, price: 1 }), null);
});
test('beta: the least-squares scale of the predicted moves, shrunk toward 1 until there are plenty of minutes', () => {
  const mk = (n, k) => Array.from({ length: n }, (_, i) => { const m = (i % 7) - 3; return { t: i, o: 100, c: 100 + m, open: 100, actual: 100 + k * m, beta: 1 }; });
  assert.ok(Math.abs(pathRecord(mk(2000, 0.5)).beta - (2000 * 0.5 + 60) / 2060) < 1e-9, 'moves carried half as far: scaled toward 0.5');
  assert.ok(pathRecord(mk(10, 0.5)).beta > 0.9, 'too few minutes: barely changed');
  assert.equal(pathRecord(mk(2000, -1)).beta, 0, 'never flipped: floored at 0');
  // graded on the raw move, so a path already scaled doesn't compound
  const scaled = mk(2000, 0.5).map((e) => ({ ...e, c: 100 + (e.c - 100) * 0.5, beta: 0.5 }));
  assert.ok(Math.abs(pathRecord(scaled).beta - pathRecord(mk(2000, 0.5)).beta) < 1e-9);
});
test('the expected path: shrunk by beta; the move model\'s proven moves come in as their own line', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 30), close = now + 10 * 60000;
  const lines = [{ key: 'bot', pts: [{ t: now, v: 100000 }, { t: close, v: 100100 }] }];
  const full = expectedPath({ lines, spot: 100000, now })(close), half = expectedPath({ lines, spot: 100000, now, beta: 0.5 })(close);
  assert.ok(Math.abs(half - 100000 - (full - 100000) / 2) < 1e-6);
  const cm = { at: now, moves: [[0, 0], [5, 40], [15, 40]] };
  const moves = predictionLines({ spot: 1e5, sigmaMin: 0.0008, now, close, cm }).filter((l) => l.key === 'moves');
  assert.ok(Math.abs(expectedPath({ lines: moves, spot: 1e5, now })(close) - (1e5 + 40)) < 1e-6);
});
test('playbook feed: runs the move model and serves its read', () => {
  const bars = market({ garch: true, seed: 6, days: 6 }), now = bars.at(-1).t + 61000;
  const pb = createPlaybook({ coinbase: 'x', file: '/nonexistent/dir/bars.json', fetchJSON: async () => [], clock: () => now, log: { error() {}, warn() {} } });
  pb.merge(bars); pb.rerun();
  const c = pb.api().candle;
  assert.ok(c.report && c.report.rows > 0 && c.live && c.live.moves.length === CM.horizons.length + 1);
});
