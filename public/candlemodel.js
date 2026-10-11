// The move model: what the 1-minute BTC history says about where BTC will be over the next 15 minutes, tested
// walk-forward. Pure; playbookfeed.js runs it on the server and the phone adds its proven moves to the expected path
// (public/predict.js expectedPath), which the cone is centred on.
//   Moves   where BTC will be 1, 2, 3, 5, 8, 12 and 15 minutes from now: one ridge regression per horizon on the
//           prediction engine's factors (public/predictor.js: trend, EMAs, VWAP, RSI, momentum, volume, sweeps,
//           structure), in typical moves (log return / (1-minute volatility x sqrt(minutes))). Graded by out-of-sample
//           R² against "no change" (the honest bar for direction: it's mostly noise at this scale).
// Walk-forward: refit each day on the days before it, then predict that day. A horizon's move is used only when it beat
// "no change" out of sample with z >= 2.5 (on non-overlapping samples); otherwise it adds nothing.
import { FACTORS, factorsAt, series, solve } from './predictor.js';

export const CM = { horizons: [1, 2, 3, 5, 8, 12, 15], every: 3, l2: 50, minTrainDays: 3, z: 2.5 };
const M = 60000, DAY = 86400000;
const moveX = (f) => [1, ...FACTORS.map((k) => f[k])];

// The samples: every 3rd minute with enough history and the next 15 minutes complete
export function cmSamples(bars, S = series(bars)) {
  const out = [];
  for (let i = 3100; i + 15 < bars.length; i += CM.every) {
    if (bars[i + 15].t !== bars[i].t + 15 * M) continue; // a gap: skip
    const f = factorsAt(S, i), sd = S.vol[i];
    if (!f || !(sd > 0)) continue;
    const y = Object.fromEntries(CM.horizons.map((h) => [h, Math.log(S.c[i + h] / S.c[i]) / (sd * Math.sqrt(h))]));
    out.push({ i, t: bars[i].t, day: Math.floor(bars[i].t / DAY), xm: moveX(f), y });
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
const fitAll = (ss) => ({ move: Object.fromEntries(CM.horizons.map((h) => [h, ridge(ss.map((s) => s.xm), ss.map((s) => s.y[h]))])) });

// Walk-forward: every sample predicted by a model fitted on earlier days only
export function cmWalkForward(bars) {
  const S = series(bars), ss = cmSamples(bars, S), days = [...new Set(ss.map((s) => s.day))].sort((a, b) => a - b), rows = [];
  for (let d = CM.minTrainDays; d < days.length; d++) {
    const train = ss.filter((s) => s.day < days[d]);
    if (train.length < 200) continue;
    const W = fitAll(train);
    for (const s of ss.filter((x) => x.day === days[d])) rows.push({ ...s, pm: Object.fromEntries(CM.horizons.map((h) => [h, dot(W.move[h], s.xm)])) });
  }
  return { rows, samples: ss, S };
}

// The report: per horizon, out-of-sample R² vs "no change" and its z (non-overlapping samples only: h minutes apart)
export function cmReport(rows) {
  const zOf = (d) => { const n = d.length; if (n < 3) return 0; const m = d.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return sd > 0 ? (m / sd) * Math.sqrt(n) : 0; };
  const move = {};
  for (const h of CM.horizons) {
    const step = Math.max(1, Math.ceil(h / CM.every)), xs = rows.filter((_, j) => j % step === 0);
    const e0 = xs.reduce((a, r) => a + r.y[h] ** 2, 0), e1 = xs.reduce((a, r) => a + (r.y[h] - r.pm[h]) ** 2, 0);
    const hits = xs.filter((r) => r.pm[h] !== 0 && r.y[h] !== 0), right = hits.filter((r) => Math.sign(r.pm[h]) === Math.sign(r.y[h])).length;
    const z = zOf(xs.map((r) => r.y[h] ** 2 - (r.y[h] - r.pm[h]) ** 2));
    move[h] = { n: xs.length, r2: e0 > 0 ? 1 - e1 / e0 : 0, z, direction: hits.length ? right / hits.length : null, proven: z >= CM.z && e1 < e0 };
  }
  return { rows: rows.length, move, anyMove: Object.values(move).some((x) => x.proven) };
}

// The live read: the model fitted on all the history applied to the latest candle, proven horizons only.
//   moves  [minutes, dollars from now]: 0 at now, through the proven horizons (0 for the rest), held after the last one
export function cmFit(samples) { return samples.length >= 200 ? fitAll(samples) : null; }
export function cmLive(S, W, report, { now, price }) {
  if (!W || !report || !(price > 0)) return null;
  let i = S.bars.length - 1;
  while (i >= 0 && S.bars[i].t + M > now) i--;
  if (i < 121 || now - (S.bars[i].t + M) > 3 * M) return null; // stale candles: no live read
  const f = factorsAt(S, i, price), sd = S.vol[i];
  if (!f || !(sd > 0)) return null;
  const xm = moveX(f);
  return { at: S.bars[i].t + M, price, moves: [[0, 0], ...CM.horizons.map((h) => [h, report.move[h]?.proven ? dot(W.move[h], xm) * sd * Math.sqrt(h) * price : 0])] };
}
export function cmMove(live, tMin) { // linear between the horizons
  if (!live?.moves || !(tMin > 0)) return 0;
  const pts = live.moves;
  for (let j = 1; j < pts.length; j++) if (tMin <= pts[j][0]) { const [a, va] = pts[j - 1], [b, vb] = pts[j]; return va + (vb - va) * (tMin - a) / (b - a); }
  return pts.at(-1)[1];
}
