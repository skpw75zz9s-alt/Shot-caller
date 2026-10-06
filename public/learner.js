// The bot's long-term memory of the market. The server watches BTC and every 15-minute window around the clock and
// learns three things that make the bot's odds more accurate. Pure functions, shared by the server and the phone:
//   1) volatility by time of week: how wild BTC usually is in each half hour of the week (New York time, so the US
//      open and 8:30 news line up all year). If the next 15 minutes are usually busier than the last 30, the bot
//      prices with more volatility before the move arrives, not after. Old weeks fade out (8-week half-life), so
//      it keeps up with the seasons.
//   2) calibration: when the bot said 85%, how often did that side really win? Small corrections, only once there's
//      enough evidence, capped at ±5 pts.
//   3) basis: the gap between Coinbase (the app's price) and the index Kalshi actually settles on.
export const SLOTS = 336; // half hours in a week
const HALF_LIFE = 8 * 30; // samples per slot: ~8 weeks (30 one-minute samples per slot per week)
const DECAY = 0.5 ** (1 / HALF_LIFE);
const MIN_SLOT_N = 20;    // samples a half hour needs before its volatility counts
export const CAL_BINS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 1.0001];
const CAL_MIN_N = 50;     // windows of evidence before a bin can be corrected at all
const CAL_MAX = 0.05;
const BASIS_MIN = 10;

export const newLearned = () => ({
  v: 1,
  vol: { s2: Array(SLOTS).fill(0), n: Array(SLOTS).fill(0), lastT: 0, minutes: 0, firstT: null },
  cal: CAL_BINS.slice(0, -1).map(() => ({ n: 0, wins: 0, sumQ: 0 })),
  basis: [], windows: 0,
});

