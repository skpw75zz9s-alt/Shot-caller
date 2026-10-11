// Reversal watch: "how to predict when the market is about to flip" (the BTC 15-minute reversal guide), as code that
// can be measured. Pure; works on 1-minute candles { t, o, h, l, c, v } oldest first, read as 15-minute candles.
//
// The checklist, for a DOWN flip (an UP flip is the mirror image), on the latest closed 15-minute candle:
//   Liquidity sweep and reclaim   3  a candle in the last 45 minutes took out the last swing high and price has
//                                    closed back below it
//   Market structure break        3  since the sweep, a 15-minute close below the latest higher low (swing low)
//   RSI divergence                2  the sweep made a higher high but 15-minute RSI 14 made a lower high
//   Volume confirmation           1  the sweep candle traded 1.5x+ the average volume with little progress (exhaustion)
//   VWAP flip                     1  price got above the day's VWAP in the last hour but closed back below it
//   Open interest confirmation    1  futures open interest dropped 0.5%+ in 5 minutes as price spiked up (a flush);
//                                    live only (there's no open-interest history to backtest)
//   MACD divergence               0  shown, not scored (the guide lists it as a signal, not in its checklist)
// 8-11 strong confluence, 5-7 developing, 0-4 insufficient. The guide calls this scoring hypothetical and
// unvalidated, and its scores are not probabilities, so the bot measures both:
//   bandStudy        after every closed 15-minute candle, did the next 15 minutes (the next Kalshi round: rounds start
//                    when a 15-minute candle closes) and the next hour move the way the score said? per band, vs 50%.
//   flipBacktest     the guide's DOWN/UP flip strategy, step by step: sweep, close back inside, RSI divergence, a
//                    15-minute close through the latest higher low (lower high), then a retest of that level that
//                    gets rejected (entry at that candle's close: wait for a close and retest). Stop beyond the sweep
//                    extreme plus 30% of a typical 15-minute range; target 2R (1.5R also recorded); stop first if
//                    both are hit in one minute; 24-hour cap. Fees 0.05% + spread/slippage 0.02% a side, in R.
//                    The guide asks for 200+ signals before trusting it.
// No parameter is tuned to the data, so the whole history is a fair test.
import { macd, rsiSeries } from './indicators.js';
import { swings } from './structure.js';

export const REV = { lookback: 40, sweepWithin: 3, mssWithin: 4, retestWithin: 4, volMult: 1.5, bodyMax: 0.5, oiDrop: -0.005, buffer: 0.3, cost: 0.0007, maxHold: 24 * 60, need: 200 };
export const POINTS = { sweep: 3, mss: 3, rsiDiv: 2, volume: 1, vwap: 1, oi: 1 };
export const band = (s) => (s >= 8 ? 'strong' : s >= 5 ? 'developing' : 'insufficient');
const M15 = 900000, DAY = 86400000, HOUR = 3600000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// 15-minute candles from 1-minute ones (only complete, clock-aligned ones; 10+ of their minutes present), each with
// the day's VWAP as of its close
export function to15(bars, now = Infinity) {
  const out = [];
  let cur = null, day = null, pv = 0, vol = 0;
  for (const b of bars) {
    const d = Math.floor(b.t / DAY);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = b.v > 0 ? b.v : 0; pv += ((b.h + b.l + b.c) / 3) * v; vol += v;
    const s = Math.floor(b.t / M15) * M15;
    if (!cur || cur.t !== s) { if (cur) out.push(cur); cur = { t: s, o: b.o, h: b.h, l: b.l, c: b.c, v, n: 1, vwap: null }; } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += v; cur.n++; }
    cur.vwap = vol > 0 ? pv / vol : null; cur.last = b.t;
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.n >= 10 && x.t + M15 <= now);
}
// the indicator series the checklist reads, once per candle list
export function prep(B) {
  const closes = B.map((b) => b.c);
  return { B, rsi: rsiSeries(closes, 14), macd: macd(closes, 12, 26, 9).map((m) => m.hist) };
}

