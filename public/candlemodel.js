// The candle model: what the 1-minute BTC history says about the next 15 minutes' candles, tested walk-forward.
// Pure; playbookfeed.js runs it on the server and the phone draws the prediction candles from its live read.
// A candle has two parts that behave very differently, so each is modelled and proven on its own:
//   Moves   where BTC will be 1, 2, 3, 5, 8, 12 and 15 minutes from now: one ridge regression per horizon on the
//           prediction engine's factors (public/predictor.js: trend, EMAs, VWAP, RSI, momentum, volume, sweeps,
//           structure), in typical moves (log return / (1-minute volatility x sqrt(minutes))). Graded by out-of-sample
//           R² against "no change" (the honest bar for direction: it's mostly noise at this scale).
//   Sizes   how big each coming minute's candle will be (its high-low range): a regression of the log range on the
//           recent ranges (last 5, 30 and 120 minutes: volatility clusters) and the time of day and week (BTC is busier
//           at some hours). Graded against the old method, the last 30 candles' average range.
// Walk-forward: refit each day on the days before it, then predict that day. A horizon's move or a minute's size is used
// only when it beat its baseline out of sample with z >= 2.5 (on non-overlapping samples); otherwise the candles fall
// back to "no change" for the move and the recent average for the size.
import { FACTORS, factorsAt, series, solve } from './predictor.js';

export const CM = { horizons: [1, 2, 3, 5, 8, 12, 15], ahead: [1, 5, 10, 15], every: 3, l2: 50, minTrainDays: 3, z: 2.5 };
const M = 60000, DAY = 86400000;
const lnRange = (b) => Math.log(Math.max(b.h - b.l, b.c * 1e-6) / b.c);

// size features at bar i: the log of the average range over the last 5 / 30 / 120 minutes, and the time of day / week
function sizeX(S, i) {
  const avgR = (n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += Math.max(S.bars[j].h - S.bars[j].l, 0) / S.bars[j].c; return Math.log(Math.max(s / n, 1e-6)); };
  const t = S.bars[i].t + M, tod = (t % DAY) / DAY, dow = new Date(t).getUTCDay();
  return [1, avgR(5), avgR(30), avgR(120), Math.sin(2 * Math.PI * tod), Math.cos(2 * Math.PI * tod), Math.sin(4 * Math.PI * tod), Math.cos(4 * Math.PI * tod), dow === 0 || dow === 6 ? 1 : 0];
}
const moveX = (f) => [1, ...FACTORS.map((k) => f[k])];

// The samples: every 3rd minute with enough history and the next 15 minutes complete
export function cmSamples(bars, S = series(bars)) {
  const out = [];
  for (let i = 3100; i + 15 < bars.length; i += CM.every) {
    if (bars[i + 15].t !== bars[i].t + 15 * M) continue; // a gap: skip
    const f = factorsAt(S, i), sd = S.vol[i];
    if (!f || !(sd > 0)) continue;
    const y = Object.fromEntries(CM.horizons.map((h) => [h, Math.log(S.c[i + h] / S.c[i]) / (sd * Math.sqrt(h))]));
    const r = Object.fromEntries(CM.ahead.map((k) => [k, lnRange(bars[i + k])]));
    out.push({ i, t: bars[i].t, day: Math.floor(bars[i].t / DAY), xm: moveX(f), xs: sizeX(S, i), y, r });
  }
  return out;
}

// ridge regression (the intercept isn't penalised)
export function ridge(X, y, l2 = CM.l2) {
  const K = X[0].length, A = Array.from({ length: K }, (_, a) => Array.from({ length: K }, (_, b) => (a === b && a > 0 ? l2 : 0))), g = new Array(K).fill(0);
  for (let n = 0; n < X.length; n++) for (let a = 0; a < K; a++) { g[a] += X[n][a] * y[n]; for (let b = 0; b < K; b++) A[a][b] += X[n][a] * X[n][b]; }
  return solve(A, g) || new Array(K).fill(0);
}
const dot = (w, x) => x.reduce((a, v, j) => a + v * (w[j] ?? 0), 0);
const fitAll = (ss) => ({
  move: Object.fromEntries(CM.horizons.map((h) => [h, ridge(ss.map((s) => s.xm), ss.map((s) => s.y[h]))])),
  size: Object.fromEntries(CM.ahead.map((k) => [k, ridge(ss.map((s) => s.xs), ss.map((s) => s.r[k]), 1)])),
});

