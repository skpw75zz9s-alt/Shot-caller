// Deeper analysis behind each call:
//   rejections() – how price has behaved around the target inside the current 15-minute window
//   deepDive()   – a multi-factor confidence score for a call, with the reasoning behind it
import { atr } from './candles.js';
import { kalshiFee } from './model.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const usd0 = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

// Rejection trends within the window that opened at `openTime`.
//   strike-cap   – wicked up to the target and closed back below it (sellers defending it: bearish)
//   strike-floor – wicked down to the target and closed back above it (buyers defending it: bullish)
//   high-reject  – retested the window high and got pushed back down (bearish)
//   low-hold     – retested the window low and bounced (bullish)
// Rejections only count while they still hold: once price closes through the target, the old caps
// (or floors) are broken, which counts the other way.
export function rejections(bars, strike, openTime, now = Date.now()) {
  const empty = { events: [], strikeCaps: 0, strikeFloors: 0, highRejects: 0, lowHolds: 0, crosses: 0, wickBias: 0, structure: 'forming', tilt: 0, bias: 'neutral', summary: [], broken: null };
  if (!strike || !openTime) return empty;
  const win = bars.filter((b) => b.t >= openTime);
  const closed = win.filter((b) => b.t + 60000 <= now);
  if (closed.length < 2) return { ...empty, summary: ['Window just opened: watching for rejections'] };

  const a = atr(bars.filter((b) => b.t + 60000 <= now)) || strike * 0.0005;
  const tol = Math.max(a * 0.15, strike * 0.00002);
  const wickMin = a * 0.2;
  const events = [];
  let runHigh = -Infinity, runLow = Infinity, runHighAt = -1, runLowAt = -1, crosses = 0, upper = 0, lower = 0;

  closed.forEach((b, i) => {
    const top = Math.max(b.o, b.c), bot = Math.min(b.o, b.c);
    upper += b.h - top;
    lower += bot - b.l;
    const cap = b.h >= strike - tol && top < strike && b.h - top >= wickMin;
    const floor = b.l <= strike + tol && bot > strike && bot - b.l >= wickMin;
    if (cap) events.push({ type: 'strike-cap', t: b.t, price: b.h, dir: -1, wick: b.h - top });
    if (floor) events.push({ type: 'strike-floor', t: b.t, price: b.l, dir: 1, wick: bot - b.l });
    // Retests of the window's extremes (needs a candle in between; a target rejection on the same wick wins)
    if (!cap && i - runHighAt >= 2 && Math.abs(b.h - runHigh) <= tol * 2 && b.h - top >= wickMin) events.push({ type: 'high-reject', t: b.t, price: b.h, dir: -1, wick: b.h - top });
    if (!floor && i - runLowAt >= 2 && Math.abs(b.l - runLow) <= tol * 2 && bot - b.l >= wickMin) events.push({ type: 'low-hold', t: b.t, price: b.l, dir: 1, wick: bot - b.l });
    if (b.h > runHigh + tol) { runHigh = b.h; runHighAt = i; }
    if (b.l < runLow - tol) { runLow = b.l; runLowAt = i; }
    if (i && (closed[i - 1].c - strike) * (b.c - strike) < 0) crosses++;
  });

  const spot = win[win.length - 1].c;
  const above = spot > strike + tol, below = spot < strike - tol;
  const count = (type) => events.filter((e) => e.type === type).length;
  let strikeCaps = count('strike-cap'), strikeFloors = count('strike-floor');
  let broken = null;
  if (strikeCaps && above) { broken = 'caps'; strikeCaps = 0; }
  if (strikeFloors && below) { broken = 'floors'; strikeFloors = 0; }
  const live = events.filter((e) => !((broken === 'caps' && e.type === 'strike-cap') || (broken === 'floors' && e.type === 'strike-floor')));

  // Structure: compare the two halves of the window
  const half = Math.floor(closed.length / 2);
  let structure = 'forming';
  if (half >= 2) {
    const [h1, h2] = [closed.slice(0, half), closed.slice(half)];
    const hi1 = Math.max(...h1.map((b) => b.h)), hi2 = Math.max(...h2.map((b) => b.h));
    const lo1 = Math.min(...h1.map((b) => b.l)), lo2 = Math.min(...h2.map((b) => b.l));
    const up = hi2 > hi1 + tol, dnH = hi2 < hi1 - tol, upL = lo2 > lo1 + tol, dnL = lo2 < lo1 - tol;
    structure = up && upL ? 'higher highs & lows' : dnH && dnL ? 'lower highs & lows' : dnH && upL ? 'squeezing' : upL ? 'higher lows' : dnH ? 'lower highs' : 'ranging';
  }
  // Wick pressure only counts when the wicks are real moves, not cent-wide ticks on a frozen tape
  const wickBias = upper + lower > a * 0.5 ? (lower - upper) / (upper + lower) : 0;
  const ratio = (x, y) => (y < a * 0.05 ? 'far longer than' : `${(x / y).toFixed(1)}×`);

  // Two decent rejections in a row, same direction: price tends to go the other way (the user's rule).
  // A rejection candle pokes at (or near) the window's high or low and closes well back: a wick of at least 0.35 x ATR
  // and about as long as its body. The last two rejection candles must point the same way, at about the same level
  // (within half an ATR), 2-12 minutes apart, the second in the last ~5 minutes, and the level must still hold.
  let double = null;
  {
    const rejs = [];
    let hi = -Infinity, lo = Infinity;
    for (const b of closed) {
      const top = Math.max(b.o, b.c), bot = Math.min(b.o, b.c), body = top - bot;
      const up = b.h - top, dn = bot - b.l;
      if (up >= a * 0.35 && up >= body * 0.8 && b.h >= Math.max(hi, b.h) - a * 0.5 && up >= dn) rejs.push({ t: b.t, dir: -1, price: b.h });
      else if (dn >= a * 0.35 && dn >= body * 0.8 && b.l <= Math.min(lo, b.l) + a * 0.5 && dn > up) rejs.push({ t: b.t, dir: 1, price: b.l });
      hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    }
    if (rejs.length >= 2) {
      const e2 = rejs[rejs.length - 1], e1 = rejs[rejs.length - 2], gap = e2.t - e1.t;
      if (e1.dir === e2.dir && Math.abs(e1.price - e2.price) <= a * 0.5 && gap >= 2 * 60000 && gap <= 12 * 60000 && now - e2.t <= 5 * 60000) {
        const level = e2.dir < 0 ? Math.max(e1.price, e2.price) : Math.min(e1.price, e2.price);
        const holds = closed.filter((b) => b.t >= e1.t).every((b) => (e2.dir < 0 ? b.c < level : b.c > level));
        if (holds) double = { dir: e2.dir, price: level, at: e2.t, label: e2.dir < 0 ? `Two rejections in a row at ${usd0(level)}: expect down` : `Two rejections in a row at ${usd0(level)}: expect up` };
      }
    }
  }

  // Score: recent events weigh more; a broken level counts for the breakout side
  let score = double ? double.dir * 2 : 0;
  for (const e of live) {
    const recent = now - e.t <= 5 * 60000 ? 1 : 0.5;
    score += e.dir * recent * (e.type.startsWith('strike') ? 1 : 0.5);
  }
  if (broken === 'caps') score += 1;
  if (broken === 'floors') score -= 1;
  score += wickBias * 0.8;
  if (/higher highs|higher lows/.test(structure)) score += 0.5;
  if (/lower highs/.test(structure)) score -= 0.5;
  const tilt = clamp(score * 0.012, -0.05, 0.05);
  const bias = tilt > 0.008 ? 'bullish' : tilt < -0.008 ? 'bearish' : 'neutral';

  const summary = [];
  if (strikeCaps) summary.push(`Target ${usd0(strike)} rejected ${strikeCaps}× from below: sellers capping it`);
  if (strikeFloors) summary.push(`Target ${usd0(strike)} held ${strikeFloors}× as support: buyers defending it`);
  if (broken === 'caps') summary.push('Broke up through the target after rejections: breakout');
  if (broken === 'floors') summary.push('Broke down through the target after holding: breakdown');
  if (count('high-reject')) summary.push(`Window high ${usd0(runHigh)} rejected ${count('high-reject')}×`);
  if (count('low-hold')) summary.push(`Window low ${usd0(runLow)} held ${count('low-hold')}×`);
  if (Math.abs(wickBias) > 0.25) summary.push(wickBias > 0 ? `Buyers absorbing dips (lower wicks ${ratio(lower, upper)} upper)` : `Sellers hitting rallies (upper wicks ${ratio(upper, lower)} lower)`);
  if (crosses >= 3) summary.push(`Chopping around the target (${crosses} crosses)`);
  if (structure !== 'forming' && structure !== 'ranging') summary.push(`Structure: ${structure}`);
  if (double) summary.unshift(double.label);
  if (!summary.length) summary.push('No clear rejections yet this window');

  return { double, events: live, strikeCaps, strikeFloors, highRejects: count('high-reject'), lowHolds: count('low-hold'), crosses, wickBias, structure, tilt, bias, summary, broken, windowHigh: runHigh, windowLow: runLow };
}

