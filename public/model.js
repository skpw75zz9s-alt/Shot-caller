// Pricing model for Kalshi 15-minute BTC markets.
// Pure functions only, shared by the browser app and the Node tests.

export function normCdf(x) {
  // |x| <= 3: Marsaglia's series (J. Stat. Software 11(4), 2004), Phi(x) = 1/2 + phi(x)(x + x^3/3 + x^5/15 + ...),
  // summed until the terms stop changing the double. Beyond 3: the tail as phi(x) over the continued fraction for
  // Mills' ratio, x + 1/(x + 2/(x + 3/(x + ...))), which keeps full relative precision even for tiny tails.
  // Accurate to ~1e-15 (the old Abramowitz-Stegun formula was ~1e-7).
  if (x < -38) return 0;
  if (x > 38) return 1;
  const phi = Math.exp(-0.5 * x * x - 0.91893853320467274178); // 0.9189... = ln(sqrt(2 pi))
  if (Math.abs(x) <= 3) {
    let s = x, t = 0, b = x;
    const q = x * x;
    for (let i = 1; s !== t; ) s = (t = s) + (b *= q / (i += 2));
    return 0.5 + s * phi;
  }
  const z = Math.abs(x);
  let cf = z;
  for (let k = 80; k >= 1; k--) cf = z + k / cf;
  const tail = phi / cf;
  return x < 0 ? tail : 1 - tail;
}

