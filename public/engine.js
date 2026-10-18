// Decision logic shared by the phone app and the server's push bot, so both
// make the same calls from the same data.
import { marketOf } from './markets.js';
import { DEFAULTS, EXIT_DEFAULTS as EXIT_D, EXIT_DEFAULTS, contractsFor, effectiveVol, feeEach, holdOdds, maxPay, evaluate, exitSignal, momentum, orderFee, probYes, quote, realizedVol } from './model.js';
import { entrySignal, flipSigns, withLiveBar } from './candles.js';
import { flipGateOk, liveFlipFeatures } from './flipstudy.js';
import { deepDive, freshRejection, quoteTrend, rejections, stability } from './analysis.js';
import { basisOf, calShift, volFactor } from './learner.js';
import { pulseFix } from './pulse.js';
import { gateCheck } from './callgate.js';
import { contextOf, lessonsFor } from './losslab.js';
const FLIP_BACK_MARGIN = 0.05; // the flip check's room over the flip bar (public/flipmodel.js FLIP.backMargin)

// Coinbase rows: [time, low, high, open, close, volume], newest first
export const parseCandles = (rows) =>
  rows.map((r) => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] ?? 0 })).sort((a, b) => a.t - b.t);

// Kalshi lists the strike as floor_strike. If it's missing, use the BTC price at the window open.
// `strikes` caches those fallbacks per ticker.
export function strikeFor(m, candles, strikes, now = Date.now()) {
  if (m.floor_strike != null || m.cap_strike != null) return Number(m.floor_strike ?? m.cap_strike);
  if (strikes[m.ticker]) return strikes[m.ticker];
  const open = Date.parse(m.open_time);
  const c = candles.find((k) => k.t >= open - 30000);
  if (c && now > open) strikes[m.ticker] = c.o;
  return strikes[m.ticker] ?? null;
}

// Plain 2-hour volatility, to tell when the short-term EWMA vol is spiking.
function longVol(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 10) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}

// Rejections are measured against "above the target"; flip them for markets where YES means below.
const tiltSign = (m) => (/^less/.test(m.strike_type || '') ? -1 : m.strike_type === 'between' ? 0 : 1);

// Kalshi settles on the average price over the last minute. Inside that minute, average what has
// printed so far (BTC prices logged with each quote, plus the current one); before it, null.
function settlementSoFar(log, close, spot, now, basis = 0) {
  if (!spot || Number.isNaN(close) || now < close - 60000 || now >= close) return null;
  const xs = log.filter((e) => e.t >= close - 60000 && e.s > 0).map((e) => e.s);
  xs.push(spot);
  return xs.reduce((a, b) => a + b, 0) / xs.length + basis;
}

// Everything the bot knows at one moment: candles with the live bar, vol, drift, rejection trends
// and a call per market. `quoteLog` (ticker -> [{ t, yesAsk, noAsk }]) collects Kalshi prices over time.
// `learned` (public/learner.js) is what the server has learned about the market over days and weeks: usual
// volatility by time of week, calibration from graded windows, and the Coinbase-vs-index basis.
// shifts: { ticker: points } learned nudges to the bot's odds that have proven themselves (the Round scan, scanfeed.js);
// they're added last. Each row keeps pPre, its odds before them (what the scan itself grades against).
// chosen: { event: ticker } (kept by the caller): for a round with many strikes (hourly and daily markets), the strike
// the bot calls. The one nearest even odds (at the money), locked once calls can start so the call card doesn't jump.
export function snapshot({ markets, candles, spot, settings, strikes = {}, quoteLog = {}, learned = null, now = Date.now(), shifts = null, chosen = null }) {
  const s = { ...DEFAULTS, ...settings };
  const bars = withLiveBar(candles, spot, now);
  const closes = bars.map((c) => c.c);
  const useLearned = learned && s.learn !== false;
  // the volatility settings the server's tuner proved on history (public/voltune.js), else the standard ones
  const tune = useLearned ? learned.volTune : null, vt = tune?.use ? tune : null;
  if (vt) s.volTails = vt.tails;
  // and the momentum it proved (only while your own momentum weight is left at 0)
  const dt = tune?.drift && !settings?.momentumWeight ? tune.drift : null;
  if (dt) s.momentumWeight = dt.w;
  const sigmaLong = longVol(closes.slice(-121)), ewma = realizedVol(closes.slice(-121), vt?.lambda ?? 0.94);
  const sigmaMin = ewma || sigmaLong ? effectiveVol(ewma, sigmaLong, s.minVol, vt?.floor ?? 0.6) * (vt?.scale ?? 1) : null;
  const driftMin = momentum(closes, dt?.n ?? 10);
  const basis = useLearned ? basisOf(learned) : 0;
  const mSpot = spot ? spot + basis : spot; // the price Kalshi will actually settle on, as best the bot knows
  const rows = markets.map((m) => {
    const strike = strikeFor(m, candles, strikes, now);
    const rej = rejections(bars, strike, Date.parse(m.open_time), now);
    let pShift = rej.tilt * s.rejectionWeight * tiltSign(m);
    const q = quote(m);
    const log = (quoteLog[m.ticker] ||= []);
    const settleAvg = settlementSoFar(log, Date.parse(m.close_time), spot, now, basis);
    // The coming minutes are usually busier (or calmer) than the last half hour at this time of the week
    // and the live correction learned every second (public/pulse.js): only while it's proving itself
    const vf = useLearned ? volFactor(learned, now, Date.parse(m.close_time)) * pulseFix(learned.pulse) : 1;
    const sig = sigmaMin ? sigmaMin * vf : sigmaMin;
    const raw = useLearned && mSpot && sig ? probYes(m, strike, mSpot, sig * s.volMultiplier, (Date.parse(m.close_time) - now) / 60000, driftMin * s.momentumWeight, settleAvg, s.volTails) : null;
    const cal = useLearned ? calShift(learned, raw) : 0; // what graded windows say about odds like these
    pShift += cal;
    let ev = evaluate({ market: m, strike, spot: mSpot, sigmaMin: sig, driftMin, pShift, settleAvg, now, settings: s });
    const pBot = ev.pYes; // the bot's own odds, before any Kalshi blend (the per-second learner grades blends of the two)
    // Respect the market: pull the bot's odds part of the way toward Kalshi's mid (your setting, or the blend the bot has
    // learned scores best once it's proven: public/pulse.js pulseBlend)
    const mw = useLearned && s.learnBlend !== false && learned?.pulse?.blend?.use ? learned.pulse.blend.w : s.marketWeight;
    if (mw > 0 && ev.pYes != null && q.yesBid != null && q.yesAsk != null) {
      const mid = (q.yesBid + q.yesAsk) / 2;
      pShift += mw * (mid - ev.pYes);
      ev = evaluate({ market: m, strike, spot: mSpot, sigmaMin: sig, driftMin, pShift, settleAvg, now, settings: s });
    }
    const pPre = ev.pYes, extra = useLearned ? shifts?.[m.ticker] || 0 : 0;
    if (extra && ev.pYes != null) ev = evaluate({ market: m, strike, spot: mSpot, sigmaMin: sig, driftMin, pShift: pShift + extra, settleAvg, now, settings: s });
    if (!log.length || now - log[log.length - 1].t >= 2000) log.push({ t: now, yesAsk: q.yesAsk, noAsk: q.noAsk, p: ev.pYes, s: spot });
    while (log.length && log[0].t < now - 15 * 60000) log.shift();
    return { m, strike, rej, ev, settleAvg, sigma: sig, learnedAdj: { volFactor: vf, cal, basis, blend: mw, scan: extra }, pRaw: raw ?? ev.pBase, pBot, pPre };
  });
  for (const t of Object.keys(quoteLog)) if (!markets.some((m) => m.ticker === t)) delete quoteLog[t];
  // the call filter the server has learned (public/callgate.js), when it has proven itself
  const callGate = useLearned && learned?.callGate?.active ? learned.callGate : null;
  return { now, bars, spot, mSpot, sigmaMin, sigmaLong, driftMin, volTails: s.volTails, momentumWeight: s.momentumWeight, volTune: vt, driftTune: dt, quoteLog, rows, callGate, live: liveRow(rows, chosen, s) };
}

