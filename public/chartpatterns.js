// Chart patterns (v13.44): the shapes traders look for, read off the 1-minute candles the way the chart shows them, and
// graded like everything else (public/tune.js: a pattern's signal touches the calls only once it proves itself on
// rounds it never trained on). Nothing here peeks ahead: a swing high or low counts only once `k` candles after it have
// closed, and a pattern counts on the candle that confirms it.
//   head & shoulders     three swing highs, the middle one highest, the shoulders level; confirmed on the first close
//                        through the neckline (the line through the two lows between them). Inverse: the mirror
//   triangles / wedges   the last two swing highs and two swing lows as lines: ascending (flat top, rising lows),
//   / channels           descending (falling highs, flat bottom), symmetric (both closing in), rising / falling wedge
//                        (both one way, closing in), channel (parallel); confirmed on the first close outside a line
//   flags                a sharp move (3+ typical moves in 4-8 minutes), then a tight pause (5-12 minutes, under half
//                        the move), confirmed when price breaks out of the pause the way the move went
//   support / resistance a level touched 3+ times by swing highs (or lows) in the last 2 hours; confirmed on a close
//                        through it
//   candles              hammer, shooting star, engulfing (candles.js), and the three-candle ones: morning / evening
//                        star, three white soldiers / black crows, piercing line / dark cloud cover
// Each confirmed pattern: { i, t, key, name, dir (+1 up, -1 down), lines: [{ t1, p1, t2, p2 }], target }.
import { detectPattern } from './candles.js';

export const CP = { k: 3, look: 90, flat: 0.04, tol: 0.35, flagMove: 3, keep: 5, levelLook: 120, levelTouches: 3 };

// the typical 1-minute move (log-return sd over the last hour), as a fraction of price
export function typicalMove(bars) {
  const out = new Array(bars.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i - 1].c > 0 ? Math.log(bars[i].c / bars[i - 1].c) : 0;
    s += r; s2 += r * r;
    if (i > 60) { const q = bars[i - 61].c > 0 ? Math.log(bars[i - 60].c / bars[i - 61].c) : 0; s -= q; s2 -= q * q; }
    const n = Math.min(i, 60);
    out[i] = n >= 10 ? Math.max(1e-5, Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2))) : null;
  }
  return out;
}

// swing highs and lows, each with the bar it becomes known at (k candles later)
export function pivots(bars, k = CP.k) {
  const hi = [], lo = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (j < i ? bars[j].h >= bars[i].h : bars[j].h > bars[i].h) isH = false;
      if (j < i ? bars[j].l <= bars[i].l : bars[j].l < bars[i].l) isL = false;
    }
    if (isH) hi.push({ i, p: bars[i].h, known: i + k });
    if (isL) lo.push({ i, p: bars[i].l, known: i + k });
  }
  return { hi, lo };
}
const lineAt = (a, b, i) => a.p + (b.p - a.p) * (i - a.i) / (b.i - a.i);
const seg = (bars, a, b, iEnd = b.i) => ({ t1: bars[a.i].t, p1: a.p, t2: bars[Math.min(iEnd, bars.length - 1)].t, p2: lineAt(a, b, Math.min(iEnd, bars.length - 1)) });

