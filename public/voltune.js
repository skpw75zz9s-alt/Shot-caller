// The volatility tuner (v13.3): which volatility settings have actually described BTC's moves best, tested walk-forward
// on the server's 1-minute history (playbookfeed.js). Every probability the bot gives comes from its volatility, so this
// is the most direct lever on how accurate its odds are. Pure; voltunefeed.js runs it hourly.
//   The settings  the EWMA decay (how fast recent minutes take over: 0.88-0.98, standard 0.94), the floor under it (a
//                 share of the 2-hour volatility: 0.4-0.8, standard 0.6), an overall scale (0.85-1.2, standard 1) and
//                 fat tails (the volatility's own uncertainty: 0-0.6, standard 0; public/model.js probYes)
//   The question  every 15 minutes, how likely did each setting make the moves that really followed over the next 5,
//                 10 and 15 minutes? The log score (the log of the predicted density at the real move) is a proper
//                 scoring rule: it rewards the setting whose whole distribution, the middle and the tails, matches what
//                 happens, and can't be gamed by being vague or by being bold
//   No fooling    walk-forward by day: each day is scored with the setting that did best on the days before it, against
//                 the standard setting on the same moves. Proven = that out-of-sample gain is positive with z >= 2.5
//                 (the 15-minute starts don't overlap). Only then does the bot use it (refit on all the days)
// The report also shows how often each one's 90% range held on the out-of-sample days.
import { GH9 } from './model.js';

export const VT = { lambdas: [0.88, 0.92, 0.94, 0.96, 0.98], floors: [0.4, 0.6, 0.8], scales: [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2], tails: [0, 0.1, 0.2, 0.3, 0.45, 0.6],
  horizons: [5, 10, 15], step: 15, window: 121, minVol: 0.00008, minTrainDays: 3, minTest: 200, z: 2.5 };
export const VT_BASE = { lambda: 0.94, floor: 0.6, scale: 1, tails: 0 };
const MIN = 60000, DAY = 86400000, LN2PI = Math.log(2 * Math.PI);

export const vtCandidates = () => VT.lambdas.flatMap((lambda) => VT.floors.flatMap((floor) => VT.scales.flatMap((scale) => VT.tails.map((tails) => ({ lambda, floor, scale, tails })))));
const same = (a, b) => a.lambda === b.lambda && a.floor === b.floor && a.scale === b.scale && a.tails === b.tails;

