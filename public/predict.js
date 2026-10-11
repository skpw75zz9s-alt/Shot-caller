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

// The close a probability implies: P(settlement > K) = p  =>  median settlement = K exp(sd z(p)), sd the settlement's
const impliedClose = (strike, pAbove, sigmaMin, mins) => strike * Math.exp(Math.sqrt(settleVariance(sigmaMin, mins)) * normInv(Math.min(0.98, Math.max(0.02, pAbove))));
export const LINE_NAMES = { bot: 'Bot', kalshi: 'Kalshi', exch: '5 exch', engine: 'Engine', guide: 'Guide', micro: 'Micro', moves: 'Move model', still: 'No change' };
// Every independent forecast of the close, each a line from today's price, clipped to the 90% cone so a runaway can't
// fly off the chart:
//   bot      the close the bot's own final odds imply (after every proven nudge), pBot = its P(YES)
//   kalshi   the close Kalshi's price implies
//   exch     the 5 exchanges' trend, half carried to the close
//   engine   the close the prediction engine's P(UP) implies (public/predictor.js)
//   guide    the close the 15-minute forecast's calibrated P(UP) implies (public/guide.js), for the round it was made for
//   micro    the micro model's proven 1-5 minute read (public/micro.js), held after 5 minutes
//   moves    the move model's proven moves (public/candlemodel.js)
//   still    no change: today's price (blended and graded, not drawn); at these horizons it's often the one to beat
// micro and moves only appear when they say something (a proven read that isn't flat).
// until: how far ahead the lines run (at least the close; the chart uses a rolling 15 minutes). `end` stays the close prediction.
export function predictionLines({ spot, sigmaMin, now, close, until = close, strike, yesMid, strikeType, trades = [], pBot = null, engine = null, guide = null, micro = null, cm = null }) {
  if (!spot || !(close > now) || !(sigmaMin > 0)) return [];
  const mins = (close - now) / 60000, sd = spot * sigmaMin * Math.sqrt(mins), less = /^less/.test(strikeType || '');
  const z90 = 1.6448536269514722, clip = (v) => Math.min(spot + z90 * sd, Math.max(spot - z90 * sd, v)); // the 90% band's edge, exactly
  const lines = [];
  if (pBot != null && strike > 0) lines.push({ key: 'bot', name: 'Bot', color: '#22d3ee', end: clip(impliedClose(strike, less ? 1 - pBot : pBot, sigmaMin, mins)), from: spot });
  const k = kalshiImplied({ strike, yesMid, strikeType, sigmaMin, minutesLeft: mins });
  if (k) lines.push({ key: 'kalshi', name: 'Kalshi', color: '#a78bfa', end: clip(k), from: spot });
  const tr = exchangeTrend(trades, now, close);
  if (tr) lines.push({ key: 'exch', name: '5 exch', color: '#fbbf24', end: clip(tr.end), from: tr.start });
  if (engine?.pUp != null && strike > 0) lines.push({ key: 'engine', name: 'Engine', color: '#34d399', end: clip(impliedClose(strike, engine.pUp, sigmaMin, mins)), from: spot });
  if (guide?.pUp != null && strike > 0) lines.push({ key: 'guide', name: 'Guide', color: '#f472b6', end: clip(impliedClose(strike, guide.pUp, sigmaMin, mins)), from: spot });
  if (micro?.horizons) {
    const since = Math.max(0, (now - (micro.at ?? now)) / 60000), move = microOffset(micro, since + Math.min(5, mins)) - microOffset(micro, since);
    if (Math.abs(move) >= 0.01) lines.push({ key: 'micro', name: 'Micro', color: '#60a5fa', end: clip(spot + move), from: spot });
  }
  if (cm?.moves) {
    const move = cmMove(cm, (close - cm.at) / 60000) - cmMove(cm, (now - cm.at) / 60000);
    if (Math.abs(move) >= 0.01) lines.push({ key: 'moves', name: 'Move model', color: '#fb923c', end: clip(spot + move), from: spot });
  }
  lines.push({ key: 'still', name: 'No change', color: '#94a3b8', end: spot, from: spot, hidden: true });
  for (const l of lines) l.pts = path(l.from, l.end, now, close, Math.max(close, until), l.key === 'kalshi');
  return lines;
}