// A fresh rejection against `side` in the last two closed candles (used as a sell warning).
export function freshRejection(rej, side, now = Date.now()) {
  const against = side === 'YES' ? -1 : 1;
  const e = [...(rej?.events || [])].reverse().find((x) => x.dir === against && now - x.t <= 3 * 60000);
  if (!e) return null;
  return { 'strike-cap': 'Rejected at the target', 'strike-floor': 'Target held as support', 'high-reject': 'Rejected at the window high', 'low-hold': 'Bounced off the window low' }[e.type];
}

// Change in a side's Kalshi ask over the last `secs` seconds, from a log of { t, yesAsk, noAsk }.
export function quoteTrend(log, side, now = Date.now(), secs = 120) {
  if (!log?.length) return null;
  const k = side === 'YES' ? 'yesAsk' : 'noAsk';
  const last = log[log.length - 1];
  const past = log.find((q) => q.t >= now - secs * 1000 && q[k] != null);
  return past && last[k] != null && last.t - past.t >= 30000 ? last[k] - past[k] : null;
}

// Log return over the last `mins` 1-minute bars.
function ret(bars, mins) {
  const n = bars?.length || 0;
  return n > mins && bars[n - 1 - mins].c > 0 ? Math.log(bars[n - 1].c / bars[n - 1 - mins].c) : null;
}