// head & shoulders (top: dir -1) and inverse (bottom: dir +1)
function headShoulders(bars, P, sd) {
  const out = [];
  const scan = (peaks, troughs, top) => {
    for (let a = 0; a + 2 < peaks.length; a++) {
      const [L, H, R] = [peaks[a], peaks[a + 1], peaks[a + 2]];
      if (R.i - L.i > CP.look) continue;
      const higher = (x, y) => (top ? x.p > y.p : x.p < y.p);
      if (!higher(H, L) || !higher(H, R)) continue;
      const t1 = troughs.filter((x) => x.i > L.i && x.i < H.i), t2 = troughs.filter((x) => x.i > H.i && x.i < R.i);
      if (!t1.length || !t2.length) continue;
      const pick = (xs) => xs.reduce((m, x) => (top ? (x.p < m.p ? x : m) : (x.p > m.p ? x : m)));
      const n1 = pick(t1), n2 = pick(t2), neckAtH = lineAt(n1, n2, H.i), height = Math.abs(H.p - neckAtH);
      if (!(height > 0) || Math.abs(L.p - R.p) > CP.tol * height) continue;
      for (let i = R.known; i < bars.length && i - R.i <= CP.look / 2; i++) {
        if (top ? bars[i].h > H.p : bars[i].l < H.p) break; // the head was taken out: no pattern
        const neck = lineAt(n1, n2, i);
        if (top ? bars[i].c < neck : bars[i].c > neck) {
          out.push({ i, key: 'hs', name: top ? 'Head and shoulders' : 'Inverse head and shoulders', dir: top ? -1 : 1, lines: [seg(bars, n1, n2, i), { t1: bars[L.i].t, p1: L.p, t2: bars[H.i].t, p2: H.p }, { t1: bars[H.i].t, p1: H.p, t2: bars[R.i].t, p2: R.p }], target: neck + (top ? -height : height) });
          break;
        }
      }
    }
  };
  scan(P.hi, P.lo, true); scan(P.lo, P.hi, false);
  return out;
}

// triangles, wedges and channels from the last two swing highs and lows known at each bar
// his / los: the swing highs and lows known by bar i (oldest first)
export function formationAt(bars, his0, los0, sd, i) {
  const his = his0.slice(-2).filter((x) => i - x.i <= CP.look), los = los0.slice(-2).filter((x) => i - x.i <= CP.look);
  if (his.length < 2 || los.length < 2 || !sd) return null;
  const [h1, h2] = his, [l1, l2] = los, px = bars[i].c, unit = px * sd; // slopes in typical moves per minute
  if (h2.i - h1.i < 3 || l2.i - l1.i < 3) return null;
  const sH = (h2.p - h1.p) / (h2.i - h1.i) / unit, sL = (l2.p - l1.p) / (l2.i - l1.i) / unit, f = CP.flat;
  const up = lineAt(h1, h2, i), dn = lineAt(l1, l2, i);
  if (!(up > dn)) return null;
  const flatH = Math.abs(sH) < f, flatL = Math.abs(sL) < f, closing = sH - sL < -f / 2, parallel = Math.abs(sH - sL) <= f;
  const kind = flatH && sL > f ? ['asc', 'Ascending triangle'] : flatL && sH < -f ? ['desc', 'Descending triangle'] : sH < -f && sL > f ? ['sym', 'Symmetric triangle']
    : sH > f && sL > f && closing ? ['rwedge', 'Rising wedge'] : sH < -f && sL < -f && closing ? ['fwedge', 'Falling wedge']
    : parallel && sH > f ? ['chup', 'Rising channel'] : parallel && sH < -f ? ['chdn', 'Falling channel'] : null;
  if (!kind) return null;
  return { id: `${h1.i}|${h2.i}|${l1.i}|${l2.i}`, kind: kind[0], name: kind[1], up, dn, lines: [seg(bars, h1, h2, i), seg(bars, l1, l2, i)], height: up - dn };
}
// the pivots known by each bar, walked forward with pointers (no rescans)
function knownWalker(P) {
  let a = 0, b = 0;
  const his = [], los = [];
  return (i) => { while (a < P.hi.length && P.hi[a].known <= i) his.push(P.hi[a++]); while (b < P.lo.length && P.lo[b].known <= i) los.push(P.lo[b++]); return { his, los }; };
}
function formations(bars, P, sd) {
  const out = [], done = new Set(), known = knownWalker(P);
  for (let i = 1; i < bars.length; i++) {
    const { his, los } = known(i - 1), fm = formationAt(bars, his, los, sd[i], i - 1); // the shape as it stood before this candle
    if (!fm || done.has(fm.id)) continue;
    const pad = 0.1 * bars[i].c * (sd[i] || 0), c = bars[i].c, dir = c > fm.up + pad ? 1 : c < fm.dn - pad ? -1 : 0;
    if (!dir) continue;
    done.add(fm.id);
    out.push({ i, key: 'triangle', name: `${fm.name} breakout ${dir > 0 ? 'up' : 'down'}`, shape: fm.kind, dir, lines: fm.lines, target: c + dir * fm.height });
  }
  return out;
}