// The market the bot calls now: the soonest round's only market, or (many strikes) its at-the-money strike
export function liveRow(rows, chosen = null, s = DEFAULTS) {
  const open = rows.filter((r) => r.ev.minutesLeft > 0);
  if (!open.length) return null;
  const close = open[0].m.close_time, group = open.filter((r) => r.m.close_time === close);
  if (group.length === 1) return group[0];
  const ev = open[0].m.event_ticker || close, kept = chosen?.[ev] ? group.find((r) => r.m.ticker === chosen[ev]) : null;
  if (kept) return kept;
  const priced = group.filter((r) => r.ev.pYes != null);
  const atm = (priced.length ? priced : group).reduce((a, r) => (Math.abs((r.ev.pYes ?? 0.5) - 0.5) < Math.abs((a.ev.pYes ?? 0.5) - 0.5) ? r : a));
  if (chosen && open[0].ev.minutesLeft <= (s.maxMinutesLeft ?? DEFAULTS.maxMinutesLeft)) chosen[ev] = atm.m.ticker;
  return atm;
}

// The side the model leans to, even below the edge threshold, so timing has something to read.
// The side the bot leans: the one with the bigger gap, or, when neither side has any gap (both overpriced) or the gap
// is on a long shot, the side its odds favour (it used to lean the least-overpriced side: a 3c long shot shown at "confidence 1" while UP was 97%)
export const leanSide = (ev) => {
  if (ev.side) return ev.side;
  if (ev.evYes == null && ev.evNo == null) return null;
  const y = ev.evYes ?? -1, n = ev.evNo ?? -1, best = y >= n ? 'YES' : 'NO';
  // no gap on either side, or the gap is on a long shot (under 20%: it can never clear a call's confidence bar)
  if (ev.pYes != null && ((y <= 0 && n <= 0) || (best === 'YES' ? ev.pYes : 1 - ev.pYes) < 0.2)) return ev.pYes >= 0.5 ? 'YES' : 'NO';
  return best;
};

// Edge for `side` priced with `volScale` × the bot's volatility, keeping only drift and rejection tilt
// that work AGAINST the call (anything that helps it is dropped), so it can only be harder than the real edge.
// sideOdds: that side's win chance; edgeUnder: { edge, p }, the edge after the exact fee of the order the bot would place
// (the 10-minute pick's worst case uses sideOdds too, so both judge a side the same way)
export function sideOdds(row, snap, s, side, volScale) {
  const dir = side === 'YES' ? 1 : -1;
  const drift = (snap.driftMin || 0) * (snap.momentumWeight ?? s.momentumWeight);
  const keptDrift = drift * dir > 0 ? 0 : drift;
  const keptShift = (row.ev.pShift || 0) * dir > 0 ? 0 : (row.ev.pShift || 0);
  const p0 = probYes(row.m, row.strike, snap.mSpot ?? snap.spot, (row.sigma ?? snap.sigmaMin) * s.volMultiplier * volScale, row.ev.minutesLeft, keptDrift, row.settleAvg, snap.volTails ?? s.volTails);
  if (p0 == null) return null;
  const pS = Math.min(0.999, Math.max(0.001, p0 + keptShift));
  return side === 'YES' ? pS : 1 - pS;
}
function edgeUnder(row, snap, s, side, volScale) {
  const p = sideOdds(row, snap, s, side, volScale), ask = side === 'YES' ? row.ev.quote.yesAsk : row.ev.quote.noAsk;
  if (p == null || ask == null) return null;
  return { edge: p - ask - orderFee(ask, p, s), p };
}