// The checklist at candle k for one direction (dir -1: a DOWN flip after a rise, +1: an UP flip after a fall)
export function checklist(P, k, dir, { oi = null } = {}) {
  const { B, rsi, macd: hist } = P, checks = [];
  const add = (key, ok, text) => checks.push({ key, pts: ok ? POINTS[key] : 0, ok, text });
  const lo = Math.max(0, k - REV.lookback), win = B.slice(lo, k + 1);
  // the levels: the last swing high/low that formed before the last sweepWithin candles
  const sw = swings(win.slice(0, -REV.sweepWithin), 2), up = dir < 0; // a DOWN flip looks above
  // the higher low (lower high) to break: the latest swing on the other side, the sweep's own leg included
  const swAll = swings(win, 2), level = (up ? sw.hi : sw.lo).at(-1), opp = (up ? swAll.lo : swAll.hi).at(-1);
  let sweepJ = null;
  if (level) {
    for (let j = Math.max(lo + level.i + 1, k - REV.sweepWithin + 1); j <= k; j++) if (up ? B[j].h > level.p : B[j].l < level.p) { if (sweepJ == null || (up ? B[j].h > B[sweepJ].h : B[j].l < B[sweepJ].l)) sweepJ = j; }
  }
  const reclaimed = sweepJ != null && (up ? B[k].c < level.p : B[k].c > level.p);
  const $ = (p) => `$${Math.round(p).toLocaleString()}`;
  add('sweep', reclaimed, reclaimed ? `swept ${up ? 'above the last swing high' : 'below the last swing low'} (${$(level.p)}) and closed back ${up ? 'below' : 'above'} it` : level ? `no sweep of the last swing ${up ? 'high' : 'low'} (${$(level.p)})` : 'no swing level yet');
  // structure break: since the sweep, a close through the latest higher low (lower high)
  let mss = false;
  if (reclaimed && opp && lo + opp.i < sweepJ) for (let j = sweepJ; j <= k; j++) if (up ? B[j].c < opp.p : B[j].c > opp.p) mss = true;
  add('mss', mss, mss ? `closed ${up ? 'below the latest higher low' : 'above the latest lower high'} (${$(opp.p)})` : `no close ${up ? 'below the latest higher low' : 'above the latest lower high'}${opp ? ` (${$(opp.p)})` : ''}`);
  // RSI divergence: the sweep's extreme vs the swing it took out
  const ext = sweepJ ?? k, prevI = level ? lo + level.i : null;
  const priceBeyond = level && (up ? B[ext].h > level.p : B[ext].l < level.p);
  const rsiDiv = priceBeyond && rsi[ext] != null && rsi[prevI] != null && (up ? rsi[ext] < rsi[prevI] : rsi[ext] > rsi[prevI]);
  add('rsiDiv', !!rsiDiv, rsiDiv ? `${up ? 'higher high' : 'lower low'} in price, ${up ? 'lower high' : 'higher low'} in RSI (${Math.round(rsi[prevI])} → ${Math.round(rsi[ext])})` : 'no RSI divergence');
  // volume: the sweep candle (or the latest) on 1.5x+ volume with little progress
  const vb = B[ext], vAvg = avg(B.slice(Math.max(0, ext - 20), ext).map((b) => b.v)), range = vb.h - vb.l;
  const volOk = vAvg > 0 && vb.v >= REV.volMult * vAvg && range > 0 && Math.abs(vb.c - vb.o) <= REV.bodyMax * range;
  add('volume', volOk, volOk ? `${(vb.v / vAvg).toFixed(1)}× average volume with little progress (exhaustion)` : 'no exhaustion volume');
  // VWAP flip: got through the day's VWAP in the last hour, closed back on the other side
  const vw = B[k].vwap, crossed = vw != null && B.slice(Math.max(0, k - 3), k + 1).some((b) => (up ? b.h > b.vwap : b.l < b.vwap));
  const vwapOk = crossed && (up ? B[k].c < vw : B[k].c > vw);
  add('vwap', vwapOk, vwapOk ? `${up ? 'lost' : 'reclaimed'} the day's VWAP (${$(vw)})` : 'no VWAP flip');
  // open interest: a flush into the move (live only)
  if (oi) {
    const ok = oi.oiChange5 != null && oi.priceChange5 != null && oi.oiChange5 <= REV.oiDrop && (up ? oi.priceChange5 > 0 : oi.priceChange5 < 0);
    add('oi', ok, ok ? `futures open interest fell ${(Math.abs(oi.oiChange5) * 100).toFixed(1)}% in 5 min as price ${up ? 'rose' : 'fell'} (positions flushed)` : 'no open-interest flush');
  }
  // MACD divergence (shown, not scored)
  const macdDiv = priceBeyond && hist[ext] != null && hist[prevI] != null && (up ? hist[ext] < hist[prevI] : hist[ext] > hist[prevI]);
  const score = checks.reduce((a, c) => a + c.pts, 0);
  return { dir: up ? 'down' : 'up', score, band: band(score), checks, macdDiv: !!macdDiv, level: level?.p ?? null, broken: opp?.p ?? null, sweepJ, extreme: sweepJ != null ? (up ? B[sweepJ].h : B[sweepJ].l) : null };
}

