// Lessons (v13.37): a member's trading notes (MACD, EMA, RSI, ceiling / floor, the double bottom) turned into rules the
// bot can test instead of believe. Each becomes a signal on 1-minute candles { t, o, h, l, c, v } (oldest first) that
// says up (+1), down (-1) or nothing (0), and joins the indicator test (public/tune.js): picked on the first 2/3 of the
// history, tested on the last 1/3 it never saw, used in calls only if proven. Plus two direct checks of the notes' own
// claims, and a live read of each for the Learn tab:
//   MACD           the MACD line crossing its signal line (a fresh cross in the last few minutes); the histogram and the
//                  zero line are already tested (the zero-line cross is the EMA 12/26 cross)
//   EMA            the cross is already tested; new: price bouncing off a rising EMA (support) or a falling one
//                  (resistance)
//   RSI            the 70/30 zones are already tested; new: divergence (a new high on a weaker RSI warns of a reversal)
//   Ceiling/floor  the round's opening range (its first minutes' high and low): a close through it (breakthrough) or a
//                  wick through it that closes back inside (rejection). rangeLadder checks the "60%+ / 70%+ areas": how
//                  often a round finished up from each zone around that range, next to what the bot's math said
//   Double bottom  two similar lows with a high between (the neckline, "res"), then a close above it; mirrored for a
//                  double top. patternStats checks the take-profit (the pattern's height above the neckline) against the
//                  stop loss (just under the neckline), as drawn
import { ema, macd, rsiSeries } from './indicators.js';
import { normCdf } from './model.js';

export const LESSON = { rangeMinutes: 3, checkpoints: [10, 6, 3], patternLook: 60, patternHold: 60, slShare: 0.3 };
const ROUND = 900000, MIN = 60000;
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// MACD line vs its signal line: the side of a cross that happened in the last k minutes, else 0
export function macdCross(closes, k = 3, fast = 12, slow = 26, sig = 9) {
  const m = macd(closes, fast, slow, sig), out = new Array(closes.length).fill(null);
  let last = -Infinity;
  for (let i = 1; i < closes.length; i++) {
    const a = m[i - 1].hist, b = m[i].hist;
    if (b == null) continue;
    if (a != null && sgn(a) !== sgn(b) && sgn(b) !== 0) last = i;
    out[i] = i - last <= k ? sgn(b) : 0;
  }
  return out;
}

// Divergence: a close above the highest close of the last `look` minutes (not counting the last 3) on a weaker
// indicator than at that high warns down (-1); a new low on a stronger indicator warns up (+1)
export function divergence(closes, ind, look = 30, gap = 2) {
  const out = new Array(closes.length).fill(null);
  for (let i = look; i < closes.length; i++) {
    if (ind[i] == null) continue;
    let jh = -1, jl = -1;
    for (let j = i - look; j <= i - 3; j++) {
      if (ind[j] == null) continue;
      if (jh < 0 || closes[j] > closes[jh]) jh = j;
      if (jl < 0 || closes[j] < closes[jl]) jl = j;
    }
    out[i] = jh >= 0 && closes[i] > closes[jh] && ind[i] < ind[jh] - gap ? -1 : jl >= 0 && closes[i] < closes[jl] && ind[i] > ind[jl] + gap ? 1 : 0;
  }
  return out;
}

// Price touching an EMA and holding it: support on a rising EMA (+1), resistance on a falling one (-1), for `keep` minutes
export function emaBounce(bars, n = 21, keep = 3) {
  const e = ema(bars.map((b) => b.c), n), out = new Array(bars.length).fill(null);
  let last = -Infinity, side = 0;
  for (let i = 3; i < bars.length; i++) {
    if (e[i] == null || e[i - 3] == null) continue;
    const b = bars[i], up = e[i] > e[i - 3], down = e[i] < e[i - 3];
    if (up && b.l <= e[i] && b.c > e[i]) { last = i; side = 1; } else if (down && b.h >= e[i] && b.c < e[i]) { last = i; side = -1; }
    out[i] = i - last < keep ? side : 0;
  }
  return out;
}

