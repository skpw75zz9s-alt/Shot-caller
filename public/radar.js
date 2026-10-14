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

export const RADAR = { level: 0.9, own: 30, levels: [0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98], replayMin: 20 };
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

// The level each kind of call is set at (v13.27). Conformal's 90% assumes the coming rounds behave like the past ones;
// BTC's rounds come in calm and wild stretches, so the misses bunch up and a straight 90% threshold can hold less. The
// radar replays its own history walk-forward: for each past round (oldest first), the threshold from the rounds before
// it only, exactly as it would have been set live, and whether that round's closes stayed inside. It then uses the lowest
// level whose replay held 90%+ (from 20 replayed rounds; up to 98%), so the bands widen until the record says they hold.
const rounds = (log) => [...(log || [])].filter((e) => e.actual != null && e.cps).sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))
  .map((e) => Object.entries(e.cps).filter(([, c]) => c.sd > 0 && Number.isFinite(c.blend)).map(([m, c]) => ({ m: +m, d: (e.actual - c.blend) / c.sd })));
const insert = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; } arr.splice(lo, 0, v); };
const KINDS = { floor: (s) => -s.d, ceil: (s) => s.d, range: (s) => Math.abs(s.d) };
let levelMemo = null;
export function radarLevels(log) {
  const rs = rounds(log), key = `${rs.length}:${log?.[0]?.closeTime ?? ''}:${log?.length ?? 0}`;
  if (levelMemo?.key === key) return levelMemo.out;
  const bandOf = (m) => BLEND.bands.findIndex(([a, b]) => m >= a && m <= b);
  const out = {};
  for (const [kind, f] of Object.entries(KINDS)) {
    const all = [], own = BLEND.bands.map(() => []), held = RADAR.levels.map(() => ({ n: 0, hit: 0 }));
    let replayed = 0;
    for (const r of rs) {
      if (all.length >= 9) {
        replayed++;
        for (const sc of r) {
          const b = bandOf(sc.m), use = b >= 0 && own[b].length >= RADAR.own ? own[b] : all, v = f(sc);
          RADAR.levels.forEach((L, i) => { const k = Math.ceil((use.length + 1) * L - 1e-9), q = k <= use.length ? use[k - 1] : Infinity; held[i].n++; if (v <= q) held[i].hit++; });
        }
      }
      for (const sc of r) { const v = f(sc), b = bandOf(sc.m); insert(all, v); if (b >= 0) insert(own[b], v); }
    }
    const rate = (h) => (h.n ? h.hit / h.n : null), found = held.findIndex((h) => h.n && h.hit / h.n >= RADAR.level - 1e-9);
    const i = replayed < RADAR.replayMin ? 0 : found < 0 ? held.length - 1 : found;
    out[kind] = { level: RADAR.levels[i], replayed, held: rate(held[i]), straight: rate(held[0]) }; // straight: what plain 90% would have held
  }
  levelMemo = { key, out };
  return out;
}