// Should this market fire a BUY THE LOW alert right now? Two gates, both tested for profit:
// 1) robust edge: the gap must clear minEdge even if volatility is 20% lower or 25% higher than measured
//    (an edge that only exists at one vol guess is mostly model error, and those trades lost money);
// 2) confidence (the call's win odds, worst case of the same three vol guesses) must clear minConfidence.
// `memory` (per ticker, kept by the caller across ticks) makes the bot stick with its call: once it has
// called a side this window, that call stands while the edge is still there (hysteresis), and switching
// to the other side needs clearly stronger evidence instead of one tick's wiggle.
export function buySignal(row, snap, settings, now = snap.now, memory = null) {
  const s = { ...DEFAULTS, ...settings };
  const { ev } = row;
  // How settled the market is (shown with the call; tested in simulation as a filter and it didn't raise the win
  // rate, because the bot's volatility already prices a jumpy market in, so it informs rather than blocks)
  const stab = stability({ bars: snap.bars, sigmaMin: snap.sigmaMin, sigmaLong: snap.sigmaLong, log: snap.quoteLog?.[row.m.ticker], now, aheadFactor: row.learnedAdj?.volFactor ?? 1 });
  // Everything the bot knows about buying one side right now
  const assess = (side) => {
    const timing = entrySignal(snap.bars, side, now);
    let stressEdge = null, robustEdge = null, worstP = null;
    if (snap.sigmaMin && snap.spot && ev.minutesLeft > 0) {
      const edges = [0.8, 1, 1.25].map((k) => edgeUnder(row, snap, s, side, k));
      if (edges.every((e) => e != null)) { stressEdge = edges[2].edge; const worst = edges.reduce((a, b) => (b.edge < a.edge ? b : a)); robustEdge = worst.edge; worstP = worst.p; }
    }
    const winProb = worstP != null ? Math.min(1, Math.max(0, worstP)) : null; // the win chance at the worst of the three vol guesses
    const deep = deepDive({
      winProb, ev: ev.side === side ? ev : { ...ev, side, edge: (side === 'YES' ? ev.evYes : ev.evNo) ?? 0 }, side, rej: row.rej, timing,
      sigmaMin: snap.sigmaMin, sigmaLong: snap.sigmaLong, driftMin: snap.driftMin, spot: snap.spot, strike: row.strike,
      kalshiDrift: quoteTrend(snap.quoteLog?.[row.m.ticker], side, now), bars: snap.bars, log: snap.quoteLog?.[row.m.ticker], now, minEdge: s.minEdge, stressEdge,
    });
    const point = side === 'YES' ? ev.evYes : ev.evNo;
    const price = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk;
    // Hold odds: the chance this side's confidence stays above holdFloor for the rest of the round
    const hold = ev.open && deep && deep.score >= 70 ? holdOdds({ market: row.m, strike: row.strike, spot: snap.mSpot ?? snap.spot, sigmaMin: (row.sigma ?? snap.sigmaMin) * s.volMultiplier, minutesLeft: ev.minutesLeft, side, floor: s.holdFloor }) : null;
    if (deep && stab.score != null) deep.checks.push({ pts: 0, ok: stab.level === 'stable' ? true : stab.level === 'unstable' ? false : null, label: `Market ${stab.level} (stability ${stab.score}/100)${stab.parts[0] ? `: ${stab.parts[0].label.toLowerCase()}` : ''}` });
    if (hold != null) deep.checks.push({ pts: 0, ok: hold >= 0.8 ? true : hold < 0.6 ? false : null, label: `Confidence stays above ${Math.round(s.holdFloor * 100)} to the end in ${Math.round(hold * 100)}% of simulated paths` });
    return { side, timing, deep, robustEdge, winProb, point, price, hold, score: deep?.score ?? -1 };
  };
  // Has the gap for `side` held for persistSec? (quoteLog keeps Kalshi asks and the bot's odds every ~2s)
  const persisted = (side, edgeNeed) => {
    if (!(s.persistSec > 0)) return true;
    const log = snap.quoteLog?.[row.m.ticker] || [];
    const since = now - s.persistSec * 1000;
    if (!log.length || log[0].t > since + 2500) return false; // not watched long enough yet
    return log.filter((e) => e.t >= since).every((e) => {
      const ask = side === 'YES' ? e.yesAsk : e.noAsk;
      const p = side === 'YES' ? e.p : 1 - e.p;
      return ask != null && p != null && p - ask - orderFee(ask, p, s) >= edgeNeed - 1e-9;
    });
  };
  // Smart exception (Aggressive): a cheap side whose gap is huge even at the worst vol guess is worth buying below the
  // confidence bar. Tested: it keeps most of the profit a high bar gives up, and those trades still mostly sell at a profit.
  const bigGap = (a) => s.bigEdgeOverride > 0 && a.robustEdge != null && a.robustEdge >= s.bigEdgeOverride - 1e-9;
  // Entry filters for NEW calls (all off unless set): too late in the window, a volatility spike, or Kalshi's price
  // for the side just jumped (someone knows something / the low already got bought)
  // Steady: the bot's odds for the side have stayed at the confidence bar for steadySec (not one lucky tick).
  // With steadyByStability the wait follows the market: half in a stable one, 1.5× in an unstable one.
  const steadyNeed = !(s.steadySec > 0) ? 0 : !s.steadyByStability ? s.steadySec
    : Math.round(s.steadySec * (stab.level === 'stable' ? 0.5 : stab.level === 'unstable' ? 1.5 : 1));
  // Fast lane (90% target): an overwhelming lead, the bot fastConf+ sure and Kalshi's ask fastAsk+, waits fastSec instead
  const fastLane = (side) => s.fastSec > 0 && ev.pYes != null && (side === 'YES' ? ev.pYes : 1 - ev.pYes) * 100 >= s.fastConf - 1e-9
    && (side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk) >= s.fastAsk - 1e-9;
  const steady = (side, secs = null) => {
    const need = secs ?? (fastLane(side) ? Math.min(steadyNeed, s.fastSec) : steadyNeed);
    if (!(need > 0)) return true;
    const log = snap.quoteLog?.[row.m.ticker] || [], since = now - need * 1000;
    if (!log.length || log[0].t > since + 2500) return false;
    return log.filter((e) => e.t >= since).every((e) => e.p != null && (side === 'YES' ? e.p : 1 - e.p) * 100 >= s.minConfidence);
  };
  const holds = (a) => !(s.minHold > 0) || (a.hold != null && a.hold >= s.minHold - 1e-9);
  // Market watch (public/watch.js) holds new calls after bad data, an untradeable Kalshi book or a violent jump
  const watchOk = () => !(snap.watchHold?.until > now);
  // The learned call filter: skip the kinds of calls that have lost money (only once it has proven itself)
  let gated = null;
  const gateOk = (a) => {
    const q = ev.quote, spread = q.yesAsk != null && q.yesBid != null ? q.yesAsk - q.yesBid : null;
    const g = gateCheck(snap.callGate, { conf: a.score, mins: ev.minutesLeft, stab: stab.score, vr: snap.sigmaMin && snap.sigmaLong ? snap.sigmaMin / snap.sigmaLong : 1, spread, ev60: snap.watchEvents60 ?? 0, at: now }, a.price);
    if (g?.skip) { gated = { side: a.side, ...g }; return false; }
    // v13.39 the loss lab's proven lessons for calls worth buying (public/losslab.js): skip a kind of call the record
    // shows wins less often than its price needs
    if (snap.lessons?.length) {
      const q2 = ev.quote, mid = q2.yesBid != null && q2.yesAsk != null && q2.yesAsk - q2.yesBid <= 0.1 ? (q2.yesBid + q2.yesAsk) / 2 : null, pY = row.pPre ?? ev.pYes;
      const ctx = contextOf({ side: a.side, kalshi: mid == null ? null : a.side === 'YES' ? mid : 1 - mid, pBot: pY == null ? null : a.side === 'YES' ? pY : 1 - pY, spot: snap.mSpot ?? snap.spot,
        strike: row.strike, sigma: row.sigma ?? snap.sigmaMin, minutesLeft: ev.minutesLeft, strikeType: row.m.strike_type, bars: snap.bars, now, sigmaMin: snap.sigmaMin, sigmaLong: snap.sigmaLong,
        flip: snap.flipCheck?.ticker === row.m.ticker ? snap.flipCheck.pLose?.[a.side] ?? null : null });
      const hit = lessonsFor({ active: snap.lessons }, ctx);
      if (hit.length) { gated = { side: a.side, lesson: hit[0] }; return false; }
    }
    return true;
  };
  const entryOk = (side, floor = true, lastMin = s.noCallLastMin) => {
    // Two-rejections rule: never make a new call against two rejections in a row
    if (s.doubleRejRule && row.rej?.double && row.rej.double.dir !== (side === 'YES' ? 1 : -1)) return false;
    if (lastMin > 0 && ev.minutesLeft < lastMin) return false;
    // the price band (Profit: 60-90c): above it a win pays too little, under it Kalshi doubts the side too much
    { const ask = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk; if (s.maxAsk > 0 && !(ask <= s.maxAsk + 1e-9)) return false; if (s.minAsk > 0 && !(ask >= s.minAsk - 1e-9)) return false; }
    // Near-certain: Kalshi's own price has to agree (its bid for the side at kalshiAgree or more)
    if (s.kalshiAgree > 0) { const bid = side === 'YES' ? ev.quote.yesBid : ev.quote.noBid; if (!(bid >= s.kalshiAgree - 1e-9)) return false; }
    // 90% target: Kalshi's own ask for the side at the floor or more (public/winguard.js)
    if (floor && s.winFloor > 0) { const ask = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk; if (!(ask >= s.winFloor - 1e-9)) return false; }
    if (s.maxVolRatio > 0 && snap.sigmaMin && snap.sigmaLong && snap.sigmaMin / snap.sigmaLong > s.maxVolRatio) return false;
    if (s.jumpSkip > 0) {
      const log = snap.quoteLog?.[row.m.ticker] || [], key = side === 'YES' ? 'yesAsk' : 'noAsk';
      const then = log.find((e) => e.t >= now - 30000 && e[key] != null), cur = ev.quote[key];
      if (then && cur != null && Math.abs(cur - then[key]) >= s.jumpSkip - 1e-9) return false;
    }
    return true;
  };
  // Late lane (v13.15): in the round's last lateMin minutes a new call has to pass this instead of the normal edge
  // bar (it replaces it there; it isn't an extra way in). Late, Kalshi already prices the leader at 90-98c, so a win
  // pays a few cents and a loss costs the whole stake: the only thing that matters is not being wrong in the tails.
  //   stress    the side still wins lateConf+ (and beats the ask plus its fee by lateMargin) with volatility lateVol x
  //             what the bot measured, fat tails lateTails, and any momentum against the call kept (none that helps)
  //   price     Kalshi's ask lateMaxAsk at most (above it a win pays almost nothing) and its bid lateBid+ (it agrees)
  //   calm      the last minutes' volatility at most lateCalm x the 2-hour level, and no jump of lateJump+ in the
  //             side's ask over the last 30 s
  //   steady    the bot's odds for the side at the confidence bar for lateSteady s
  //   guard     its own record: once its last 40 calls lose money after fees (20+), it switches off (snap.lateOff)
  // Simulated with the vol wrong, jumps and a lagging Kalshi price: 98.4-99.8% won and still in profit at harshness
  // where the normal rules lost money late (the stress test is what does it: without it, it lost money too)
  const inLate = s.lateMin > 0 && ev.minutesLeft <= s.lateMin;
  let lateWhy = null, lateP = null;
  const lateOk = (a) => {
    const side = a.side, ask = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk, bid = side === 'YES' ? ev.quote.yesBid : ev.quote.noBid;
    const no = (why) => { lateWhy = why; return false; };
    if (snap.lateOff) return no('its own record is losing money after fees: off until it recovers');
    if (!ev.open || ask == null) return no('no price to buy at');
    if (ask > s.lateMaxAsk + 1e-9) return no(`Kalshi's ask ${Math.round(ask * 100)}¢ is over ${Math.round(s.lateMaxAsk * 100)}¢: a win would pay almost nothing`);
    if (!(bid >= s.lateBid - 1e-9)) return no(`Kalshi's bid isn't at ${Math.round(s.lateBid * 100)}¢+ (it doesn't agree yet)`);
    if (snap.sigmaMin && snap.sigmaLong && snap.sigmaMin / snap.sigmaLong > s.lateCalm) return no('the price is moving faster than usual');
    const log = snap.quoteLog?.[row.m.ticker] || [], key = side === 'YES' ? 'yesAsk' : 'noAsk';
    if (log.some((e) => e.t >= now - 30000 && e[key] != null && Math.abs(e[key] - ask) >= s.lateJump - 1e-9)) return no('Kalshi\'s price just jumped');
    const dir = side === 'YES' ? 1 : -1, drift = (snap.driftMin || 0) * (snap.momentumWeight ?? s.momentumWeight);
    const q = probYes(row.m, row.strike, snap.mSpot ?? snap.spot, (row.sigma ?? snap.sigmaMin) * s.volMultiplier * s.lateVol, ev.minutesLeft, drift * dir > 0 ? 0 : drift, row.settleAvg, Math.max(s.lateTails, snap.volTails ?? 0));
    if (q == null) return no('no price model');
    lateP = side === 'YES' ? q : 1 - q;
    const bar = Math.max(s.lateConf, ask + feeEach(ask, 10) + s.lateMargin);
    if (lateP < bar - 1e-9) return no(`stress test: ${(lateP * 100).toFixed(1)}% with ${s.lateVol}× volatility and fat tails, needs ${(bar * 100).toFixed(1)}%`);
    if (!steady(side, s.lateSteady)) return no(`waiting for ${s.lateSteady} s at the confidence bar`);
    lateWhy = null;
    return true;
  };
  // Early lane (v13.16): from earlyMin minutes left until the late lane, a call Kalshi still prices under the 90% floor
  // (earlyMinAsk to the floor) when the bot is clearly surer than Kalshi. Live unless its recent calls lose money after
  // fees; then test calls (graded, never sent) until they recover (snap.earlyLive: public/profitguard.js earlyProof). Its bar: the bot's worst-case odds (volatility 20% off either way, momentum against kept) at earlyConf+
  // (and the guard's floor), its worst-case gap after the fee earlyEdge+, Kalshi's bid earlyBid+ (Kalshi leans the same
  // way), a calm market with no jump in the ask, the usual steady wait and hold odds. Live calls go out at half size.
  const inEarly = s.earlyMin > 0 && ev.minutesLeft <= s.earlyMin && ev.minutesLeft > Math.max(s.lateMin || 0, s.noCallLastMin || 0);
  let earlyWhy = null;
  const earlyOk = (a) => {
    const side = a.side, ask = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk, bid = side === 'YES' ? ev.quote.yesBid : ev.quote.noBid;
    const no = (why) => { earlyWhy = why; return false; };
    if (!ev.open) return no(ev.reason ? ev.reason.charAt(0).toLowerCase() + ev.reason.slice(1) : 'not open for calls');
    if (ask == null || a.winProb == null || a.robustEdge == null) return no('no price to buy at');
    if (ask < s.earlyMinAsk - 1e-9) return no(`Kalshi's ask ${Math.round(ask * 100)}¢ is under ${Math.round(s.earlyMinAsk * 100)}¢: too much doubt this early`);
    if (s.winFloor > 0 && ask >= s.winFloor - 1e-9) return no('priced at the floor: the normal rules decide');
    if (!(bid >= s.earlyBid - 1e-9)) return no(`Kalshi's bid isn't at ${Math.round(s.earlyBid * 100)}¢+`);
    const bar = Math.max(s.earlyConf, s.winFloor || 0);
    if (a.winProb < bar - 1e-9) return no(`worst-case odds ${(a.winProb * 100).toFixed(1)}%, needs ${(bar * 100).toFixed(0)}%`);
    if (a.robustEdge < s.earlyEdge - 1e-9) return no(`worst-case gap ${(a.robustEdge * 100).toFixed(1)} pts over Kalshi, needs ${(s.earlyEdge * 100).toFixed(0)}`);
    if (snap.sigmaMin && snap.sigmaLong && snap.sigmaMin / snap.sigmaLong > s.lateCalm) return no('the price is moving faster than usual');
    const log = snap.quoteLog?.[row.m.ticker] || [], key = side === 'YES' ? 'yesAsk' : 'noAsk';
    if (log.some((e) => e.t >= now - 30000 && e[key] != null && Math.abs(e[key] - ask) >= s.lateJump - 1e-9)) return no('Kalshi\'s price just jumped');
    if (!holds(a)) return no(`its confidence holds to the end in only ${a.hold == null ? '—' : Math.round(a.hold * 100)}% of paths`);
    if (!steady(side)) return no(`waiting for ${steadyNeed} s of steady odds`);
    if (!entryOk(side, false) || !watchOk()) return no('held by a safety rule (rejections, market watch or a filter)');
    earlyWhy = null;
    return true;
  };
  // Flip calls (v13.19): a locked call can switch sides once a round when the evidence of a flip is clear: the bot's
  // worst-case odds (volatility 20% off either way, momentum against kept) on the other side at flipConf+, that side
  // clearing the same bar as a fresh call at its price (the switching gap and confidence at the 90% floor and up, the
  // early lane's rules under it), steady for the full wait, Kalshi leaning the same way, and not in the last minutes.
  // Half size, at most flipMax a round, and off while its own calls lose money after fees (snap.flipOff)
  let flipWhy = null;
  const flipOk = (b) => {
    const no = (why) => { flipWhy = why; return false; };
    // v13.45 a locked call never switches sides: flip calls only where switchLocked is set on purpose
    if (!s.switchLocked) return no('the call is locked for this round: it never switches sides');
    if (!(s.flipCalls > 0)) return no('off');
    if (snap.flipOff) return no('flip calls lost money lately: off until they recover');
    if ((mem.flips || 0) >= s.flipMax) return no('already flipped this round');
    if (b.winProb == null || b.winProb < s.flipConf - 1e-9) return no(`the bot's worst case on ${b.side === 'YES' ? 'UP' : 'DOWN'} is ${b.winProb == null ? '—' : `${(b.winProb * 100).toFixed(0)}%`}, needs ${Math.round(s.flipConf * 100)}%`);
    // v13.38 the flip check (public/flipmodel.js, proven only): chart history and the buyers and sellers must not say the
    // new side is likely to flip back (more than the flip bar allows, plus 5 points)
    const fc = snap.flipCheck, back = fc && fc.ticker === row.m.ticker ? fc.pLose?.[b.side] : null;
    if (back != null && back > 1 - s.flipConf + FLIP_BACK_MARGIN) return no(`chart history and buyers / sellers give ${b.side === 'YES' ? 'UP' : 'DOWN'} a ${Math.round(back * 100)}% chance of flipping back`);
    // v13.43 the flip study (public/flipstudy.js, proven only): history's rule for the flips that hold
    const fs = snap.flipGate;
    if (fs?.proven && fs.gate) {
      const f = liveFlipFeatures({ bars: snap.bars, spot: snap.mSpot ?? snap.spot, strike: row.strike, side: b.side, sigmaMin: row.sigma ?? snap.sigmaMin, sigmaLong: snap.sigmaLong, minutesLeft: ev.minutesLeft, openTime: Date.parse(row.m.open_time) });
      if (!flipGateOk(fs.gate, f)) return no(`history's flip rule: ${fs.gate.label}`);
    }
    const ask = b.side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk;
    const priced = !(s.winFloor > 0) || ask >= s.winFloor - 1e-9;
    // v13.43.1 flips run past the last-minutes rule down to the minute history proved they hold (the flip study's late window)
    const lateTo = fs?.late?.lastMin, flipLast = lateTo != null && lateTo < s.noCallLastMin ? lateTo : s.noCallLastMin;
    if (s.noCallLastMin > 0 && ev.minutesLeft < s.noCallLastMin && !(ev.minutesLeft >= flipLast)) return no(lateTo != null ? `history proves flips only down to ${lateTo} min left` : `no flips in the last ${s.noCallLastMin} minutes until history proves later ones hold`);
    if (priced ? !(passes(b, ...need.switching, true) && steady(b.side) && entryOk(b.side, true, flipLast) && holds(b) && watchOk()) : !earlyOk(b)) return no(priced ? 'not past the bar for a switch yet' : (earlyWhy || 'not past the bar yet'));
    if (!gateOk(b)) return no(gated?.lesson ? `a lesson from past losses: ${gated.lesson.label.toLowerCase()}` : 'the call filter skipped it');
    flipWhy = null;
    return true;
  };
  const passes = (a, edgeNeed, confNeed, persist = false) => ev.open && a.price != null && a.point != null && a.point >= edgeNeed - 1e-9 && a.point <= s.maxEdge &&
    a.robustEdge != null && a.robustEdge >= edgeNeed - 1e-9 && !!a.deep && (a.score >= confNeed || bigGap(a)) && (!persist || persisted(a.side, edgeNeed));

  const mem = memory ? (memory[row.m.ticker] ||= {}) : {};
  const called = mem.side ?? null, lean = leanSide(ev);
  const need = {
    new: [s.minEdge, s.minConfidence],
    holding: [s.minEdge * s.holdEdgeFrac, s.minConfidence - s.holdConfDrop],
    switching: [s.minEdge + s.switchEdgeExtra, s.minConfidence + s.switchConfExtra],
  };
  let pick = null, shown = null, stance = 'new', earlyWould = null, flipPick = null, lockedOut = false;
  // v13.45 one side a round: once the round call has locked (snap.lockedSide: the server's 10-minute pick, or the one
  // this phone showed), no call is ever made on the other side
  const locked = snap.lockedSide && snap.lockedSide.ticker === row.m.ticker ? snap.lockedSide.side : null;
  if (called) {
    const a = assess(called);
    shown = a; stance = 'holding';
    if (passes(a, ...need.holding)) pick = a;
    if (lean && lean !== called && !(locked && lean !== locked)) {
      const b = assess(lean);
      if (!s.lockCall && (inLate ? lateOk(b) : passes(b, ...need.switching, true) && steady(lean)) && entryOk(lean) && holds(b) && watchOk() && gateOk(b)) { pick = b; stance = 'switching'; }
      else if (s.lockCall && flipOk(b)) { pick = b; stance = 'switching'; flipPick = b; }
      else if (!pick) { shown = b; stance = 'switching'; }
    }
  } else if (lean && locked && lean !== locked) {
    shown = assess(lean); lockedOut = true; // the bot leans the other way, but the round is locked: no call against it
  } else if (lean) {
    shown = assess(lean);
    if ((inLate ? lateOk(shown) : passes(shown, ...need.new, true) && steady(lean)) && !(mem.cooldownUntil > now) && entryOk(lean) && holds(shown) && watchOk() && gateOk(shown)) pick = shown;
    // the early lane: a test call until it has proven itself (earlyWould), a real one after
    else if (inEarly && !(mem.cooldownUntil > now) && earlyOk(shown) && gateOk(shown)) { earlyWould = shown; if (snap.earlyLive) pick = shown; }
  }
  const a = pick ?? shown;
  const [edgeNeed, confNeed] = need[stance];
  const callSide = pick?.side ?? null;
  const prob = callSide ? (callSide === 'YES' ? ev.pYes : 1 - ev.pYes) : null;
  const firstOnly = s.scaleIn && callSide && callSide !== called; // a brand-new scaled call starts small
  const late = !!callSide && callSide !== called && inLate; // a new call made by the late lane (half size: see lateSize)
  const early = !!callSide && callSide !== called && !!earlyWould && pick === earlyWould; // a live early-lane call (half size)
  const flip = !!callSide && !!flipPick && pick === flipPick; // a flip call: the locked call switched sides (half size)
  const contracts = callSide ? Math.max(1, Math.floor(contractsFor(prob, pick.price, s) * (pick.deep ? pick.deep.sizeMult : 0.5) * (firstOnly ? s.firstSize : 1) * (late ? s.lateSize : early ? s.earlySize : flip ? s.flipSize : 1))) : 0;
  const buyNow = !!callSide && pick.timing.state === 'NOW';
  // fire = a new call worth an alert (first call, or a real switch); holding the same call doesn't re-alert
  const fire = !!callSide && callSide !== called && (buyNow || !s.waitForDip);
  // Max price: the most you can pay and still clear limitEdgeFrac × minEdge with vol 20% off either way
  const limit = callSide && pick.winProb != null ? maxPay(pick.winProb, s.minEdge * s.limitEdgeFrac, s) : null;
  // Scale-in tiers: a call opens at the first tier its gap clears; each time the gap later clears the next
  // tier (with full confidence) it signals an add. Small early entries, bigger ones as the edge proves out.
  const st = s.scaleStep;
  const tiers = s.scaleIn ? [s.minEdge, s.minEdge + st, s.minEdge + 2 * st, s.minEdge + 4 * st] : [s.minEdge];
  const reached = (e) => tiers.reduce((k, t, i) => (e != null && e >= t - 1e-9 ? i : k), -1);
  let add = false;
  // Bail out on the bot's own call: its odds for the called side fell under bailBelow (see EXIT_DEFAULTS). Once
  // called, the bail stands for the rest of the round.
  const bailBelow = settings?.bailBelow ?? EXIT_D.bailBelow, bailLastSec = settings?.bailLastSec ?? EXIT_D.bailLastSec;
  if (called && !mem.bail && bailBelow > 0 && ev.pYes != null && ev.minutesLeft * 60 > bailLastSec) {
    const pc = called === 'YES' ? ev.pYes : 1 - ev.pYes;
    if (pc < bailBelow) mem.bail = { side: called, at: now, p: pc, bid: called === 'YES' ? ev.quote.yesBid : ev.quote.noBid, entry: mem.price ?? null };
  }
  if (fire) { mem.side = callSide; mem.at = now; mem.price = pick.price; mem.n = (mem.n || 0) + 1; mem.late = late; mem.early = early; mem.flip = flip; if (flip) { mem.flips = (mem.flips || 0) + 1; mem.flipFrom = called; mem.bail = null; /* a fresh bail line for the new call */ } mem.tier = Math.max(0, Math.min(reached(pick.point), reached(pick.robustEdge))); }
  else if (callSide && callSide === called && tiers.length > 1 && pick.deep && (pick.score >= s.minConfidence || bigGap(pick))) {
    const next = (mem.tier ?? 0) + 1;
    if (next < tiers.length && Math.min(reached(pick.point), reached(pick.robustEdge)) >= next) { add = true; mem.tier = Math.min(reached(pick.point), reached(pick.robustEdge)); }
  }
  return {
    stability: stab, steadyNeed, bail: mem.bail ?? null, gated, watchHold: snap.watchHold?.until > now ? snap.watchHold : null,
    hold: a?.hold ?? null, holdOk: !!a && holds(a), steadyOk: !!a && steady(a.side), locked: !!s.lockCall && !!called,
    add, tier: mem.tier ?? null, callN: mem.n ?? 0, bigGap: !!pick && pick.score < s.minConfidence && bigGap(pick), // under the full bar but a huge gap (holding a call too)
    cooldown: !called && mem.cooldownUntil > now ? Math.ceil((mem.cooldownUntil - now) / 1000) : 0,
    side: a?.side ?? lean, callSide, price: pick?.price ?? null, limit, edge: pick?.point ?? null,
    timing: a?.timing ?? entrySignal(snap.bars, null, now), deep: a?.deep ?? null, robustEdge: a?.robustEdge ?? null,
    robust: a?.robustEdge != null && a.robustEdge >= edgeNeed - 1e-9, confident: !!callSide, buyNow, contracts, fire,
    stance: callSide ? (callSide === called || !called ? (called ? 'holding' : 'new') : 'switching') : stance, called, calledAt: mem.at ?? null, edgeNeed, confNeed,
    // the bot already called a side and is sticking with it while the other side wiggles
    sticking: !!called && !!lean && lean !== called && callSide !== lean,
    // the late lane: on in the last lateMin minutes; lane 'late' on a call it made; why it's holding off; its stress-test odds
    late: inLate ? { on: true, why: callSide ? null : lateWhy, p: lateP, made: callSide ? (callSide === called ? !!mem.late : late) : false } : null,
    lane: callSide && (callSide === called ? mem.late : late) ? 'late' : callSide && (callSide === called ? mem.early : early) ? 'early' : callSide && (callSide === called ? mem.flip : flip) ? 'flip' : null,
    // flip calls: why a locked call isn't switching (while the bot leans the other way), and the side it flipped from
    roundLock: locked, lockedOut,
    flip: called && lean && lean !== called && !flipPick && s.flipCalls > 0 ? { why: flipWhy } : (callSide && (callSide === called ? mem.flip : flip)) ? { from: mem.flipFrom ?? called } : null,
    // the early lane: on from earlyMin minutes left; would = the call it makes now (a test call unless live)
    early: inEarly && !called ? { on: true, live: !!snap.earlyLive, would: earlyWould ? { side: earlyWould.side, price: earlyWould.price, p: earlyWould.winProb, conf: earlyWould.score } : null, why: earlyWould ? null : earlyWhy } : null,
  };
}