// The record: per line, its 5-minutes-left predictions against where BTC closed: average miss, mean squared error and
// bias (dollars). `still` is "no change" (logged as spot by older versions). Rounds first seen after the 5-minute mark
// (only minute checkpoints, no 5-minute call) aren't in it.
const META = new Set(['ticker', 'closeTime', 'at', 'spot', 'actual', 'gone', 'cps', 'sd', 'blend']);
export function predictionRecord(log) {
  const done = log.filter((e) => e.actual != null && (e.at != null || !e.cps));
  const keys = [...new Set(done.flatMap((e) => Object.keys(e).filter((k) => !META.has(k) && Number.isFinite(e[k]))))];
  const stat = (k) => {
    const xs = done.filter((e) => Number.isFinite(k === 'still' ? e.still ?? e.spot : e[k])).map((e) => (k === 'still' ? e.still ?? e.spot : e[k]) - e.actual);
    return xs.length ? { miss: xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length, mse: xs.reduce((a, b) => a + b * b, 0) / xs.length, bias: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null;
  };
  const lines = Object.fromEntries([...new Set([...keys, 'still'])].map((k) => [k, stat(k)]).filter(([, v]) => v));
  return { rounds: done.length, lines, ...lines };
}

// ---------- the expected path: where the bot expects BTC to be, minute by minute (the cone's centre) ----------
// The blend of the lines: the minimum-variance combination of their bias-corrected forecasts (Bates-Granger with the full
// error covariance). With e_i the line's miss at past closes and b_i its bias, the weights minimise
// E[(sum w_i (e_i - b_i))^2] subject to sum w_i = 1, w_i >= 0:
//   w = M^-1 1 / (1' M^-1 1) on the lines kept, M = the bias-corrected error second-moment matrix
// Lines that miss together (Bot and Kalshi often do) share weight instead of each counting fully, which inverse-MSE
// weights (only right when errors are independent) can't do. Any line whose weight would go negative is dropped and the
// rest re-solved.
// Every minute (v13): each line's close prediction is logged at every whole minute of the round (14 down to 1 minute
// left), not just at 5 minutes left, so a round gives ~14 graded samples instead of 1. Misses are measured in typical
// moves (miss / (spot x 1-minute vol x sqrt(minutes left))) so a miss with 14 minutes left and one with 1 minute left
// are comparable and pool. Which line is best changes with the time left (the market's price says more near the close,
// a trend more early), so the weights are fitted per stretch (1-3, 4-7 and 8-14 minutes left), each pulled toward the
// all-minutes fit until it has 30 rounds of its own.
// Shrinkage everywhere, so a short record can't overfit (n = rounds): biases toward 0 (n/(n+60): a few rounds' average
// miss is mostly noise), M toward its diagonal (by 20/(n+20)) and the weights toward equal ones (by 20/(n+20): on a short
// record a plain average is hard to beat). Lines with fewer than 5 graded rounds get the average weight until they have
// a record ("no change" gets none: it's the baseline, and joins the blend only when its record earns it a share).
// Each line's moves are scaled first (scaleSamples: how far they really carry), and the blended move gets its own
// scale (finalScale): v13.1, ~0-2% better again where lines are well sized, ~12-14% where they over- or undershoot,
// and level with "no change" when they know nothing.
// Checked walk-forward on simulated rounds (lines that know part of the move, better or worse by the time left): ~3-8%
// smaller average miss than v12.9's one-sample-a-round fit, about level with a plain average for the first 30 rounds
// and ~2-5% better after; with lines that know nothing, level with v12.9 (both 1-2% behind "no change").
export const BLEND = { minRounds: 5, shrink: 20, biasShrink: 60, pool: 30, equal: 20, bands: [[1, 3], [4, 7], [8, 14]] };
// The graded samples: one per round per logged minute. Rounds logged before v13 have one sample (5 minutes left) and no
// sd: they use the spread of "no change"'s misses over those rounds (its typical miss is the typical move) as theirs.
export function blendSamples(log) {
  const done = (log || []).filter((e) => e.actual != null), old = done.filter((e) => !e.cps && Number.isFinite(e.spot));
  const s0 = Math.sqrt(old.reduce((a, e) => a + (e.spot - e.actual) ** 2, 0) / (old.length || 1)) || 1; // (a perfect "no change": any scale will do)
  const zs = (c, actual, sd) => {
    const z = {};
    for (const k of Object.keys(c)) if (!META.has(k) && Number.isFinite(c[k])) z[k] = (c[k] - actual) / sd;
    if (z.still == null && Number.isFinite(c.spot)) z.still = (c.spot - actual) / sd;
    return z;
  };
  const out = [];
  for (const e of done) {
    if (e.cps) { for (const [m, c] of Object.entries(e.cps)) if (c.sd > 0) out.push({ r: e.closeTime, m: +m, z: zs(c, e.actual, c.sd) }); }
    else out.push({ r: e.closeTime, m: 5, z: zs(e, e.actual, s0) });
  }
  return out;
}
// Which stretch of the round a number of minutes left falls in (the index into BLEND.bands)
export const blendBand = (mins) => { const m = Math.min(14, Math.max(1, Math.round(mins))); return BLEND.bands.findIndex(([a, b]) => m >= a && m <= b); };
// The fit: { weights (an average line = 1), bias (typical moves), known (lines with a record), rounds, scale (each line's
// move scale) }. With mins, the
// fit for that stretch of the round; without, the all-minutes fit.
export function blendFit(log, mins = null) {
  const ss = blendSamples(log), sAll = scaleSamples(ss), xAll = applyScale(ss, sAll), fAll = fitSamples(xAll);
  const all = { ...fAll, scale: sAll, final: finalScale(xAll, fAll) };
  if (mins == null) return all;
  const [a, b] = BLEND.bands[blendBand(mins)], bs = ss.filter((s) => s.m >= a && s.m <= b), sc = scaleSamples(bs, sAll), xs = applyScale(bs, sc), f = fitSamples(xs, all);
  return { ...f, scale: sc, final: finalScale(xs, f, all.final) };
}
// Each line's scale (v13.1): how far its predicted moves really carry. A line can point the right way and still call the
// size wrong: Kalshi's price or the bot's odds turned into a close overshoot when they're noisy (or priced with another
// volatility), the exchanges' trend undershoots. The scale is the line's Mincer-Zarnowitz slope, the least-squares
// answer to "actual move = scale x predicted move" (both from "no change", in typical moves, centred):
//   scale = Cov(predicted, actual) / Var(predicted)
// shrunk toward 1 by 20 rounds' worth of the line's own spread (so a short record barely moves it), kept within 0..2.
// A line that knows nothing gets scaled toward 0 (it collapses onto "no change"), one that's too timid gets stretched.
// Like the weights, per stretch of the round, pulled toward the all-minutes scale until it has 30 rounds of its own.
export const SCALE = { prior: 20, lo: 0, hi: 2 };
function scaleSamples(ss, prior = null) {
  const out = {}, keys = new Set(ss.flatMap((s) => Object.keys(s.z)));
  for (const k of keys) {
    if (k === 'still') continue;
    const xs = ss.filter((s) => s.z[k] != null && s.z.still != null), n = new Set(xs.map((s) => s.r)).size, target = prior?.[k] ?? 1;
    if (!xs.length) { out[k] = target; continue; }
    const x = xs.map((s) => s.z[k] - s.z.still), y = xs.map((s) => -s.z.still), mx = x.reduce((t, v) => t + v, 0) / x.length, my = y.reduce((t, v) => t + v, 0) / y.length;
    const sxx = x.reduce((t, v) => t + (v - mx) ** 2, 0), sxy = x.reduce((t, v, i) => t + (v - mx) * (y[i] - my), 0);
    if (!(sxx > 0)) { out[k] = target; continue; }
    const c = (prior ? BLEND.pool : SCALE.prior) * sxx / n; // that many rounds' worth of the line's own spread
    out[k] = Math.min(SCALE.hi, Math.max(SCALE.lo, (sxy + c * target) / (sxx + c)));
  }
  return out;
}
// The blend's own scale: averaging lines that were each shrunk on their own leaves the average too timid (combining
// cancels some of their noise, so it can afford to go further), so the blended move gets its own slope, the same way
// (shrunk toward 1, or toward the all-minutes one for a stretch). The expected path multiplies its move by it.
function finalScale(ss, fit, target = 1) {
  const pts = [];
  for (const s of ss) {
    if (s.z.still == null) continue;
    let t = 0, w = 0;
    for (const [k, v] of Object.entries(s.z)) { const wk = fit.weights[k] ?? 0; t += wk * (v - (fit.bias[k] || 0)); w += wk; }
    if (w > 0) pts.push({ r: s.r, x: t / w - s.z.still, y: -s.z.still });
  }
  const n = new Set(pts.map((p) => p.r)).size;
  if (!n) return target;
  const mx = pts.reduce((t, p) => t + p.x, 0) / pts.length, my = pts.reduce((t, p) => t + p.y, 0) / pts.length;
  const sxx = pts.reduce((t, p) => t + (p.x - mx) ** 2, 0), sxy = pts.reduce((t, p) => t + (p.x - mx) * (p.y - my), 0);
  if (!(sxx > 0)) return target;
  const c = (target === 1 ? SCALE.prior : BLEND.pool) * sxx / n;
  return Math.min(SCALE.hi, Math.max(SCALE.lo, (sxy + c * target) / (sxx + c)));
}
// The samples with each line's predicted move scaled (its miss becomes scale x predicted move - actual move)
function applyScale(ss, scale) {
  return ss.map((s) => (s.z.still == null ? s : { ...s, z: Object.fromEntries(Object.entries(s.z).map(([k, v]) => [k, k === 'still' ? v : (scale[k] ?? 1) * (v - s.z.still) + s.z.still])) }));
}
// The lines with their moves (from the current price) scaled: what the chart draws and the blend combines
export function scaleLines(lines, scale, spot) {
  return (lines || []).map((l) => { const b = scale?.[l.key]; return b == null || b === 1 ? l : { ...l, end: spot + b * (l.end - spot), pts: l.pts.map((p) => ({ ...p, v: spot + b * (p.v - spot) })) }; });
}
function fitSamples(ss, prior = null) {
  const P = BLEND.pool, keys = [...new Set([...ss.flatMap((s) => Object.keys(s.z)), ...(prior ? Object.keys(prior.bias) : []), 'still'])];
  const has = Object.fromEntries(keys.map((k) => [k, ss.filter((s) => s.z[k] != null)]));
  const roundsOf = (xs) => new Set(xs.map((s) => s.r)).size, nr = Object.fromEntries(keys.map((k) => [k, roundsOf(has[k])]));
  const bias = {};
  for (const k of keys) {
    const xs = has[k], mean = xs.length ? xs.reduce((t, s) => t + s.z[k], 0) / xs.length : 0, n = nr[k];
    const own = mean * (n / (n + BLEND.biasShrink)); // a short record's average miss is mostly noise: shrunk toward 0
    bias[k] = prior ? (n * own + P * (prior.bias[k] ?? 0)) / (n + P) : own;
  }
  const known = prior ? prior.known : keys.filter((k) => nr[k] >= BLEND.minRounds), weights = {}, M = {};
  if (known.length) {
    // the stretch's own moments; a stretch's fit pulls its error sizes toward the all-minutes ones geometrically (so one
    // stretch's much bigger misses can't swamp another's) and its correlations toward theirs linearly, by rounds
    const mom = (a, b) => { const xs = has[a].filter((s) => s.z[b] != null), d = (s, k) => s.z[k] - bias[k]; return { n: roundsOf(xs), ab: xs.reduce((t, s) => t + d(s, a) * d(s, b), 0) / (xs.length || 1), aa: xs.reduce((t, s) => t + d(s, a) ** 2, 0) / (xs.length || 1), bb: xs.reduce((t, s) => t + d(s, b) ** 2, 0) / (xs.length || 1) }; };
    const diag = {};
    for (const a of known) {
      const o = mom(a, a), pv = prior?.M[a]?.[a];
      diag[a] = !prior ? o.aa : o.n && o.aa > 0 && pv > 0 ? Math.exp((o.n * Math.log(o.aa) + P * Math.log(pv)) / (o.n + P)) : (pv ?? o.aa);
    }
    for (const a of known) {
      M[a] = {};
      for (const b of known) {
        if (a === b) { M[a][b] = diag[a]; continue; }
        const o = mom(a, b), c = o.aa > 0 && o.bb > 0 ? o.ab / Math.sqrt(o.aa * o.bb) : 0;
        const pc = prior && prior.M[a]?.[a] > 0 && prior.M[b]?.[b] > 0 ? (prior.M[a][b] ?? 0) / Math.sqrt(prior.M[a][a] * prior.M[b][b]) : 0;
        M[a][b] = (prior ? (o.n * c + P * pc) / (o.n + P) : c) * Math.sqrt(diag[a] * diag[b]);
      }
    }
    const n = prior ? prior.rounds : Math.min(...known.map((k) => nr[k])), lam = BLEND.shrink / (n + BLEND.shrink);
    const Ms = known.map((a, i) => known.map((b, j) => (i === j ? M[a][b] : (1 - lam) * M[a][b])));
    let active = known.map((_, i) => i), w = null;
    while (active.length) {
      const x = solveSym(active.map((i) => active.map((j) => Ms[i][j])), active.map(() => 1)), tot = x ? x.reduce((t, v) => t + v, 0) : 0;
      if (!x || !(tot > 0)) { w = null; break; }
      const ws = x.map((v) => v / tot), neg = ws.reduce((m, v, i) => (v < ws[m] ? i : m), 0);
      if (ws[neg] >= 0) { w = new Map(active.map((i, k) => [i, ws[k]])); break; }
      active = active.filter((_, k) => k !== neg); // the most negative line drops out; re-solve
    }
    if (!w) { const inv = known.map((_, i) => (Ms[i][i] > 0 ? 1 / Ms[i][i] : 0)), t = inv.reduce((u, v) => u + v, 0) || 1; w = new Map(inv.map((v, i) => [i, v / t])); } // degenerate: inverse-MSE
    // pulled toward the no-record weights (equal, "no change" 0) by S/(n+S): fitted weights are noisy on a short record,
    // where a plain average is hard to beat
    const n0 = prior ? prior.rounds : n, pull = BLEND.equal / (n0 + BLEND.equal), w0 = known.map((k) => (k === 'still' ? 0 : 1)), t0 = w0.reduce((u, v) => u + v, 0);
    known.forEach((k, i) => { weights[k] = ((1 - pull) * (w.get(i) ?? 0) + pull * (t0 ? w0[i] / t0 : 1 / known.length)) * known.length; }); // scaled so an average line weighs 1
  }
  for (const k of keys) if (!(k in weights)) weights[k] = k === 'still' ? 0 : 1; // no record yet: an average line ("no change" only joins once it has one)
  return { weights, bias, known, M, rounds: prior ? prior.rounds : (known.length ? Math.min(...known.map((k) => nr[k])) : 0) };
}
// The blend's own scoreboard: its close forecast logged each minute (with the weights known then, so out of sample) vs
// "no change" and the best single line, each on the same checkpoints. Average miss in dollars.
export function blendScore(log) {
  const xs = [];
  for (const e of log || []) if (e.actual != null && e.cps) for (const c of Object.values(e.cps)) if (Number.isFinite(c.blend)) xs.push({ c, a: e.actual, r: e.closeTime });
  if (!xs.length) return { n: 0 };
  const avg = (ys, k) => ys.reduce((t, x) => t + Math.abs(x.c[k] - x.a), 0) / ys.length;
  let best = null;
  for (const k of new Set(xs.flatMap((x) => Object.keys(x.c).filter((q) => !META.has(q) && q !== 'still')))) {
    const ys = xs.filter((x) => Number.isFinite(x.c[k]));
    if (ys.length < xs.length / 2) continue; // seldom drawn: not a fair comparison
    const m = avg(ys, k);
    if (!best || m < best.miss) best = { key: k, miss: m, blend: avg(ys, 'blend'), n: ys.length };
  }
  const st = xs.filter((x) => Number.isFinite(x.c.still));
  return { n: xs.length, rounds: new Set(xs.map((x) => x.r)).size, blend: avg(xs, 'blend'), still: st.length ? avg(st, 'still') : null, stillBlend: st.length ? avg(st, 'blend') : null, best };
}
// Each line shifted by its bias in dollars (blendFit's, in typical moves, times the typical move to the close),
// proportionally from now to its close, then held
export function correctLines(lines, bias, now, close) {
  return (lines || []).map((l) => { const b = bias?.[l.key] || 0; return b ? { ...l, end: l.end - b, pts: l.pts.map((p) => ({ ...p, v: p.v - b * Math.min(1, Math.max(0, (p.t - now) / (close - now))) })) } : l; });
}
function solveSym(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
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
// The expected path (price at time t): the optimally blended prediction lines (blendFit: every forecast, the micro
// model and the move model included, each scaled and bias-corrected; the blended move times the blend's own scale,
// `final`), bent by the flip forecast (today's momentum carried forward,
// turning where a flip looks ripe: public/flip.js), then scaled by beta (how far its minute moves have really carried,
// fitted on its own graded minutes: pathRecord). The cone's centre follows it, and the flip markers sit on its turns.
export function expectedPath({ lines, spot, now, weights = null, flip = null, beta = 1, final = 1 }) {
  const w = weights || {};
  const blend = (t) => { let s = 0, ws = 0; for (const l of lines || []) { const v = valueAt(l.pts, t), k = w[l.key] ?? 1; if (v != null) { s += v * k; ws += k; } } return ws ? s / ws : spot; };
  return (t) => spot + beta * (final * (blend(t) - spot) + flipOffset(flip, (t - now) / 60000));
}
// The expected path on whole minutes from the next one to the close: { t, o, c } (where it expects BTC at the start and
// end of each minute). Each minute is graded at its close (pathRecord); its turns are the flip markers (pathTurns).
export function pathMinutes({ lines, spot, sigmaMin, now, close, weights = null, flip = null, beta = 1, final = 1 }) {
  if (!lines?.length || !spot || !(sigmaMin > 0) || !(close > now)) return [];
  const path = expectedPath({ lines, spot, now, weights, flip, beta, final }), out = [];
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
