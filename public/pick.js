// The 10-minute pick (v13.23; exact math v13.26): every round, at 10:00 left, the bot locks a side by the math and keeps
// it to the close.
//   side     the side the bot's odds favour, or the official call's side when the bot has already called this round
//   p        the bot's full odds for that side (public/model.js probYes on Kalshi's settlement: the average of 60
//            one-second prints in the final minute, fat tails as tuned, plus every proven nudge: calibration from
//            graded rounds, the rejection tilt, the learned Kalshi blend and the Round scan). Checked against brute-force
//            simulation of the 60-print average (test/pick.test.js): within simulation noise
//   worst    the engine's own worst case (public/engine.js sideOdds): volatility 20% lower, as measured, or 25% higher,
//            keeping only the momentum and nudges that work against the side. Never above p
//   buy      only when it's also worth paying for: Kalshi's ask inside the official level's band (60-90c) and the
//            worst case beating that ask plus the exact fee on a $10 order by the level's gap (8c). Otherwise it's a
//            pick, not a buy: the direction the math leans, at a price that doesn't pay
//   kalshi   Kalshi's own odds for the side at the lock (its mid), the baseline the pick's math is graded against
// A pick is a lean, so it wins about as often as its odds say (a 70% pick loses 3 rounds in 10); buying every pick at
// Kalshi's price only pays where the bot is righter than Kalshi, which is what `buy` checks and the record measures.
import { DEFAULTS, feeEach } from './model.js';
import { sideOdds } from './engine.js';

export const PICK = { at: 10, window: 1, vols: [0.8, 1, 1.25] }; // minutes left when it locks (and how late a restarted server may still lock)

export function pickNow({ row, snap, settings = {}, side: forced = null }) {
  const s = { ...DEFAULTS, ...settings }, ev = row?.ev;
  if (!ev || ev.pYes == null || !(snap?.sigmaMin > 0)) return null;
  const lean = ev.pYes >= 0.5 ? 'YES' : 'NO', side = forced === 'YES' || forced === 'NO' ? forced : lean;
  const p = side === 'YES' ? ev.pYes : 1 - ev.pYes;
  const ws = PICK.vols.map((k) => sideOdds(row, snap, s, side, k)).filter((v) => v != null);
  const worst = ws.length ? Math.min(p, ...ws) : null;
  const q = ev.quote, ask = side === 'YES' ? q.yesAsk : q.noAsk, bid = side === 'YES' ? q.yesBid : q.noBid;
  const n10 = ask > 0 ? Math.max(1, Math.floor(10 / ask + 1e-9)) : 0; // the $10 order the record is scored on
  const gap = ask != null && worst != null && n10 ? worst - ask - feeEach(ask, n10) : null;
  const kalshi = ask != null && bid != null ? (ask + bid) / 2 : ask; // Kalshi's odds for the side
  const inBand = ask != null && (!(s.minAsk > 0) || ask >= s.minAsk - 1e-9) && (!(s.maxAsk > 0) || ask <= s.maxAsk + 1e-9);
  const buy = inBand && gap != null && gap >= s.minEdge - 1e-9;
  const c = (x) => `${Math.round(x * 100)}¢`;
  const why = (side !== lean ? 'the official call stands for this round; ' : '') + (buy ? `worth buying: even in the worst case it beats Kalshi's ${c(ask)} by ${c(gap)} after the fee`
    : ask == null ? 'no Kalshi price to buy at'
    : !inBand ? `a pick, not a buy: Kalshi asks ${c(ask)}, outside ${Math.round((s.minAsk || 0) * 100)}-${Math.round((s.maxAsk || 1) * 100)}¢`
    : `a pick, not a buy: at ${c(ask)} the worst-case edge is ${gap == null ? '—' : c(gap)}, under the ${c(s.minEdge)} it takes to pay`);
  return { side, p, worst, ask, bid, kalshi, gap, buy, why, official: side !== lean, strike: row.strike, spot: snap.mSpot ?? snap.spot, minutesLeft: ev.minutesLeft };
}

// The picks' scorecard: did the math's odds beat Kalshi's? Brier score (mean squared error of the odds against what
// happened; lower is better, 0.25 = always 50%) for the bot and for Kalshi's mid at the same moment, and calibration by
// odds band (said vs won). Only picks that stored Kalshi's odds are compared head to head.
export function pickScore(picks) {
  const graded = (picks || []).filter((e) => (e.result === 'yes' || e.result === 'no') && e.p != null);
  const won = (e) => (e.side.toLowerCase() === e.result ? 1 : 0);
  const both = graded.filter((e) => e.kalshi != null);
  const brier = (xs, f) => (xs.length ? xs.reduce((a, e) => a + (f(e) - won(e)) ** 2, 0) / xs.length : null);
  const bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
    const xs = graded.filter((e) => e.p >= lo && e.p < hi);
    return { lo, hi: Math.min(hi, 1), n: xs.length, said: xs.length ? xs.reduce((a, e) => a + e.p, 0) / xs.length : null, won: xs.length ? xs.reduce((a, e) => a + won(e), 0) / xs.length : null };
  });
  return { n: graded.length, brier: brier(graded, (e) => e.p), vs: both.length, brierBot: brier(both, (e) => e.p), brierKalshi: brier(both, (e) => e.kalshi), bands };
}