// After a sale, forget the call on that market so a fresh dislocation can be called again (re-entry),
// after a short cooldown so it doesn't buy straight back at the price it just sold.
export function releaseCall(memory, ticker, now = Date.now(), settings = {}) {
  if (!memory) return;
  const s = { ...DEFAULTS, ...settings };
  memory[ticker] = { n: memory[ticker]?.n ?? 0, cooldownUntil: now + s.reentrySec * 1000, at: now };
}

// Exit check for one tracked position. Updates pos.peakBid / pos.peakP after the check
// (so drops are measured from earlier highs) and reports whether they changed.
export function positionCheck(pos, snap, settings, now = snap.now) {
  const s = { ...DEFAULTS, ...EXIT_DEFAULTS, ...settings };
  const { rows, bars } = snap;
  const row = rows.find((r) => r.m.ticker === pos.ticker) ?? null;
  const minutesLeft = (Date.parse(pos.closeTime) - now) / 60000;
  let pYes = row?.ev.pYes ?? null;
  // The bot's settled view: its odds averaged over the last smoothSec, so one jumpy tick doesn't move it
  if (pYes != null && s.smoothSec > 0 && minutesLeft > 1) {
    const recent = (snap.quoteLog?.[pos.ticker] || []).filter((e) => e.t >= now - s.smoothSec * 1000 && e.p != null).map((e) => e.p);
    pYes = [...recent, pYes].reduce((a, b) => a + b, 0) / (recent.length + 1);
  }
  const pSide = pYes == null ? null : pos.side === 'YES' ? pYes : 1 - pYes;
  const bid = row ? (pos.side === 'YES' ? row.ev.quote.yesBid : row.ev.quote.noBid) : null;
  const flips = flipSigns(bars, pos.side, now);
  const rejFlip = freshRejection(row?.rej, pos.side, now);
  if (rejFlip) flips.push(rejFlip);
  let ex = exitSignal({ pos, bid, pSide, flips, minutesLeft, settings: s });
  let changed = false;
  // Hold steady: a sell has to stay a sell for a while before it's SELL NOW (no waiting in the last minute)
  if (ex.action === 'SELL') {
    const wait = (ex.kind === 'cut' ? s.cutConfirmSec : ex.kind === 'bail' ? 0 : s.takeConfirmSec) * 1000;
    if (pos.sellSince?.kind !== ex.kind) { pos.sellSince = { kind: ex.kind, t: now }; changed = true; }
    const held = now - pos.sellSince.t;
    if (held < wait && minutesLeft > 1) {
      const left = Math.ceil((wait - held) / 1000);
      ex = { ...ex, action: 'HOLD', kind: 'steady', why: ex.kind === 'cut'
        ? `Kalshi pays a bit more than the bot's odds right now, but one move isn't a reason to bail. Holding the call; if it's still true in ${left}s, sell.`
        : `In profit and Kalshi has caught up. Making sure it sticks for ${left}s before calling the sell.` };
    }
  } else if (pos.sellSince) { pos.sellSince = null; changed = true; }
  if (bid != null && (pos.peakBid == null || bid > pos.peakBid)) { pos.peakBid = bid; changed = true; }
  if (pSide != null && (pos.peakP == null || pSide > pos.peakP)) { pos.peakP = pSide; changed = true; }
  return { row, minutesLeft, pSide, bid, ex, changed };
}