// The checklist right now, both ways (the server passes the futures context for the open-interest point)
export function reversalNow(bars, { now = Date.now(), oi = null } = {}) {
  const B = to15(bars, now);
  if (B.length < 30) return null;
  const P = prep(B), k = B.length - 1;
  const down = checklist(P, k, -1, { oi }), up = checklist(P, k, 1, { oi });
  const best = down.score > up.score ? down : up.score > down.score ? up : null;
  const r = B.slice(-41).map((b, i, a) => (i ? Math.log(b.c / a[i - 1].c) : 0)).slice(1), sd15 = Math.sqrt(avg(r.map((x) => x * x))) || null;
  return { at: B[k].t + M15, max: oi ? 11 : 10, down, up, best, sd15 };
}

// ---- does the score predict the flip? ----
// After each closed 15-minute candle with a clear side (one side's score above the other's), the move over the next
// 15 minutes and the next hour, signed so + = the way the score said, in typical 15-minute moves
export function bandStudy(bars) {
  const B = to15(bars), P = prep(B), rows = { insufficient: [], developing: [], strong: [] };
  const r = B.map((b, i) => (i ? Math.log(b.c / B[i - 1].c) : 0));
  for (let k = 40; k + 4 < B.length; k++) {
    if (B[k + 1].t !== B[k].t + M15 || B[k + 4].t !== B[k].t + 4 * M15) continue; // complete next hour only
    const d = checklist(P, k, -1), u = checklist(P, k, 1);
    if (d.score === u.score) continue;
    const c = d.score > u.score ? d : u, sgn = c.dir === 'up' ? 1 : -1;
    const sd = Math.sqrt(avg(r.slice(k - 39, k + 1).map((x) => x * x))) || 1e-4;
    rows[c.band].push({ y15: sgn * Math.log(B[k + 1].c / B[k].c) / sd, y60: sgn * Math.log(B[k + 4].c / B[k].c) / (sd * 2) });
  }
  const sum = (xs) => {
    const n = xs.length, hit = (f) => (n ? xs.filter((x) => x[f] > 0).length / n : null);
    const z = (f) => { if (n < 2) return 0; const m = avg(xs.map((x) => x[f])), s = Math.sqrt(avg(xs.map((x) => (x[f] - m) ** 2)) * n / (n - 1)); return s > 0 ? (m / s) * Math.sqrt(n) : 0; };
    return { n, hit15: hit('y15'), hit60: hit('y60'), mean15: n ? avg(xs.map((x) => x.y15)) : 0, z15: z('y15'), z60: z('y60') };
  };
  return Object.fromEntries(Object.entries(rows).map(([k, xs]) => [k, sum(xs)]));
}
// A band is proven for the next round when it beat a coin flip with z >= 2.5 on 100+ signals (only developing and
// strong can reach the calls: the guide calls 0-4 insufficient confirmation)
export const bandProven = (s) => !!s && s.n >= 100 && s.z15 >= 2.5;

// For the bot's calls: a proven band's measured move over the next round, for the round that opened as the signal
// candle closed. Spread over the minutes left (the move so far is already in the price), as a P(YES) shift capped at
// +-4 points. Unproven bands add nothing.
export function reversalShift(now, study, { spot, strike, sigmaMin, minutesLeft, strikeType = 'greater', openTime }) {
  const b = now?.best, s = b ? study?.[b.band] : null;
  if (!b || b.band === 'insufficient' || !bandProven(s) || now.at !== openTime || !(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0) || !(now.sd15 > 0)) return 0;
  const move = (b.dir === 'up' ? 1 : -1) * s.mean15 * (s.n / (s.n + 100)) * now.sd15 * spot * Math.min(1, minutesLeft / 15);
  const sd = spot * sigmaMin * Math.sqrt(minutesLeft), ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const shift = ncdf((spot + move - strike) / sd) - ncdf((spot - strike) / sd);
  return Math.min(0.04, Math.max(-0.04, /^less/.test(strikeType || '') ? -shift : shift));
}
function erf(x) { // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// ---- the guide's flip strategy, backtested ----
function hourTrend(bars1, t) { // the 20-hour average's slope over 3 hours, from 1-minute bars up to time t
  const closes = [];
  let j = bars1.length - 1;
  while (j >= 0 && bars1[j].t > t) j--;
  for (let h = 23; h >= 0 && j >= 0; h--) {
    const end = Math.floor(t / HOUR) * HOUR - h * HOUR + HOUR;
    let c = null;
    for (let x = j; x >= 0 && bars1[x].t >= end - HOUR; x--) if (bars1[x].t < end) { c = bars1[x].c; break; }
    if (c != null) closes.push(c);
  }
  if (closes.length < 23) return 0;
  const ma = (s) => avg(closes.slice(closes.length - 20 - s, closes.length - s));
  return Math.sign(ma(0) - ma(3));
}
const firstAt = (bars, t) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; } return lo; };

