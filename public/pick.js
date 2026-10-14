// The 10-minute pick (v13.23): every round, at 10:00 left, the bot locks a side by the math and keeps it to the close.
//   side     the side the bot's odds favour (public/model.js probYes: distance to the target in typical moves for the
//            time left, Kalshi's 60-second settlement average, fat tails, momentum, and every proven nudge)
//   p        those odds for the side
//   worst    the same odds with volatility 20% lower or 25% higher and only momentum against the side kept: the
//            worst of the three (the pick's "even if the bot is a bit wrong" number)
//   buy      only when it's also worth paying for: Kalshi's ask inside the official level's band (60-90c) and the
//            worst case beating that ask plus its fee by the level's gap (8c). Otherwise it's a pick, not a buy:
//            the direction the math leans, at a price that doesn't pay
// A pick is a lean, so it wins about as often as its odds say (a 70% pick loses 3 rounds in 10); buying every pick at
// Kalshi's price only pays where the bot is righter than Kalshi, which is what `buy` checks.
import { DEFAULTS, feeEach, probYes } from './model.js';

export const PICK = { at: 10, window: 1 }; // minutes left when it locks (and how late a restarted server may still lock)

export function pickNow({ row, snap, settings = {} }) {
  const s = { ...DEFAULTS, ...settings }, ev = row?.ev;
  if (!ev || ev.pYes == null || !(snap?.sigmaMin > 0)) return null;
  const side = ev.pYes >= 0.5 ? 'YES' : 'NO', p = side === 'YES' ? ev.pYes : 1 - ev.pYes, dir = side === 'YES' ? 1 : -1;
  const drift = (snap.driftMin || 0) * (snap.momentumWeight ?? s.momentumWeight), kept = drift * dir > 0 ? 0 : drift;
  const odds = (k) => { const q = probYes(row.m, row.strike, snap.mSpot ?? snap.spot, (row.sigma ?? snap.sigmaMin) * s.volMultiplier * k, ev.minutesLeft, kept, row.settleAvg, snap.volTails ?? s.volTails); return q == null ? null : side === 'YES' ? q : 1 - q; };
  const ws = [0.8, 1, 1.25].map(odds).filter((v) => v != null), worst = ws.length ? Math.min(...ws) : null;
  const ask = side === 'YES' ? ev.quote.yesAsk : ev.quote.noAsk, bid = side === 'YES' ? ev.quote.yesBid : ev.quote.noBid;
  const gap = ask != null && worst != null ? worst - ask - feeEach(ask, Math.max(1, Math.floor(10 / ask))) : null;
  const inBand = ask != null && (!(s.minAsk > 0) || ask >= s.minAsk - 1e-9) && (!(s.maxAsk > 0) || ask <= s.maxAsk + 1e-9);
  const buy = inBand && gap != null && gap >= s.minEdge - 1e-9;
  const why = buy ? `worth buying: even in the worst case it beats Kalshi's ${Math.round(ask * 100)}¢ by ${Math.round(gap * 100)}¢ after the fee`
    : ask == null ? 'no Kalshi price to buy at'
    : !inBand ? `a pick, not a buy: Kalshi asks ${Math.round(ask * 100)}¢, outside ${Math.round((s.minAsk || 0) * 100)}-${Math.round((s.maxAsk || 1) * 100)}¢`
    : `a pick, not a buy: at ${Math.round(ask * 100)}¢ the worst-case edge is ${gap == null ? '—' : `${Math.round(gap * 100)}¢`}, under the ${Math.round(s.minEdge * 100)}¢ it takes to pay`;
  return { side, p, worst, ask, bid, gap, buy, why, strike: row.strike, spot: snap.mSpot ?? snap.spot, minutesLeft: ev.minutesLeft };
}
