// The playbook's 15-minute BTC sweep strategy, exactly as written, so it can be measured instead of believed
// ("a testable setup, not a verified profitable system"). On 1-minute candles { t, o, h, l, c, v }, oldest first:
//   Trend         the 1-hour chart: the 20-hour average rising (longs only) or falling (shorts only)
//   Liquidity     yesterday's (UTC) high and low ... and, as a variant with more examples, the last hour's
//   Sweep         a 15-minute candle breaks one of them and closes back inside
//   Confirmation  within 30 minutes, a market structure shift on the 1-minute chart (a close through the last swing
//                 against the sweep) on above-average volume
//   Entry         the retest of that shift level within 30 minutes (no chasing; no retest, no trade)
//   Stop          beyond the sweep's extreme, plus a volatility allowance (30% of the typical 15-minute range)
//   Exit          2R target (1.5R also recorded); a 24-hour cap; stop first if both hit in the same minute
//   Fees          0.05% a side (a typical futures taker fee), counted in R
// No parameter is tuned to the data, so the backtest and the live paper trades are the same test, walking forward.
// The report is what the playbook asks for: count, win rate, average R, total R, max drawdown, fees.
import { swings } from './structure.js';

export const PLAY = { fee: 0.0005, confirmMin: 30, retestMin: 30, maxHold: 24 * 60, buffer: 0.3 };
const DAY = 86400000, HOUR = 3600000, M15 = 900000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const firstAt = (bars, t) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; } return lo; }; // first bar at or after t

function hourlyTrend(bars, i) { // the 20-hour average's slope over the last 3 hours, from 1-minute bars up to i
  const closes = [];
  for (let t = Math.floor(bars[i].t / HOUR) * HOUR - 23 * HOUR; t <= bars[i].t; t += HOUR) {
    let c = null;
    for (let j = i; j >= 0 && bars[j].t >= t; j--) if (bars[j].t < t + HOUR) { c = bars[j].c; break; }
    if (c != null) closes.push(c);
  }
  if (closes.length < 23) return 0;
  const ma = (k) => avg(closes.slice(closes.length - 20 - k, closes.length - k));
  const slope = ma(0) - ma(3);
  return slope > 0 ? 1 : slope < 0 ? -1 : 0;
}

// variant: 'day' (yesterday's high/low, as written) or 'hour' (the last hour's high/low: more examples)
export function backtest(bars, { variant = 'day', target = 2 } = {}) {
  const trades = [];
  const idx = new Map(bars.map((b, i) => [b.t, i]));
  let busyUntil = 0;
  for (let s = Math.ceil(bars[0]?.t / M15) * M15; bars.length && s + M15 <= bars.at(-1).t; s += M15) {
    if (s < busyUntil) continue;
    const i0 = idx.get(s), i1 = idx.get(s + M15 - 60000);
    if (i0 == null || i1 == null) continue;
    // the 15-minute candle
    const seg = bars.slice(i0, i1 + 1), h = Math.max(...seg.map((b) => b.h)), l = Math.min(...seg.map((b) => b.l)), c = seg.at(-1).c;
    const from = variant === 'day' ? Math.floor(s / DAY) * DAY - DAY : Math.floor(s / HOUR) * HOUR - HOUR;
    const to = variant === 'day' ? Math.floor(s / DAY) * DAY : Math.floor(s / HOUR) * HOUR;
    const ref = bars.slice(firstAt(bars, from), firstAt(bars, to));
    if (ref.length < (variant === 'day' ? 600 : 45)) continue;
    const refH = Math.max(...ref.map((b) => b.h)), refL = Math.min(...ref.map((b) => b.l));
    let dir = 0, extreme = 0;
    if (l < refL && c > refL) { dir = 1; extreme = l; } else if (h > refH && c < refH) { dir = -1; extreme = h; }
    if (!dir) continue;
    if (hourlyTrend(bars, i1) !== dir) continue; // with the 1-hour trend only
    // confirmation: a structure shift against the sweep, on above-average volume
    let mss = null;
    for (let j = i1 + 1; j < bars.length && bars[j].t <= bars[i1].t + PLAY.confirmMin * 60000; j++) {
      const sw = swings(bars.slice(Math.max(0, j - 60), j), 2), last = dir > 0 ? sw.hi.at(-1) : sw.lo.at(-1);
      const vAvg = avg(bars.slice(Math.max(0, j - 30), j).map((b) => b.v || 0));
      if (last && (dir > 0 ? bars[j].c > last.p : bars[j].c < last.p) && (bars[j].v || 0) > 1.2 * vAvg) { mss = { j, level: last.p }; break; }
    }
    if (!mss) continue;
    // entry: the retest of the shift level
    let entryJ = null;
    for (let j = mss.j + 1; j < bars.length && bars[j].t <= bars[mss.j].t + PLAY.retestMin * 60000; j++) if (dir > 0 ? bars[j].l <= mss.level : bars[j].h >= mss.level) { entryJ = j; break; }
    if (entryJ == null) continue;
    const entry = mss.level, typical15 = avg(bars.slice(Math.max(0, i0 - 16 * 15), i0).map((b, k, a) => (k % 15 === 14 ? Math.max(...a.slice(k - 14, k + 1).map((x) => x.h)) - Math.min(...a.slice(k - 14, k + 1).map((x) => x.l)) : null)).filter((x) => x != null));
    const stop = extreme - dir * PLAY.buffer * (typical15 || Math.abs(entry - extreme));
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const tgt = entry + dir * target * risk;
    let exit = null, exitJ = null;
    for (let j = entryJ; j < bars.length && bars[j].t <= bars[entryJ].t + PLAY.maxHold * 60000; j++) {
      const b = bars[j];
      if (dir > 0 ? b.l <= stop : b.h >= stop) { exit = stop; exitJ = j; break; } // stop first if both in one minute
      if (dir > 0 ? b.h >= tgt : b.l <= tgt) { exit = tgt; exitJ = j; break; }
    }
    if (exit == null) { if (bars.at(-1).t - bars[entryJ].t < PLAY.maxHold * 60000) { trades.push({ t: bars[entryJ].t, dir, entry, stop, target: tgt, open: true }); break; } exitJ = Math.min(bars.length - 1, entryJ + PLAY.maxHold); exit = bars[exitJ].c; }
    const fees = PLAY.fee * (entry + exit) / risk; // in R
    trades.push({ t: bars[entryJ].t, dir, entry, stop, target: tgt, exit, r: (dir * (exit - entry)) / risk - fees, fees, won: dir * (exit - entry) > 0 });
    busyUntil = bars[exitJ].t;
  }
  return trades;
}
// The playbook's scorecard
export function scorecard(trades) {
  const done = trades.filter((t) => !t.open);
  let eq = 0, peak = 0, dd = 0;
  for (const t of done) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n: done.length, open: trades.filter((t) => t.open).length, wins: done.filter((t) => t.won).length, winRate: done.length ? done.filter((t) => t.won).length / done.length : null,
    avgR: done.length ? eq / done.length : null, totalR: eq, maxDD: dd, feesR: done.reduce((a, t) => a + t.fees, 0), needs: Math.max(0, 100 - done.length) };
}
