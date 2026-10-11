// Market structure, the way experienced BTC traders read a chart (from "The BTC Trader's Playbook"), turned into numbers
// the bot can test. Pure; works on 1-minute candles { t, o, h, l, c, v } oldest first.
//   swings        swing highs/lows (a candle higher/lower than the 3 on each side)
//   sweep         price took out a key level (yesterday's or the last hour's high/low, or a recent swing) and closed
//                 back inside: a failed breakout or breakdown, the stop hunt reversing (bullish below, bearish above)
//   shift         a market structure shift: a close through the last swing high in a down-leg (bullish), or the last
//                 swing low in an up-leg (bearish)
//   fvg           fair value gaps: a 3-candle imbalance (candle 3's low above candle 1's high, or the reverse) that price
//                 hasn't filled yet; price often comes back to fill them
//   orderBlock    the last opposite candle before a strong move (2x+ the average body): a possible demand/supply zone
//   volDiv        volume divergence: a new 30-minute high (low) on clearly weaker volume than the last one
//   vwap          how far price is from the day's volume-weighted average (UTC day), in typical moves
// None of these is trusted on faith: they become inputs the micro model learns from (public/micro.js), and the
// playbook's 15-minute sweep strategy is backtested and paper-traded (public/playbook.js).
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DAY = 86400000, HOUR = 3600000;

export function swings(bars, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < bars.length - k; i++) {
    const b = bars[i], around = [...bars.slice(i - k, i), ...bars.slice(i + 1, i + k + 1)];
    if (around.every((x) => x.h < b.h)) hi.push({ i, t: b.t, p: b.h });
    if (around.every((x) => x.l > b.l)) lo.push({ i, t: b.t, p: b.l });
  }
  return { hi, lo };
}
// The key levels traders watch: yesterday's (UTC) and the last full hour's high/low, and the latest swing high/low
export function keyLevels(bars, now) {
  const today = Math.floor(now / DAY) * DAY, hourStart = Math.floor(now / HOUR) * HOUR;
  const range = (from, to) => { const xs = bars.filter((b) => b.t >= from && b.t < to); return xs.length ? { h: Math.max(...xs.map((b) => b.h)), l: Math.min(...xs.map((b) => b.l)), n: xs.length } : null; };
  const out = [];
  const pd = range(today - DAY, today), ph = range(hourStart - HOUR, hourStart);
  if (pd?.n >= 600) out.push({ name: "yesterday's high", p: pd.h, side: 'high' }, { name: "yesterday's low", p: pd.l, side: 'low' });
  if (ph?.n >= 45) out.push({ name: "the last hour's high", p: ph.h, side: 'high' }, { name: "the last hour's low", p: ph.l, side: 'low' });
  const sw = swings(bars.slice(-90, -5));
  const sh = sw.hi.at(-1), sl = sw.lo.at(-1);
  if (sh) out.push({ name: 'the last swing high', p: sh.p, side: 'high' });
  if (sl) out.push({ name: 'the last swing low', p: sl.p, side: 'low' });
  return out;
}
// A sweep in the last `within` minutes: a candle wicked through a level and closed back on the near side
export function findSweep(bars, now, within = 5) {
  const levels = keyLevels(bars.slice(0, -within), now), recent = bars.slice(-within);
  let best = null;
  for (const L of levels) for (const b of recent) {
    if (L.side === 'low' && b.l < L.p && b.c > L.p) best = !best || b.t > best.t ? { dir: 1, t: b.t, level: L.name, p: L.p, extreme: b.l } : best;
    if (L.side === 'high' && b.h > L.p && b.c < L.p) best = !best || b.t > best.t ? { dir: -1, t: b.t, level: L.name, p: L.p, extreme: b.h } : best;
  }
  return best;
}
// A market structure shift in the last `within` minutes
export function findShift(bars, within = 5) {
  const sw = swings(bars.slice(0, -within));
  const sh = sw.hi.at(-1), sl = sw.lo.at(-1), recent = bars.slice(-within);
  if (!sh || !sl) return null;
  const downLeg = sh.t < sl.t, upLeg = sl.t < sh.t; // the latest swing low came after the high: falling
  for (const b of recent) {
    if (downLeg && b.c > sh.p) return { dir: 1, t: b.t, p: sh.p, text: `closed above the last swing high ($${sh.p.toFixed(0)}) after a down-leg` };
    if (upLeg && b.c < sl.p) return { dir: -1, t: b.t, p: sl.p, text: `closed below the last swing low ($${sl.p.toFixed(0)}) after an up-leg` };
  }
  return null;
}
// Unfilled fair value gaps in the last `look` minutes: { dir: 1 (bullish gap, below a rise) | -1, lo, hi, t }
export function fairValueGaps(bars, look = 120) {
  const xs = bars.slice(-look), out = [];
  for (let i = 2; i < xs.length; i++) {
    const a = xs[i - 2], c = xs[i];
    let g = null;
    if (c.l > a.h) g = { dir: 1, lo: a.h, hi: c.l, t: xs[i - 1].t };
    if (c.h < a.l) g = { dir: -1, lo: c.h, hi: a.l, t: xs[i - 1].t };
    if (!g) continue;
    const later = xs.slice(i + 1);
    const filled = g.dir === 1 ? later.some((b) => b.l <= g.lo) : later.some((b) => b.h >= g.hi);
    if (!filled) out.push(g);
  }
  return out;
}
// Order blocks: the last opposite candle before a displacement (body 2x+ the 30-minute average body)
export function orderBlocks(bars, look = 120) {
  const xs = bars.slice(-look), out = [];
  for (let i = 31; i < xs.length; i++) {
    const body = Math.abs(xs[i].c - xs[i].o), typical = avg(xs.slice(i - 30, i).map((b) => Math.abs(b.c - b.o)));
    if (!(typical > 0) || body < 2 * typical) continue;
    const up = xs[i].c > xs[i].o;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const b = xs[j];
      if (up ? b.c < b.o : b.c > b.o) { out.push({ dir: up ? 1 : -1, lo: Math.min(b.o, b.c, b.l), hi: Math.max(b.o, b.c, b.h), t: b.t }); break; }
    }
  }
  return out.slice(-6);
}
// Volume divergence: a new 30-minute high (low) in the last 3 minutes on less than 70% of the volume at the last one
export function volumeDivergence(bars) {
  const xs = bars.slice(-33), last = xs.slice(-3), prior = xs.slice(0, -3);
  if (prior.length < 20 || !last.length) return 0;
  const hiPrior = prior.reduce((a, b) => (b.h > a.h ? b : a)), loPrior = prior.reduce((a, b) => (b.l < a.l ? b : a));
  const top = last.reduce((a, b) => (b.h > a.h ? b : a)), bot = last.reduce((a, b) => (b.l < a.l ? b : a));
  if (top.h > hiPrior.h && hiPrior.v > 0 && top.v < 0.7 * hiPrior.v) return -1; // a weak new high: bearish
  if (bot.l < loPrior.l && loPrior.v > 0 && bot.v < 0.7 * loPrior.v) return 1;  // a weak new low: bullish
  return 0;
}
export function dayVwap(bars, now) {
  const xs = bars.filter((b) => b.t >= Math.floor(now / DAY) * DAY && b.v > 0);
  const vol = xs.reduce((a, b) => a + b.v, 0);
  return vol > 0 ? xs.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0) / vol : null;
}