// flags: a sharp move, a tight pause, a break the way the move went
function flags(bars, sd) {
  const out = [];
  let lastI = -99;
  for (let i = 20; i < bars.length; i++) {
    if (i - lastI < 10 || !sd[i]) continue;
    for (let c = 5; c <= 12; c++) {
      const w0 = i - c, pole0 = w0 - 6;
      if (pole0 < 1) break;
      const move = bars[w0 - 1].c - bars[pole0].o, dir = Math.sign(move), unit = bars[i].c * sd[i];
      if (Math.abs(move) < CP.flagMove * unit * Math.sqrt(6)) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = w0; j < i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
      if (hi - lo > 0.5 * Math.abs(move)) continue;
      if (dir > 0 ? bars[i].c > hi : bars[i].c < lo) {
        out.push({ i, key: 'flag', name: dir > 0 ? 'Bull flag breakout' : 'Bear flag breakout', dir, lines: [{ t1: bars[w0].t, p1: hi, t2: bars[i].t, p2: hi }, { t1: bars[w0].t, p1: lo, t2: bars[i].t, p2: lo }, { t1: bars[pole0].t, p1: bars[pole0].o, t2: bars[w0 - 1].t, p2: bars[w0 - 1].c }], target: bars[i].c + move });
        lastI = i; break;
      }
    }
  }
  return out;
}

// support / resistance: a level touched 3+ times, then a close through it
function levelBreaks(bars, P, sd) {
  const out = [], used = new Set(), known = knownWalker(P);
  for (let i = 1; i < bars.length; i++) {
    const { his, los } = known(i - 1);
    if (!sd[i]) continue;
    const tol = 0.5 * bars[i].c * sd[i], c = bars[i].c, prev = bars[i - 1].c;
    for (const [pts, res] of [[his, true], [los, false]]) {
      const recent = [];
      for (let j = pts.length - 1; j >= 0 && i - pts[j].i <= CP.levelLook; j--) recent.unshift(pts[j]);
      if (recent.length < CP.levelTouches) continue;
      const ref = recent.at(-1), touch = recent.filter((x) => Math.abs(x.p - ref.p) <= tol);
      if (touch.length < CP.levelTouches) continue;
      const lvl = touch.reduce((a, x) => a + x.p, 0) / touch.length, id = `${res}|${touch[0].i}`;
      if (used.has(id)) continue;
      if (res ? prev <= lvl + tol && c > lvl + tol : prev >= lvl - tol && c < lvl - tol) {
        used.add(id);
        out.push({ i, key: 'level', name: res ? `Resistance break (${touch.length} touches)` : `Support break (${touch.length} touches)`, dir: res ? 1 : -1, lines: [{ t1: bars[touch[0].i].t, p1: lvl, t2: bars[i].t, p2: lvl }], target: null });
      }
    }
  }
  return out;
}

