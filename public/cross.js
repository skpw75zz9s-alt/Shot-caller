// Related markets (v13.33): every market reads the other markets that move with it. Bitcoin drags Ethereum, Solana,
// XRP and Dogecoin; crypto often follows the Nasdaq and S&P 500 in US hours; gold and oil move on the same macro news.
// For each market (its asset, public/markets.js) the server keeps every asset's 1-minute closes (crossfeed.js) and:
//   relation   each other asset's correlation (rho) and beta with this one on 1-minute moves over the last few days,
//              its move in the last 5 and 15 minutes, and the catch-up it implies: beta x its move - this one's move
//              (how far this market has lagged what moves it)
//   model      a ridge regression of this market's next 5 minutes on every asset's last 1- and 5-minute moves (its own
//              included: the catch-up), refitted every 30 minutes and scored walk-forward on the last 30% of the data
//              (never trained on) against "no change"
//   in calls   only once proven (1,500+ test minutes, squared error at least 0.5% under "no change", z 2.5+): its
//              expected move then shifts the bot's odds as a drift over the time left (at most 5 minutes of it), capped
//              at +-5 points. Until then it's shown, never used: lead-lag between liquid markets is small and gets
//              arbitraged away, and the record decides whether any is left
import { normCdf } from './model.js';

export const CROSS = { horizon: 5, ridge: 2, testShare: 0.3, minTest: 1500, minGain: 0.005, z: 2.5, cap: 0.05, corrMinutes: 3 * 1440 };

const MIN = 60000;
const lr = (m, t, lag) => { const a = m.get(t), b = m.get(t - lag * MIN); return a > 0 && b > 0 ? Math.log(a / b) : null; };

// One asset's closes as a Map(minute -> close), from candles [{ t, c }]
export const closeMap = (candles) => new Map((candles || []).filter((x) => x.c > 0).map((x) => [Math.floor(x.t / MIN) * MIN, x.c]));

// The model's inputs at minute t: [own 1m, own 5m, then each other asset's 1m and 5m moves] (a missing move is 0, e.g.
// the S&P overnight), scaled to typical moves by the caller
export function features(maps, target, others, t) {
  const out = [lr(maps[target], t, 1) ?? 0, lr(maps[target], t, 5) ?? 0];
  for (const k of others) out.push(lr(maps[k], t, 1) ?? 0, lr(maps[k], t, 5) ?? 0);
  return out;
}
// Every minute with a known outcome (this market's move over the next CROSS.horizon minutes) and its own recent moves
export function dataset(maps, target, others, h = CROSS.horizon) {
  const X = [], y = [], ts = [];
  for (const t of [...maps[target].keys()].sort((a, b) => a - b)) {
    const fut = maps[target].get(t + h * MIN), now = maps[target].get(t);
    if (!(fut > 0 && now > 0) || lr(maps[target], t, 5) == null) continue;
    X.push(features(maps, target, others, t)); y.push(Math.log(fut / now)); ts.push(t);
  }
  return { X, y, ts };
}

// Ridge regression on standardized columns: returns { w, mu, sd } (no intercept: drift is ~0 at these horizons)
export function ridgeFit(X, y, lambda = CROSS.ridge) {
  const n = X.length, k = X[0]?.length ?? 0;
  if (!n || !k) return null;
  const mu = new Array(k).fill(0), sd = new Array(k).fill(0);
  for (const r of X) r.forEach((v, j) => { mu[j] += v / n; });
  for (const r of X) r.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / n; });
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i].map((v, j) => (v - mu[j]) / sd[j]);
    for (let a = 0; a < k; a++) { b[a] += z[a] * y[i]; for (let c = 0; c < k; c++) A[a][c] += z[a] * z[c]; }
  }
  for (let a = 0; a < k; a++) A[a][a] += lambda * n / 100; // the penalty grows with the data, so it's the same strength at any size
  // Gaussian elimination with partial pivoting
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-18) return null;
    for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let cc = c; cc <= k; cc++) M[r][cc] -= f * M[c][cc]; }
  }
  return { w: M.map((r, i) => r[k] / r[i]), mu, sd };
}
export const predict = (m, x) => (m ? x.reduce((a, v, j) => a + m.w[j] * (v - m.mu[j]) / m.sd[j], 0) : 0);

