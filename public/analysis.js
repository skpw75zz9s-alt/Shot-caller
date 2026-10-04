// Deeper analysis behind each call:
//   rejections() – how price has behaved around the target inside the current 15-minute window
//   deepDive()   – a multi-factor confidence score for a call, with the reasoning behind it
import { atr } from './candles.js';

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
    if (cap) events.push({ type: 'strike-cap', t: b.t, price: b.h, dir: -1 });
    if (floor) events.push({ type: 'strike-floor', t: b.t, price: b.l, dir: 1 });
    // Retests of the window's extremes (needs a candle in between; a target rejection on the same wick wins)
    if (!cap && i - runHighAt >= 2 && Math.abs(b.h - runHigh) <= tol * 2 && b.h - top >= wickMin) events.push({ type: 'high-reject', t: b.t, price: b.h, dir: -1 });
    if (!floor && i - runLowAt >= 2 && Math.abs(b.l - runLow) <= tol * 2 && bot - b.l >= wickMin) events.push({ type: 'low-hold', t: b.t, price: b.l, dir: 1 });
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
  const wickBias = upper + lower > 0 ? (lower - upper) / (upper + lower) : 0;

  // Score: recent events weigh more; a broken level counts for the breakout side
  let score = 0;
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
  if (Math.abs(wickBias) > 0.25) summary.push(wickBias > 0 ? `Buyers absorbing dips (lower wicks ${(lower / Math.max(upper, 1e-9)).toFixed(1)}× upper)` : `Sellers hitting rallies (upper wicks ${(upper / Math.max(lower, 1e-9)).toFixed(1)}× lower)`);
  if (crosses >= 3) summary.push(`Chopping around the target (${crosses} crosses)`);
  if (structure !== 'forming' && structure !== 'ranging') summary.push(`Structure: ${structure}`);
  if (!summary.length) summary.push('No clear rejections yet this window');

  return { events: live, strikeCaps, strikeFloors, highRejects: count('high-reject'), lowHolds: count('low-hold'), crosses, wickBias, structure, tilt, bias, summary, broken, windowHigh: runHigh, windowLow: runLow };
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

// Multi-factor confidence for a call on `side`. Starts at 50 and adds or subtracts per factor.
export function deepDive({ ev, side, rej, timing, sigmaMin, sigmaLong, driftMin, spot, strike, kalshiDrift }) {
  if (!side || ev.pYes == null) return null;
  const s = side === 'YES' ? 1 : -1;
  const checks = [];
  let score = 50;
  const add = (pts, label) => { pts = Math.round(pts); score += pts; checks.push({ pts, ok: pts > 0 ? true : pts < 0 ? false : null, label }); };

  const edge = side === 'YES' ? ev.evYes : ev.evNo;
  if (edge != null) add(clamp(edge * 200, -20, 25), `Edge ${(edge * 100).toFixed(1)} pts after fees`);

  const rt = (rej?.tilt || 0) * s;
  if (rt > 0.008) add(10, `Rejections favor ${side}: ${rej.summary[0]}`);
  else if (rt < -0.008) add(-15, `Rejections against ${side}: ${rej.summary[0]}`);
  else add(0, 'Rejection trend neutral');

  if (driftMin) add(driftMin * s > 0 ? 6 : -6, driftMin * s > 0 ? '10-min momentum is with you' : '10-min momentum is against you');

  if (timing) {
    if (timing.state === 'NOW') add(8, 'Candles show a dip to buy');
    else if (timing.state === 'CHASE') add(-10, 'Chasing: price just ran');
  }

  if (sigmaMin && spot && strike && ev.minutesLeft > 0) {
    const z = Math.log(spot / strike) / (sigmaMin * Math.sqrt(Math.max(ev.minutesLeft, 0.25)));
    const zs = z * s;
    if (zs > 1) add(8, `BTC already on your side by ${zs.toFixed(1)}σ`);
    else if (zs < -1.5) add(-8, `BTC needs a ${(-zs).toFixed(1)}σ move to win`);
    else add(0, `BTC ${Math.abs(z).toFixed(1)}σ from the target`);
  }

  if (sigmaMin && sigmaLong) {
    const r = sigmaMin / sigmaLong;
    if (r > 1.8) add(-8, `Volatility spiking (${r.toFixed(1)}× normal): model less reliable`);
    else if (r < 0.6) add(4, 'Calm tape: model more reliable');
  }

  if (ev.minutesLeft < 3) add(5, 'Late in the window: model most accurate');
  else if (ev.minutesLeft > 11) add(-5, 'Early in the window: lots can change');

  const q = ev.quote;
  if (q.yesBid != null && q.yesAsk != null) {
    const spr = q.yesAsk - q.yesBid;
    if (spr <= 0.02) add(3, 'Tight Kalshi spread');
    else if (spr >= 0.06) add(-5, `Wide Kalshi spread (${(spr * 100).toFixed(0)} pts)`);
  }

  if (kalshiDrift != null && Math.abs(kalshiDrift) >= 0.03) {
    if (kalshiDrift < 0) add(-5, `Kalshi moving against the call (${(kalshiDrift * 100).toFixed(0)} pts in 2 min)`);
    else add(3, `Kalshi catching up to the bot (+${(kalshiDrift * 100).toFixed(0)} pts in 2 min)`);
  }

  score = clamp(Math.round(score), 0, 100);
  const grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';
  const verdict = { A: 'Strong call', B: 'Good call', C: 'Marginal: size down', D: 'Weak: skip' }[grade];
  const sizeMult = { A: 1, B: 0.75, C: 0.5, D: 0 }[grade];
  return { score, grade, verdict, sizeMult, checks };
}