export function flipBacktest(bars, { target = 2, needRsi = true } = {}) {
  const B = to15(bars), P = prep(B), trades = [];
  let busyUntil = 0;
  for (let k = 40; k < B.length; k++) {
    if (B[k].t < busyUntil) continue;
    for (const dir of [-1, 1]) {
      const c = checklist(P, k, dir), up = dir < 0;
      // steps 1-3: a sweep that closed back inside at THIS candle (the first close back), with RSI divergence
      if (!c.checks[0].ok || c.extreme == null || c.broken == null) continue;
      // only once per sweep: the sweep candle is this one, or the last one closed beyond the level and this one closed back
      if (!(c.sweepJ === k || (c.sweepJ === k - 1 && (up ? B[k - 1].c >= c.level : B[k - 1].c <= c.level)))) continue;
      if (needRsi && !c.checks.find((x) => x.key === 'rsiDiv').ok) continue;
      // step 4: a close through the latest higher low (lower high), within mssWithin candles (this one included)
      let b = null;
      for (let j = k; j < Math.min(B.length, k + REV.mssWithin + 1); j++) if (up ? B[j].c < c.broken : B[j].c > c.broken) { b = j; break; }
      if (b == null) continue;
      // step 5: the retest: a later candle reaches back to the broken level and closes rejected (entry at its close)
      let r = null;
      for (let j = b + 1; j < Math.min(B.length, b + REV.retestWithin + 1); j++) if (up ? B[j].h >= c.broken && B[j].c < c.broken : B[j].l <= c.broken && B[j].c > c.broken) { r = j; break; }
      if (r == null) continue;
      const entryT = B[r].t + M15, entry = B[r].c, side = up ? -1 : 1;
      const typical = avg(B.slice(Math.max(0, k - 20), k).map((x) => x.h - x.l));
      const span = B.slice(k - REV.sweepWithin + 1, r + 1); // the sweep's extreme (and anything beyond it before entry)
      const stop = up ? Math.max(...span.map((x) => x.h)) + REV.buffer * typical : Math.min(...span.map((x) => x.l)) - REV.buffer * typical, risk = Math.abs(stop - entry);
      if (!(risk > 0)) continue;
      const tgt = entry + side * target * risk;
      let exit = null, exitT = null;
      for (let j = firstAt(bars, entryT); j < bars.length && bars[j].t < entryT + REV.maxHold * 60000; j++) {
        const x = bars[j];
        if (up ? x.h >= stop : x.l <= stop) { exit = stop; exitT = x.t; break; }
        if (up ? x.l <= tgt : x.h >= tgt) { exit = tgt; exitT = x.t; break; }
      }
      const trend = hourTrend(bars, entryT);
      if (exit == null) {
        if (bars.at(-1).t - entryT < REV.maxHold * 60000) { trades.push({ t: entryT, dir: up ? 'down' : 'up', entry, stop, target: tgt, open: true, score: c.score }); busyUntil = Infinity; break; }
        const j = Math.min(bars.length - 1, firstAt(bars, entryT + REV.maxHold * 60000) - 1); exit = bars[j].c; exitT = bars[j].t;
      }
      const fees = REV.cost * (entry + exit) / risk;
      trades.push({ t: entryT, dir: up ? 'down' : 'up', entry, stop, target: tgt, exit, r: side * (exit - entry) / risk - fees, fees, won: side * (exit - entry) > 0, score: c.score, withTrend: trend === side, againstTrend: trend === -side });
      busyUntil = exitT;
      break;
    }
  }
  return trades;
}
