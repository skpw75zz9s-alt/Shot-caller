// Decision logic shared by the phone app and the server's push bot, so both
// make the same calls from the same data.
import { evaluate, exitSignal, momentum, realizedVol } from './model.js';
import { entrySignal, flipSigns, withLiveBar } from './candles.js';

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

// Everything the bot knows at one moment: candles with the live bar, vol, drift and a call per market.
export function snapshot({ markets, candles, spot, settings, strikes = {}, now = Date.now() }) {
  const bars = withLiveBar(candles, spot, now);
  const closes = bars.map((c) => c.c);
  const sigmaMin = realizedVol(closes.slice(-121));
  const driftMin = momentum(closes, 10);
  const rows = markets.map((m) => {
    const strike = strikeFor(m, candles, strikes, now);
    return { m, strike, ev: evaluate({ market: m, strike, spot, sigmaMin, driftMin, now, settings }) };
  });
  return { now, bars, spot, sigmaMin, driftMin, rows, live: rows.find((r) => r.ev.minutesLeft > 0) ?? null };
}

// The side the model leans to, even below the edge threshold, so timing has something to read.
export const leanSide = (ev) =>
  ev.side ?? (ev.evYes == null && ev.evNo == null ? null : (ev.evYes ?? -1) >= (ev.evNo ?? -1) ? 'YES' : 'NO');

// Should this market fire a BUY THE LOW alert right now?
export function buySignal(row, bars, settings, now = Date.now()) {
  const side = leanSide(row.ev);
  const timing = entrySignal(bars, side, now);
  const buyNow = !!row.ev.side && timing.state === 'NOW';
  return { side, timing, buyNow, fire: !!row.ev.side && (buyNow || !settings.waitForDip) };
}

// Exit check for one tracked position. Updates pos.peakBid / pos.peakP after the check
// (so drops are measured from earlier highs) and reports whether they changed.
export function positionCheck(pos, rows, bars, settings, now = Date.now()) {
  const row = rows.find((r) => r.m.ticker === pos.ticker) ?? null;
  const minutesLeft = (Date.parse(pos.closeTime) - now) / 60000;
  const pYes = row?.ev.pYes ?? null;
  const pSide = pYes == null ? null : pos.side === 'YES' ? pYes : 1 - pYes;
  const bid = row ? (pos.side === 'YES' ? row.ev.quote.yesBid : row.ev.quote.noBid) : null;
  const ex = exitSignal({ pos, bid, pSide, flips: flipSigns(bars, pos.side, now), minutesLeft, settings });
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
    body: `Kalshi ${pc(ev.price)} vs bot ${pc(bot)} · buy ${dollars(ev.contracts * ev.price)}${where}${sig.buyNow ? ' · candle dip too' : ''}${btc(spot)}`,
  };
}

export function sellMessage(pos, check, spot) {
  const { ex, bid } = check;
  const money = `${ex.pnl >= 0 ? '+' : '-'}$${Math.abs(ex.pnl).toFixed(2)}`;
  return { tag: `sell-${pos.id}`, title: `SELL NOW: ${sideName(pos.side)} at ${pc(bid)} (${money})`, body: `${ex.why}${btc(spot)}` };
}
