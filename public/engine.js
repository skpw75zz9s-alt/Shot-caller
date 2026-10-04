// Decision logic shared by the phone app and the server's push bot, so both
// make the same calls from the same data.
import { DEFAULTS, effectiveVol, evaluate, exitSignal, kalshiFee, momentum, probYes, quote, realizedVol } from './model.js';
import { entrySignal, flipSigns, withLiveBar } from './candles.js';
import { deepDive, freshRejection, quoteTrend, rejections } from './analysis.js';

// Coinbase rows: [time, low, high, open, close, volume], newest first
export const parseCandles = (rows) =>
  rows.map((r) => ({ t: r[0] * 1000, l: r[1], h: r[2], o: r[3], c: r[4] })).sort((a, b) => a.t - b.t);

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
function settlementSoFar(log, close, spot, now) {
  if (!spot || Number.isNaN(close) || now < close - 60000 || now >= close) return null;
  const xs = log.filter((e) => e.t >= close - 60000 && e.s > 0).map((e) => e.s);
  xs.push(spot);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Everything the bot knows at one moment: candles with the live bar, vol, drift, rejection trends
// and a call per market. `quoteLog` (ticker -> [{ t, yesAsk, noAsk }]) collects Kalshi prices over time.
export function snapshot({ markets, candles, spot, settings, strikes = {}, quoteLog = {}, now = Date.now() }) {
  const s = { ...DEFAULTS, ...settings };
  const bars = withLiveBar(candles, spot, now);
  const closes = bars.map((c) => c.c);
  const sigmaLong = longVol(closes.slice(-121));
  const sigmaMin = effectiveVol(realizedVol(closes.slice(-121)), sigmaLong, s.minVol);
  const driftMin = momentum(closes, 10);
  const rows = markets.map((m) => {
    const strike = strikeFor(m, candles, strikes, now);
    const rej = rejections(bars, strike, Date.parse(m.open_time), now);
    const pShift = rej.tilt * s.rejectionWeight * tiltSign(m);
    const q = quote(m);
    const log = (quoteLog[m.ticker] ||= []);
    const settleAvg = settlementSoFar(log, Date.parse(m.close_time), spot, now);
    const ev = evaluate({ market: m, strike, spot, sigmaMin, driftMin, pShift, settleAvg, now, settings: s });
    if (!log.length || now - log[log.length - 1].t >= 2000) log.push({ t: now, yesAsk: q.yesAsk, noAsk: q.noAsk, p: ev.pYes, s: spot });
    while (log.length && log[0].t < now - 15 * 60000) log.shift();
    return { m, strike, rej, ev, settleAvg };
  });
  for (const t of Object.keys(quoteLog)) if (!markets.some((m) => m.ticker === t)) delete quoteLog[t];
  return { now, bars, spot, sigmaMin, sigmaLong, driftMin, quoteLog, rows, live: rows.find((r) => r.ev.minutesLeft > 0) ?? null };
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
  const p0 = probYes(row.m, row.strike, snap.spot, snap.sigmaMin * s.volMultiplier * volScale, row.ev.minutesLeft, keptDrift, row.settleAvg);
  const ask = side === 'YES' ? row.ev.quote.yesAsk : row.ev.quote.noAsk;
  if (p0 == null || ask == null) return null;
  const pS = Math.min(0.999, Math.max(0.001, p0 + keptShift));
  return (side === 'YES' ? pS : 1 - pS) - ask - kalshiFee(ask);
}

// Should this market fire a BUY THE LOW alert right now? Two gates, both tested for profit:
// 1) robust edge: the gap must clear minEdge even if volatility is 20% lower or 25% higher than measured
//    (an edge that only exists at one vol guess is mostly model error, and those trades lost money);
// 2) the deep dive's confidence must clear minConfidence. Position size scales with confidence.
export function buySignal(row, snap, settings, now = snap.now) {
  const s = { ...DEFAULTS, ...settings };
  const side = leanSide(row.ev);
  const timing = entrySignal(snap.bars, side, now);
  let stressEdge = null, robustEdge = null;
  if (side && snap.sigmaMin && snap.spot && row.ev.minutesLeft > 0) {
    const edges = [0.8, 1, 1.25].map((k) => edgeUnder(row, snap, s, side, k));
    if (edges.every((e) => e != null)) { stressEdge = edges[2]; robustEdge = Math.min(...edges); }
  }
  const deep = deepDive({
    ev: row.ev, side, rej: row.rej, timing, sigmaMin: snap.sigmaMin, sigmaLong: snap.sigmaLong, driftMin: snap.driftMin,
    spot: snap.spot, strike: row.strike, kalshiDrift: quoteTrend(snap.quoteLog?.[row.m.ticker], side, now),
    bars: snap.bars, log: snap.quoteLog?.[row.m.ticker], now, minEdge: s.minEdge, stressEdge,
  });
  const robust = robustEdge != null && robustEdge >= s.minEdge - 1e-9;
  const confident = !!deep && deep.score >= s.minConfidence && robust;
  const buyNow = !!row.ev.side && timing.state === 'NOW';
  const contracts = row.ev.side ? Math.max(1, Math.floor(row.ev.contracts * (deep ? deep.sizeMult : 0.5))) : 0;
  return { side, timing, deep, robustEdge, robust, confident, buyNow, contracts, fire: !!row.ev.side && confident && (buyNow || !s.waitForDip) };
}

// Exit check for one tracked position. Updates pos.peakBid / pos.peakP after the check
// (so drops are measured from earlier highs) and reports whether they changed.
export function positionCheck(pos, snap, settings, now = snap.now) {
  const { rows, bars } = snap;
  const row = rows.find((r) => r.m.ticker === pos.ticker) ?? null;
  const minutesLeft = (Date.parse(pos.closeTime) - now) / 60000;
  const pYes = row?.ev.pYes ?? null;
  const pSide = pYes == null ? null : pos.side === 'YES' ? pYes : 1 - pYes;
  const bid = row ? (pos.side === 'YES' ? row.ev.quote.yesBid : row.ev.quote.noBid) : null;
  const flips = flipSigns(bars, pos.side, now);
  const rejFlip = freshRejection(row?.rej, pos.side, now);
  if (rejFlip) flips.push(rejFlip);
  const ex = exitSignal({ pos, bid, pSide, flips, minutesLeft, settings });
  let changed = false;
  if (bid != null && (pos.peakBid == null || bid > pos.peakBid)) { pos.peakBid = bid; changed = true; }
  if (pSide != null && (pos.peakP == null || pSide > pos.peakP)) { pos.peakP = pSide; changed = true; }
  return { row, minutesLeft, pSide, bid, ex, changed };
}

// ---------- alert wording (same on push and in-app) ----------
const pc = (v) => `${(v * 100).toFixed(0)}%`;
const dollars = (v) => `$${v.toFixed(2)}`;
export const sideName = (side) => (side === 'YES' ? 'YES · Above' : 'NO · Below');

const btc = (spot) => (spot ? ` · BTC $${Math.round(spot).toLocaleString('en-US')}` : '');

export function buyMessage(row, sig, spot) {
  const { m, ev, strike } = row;
  const bot = ev.side === 'YES' ? ev.pYes : 1 - ev.pYes;
  const where = strike ? ` (BTC ${ev.side === 'YES' ? 'above' : 'below'} $${Math.round(strike).toLocaleString('en-US')})` : '';
  return {
    tag: `buy-${m.ticker}`,
    title: `Buy the low: ${sideName(ev.side)} at ${pc(ev.price)}`,
    body: `Kalshi ${pc(ev.price)} vs bot ${pc(bot)} · buy ${dollars(sig.contracts * ev.price)}${where}` +
      `${sig.deep ? ` · confidence ${sig.deep.score}` : ''}${sig.buyNow ? ' · candle dip too' : ''}${btc(spot)}`,
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
  parts.push(`Now BTC ${spot ? usd(spot) : '—'}${diff} · bot leans ${lean}${sig?.fire ? ` · BUY THE LOW ${sideName(ev.side)} at ${pc(ev.price)}` : startsLater}.`);
  return {
    tag: 'window-update',
    title: `🕒 ${hm(open, tz)}–${hm(close, tz)}${tz ? '' : ' UTC'} window · target ${strike ? usd(strike) : '—'}`,
    body: parts.join(' '),
  };
}

export function sellMessage(pos, check, spot) {
  const { ex, bid } = check;
  const money = `${ex.pnl >= 0 ? '+' : '-'}$${Math.abs(ex.pnl).toFixed(2)}`;
  const cashOut = ex.net != null ? ` · cash out ${dollars(ex.net * pos.contracts)}` : '';
  return { tag: `sell-${pos.id}`, title: `SELL NOW: ${sideName(pos.side)} at ${pc(bid)}${cashOut} (${money})`, body: `${ex.why}${btc(spot)}` };
}
