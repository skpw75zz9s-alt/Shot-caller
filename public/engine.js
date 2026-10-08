// Decision logic shared by the phone app and the server's push bot, so both
// make the same calls from the same data.
import { DEFAULTS, EXIT_DEFAULTS as EXIT_D, EXIT_DEFAULTS, contractsFor, effectiveVol, holdOdds, maxPay, evaluate, exitSignal, kalshiFee, momentum, probYes, quote, realizedVol } from './model.js';
import { entrySignal, flipSigns, withLiveBar } from './candles.js';
import { deepDive, freshRejection, quoteTrend, rejections, stability } from './analysis.js';
import { basisOf, calShift, volFactor } from './learner.js';

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
export function snapshot({ markets, candles, spot, settings, strikes = {}, quoteLog = {}, learned = null, now = Date.now() }) {
  const s = { ...DEFAULTS, ...settings };
  const bars = withLiveBar(candles, spot, now);
  const closes = bars.map((c) => c.c);
  const sigmaLong = longVol(closes.slice(-121));
  const sigmaMin = effectiveVol(realizedVol(closes.slice(-121)), sigmaLong, s.minVol);
  const driftMin = momentum(closes, 10);
  const useLearned = learned && s.learn !== false;
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
    const vf = useLearned ? volFactor(learned, now, Date.parse(m.close_time)) : 1;
    const sig = sigmaMin ? sigmaMin * vf : sigmaMin;
    const raw = useLearned && mSpot && sig ? probYes(m, strike, mSpot, sig * s.volMultiplier, (Date.parse(m.close_time) - now) / 60000, driftMin * s.momentumWeight, settleAvg) : null;
    const cal = useLearned ? calShift(learned, raw) : 0; // what graded windows say about odds like these
    pShift += cal;
    let ev = evaluate({ market: m, strike, spot: mSpot, sigmaMin: sig, driftMin, pShift, settleAvg, now, settings: s });
    // Respect the market: pull the bot's odds part of the way toward Kalshi's mid
    if (s.marketWeight > 0 && ev.pYes != null && q.yesBid != null && q.yesAsk != null) {
      const mid = (q.yesBid + q.yesAsk) / 2;
      ev = evaluate({ market: m, strike, spot: mSpot, sigmaMin: sig, driftMin, pShift: pShift + s.marketWeight * (mid - ev.pYes), settleAvg, now, settings: s });
    }
    if (!log.length || now - log[log.length - 1].t >= 2000) log.push({ t: now, yesAsk: q.yesAsk, noAsk: q.noAsk, p: ev.pYes, s: spot });
    while (log.length && log[0].t < now - 15 * 60000) log.shift();
    return { m, strike, rej, ev, settleAvg, sigma: sig, learnedAdj: { volFactor: vf, cal, basis }, pRaw: raw ?? ev.pBase };
  });
  for (const t of Object.keys(quoteLog)) if (!markets.some((m) => m.ticker === t)) delete quoteLog[t];
  return { now, bars, spot, mSpot, sigmaMin, sigmaLong, driftMin, quoteLog, rows, live: rows.find((r) => r.ev.minutesLeft > 0) ?? null };
}

// The side the model leans to, even below the edge threshold, so timing has something to read.
export const leanSide = (ev) =>
  ev.side ?? (ev.evYes == null && ev.evNo == null ? null : (ev.evYes ?? -1) >= (ev.evNo ?? -1) ? 'YES' : 'NO');