// ---------- alert wording (same on push and in-app) ----------
const pc = (v) => `${(v * 100).toFixed(0)}%`;
const dollars = (v) => `$${v.toFixed(2)}`;
export const sideName = (side) => (side === 'YES' ? 'YES · Above' : 'NO · Below');

// the round's coin (public/markets.js) and its prices at that coin's precision ($100,250 for BTC, $2.5123 for XRP)
const coinOf = (ticker) => marketOf(String(ticker || '').split('-')[0]);
const px = (v, mk) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: mk.digits, maximumFractionDigits: mk.digits })}`;
const btc = (spot, ticker) => { const mk = coinOf(ticker); return spot ? ` · ${mk.key} ${px(spot, mk)}` : ''; };

// The bot's own call went bad: bail out (sig.bail from buySignal)
export function bailMessage(row, sig) {
  const b = sig.bail, side = sideName(b.side);
  return { tag: `bail-${row.m.ticker}`, title: `🚨 BAIL OUT: ${side}${b.bid ? ` · sell at ${pc(b.bid)}` : ''}`,
    body: `The bot's odds on its ${side} call fell to ${pc(b.p)}. If you bought it, selling now keeps ${b.bid ? `about ${pc(b.bid)} of each $1` : 'part of it'} instead of risking all of it.` };
}