// The round's opening range: the high (ceiling) and low (floor) of its first k minutes, at each minute after them
export function openingRange(bars, k = LESSON.rangeMinutes) {
  const out = new Array(bars.length).fill(null);
  let start = null, hi = -Infinity, lo = Infinity, open = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], rs = Math.floor(b.t / ROUND) * ROUND;
    if (rs !== start) { start = rs; hi = -Infinity; lo = Infinity; open = b.t === rs ? b.o : null; }
    if (b.t < rs + k * MIN) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); continue; }
    if (hi > lo && open != null) out[i] = { ceil: hi, floor: lo, open, start: rs };
  }
  return out;
}
// Breakthrough: closing above the ceiling (+1) or below the floor (-1). Rejection: a wick through it in the last 3
// minutes that closed back inside: rejected at the ceiling (-1) or the floor (+1)
export function rangeSignal(bars, k = LESSON.rangeMinutes, mode = 'break') {
  const r = openingRange(bars, k);
  return bars.map((b, i) => {
    const x = r[i];
    if (!x) return null;
    if (mode === 'break') return b.c > x.ceil ? 1 : b.c < x.floor ? -1 : 0;
    for (let j = i; j > i - 3 && j >= 0 && r[j]?.start === x.start; j--) {
      if (bars[j].h > x.ceil && bars[j].c <= x.ceil) return -1;
      if (bars[j].l < x.floor && bars[j].c >= x.floor) return 1;
    }
    return 0;
  });
}

// Swing lows/highs (lower/higher than the k candles on each side), each known only k minutes later: no peeking
function swingPoints(bars, k = 2) {
  const lows = [], highs = [];
  for (let i = k; i < bars.length - k; i++) {
    let lo = true, hi = true;
    // strictly past the candles before, at least level with the ones after (equal lows on two candles count once)
    for (let j = i - k; j <= i + k; j++) if (j !== i) { if (j < i ? bars[j].l <= bars[i].l : bars[j].l < bars[i].l) lo = false; if (j < i ? bars[j].h >= bars[i].h : bars[j].h > bars[i].h) hi = false; }
    if (lo) lows.push({ i, p: bars[i].l, known: i + k });
    if (hi) highs.push({ i, p: bars[i].h, known: i + k });
  }
  return { lows, highs };
}
// Double bottoms (W) and tops (M) as they complete: two swing lows within `look` minutes, within 30% of the pattern's
// height of each other, the neckline the highest high between them; the break is the first close above it.
// Returns every break: { i, type: 'W' | 'M', neckline, extreme, height }
export function doublePatterns(bars, look = LESSON.patternLook) {
  const { lows, highs } = swingPoints(bars), out = [];
  const scan = (pts, type) => {
    const seen = new Set(); // one break per minute, whichever pair of lows made it
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length && pts[b].i - pts[a].i <= look; b++) {
        const p1 = pts[a], p2 = pts[b];
        if (p2.i - p1.i < 4) continue;
        let neck = type === 'W' ? -Infinity : Infinity;
        for (let j = p1.i + 1; j < p2.i; j++) neck = type === 'W' ? Math.max(neck, bars[j].h) : Math.min(neck, bars[j].l);
        const ext = type === 'W' ? Math.min(p1.p, p2.p) : Math.max(p1.p, p2.p), height = Math.abs(neck - ext);
        if (!(height > 0) || Math.abs(p1.p - p2.p) > 0.3 * height) continue;
        // it must not have broken already between the lows, and the second low must hold until the break
        for (let i = p2.known; i < bars.length && i - p2.i <= look; i++) {
          const c = bars[i].c;
          if (type === 'W' ? bars[i].l < ext : bars[i].h > ext) break;
          if (type === 'W' ? c > neck : c < neck) { if (!seen.has(i)) { out.push({ i, type, neckline: neck, extreme: ext, height }); seen.add(i); } break; }
        }
      }
    }
  };
  scan(lows, 'W'); scan(highs, 'M');
  return out.sort((x, y) => x.i - y.i);
}
// As a signal: +1 for 5 minutes after a double bottom breaks its neckline, -1 after a double top
export function patternSignal(bars, look = LESSON.patternLook, keep = 5) {
  const out = bars.map(() => 0);
  for (const p of doublePatterns(bars, look)) for (let i = p.i; i < Math.min(bars.length, p.i + keep); i++) out[i] = p.type === 'W' ? 1 : -1;
  return out;
}

