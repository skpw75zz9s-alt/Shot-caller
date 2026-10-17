// Flip check (v13.38): will the side that's ahead now lose by the close? Learned from the chart's history and from who's
// buying and selling, instead of the bot's odds alone.
//   The bot's math   how far price is past the target for the time left (the flip chance a fair coin-flip walk gives)
//   Chart history    every past round in the 1-minute candles (up to 3 weeks), at 10, 6 and 3 minutes left: the leader
//                    (above or below the round's open, Kalshi's target) and whether it lost, with what the chart showed:
//                      momentum   the last 3 minutes moving against the leader
//                      run        the last 5 minutes' run toward the leader (exhausted runs snap back)
//                      RSI        stretched the leader's way
//                      wick       the last candle's wick against the leader (rejected)
//                      candle flow   buyers vs sellers from the candles: volume on up candles vs down candles over the
//                                 last 5 minutes, and where they closed in their range (near the high = buyers won)
//                      volume     the last 3 minutes' volume against the hour's (a surge)
//                      pullback   how far price has come back from the round's extreme the leader's way
//   Buyers / sellers the live trade tape (the Round scan's reads on the exchanges: flow, absorption, big prints,
//                    momentum, futures): every graded scan sample, turned to point toward a flip
// Each is a logistic regression on top of the bot's flip chance (zero weights = the bot's math), fitted on the older 2/3
// of its data and scored on the newer 1/3 against the bot's math. Only a part that beats it there (log loss, z 2.5+, on
// 600+ chart or 200+ tape samples) is used: then its flip chance nudges the bot's odds (capped at 5 points) and blocks a
// flip call that it says is likely to flip back.
import { normCdf } from './model.js';
import { rsiSeries } from './indicators.js';
import { FEATURES as SCAN_FEATURES, FEATURE_NAMES as SCAN_NAMES } from './roundscan.js';

export const FLIP = { checkpoints: [10, 6, 3], train: 2 / 3, l2: 30, minChart: 600, minFlow: 200, z: 2.5, cap: 0.05, backMargin: 0.05 };
export const CHART_FEATURES = ['mom', 'run', 'rsi', 'wick', 'cflow', 'close', 'vol', 'pull'];
export const CHART_NAMES = { mom: 'Momentum against it', run: 'Its run (exhaustion)', rsi: 'RSI stretched its way', wick: 'Rejection wick', cflow: 'Candle flow (buyers vs sellers)', close: 'Where candles closed', vol: 'Volume surge', pull: 'Pullback from the extreme' };
const ROUND = 900000, MIN = 60000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (p) => { const q = clamp(p, 0.005, 0.995); return Math.log(q / (1 - q)); };
const sigm = (z) => 1 / (1 + Math.exp(-z));

// 1-minute volatility over the last hour at each bar
export function volSeries(bars) {
  const out = new Array(bars.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 1; i < bars.length; i++) {
    const r = Math.log(bars[i].c / bars[i - 1].c);
    s += r; s2 += r * r;
    if (i > 60) { const q = Math.log(bars[i - 60].c / bars[i - 61].c); s -= q; s2 -= q * q; }
    if (i >= 60) out[i] = Math.max(1e-5, Math.sqrt(Math.max(0, s2 / 60 - (s / 60) ** 2)));
  }
  return out;
}