export function buyMessage(row, sig, spot) {
  const { m, ev, strike } = row;
  const side = sig.callSide ?? ev.side, price = sig.price ?? ev.price;
  const bot = side === 'YES' ? ev.pYes : 1 - ev.pYes;
  const mk = coinOf(m.ticker), where = strike ? ` (${mk.key} ${side === 'YES' ? 'above' : 'below'} ${px(strike, mk)})` : '';
  return {
    tag: `buy-${m.ticker}`,
    title: `${sig.stance === 'switching' ? 'Switch: buy' : (sig.deep?.score ?? 0) >= 90 && (sig.hold ?? 0) >= 0.9 ? 'Confident buy:' : 'Buy the low:'} ${sideName(side)} at ${pc(price)}${sig.limit ? ` · max ${pc(sig.limit)}` : ''}`,
    body: `${sig.limit ? `Act now: buy only at ${pc(sig.limit)} or less, skip if it's higher. ` : ''}Kalshi ${pc(price)} vs bot ${pc(bot)} · buy ${dollars(sig.contracts * price)}${where}` +
      `${sig.deep ? ` · confidence ${sig.deep.score}${sig.bigGap ? ' · big-gap exception' : ''}` : ''}${sig.hold != null ? ` · holds ${Math.round(sig.hold * 100)}%` : ''}${sig.buyNow ? ' · candle dip too' : ''}${btc(spot, m.ticker)}`,
  };
}