// Half hour of the week in New York time (Sun 00:00 = 0). The UTC offset is cached per hour.
const nyFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }) : null;
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const slotCache = new Map();
export function slotOf(t) {
  const h = Math.floor(t / 3600000);
  let base = slotCache.get(h);
  if (base == null) {
    let day = new Date(h * 3600000).getUTCDay(), hour = new Date(h * 3600000).getUTCHours() - 5;
    if (nyFmt) {
      const p = Object.fromEntries(nyFmt.formatToParts(new Date(h * 3600000 + 1)).map((x) => [x.type, x.value]));
      day = DAYS[p.weekday]; hour = Number(p.hour) % 24;
    } else if (hour < 0) { hour += 24; day = (day + 6) % 7; }
    base = (day * 24 + hour) * 2;
    if (slotCache.size > 5000) slotCache.clear();
    slotCache.set(h, base);
  }
  return base + (Math.floor(t / 60000) % 60 >= 30 ? 1 : 0);
}
export const slotLabel = (slot) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Math.floor(slot / 48)]} ${new Date(Date.UTC(2000, 0, 1, Math.floor((slot % 48) / 2), (slot % 2) * 30)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} ET`;

// Feed 1-minute candles (oldest first, { t, c }). Only consecutive minutes newer than what's already learned count.
export function learnCandles(L, candles) {
  const v = L.vol;
  let added = 0;
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1], b = candles[i];
    if (b.t <= v.lastT || b.t - a.t !== 60000 || !(a.c > 0 && b.c > 0)) continue;
    const slot = slotOf(b.t);
    let r2 = Math.log(b.c / a.c) ** 2;
    if (v.n[slot] >= MIN_SLOT_N) r2 = Math.min(r2, 36 * (v.s2[slot] / v.n[slot])); // one crash minute can't own the slot
    v.s2[slot] = v.s2[slot] * DECAY + r2;
    v.n[slot] = v.n[slot] * DECAY + 1;
    v.lastT = b.t; v.minutes++; v.firstT ??= b.t;
    added++;
  }
  return added;
}

const slotVar = (L, slot) => (L?.vol?.n[slot] >= MIN_SLOT_N ? L.vol.s2[slot] / L.vol.n[slot] : null);

// How much busier the coming minutes usually are than the recent ones: sqrt(usual variance from now to close ÷ usual
// variance over the last 30 minutes), within 0.75-1.5. 1 when there isn't enough history.
export function volFactor(L, now, close, lookback = 30) {
  if (!L?.vol || !(close > now)) return 1;
  const avg = (from, to) => {
    let s = 0, k = 0;
    for (let t = from; t < to; t += 60000) { const x = slotVar(L, slotOf(t)); if (x == null) return null; s += x; k++; }
    return k ? s / k : null;
  };
  const fut = avg(now, close), past = avg(now - lookback * 60000, now);
  if (!fut || !past) return 1;
  return Math.min(1.5, Math.max(0.75, Math.sqrt(fut / past)));
}

// The week's busiest and quietest half hours, relative to the week's average
export function volProfile(L) {
  const vars = [...Array(SLOTS).keys()].map((s) => slotVar(L, s));
  const known = vars.map((x, s) => [x, s]).filter(([x]) => x != null);
  if (known.length < SLOTS / 2) return null;
  const mean = known.reduce((a, [x]) => a + x, 0) / known.length;
  known.sort((a, b) => b[0] - a[0]);
  const rel = (x) => Math.sqrt(x / mean);
  return { busiest: { slot: known[0][1], x: rel(known[0][0]) }, quietest: { slot: known[known.length - 1][1], x: rel(known[known.length - 1][0]) }, rel: vars.map((x) => (x == null ? null : rel(x))) };
}

// ---------- calibration ----------
const binOf = (q) => CAL_BINS.findIndex((b, i) => q >= b && q < CAL_BINS[i + 1]);

// One graded window: samples of the bot's raw P(YES) during the call phase, and how it settled.
// Samples in one window are nearly the same bet, so a window counts once in total (split across the bins it visited).
export function learnWindow(L, samples, result) {
  if (result !== 'yes' && result !== 'no') return;
  const ps = samples.filter((p) => p != null);
  if (!ps.length) return;
  const w = 1 / ps.length, fade = 0.9995 ** w; // slow fade: about a year of 15-minute windows
  for (const p of ps) {
    const q = Math.max(p, 1 - p), won = (p >= 0.5) === (result === 'yes');
    const b = L.cal[binOf(q)];
    if (!b) continue;
    b.n = b.n * fade + w; b.wins = b.wins * fade + (won ? w : 0); b.sumQ = b.sumQ * fade + q * w;
  }
  L.windows++;
}

// Correction (in probability points) for the favored side in one bin: only the part of the miss that's bigger than
// 2 standard errors (luck), so a calibrated bot gets no correction and a real, lasting miss gets fixed. Capped at ±5.
function binShift(b) {
  if (!b || b.n < CAL_MIN_N) return 0;
  const said = b.sumQ / b.n, d = b.wins / b.n - said;
  const se = Math.sqrt(Math.max(said * (1 - said), 0.01) / b.n);
  const real = Math.max(0, Math.abs(d) - 2 * se);
  return real > 0 ? Math.sign(d) * Math.min(CAL_MAX, real) : 0;
}
// Shift to add to P(YES): applied to whichever side the model favors
export function calShift(L, pYes) {
  if (!L?.cal || pYes == null) return 0;
  const q = Math.max(pYes, 1 - pYes);
  const s = binShift(L.cal[binOf(q)]);
  return s === 0 ? 0 : pYes >= 0.5 ? s : -s;
}
export const calTable = (L) => (L?.cal || []).map((b, i) => ({ from: CAL_BINS[i], to: Math.min(1, CAL_BINS[i + 1]), n: Math.round(b.n), said: b.n ? b.sumQ / b.n : null, won: b.n ? b.wins / b.n : null, shift: binShift(b) }));

// ---------- basis (Coinbase vs Kalshi's settlement index) ----------
export function learnBasis(L, settled, coinbaseAvg) {
  if (!(settled > 0 && coinbaseAvg > 0) || Math.abs(settled - coinbaseAvg) > coinbaseAvg * 0.002) return false; // a bad read, not a basis
  L.basis.push(Math.round((settled - coinbaseAvg) * 100) / 100);
  if (L.basis.length > 100) L.basis.splice(0, L.basis.length - 100);
  return true;
}
export function basisOf(L) {
  const b = L?.basis || [];
  if (b.length < BASIS_MIN) return 0;
  const s = [...b].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]; // median: one odd settlement can't move it
}

// What the phone downloads: everything the model uses, without the raw sums
export const publicLearned = (L) => ({ v: L.v, vol: L.vol, cal: L.cal, basis: L.basis, windows: L.windows });