// candlestick patterns: the one- and two-candle ones (candles.js) and the three-candle ones
export function candle3(a, b, c) {
  const body = (x) => Math.abs(x.c - x.o), bull = (x) => x.c > x.o, bear = (x) => x.c < x.o, mid = (x) => (x.o + x.c) / 2, rng = (x) => x.h - x.l;
  if (!(rng(a) > 0 && rng(b) > 0 && rng(c) > 0)) return null;
  if (bear(a) && body(a) > 0.5 * rng(a) && body(b) < 0.3 * body(a) && bull(c) && c.c > mid(a)) return { name: 'Morning star', dir: 1 };
  if (bull(a) && body(a) > 0.5 * rng(a) && body(b) < 0.3 * body(a) && bear(c) && c.c < mid(a)) return { name: 'Evening star', dir: -1 };
  if ([a, b, c].every((x) => bull(x) && body(x) > 0.5 * rng(x)) && b.c > a.c && c.c > b.c && b.o > a.o && c.o > b.o) return { name: 'Three white soldiers', dir: 1 };
  if ([a, b, c].every((x) => bear(x) && body(x) > 0.5 * rng(x)) && b.c < a.c && c.c < b.c && b.o < a.o && c.o < b.o) return { name: 'Three black crows', dir: -1 };
  if (bear(b) && bull(c) && c.o < b.c && c.c > mid(b) && c.c < b.o) return { name: 'Piercing line', dir: 1 };
  if (bull(b) && bear(c) && c.o > b.c && c.c < mid(b) && c.c > b.o) return { name: 'Dark cloud cover', dir: -1 };
  return null;
}
function candlePatterns(bars, sd) {
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    // a pattern only counts as a signal on a candle big enough to matter (half a typical move or more)
    if (!sd[i] || bars[i].h - bars[i].l < 0.5 * bars[i].c * sd[i]) continue;
    const p = candle3(bars[i - 2], bars[i - 1], bars[i]) ?? detectPattern(bars[i - 1], bars[i]);
    if (p) out.push({ i, key: 'candles', name: p.name, dir: p.dir, lines: [], target: null });
  }
  return out;
}

export const PATTERN_KEYS = { hs: 'Head and shoulders', triangle: 'Triangles, wedges and channels', flag: 'Flags', level: 'Support / resistance breaks', candles: 'Candlestick patterns' };
// every confirmed pattern in the bars (oldest first), each with its time
export function findPatterns(bars, keys = Object.keys(PATTERN_KEYS)) {
  if (bars.length < 30) return [];
  const sd = typicalMove(bars), P = pivots(bars), out = [];
  if (keys.includes('hs')) out.push(...headShoulders(bars, P, sd));
  if (keys.includes('triangle')) out.push(...formations(bars, P, sd));
  if (keys.includes('flag')) out.push(...flags(bars, sd));
  if (keys.includes('level')) out.push(...levelBreaks(bars, P, sd));
  if (keys.includes('candles')) out.push(...candlePatterns(bars, sd));
  return out.map((e) => ({ ...e, t: bars[e.i].t })).sort((a, b) => a.i - b.i);
}
// as a signal for the indicator test: +1 / -1 for `keep` minutes after a pattern of that kind confirms
export function patternKeySignal(bars, key, keep = CP.keep) {
  const out = bars.map(() => 0);
  for (const e of findPatterns(bars, [key])) for (let i = e.i; i < Math.min(bars.length, e.i + keep); i++) out[i] = e.dir;
  return out;
}

// The candidates for the indicator test (public/tune.js): each kind of pattern, its signal held 3 or 8 minutes
export const PATTERN_CANDIDATES = Object.keys(PATTERN_KEYS).flatMap((key) => [3, 8].map((keep) => ({ id: `cp_${key}_${keep}`, family: `cp_${key}`, name: `${PATTERN_KEYS[key]} (${keep} min after)`, need: 30, fromBars: (bars) => patternKeySignal(bars, key, keep) })));
export const PATTERN_FAMILIES = Object.fromEntries(Object.entries(PATTERN_KEYS).map(([k, v]) => [`cp_${k}`, v]));

// What the chart shows right now: the chart shapes confirmed in the last `within` minutes, the candle patterns of the
// last `candleWithin` (they're common), at most `max`, newest first; and the shape still forming
export function patternsNow(bars, { within = 30, candleWithin = 5, max = 6 } = {}) {
  if (bars.length < 30) return { recent: [], forming: null };
  const all = findPatterns(bars), last = bars.at(-1).t;
  const recent = all.filter((e) => last - e.t <= (e.key === 'candles' ? candleWithin : within) * 60000).reverse().slice(0, max);
  const sd = typicalMove(bars), P = pivots(bars), n = bars.length - 1;
  const fm = formationAt(bars, P.hi.filter((x) => x.known <= n), P.lo.filter((x) => x.known <= n), sd.at(-1), n);
  return { recent, forming: fm ? { name: fm.name, kind: fm.kind, lines: fm.lines, up: fm.up, dn: fm.dn } : null };
}