// The same volatility the bot prices with (public/model.js realizedVol + effectiveVol, public/engine.js longVol), from
// the 121 closes up to and including i
function vols(c, i, lambda) {
  const r = [];
  for (let k = i - VT.window + 2; k <= i; k++) if (c[k] > 0 && c[k - 1] > 0) r.push(Math.log(c[k] / c[k - 1]));
  if (r.length < 10) return null;
  let v = r.slice(0, 10).reduce((a, x) => a + x * x, 0) / 10;
  for (const x of r) v = lambda * v + (1 - lambda) * x * x;
  const m = r.reduce((a, x) => a + x, 0) / r.length, long = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / r.length);
  return { ewma: Math.sqrt(v), long };
}
// The predicted density of a log move x over h minutes: a normal with sd sigma sqrt(h), or with fat tails, the mixture
// over the volatility's uncertainty (same average variance)
export function logDensity(x, sigma, h, tails = 0) {
  if (!(tails > 0)) { const s = sigma * Math.sqrt(h); return -0.5 * LN2PI - Math.log(s) - (x * x) / (2 * s * s); }
  let f = 0;
  for (const [z, w] of GH9) { const s = sigma * Math.exp(tails * z - tails * tails) * Math.sqrt(h); f += w * Math.exp(-(x * x) / (2 * s * s)) / s; }
  return Math.log(f) - 0.5 * LN2PI;
}
// The two-sided 90% range's half-width (bisection on the mixture's chance of a move that big)
export function range90(sigma, h, tails = 0) {
  const sd = sigma * Math.sqrt(h), tail = (x) => { let p = 0; for (const [z, w] of tails > 0 ? GH9 : [[0, 1]]) { const s = sd * Math.exp(tails * z - tails * tails); p += w * erfc(x / (s * Math.SQRT2)); } return p; };
  let lo = 0, hi = 20 * sd;
  for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (tail(mid) > 0.1) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function erfc(x) { // complementary error function (Numerical Recipes' Chebyshev fit, ~1e-7 relative)
  const z = Math.abs(x), t = 1 / (1 + z / 2);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// The samples: every 15 minutes with a full window behind and the next 15 minutes complete
export function vtSamples(bars) {
  const c = bars.map((b) => b.c), out = [], H = Math.max(...VT.horizons);
  for (let i = VT.window; i + H < bars.length; i += VT.step) {
    if (bars[i + H].t !== bars[i].t + H * MIN) continue; // a gap: skip
    const v = Object.fromEntries(VT.lambdas.map((l) => [l, vols(c, i, l)]));
    if (!v[VT.lambdas[0]]) continue;
    out.push({ t: bars[i].t, day: Math.floor(bars[i].t / DAY), v, x: VT.horizons.map((h) => Math.log(c[i + h] / c[i])) });
  }
  return out;
}
const sigmaOf = (s, k) => { const v = s.v[k.lambda]; return Math.max(v.ewma, k.floor * v.long, VT.minVol) * k.scale; };
const scoreOf = (s, k) => { const sig = sigmaOf(s, k); return VT.horizons.reduce((a, h, j) => a + logDensity(s.x[j], sig, h, k.tails), 0); };

// The test, a slice at a time, yielding between slices (the server keeps answering while it runs)
export async function tuneVolAsync(bars, pause = () => new Promise((r) => setImmediate(r))) {
  const ss = vtSamples(bars), cands = vtCandidates(), score = [];
  for (let i = 0; i < ss.length; i++) { score.push(cands.map((k) => scoreOf(ss[i], k))); if (i % 50 === 49) await pause(); }
  return vtReport(ss, cands, score);
}
function vtReport(ss, cands, score) { // score: per sample, per setting
  const base = cands.findIndex((k) => same(k, VT_BASE)), days = [...new Set(ss.map((s) => s.day))].sort((a, b) => a - b);
  const daySum = days.map((d) => { const tot = new Array(cands.length).fill(0); ss.forEach((s, i) => { if (s.day === d) for (let k = 0; k < cands.length; k++) tot[k] += score[i][k]; }); return tot; });
  const best = (upTo) => { let b = base, bv = -Infinity; for (let k = 0; k < cands.length; k++) { let v = 0; for (let d = 0; d < upTo; d++) v += daySum[d][k]; if (v > bv) { bv = v; b = k; } } return b; };
  // walk-forward
  const diffs = [], held = { tuned: [0, 0], base: [0, 0] };
  for (let d = VT.minTrainDays; d < days.length; d++) {
    const k = best(d);
    ss.forEach((s, i) => {
      if (s.day !== days[d]) return;
      diffs.push(score[i][k] - score[i][base]);
      for (const [name, kk] of [['tuned', k], ['base', base]]) {
        const sig = sigmaOf(s, cands[kk]);
        VT.horizons.forEach((h, j) => { held[name][1]++; if (Math.abs(s.x[j]) <= range90(sig, h, cands[kk].tails)) held[name][0]++; });
      }
    });
  }
  const n = diffs.length, m = n ? diffs.reduce((a, b) => a + b, 0) / n : 0, sd = n > 1 ? Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  const z = sd > 0 ? (m / sd) * Math.sqrt(n) : 0, final = cands[best(days.length)], proven = n >= VT.minTest && m > 0 && z >= VT.z;
  return {
    samples: ss.length, days: days.length, test: n, gain: m, z, proven,
    pick: final, base: VT_BASE,
    held90: { tuned: held.tuned[1] ? held.tuned[0] / held.tuned[1] : null, base: held.base[1] ? held.base[0] / held.base[1] : null },
  };
}
// What the bot uses: the pick once proven, else nothing (the standard settings)
export const vtLive = (report) => (report?.proven && !same(report.pick, VT_BASE) ? { use: true, ...report.pick, gain: report.gain, z: report.z } : { use: false });
