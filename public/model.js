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

// P(settlement value > K)
export function probAbove(S, K, sigmaMin, minutesLeft, driftMin = 0, w = 1) {
  const variance = settleVariance(sigmaMin, minutesLeft, w);
  const mu = Math.log(S / K) + driftMin * Math.max(minutesLeft, 0);
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
export function probYes(m, strike, S, sigmaMin, minutesLeft, driftMin) {
  const type = m.strike_type || 'greater';
  const floor = num(m.floor_strike) ?? strike;
  const cap = num(m.cap_strike);
  const above = (k) => probAbove(S, k, sigmaMin, minutesLeft, driftMin);
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
  minEdge: 0.04,        // required EV per contract after fees, in dollars
  maxSpread: 0.10,      // skip markets with a wider yes spread
  minMinutesLeft: 0.5,  // don't call shots in the last 30 seconds
  maxMinutesLeft: 14,   // or right after open when the strike is barely set
  waitMinutes: 5,       // watch the first 5 minutes of each window before making any call
  volMultiplier: 1.15,  // fatten tails: realized vol underestimates jumps
  momentumWeight: 0.25, // fraction of recent drift to carry forward
  kellyFraction: 0.25,
  bankroll: 100,
  maxStake: 25,
  minVol: 0.00008,      // volatility floor per minute (0.8 bp, ~$7/min at $85k): frozen tapes aren't certainty
  minConfidence: 60,    // deep-dive score (0-100) a call needs before it fires: B or better
  rejectionWeight: 1,   // how much rejection trends move the odds (0 = off, 1 = up to ±5 pts)
};

// Decide the call for one market.
// pShift nudges P(YES) by evidence the price model can't see (e.g. rejection trends), in probability points.
export function evaluate({ market, strike, spot, sigmaMin, driftMin = 0, pShift = 0, now = Date.now(), settings = {} }) {
  const s = { ...DEFAULTS, ...settings };
  const minutesLeft = (Date.parse(market.close_time) - now) / 60000;
  const q = quote(market);
  const out = { minutesLeft, quote: q, pYes: null, pBase: null, pShift: 0, evYes: null, evNo: null, call: 'PASS', reason: '', side: null, price: null, contracts: 0, edge: 0 };

  if (!spot || !sigmaMin) return { ...out, reason: 'Waiting for price data' };
  const p = probYes(market, strike, spot, sigmaMin * s.volMultiplier, minutesLeft, driftMin * s.momentumWeight);
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

  const best = (out.evYes ?? -1) >= (out.evNo ?? -1)
    ? { side: 'YES', ev: out.evYes, price: q.yesAsk, prob: out.pYes }
    : { side: 'NO', ev: out.evNo, price: q.noAsk, prob: 1 - out.pYes };
  if (best.ev === null || best.price === null) return { ...out, reason: 'No liquidity' };
  out.edge = best.ev;
  if (best.ev < s.minEdge) return { ...out, reason: `Best gap ${(best.ev * 100).toFixed(1)} pts, need ${(s.minEdge * 100).toFixed(1)}` };

  const cost = best.price + kalshiFee(best.price);
  const kelly = Math.max(0, (best.prob - cost) / (1 - cost)) * s.kellyFraction;
  const stake = Math.min(kelly * s.bankroll, s.maxStake);
  return {
    ...out,
    call: best.side,
    side: best.side,
    price: best.price,
    contracts: Math.max(1, Math.floor(stake / cost)),
    reason: `Bot ${(best.prob * 100).toFixed(0)}% vs Kalshi ${(best.price * 100).toFixed(0)}%`,
  };
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
  trail: 0.06,     // bid falling this far from its peak is a flip sign
  oddsDrop: 0.08,  // bot odds falling this far from their peak is a flip sign
};

// When to sell an open position. pos = { side, price, contracts, peakBid, peakP }.
// bid is what the side sells for right now; pSide is the bot's current odds for that side.
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

  if (net >= pSide) {
    return inProfit
      ? { ...base, signs, action: 'SELL', kind: 'take', why: `Kalshi's sell price ${c(bid)} has caught up to the bot's ${c(pSide)}. The low is gone, so take the profit.` }
      : { ...base, signs, action: 'SELL', kind: 'cut', why: `Bot now gives it only ${c(pSide)}, less than the ${c(bid)} you can sell at. Cut it.` };
  }
  if (inProfit && signs.length) return { ...base, signs, action: 'SELL', kind: 'flip', why: `Price may be flipping: ${signs.join(' · ')}` };
  return {
    ...base, signs, action: 'HOLD', kind: 'hold',
    why: `Bot gives it ${c(pSide)}. Selling now gets you ${c(net)} after fees.${inProfit ? ' In profit, no flip signs.' : ''}`,
  };
}