// How a predicted move (dollars, by the close) changes P(YES): the chance of settling above the target with the move
// minus without it, at this volatility and time left (with Kalshi's averaged settlement, like the bot's own odds). Flipped for "less than" markets, capped at +-cap. Every learned
// nudge to the odds (micro model, tuned indicators, reversal checklist, guide forecast) goes through this.
export function oddsShift(move, { spot, strike, sigmaMin, minutesLeft, strikeType = 'greater' }, cap) {
  if (!move || !(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0) || !(spot + move > 0)) return 0;
  const d = probAbove(spot + move, strike, sigmaMin, minutesLeft) - probAbove(spot, strike, sigmaMin, minutesLeft);
  return Math.min(cap, Math.max(-cap, /^less/.test(strikeType || '') ? -d : d));
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

// ---------- the settlement ----------
// Kalshi settles on the average of its index's last 60 one-second prints before the close (SETTLE). Seen from now, the
// prints still to come are correlated log-normal prices; their sum's first two moments are computed exactly:
//   E[S_i] = S exp(a t_i), E[S_i S_j] = S^2 exp(a (t_i + t_j) + s2 min(t_i, t_j)), a = drift + s2/2, s2 = sigma^2
// (t in minutes from now), and the settlement is priced from a log-normal with exactly those moments. The prints
// already made (inside the last minute) count at face value. The shape beyond two moments differs from the true one by
// far less than a billionth at these volatilities.
export const SETTLE = { prints: 60, w: 1 };
// Returns the number of prints still to come, their sum's mean m1 and its variance c (computed directly as
// sum E_i E_j (exp(s2 min(t_i, t_j)) - 1) with expm1, never as E[X^2] - E[X]^2, which would cancel away digits).
function futurePrints(S, sigmaMin, t, driftMin = 0, { prints: N, w } = SETTLE) {
  const v = sigmaMin * sigmaMin, a = driftMin + v / 2, d = w / N;
  let n = 0, m1 = 0, c = 0, later = 0;
  for (let i = N; i >= 1; i--) { // latest print first: `later` is the sum of E[S_j]/S over the prints after it
    const tau = t - w + i * d;
    if (!(tau > 1e-12)) break;
    const e = Math.exp(a * tau);
    n++; m1 += e; c += e * Math.expm1(v * tau) * (e + 2 * later); later += e;
  }
  return { n, m1: S * m1, c: S * S * c };
}
// The settlement average's log-variance (S = 1, no drift, no prints known yet): what its spread is, for anything that
// needs it as one number (Kalshi's implied close, the cone)
export function settleVariance(sigmaMin, minutesLeft) {
  const t = Math.max(minutesLeft, 0), { prints: N } = SETTLE, f = futurePrints(1, sigmaMin, t), k = N - f.n;
  return Math.log1p(f.c / ((k + f.m1) * (k + f.m1))); // the prints already made add no variance
}

// P(settlement > K). settleAvg: the average of the prints made so far inside the last minute (when known); without it
// those prints are taken as today's price.
export function probAbove(S, K, sigmaMin, minutesLeft, driftMin = 0, w = 1, settleAvg = null) {
  void w; // (the window is SETTLE.w)
  const t = Math.max(minutesLeft, 0), { prints: N } = SETTLE;
  const f = sigmaMin > 0 ? futurePrints(S, sigmaMin, t, driftMin) : { n: 0, m1: 0, c: 0 };
  if (!(sigmaMin > 0) && t > 0) { // no volatility: the future prints are known too
    const d = SETTLE.w / N; let sum = 0, n = 0;
    for (let i = 1; i <= N; i++) { const tau = t - SETTLE.w + i * d; if (tau > 1e-12) { sum += S * Math.exp(driftMin * tau); n++; } }
    const avg = ((settleAvg ?? S) * (N - n) + sum) / N;
    return avg > K ? 1 : avg < K ? 0 : 0.5;
  }
  const known = (settleAvg ?? S) * (N - f.n), need = N * K - known; // the future prints must add up to more than this
  if (f.n === 0) { const avg = known / N; return avg > K ? 1 : avg < K ? 0 : 0.5; }
  if (need <= 0) return 1;
  const s2 = Math.log1p(f.c / (f.m1 * f.m1));
  if (!(s2 > 0)) return f.m1 > need ? 1 : f.m1 < need ? 0 : 0.5;
  return normCdf((Math.log(f.m1) - s2 / 2 - Math.log(need)) / Math.sqrt(s2));
}

// Kalshi's fee (in dollars) at price p: rate·contracts·p·(1−p), rounded up to the cent. The rates start at Kalshi's
// published 7% (taker) and a quarter of that (maker), and switch to the ones measured from real fills once there are
// enough (public/fees.js, applied with setFeeRates).
const FEE_RATES = { taker: 0.07, maker: 0.0175, measured: { taker: false, maker: false } };
export function setFeeRates(learned) {
  for (const kind of ['taker', 'maker']) {
    const x = learned?.[kind];
    if (x?.k != null && x.n >= 8) { FEE_RATES[kind] = x.k; FEE_RATES.measured[kind] = true; }
  }
  return feeRates();
}
export const feeRates = () => ({ taker: FEE_RATES.taker, maker: FEE_RATES.maker, measured: { ...FEE_RATES.measured } });
export function kalshiFee(p, contracts = 1, maker = false) {
  return Math.ceil((maker ? FEE_RATES.maker : FEE_RATES.taker) * contracts * p * (1 - p) * 100 - 1e-9) / 100;
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
  minConfidence: 85,    // confidence = win odds (0-100) a call needs before it fires (Balanced)
  rejectionWeight: 1,   // how much rejection trends move the odds (0 = off, 1 = up to ±5 pts)
  holdEdgeFrac: 0.5,    // once called, the call stands while the robust gap is at least half of minEdge...
  holdConfDrop: 10,     // ...and confidence is no more than 10 below minConfidence
  switchEdgeExtra: 0.04, // calling the OTHER side in the same window needs 4 pts more gap...
  switchConfExtra: 8,    // ...and 8 more confidence (win odds)
  bigEdgeOverride: 0,   // a call under minConfidence still fires if its worst-case gap is at least this (0 = off; Safe 0.15, Balanced 0.12, Aggressive 0.10)
  persistSec: 0,        // a new call needs its gap to have held this long (edges that last survive your reaction time)
  limitEdgeFrac: 0.5,   // max price on a call: still clears this share of minEdge even with vol 20% off
  marketWeight: 0,      // blend Kalshi's own mid into the bot's odds (0 = bot only)
  learnBlend: true,     // once proven, use the Kalshi blend the bot has learned scores best instead (public/pulse.js)
  maxEdge: 1,           // a gap bigger than this is too good to be true (usually a lag that's gone before you can buy)
  scaleIn: false,       // add to a call as its gap grows past minEdge +2, +4 and +8 pts (Aggressive)
  scaleStep: 0.02,      // spacing of the scale-in tiers: minEdge +1, +2 and +4 steps
  firstSize: 1,         // with scaleIn, the first entry is this fraction of the normal size (adds carry the rest)
  reentrySec: 15,       // after selling, a new call on the same market can fire this many seconds later
  doubleRejRule: true,  // two decent rejections in a row in the window: never call against them (see analysis.js)
  noCallLastMin: 0,     // entry filters for new calls (0 = off): no new call with fewer than this many minutes left,
  maxVolRatio: 0,       // ...or when 1-minute vol is more than this many times its 2-hour norm,
  jumpSkip: 0,          // ...or when Kalshi's price for the side moved this much in the last 30 seconds
  minHold: 0,           // Steady: a new call needs this chance (0-1) that its confidence stays above holdFloor all round (0 = off)
  holdFloor: 0.8,       // ...the confidence floor that "holding" means (80)
  steadySec: 0,         // Steady: the bot's odds must have stayed at minConfidence or more for this long before a call
  steadyByStability: true, // ...half as long in a stable market (👍), 1.5× as long in an unstable one. In simulation
                           // (3 × ~13,000 rounds) this made ~37% more calls than a fixed 60s, every one still at 85+,
                           // winning 94.8% vs 95.5%
  lockCall: false,      // Steady: once a side is called, never switch to the other side that round
  kalshiAgree: 0,       // Near-certain: a new call needs Kalshi's own bid for the side at least this high (the market agrees; 0 = off)
  learn: true,          // use what the server learned over days and weeks (time-of-week volatility, calibration, basis)
};

// Risk levels (Settings). All levels re-enter after selling. Aggressive trades every small gap, scales in as it
// grows, re-enters fast and bets twice Safe's size. Simulated on fresh seeds with instant fills it made 2.4-16x
// Safe's profit where there was an edge; its worst losing stretch was ~$90-200 vs Safe's ~$15-40.
export const RISK_LEVELS = {
  // Steady: only calls whose confidence is likely to last. In simulation, calls at confidence 85+ with hold odds of
  // 80%+ kept their confidence above 80 for the rest of the round 93% of the time (85+ alone: 84%; 85-90 alone: 65%)
  // and won about 98%. No big-gap exception, no switching sides mid-round.
  steady: { label: 'Steady', minEdge: 0.06, minConfidence: 85, bigEdgeOverride: 0, minHold: 0.8, steadySec: 60, lockCall: true, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'Calls that hold: confidence 85+ that held for a minute and is likely to stay above 80 all round' },
  // Sniper: the strictest. Confidence 90+ held for 90s, hold odds 90%+. Simulated: confidence stayed above 80 all round
  // 97-98% of the time and calls won 99.2-99.6%. Very few calls, and they're priced high, so each win pays a few cents.
  sniper: { label: 'Sniper', minEdge: 0.03, minConfidence: 90, bigEdgeOverride: 0, minHold: 0.9, steadySec: 90, lockCall: true, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'Fewest, surest calls: confidence 90+ for 90 seconds and likely to stay above 80 all round. Wins pay little' },
  // Near-certain: the highest win rate the bot can honestly aim for (never 100%: the close is decided by trades that
  // haven't happened yet). Confidence 95+ held for 2 minutes, a 95%+ chance it stays above 80 all round, and Kalshi's
  // own bid for the side at 85c+ (when the bot is sure and the market isn't, the bot is usually the one that's wrong).
  // Calls are rare and priced 90c+, so a win pays a few cents and one loss can cost 20+ wins. The server keeps this
  // level's own graded record (Record tab) so its real win rate and profit after fees are measured, not assumed.
  certain: { label: 'Near-certain', minEdge: 0.01, minConfidence: 95, bigEdgeOverride: 0, minHold: 0.95, steadySec: 120, lockCall: true, kalshiAgree: 0.85, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'Only the surest calls: confidence 95+ for 2 minutes, very likely to hold all round, and Kalshi\'s price agrees. Rare, wins pay a few cents, and one loss can erase 20+ wins. Never 100%' },
  safe: { label: 'Safe', minEdge: 0.08, minConfidence: 90, bigEdgeOverride: 0.15, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'Fewest calls, biggest gaps only' },
  balanced: { label: 'Balanced', minEdge: 0.06, minConfidence: 85, bigEdgeOverride: 0.12, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'About 2× the calls of Safe' },
  // Picked by a 100-configuration search scored across 6 simulated market types, then confirmed on fresh seeds
  // it was not picked on (beat the previous Aggressive in 11 of 12 market/fill-speed cells).
  aggressive: { label: 'Aggressive', minEdge: 0.02, minConfidence: 80, scaleIn: true, scaleStep: 0.015, reentrySec: 5, limitEdgeFrac: 0.25, cutMargin: 0.01, kellyFraction: 0.5, maxStake: 50,
    bigEdgeOverride: 0.10, hint: 'Trades every small gap, adds as it grows, quick re-entry, double-size bets: biggest wins and biggest swings' },
};
// The strategy settings a risk level sets
export const RISK_KEYS = ['minEdge', 'minConfidence', 'bigEdgeOverride', 'minHold', 'steadySec', 'lockCall', 'kalshiAgree', 'scaleIn', 'scaleStep', 'reentrySec', 'limitEdgeFrac', 'cutMargin', 'kellyFraction', 'maxStake'];
export const riskSettings = (k) => Object.fromEntries(RISK_KEYS.map((key) => [key, RISK_LEVELS[k][key] ?? DEFAULTS[key]]));
export const riskLevelOf = (s) => Object.keys(RISK_LEVELS).find((k) => Math.abs(RISK_LEVELS[k].minEdge - s.minEdge) < 1e-9 && RISK_LEVELS[k].minConfidence === s.minConfidence && (RISK_LEVELS[k].minHold ?? 0) === (s.minHold ?? 0)) ?? 'custom';

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

  // edges after the exact fee of the order the bot would place (Kalshi rounds per order, not per contract)
  if (q.yesAsk !== null) out.evYes = out.pYes - q.yesAsk - orderFee(q.yesAsk, out.pYes, s);
  if (q.noAsk !== null) out.evNo = (1 - out.pYes) - q.noAsk - orderFee(q.noAsk, 1 - out.pYes, s);

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
// Kelly for a binary contract bought at all-in cost c that pays $1: f* = (p - c) / (1 - c) of the bankroll. The fee is
// charged on the whole order and rounded up once (not per contract), so the count is the most whose exact total
// (price x n + the order's fee) fits the stake.
export function contractsFor(prob, price, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const cost = price + FEE_RATES.taker * price * (1 - price); // the fee per contract before the order's rounding
  const kelly = Math.max(0, (prob - cost) / (1 - cost)) * s.kellyFraction;
  const budget = Math.min(kelly * s.bankroll, s.maxStake);
  let n = Math.floor(budget / cost);
  while (n > 1 && n * price + kalshiFee(price, n) > budget + 1e-9) n--;
  return Math.max(1, n);
}

// The exact fee per contract on an order of n contracts: Kalshi rounds the ORDER's fee up to the cent once, so a
// 48-contract order at 50c pays $0.84 (1.75c each), not 48 x 2c
export const feeEach = (price, n = 1) => { const k = Math.max(1, Math.floor(n)); return kalshiFee(price, k) / k; };
// ...on the order the bot would actually place at this price (its Kelly size); without settings, a single contract
export const orderFee = (price, prob, settings = null) => (settings ? feeEach(price, contractsFor(prob, price, settings)) : kalshiFee(price));
// Profit or loss of spending $10 on a contract at `price` held to settlement: whole contracts and the order's exact fee
export const fee10 = (price) => feeEach(price, Math.floor(10 / price + 1e-9)); // the exact fee per contract on a $10 order
export function pnl10(price, won, extraPer = 0) {
  if (!(price > 0 && price < 1)) return 0;
  const n = Math.floor(10 / price + 1e-9);
  return n * ((won ? 1 : 0) - price - extraPer) - kalshiFee(price, n);
}

// Most you can pay for a side with win probability p and still clear minEdge after fees (at the size the bot would buy)
export function maxPay(p, minEdge, settings = null) {
  for (let c = 99; c >= 1; c--) {
    const price = c / 100;
    if (p - price - orderFee(price, p, settings) >= minEdge - 1e-9) return price;
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
  const cap = maxPay(sideDip, s.minEdge, s);
  if (cap === null) return null;
  const limit = Math.min(Math.floor((ask + shift) * 100 + 1e-9) / 100, cap);
  return limit >= 0.01 ? { price: limit, dipLevel, fairAtDip: sideDip } : null;
}

// Lowest sell price whose proceeds after the exit fee (on n contracts, rounded once) are at least `value` each.
export function sellTarget(value, n = 1) {
  for (let c = 1; c <= 99; c++) {
    const price = c / 100;
    if (price - feeEach(price, n) >= value - 1e-9) return price;
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
  // Bail out (stop loss): sell a losing position once the bot's odds for it fall under this, even below value.
  // In simulation (2 × ~9,000 calls), bailing under 40% cut the calls that lost everything from 5.2% to 1.6% and the
  // average loss from 94¢ to 73¢ a contract, for about 0.3¢ a contract overall (a third of bails would have won).
  // 0 turns it off.
  bailBelow: 0.4,
  bailLastSec: 30,   // ...but not in the last 30 seconds (the price is nearly settled by then)
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
  const n = pos.contracts || 1, entryCost = pos.price + feeEach(pos.price, n); // this position's own order size
  const target = sellTarget(Math.max(pSide, entryCost + s.minProfit), n);
  if (bid == null || bid <= 0) return { action: 'HOLD', kind: 'nobid', why: 'No bids to sell into right now', holdEv: pSide, target, signs: [] };

  const net = bid - feeEach(bid, n);
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
  if (!inProfit && s.bailBelow > 0 && pSide < s.bailBelow && minutesLeft * 60 > s.bailLastSec) {
    return { ...base, signs, action: 'SELL', kind: 'bail', why: `Bail out: the bot now gives it only ${c(pSide)} (under ${c(s.bailBelow)}). Sell at ${c(bid)} and keep ${c(net)} of each $1 instead of risking all of it.` };
  }
  if (!inProfit && net >= pSide + s.cutMargin) {
    return { ...base, signs, action: 'SELL', kind: 'cut', why: `Bot now gives it only ${c(pSide)}, less than the ${c(bid)} you can sell at. Cut it.` };
  }
  return {
    ...base, signs, action: 'HOLD', kind: 'hold',
    why: `Bot gives it ${c(pSide)}. Selling now gets you ${c(net)} after fees, less than it's worth${signs.length ? ', even with flip signs showing' : ''}. Sell at ${c(target)} or hold to settlement.`,
  };
}

// ---------- hold odds: will this call's confidence last the round? ----------
// Confidence moves with BTC. holdOdds is the chance that the side's confidence never drops below `floor`, checked every
// 10 seconds until the last `stopMin` minutes, when BTC follows a random walk at a volatility the bot can't know exactly
// (log-normal around its estimate, 20% spread). Computed exactly rather than simulated (v12.4; it used to be 300
// random paths, +-2.5 points of noise): for each volatility (7-point Gauss-Hermite quadrature over the 20% spread) the
// price distribution is stepped forward on a fine grid, and at each check the paths that broke the floor are removed;
// what's left at the end is the chance it held. Deterministic, so it never jitters between ticks.
export const HOLD_DT = 1 / 6; // minutes between checks (10s)
const GH7 = [[0, 0.457142857142857], [1.154405394739968, 0.240123178605013], [-1.154405394739968, 0.240123178605013],
  [2.366759410734541, 0.030757123967586], [-2.366759410734541, 0.030757123967586], [3.750439717725742, 0.000548268855972], [-3.750439717725742, 0.000548268855972]];
const holdCache = new Map(); // the same inputs give the same answer: every device and refresh shares it
export function holdOdds(o) {
  const { market, strike, spot, sigmaMin, minutesLeft, side, floor = 0.8, stopMin = 1, confVol = 1.25 } = o;
  if (!spot || !sigmaMin || !side || !(minutesLeft > stopMin)) return null;
  const key = [market?.ticker, market?.strike_type, market?.floor_strike, market?.cap_strike, strike, spot.toFixed(2), sigmaMin.toPrecision(6), minutesLeft.toFixed(3), side, floor, stopMin, confVol].join('|');
  if (holdCache.has(key)) return holdCache.get(key);
  const v = holdExact({ market, strike, spot, sigmaMin, minutesLeft, side, floor, stopMin, confVol });
  if (holdCache.size > 500) holdCache.delete(holdCache.keys().next().value);
  holdCache.set(key, v);
  return v;
}
function holdExact({ market, strike, spot, sigmaMin, minutesLeft, side, floor, stopMin, confVol }) {
  const steps = Math.floor((minutesLeft - stopMin) / HOLD_DT);
  const x0 = Math.log(spot);
  const sideP = (x, t) => { const p = probYes(market, strike, Math.exp(x), sigmaMin * confVol, t, 0); return p == null ? null : side === 'YES' ? p : 1 - p; };
  // the floor as a price level at each check: confidence is monotone in price, so it's one crossing (found by bisection)
  const span = 12 * sigmaMin * Math.sqrt(minutesLeft) + 0.05;
  const lo0 = sideP(x0 - span, minutesLeft), hi0 = sideP(x0 + span, minutesLeft);
  if (lo0 == null || hi0 == null) return null;
  const rising = hi0 >= lo0; // the side's confidence rises with the price (YES on an "above" market)
  const level = [];
  for (let i = 1; i <= steps; i++) {
    const t = minutesLeft - i * HOLD_DT, a = sideP(x0 - span, t), b = sideP(x0 + span, t);
    if ((rising ? a : b) >= floor) { level.push(-Infinity); continue; } // holds anywhere in range
    if ((rising ? b : a) < floor) { level.push(Infinity); continue; }   // fails anywhere in range
    let l = x0 - span, h = x0 + span;
    for (let k = 0; k < 60; k++) { const m = (l + h) / 2; if ((sideP(m, t) >= floor) === rising) h = m; else l = m; }
    level.push((l + h) / 2);
  }
  if (!steps) return 1;
  let total = 0;
  for (const [z, w] of GH7) {
    const vol = sigmaMin * Math.exp(0.2 * z - 0.02), sd = vol * Math.sqrt(HOLD_DT); // per-check move
    const h = sd / 8, half = Math.ceil((6 * vol * Math.sqrt(steps * HOLD_DT) + 6 * sd) / h), n = 2 * half + 1;
    const kr = Math.ceil(6 * sd / h), ker = [];
    let ks = 0;
    for (let k = -kr; k <= kr; k++) { const v = Math.exp(-0.5 * (k * h / sd) ** 2); ker.push(v); ks += v; }
    for (let k = 0; k < ker.length; k++) ker[k] /= ks;
    let p = new Float64Array(n), q = new Float64Array(n);
    p[half] = 1;
    for (let i = 0; i < steps; i++) {
      q.fill(0);
      for (let j = 0; j < n; j++) { const v = p[j]; if (!v) continue; for (let k = -kr; k <= kr; k++) { const jj = j + k; if (jj >= 0 && jj < n) q[jj] += v * ker[k + kr]; } }
      // the floor usually falls inside a grid cell: keep the share of that cell on the holding side (second-order accurate)
      const L = level[i];
      if (L === Infinity) q.fill(0);
      else if (L !== -Infinity) for (let j = 0; j < n; j++) { const x = x0 + (j - half) * h, keep = rising ? (x + h / 2 - L) / h : (L - (x - h / 2)) / h; if (keep <= 0) q[j] = 0; else if (keep < 1) q[j] *= keep; }
      [p, q] = [q, p];
    }
    let m = 0; for (let j = 0; j < n; j++) m += p[j];
    total += w * m;
  }
  return Math.min(1, Math.max(0, total));
}
