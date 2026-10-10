// Prediction lines for the forecast cone: three reads of where BTC closes this round, each from a different market.
//   Bot        the bot's own model: today's price carried forward with its momentum (the cone is centred on it)
//   Kalshi     what Kalshi's price implies: the close level at which "above the target" is exactly as likely as
//              Kalshi's YES price says, using the bot's volatility
//   Exchanges  the five exchanges' combined trend: a straight-line fit through their median price over the last
//              5 minutes, carried to the close at half strength (trends fade)
// Every round, each line's close prediction with 5 minutes left is graded against where BTC really closed, next to
// "no change" (the price at that moment) as the baseline any prediction has to beat.
import { normCdf } from './model.js';

// Inverse of the standard normal CDF (Acklam's approximation, plenty for a chart)
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const path = (from, to, now, close, step = 60000) => { // log-linear from today's price to the close prediction
  const pts = [];
  for (let t = now; t < close; t += step) pts.push({ t, v: from * Math.exp(Math.log(to / from) * ((t - now) / (close - now))) });
  pts.push({ t: close, v: to });
  return pts;
};

// Kalshi's implied close: P(close > strike) = YES mid  =>  close median = strike * exp(sigma * sqrt(t) * z(mid))
export function kalshiImplied({ strike, yesMid, strikeType = 'greater', sigmaMin, minutesLeft }) {
  if (!strike || yesMid == null || !(sigmaMin > 0) || !(minutesLeft > 0)) return null;
  const pAbove = /^less/.test(strikeType) ? 1 - yesMid : yesMid;
  const p = Math.min(0.98, Math.max(0.02, pAbove)); // the ends of the book say little about a level
  return strike * Math.exp(sigmaMin * Math.sqrt(minutesLeft) * normInv(p));
}

// The exchanges' trend: median price across exchanges every 10 seconds over the last 5 minutes, least-squares slope
// (log price per minute), half of it carried to the close
export function exchangeTrend(trades, now, close, { lookback = 5 * 60000, damp = 0.5 } = {}) {
  const from = now - lookback, buckets = new Map();
  for (const x of trades) {
    if (x.t < from || x.t > now || !(x.price > 0)) continue;
    const k = Math.floor((x.t - from) / 10000);
    const b = buckets.get(k) || {};
    b[x.ex] = x.price; // the latest price per exchange in each 10s bucket
    buckets.set(k, b);
  }
  const pts = [...buckets.entries()].map(([k, b]) => ({ m: (k * 10000 + 5000) / 60000, y: Math.log(median(Object.values(b))) })).sort((a, b) => a.m - b.m);
  if (pts.length < 6) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p.m, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.m - mx) * (p.y - my); sxx += (p.m - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0; // log price per minute
  const last = Math.exp(pts[n - 1].y), minutes = Math.max(0, (close - now) / 60000);
  return { start: last, end: last * Math.exp(slope * damp * minutes), slopePerMin: last * slope };
}

// All three lines, clipped to the 90% cone so a runaway trend can't fly off the chart
export function predictionLines({ spot, sigmaMin, driftMin = 0, now, close, strike, yesMid, strikeType, trades = [] }) {
  if (!spot || !(close > now) || !(sigmaMin > 0)) return [];
  const mins = (close - now) / 60000, sd = spot * sigmaMin * Math.sqrt(mins);
  const clip = (v) => Math.min(spot + 1.645 * sd, Math.max(spot - 1.645 * sd, v));
  const lines = [];
  lines.push({ key: 'bot', name: 'Bot', color: '#22d3ee', end: clip(spot * Math.exp(driftMin * mins)), from: spot });
  const k = kalshiImplied({ strike, yesMid, strikeType, sigmaMin, minutesLeft: mins });
  if (k) lines.push({ key: 'kalshi', name: 'Kalshi', color: '#a78bfa', end: clip(k), from: spot });
  const tr = exchangeTrend(trades, now, close);
  if (tr) lines.push({ key: 'exch', name: '5 exch', color: '#fbbf24', end: clip(tr.end), from: tr.start });
  for (const l of lines) l.pts = path(l.from, l.end, now, close);
  return lines;
}

// The record: average miss (dollars) of each line's 5-minutes-left prediction, vs "no change"
export function predictionRecord(log) {
  const done = log.filter((e) => e.actual != null);
  const avg = (k) => { const xs = done.filter((e) => e[k] != null).map((e) => Math.abs(e[k] - e.actual)); return xs.length ? { miss: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null; };
  return { rounds: done.length, bot: avg('bot'), kalshi: avg('kalshi'), exch: avg('exch'), still: avg('spot') };
}
export { normCdf };

// ---------- prediction candles: the minutes from now to the close, drawn as ghost candles ----------
// The path is a blend of the prediction lines, each weighted by how close it has come at past closes (1 / miss², from
// predictionRecord; equal weights until each has 5 graded rounds). Each minute's candle opens where the last one
// closed and closes on the path; its wicks reach BTC's typical one-minute range (about 0.8σ either side of the body's
// middle, so the candles look like real minutes at today's volatility, not a straight line).
export function blendWeights(record) {
  const w = {};
  for (const k of ['bot', 'kalshi', 'exch']) { const x = record?.[k]; w[k] = x && x.n >= 5 && x.miss > 0 ? 1 / (x.miss * x.miss) : null; }
  const known = Object.values(w).filter((v) => v != null);
  const fill = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  for (const k of Object.keys(w)) w[k] ??= fill; // a line without a record yet counts as average
  return w;
}
const valueAt = (pts, t) => { // the line's value at time t (straight between its points)
  if (!pts?.length) return null;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1)); }
  return pts[pts.length - 1].v;
};
export function predictionCandles({ lines, spot, sigmaMin, now, close, weights = null }) {
  if (!lines?.length || !spot || !(sigmaMin > 0) || !(close > now)) return [];
  const w = weights || blendWeights(null);
  const path = (t) => { let s = 0, ws = 0; for (const l of lines) { const v = valueAt(l.pts, t), k = w[l.key] ?? 1; if (v != null) { s += v * k; ws += k; } } return ws ? s / ws : spot; };
  const out = [];
  let o = path(Math.floor(now / 60000) * 60000 + 60000);
  for (let t = Math.floor(now / 60000) * 60000 + 60000; t < close; t += 60000) {
    const c = path(Math.min(close, t + 60000)), mid = (o + c) / 2, half = 0.8 * sigmaMin * mid;
    out.push({ t, o, c, h: Math.max(o, c, mid + half), l: Math.min(o, c, mid - half) });
    o = c;
  }
  return out;
}
// The record: how often a minute's candle (as predicted just before that minute began) got the direction right, and
// its average miss at the minute's close vs "no change" (the minute's open)
export function candleRecord(log) {
  const done = log.filter((e) => e.actual != null && e.open != null);
  if (!done.length) return { n: 0 };
  const moved = done.filter((e) => e.actual !== e.open && e.c !== e.o);
  const right = moved.filter((e) => Math.sign(e.c - e.o) === Math.sign(e.actual - e.open)).length;
  const avg = (f) => done.reduce((a, e) => a + Math.abs(f(e) - e.actual), 0) / done.length;
  return { n: done.length, called: moved.length, right, miss: avg((e) => e.c), still: avg((e) => e.open) };
}