// Clock time in the phone's time zone (the server doesn't know it otherwise).
function hm(t, tz) {
  try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }); }
  catch { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }); }
}

// The every-15-minutes update: how the last window went, and the read on the new one.
export function updateMessage({ prev, row, sig, spot, tz, now = Date.now() }) {
  const { m, ev, strike } = row;
  const open = Date.parse(m.open_time), close = Date.parse(m.close_time);
  const mk = coinOf(m.ticker), usd = (v) => px(v, mk);
  const parts = [];
  if (prev) {
    const money = `${prev.paperUsd >= 0 ? '+' : '-'}$${Math.abs(prev.paperUsd).toFixed(2)}`;
    parts.push(`${hm(prev.openTime, tz)} window settled ${prev.result.toUpperCase()} · bot had ${pc(prev.avgWinnerOdds)} on the winner` +
      `${prev.calls ? ` · follow-the-bot ${money}` : ''}.`);
  }
  const lean = ev.pYes >= 0.5 ? `YES ${pc(ev.pYes)}` : `NO ${pc(1 - ev.pYes)}`;
  const diff = spot && strike ? ` (${spot >= strike ? '+' : '-'}${usd(Math.abs(spot - strike))})` : '';
  const startsLater = ev.callsAt && now < ev.callsAt ? ` · calls start ${hm(ev.callsAt, tz)}` : '';
  parts.push(`Now ${mk.key} ${spot ? usd(spot) : '—'}${diff} · bot leans ${lean}${sig?.callSide ? ` · BUY THE LOW ${sideName(sig.callSide)} at ${pc(sig.price)}` : startsLater}.`);
  return {
    tag: 'window-update',
    title: `🕒 ${hm(open, tz)}–${hm(close, tz)}${tz ? '' : ' UTC'} window · target ${strike ? usd(strike) : '—'}`,
    body: parts.join(' '),
  };
}