// The new candidates for the indicator test (public/tune.js), by family
const cl = (bars) => bars.map((b) => b.c);
export const LESSON_CANDIDATES = [
  ...[[3, 12, 26, 9], [5, 12, 26, 9], [3, 8, 17, 9]].map(([k, a, b, s]) => ({ id: `macdx${k}_${a}_${b}`, family: 'macdx', name: `MACD ${a}/${b}/${s} line crossing its signal (last ${k} min)`, need: b + s, fromBars: (bars) => macdCross(cl(bars), k, a, b, s) })),
  ...[20, 30, 60].map((L) => ({ id: `divrsi${L}`, family: 'div', name: `RSI 14 divergence (${L}-minute high/low)`, need: L + 15, fromBars: (bars) => { const c = cl(bars); return divergence(c, rsiSeries(c, 14), L, 2); } })),
  { id: 'divmacd30', family: 'div', name: 'MACD divergence (30-minute high/low)', need: 60, fromBars: (bars) => { const c = cl(bars); return divergence(c, macd(c).map((m) => m.macd), 30, 0); } },
  ...[9, 21, 50].map((n) => ({ id: `emab${n}`, family: 'emasr', name: `Bounce off the EMA ${n} (support / resistance)`, need: n + 3, fromBars: (bars) => emaBounce(bars, n) })),
  ...[2, 3, 5].flatMap((k) => [['break', 'breakthrough'], ['reject', 'rejection']].map(([mode, word]) => ({ id: `range${k}${mode}`, family: 'range', name: `Opening ${k}-minute ceiling / floor ${word}`, need: 1, fromBars: (bars) => rangeSignal(bars, k, mode) }))),
  ...[30, 60].map((L) => ({ id: `wm${L}`, family: 'pattern', name: `Double bottom / top neckline break (${L} min)`, need: L, fromBars: (bars) => patternSignal(bars, L) })),
];
export const LESSON_FAMILIES = { macdx: 'MACD signal cross', div: 'Divergence', emasr: 'EMA support / resistance', range: 'Ceiling / floor', pattern: 'Double bottom / top' };

