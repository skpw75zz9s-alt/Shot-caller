// Pricing model for Kalshi 15-minute BTC markets.
// Pure functions only, shared by the browser app and the Node tests.

export function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation of erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// The volatility the model prices with: short-term EWMA vol, but never far below the 2-hour vol and
// never below a floor. A few frozen minutes (thin overnight tape, stale ticks) would otherwise make
// the bot ~100% sure of a $2 lead.
export function effectiveVol(ewma, long, minVol = 0.00008) {
  if (!ewma && !long) return null;
  return Math.max(ewma || 0, 0.6 * (long || 0), minVol);
}

// Per-minute log-return volatility from a list of closes (oldest first), EWMA-weighted.
export function realizedVol(closes, lambda = 0.94) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return null;
  let v = rets.slice(0, 10).reduce((a, r) => a + r * r, 0) / Math.min(10, rets.length);
  for (const r of rets) v = lambda * v + (1 - lambda) * r * r;
  return Math.sqrt(v);
}

// Mean per-minute log return over the last `n` minutes.
export function momentum(closes, n = 10) {
  if (closes.length < n + 1) return 0;
  const a = closes[closes.length - 1 - n];
  const b = closes[closes.length - 1];
  return a > 0 && b > 0 ? Math.log(b / a) / n : 0;
}

// Kalshi settles these markets on the average of the index over the final
// `w` minutes, which has less variance than a single print.
export function settleVariance(sigmaMin, minutesLeft, w = 1) {
  const t = Math.max(minutesLeft, 0);
  if (t >= w) return sigmaMin * sigmaMin * (t - w + w / 3);
  return (sigmaMin * sigmaMin * t ** 3) / (3 * w * w);
}

// P(settlement value > K). In the final `w` minutes part of the settlement average is already printed:
// pass `settleAvg` (the average of prices since close − w) so the locked-in part counts at face value.
export function probAbove(S, K, sigmaMin, minutesLeft, driftMin = 0, w = 1, settleAvg = null) {
  const t = Math.max(minutesLeft, 0);
  if (settleAvg != null && t < w) {
    const mean = (1 - t / w) * settleAvg + (t / w) * S * Math.exp(driftMin * t);
    const sd = S * Math.sqrt(settleVariance(sigmaMin, t, w));
    return sd > 0 ? normCdf((mean - K) / sd) : mean > K ? 1 : mean < K ? 0 : 0.5;
  }
  const variance = settleVariance(sigmaMin, minutesLeft, w);
  const mu = Math.log(S / K) + driftMin * t;
  if (variance <= 0) return mu > 0 ? 1 : mu < 0 ? 0 : 0.5;
  return normCdf(mu / Math.sqrt(variance));
}

