// The 10-minute pick (v13.23; exact math v13.26; bot + Kalshi v13.28): every round, at 10:00 left, the bot locks a side and
// keeps it to the close.
//   pb       the bot's full odds for the side (public/model.js probYes on Kalshi's settlement: the average of 60 one-second
//            prints in the final minute, fat tails as tuned, plus every proven nudge). Checked against brute-force
//            simulation of the 60-print average (test/pick.test.js): within simulation noise
//   kalshi   Kalshi's own odds for the side (its mid). At 10 minutes out the market is a strong forecaster: on the bot's
//            own walk-forward history, extra chart signals added nothing over distance-to-target odds, so the one real
//            source of extra information is the price the market sets
//   p        the pick's odds: the two combined in log-odds space, mix x logit(bot) + (1 - mix) x logit(Kalshi). The mix
//            starts at half and half (two decent forecasts with different errors beat either alone) and, from 30
//            graded picks, is the share (0, 1/4, 1/2, 3/4 or all bot) whose odds scored best on the pick's own record
//            (log loss; pickMix). Kalshi is left out when its spread is wider than 10c (no real price)
//   side     the side p favours, or the official call's side when the bot has already called this round
//   worst    the engine's worst case for the bot (public/engine.js sideOdds: volatility 20% lower, as measured, or 25%
//            higher, keeping only the momentum and nudges that work against the side), combined with Kalshi the same
//            way. Never above p
//   buy      only when it's also worth paying for: Kalshi's ask inside the official level's band (60-90c) and the
//            worst case beating that ask plus the exact fee on a $10 order by the level's gap (8c). With Kalshi in the
//            odds that takes a bigger disagreement than before: the bot has to be clearly righter than the market
// A pick is a lean, so it wins about as often as its odds say (a 70% pick loses 3 rounds in 10). No mix makes a round
// 10 minutes from its close predictable; the record shows how the pick's odds compare with the bot's and Kalshi's alone.
import { DEFAULTS, feeEach } from './model.js';
import { sideOdds } from './engine.js';

export const PICK = { at: 10, window: 1, vols: [0.8, 1, 1.25], mix: 0.5, mixes: [0, 0.25, 0.5, 0.75, 1], learnFrom: 30, maxSpread: 0.1 }; // at: minutes left when it locks (window: how late a restarted server may still lock)

const clampP = (p) => Math.min(0.995, Math.max(0.005, p));
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
// the bot's odds and Kalshi's combined in log-odds space (mix = the bot's share); Kalshi missing: the bot's alone
// odds pulled toward 50% (t > 1) or pushed away from it (t < 1) on the log-odds scale: the tune-up's calibration
// (public/tuneup.js); t = 1 leaves them alone
export const calibrate = (p, t = 1) => (p == null || t === 1 ? p : 1 / (1 + Math.exp(-logit(p) / t)));
export const mixOdds = (pBot, pKalshi, mix) => (pKalshi == null || mix >= 1 ? pBot : 1 / (1 + Math.exp(-(mix * logit(pBot) + (1 - mix) * logit(pKalshi)))));

// The mix the pick uses: half and half until 30 graded picks have both odds stored, then the one whose combined odds had
// the lowest log loss on them. Picks from before v13.28 stored the bot's odds as p.
export function pickMix(picks) {
  const xs = (picks || []).filter((e) => (e.result === 'yes' || e.result === 'no') && e.kalshi != null && !e.fallback && (e.pb ?? e.p) != null);
  const won = (e) => e.side.toLowerCase() === e.result;
  const loss = (w) => xs.reduce((a, e) => { const q = clampP(mixOdds(e.pb ?? e.p, e.kalshi, w)); return a - Math.log(won(e) ? q : 1 - q); }, 0) / (xs.length || 1);
  if (xs.length < PICK.learnFrom) return { mix: PICK.mix, n: xs.length, learned: false };
  const scores = PICK.mixes.map((w) => ({ w, loss: loss(w) })), best = scores.reduce((a, b) => (b.loss < a.loss - 1e-12 ? b : a));
  return { mix: best.w, n: xs.length, learned: true, scores };
}

