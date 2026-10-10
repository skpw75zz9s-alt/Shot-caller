// Flip watch: trying to catch the turns (the drop, then the bounce) in the prediction candles.
// 1) The flip score (0-1): how ripe the current move is to turn, from what's on the chart and the tape:
//      stretched   the last 5 minutes moved much more than BTC's usual 5 minutes (exhausted moves snap back)
//      RSI         1-minute RSI past 75 or under 25
//      level       pinned at the round's floor after a fall (or its ceiling after a rise)
//      wick        the last closed candle has a long wick against the move (rejection)
//      flow        the live trades lean against the move (someone absorbing it)
// 2) The shape: the prediction candles carry today's momentum, then bend like a damped spring around the blended
//    prediction, plus the retracement a ripe flip wins back (score x 40% of the last 5 minutes' move). A high score
//    turns sooner and swings back past the blend (a flip); a low one just lets the move fade.
//    Turning points on that path are marked on the chart (↺).
// 3) The record: every predicted turn is checked afterwards: did price make a V (or an upside-down V) there? Its hit
//    rate is shown next to how often a random minute looks like a turn, and the shape's strength (amp) follows the
//    record, so it fades away if it isn't catching turns. Pure functions; app.js and tvchart.js use them.
import { rsi } from './candles.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// bars: 1-minute candles oldest first (the last one may be the live minute). Returns null when there's too little data.
export function flipForecast({ bars, spot, sigmaMin, now, openTime = null, flowBuyShare = null, amp = 1 }) {
  const done = (bars || []).filter((b) => b.t + 60000 <= now);
  if (done.length < 20 || !(spot > 0) || !(sigmaMin > 0)) return null;
  const px = spot, sd1 = px * sigmaMin; // dollars per typical minute
  const c3 = done[done.length - 3]?.c, c5 = done[done.length - 5]?.c;
  const v0 = (px - c3) / 3; // momentum, $ per minute over the last ~3 minutes
  const move5 = px - c5, z = move5 / (sd1 * Math.sqrt(5));
  const dir = v0 >= 0 ? 'down' : 'up'; // the way a flip would go
  const sgn = v0 >= 0 ? 1 : -1;
  const parts = [];
  const add = (name, pts, why) => { if (pts > 0.01) parts.push({ name, pts, why }); };
  add('Stretched', clamp((Math.abs(z) - 1) / 1.5, 0, 1) * 0.35, `${z >= 0 ? '+' : '−'}$${Math.abs(move5).toFixed(0)} in 5 min, ${Math.abs(z).toFixed(1)}× a normal 5 minutes`);
  const r = rsi(done.map((b) => b.c).concat(px), 14)?.value ?? null;
  if (r != null) add('RSI', (sgn > 0 ? clamp((r - 70) / 15, 0, 1) : clamp((30 - r) / 15, 0, 1)) * 0.2, `RSI ${Math.round(r)} (${sgn > 0 ? 'overbought' : 'oversold'})`);
  if (openTime) {
    const round = done.filter((b) => b.t >= openTime);
    if (round.length >= 2) {
      const lo = Math.min(...round.map((b) => b.l), px), hi = Math.max(...round.map((b) => b.h), px);
      if (sgn < 0 && px - lo <= 1.2 * sd1) add('Level', 0.2, `at the round's floor ($${lo.toFixed(0)})`);
      if (sgn > 0 && hi - px <= 1.2 * sd1) add('Level', 0.2, `at the round's ceiling ($${hi.toFixed(0)})`);
    }
  }
  const lb = done[done.length - 1], range = lb.h - lb.l;
  if (range > 0) {
    const wick = sgn < 0 ? Math.min(lb.o, lb.c) - lb.l : lb.h - Math.max(lb.o, lb.c); // the wick against the move
    add('Wick', clamp((wick / range - 0.4) / 0.4, 0, 1) * 0.15, `last candle's ${sgn < 0 ? 'lower' : 'upper'} wick is ${Math.round(wick / range * 100)}% of it (rejected)`);
  }
  if (flowBuyShare != null) add('Flow', clamp(((sgn < 0 ? flowBuyShare : 1 - flowBuyShare) - 0.55) / 0.2, 0, 1) * 0.1, `${Math.round((sgn < 0 ? flowBuyShare : 1 - flowBuyShare) * 100)}% of the last minute's trades ${sgn < 0 ? 'bought' : 'sold'} into the ${sgn < 0 ? 'drop' : 'rise'}`);
  const score = clamp(parts.reduce((a, p) => a + p.pts, 0), 0, 1);
  // the spring: quicker and bouncier the riper the move. omega in radians per minute.
  const omega = 0.35 + 0.9 * score, zeta = clamp(1.15 - 0.95 * score, 0.3, 1.15);
  // the retracement a ripe flip wins back: score x 40% of the last 5 minutes' move, peaking sooner the riper it is
  const bounce = -sgn * score * 0.4 * Math.abs(move5), peak = 4 - 2 * score;
  return { v0, score, dir, z, rsi: r, parts, omega, zeta, bounce, peak, amp: clamp(amp, 0, 1.3), sd1 };
}