// Display tint for a confidence score (color only; the number is what's shown).
export const confTier = (score) => (score >= 85 ? 'hi' : score >= 70 ? 'mid' : 'lo');
// Confidence ranges used to group results in History.
export const confBucket = (score) => (score >= 90 ? '90+' : score >= 80 ? '80–89' : score >= 70 ? '70–79' : 'under 70');

// Confidence for a call on `side` = its win odds: the chance the side settles in the money, from the bot's price
// model at the most cautious of three volatility guesses (`winProb`). Tested on ~65,000 simulated calls, those odds
// matched how often calls really won (calls given 80-90% won 82-83% of the time), while the old points score
// (start at 50, add or subtract per factor) predicted wins worse than the odds alone. The factor checks below are
// still listed as the reasons behind a call (`points`), and many red flags at once still halve the bet size.
// `log` is this market's recent history [{ t, p (bot P(YES)), yesAsk, noAsk }] used for the
// stability, odds-trend and edge-persistence checks; `bars` are 1-minute candles.
export function deepDive({ winProb = null, ev, side, rej, timing, sigmaMin, sigmaLong, driftMin, spot, strike, kalshiDrift, bars, log, now = Date.now(), minEdge = 0.04, stressEdge = null }) {
  if (!side || ev.pYes == null) return null;
  const s = side === 'YES' ? 1 : -1;
  const checks = [];
  let score = 50;
  const add = (pts, label) => { pts = Math.round(pts); score += pts; checks.push({ pts, ok: pts > 0 ? true : pts < 0 ? false : null, label }); };

  const edge = side === 'YES' ? ev.evYes : ev.evNo;
  if (edge != null) add(clamp(edge * 200, -20, 25), `Edge ${(edge * 100).toFixed(1)} pts after fees`);

  if (rej?.double) add(rej.double.dir === s ? 10 : -15, rej.double.dir === s ? `${rej.double.label} (with ${side})` : `${rej.double.label} (against ${side})`);
  const rt = (rej?.tilt || 0) * s;
  if (rt > 0.008) add(10, `Rejections favor ${side}: ${rej.summary[0]}`);
  else if (rt < -0.008) add(-15, `Rejections against ${side}: ${rej.summary[0]}`);
  else add(0, 'Rejection trend neutral');

  // Trend on several timeframes (falls back to 10-min momentum without candles)
  const rs = [3, 10, 30].map((m) => ret(bars, m)).filter((r) => r != null && r !== 0);
  if (rs.length >= 2) {
    const agree = rs.filter((r) => r * s > 0).length, against = rs.length - agree;
    if (!against) add(8, `Trend lines up with ${side} on 3/10/30 min`);
    else if (!agree) add(-8, `Trend is against ${side} on 3/10/30 min`);
    else add(agree > against ? 3 : -3, agree > against ? 'Trend mostly with you' : 'Trend mostly against you');
  } else if (driftMin) add(driftMin * s > 0 ? 6 : -6, driftMin * s > 0 ? '10-min momentum is with you' : '10-min momentum is against you');

  // How the bot's own read has behaved: steady or flipping, building or fading, edge lasting or a blip
  const sideP = (e) => (side === 'YES' ? e.p : 1 - e.p);
  const recent = (log || []).filter((e) => e.p != null && now - e.t <= 180000);
  let botDelta = null; // change in the bot's own odds for this side over ~2 min
  if (recent.length >= 10) {
    const share = recent.filter((e) => sideP(e) >= 0.5).length / recent.length;
    if (share >= 0.9) add(6, `Bot has favored ${side} for 3 min straight`);
    else if (share < 0.6) add(-8, 'Bot\'s read keeps flipping');
    const twoMin = recent.filter((e) => now - e.t <= 120000);
    if (twoMin.length >= 5) {
      // Average the first and last few readings so a single noisy tick can't fake (or hide) a trend
      const k = Math.max(1, Math.floor(twoMin.length / 5));
      const avg = (xs) => xs.reduce((a, e) => a + sideP(e), 0) / xs.length;
      const delta = avg(twoMin.slice(-k)) - avg(twoMin.slice(0, k));
      botDelta = delta;
      if (delta >= 0.05) add(4, `Odds building toward ${side} (+${(delta * 100).toFixed(0)} pts in 2 min)`);
      else if (delta <= -0.05) add(-6, `Odds fading (−${(-delta * 100).toFixed(0)} pts in 2 min)`);
    }
    const askKey = side === 'YES' ? 'yesAsk' : 'noAsk';
    const last30 = recent.filter((e) => now - e.t <= 30000 && e[askKey] != null);
    if (last30.length >= 5) {
      const held = last30.every((e) => sideP(e) - e[askKey] - kalshiFee(e[askKey]) >= minEdge);
      add(held ? 4 : -3, held ? 'Edge has held for 30+ seconds' : 'Edge just appeared: could be a stale quote');
    }
  }

  if (timing) {
    if (timing.state === 'NOW') add(8, 'Candles show a dip to buy');
    else if (timing.state === 'CHASE') add(-10, 'Chasing: price just ran');
  }

  if (sigmaMin && spot && strike && ev.minutesLeft > 0) {
    const z = Math.log(spot / strike) / (sigmaMin * Math.sqrt(Math.max(ev.minutesLeft, 0.25)));
    const zs = z * s;
    if (zs > 1.5) add(10, `BTC well on your side (${zs.toFixed(1)}σ)`);
    else if (zs > 1) add(6, `BTC already on your side by ${zs.toFixed(1)}σ`);
    else if (zs < -1.5) add(-8, `BTC needs a ${(-zs).toFixed(1)}σ move to win`);
    else add(0, `BTC ${Math.abs(z).toFixed(1)}σ from the target`);
  }

  if (sigmaMin && sigmaLong) {
    const r = sigmaMin / sigmaLong;
    if (r > 1.8) add(-8, `Volatility spiking (${r.toFixed(1)}× normal): model less reliable`);
    else if (r < 0.6) add(4, 'Calm tape: model more reliable');
  }

  if (ev.minutesLeft < 3) add(5, 'Late in the window: model most accurate');

  const q = ev.quote;
  if (q.yesBid != null && q.yesAsk != null) {
    const spr = q.yesAsk - q.yesBid;
    if (spr <= 0.02) add(3, 'Tight Kalshi spread');
    else if (spr >= 0.06) add(-5, `Wide Kalshi spread (${(spr * 100).toFixed(0)} pts)`);
  }

  // Kalshi's price for this side dropping is usually what makes the "low", so it only counts against
  // the call when the bot's own odds are fading too (then the market likely knows something).
  if (kalshiDrift != null && Math.abs(kalshiDrift) >= 0.03) {
    if (kalshiDrift > 0) add(3, `Kalshi catching up to the bot (+${(kalshiDrift * 100).toFixed(0)} pts in 2 min)`);
    else if (botDelta != null && botDelta <= -0.02) add(-5, `Kalshi and the bot both moving against the call (${(kalshiDrift * 100).toFixed(0)} pts in 2 min)`);
    else add(0, `Kalshi dipped ${(-kalshiDrift * 100).toFixed(0)} pts while the bot's odds held: that's the low`);
  }

  // Stress test: re-price with 25% more volatility and no momentum/rejection tilt. A thinner edge is
  // normal under stress; only an edge that clearly flips negative counts against the call.
  if (stressEdge != null) {
    if (stressEdge >= minEdge) add(6, `Edge holds under a stress test (+${(stressEdge * 100).toFixed(1)} pts with 25% more volatility)`);
    else if (stressEdge > 0) add(2, `Edge survives a stress test (+${(stressEdge * 100).toFixed(1)} pts)`);
    else if (stressEdge < -0.02) add(-4, 'Edge flips negative under a stress test: depends on optimistic assumptions');
    else add(0, 'Edge thins out under a stress test');
  }

  const points = clamp(Math.round(score), 0, 100);
  if (winProb == null) return { score: points, points, sizeMult: points < 45 ? 0 : clamp(0.5 + (points - 45) / 60, 0.5, 1), checks };
  const odds = clamp(Math.round(winProb * 100), 0, 100);
  checks.unshift({ pts: 0, ok: odds >= 50, label: `Wins about ${odds} times in 100 (bot's odds, most cautious volatility guess)` });
  return { score: odds, points, sizeMult: points < 35 ? 0.5 : 1, checks };
}