// Everything above at this moment, plus the numbers for the micro model (each around 0, + pointing up)
export function structureRead(bars, { now = Date.now(), price = null, sigmaMin = 0.0008 } = {}) {
  const done = (bars || []).filter((b) => b.t + 60000 <= now);
  const out = { sweep: null, shift: null, fvg: [], blocks: [], volDiv: 0, vwap: null, features: { sweep: 0, shift: 0, fvgPull: 0, obZone: 0, volDiv: 0, vwapDev: 0 } };
  if (done.length < 60) return out;
  const p = price ?? done.at(-1).c, sd = p * sigmaMin;
  out.sweep = findSweep(done, now); out.shift = findShift(done); out.fvg = fairValueGaps(done); out.blocks = orderBlocks(done);
  out.volDiv = volumeDivergence(done); out.vwap = dayVwap(done, now);
  const fresh = (e) => (e ? clamp(1 - (now - e.t) / 300000, 0, 1) * e.dir : 0); // fades over 5 minutes
  // the nearest unfilled gap pulls price toward it (closer = stronger)
  const near = out.fvg.map((g) => ({ g, d: (g.lo + g.hi) / 2 - p })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
  const inZone = out.blocks.filter((z) => p >= z.lo - sd * 0.2 && p <= z.hi + sd * 0.2).at(-1);
  out.features = {
    sweep: fresh(out.sweep), shift: fresh(out.shift),
    fvgPull: near ? clamp(Math.sign(near.d) / Math.max(1, Math.abs(near.d) / sd), -1, 1) : 0,
    obZone: inZone ? inZone.dir : 0, volDiv: out.volDiv,
    vwapDev: out.vwap ? clamp((p - out.vwap) / (sd * Math.sqrt(15)), -3, 3) : 0,
  };
  return out;
}