// The chart's reads at bar i for a leader (+1 above the target, -1 below), each pointing toward a flip, about -2..2
export function chartFeatures(bars, i, { lead, sigma, roundStart, rsi = null }) {
  const b = bars[i], c = b.c, sd = Math.max(1e-9, c * sigma), at = (k) => bars[Math.max(0, i - k)].c;
  const mom = clamp((-(c - at(3)) * lead) / (sd * Math.sqrt(3)), -3, 3) / 1.5;
  const run = clamp(((c - at(5)) * lead) / (sd * Math.sqrt(5)), -3, 3) / 1.5;
  const r = rsi ?? rsiSeries(bars.slice(Math.max(0, i - 40), i + 1).map((x) => x.c), 14).at(-1);
  const rs = r == null ? 0 : ((r - 50) / 25) * lead;
  const range = b.h - b.l, wick = range > 0 ? (lead > 0 ? b.h - Math.max(b.o, b.c) : Math.min(b.o, b.c) - b.l) / range : 0;
  let vu = 0, vt = 0, cl = 0, n = 0;
  for (let k = Math.max(0, i - 4); k <= i; k++) { const x = bars[k], v = x.v > 0 ? x.v : 0; vt += v; vu += v * Math.sign(x.c - x.o); }
  for (let k = Math.max(0, i - 2); k <= i; k++) { const x = bars[k], rg = x.h - x.l; if (rg > 0) { cl += ((x.c - x.l) / rg - 0.5) * 2; n++; } }
  const cflow = vt > 0 ? (-vu / vt) * lead : 0, close = n ? (-cl / n) * lead : 0;
  let v3 = 0, v60 = 0, n60 = 0;
  for (let k = Math.max(0, i - 2); k <= i; k++) v3 += bars[k].v > 0 ? bars[k].v : 0;
  for (let k = Math.max(0, i - 62); k <= i - 3; k++) { v60 += bars[k].v > 0 ? bars[k].v : 0; n60++; }
  const vol = n60 && v60 > 0 ? clamp(v3 / 3 / (v60 / n60) - 1, -1, 3) / 2 : 0;
  let ext = c;
  for (let k = i; k >= 0 && bars[k].t >= roundStart; k--) ext = lead > 0 ? Math.max(ext, bars[k].h) : Math.min(ext, bars[k].l);
  const pull = clamp(((ext - c) * lead) / sd, 0, 4) / 2;
  return [mom, run, rs, wick, cflow, close, vol, pull];
}

// The bot's math for the leader losing: the chance a fair walk ends back past the target
export const mathFlip = (price, target, sigma, minutes) => normCdf(-Math.abs(Math.log(price / target)) / (sigma * Math.sqrt(Math.max(minutes, 1e-6))));

// Every past round x checkpoint in the candles: { round, m, base, x, y (1 = the leader lost) }
export function chartSamples(bars) {
  const at = new Map(bars.map((b, i) => [b.t, i])), vol = volSeries(bars), rsi = rsiSeries(bars.map((b) => b.c), 14), out = [];
  if (bars.length < 120) return out;
  for (let rs = Math.ceil(bars[0].t / ROUND) * ROUND; rs + ROUND <= bars.at(-1).t + MIN; rs += ROUND) {
    const first = at.get(rs), last = at.get(rs + ROUND - MIN);
    if (first == null || last == null || last - first !== 14) continue;
    const target = bars[first].o, close = bars[last].c;
    if (close === target) continue;
    for (const m of FLIP.checkpoints) {
      const i = first + 14 - m, c = bars[i].c, s = vol[i];
      if (s == null || c === target) continue;
      const lead = c > target ? 1 : -1;
      out.push({ round: rs, m, base: mathFlip(c, target, s, m), x: chartFeatures(bars, i, { lead, sigma: s, roundStart: rs, rsi: rsi[i] }), y: (close > target ? 1 : -1) === lead ? 0 : 1 });
    }
  }
  return out;
}
// The tape's graded samples (the Round scan's, scanfeed.js) as flip samples: the leader by the bot's odds, the reads
// turned to point against it
export function flowSamples(scan) {
  return (scan || []).filter((s) => (s.y === 0 || s.y === 1) && s.pModel != null && s.pModel !== 0.5 && Array.isArray(s.x)).map((s) => {
    const lead = s.pModel > 0.5 ? 1 : -1;
    return { round: s.closeTime, m: s.cp, base: Math.min(s.pModel, 1 - s.pModel), x: s.x.map((v) => -(v || 0) * lead), y: (s.y === 1 ? 1 : -1) === lead ? 0 : 1 };
  }).sort((a, b) => a.round - b.round);
}