// Market stability, 0-100: how settled the tape is right now, so the bot can tell a calm market (where its odds are
// most trustworthy) from a jumpy one (where the volatility it measured may already be stale). Each part subtracts:
//   volatility spike  1-minute vol vs its 2-hour norm
//   shock candle      a candle in the last 10 minutes far bigger than the usual one
//   whipsaw           the bot's own odds crossing 50/50, or swinging a lot, over the last 3 minutes
//   Kalshi jumps      the contract's price jumping 6¢+ between quotes
//   busier ahead      the learned volatility for the coming minutes vs the last half hour (time-of-week)
// level: 'stable' (70+), 'moderate' (45-69), 'unstable' (under 45), or 'unknown' without enough candles.
export const STABILITY_LEVELS = { stable: 70, moderate: 45 };
export function stability({ bars = [], sigmaMin = null, sigmaLong = null, log = [], now = Date.now(), aheadFactor = 1 }) {
  const closed = bars.filter((b) => b.t + 60000 <= now);
  if (closed.length < 20) return { score: null, level: 'unknown', parts: [] };
  const parts = [];
  const hit = (pts, label) => { pts = Math.round(pts); if (pts > 0) parts.push({ pts: -pts, label }); return pts; };
  let pen = 0;
  if (sigmaMin && sigmaLong) {
    const r = sigmaMin / sigmaLong;
    pen += hit(clamp((r - 1.15) / (2.2 - 1.15), 0, 1) * 35, `Volatility ${r.toFixed(1)}× its 2-hour norm`);
  }
  const ranges = closed.slice(-60).map((b) => b.h - b.l).sort((a, b) => a - b);
  const med = ranges[Math.floor(ranges.length / 2)];
  if (med > 0) {
    const big = Math.max(...closed.slice(-10).map((b) => b.h - b.l)) / med;
    pen += hit(clamp((big - 2.5) / (5 - 2.5), 0, 1) * 25, `A ${big.toFixed(1)}× candle in the last 10 minutes`);
  }
  const recent = (log || []).filter((e) => e.p != null && now - e.t <= 180000);
  if (recent.length >= 10) {
    let crosses = 0;
    for (let i = 1; i < recent.length; i++) if ((recent[i].p >= 0.5) !== (recent[i - 1].p >= 0.5)) crosses++;
    pen += hit(Math.min(25, crosses * 10), `Bot's odds crossed 50/50 ${crosses} time${crosses === 1 ? '' : 's'} in 3 min`);
    const ps = recent.map((e) => e.p), swing = Math.max(...ps) - Math.min(...ps);
    pen += hit(clamp((swing - 0.2) / 0.3, 0, 1) * 15, `Bot's odds swung ${Math.round(swing * 100)} pts in 3 min`);
    let jumps = 0;
    for (let i = 1; i < recent.length; i++) for (const k of ['yesAsk', 'noAsk']) if (recent[i][k] != null && recent[i - 1][k] != null && Math.abs(recent[i][k] - recent[i - 1][k]) >= 0.06 - 1e-9) { jumps++; break; }
    pen += hit(Math.min(15, jumps * 5), `Kalshi's price jumped ${jumps} time${jumps === 1 ? '' : 's'} in 3 min`);
  }
  if (aheadFactor > 1.2) pen += hit(clamp((aheadFactor - 1.2) / 0.3, 0, 1) * 10, `The next minutes are usually ${aheadFactor.toFixed(1)}× busier at this time of week`);
  const score = clamp(Math.round(100 - pen), 0, 100);
  const level = score >= STABILITY_LEVELS.stable ? 'stable' : score >= STABILITY_LEVELS.moderate ? 'moderate' : 'unstable';
  return { score, level, parts };
}
