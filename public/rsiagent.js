// The RSI agent (v13.85): reads RSI 14 on 1-, 5- and 15-minute candles, and tests on the market's saved history
// (playbookfeed.js: up to 21 days of 1-minute bars) whether RSI's extremes predicted Kalshi's 15-minute rounds.
//   read   RSI 14 on each timeframe, its zone (70+ overbought, 30 or under oversold) and a fresh divergence on 1 minute
//          (a new 30-minute high on a weaker RSI, or a new low on a stronger one: lessons.js divergence)
//   test   every past round (:00, :15, :30, :45) that opened with the 1-minute RSI at an extreme: did the round end
//          the way a reversal says (overbought → down, oversold → up)? Scored against the base rate of up rounds, so a
//          trending stretch doesn't pass for an edge: z ≥ 2 over 30+ extreme rounds is "extremes fade", z ≤ −2 is
//          "extremes run" (momentum), anything else is no proven edge.
// Context only, like every agent: it reports and informs, and no call uses it.
import { aggregate, rsiSeries } from './indicators.js';
import { divergence } from './lessons.js';

export const RSI = { n: 14, hi: 70, lo: 30, round: 15, minExtremes: 30, z: 2 };
const zoneOf = (v) => (v == null ? null : v >= RSI.hi ? 'overbought' : v <= RSI.lo ? 'oversold' : 'neutral');

// bars: 1-minute candles { t, o, h, l, c } oldest first
export function rsiRead(allBars) {
  const bars = allBars.slice(-1500); // a day is plenty for RSI 14 on 15 minutes (100 bars), and keeps this cheap every few seconds
  const tf = (min) => {
    const b = min === 1 ? bars : aggregate(bars, min);
    const r = rsiSeries(b.map((x) => x.c), RSI.n), v = r.at(-1);
    return { min, v: v == null ? null : Math.round(v * 10) / 10, zone: zoneOf(v) };
  };
  const tail = bars.slice(-200), c = tail.map((x) => x.c), div = tail.length > 40 ? divergence(c, rsiSeries(c, RSI.n), 30, 2).slice(-3).find((x) => x) ?? 0 : 0;
  return { tfs: [tf(1), tf(5), tf(15)], divergence: div === -1 ? 'bearish' : div === 1 ? 'bullish' : null };
}

export function rsiTest(bars) {
  const r = rsiSeries(bars.map((x) => x.c), RSI.n), ms = RSI.round * 60000, byT = new Map(bars.map((b, i) => [b.t, i]));
  let rounds = 0, ups = 0;
  const ex = []; // { dir: -1 (overbought: reversal says down) | 1 (oversold: says up), up }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t % ms !== 0) continue;
    const j = byT.get(bars[i].t + ms - 60000); // the round's last minute
    if (j == null || r[i - 1] == null) continue;
    const up = bars[j].c > bars[i].o;
    rounds++; if (up) ups++;
    if (r[i - 1] >= RSI.hi) ex.push({ dir: -1, up }); else if (r[i - 1] <= RSI.lo) ex.push({ dir: 1, up });
  }
  const pUp = rounds ? ups / rounds : 0.5;
  let hits = 0, need = 0, v = 0;
  for (const e of ex) { const p = e.dir > 0 ? pUp : 1 - pUp; hits += (e.dir > 0) === e.up ? 1 : 0; need += p; v += p * (1 - p); }
  const z = v > 0 ? (hits - need) / Math.sqrt(v) : 0, n = ex.length;
  const verdict = n < RSI.minExtremes ? 'few' : z >= RSI.z ? 'fade' : z <= -RSI.z ? 'run' : 'noise';
  return { rounds, extremes: n, hits, expected: need, z, pUp, verdict, days: bars.length ? (bars.at(-1).t - bars[0].t) / 86400000 : 0 };
}

// the last test, kept per market while its history hasn't grown by a round (the test reads up to 30,000 bars)
const cache = new Map();
export function rsiTestCached(key, bars) {
  const last = bars.at(-1)?.t ?? 0, hit = cache.get(key);
  if (hit && last - hit.last < RSI.round * 60000) return hit.out;
  const out = rsiTest(bars);
  cache.set(key, { last, out });
  return out;
}
