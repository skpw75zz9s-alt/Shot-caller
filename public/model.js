// Pricing model for Kalshi 15-minute BTC markets.
// Pure functions only, shared by the browser app and the Node tests.

export function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation of erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
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
  volMultiplier: 1.15,  // fatten tails: realized vol underestimates jumps
  momentumWeight: 0.25, // fraction of recent drift to carry forward
  kellyFraction: 0.25,
  bankroll: 100,
  maxStake: 25,
};

// Decide the call for one market.
export function evaluate({ market, strike, spot, sigmaMin, driftMin = 0, now = Date.now(), settings = {} }) {
  const s = { ...DEFAULTS, ...settings };
  const minutesLeft = (Date.parse(market.close_time) - now) / 60000;
  const q = quote(market);
  const out = { minutesLeft, quote: q, pYes: null, evYes: null, evNo: null, call: 'PASS', reason: '', side: null, price: null, contracts: 0, edge: 0 };

  if (!spot || !sigmaMin) return { ...out, reason: 'Waiting for price data' };
  const p = probYes(market, strike, spot, sigmaMin * s.volMultiplier, minutesLeft, driftMin * s.momentumWeight);
  if (p === null) return { ...out, reason: 'Unknown strike' };
  out.pYes = Math.min(Math.max(p, 0.001), 0.999);

  if (q.yesAsk !== null) out.evYes = out.pYes - q.yesAsk - kalshiFee(q.yesAsk);
  if (q.noAsk !== null) out.evNo = (1 - out.pYes) - q.noAsk - kalshiFee(q.noAsk);

  if (minutesLeft < s.minMinutesLeft) return { ...out, reason: 'Too close to settlement' };
  if (minutesLeft > s.maxMinutesLeft) return { ...out, reason: 'Too early in the window' };
  if (q.yesBid !== null && q.yesAsk !== null && q.yesAsk - q.yesBid > s.maxSpread) return { ...out, reason: 'Spread too wide' };

  const best = (out.evYes ?? -1) >= (out.evNo ?? -1)
    ? { side: 'YES', ev: out.evYes, price: q.yesAsk, prob: out.pYes }
    : { side: 'NO', ev: out.evNo, price: q.noAsk, prob: 1 - out.pYes };
  if (best.ev === null || best.price === null) return { ...out, reason: 'No liquidity' };
  out.edge = best.ev;
  if (best.ev < s.minEdge) return { ...out, reason: `Best edge ${(best.ev * 100).toFixed(1)}¢ < ${(s.minEdge * 100).toFixed(1)}¢` };

  const cost = best.price + kalshiFee(best.price);
  const kelly = Math.max(0, (best.prob - cost) / (1 - cost)) * s.kellyFraction;
  const stake = Math.min(kelly * s.bankroll, s.maxStake);
  return {
    ...out,
    call: best.side,
    side: best.side,
    price: best.price,
    contracts: Math.max(1, Math.floor(stake / cost)),
    reason: `Model ${(best.prob * 100).toFixed(0)}% vs ${(best.price * 100).toFixed(0)}¢`,
  };
}

// P&L per contract for a settled call.
export function settlePnl(call, result) {
  const fee = kalshiFee(call.price);
  const won = call.side.toLowerCase() === String(result).toLowerCase();
  return { won, pnl: ((won ? 1 : 0) - call.price - fee) * call.contracts };
}