// Kalshi taker fee per contract (in dollars) at price p in dollars: 0.07·p·(1−p), rounded up to the cent.
export function kalshiFee(p, contracts = 1) {
  return Math.ceil(0.07 * contracts * p * (1 - p) * 100 - 1e-9) / 100;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// Normalize a Kalshi market's quotes to dollars (0–1). Handles both the cents and *_dollars fields.
export function quote(m) {
  const pick = (k) => {
    const d = num(m[`${k}_dollars`]);
    if (d !== null && !Number.isNaN(d)) return d;
    const c = num(m[k]);
    return c !== null && !Number.isNaN(c) ? c / 100 : null;
  };
  let yesBid = pick('yes_bid'), yesAsk = pick('yes_ask'), noBid = pick('no_bid'), noAsk = pick('no_ask');
  if (noAsk === null && yesBid !== null) noAsk = 1 - yesBid;
  if (noBid === null && yesAsk !== null) noBid = 1 - yesAsk;
  // A side with no offers shows up as ask 0 or 1, which can't be bought.
  if (yesAsk !== null && (yesAsk <= 0 || yesAsk >= 1)) yesAsk = null;
  if (noAsk !== null && (noAsk <= 0 || noAsk >= 1)) noAsk = null;
  return { yesBid, yesAsk, noBid, noAsk, last: pick('last_price') };
}

// Model probability that the market resolves YES, based on its strike definition.
export function probYes(m, strike, S, sigmaMin, minutesLeft, driftMin, settleAvg = null) {
  const type = m.strike_type || 'greater';
  const floor = num(m.floor_strike) ?? strike;
  const cap = num(m.cap_strike);
  const above = (k) => probAbove(S, k, sigmaMin, minutesLeft, driftMin, 1, settleAvg);
  switch (type) {
    case 'greater':
    case 'greater_or_equal':
      return floor ? above(floor) : null;
    case 'less':
    case 'less_or_equal':
      return cap ? 1 - above(cap) : floor ? 1 - above(floor) : null;
    case 'between':
      return floor && cap ? above(floor) - above(cap) : null;
    default:
      return floor ? above(floor) : null;
  }
}

export const DEFAULTS = {
  minEdge: 0.06,        // required EV per contract after fees, in dollars, even with vol 20% off either way (Balanced)
  maxSpread: 0.10,      // skip markets with a wider yes spread
  minMinutesLeft: 0.5,  // don't call shots in the last 30 seconds
  maxMinutesLeft: 14,   // or right after open when the strike is barely set
  waitMinutes: 5,       // watch the first 5 minutes of each window before making any call
  volMultiplier: 1.0,   // 1 = price with measured vol (1.15 overstated real 15-min swings ~1.3x)
  momentumWeight: 0,    // fraction of recent drift to carry forward (real BTC/ETH/SOL data: drift doesn't carry)
  kellyFraction: 0.25,
  bankroll: 100,
  maxStake: 25,
  minVol: 0.00008,      // volatility floor per minute (0.8 bp, ~$7/min at $85k): frozen tapes aren't certainty
  minConfidence: 55,    // deep-dive score (0-100) a call needs before it fires (Balanced)
  rejectionWeight: 1,   // how much rejection trends move the odds (0 = off, 1 = up to ±5 pts)
  holdEdgeFrac: 0.5,    // once called, the call stands while the robust gap is at least half of minEdge...
  holdConfDrop: 10,     // ...and confidence is no more than 10 below minConfidence
  switchEdgeExtra: 0.04, // calling the OTHER side in the same window needs 4 pts more gap...
  switchConfExtra: 15,   // ...and 15 more confidence
  persistSec: 0,        // a new call needs its gap to have held this long (edges that last survive your reaction time)
  limitEdgeFrac: 0.5,   // max price on a call: still clears this share of minEdge even with vol 20% off
  marketWeight: 0,      // blend Kalshi's own mid into the bot's odds (0 = bot only)
  maxEdge: 1,           // a gap bigger than this is too good to be true (usually a lag that's gone before you can buy)
  scaleIn: false,       // add to a call as its gap grows past minEdge +2, +4 and +8 pts (Aggressive)
  scaleStep: 0.02,      // spacing of the scale-in tiers: minEdge +1, +2 and +4 steps
  firstSize: 1,         // with scaleIn, the first entry is this fraction of the normal size (adds carry the rest)
  reentrySec: 15,       // after selling, a new call on the same market can fire this many seconds later
};

// Risk levels (Settings). All levels re-enter after selling. Aggressive also scales in as the gap grows and
// bets twice the size (half Kelly, $50 max). Simulated with instant fills it made 2-11x Safe's profit where
// there was an edge, with ~2x its own swings; sizing multiplies losses by the same factor as wins.
export const RISK_LEVELS = {
  safe: { label: 'Safe', minEdge: 0.08, minConfidence: 60, practiceConfidence: 70, scaleIn: false, kellyFraction: 0.25, maxStake: 25, practiceMax: 5, practiceLoss: 20, hint: 'Fewest calls, biggest gaps only' },
  balanced: { label: 'Balanced', minEdge: 0.06, minConfidence: 55, practiceConfidence: 60, scaleIn: false, kellyFraction: 0.25, maxStake: 25, practiceMax: 5, practiceLoss: 20, hint: 'About 2× the calls of Safe' },
  aggressive: { label: 'Aggressive', minEdge: 0.04, minConfidence: 50, practiceConfidence: 55, scaleIn: true, kellyFraction: 0.5, maxStake: 50, practiceMax: 10, practiceLoss: 40, hint: 'Most calls, adds as the gap grows, double-size bets: biggest wins and biggest swings' },
};
export const riskLevelOf = (s) => Object.keys(RISK_LEVELS).find((k) => Math.abs(RISK_LEVELS[k].minEdge - s.minEdge) < 1e-9 && RISK_LEVELS[k].minConfidence === s.minConfidence) ?? 'custom';

// Decide the call for one market.
// pShift nudges P(YES) by evidence the price model can't see (e.g. rejection trends), in probability points.
export function evaluate({ market, strike, spot, sigmaMin, driftMin = 0, pShift = 0, settleAvg = null, now = Date.now(), settings = {} }) {
  const s = { ...DEFAULTS, ...settings };
  const minutesLeft = (Date.parse(market.close_time) - now) / 60000;
  const q = quote(market);
  const out = { minutesLeft, quote: q, pYes: null, pBase: null, pShift: 0, evYes: null, evNo: null, call: 'PASS', reason: '', side: null, price: null, contracts: 0, edge: 0 };

  if (!spot || !sigmaMin) return { ...out, reason: 'Waiting for price data' };
  const p = probYes(market, strike, spot, sigmaMin * s.volMultiplier, minutesLeft, driftMin * s.momentumWeight, settleAvg);
  if (p === null) return { ...out, reason: 'Unknown strike' };
  out.pBase = p;
  out.pShift = pShift;
  out.pYes = Math.min(Math.max(p + pShift, 0.001), 0.999);

  if (q.yesAsk !== null) out.evYes = out.pYes - q.yesAsk - kalshiFee(q.yesAsk);
  if (q.noAsk !== null) out.evNo = (1 - out.pYes) - q.noAsk - kalshiFee(q.noAsk);

  if (minutesLeft < s.minMinutesLeft) return { ...out, reason: 'Too close to settlement' };
  // No calls until waitMinutes into the window (early calls are mostly momentum guesses at the target)
  const opened = Date.parse(market.open_time);
  const closes = Date.parse(market.close_time);
  out.callsAt = Math.max(Number.isNaN(opened) ? -Infinity : opened + s.waitMinutes * 60000, closes - s.maxMinutesLeft * 60000);
  if (now < out.callsAt) return { ...out, reason: `Watching the first ${s.waitMinutes} minutes before calling` };
  if (q.yesBid !== null && q.yesAsk !== null && q.yesAsk - q.yesBid > s.maxSpread) return { ...out, reason: 'Spread too wide' };
  out.open = true; // past the time, spread and data gates: calls are allowed now

  const best = (out.evYes ?? -1) >= (out.evNo ?? -1)
    ? { side: 'YES', ev: out.evYes, price: q.yesAsk, prob: out.pYes }
    : { side: 'NO', ev: out.evNo, price: q.noAsk, prob: 1 - out.pYes };
  if (best.ev === null || best.price === null) return { ...out, reason: 'No liquidity' };
  out.edge = best.ev;
  if (best.ev < s.minEdge) return { ...out, reason: `Best gap ${(best.ev * 100).toFixed(1)} pts, need ${(s.minEdge * 100).toFixed(1)}` };

  return {
    ...out,
    call: best.side,
    side: best.side,
    price: best.price,
    contracts: contractsFor(best.prob, best.price, s),
    reason: `Bot ${(best.prob * 100).toFixed(0)}% vs Kalshi ${(best.price * 100).toFixed(0)}%`,
  };
}

// Quarter-Kelly position size (in contracts) for win probability `prob` at `price`, capped at maxStake.
export function contractsFor(prob, price, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const cost = price + kalshiFee(price);
  const kelly = Math.max(0, (prob - cost) / (1 - cost)) * s.kellyFraction;
  return Math.max(1, Math.floor(Math.min(kelly * s.bankroll, s.maxStake) / cost));
}

// P&L per contract for a settled call.
export function settlePnl(call, result) {
  const fee = kalshiFee(call.price);
  const won = call.side.toLowerCase() === String(result).toLowerCase();
  return { won, pnl: ((won ? 1 : 0) - call.price - fee) * call.contracts };
}

// Most you can pay for a side with win probability p and still clear minEdge after fees.
export function maxPay(p, minEdge) {
  for (let c = 99; c >= 1; c--) {
    const price = c / 100;
    if (p - price - kalshiFee(price) >= minEdge - 1e-9) return price;
  }
  return null;
}

// Limit price for buying the low: the side's ask, shifted by how far the model's fair value
// moves if BTC reaches dipLevel, capped so a fill still clears minEdge at that level.
export function dipLimit({ market, strike, spot, dipLevel, sigmaMin, driftMin = 0, side, now = Date.now(), settings = {} }) {
  const s = { ...DEFAULTS, ...settings };
  if (!side || !spot || !dipLevel || !sigmaMin) return null;
  const minutesLeft = (Date.parse(market.close_time) - now) / 60000;
  const p = (S) => probYes(market, strike, S, sigmaMin * s.volMultiplier, minutesLeft, driftMin * s.momentumWeight);
  const pNow = p(spot), pDip = p(dipLevel);
  if (pNow === null || pDip === null) return null;
  const q = quote(market);
  const ask = side === 'YES' ? q.yesAsk ?? (q.noBid !== null ? 1 - q.noBid : null) : q.noAsk ?? (q.yesBid !== null ? 1 - q.yesBid : null);
  if (ask === null) return null;
  const sideDip = side === 'YES' ? pDip : 1 - pDip;
  const shift = side === 'YES' ? pDip - pNow : pNow - pDip;
  const cap = maxPay(sideDip, s.minEdge);
  if (cap === null) return null;
  const limit = Math.min(Math.floor((ask + shift) * 100 + 1e-9) / 100, cap);
  return limit >= 0.01 ? { price: limit, dipLevel, fairAtDip: sideDip } : null;
}

// Lowest sell price whose proceeds after the exit fee are at least `value`.
export function sellTarget(value) {
  for (let c = 1; c <= 99; c++) {
    const price = c / 100;
    if (price - kalshiFee(price) >= value - 1e-9) return price;
  }
  return 0.99;
}

export const EXIT_DEFAULTS = {
  minProfit: 0.01, // per contract after both fees, to count as "in profit"
  trail: 0.06,     // bid falling this far from its peak is a flip sign (shown, not a sell by itself)
  oddsDrop: 0.08,  // bot odds falling this far from their peak is a flip sign (shown, not a sell by itself)
  cutMargin: 0.03,   // a losing sell needs Kalshi to pay this much MORE than the bot's odds
  cutConfirmSec: 30, // ...and to keep doing so this long before SELL NOW (one bad tick isn't a reason)
  takeConfirmSec: 0, // same wait for a profitable sell
  smoothSec: 0,      // exit decisions use the bot's odds averaged over this many seconds
};

// When to sell an open position. pos = { side, price, contracts, peakBid, peakP }.
// bid is what the side sells for right now; pSide is the bot's current odds for that side.
// Sells only when Kalshi pays at least what holding is worth (net >= pSide). Flip signs are shown as a
// watch list but never force a sale below value: in testing, those early sells raised the win rate and
// lowered the profit (holding to settlement also skips the exit fee).
export function exitSignal({ pos, bid, pSide, flips = [], minutesLeft, settings = {} }) {
  const s = { ...EXIT_DEFAULTS, ...settings };
  if (minutesLeft <= 0) return { action: 'WAIT', kind: 'closed', why: 'Market closed. Settles at $1 or $0.', signs: [] };
  if (pSide == null) return { action: 'HOLD', kind: 'nodata', why: 'Waiting for price data', signs: [] };
  const entryCost = pos.price + kalshiFee(pos.price);
  const target = sellTarget(Math.max(pSide, entryCost + s.minProfit));
  if (bid == null || bid <= 0) return { action: 'HOLD', kind: 'nobid', why: 'No bids to sell into right now', holdEv: pSide, target, signs: [] };

  const net = bid - kalshiFee(bid);
  const pnlPer = net - entryCost;
  const base = { bid, net, pnlPer, pnl: pnlPer * pos.contracts, holdEv: pSide, target };
  const inProfit = pnlPer >= s.minProfit - 1e-9;
  const signs = [...flips];
  if (pos.peakP != null && pos.peakP - pSide >= s.oddsDrop) signs.push(`Bot odds down ${((pos.peakP - pSide) * 100).toFixed(0)} pts from peak`);
  if (pos.peakBid != null && pos.peakBid - bid >= s.trail - 1e-9) signs.push(`Sell price down to ${(bid * 100).toFixed(0)}% from its ${(pos.peakBid * 100).toFixed(0)}% peak`);
  const c = (v) => `${(v * 100).toFixed(0)}%`;

  if (inProfit && net >= pSide) {
    return { ...base, signs, action: 'SELL', kind: 'take', why: `Kalshi's sell price ${c(bid)} has caught up to the bot's ${c(pSide)}. The low is gone, so take the profit.` };
  }
  if (!inProfit && net >= pSide + s.cutMargin) {
    return { ...base, signs, action: 'SELL', kind: 'cut', why: `Bot now gives it only ${c(pSide)}, less than the ${c(bid)} you can sell at. Cut it.` };
  }
  return {
    ...base, signs, action: 'HOLD', kind: 'hold',
    why: `Bot gives it ${c(pSide)}. Selling now gets you ${c(net)} after fees, less than it's worth${signs.length ? ', even with flip signs showing' : ''}. Sell at ${c(target)} or hold to settlement.`,
  };
}