// The offset (dollars) from the blended prediction t minutes from now
// (the spring carrying today's momentum, plus the retracement: rises to `bounce` at `peak` minutes, then fades)
export function flipOffset(f, t) {
  if (!f || !(t > 0)) return 0;
  const { v0, omega: w, zeta: z, amp, bounce = 0, peak = 3 } = f, a = z * w;
  const spring = z < 1 ? (v0 / (w * Math.sqrt(1 - z * z))) * Math.exp(-a * t) * Math.sin(w * Math.sqrt(1 - z * z) * t) : v0 * t * Math.exp(-w * t);
  return amp * (spring + bounce * (t / peak) * Math.exp(1 - t / peak));
}

// Turning points on a path of candles' expected closes: [{ t, dir: 'up' | 'down', v }] where the path bottoms (or tops)
// out, by at least minMove against the highest (lowest) point up to 3 steps either side
export function turnPoints(points, minMove = 0) {
  const out = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1].v, b = points[i].v, c = points[i + 1].v;
    const left = points.slice(Math.max(0, i - 3), i).map((p) => p.v), right = points.slice(i + 1, i + 4).map((p) => p.v);
    if (b < a && b <= c && Math.max(...left) - b >= minMove && Math.max(...right) - b >= minMove) out.push({ t: points[i].t, dir: 'up', v: b });
    if (b > a && b >= c && b - Math.min(...left) >= minMove && b - Math.min(...right) >= minMove) out.push({ t: points[i].t, dir: 'down', v: b });
  }
  return out;
}
// Did a real turn happen at minute t? A V: the low within a minute of t sits at least `need` under the closes two
// minutes either side (an upside-down V for a 'down' flip). null until those bars exist.
export function turnHappened(bars, t, dir, need) {
  const at = (ms) => bars.find((b) => b.t === ms);
  const before = at(t - 120000), after = at(t + 120000), near = [at(t - 60000), at(t), at(t + 60000)].filter(Boolean);
  if (!before || !after || near.length < 3) return null;
  if (dir === 'up') { const lo = Math.min(...near.map((b) => b.l)); return before.c - lo >= need && after.c - lo >= need; }
  const hi = Math.max(...near.map((b) => b.h)); return hi - before.c >= need && hi - after.c >= need;
}
// How often a random minute passes the same test (the base rate a flip call has to beat), over the bars given
export function turnBaseRate(bars, need) {
  let n = 0, hit = 0;
  for (let i = 3; i < bars.length - 3; i++) {
    if (bars[i + 2].t - bars[i - 2].t !== 240000) continue;
    for (const dir of ['up', 'down']) { const h = turnHappened(bars, bars[i].t, dir, need); if (h != null) { n++; if (h) hit++; } }
  }
  return n ? hit / n : null;
}
// The flip record: calls graded, caught, and the strength the shape earns from it (1 until 20 graded calls; then the
// hit rate over the base rate, kept between 0.3 and 1.3)
export function flipRecord(log, base) {
  const graded = log.filter((e) => e.hit === true || e.hit === false);
  const hits = graded.filter((e) => e.hit).length, rate = graded.length ? hits / graded.length : null;
  const amp = graded.length >= 20 && base > 0 ? clamp(rate / base, 0.3, 1.3) : 1;
  return { n: graded.length, hits, rate, base, amp };
}