export function pickNow({ row, snap, settings = {}, side: forced = null, mix = PICK.mix, temp = 1 }) { // temp: the tune-up's calibration (1: none)
  const s = { ...DEFAULTS, ...settings }, ev = row?.ev;
  if (!ev || ev.pYes == null || !(snap?.sigmaMin > 0)) return null;
  const q = ev.quote, midYes = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null;
  const kYes = midYes != null && q.yesAsk - q.yesBid <= PICK.maxSpread + 1e-9 ? midYes : null, used = kYes != null && mix < 1;
  const pYes = mixOdds(ev.pYes, kYes, mix);
  const lean = pYes >= 0.5 ? 'YES' : 'NO', side = forced === 'YES' || forced === 'NO' ? forced : lean;
  const of = (y) => (y == null ? null : side === 'YES' ? y : 1 - y);
  const pb = of(ev.pYes), p = calibrate(of(pYes), temp), kalshi = of(midYes);
  const ws = PICK.vols.map((k) => sideOdds(row, snap, s, side, k)).filter((v) => v != null);
  const worstBot = ws.length ? Math.min(pb, ...ws) : null;
  const worst = worstBot == null ? null : Math.min(p, calibrate(used ? mixOdds(worstBot, of(kYes), mix) : worstBot, temp));
  const ask = side === 'YES' ? q.yesAsk : q.noAsk, bid = side === 'YES' ? q.yesBid : q.noBid;
  const n10 = ask > 0 ? Math.max(1, Math.floor(10 / ask + 1e-9)) : 0; // the $10 order the record is scored on
  const gap = ask != null && worst != null && n10 ? worst - ask - feeEach(ask, n10) : null;
  const inBand = ask != null && (!(s.minAsk > 0) || ask >= s.minAsk - 1e-9) && (!(s.maxAsk > 0) || ask <= s.maxAsk + 1e-9);
  const buy = inBand && gap != null && gap >= s.minEdge - 1e-9;
  const c = (x) => `${Math.round(x * 100)}¢`;
  const why = (side !== lean ? 'the official call stands for this round; ' : '') + (buy ? `worth buying: even in the worst case it beats Kalshi's ${c(ask)} by ${c(gap)} after the fee`
    : ask == null ? 'no Kalshi price to buy at'
    : !inBand ? `a pick, not a buy: Kalshi asks ${c(ask)}, outside ${Math.round((s.minAsk || 0) * 100)}-${Math.round((s.maxAsk || 1) * 100)}¢`
    : `a pick, not a buy: at ${c(ask)} the worst-case edge is ${gap == null ? '—' : c(gap)}, under the ${c(s.minEdge)} it takes to pay`);
  return { side, p, pb, kalshi, mix: used ? mix : 1, temp, worst, worstBot, ask, bid, gap, buy, why, official: side !== lean, strike: row.strike, spot: snap.mSpot ?? snap.spot, minutesLeft: ev.minutesLeft };
}

// The guaranteed pick (v13.43.3): every round gets a side after the first 5 minutes, even when the bot's own odds can't
// be worked out yet (no fresh price or volatility): then Kalshi's favourite (its mid price), else the side price is on.
// Marked fallback, never a buy; graded like any pick.
export function pickFallback({ row, snap }) {
  const ev = row?.ev, q = ev?.quote ?? {}, m = row?.m ?? {}, less = /^less/.test(m.strike_type || '');
  const midYes = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : q.yesAsk ?? q.yesBid ?? null;
  const spot = snap?.mSpot ?? snap?.spot ?? null;
  let side = null, by = null;
  if (midYes != null && midYes !== 0.5) { side = midYes > 0.5 ? 'YES' : 'NO'; by = 'kalshi'; }
  else if (spot > 0 && row?.strike > 0 && spot !== row.strike) { side = (spot > row.strike) !== less ? 'YES' : 'NO'; by = 'price'; }
  if (!side) return null;
  const p = midYes != null ? (side === 'YES' ? midYes : 1 - midYes) : 0.5;
  const ask = side === 'YES' ? q.yesAsk ?? null : q.noAsk ?? null, bid = side === 'YES' ? q.yesBid ?? null : q.noBid ?? null;
  const why = by === 'kalshi' ? 'the bot\'s own odds weren\'t ready, so this is Kalshi\'s favourite; a pick, not a buy' : 'the bot\'s own odds weren\'t ready, so this is the side price is on; a pick, not a buy';
  return { side, p, pb: null, kalshi: midYes != null ? p : null, mix: 0, worst: null, worstBot: null, ask, bid, gap: null, buy: false, why, official: false, fallback: by, strike: row?.strike ?? null, spot, minutesLeft: ev?.minutesLeft ?? null };
}
export const pickAlways = (args) => pickNow(args) ?? pickFallback(args);

// The picks' scorecard: Brier score (mean squared error of the odds against what happened; lower is better, 0.25 =
// always 50%) for the pick's odds, the bot's alone and Kalshi's mid at the same moment, on the picks that stored them,
// and calibration by odds band (said vs won)
export function pickScore(picks) {
  const graded = (picks || []).filter((e) => (e.result === 'yes' || e.result === 'no') && e.p != null);
  const won = (e) => (e.side.toLowerCase() === e.result ? 1 : 0);
  const both = graded.filter((e) => e.kalshi != null && !e.fallback); // fallback picks are Kalshi's own side: no bot-vs-Kalshi test
  const brier = (xs, f) => (xs.length ? xs.reduce((a, e) => a + (f(e) - won(e)) ** 2, 0) / xs.length : null);
  const bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
    const xs = graded.filter((e) => e.p >= lo && e.p < hi);
    return { lo, hi: Math.min(hi, 1), n: xs.length, said: xs.length ? xs.reduce((a, e) => a + e.p, 0) / xs.length : null, won: xs.length ? xs.reduce((a, e) => a + won(e), 0) / xs.length : null };
  });
  return { n: graded.length, brier: brier(graded, (e) => e.p), vs: both.length, brierPick: brier(both, (e) => e.p), brierBot: brier(both, (e) => e.pb ?? e.p), brierKalshi: brier(both, (e) => e.kalshi), bands };
}
