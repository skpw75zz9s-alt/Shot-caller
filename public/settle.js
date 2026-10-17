// The line (v13.41): how safe the side that's ahead really is, in plain numbers, from the round's own arithmetic and
// from history (ideas learned from another 15-minute terminal, checked and built the Shot Caller way):
//   cushion      the lead over the target in dollars, next to how far price usually still moves in the time left
//                (price x volatility x sqrt(minutes)); their ratio, and how often rounds in history actually finished
//                on the leader's side at that ratio and that much time left (cushionTable, from the 1-minute candles)
//   razor        a lead under a quarter of the move left: a coin-flip zone
//   settlement   the last 60 seconds of a crypto round: Kalshi settles on the average of 60 one-second prints, so
//                every second that passes is banked. What the average lands at if price stays put, what the seconds
//                left would have to average to flip it, and how far that is in typical moves: past ~4 it's locked
//                by arithmetic
//   pressure     buyers vs sellers against the leader: how often the leader still won when they disagreed (the
//                Round scan's graded samples)
//   sessions     when Sydney, Tokyo, London and New York open and close (where the volume comes from)
// Pure functions; the server builds the history tables (tunefeed.js), the Deck shows them (app.js).
import { normCdf } from './model.js';

export const RATIO_BUCKETS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, Infinity];
export const LEFT_BUCKETS = [0, 1.01, 3, 6, 10, 15]; // minutes left
const ROUND = 900000, MIN = 60000;
const bucketOf = (edges, v) => { for (let i = 0; i < edges.length - 1; i++) if (v >= edges[i] && v < edges[i + 1]) return i; return edges.length - 2; };

// The lead and the move left. up: the leader is above the target (the leader's side in price terms)
export function cushionRead({ price, strike, sigmaMin, minutesLeft }) {
  if (!(price > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0)) return null;
  const lead = price - strike, move = price * sigmaMin * Math.sqrt(minutesLeft), ratio = Math.abs(lead) / move;
  const word = ratio < 0.25 ? 'razor' : ratio < 0.75 ? 'thin' : ratio < 1.5 ? 'solid' : ratio < 3 ? 'strong' : 'near-certain';
  return { lead, up: lead >= 0, move, ratio, word, razor: ratio < 0.25, mathWin: normCdf(ratio) };
}

// History: at every minute of every complete round in the candles, the leader's cushion ratio and minutes left, and
// whether the round then finished on the leader's side (the target is the round's open). Wins by bucket.
export function cushionTable(bars) {
  const at = new Map(bars.map((b, i) => [b.t, i])), n = (RATIO_BUCKETS.length - 1) * (LEFT_BUCKETS.length - 1);
  const won = new Array(n).fill(0), all = new Array(n).fill(0);
  let s = 0, s2 = 0; const vol = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const r = Math.log(bars[i].c / bars[i - 1].c); s += r; s2 += r * r;
    if (i > 60) { const q = Math.log(bars[i - 60].c / bars[i - 61].c); s -= q; s2 -= q * q; }
    if (i >= 60) vol[i] = Math.max(1e-5, Math.sqrt(Math.max(0, s2 / 60 - (s / 60) ** 2)));
  }
  let rounds = 0;
  for (let rs = Math.ceil((bars[0]?.t ?? 0) / ROUND) * ROUND; bars.length && rs + ROUND <= bars.at(-1).t + MIN; rs += ROUND) {
    const first = at.get(rs), last = at.get(rs + ROUND - MIN);
    if (first == null || last == null || last - first !== 14) continue;
    const target = bars[first].o, close = bars[last].c;
    if (close === target) continue;
    rounds++;
    for (let k = first; k < last; k++) {
      const left = (last - k), c = bars[k].c, sg = vol[k];
      if (sg == null || c === target) continue;
      const ratio = Math.abs(c - target) / (c * sg * Math.sqrt(left)), j = bucketOf(RATIO_BUCKETS, ratio) * (LEFT_BUCKETS.length - 1) + bucketOf(LEFT_BUCKETS, left);
      all[j]++; if ((close > target) === (c > target)) won[j]++;
    }
  }
  return { rounds, ratio: RATIO_BUCKETS, left: LEFT_BUCKETS, won, all };
}
// The history for one moment: { rate, n } at this ratio and time left, or null without enough rounds (30+)
export function cushionHistory(table, ratio, minutesLeft) {
  if (!table?.all) return null;
  const j = bucketOf(table.ratio.map((x) => (x === null ? Infinity : x)), ratio) * (table.left.length - 1) + bucketOf(table.left, minutesLeft);
  const n = table.all[j];
  return n >= 30 ? { rate: table.won[j] / n, n } : null;
}