// Aggressive scale-in: the gap on a call you hold grew past the next tier
export function addMessage(row, sig, spot) {
  const { m, ev } = row;
  const side = sig.callSide, price = sig.price;
  const bot = side === 'YES' ? ev.pYes : 1 - ev.pYes;
  return {
    tag: `add-${m.ticker}`,
    title: `Add: ${sideName(side)} at ${pc(price)}${sig.limit ? ` · max ${pc(sig.limit)}` : ''}`,
    body: `The gap grew to ${(sig.edge * 100).toFixed(0)} pts (Kalshi ${pc(price)} vs bot ${pc(bot)}) · add ${dollars(sig.contracts * price)}${btc(spot, m.ticker)}`,
  };
}

export function sellMessage(pos, check, spot) {
  const { ex, bid } = check;
  const money = `${ex.pnl >= 0 ? '+' : '-'}$${Math.abs(ex.pnl).toFixed(2)}`;
  const cashOut = ex.net != null ? ` · cash out ${dollars(ex.net * pos.contracts)}` : '';
  return { tag: `sell-${pos.id}`, title: `${ex.kind === 'take' ? 'SELL HIGH' : ex.kind === 'cut' ? 'BAIL' : ex.kind === 'bail' ? 'BAIL OUT' : 'SELL NOW'}: ${sideName(pos.side)} at ${pc(bid)}${cashOut} (${money})`, body: `${ex.why}${btc(spot, pos.ticker)}` };
}