// The radar's read now. expected: the blend's expected close; sd: a typical move to the close; next: { c, sd } for the
// next minute's expected close and 1-minute move
export function radarRead({ log, pcLog = [], expected, sd, mins, target, next = null }) {
  if (!Number.isFinite(expected) || !(sd > 0)) return null;
  const all = closeScores(log), [a, b] = BLEND.bands[blendBand(mins)], own = all.filter((s) => s.m >= a && s.m <= b);
  const use = own.length >= RADAR.own ? own : all;
  const lv = radarLevels(log);
  const q = (f, z, L) => { const v = conformal(use.map(f), L); return v == null ? { q: z, sure: false } : { q: v, sure: true }; };
  const F = q(KINDS.floor, Z.one, lv.floor.level), C = q(KINDS.ceil, Z.one, lv.ceil.level), R = q(KINDS.range, Z.two, lv.range.level);
  const floor = expected - F.q * sd, ceil = expected + C.q * sd, lo = expected - R.q * sd, hi = expected + R.q * sd;
  const dir = target > 0 ? (floor > target ? 'UP' : ceil < target ? 'DOWN' : null) : null;
  const need = dir || !(target > 0) ? 0 : expected >= target ? target - floor : ceil - target;
  let nx = null;
  if (next && Number.isFinite(next.c) && next.sd > 0) {
    const v = conformal(minuteScores(pcLog)), w = (v ?? Z.two) * next.sd;
    nx = { t: next.t, lo: next.c - w, hi: next.c + w, sure: v != null };
  }
  return { expected, floor, ceil, lo, hi, dir, need, target, sure: F.sure && C.sure && R.sure, n: use.length, stretch: use === own, next: nx, levels: lv };
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

// The scope (v13.12): the radar drawn as a real radar screen, a round phosphor display with range rings, a bezel and a
// sweeping beam (the beam is a CSS overlay, so it never restarts when this redraws). Price runs up and down the screen:
//   centre      the expected close (+)
//   range ring  the 90% range (it's symmetric around the expected close, so it's a circle)
//   chords      the floor and ceiling, inside the ring
//   target      a horizontal line across the screen; above it is the UP zone (green), below the DOWN zone (red)
//   now         BTC's price now, the bright blip on the centre line
//   next        the next minute's 90% band, the small dashed circle
//   blips       every exchange, at its price (green: buyers led its last minute, red: sellers), spread left and right
//   rings       each ring is labelled with its distance from the expected close
// phase: where the beam is now (ms into its period), so each blip lights up as the beam passes it
export const SCOPE = { size: 300, r: 132, beam: 138, period: 4000 };
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// prices at the precision their size needs ($100,250 for BTC, $152.37 for SOL, $2.5123 for XRP, $0.18234 for DOGE)
const digitsFor = (ref) => (ref >= 1000 ? 0 : ref >= 10 ? 2 : ref >= 1 ? 4 : 5);
let scopeRef = 1000; // the price size of the read being drawn (set by scopeSvg)
const money = (v, ref = scopeRef) => { const d = digitsFor(Math.abs(ref)); return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`; };
// Each exchange's tag on its blip (perps marked ·P); anything new falls back to its first three letters
const TAGS = { Coinbase: 'CB', Kraken: 'KRK', Bitstamp: 'BST', Gemini: 'GEM', 'Binance.US': 'BUS', Binance: 'BIN', 'Binance perp': 'BIN·P', 'Bybit perp': 'BYB·P',
  'OKX perp': 'OKX·P', 'Deribit perp': 'DER·P', Bitfinex: 'BFX', 'Crypto.com': 'CRO' };
export const blipTag = (ex) => TAGS[ex] ?? String(ex).slice(0, 3).toUpperCase();
const short = (v, ref = scopeRef) => (v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : v >= 10 || ref >= 1000 ? `$${Math.round(v)}`
  : `$${v.toPrecision(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`); // a ring's distance: $78, or $0.21 / $0.0031 on a small-priced market

export function scopeLayout(rd, spot, venues = []) {
  const { size, r: R } = SCOPE, c = size / 2, E = rd.expected;
  const near = [rd.hi - E, E - rd.lo, Math.abs(rd.floor - E), Math.abs(rd.ceil - E), Number.isFinite(spot) ? Math.abs(spot - E) : 0,
    rd.target > 0 ? Math.abs(rd.target - E) : 0, rd.next ? Math.max(Math.abs(rd.next.hi - E), Math.abs(rd.next.lo - E)) : 0, ...venues.map((v) => Math.abs(v.price - E))];
  // the screen spans the farthest thing to show (+18%), at least a millionth of the price: a $1 floor squashed XRP's and
  // DOGE's whole radar (ranges of a fraction of a cent) into one flat line at the centre
  const S = Math.max(Math.abs(E) * 1e-6 || 1e-9, ...near.filter(Number.isFinite)) * 1.18;
  const Y = (p) => c - ((p - E) / S) * R, half = (y, rad = R) => Math.sqrt(Math.max(0, rad * rad - (y - c) ** 2));
  const sorted = [...venues].sort((a, b) => a.ex.localeCompare(b.ex)), per = Math.max(1, Math.ceil(sorted.length / 2) - 1);
  const blips = sorted.map((v, i) => {
    const y = Y(v.price), f = 0.3 + 0.55 * (Math.floor(i / 2) / per), x = c + (i % 2 ? 1 : -1) * f * half(y);
    return { ...v, x, y };
  });
  const rr = ((rd.hi - E) / S) * R;
  return { c, R, S, Y, half, rr, blips, now: Number.isFinite(spot) ? Y(spot) : null };
}
// The beam's angle at a point: degrees clockwise from 12 o'clock
const bearing = (x, y, c) => ((Math.atan2(x - c, c - y) * 180) / Math.PI + 360) % 360;

// The screen without a read: bezel, phosphor screen, range rings, crosshairs and bearing ticks. under: drawn between
// the screen and the rings (the zones)
function frame(under = '') {
  const { size } = SCOPE, R = SCOPE.r, c = size / 2, f = (v) => v.toFixed(1);
  const out = ['<defs><radialGradient id="rsScreen" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#06231a"/><stop offset=".75" stop-color="#03140f"/><stop offset="1" stop-color="#010806"/></radialGradient>'
    + `<clipPath id="rsClip"><circle cx="${c}" cy="${c}" r="${R + 6}"/></clipPath>`
    + '<filter id="rsGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'];
  // bezel and screen
  out.push(`<circle class="rs-bezel" cx="${c}" cy="${c}" r="${R + 13}"/><circle class="rs-screen" cx="${c}" cy="${c}" r="${R + 6}" fill="url(#rsScreen)"/>`);
  out.push(under);
  // range rings, crosshairs and bearing ticks
  for (let k = 1; k <= 4; k++) out.push(`<circle class="rs-ring" cx="${c}" cy="${c}" r="${f((R * k) / 4)}"/>`);
  out.push(`<line class="rs-cross" x1="${c - R - 6}" x2="${c + R + 6}" y1="${c}" y2="${c}"/><line class="rs-cross" x1="${c}" x2="${c}" y1="${c - R - 6}" y2="${c + R + 6}"/>`);
  for (let a = 0; a < 360; a += 10) {
    const t = (a * Math.PI) / 180, r1 = R + 6, r2 = R + (a % 30 ? 9 : 12);
    out.push(`<line class="rs-tick" x1="${f(c + r1 * Math.sin(t))}" y1="${f(c - r1 * Math.cos(t))}" x2="${f(c + r2 * Math.sin(t))}" y2="${f(c - r2 * Math.cos(t))}"/>`);
  }
  return out;
}
export const scopeIdle = (msg = 'WAITING FOR A LIVE ROUND') => frame().join('') + `<text class="rs-corner" x="${SCOPE.size / 2}" y="${SCOPE.size / 2 + SCOPE.r / 2 + 4}" text-anchor="middle">${xmlEsc(msg)}</text>`;

export function scopeSvg(rd, spot, venues = [], { phase = null } = {}) {
  scopeRef = Math.abs(rd.expected) || 1000;
  const { size, period: P } = SCOPE, L = scopeLayout(rd, spot, venues), { c, R, Y, half, rr } = L, f = (v) => v.toFixed(1);
  const sync = (x, y) => {
    if (phase == null) return '';
    const d = ((((bearing(x, y, c) / 360) * P - phase) % P) + P) % P;
    return ` style="animation-delay:${Math.round(d - P)}ms"`;
  };
  const yT = rd.target > 0 ? Y(rd.target) : null;
  // the UP and DOWN zones either side of the target
  const out = frame(yT == null ? '' : `<g clip-path="url(#rsClip)"><rect class="rs-up" x="0" y="0" width="${size}" height="${f(Math.max(0, yT))}"/><rect class="rs-down" x="0" y="${f(Math.max(0, yT))}" width="${size}" height="${f(Math.max(0, size - yT))}"/></g>`);
  for (let k = 1; k <= 4; k++) out.push(`<text class="rs-scale" x="${f(c - (R * k) / 4 * 0.5 - 2)}" y="${f(c - (R * k) / 4 * 0.866 + 3)}" text-anchor="end">±${short((L.S * k) / 4)}</text>`); // on each ring, up and to the left
  // the 90% range ring, the floor and ceiling chords
  out.push(`<circle class="rs-range" cx="${c}" cy="${c}" r="${f(rr)}"/>`);
  for (const [p, name] of [[rd.ceil, 'CEILING'], [rd.floor, 'FLOOR']]) {
    const y = Y(p), w = Math.max(10, half(y, rr));
    // labelled outside the ring's middle: the ceiling above its chord, the floor below
    out.push(`<line class="rs-edge" x1="${f(c - w)}" x2="${f(c + w)}" y1="${f(y)}" y2="${f(y)}"/><text class="rs-lbl" x="${c}" y="${f(name === 'CEILING' ? y - 4 : y + 10)}" text-anchor="middle">${name} ${money(p)}</text>`);
  }
  // the target line
  if (yT != null) {
    const w = half(yT, R + 6);
    out.push(`<line class="rs-target" x1="${f(c - w)}" x2="${f(c + w)}" y1="${f(yT)}" y2="${f(yT)}"/><text class="rs-lbl tgt" x="${f(c + Math.min(w, R) - 4)}" y="${f(yT - 4)}" text-anchor="end">TARGET ${money(rd.target)}</text>`);
  }
  // the next minute's band
  if (rd.next) {
    const y = Y((rd.next.lo + rd.next.hi) / 2), rad = Math.max(3, ((rd.next.hi - rd.next.lo) / 2 / L.S) * R);
    out.push(`<circle class="rs-next" cx="${c}" cy="${f(y)}" r="${f(rad)}"/>`);
  }
  // the exchanges' blips, then the expected close and the price now
  for (const b of L.blips) {
    out.push(`<g class="rs-blip ${b.net > 0 ? 'b' : b.net < 0 ? 's' : ''}"${sync(b.x, b.y)}><circle cx="${f(b.x)}" cy="${f(b.y)}" r="3.6" filter="url(#rsGlow)"><title>${xmlEsc(b.ex)} ${money(b.price)}</title></circle>`
      + `<text class="rs-ex" x="${f(b.x)}" y="${f(b.y - 6)}" text-anchor="middle">${xmlEsc(blipTag(b.ex))}</text></g>`);
  }
  out.push(`<path class="rs-exp" d="M${c - 6} ${c}h12M${c} ${c - 6}v12"/>`);
  if (L.now != null) out.push(`<g class="rs-now"${sync(c, L.now)}><circle cx="${c}" cy="${f(L.now)}" r="4.8" filter="url(#rsGlow)"/><text class="rs-lbl now" x="${c + 8}" y="${f(L.now + 3)}">NOW ${money(spot)}</text></g>`);
  // the corners: the zones and the verdict
  if (yT != null) out.push(`<text class="rs-corner up" x="6" y="14">▲ UP ZONE</text><text class="rs-corner down" x="6" y="${size - 6}">▼ DOWN ZONE</text>`);
  out.push(`<text class="rs-corner ${rd.dir === 'UP' ? 'up' : rd.dir === 'DOWN' ? 'down' : ''}" x="${size - 6}" y="${size - 6}" text-anchor="end">${rd.dir ? `${rd.dir} · 90%+` : rd.target > 0 ? 'NO CALL' : ''}</text>`);
  out.push(`<text class="rs-corner" x="${size - 6}" y="14" text-anchor="end">${venues.length} EXCH</text>`);
  return out.join('');
}