// The last 60 seconds: prints = [{ t, s }] (the bot's quote log: the price each tick), close = the close time.
// avg60 settlement only (crypto); null outside the last minute.
export function settlementWatch({ prints, close, spot, strike, sigmaMin, now = Date.now(), basis = 0 }) {
  if (!(spot > 0) || !(strike > 0) || now < close - 60000 || now >= close) return null;
  // banked: the seconds already in Kalshi's average (one print a second); their average from the prints seen (every
  // couple of seconds in the bot's log), the live price filling any gap
  const banked = Math.min(60, Math.max(0, Math.floor((now - (close - 60000)) / 1000))), left = 60 - banked;
  const xs = (prints || []).filter((e) => e.t >= close - 60000 && e.t <= now && e.s > 0).map((e) => e.s + basis);
  const avg = xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : spot + basis;
  const px = spot + basis, proj = (avg * banked + px * left) / 60, lead = proj - strike;
  if (!left) return { banked, left, avg, proj, lead, need: null, sigmas: Infinity, locked: true };
  // what the seconds left must average for the final average to land exactly on the target
  const need = (60 * strike - avg * banked) / left, gap = need - px;
  // how much the average of the seconds left typically wanders from here: a random walk's average over n seconds
  const sdSec = px * (sigmaMin / Math.sqrt(60)), sdAvg = sdSec * Math.sqrt((left + 1) * (2 * left + 1) / (6 * left));
  const sigmas = sdAvg > 0 ? Math.abs(gap) / sdAvg : Infinity;
  return { banked, left, avg, proj, lead, need, gap, perSec: gap / Math.max(1, left), sigmas, locked: Math.sign(gap) === Math.sign(-lead) && sigmas >= 4 };
}

// Buyers vs sellers against the leader: the Round scan's graded samples (lean: the scan's side, pModel: the bot's
// odds for YES, y: 1 when YES won). { agree: { n, won }, disagree: { n, won } } for the leader
export function pressureAgreement(samples) {
  const out = { agree: { n: 0, won: 0 }, disagree: { n: 0, won: 0 } };
  for (const s of samples || []) {
    if ((s.y !== 0 && s.y !== 1) || !s.lean || s.pModel == null || s.pModel === 0.5) continue;
    const lead = s.pModel > 0.5 ? 'YES' : 'NO', b = s.lean === lead ? out.agree : out.disagree;
    b.n++; if ((s.y === 1 ? 'YES' : 'NO') === lead) b.won++;
  }
  return out;
}

// The big trading sessions, weekdays, in each city's own time: { name, flag, open, opensIn | closesIn (ms) }
export const SESSIONS = [['Sydney', '🇦🇺', 'Australia/Sydney', 7, 16], ['Tokyo', '🇯🇵', 'Asia/Tokyo', 9, 18], ['London', '🇬🇧', 'Europe/London', 8, 17], ['New York', '🇺🇸', 'America/New_York', 8, 17]];
const fmts = {};
function localParts(t, tz) {
  const f = (fmts[tz] ||= new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }));
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { wd: p.weekday, mins: (+p.hour % 24) * 60 + +p.minute };
}
export function sessions(now = Date.now()) {
  return SESSIONS.map(([name, flag, tz, o, c]) => {
    const isOpen = (t) => { const p = localParts(t, tz); return !['Sat', 'Sun'].includes(p.wd) && p.mins >= o * 60 && p.mins < c * 60; };
    const open = isOpen(now);
    let dt = 0; // minutes until it changes (searched minute by minute, up to 3 days)
    for (let k = 1; k <= 3 * 1440; k++) if (isOpen(now + k * MIN) !== open) { dt = k * MIN; break; }
    return { name, flag, open, ...(open ? { closesIn: dt } : { opensIn: dt }) };
  });
}
export const span = (ms) => { const m = Math.round(ms / MIN), h = Math.floor(m / 60); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`; };
