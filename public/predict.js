// Prediction lines for the forecast cone: three reads of where BTC closes this round, each from a different market.
//   Bot        the bot's own model: today's price carried forward with its momentum (the cone is centred on it)
//   Kalshi     what Kalshi's price implies: the close level at which "above the target" is exactly as likely as
//              Kalshi's YES price says, using the bot's volatility
//   Exchanges  the five exchanges' combined trend: a straight-line fit through their median price over the last
//              5 minutes, carried to the close at half strength (trends fade)
// Every round, each line's close prediction with 5 minutes left is graded against where BTC really closed, next to
// "no change" (the price at that moment) as the baseline any prediction has to beat.
import { normCdf, settleVariance } from './model.js';
import { flipOffset, turnPoints } from './flip.js';
import { microOffset } from './micro.js';
import { cmMove } from './candlemodel.js';

// Inverse of the standard normal CDF: Acklam's rational approximation (relative error ~1e-9), then one Halley step on
// the exact CDF, which takes it to full double precision
export function normInv(p) {
  const x = acklam(p);
  if (!Number.isFinite(x)) return x;
  const e = normCdf(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}
function acklam(p) {
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
// log-linear from today's price to the close prediction; past the close (out to `until`) it keeps the same rate per
// minute, or holds the close level when `hold` (Kalshi's price only speaks for this round's close)
const path = (from, to, now, close, until = close, hold = false, step = 60000) => {
  // on whole minutes, like the candles (starting on the live candle), so redraws don't reshuffle the chart's timeline
  const pts = [], rate = Math.log(to / from) / (close - now), t0 = Math.floor(now / step) * step;
  pts.push({ t: t0, v: from });
  for (let t = t0 + step; t < close; t += step) pts.push({ t, v: from * Math.exp(rate * (t - now)) });
  pts.push({ t: close, v: to });
  for (let t = close + step; t <= until; t += step) pts.push({ t, v: hold ? to : from * Math.exp(rate * (t - now)) });
  return pts;
};

// Kalshi's implied close: P(settlement > strike) = YES mid  =>  median = strike * exp(sd * z(mid)), with sd the settlement
// average's (model.js settleVariance), the same one the bot prices with
export function kalshiImplied({ strike, yesMid, strikeType = 'greater', sigmaMin, minutesLeft }) {
  if (!strike || yesMid == null || !(sigmaMin > 0) || !(minutesLeft > 0)) return null;
  const pAbove = /^less/.test(strikeType) ? 1 - yesMid : yesMid;
  const p = Math.min(0.98, Math.max(0.02, pAbove)); // the ends of the book say little about a level
  return strike * Math.exp(Math.sqrt(settleVariance(sigmaMin, minutesLeft)) * normInv(p));
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
// until: how far ahead the lines run (at least the close; the chart uses a rolling 15 minutes). `end` stays the close prediction.
// engine: the prediction engine's live read (public/predictor.js) { pUp } - its implied close becomes a line too
export function predictionLines({ spot, sigmaMin, driftMin = 0, now, close, until = close, strike, yesMid, strikeType, trades = [], engine = null }) {
  if (!spot || !(close > now) || !(sigmaMin > 0)) return [];
  const mins = (close - now) / 60000, sd = spot * sigmaMin * Math.sqrt(mins);
  const z90 = 1.6448536269514722, clip = (v) => Math.min(spot + z90 * sd, Math.max(spot - z90 * sd, v)); // the 90% band's edge, exactly
  const lines = [];
  lines.push({ key: 'bot', name: 'Bot', color: '#22d3ee', end: clip(spot * Math.exp(driftMin * mins)), from: spot });
  const k = kalshiImplied({ strike, yesMid, strikeType, sigmaMin, minutesLeft: mins });
  if (k) lines.push({ key: 'kalshi', name: 'Kalshi', color: '#a78bfa', end: clip(k), from: spot });
  const tr = exchangeTrend(trades, now, close);
  if (tr) lines.push({ key: 'exch', name: '5 exch', color: '#fbbf24', end: clip(tr.end), from: tr.start });
  // the engine's P(UP) as a close: the price it expects BTC to finish at (P(close > target) = P(UP) => median close)
  if (engine?.pUp != null && strike > 0) lines.push({ key: 'engine', name: 'Engine', color: '#34d399', end: clip(strike * Math.exp(Math.sqrt(settleVariance(sigmaMin, mins)) * normInv(Math.min(0.98, Math.max(0.02, engine.pUp))))), from: spot });
  for (const l of lines) l.pts = path(l.from, l.end, now, close, Math.max(close, until), l.key === 'kalshi');
  return lines;
}

// The record: average miss (dollars) of each line's 5-minutes-left prediction, vs "no change", and its mean squared error
export function predictionRecord(log) {
  const done = log.filter((e) => e.actual != null);
  const avg = (k) => { const xs = done.filter((e) => e[k] != null).map((e) => e[k] - e.actual); return xs.length ? { miss: xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length, mse: xs.reduce((a, b) => a + b * b, 0) / xs.length, n: xs.length } : null; };
  return { rounds: done.length, bot: avg('bot'), kalshi: avg('kalshi'), exch: avg('exch'), engine: avg('engine'), still: avg('spot') };
}

// ---------- the expected path: where the bot expects BTC to be, minute by minute (the cone's centre) ----------
// The expected path is a blend of the prediction lines, each weighted by its inverse mean squared error at past closes
// (inverse-variance weighting: the weights that minimise the blend's error for independent errors), equal weights until
// each has 5 graded rounds.
export function blendWeights(record) {
  const w = {};
  for (const k of ['bot', 'kalshi', 'exch', 'engine']) { const x = record?.[k], mse = x?.mse ?? (x?.miss > 0 ? x.miss * x.miss : null); w[k] = x && x.n >= 5 && mse > 0 ? 1 / mse : null; }
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
// The volatility of the last 30 complete one-minute candles (average range / sqrt(8/pi): a random walk's expected
// high-low range over a minute is sqrt(8/pi) = 1.596 times its per-minute sd), kept within
// half to double the model's
export function candleSigma(bars, sigmaMin, now) {
  const done = (bars || []).filter((b) => b.t + 60000 <= now && b.h > 0 && b.l > 0).slice(-30);
  if (done.length < 10) return sigmaMin;
  const r = done.reduce((a, b) => a + (b.h - b.l) / ((b.h + b.l) / 2), 0) / done.length / Math.sqrt(8 / Math.PI);
  return sigmaMin > 0 ? Math.min(2 * sigmaMin, Math.max(0.5 * sigmaMin, r)) : r;
}
// flip (public/flip.js flipForecast): bends the expected path to carry today's momentum and turn where a flip looks ripe
// micro (public/micro.js microRead): the small details' learned push over the next 5 minutes (zero until proven)
// The expected path (price at time t): the weighted prediction lines, bent by the flip forecast and the micro model,
// then scaled by beta (how far its minute moves have really carried, fitted on its own graded minutes: pathRecord),
// plus the candle model's proven moves (public/candlemodel.js; zero for horizons that haven't beaten "no change").
// The cone's centre follows it, and the flip markers sit on its turns.
export function expectedPath({ lines, spot, now, weights = null, flip = null, micro = null, beta = 1, cm = null }) {
  const w = weights || blendWeights(null);
  const blend = (t) => { let s = 0, ws = 0; for (const l of lines || []) { const v = valueAt(l.pts, t), k = w[l.key] ?? 1; if (v != null) { s += v * k; ws += k; } } return ws ? s / ws : spot; };
  const microAt = micro?.at ?? now, cmAt = cm?.at ?? now;
  const raw = (t) => blend(t) + flipOffset(flip, (t - now) / 60000) + microOffset(micro, (t - microAt) / 60000) - microOffset(micro, (now - microAt) / 60000);
  return (t) => spot + beta * (raw(t) - spot) + cmMove(cm, (t - cmAt) / 60000) - cmMove(cm, (now - cmAt) / 60000);
}
// The expected path on whole minutes from the next one to the close: { t, o, c } (where it expects BTC at the start and
// end of each minute). Each minute is graded at its close (pathRecord); its turns are the flip markers (pathTurns).
export function pathMinutes({ lines, spot, sigmaMin, now, close, weights = null, flip = null, micro = null, beta = 1, cm = null }) {
  if (!lines?.length || !spot || !(sigmaMin > 0) || !(close > now)) return [];
  const path = expectedPath({ lines, spot, now, weights, flip, micro, beta, cm }), out = [];
  for (let t = Math.floor(now / 60000) * 60000 + 60000; t < close; t += 60000) out.push({ t, o: path(t), c: path(Math.min(close, t + 60000)) });
  return out;
}
// ---------- the cone: the market's most predictable outcome, calibrated on its own record ----------
// Not a plain funnel around the price any more (v12.2). It scans what the bot reads and asks where BTC is most likely
// to be at each minute:
//   Centre    the expected path (prediction lines + engine + flip forecast + micro model), not the current price
//   Width     the volatility the bot prices with (learned by time of week, corrected every second), blended with how
//             far the last 30 real candles actually moved (geometric mean), x the cone's own calibration factor
//   Skew      the last hour's upside vs downside moves (semi-deviations): when drops have been sharper than rallies the
//             downside of the cone is wider (and the reverse), kept within 0.7x-1.4x
//   Calibration  every round the cone's close band (with 5 minutes left) is checked against where BTC really closed;
//             its width factor is set so the 90% band holds ~90% of closes (from the actual misses, shrunk toward 1
//             until 20+ rounds)
// The summary is the most predictable outcome: the most likely close zone (the 50% band), the 90% band, and the
// chance of finishing above the target, graded against Kalshi's own price at the same moment.
export function coneSkew(bars, now) {
  const done = (bars || []).filter((b) => b.t + 60000 <= now).slice(-61);
  if (done.length < 30) return { up: 1, dn: 1 };
  let su = 0, sd = 0, n = 0;
  for (let i = 1; i < done.length; i++) { const r = Math.log(done[i].c / done[i - 1].c); if (r > 0) su += r * r; else sd += r * r; n++; }
  const up = Math.sqrt((2 * su) / n), dn = Math.sqrt((2 * sd) / n), mean = (up + dn) / 2;
  if (!(mean > 0)) return { up: 1, dn: 1 };
  const k = (x) => Math.min(1.4, Math.max(0.7, x / mean));
  return { up: k(up), dn: k(dn) };
}
// The split normal (centre m, sd a above it, b below it; a share a/(a+b) of the mass lies above m):
//   CDF       x < m: 2b/(a+b) Phi((x-m)/b)          x >= m: 1 - 2a/(a+b) (1 - Phi((x-m)/a))
//   quantile  the exact inverse of that
export function splitCdf(x, m, a, b) {
  if (!(a > 0) || !(b > 0)) return x < m ? 0 : 1;
  return x < m ? (2 * b / (a + b)) * normCdf((x - m) / b) : 1 - (2 * a / (a + b)) * (1 - normCdf((x - m) / a));
}
export const splitAbove = (K, m, a, b) => 1 - splitCdf(K, m, a, b);
export function splitQuantile(q, m, a, b) {
  if (!(a > 0) || !(b > 0)) return m;
  return q < b / (a + b) ? m + b * normInv(q * (a + b) / (2 * b)) : m + a * normInv(1 - (1 - q) * (a + b) / (2 * a));
}
export function marketCone({ path, spot, sigmaMin, now, close, bars = null, strike = null, strikeType = 'greater', fix = 1, step = 60000 }) {
  if (!spot || !(sigmaMin > 0) || !(close > now)) return { pts: [], summary: null };
  const center = path || (() => spot), real = candleSigma(bars, sigmaMin, now), sig = Math.sqrt(sigmaMin * real) * (fix > 0 ? fix : 1), sk = coneSkew(bars, now);
  const at = (t) => {
    const m = center(t), sd = spot * sig * Math.sqrt(Math.max(0, t - now) / 60000), a = sd * sk.up, b = sd * sk.dn;
    if (!(sd > 0)) return { t, mid: m, hi50: m, lo50: m, hi90: m, lo90: m, a, b };
    // the exact central 50% and 90% of the split normal (equal tails: 25/75%, 5/95%)
    return { t, mid: m, lo50: splitQuantile(0.25, m, a, b), hi50: splitQuantile(0.75, m, a, b), lo90: splitQuantile(0.05, m, a, b), hi90: splitQuantile(0.95, m, a, b), a, b };
  };
  const pts = [{ ...at(now), t: Math.floor(now / step) * step }];
  for (let t = Math.floor(now / step) * step + step; t < close; t += step) pts.push(at(t));
  const end = at(close); pts.push(end);
  // the chance of SETTLING above the target: Kalshi settles on the last minute's average, a little less spread out
  const mins = (close - now) / 60000, k = mins > 0 && sig > 0 ? Math.sqrt(settleVariance(sig, mins) / (sig * sig * mins)) : 1;
  const pUp = strike > 0 ? splitAbove(strike, end.mid, end.a * k, end.b * k) : null;
  return { pts, summary: { t: close, mid: end.mid, lo50: end.lo50, hi50: end.hi50, lo90: end.lo90, hi90: end.hi90, a: end.a, b: end.b, skew: sk, sig, fix,
    pAbove: pUp, pYes: pUp == null ? null : /^less/.test(strikeType || '') ? 1 - pUp : pUp } };
}
// The cone's record: rounds whose close band (with 5 min left) has been graded.
//   Coverage  where each close fell in the cone's own distribution (its CDF value, the probability integral
//             transform): inside the 50% band = between 25% and 75%, inside the 90% band = between 5% and 95%
//   Width     for each round, the width factor that would have put that close exactly on the 90% band's edge (the
//             band scales linearly with the width); the factor that holds 90% of closes is the 90th percentile of those
//   Odds      the Brier score of its "above the target" chance vs Kalshi's price then
export function coneRecord(log) {
  const done = (log || []).filter((e) => e.actual != null && e.a > 0 && e.b > 0);
  if (!done.length) return { n: 0, fix: 1 };
  const u = done.map((e) => splitCdf(e.actual, e.mid, e.a, e.b));
  const in50 = u.filter((x) => x >= 0.25 && x <= 0.75).length / u.length, in90 = u.filter((x) => x >= 0.05 && x <= 0.95).length / u.length;
  const need = done.map((e) => (e.actual >= e.mid ? (e.actual - e.mid) / (splitQuantile(0.95, e.mid, e.a, e.b) - e.mid) : (e.mid - e.actual) / (e.mid - splitQuantile(0.05, e.mid, e.a, e.b)))).sort((x, y) => x - y);
  const q90 = need[Math.min(need.length - 1, Math.ceil(0.9 * need.length) - 1)], raw = Math.min(1.8, Math.max(0.6, q90));
  const fix = done.length >= 10 ? 1 + (raw - 1) * done.length / (done.length + 20) : 1;
  const gr = done.filter((e) => e.pAbove != null && e.strike > 0), y = (e) => (e.actual > e.strike ? 1 : 0);
  const brier = gr.length ? gr.reduce((a, e) => a + (e.pAbove - y(e)) ** 2, 0) / gr.length : null;
  const km = gr.filter((e) => e.kAbove != null), brierK = km.length ? km.reduce((a, e) => a + (e.kAbove - y(e)) ** 2, 0) / km.length : null;
  const brierC = km.length ? km.reduce((a, e) => a + (e.pAbove - y(e)) ** 2, 0) / km.length : null;
  return { n: done.length, in50, in90, fix, brier, brierKalshi: brierK, brierSame: brierC, nKalshi: km.length };
}

// The record: how often the expected path's minute (as it stood just before that minute began) got the direction right;
// its average miss at the minute's close vs "no change" (the minute's open); and beta, the least-squares scale of its
// predicted moves (sum(pred x actual) / sum(pred^2): the factor that minimises the squared miss), shrunk toward 1 until
// there are plenty of minutes and kept within 0-1.5
export const BETA_PRIOR = 60;
export function pathRecord(log) {
  const done = log.filter((e) => e.actual != null && e.open != null);
  if (!done.length) return { n: 0, beta: 1 };
  const moved = done.filter((e) => e.actual !== e.open && e.c !== e.o);
  const right = moved.filter((e) => Math.sign(e.c - e.o) === Math.sign(e.actual - e.open)).length;
  const avg = (f) => done.reduce((a, e) => a + Math.abs(f(e) - e.actual), 0) / done.length;
  // beta from the raw (unscaled) moves each minute was predicted with
  const rawMove = (e) => (e.c - e.o) / (e.beta || 1);
  let sxy = 0, sxx = 0;
  for (const e of done) { const m = rawMove(e), a = e.actual - e.open; sxy += m * a; sxx += m * m; }
  const fit = sxx > 0 ? sxy / sxx : 1, beta = Math.min(1.5, Math.max(0, (done.length * fit + BETA_PRIOR) / (done.length + BETA_PRIOR)));
  return { n: done.length, called: moved.length, right, miss: avg((e) => e.c), still: avg((e) => e.open), beta };
}

// The turns on the expected path (where it bottoms or tops out by at least a fifth of a typical minute), with the last 3
// minutes in front so a turn happening right now (the live candle) shows too: the chart marks them ↺. v0: the flip
// forecast's momentum ($/min), giving the price 3 minutes ago.
export function pathTurns(minutes, spot, now, sd1, v0 = 0) {
  if (!minutes?.length) return [];
  const live = Math.floor(now / 60000) * 60000;
  const pts = [{ t: live - 180000, v: spot - 3 * v0 }, { t: live, v: spot }, ...minutes.map((c) => ({ t: c.t, v: c.c }))];
  return turnPoints(pts, 0.2 * sd1).filter((x) => x.t >= live).map((x) => ({ ...x, now: x.t === live }));
}