// Walk-forward: fit on the first 70%, score on the last 30% against "no change" (paired squared errors)
export function evaluate(X, y, o = CROSS) {
  const cut = Math.floor(X.length * (1 - o.testShare)), nTest = X.length - cut;
  if (cut < 200 || nTest < 50) return { n: nTest, gain: null, z: null, proven: false };
  const m = ridgeFit(X.slice(0, cut), y.slice(0, cut), o.ridge);
  if (!m) return { n: nTest, gain: null, z: null, proven: false };
  const d = []; let e0 = 0, e1 = 0;
  for (let i = cut; i < X.length; i++) { const p = predict(m, X[i]), a = y[i] * y[i], b = (y[i] - p) ** 2; e0 += a; e1 += b; d.push(a - b); }
  const mean = d.reduce((a, v) => a + v, 0) / d.length, sd = Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, d.length - 1));
  const gain = e0 > 0 ? (e0 - e1) / e0 : 0, z = sd > 0 ? mean / (sd / Math.sqrt(d.length)) : 0;
  return { n: nTest, gain, z, proven: nTest >= o.minTest && gain >= o.minGain && z >= o.z };
}

// How two assets move together on 1-minute moves (minutes both traded, the last CROSS.corrMinutes)
export function relation(maps, a, b, now, minutes = CROSS.corrMinutes) {
  const xs = [], ys = [];
  for (let t = Math.floor(now / MIN) * MIN - minutes * MIN; t <= now; t += MIN) {
    const ra = lr(maps[a], t, 1), rb = lr(maps[b], t, 1);
    if (ra != null && rb != null && (ra !== 0 || rb !== 0)) { xs.push(rb); ys.push(ra); }
  }
  const n = xs.length;
  if (n < 30) return { n, rho: null, beta: null };
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { n, rho: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, beta: sxx > 0 ? sxy / sxx : null }; // beta: this market's move per 1% of the other's
}
export const moveOver = (map, now, minutes) => { const t = Math.floor(now / MIN) * MIN, a = map?.get(t) ?? map?.get(t - MIN), b = map?.get(t - minutes * MIN); return a > 0 && b > 0 ? Math.log(a / b) : null; };

// The shift to the bot's odds from an expected move: the probability of finishing above the target with the move added
// as drift over the time left (at most CROSS.horizon minutes of it), minus without; capped. Below-the-target markets
// (strike_type less*) move the other way.
export function crossShift({ pYes, mu5, sigmaMin, minutesLeft, strikeType = 'greater' }, cap = CROSS.cap) {
  if (!(pYes > 0 && pYes < 1) || !(sigmaMin > 0) || !(minutesLeft > 0) || !Number.isFinite(mu5)) return 0;
  const drift = mu5 * Math.min(minutesLeft, CROSS.horizon) / CROSS.horizon, s = sigmaMin * Math.sqrt(minutesLeft);
  const z = invNorm(pYes), dir = /^less/.test(strikeType) ? -1 : 1;
  return Math.max(-cap, Math.min(cap, normCdf(z + dir * drift / s) - pYes));
}
// Inverse normal CDF (Acklam's rational approximation, refined with one Newton step)
export function invNorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p)), lo = 0.02425;
  let x;
  if (q < lo) { const r = Math.sqrt(-2 * Math.log(q)); x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  else if (q > 1 - lo) { const r = Math.sqrt(-2 * Math.log(1 - q)); x = -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  else { const r = q - 0.5, s = r * r; x = (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1); }
  const e = normCdf(x) - q, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}