// Logistic regression with the bot's flip chance as a fixed offset (Newton's method, an L2 penalty toward 0)
export function fitFlip(ss, l2 = FLIP.l2) {
  const k = ss[0]?.x.length ?? 0, w = new Array(k).fill(0);
  if (!ss.length) return w;
  for (let it = 0; it < 15; it++) {
    const g = w.map((v) => l2 * v), H = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => (a === b ? l2 : 0)));
    for (const s of ss) {
      const p = sigm(logit(s.base) + w.reduce((a, v, j) => a + v * s.x[j], 0)), r = p - s.y, q = p * (1 - p);
      for (let a = 0; a < k; a++) { g[a] += r * s.x[a]; for (let b = 0; b < k; b++) H[a][b] += q * s.x[a] * s.x[b]; }
    }
    const step = solve(H, g);
    if (!step) break;
    let moved = 0;
    for (let a = 0; a < k; a++) { w[a] -= step[a]; moved += Math.abs(step[a]); }
    if (moved < 1e-7) break;
  }
  return w.map((v) => clamp(v, -4, 4));
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
export const flipProb = (w, base, x) => sigm(logit(base) + w.reduce((a, v, j) => a + v * (x[j] || 0), 0));

// Fit on the older 2/3 (by round), score the newer 1/3 against the bot's math: log loss per round, paired; then the
// weights used live are refitted on everything. { n, nTest, lossBase, lossModel, gain, z, proven, w, flipRate, mathRate }
export function evaluate(ss, minTest) {
  const rounds = [...new Set(ss.map((s) => s.round))].sort((a, b) => a - b), cut = rounds[Math.floor(rounds.length * FLIP.train)] ?? Infinity;
  const train = ss.filter((s) => s.round < cut), test = ss.filter((s) => s.round >= cut);
  const out = { n: ss.length, nTest: test.length, lossBase: null, lossModel: null, gain: null, z: 0, proven: false, w: null,
    flipRate: ss.length ? ss.filter((s) => s.y).length / ss.length : null, mathRate: ss.length ? ss.reduce((a, s) => a + s.base, 0) / ss.length : null };
  if (train.length < 100 || test.length < 30) return out;
  const wt = fitFlip(train), ll = (p, y) => -(y ? Math.log(clamp(p, 1e-6, 1)) : Math.log(clamp(1 - p, 1e-6, 1)));
  const byRound = new Map();
  let lb = 0, lm = 0;
  for (const s of test) {
    const a = ll(s.base, s.y), b = ll(flipProb(wt, s.base, s.x), s.y);
    lb += a; lm += b; byRound.set(s.round, (byRound.get(s.round) || 0) + (a - b));
  }
  const d = [...byRound.values()], mean = d.reduce((a, v) => a + v, 0) / d.length, sd = Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, d.length - 1));
  out.lossBase = lb / test.length; out.lossModel = lm / test.length; out.gain = lb > 0 ? (lb - lm) / lb : 0;
  out.z = sd > 0 ? (mean / sd) * Math.sqrt(d.length) : 0;
  out.proven = test.length >= minTest && out.z >= FLIP.z && out.gain > 0;
  out.w = fitFlip(ss);
  return out;
}

// The flip check for a live leader: the bot's flip chance, then the proven parts on top. parts: each read's push (in
// log-odds) with its name, biggest first
export function flipCheck({ pLead, chart = null, chartX = null, flow = null, flowX = null }) {
  if (pLead == null) return null;
  const base = 1 - pLead;
  let z = logit(base);
  const parts = [];
  const add = (model, x, names, keys, kind) => {
    if (!model?.proven || !model.w || !x) return;
    model.w.forEach((w, j) => { const v = w * (x[j] || 0); z += v; if (Math.abs(v) > 0.02) parts.push({ kind, key: keys[j], name: names[keys[j]] ?? keys[j], push: v }); });
  };
  add(chart, chartX, CHART_NAMES, CHART_FEATURES, 'chart'); add(flow, flowX, SCAN_NAMES, SCAN_FEATURES, 'flow');
  parts.sort((a, b) => Math.abs(b.push) - Math.abs(a.push));
  return { base, p: sigm(z), parts, used: !!(chart?.proven || flow?.proven) };
}