// Walk-forward: every sample predicted by a model fitted on earlier days only
export function cmWalkForward(bars) {
  const S = series(bars), ss = cmSamples(bars, S), days = [...new Set(ss.map((s) => s.day))].sort((a, b) => a - b), rows = [];
  for (let d = CM.minTrainDays; d < days.length; d++) {
    const train = ss.filter((s) => s.day < days[d]);
    if (train.length < 200) continue;
    const W = fitAll(train);
    // the baseline, made fair: the recent average range with its own bias corrected on the same training days (the log of
    // an average sits above the average log, so an uncorrected baseline would lose for a reason that isn't information)
    const bias = Object.fromEntries(CM.ahead.map((k) => [k, train.reduce((a, s) => a + s.r[k] - s.xs[2], 0) / train.length]));
    for (const s of ss.filter((x) => x.day === days[d])) rows.push({ ...s, pm: Object.fromEntries(CM.horizons.map((h) => [h, dot(W.move[h], s.xm)])), ps: Object.fromEntries(CM.ahead.map((k) => [k, dot(W.size[k], s.xs)])), pb: Object.fromEntries(CM.ahead.map((k) => [k, s.xs[2] + bias[k]])) });
  }
  return { rows, samples: ss, S };
}

// The report: per horizon, out-of-sample R² vs "no change" and its z; per minute ahead, the size model's error vs the
// recent-average baseline (in log range) and its z. z uses non-overlapping samples only (h minutes apart).
export function cmReport(rows) {
  const zOf = (d) => { const n = d.length; if (n < 3) return 0; const m = d.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return sd > 0 ? (m / sd) * Math.sqrt(n) : 0; };
  const move = {}, size = {};
  for (const h of CM.horizons) {
    const step = Math.max(1, Math.ceil(h / CM.every)), xs = rows.filter((_, j) => j % step === 0);
    const e0 = xs.reduce((a, r) => a + r.y[h] ** 2, 0), e1 = xs.reduce((a, r) => a + (r.y[h] - r.pm[h]) ** 2, 0);
    const hits = xs.filter((r) => r.pm[h] !== 0 && r.y[h] !== 0), right = hits.filter((r) => Math.sign(r.pm[h]) === Math.sign(r.y[h])).length;
    const z = zOf(xs.map((r) => r.y[h] ** 2 - (r.y[h] - r.pm[h]) ** 2));
    move[h] = { n: xs.length, r2: e0 > 0 ? 1 - e1 / e0 : 0, z, direction: hits.length ? right / hits.length : null, proven: z >= CM.z && e1 < e0 };
  }
  for (const k of CM.ahead) {
    const step = Math.max(1, Math.ceil(k / CM.every)), xs = rows.filter((_, j) => j % step === 0);
    const base = (r) => r.pb[k]; // the last 30 minutes' average range (the old wicks), bias-corrected
    const e0 = xs.reduce((a, r) => a + (r.r[k] - base(r)) ** 2, 0), e1 = xs.reduce((a, r) => a + (r.r[k] - r.ps[k]) ** 2, 0);
    const z = zOf(xs.map((r) => (r.r[k] - base(r)) ** 2 - (r.r[k] - r.ps[k]) ** 2));
    size[k] = { n: xs.length, gain: e0 > 0 ? 1 - e1 / e0 : 0, z, proven: z >= CM.z && e1 < e0 };
  }
  return { rows: rows.length, move, size, anyMove: Object.values(move).some((x) => x.proven), anySize: Object.values(size).some((x) => x.proven) };
}

// The live read: the models fitted on all the history applied to the latest candle, with only proven parts switched on.
//   moves(t)  dollars from now at t minutes (0 at now, through the proven horizons, held after the last one)
//   range(t)  the expected high-low (dollars) of the minute starting t minutes from now, or null (use the recent average)
export function cmFit(samples) { return samples.length >= 200 ? fitAll(samples) : null; }
export function cmLive(S, W, report, { now, price }) {
  if (!W || !report || !(price > 0)) return null;
  let i = S.bars.length - 1;
  while (i >= 0 && S.bars[i].t + M > now) i--;
  if (i < 121 || now - (S.bars[i].t + M) > 3 * M) return null; // stale candles: no live read
  const f = factorsAt(S, i, price), sd = S.vol[i];
  if (!f || !(sd > 0)) return null;
  const xm = moveX(f), xs = sizeX(S, i);
  const pts = [[0, 0], ...CM.horizons.map((h) => [h, report.move[h]?.proven ? dot(W.move[h], xm) * sd * Math.sqrt(h) * price : 0])];
  const sizes = CM.ahead.map((k) => [k, report.size[k]?.proven ? Math.exp(dot(W.size[k], xs)) * price : null]);
  return { at: S.bars[i].t + M, price, moves: pts, sizes };
}
export function cmMove(live, tMin) { // linear between the horizons
  if (!live?.moves || !(tMin > 0)) return 0;
  const pts = live.moves;
  for (let j = 1; j < pts.length; j++) if (tMin <= pts[j][0]) { const [a, va] = pts[j - 1], [b, vb] = pts[j]; return va + (vb - va) * (tMin - a) / (b - a); }
  return pts.at(-1)[1];
}
export function cmRange(live, tMin) { // nearest proven minute-ahead size, or null
  const xs = (live?.sizes || []).filter(([, v]) => v != null);
  if (!xs.length) return null;
  return xs.reduce((a, b) => (Math.abs(b[0] - tMin) < Math.abs(a[0] - tMin) ? b : a))[1];
}