// Edge for `side` priced with `volScale` × the bot's volatility, keeping only drift and rejection tilt
// that work AGAINST the call (anything that helps it is dropped), so it can only be harder than the real edge.
function edgeUnder(row, snap, s, side, volScale) {
  const dir = side === 'YES' ? 1 : -1;
  const drift = (snap.driftMin || 0) * s.momentumWeight;
  const keptDrift = drift * dir > 0 ? 0 : drift;
  const keptShift = (row.ev.pShift || 0) * dir > 0 ? 0 : (row.ev.pShift || 0);
  const p0 = probYes(row.m, row.strike, snap.mSpot ?? snap.spot, (row.sigma ?? snap.sigmaMin) * s.volMultiplier * volScale, row.ev.minutesLeft, keptDrift, row.settleAvg);
  const ask = side === 'YES' ? row.ev.quote.yesAsk : row.ev.quote.noAsk;
  if (p0 == null || ask == null) return null;
  const pS = Math.min(0.999, Math.max(0.001, p0 + keptShift));
  return (side === 'YES' ? pS : 1 - pS) - ask - kalshiFee(ask);
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
    let stressEdge = null, robustEdge = null;
    if (snap.sigmaMin && snap.spot && ev.minutesLeft > 0) {
      const edges = [0.8, 1, 1.25].map((k) => edgeUnder(row, snap, s, side, k));
      if (edges.every((e) => e != null)) { stressEdge = edges[2]; robustEdge = Math.min(...edges); }
    }
    const price0 = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk;
    const winProb = robustEdge != null && price0 != null ? Math.min(1, Math.max(0, robustEdge + price0 + kalshiFee(price0))) : null;
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
    return { side, timing, deep, robustEdge, point, price, hold, score: deep?.score ?? -1 };
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
      return ask != null && p != null && p - ask - kalshiFee(ask) >= edgeNeed - 1e-9;
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
  const steady = (side) => {
    if (!(steadyNeed > 0)) return true;
    const log = snap.quoteLog?.[row.m.ticker] || [], since = now - steadyNeed * 1000;
    if (!log.length || log[0].t > since + 2500) return false;
    return log.filter((e) => e.t >= since).every((e) => e.p != null && (side === 'YES' ? e.p : 1 - e.p) * 100 >= s.minConfidence);
  };
  const holds = (a) => !(s.minHold > 0) || (a.hold != null && a.hold >= s.minHold - 1e-9);
  const entryOk = (side) => {
    // Two-rejections rule: never make a new call against two rejections in a row
    if (s.doubleRejRule && row.rej?.double && row.rej.double.dir !== (side === 'YES' ? 1 : -1)) return false;
    if (s.noCallLastMin > 0 && ev.minutesLeft < s.noCallLastMin) return false;
    if (s.maxVolRatio > 0 && snap.sigmaMin && snap.sigmaLong && snap.sigmaMin / snap.sigmaLong > s.maxVolRatio) return false;
    if (s.jumpSkip > 0) {
      const log = snap.quoteLog?.[row.m.ticker] || [], key = side === 'YES' ? 'yesAsk' : 'noAsk';
      const then = log.find((e) => e.t >= now - 30000 && e[key] != null), cur = ev.quote[key];
      if (then && cur != null && Math.abs(cur - then[key]) >= s.jumpSkip - 1e-9) return false;
    }
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
  let pick = null, shown = null, stance = 'new';
  if (called) {
    const a = assess(called);
    shown = a; stance = 'holding';
    if (passes(a, ...need.holding)) pick = a;
    if (lean && lean !== called) {
      const b = assess(lean);
      if (!s.lockCall && passes(b, ...need.switching, true) && entryOk(lean) && holds(b) && steady(lean)) { pick = b; stance = 'switching'; }
      else if (!pick) { shown = b; stance = 'switching'; }
    }
  } else if (lean) {
    shown = assess(lean);
    if (passes(shown, ...need.new, true) && !(mem.cooldownUntil > now) && entryOk(lean) && holds(shown) && steady(lean)) pick = shown;
  }
  const a = pick ?? shown;
  const [edgeNeed, confNeed] = need[stance];
  const callSide = pick?.side ?? null;
  const prob = callSide ? (callSide === 'YES' ? ev.pYes : 1 - ev.pYes) : null;
  const firstOnly = s.scaleIn && callSide && callSide !== called; // a brand-new scaled call starts small
  const contracts = callSide ? Math.max(1, Math.floor(contractsFor(prob, pick.price, s) * (pick.deep ? pick.deep.sizeMult : 0.5) * (firstOnly ? s.firstSize : 1))) : 0;
  const buyNow = !!callSide && pick.timing.state === 'NOW';
  // fire = a new call worth an alert (first call, or a real switch); holding the same call doesn't re-alert
  const fire = !!callSide && callSide !== called && (buyNow || !s.waitForDip);
  // Max price: the most you can pay and still clear limitEdgeFrac × minEdge with vol 20% off either way
  const limit = callSide && pick.robustEdge != null ? maxPay(pick.robustEdge + pick.price + kalshiFee(pick.price), s.minEdge * s.limitEdgeFrac) : null;
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
  if (fire) { mem.side = callSide; mem.at = now; mem.price = pick.price; mem.n = (mem.n || 0) + 1; mem.tier = Math.max(0, Math.min(reached(pick.point), reached(pick.robustEdge))); }
  else if (callSide && callSide === called && tiers.length > 1 && pick.deep && (pick.score >= s.minConfidence || bigGap(pick))) {
    const next = (mem.tier ?? 0) + 1;
    if (next < tiers.length && Math.min(reached(pick.point), reached(pick.robustEdge)) >= next) { add = true; mem.tier = Math.min(reached(pick.point), reached(pick.robustEdge)); }
  }
  return {
    stability: stab, steadyNeed, bail: mem.bail ?? null,
    hold: a?.hold ?? null, holdOk: !!a && holds(a), steadyOk: !!a && steady(a.side), locked: !!s.lockCall && !!called,
    add, tier: mem.tier ?? null, callN: mem.n ?? 0, bigGap: !!pick && pick.score < s.minConfidence && bigGap(pick), // under the full bar but a huge gap (holding a call too)
    cooldown: !called && mem.cooldownUntil > now ? Math.ceil((mem.cooldownUntil - now) / 1000) : 0,
    side: a?.side ?? lean, callSide, price: pick?.price ?? null, limit, edge: pick?.point ?? null,
    timing: a?.timing ?? entrySignal(snap.bars, null, now), deep: a?.deep ?? null, robustEdge: a?.robustEdge ?? null,
    robust: a?.robustEdge != null && a.robustEdge >= edgeNeed - 1e-9, confident: !!callSide, buyNow, contracts, fire,
    stance: callSide ? (callSide === called || !called ? (called ? 'holding' : 'new') : 'switching') : stance, called, calledAt: mem.at ?? null, edgeNeed, confNeed,
    // the bot already called a side and is sticking with it while the other side wiggles
    sticking: !!called && !!lean && lean !== called && callSide !== lean,
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

const btc = (spot) => (spot ? ` · BTC $${Math.round(spot).toLocaleString('en-US')}` : '');

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
  const where = strike ? ` (BTC ${side === 'YES' ? 'above' : 'below'} $${Math.round(strike).toLocaleString('en-US')})` : '';
  return {
    tag: `buy-${m.ticker}`,
    title: `${sig.stance === 'switching' ? 'Switch: buy' : (sig.deep?.score ?? 0) >= 90 && (sig.hold ?? 0) >= 0.9 ? 'Confident buy:' : 'Buy the low:'} ${sideName(side)} at ${pc(price)}${sig.limit ? ` · max ${pc(sig.limit)}` : ''}`,
    body: `${sig.limit ? `Act now: buy only at ${pc(sig.limit)} or less, skip if it's higher. ` : ''}Kalshi ${pc(price)} vs bot ${pc(bot)} · buy ${dollars(sig.contracts * price)}${where}` +
      `${sig.deep ? ` · confidence ${sig.deep.score}${sig.bigGap ? ' · big-gap exception' : ''}` : ''}${sig.hold != null ? ` · holds ${Math.round(sig.hold * 100)}%` : ''}${sig.buyNow ? ' · candle dip too' : ''}${btc(spot)}`,
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
  const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
  const parts = [];
  if (prev) {
    const money = `${prev.paperUsd >= 0 ? '+' : '-'}$${Math.abs(prev.paperUsd).toFixed(2)}`;
    parts.push(`${hm(prev.openTime, tz)} window settled ${prev.result.toUpperCase()} · bot had ${pc(prev.avgWinnerOdds)} on the winner` +
      `${prev.calls ? ` · follow-the-bot ${money}` : ''}.`);
  }
  const lean = ev.pYes >= 0.5 ? `YES ${pc(ev.pYes)}` : `NO ${pc(1 - ev.pYes)}`;
  const diff = spot && strike ? ` (${spot >= strike ? '+' : '-'}${usd(Math.abs(spot - strike))})` : '';
  const startsLater = ev.callsAt && now < ev.callsAt ? ` · calls start ${hm(ev.callsAt, tz)}` : '';
  parts.push(`Now BTC ${spot ? usd(spot) : '—'}${diff} · bot leans ${lean}${sig?.callSide ? ` · BUY THE LOW ${sideName(sig.callSide)} at ${pc(sig.price)}` : startsLater}.`);
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
    body: `The gap grew to ${(sig.edge * 100).toFixed(0)} pts (Kalshi ${pc(price)} vs bot ${pc(bot)}) · add ${dollars(sig.contracts * price)}${btc(spot)}`,
  };
}

export function sellMessage(pos, check, spot) {
  const { ex, bid } = check;
  const money = `${ex.pnl >= 0 ? '+' : '-'}$${Math.abs(ex.pnl).toFixed(2)}`;
  const cashOut = ex.net != null ? ` · cash out ${dollars(ex.net * pos.contracts)}` : '';
  return { tag: `sell-${pos.id}`, title: `${ex.kind === 'take' ? 'SELL HIGH' : ex.kind === 'cut' ? 'BAIL' : ex.kind === 'bail' ? 'BAIL OUT' : 'SELL NOW'}: ${sideName(pos.side)} at ${pc(bid)}${cashOut} (${money})`, body: `${ex.why}${btc(spot)}` };
}