// 1-minute volatility over the last hour at each bar (the bot's typical move)
function vol60(bars) {
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

// The notes' "areas": at 10, 6 and 3 minutes left, where price sits against the opening range, and how often the round
// then finished on that side of its open (Kalshi's target is the price at the open), next to the bot's own math for
// the same moments. Zones: far above (more than one range-height over the ceiling), above, inside, below, far below.
export const ZONES = ['far above', 'above', 'inside', 'below', 'far below'];
export function rangeLadder(bars, k = LESSON.rangeMinutes) {
  const at = new Map(bars.map((b, i) => [b.t, i])), vol = vol60(bars), acc = Object.fromEntries(ZONES.map((z) => [z, { n: 0, hit: 0, math: 0 }]));
  let rounds = 0;
  for (let rs = Math.ceil(bars[0]?.t / ROUND) * ROUND; bars.length && rs + ROUND <= bars.at(-1).t + MIN; rs += ROUND) {
    const first = at.get(rs), last = at.get(rs + ROUND - MIN);
    if (first == null || last == null || last - first !== 14) continue; // a complete round only
    const open = bars[first].o, close = bars[last].c;
    let hi = -Infinity, lo = Infinity;
    for (let j = first; j < first + k; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    const w = hi - lo;
    if (!(w > 0) || close === open) continue;
    rounds++;
    for (const m of LESSON.checkpoints) {
      const i = first + 14 - m, p = bars[i].c, s = vol[i];
      if (s == null) continue;
      const zone = p > hi + w ? 'far above' : p > hi ? 'above' : p < lo - w ? 'far below' : p < lo ? 'below' : 'inside';
      const up = close > open, pUp = normCdf(Math.log(p / open) / (s * Math.sqrt(m)));
      const side = zone.includes('below') ? 'down' : 'up', a = acc[zone];
      a.n++; a.hit += (side === 'up' ? up : !up) ? 1 : 0; a.math += side === 'up' ? pUp : 1 - pUp;
    }
  }
  return { rounds, k, zones: ZONES.map((z) => ({ zone: z, side: z.includes('below') ? 'down' : 'up', n: acc[z].n, hit: acc[z].n ? acc[z].hit / acc[z].n : null, math: acc[z].n ? acc[z].math / acc[z].n : null })) };
}

// The double bottom / top as drawn: buy the neckline break, take profit one pattern-height past the neckline, stop
// loss 30% of the height back through it, an hour at most. Win rate next to the win rate the payoff needs.
export function patternStats(bars, look = LESSON.patternLook) {
  const by = { W: [], M: [] };
  for (const p of doublePatterns(bars, look)) {
    const dir = p.type === 'W' ? 1 : -1, entry = bars[p.i].c, tp = p.neckline + dir * p.height, sl = p.neckline - dir * LESSON.slShare * p.height;
    const risk = (entry - sl) * dir, reward = (tp - entry) * dir;
    if (!(risk > 0) || !(reward > 0)) continue;
    let r = null;
    for (let j = p.i + 1; j < bars.length && j <= p.i + LESSON.patternHold; j++) {
      const b = bars[j];
      if (dir > 0 ? b.l <= sl : b.h >= sl) { r = -1; break; } // the stop first if both hit in one minute
      if (dir > 0 ? b.h >= tp : b.l <= tp) { r = reward / risk; break; }
    }
    if (r == null) { const j = Math.min(bars.length - 1, p.i + LESSON.patternHold); if (j === p.i) continue; r = ((bars[j].c - entry) * dir) / risk; }
    by[p.type].push({ r, win: r > 0, need: risk / (risk + reward) });
  }
  const sum = (xs) => ({ n: xs.length, win: xs.length ? xs.filter((x) => x.win).length / xs.length : null, avgR: xs.length ? xs.reduce((a, x) => a + x.r, 0) / xs.length : null, need: xs.length ? xs.reduce((a, x) => a + x.need, 0) / xs.length : null });
  return { W: sum(by.W), M: sum(by.M), all: sum([...by.W, ...by.M]) };
}

// What each lesson says right now, from the latest closed 1-minute candles (the newest, still forming, is left out)
export function lessonsNow(candles, now = Date.now()) {
  const bars = candles.filter((b) => b.t + MIN <= now);
  if (bars.length < 60) return null;
  const c = cl(bars), i = bars.length - 1, m = macd(c), e9 = ema(c, 9), e21 = ema(c, 21), rsi = rsiSeries(c, 14);
  let crossAgo = null;
  for (let j = i; j > 0; j--) if (m[j].hist != null && m[j - 1].hist != null && sgn(m[j].hist) !== sgn(m[j - 1].hist)) { crossAgo = i - j; break; }
  const range = openingRange(bars)[i], rs = Math.floor(now / ROUND) * ROUND;
  const live = range && range.start === rs ? range : null, p = c[i];
  const w = live ? live.ceil - live.floor : 0;
  const pat = doublePatterns(bars.slice(-120)).filter((x) => x.i >= Math.min(bars.length, 120) - 10).at(-1) || null;
  return {
    price: p,
    macd: { line: m[i].macd, signal: m[i].signal, hist: m[i].hist, side: sgn(m[i].hist), zero: sgn(m[i].macd), crossAgo, growing: m[i].hist != null && m[i - 1].hist != null && Math.abs(m[i].hist) > Math.abs(m[i - 1].hist) },
    ema: { e9: e9[i], e21: e21[i], trend: sgn(e9[i] - e21[i]), bounce: emaBounce(bars, 21).at(-1) },
    rsi: { v: rsi[i], zone: rsi[i] > 70 ? 'overbought' : rsi[i] < 30 ? 'oversold' : 'neutral', divergence: divergence(c, rsi, 30, 2).at(-1) },
    range: live ? { ...live, zone: p > live.ceil + w ? 'far above' : p > live.ceil ? 'above' : p < live.floor - w ? 'far below' : p < live.floor ? 'below' : 'inside', rejected: rangeSignal(bars, LESSON.rangeMinutes, 'reject').at(-1) } : null,
    pattern: pat ? { type: pat.type, neckline: pat.neckline, tp: pat.neckline + (pat.type === 'W' ? 1 : -1) * pat.height, sl: pat.neckline - (pat.type === 'W' ? 1 : -1) * LESSON.slShare * pat.height, ago: Math.min(bars.length, 120) - 1 - pat.i } : null,
  };
}
