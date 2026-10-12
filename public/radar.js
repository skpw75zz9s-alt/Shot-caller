// The market radar (v13.2): calls about this round that come true at least 90% of the time.
// Not by out-guessing the market: 90% is reachable for any question whose answer is wide enough, and the radar finds the
// narrowest answers that still hold 90% of the time, from the bot's own record. The method is split conformal
// prediction. Each logged minute (public/predict.js: the blend's expected close, logged out of sample) left a score, how
// far the close landed from what was expected, in typical moves:
//   d = (close - expected) / (spot x 1-minute vol x sqrt(minutes left))
// With n past scores, the ceil((n+1) x 0.9)-th smallest is a threshold a new score stays under with probability at
// least 90%, whatever the scores' distribution, provided the next round behaves like the past ones (exchangeable). So:
//   Floor     closes above   expected - q x sd    (q from the scores -d)
//   Ceiling   closes below   expected + q x sd    (q from d)
//   Range     closes between expected -+ q x sd   (q from |d|)
//   Direction UP when the floor clears the target, DOWN when the ceiling does: it inherits the floor's (ceiling's) 90%.
//             Otherwise no call, and how much further from the target BTC's expected close would need to be
//   Next minute  the next 1-minute candle closes within its expected close -+ q x the 1-minute move (the path's record)
// Scores come from the same stretch of the round (1-3, 4-7, 8-14 minutes left) once it has 30, else from every minute.
// Below 9 scores there's no guarantee yet: it falls back to the normal curve's 90% points and says so. Each call is
// logged and graded at the close, so the record shows whether 90% really held.
import { BLEND, blendBand } from './predict.js';

export const RADAR = { level: 0.9, own: 30 };
const Z = { one: 1.2815515655446004, two: 1.6448536269514722 }; // the normal curve's one- and two-sided 90% points

// The conformal threshold: the ceil((n+1) x level)-th smallest score, or null when n is too small for it to exist
export function conformal(scores, level = RADAR.level) {
  const n = scores.length, k = Math.ceil((n + 1) * level - 1e-9);
  return k > n || k < 1 ? null : [...scores].sort((a, b) => a - b)[k - 1];
}
// Past scores of the expected close: one per graded logged minute
export function closeScores(log) {
  const out = [];
  for (const e of log || []) if (e.actual != null && e.cps) for (const [m, c] of Object.entries(e.cps)) if (c.sd > 0 && Number.isFinite(c.blend)) out.push({ m: +m, d: (e.actual - c.blend) / c.sd });
  return out;
}
// Past scores of the expected path's next minute (pcLog entries carry the 1-minute move from v13.2)
const minuteScores = (pcLog) => (pcLog || []).filter((e) => e.actual != null && e.sd > 0 && Number.isFinite(e.c)).map((e) => Math.abs(e.actual - e.c) / e.sd);

// The radar's read now. expected: the blend's expected close; sd: a typical move to the close; next: { c, sd } for the
// next minute's expected close and 1-minute move
export function radarRead({ log, pcLog = [], expected, sd, mins, target, next = null }) {
  if (!Number.isFinite(expected) || !(sd > 0)) return null;
  const all = closeScores(log), [a, b] = BLEND.bands[blendBand(mins)], own = all.filter((s) => s.m >= a && s.m <= b);
  const use = own.length >= RADAR.own ? own : all;
  const q = (f, z) => { const v = conformal(use.map(f)); return v == null ? { q: z, sure: false } : { q: v, sure: true }; };
  const F = q((s) => -s.d, Z.one), C = q((s) => s.d, Z.one), R = q((s) => Math.abs(s.d), Z.two);
  const floor = expected - F.q * sd, ceil = expected + C.q * sd, lo = expected - R.q * sd, hi = expected + R.q * sd;
  const dir = target > 0 ? (floor > target ? 'UP' : ceil < target ? 'DOWN' : null) : null;
  const need = dir || !(target > 0) ? 0 : expected >= target ? target - floor : ceil - target;
  let nx = null;
  if (next && Number.isFinite(next.c) && next.sd > 0) {
    const v = conformal(minuteScores(pcLog)), w = (v ?? Z.two) * next.sd;
    nx = { t: next.t, lo: next.c - w, hi: next.c + w, sure: v != null };
  }
  return { expected, floor, ceil, lo, hi, dir, need, target, sure: F.sure && C.sure && R.sure, n: use.length, stretch: use === own, next: nx };
}

// The record: how often each kind of call came true (graded against the round's close, the close of Coinbase's last
// 1-minute candle, like the prediction lines). r = { f, c, l, h, d, tg } on each logged minute; pcLog entries' lo/hi
export function radarRecord(log, pcLog = []) {
  const k = () => ({ n: 0, hit: 0 }), t = { floor: k(), ceil: k(), range: k(), dir: k(), next: k() };
  const add = (x, ok) => { x.n++; if (ok) x.hit++; };
  for (const e of log || []) {
    if (e.actual == null || !e.cps) continue;
    const a = e.actual;
    for (const c of Object.values(e.cps)) {
      const r = c.r;
      if (!r) continue;
      add(t.floor, a >= r.f); add(t.ceil, a <= r.c); add(t.range, a >= r.l && a <= r.h);
      if (r.d) add(t.dir, r.d === 'UP' ? a > r.tg : a < r.tg);
    }
  }
  for (const e of pcLog || []) if (e.actual != null && Number.isFinite(e.lo)) add(t.next, e.actual >= e.lo && e.actual <= e.hi);
  for (const x of Object.values(t)) x.rate = x.n ? x.hit / x.n : null;
  return t;
}
