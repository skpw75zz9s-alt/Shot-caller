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
export function effectiveVol(ewma, long, minVol = 0.00008, floor = 0.6) {
  if (!ewma && !long) return null;
  return Math.max(ewma || 0, floor * (long || 0), minVol);
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
// Kalshi settles on the average of its index's last 60 one-second prints before the close (SETTLE). The sum of the
// prints still to come splits exactly into two independent parts:
//   F = S x e^X0 x R,   X0 = the log move from now to the start of the last minute: exactly normal
//                       R  = sum of e^(W_j), the final minute's prints relative to its start: a fixed shape that depends
//                            only on the volatility (never the price), so it's worked out once and cached
// R gets its exact mean, variance and third cumulant (skewness), and is represented by the shifted log-normal with all
// three; X0 is integrated exactly with 24-point Gauss-Hermite quadrature (over whichever of the two is narrower, so the
// integrand stays smooth). Whatever shape R has beyond three moments is then averaged out by X0's much larger spread.
// The prints already made (inside the last minute) count at face value.
export const SETTLE = { prints: 60, w: 1 };
// Gauss-Hermite nodes and weights for E[f(Z)], Z ~ N(0,1) (Newton on the orthonormal Hermite recurrence, Numerical
// Recipes' gauher, then rescaled from the e^(-x^2) weight to the standard normal)
function gaussHermite(n) {
  const x = new Array(n), w = new Array(n), m = (n + 1) >> 1;
  let z = 0;
  for (let i = 0; i < m; i++) {
    if (i === 0) z = Math.sqrt(2 * n + 1) - 1.85575 * Math.pow(2 * n + 1, -0.16667);
    else if (i === 1) z -= 1.14 * Math.pow(n, 0.426) / z;
    else if (i === 2) z = 1.86 * z - 0.86 * x[0];
    else if (i === 3) z = 1.91 * z - 0.91 * x[1];
    else z = 2 * z - x[i - 2];
    let pp = 0;
    for (let it = 0; it < 200; it++) {
      let p1 = Math.PI ** -0.25, p2 = 0;
      for (let k = 0; k < n; k++) { const p3 = p2; p2 = p1; p1 = z * Math.sqrt(2 / (k + 1)) * p2 - Math.sqrt(k / (k + 1)) * p3; }
      pp = Math.sqrt(2 * n) * p2;
      const z1 = z; z = z1 - p1 / pp;
      if (Math.abs(z - z1) <= 1e-15 * Math.max(1, Math.abs(z))) break;
    }
    x[i] = z; x[n - 1 - i] = -z; w[i] = 2 / (pp * pp); w[n - 1 - i] = w[i];
  }
  return x.map((xi, k) => [xi * Math.SQRT2, w[k] / Math.sqrt(Math.PI)]);
}
export const GH24 = gaussHermite(24);
export const GH9 = gaussHermite(9);
// The final-minute shape R for prints at times u_1 < ... < u_n (minutes): exact mean, variance and third cumulant
// (variance and cumulant built from expm1 terms, never from raw moments, which would cancel away the digits), and the
// shifted log-normal R = shift + e^Y, Y ~ N(mu, s^2), with all three
const shapeCache = new Map();
function windowShape(sigmaMin, driftMin, n, first) {
  const key = `${sigmaMin}|${driftMin}|${n}|${first}`;
  if (shapeCache.has(key)) return shapeCache.get(key);
  const v = sigmaMin * sigmaMin, a = driftMin + v / 2, d = SETTLE.w / SETTLE.prints;
  const u = Array.from({ length: n }, (_, j) => first + j * d), E = u.map((x) => Math.exp(a * x));
  const suf = new Array(n + 1).fill(0);
  for (let j = n - 1; j >= 0; j--) suf[j] = suf[j + 1] + E[j];
  let M = 0, V = 0, K3 = 0;
  for (let i = 0; i < n; i++) {
    M += E[i];
    V += E[i] * Math.expm1(v * u[i]) * (E[i] + 2 * suf[i + 1]); // Cov(e^Wi, e^Wj) = Ei Ej (e^(v min) - 1)
    for (let j = i; j < n; j++) {
      // the joint cumulant of (i, j, k) for i <= j <= k depends only on u_i, u_j: Ei Ej Ek (e^(2v ui + v uj) - 2e^(v ui) - e^(v uj) + 2)
      const f = Math.expm1(2 * v * u[i] + v * u[j]) - 2 * Math.expm1(v * u[i]) - Math.expm1(v * u[j]), b = E[i] * E[j] * f;
      K3 += i < j ? b * (6 * suf[j + 1] + 3 * E[j]) : b * (3 * suf[j + 1] + E[j]); // all orderings of the triple
    }
  }
  let out;
  const g = V > 0 ? K3 / V ** 1.5 : 0; // skewness
  if (!(V > 0) || !(g > 0)) out = { M, V, shift: 0, mu: Math.log(M), s: 0 };
  else {
    let w = (g / 3) ** 2; // shifted log-normal: skewness (w + 3) sqrt(w), w = e^(s^2) - 1
    for (let it = 0; it < 100; it++) { const r = Math.sqrt(w), fw = (w + 3) * r - g, dw = r + (w + 3) / (2 * r), nw = w - fw / dw; if (!(nw > 0)) { w /= 2; continue; } if (Math.abs(nw - w) <= 1e-16 * w) { w = nw; break; } w = nw; }
    const em = Math.sqrt(V / (w * (w + 1)));
    out = { M, V, shift: M - em * Math.sqrt(1 + w), mu: Math.log(em), s: Math.sqrt(Math.log1p(w)) };
  }
  if (shapeCache.size > 2000) shapeCache.delete(shapeCache.keys().next().value);
  shapeCache.set(key, out);
  return out;
}
// The prints still to come, seen from now: how many, X0's mean and sd, and R's shape
function future(sigmaMin, t, driftMin) {
  const { prints: N, w } = SETTLE, d = w / N, t0 = t - w;
  let n = 0, first = null;
  for (let i = 1; i <= N; i++) { const tau = t0 + i * d; if (tau > 1e-12) { n++; if (first == null) first = tau; } }
  if (!n) return { n: 0 };
  const lead = Math.max(t0, 0); // the time to the start of the last minute (0 inside it)
  return { n, x0: driftMin * lead, sx: sigmaMin * Math.sqrt(lead), lead, R: windowShape(sigmaMin, driftMin, n, Math.round((first - lead) * 1e12) / 1e12) };
}
// The settlement average's log-variance (S = 1, no drift, no prints known yet), for anything that needs its spread as
// one number (Kalshi's implied close, the cone): Var(e^X0 R) = g^2 (M^2 (e^(v lead) - 1) + V e^(v lead)), g = E[e^X0]
export function settleVariance(sigmaMin, minutesLeft) {
  const t = Math.max(minutesLeft, 0), f = sigmaMin > 0 ? future(sigmaMin, t, 0) : { n: 0 };
  if (!f.n) return 0;
  const v = sigmaMin * sigmaMin, g1 = Math.exp(v * f.lead / 2), k = SETTLE.prints - f.n, mean = k + g1 * f.R.M;
  const varSum = g1 * g1 * (f.R.M * f.R.M * Math.expm1(v * f.lead) + f.R.V * Math.exp(v * f.lead));
  return Math.log1p(varSum / (mean * mean));
}

// P(settlement > K). settleAvg: the average of the prints made so far inside the last minute (when known); without it
// those prints are taken as today's price.
export function probAbove(S, K, sigmaMin, minutesLeft, driftMin = 0, w = 1, settleAvg = null) {
  void w; // (the window is SETTLE.w)
  const t = Math.max(minutesLeft, 0), { prints: N } = SETTLE;
  if (!(sigmaMin > 0)) { // no volatility: every print is known
    const d = SETTLE.w / N; let sum = 0, n = 0;
    for (let i = 1; i <= N; i++) { const tau = t - SETTLE.w + i * d; if (tau > 1e-12) { sum += S * Math.exp(driftMin * tau); n++; } }
    const avg = ((settleAvg ?? S) * (N - n) + sum) / N;
    return avg > K ? 1 : avg < K ? 0 : 0.5;
  }
  const f = future(sigmaMin, t, driftMin), known = (settleAvg ?? S) * (N - f.n);
  if (!f.n) { const avg = known / N; return avg > K ? 1 : avg < K ? 0 : 0.5; }
  const need = N * K - known; // the future prints must add up to more than this
  if (need <= 0) return 1;
  const L = Math.log(need / S), { shift, mu, s } = f.R;
  // P(R > r) for the shifted log-normal R
  const rAbove = (r) => (r <= shift ? 1 : s > 0 ? normCdf((mu - Math.log(r - shift)) / s) : shift + Math.exp(mu) > r ? 1 : 0);
  if (!(f.sx > 0)) return rAbove(Math.exp(L)); // inside the last minute: only R is left
  let p = 0;
  if (s <= f.sx) { // integrate over R (the narrower): P(X0 > L - ln R)
    for (const [z, wt] of GH24) { const r = shift + Math.exp(mu + s * z); p += wt * (r > 0 ? normCdf((f.x0 - (L - Math.log(r))) / f.sx) : 0); }
  } else { // integrate over X0: P(R > e^(L - X0))
    for (const [z, wt] of GH24) p += wt * rAbove(Math.exp(L - (f.x0 + f.sx * z)));
  }
  return Math.min(1, Math.max(0, p));
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
// Computed in exact integer arithmetic (no floating-point fudge): price in 1/10,000ths of a dollar (Kalshi quotes to
// 4 decimals), contracts in hundredths (fractional counts exist), the rate in parts per million, and a true ceiling.
// Floating point gets cases like 4 contracts at 50c wrong: 0.07 x 4 x 0.25 x 100 = 7.000000000000001, which rounds up to 8c.
export function kalshiFee(p, contracts = 1, maker = false) {
  const rate = maker ? FEE_RATES.maker : FEE_RATES.taker;
  const q = BigInt(Math.round(p * 10000)), n = BigInt(Math.max(0, Math.round(contracts * 100))), r = BigInt(Math.round(rate * 1e6));
  if (q <= 0n || q >= 10000n || n === 0n) return 0;
  // cents = r/1e6 x n/100 x q/1e4 x (1e4-q)/1e4 x 100  =  r n q (1e4-q) / 1e14
  const num = r * n * q * (10000n - q), den = 100000000000000n;
  return Number((num + den - 1n) / den) / 100;
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
// tails > 0 (v13.3, the volatility tuner's fat tails: public/voltune.js): the volatility itself is uncertain, log-normal
// with spread `tails` around the estimate and the same average variance (sigma_j = sigma e^(tails z - tails^2)), so the
// odds average over it (9-point Gauss-Hermite). Same spread, fatter tails: big moves are likelier than the normal curve
// says, and middling ones a little less likely, so the bot is less sure of a big lead (odds above ~95%) and a little
// surer of a modest one
export function probYes(m, strike, S, sigmaMin, minutesLeft, driftMin, settleAvg = null, tails = 0) {
  if (tails > 0 && sigmaMin > 0) {
    let p = 0;
    for (const [z, wt] of GH9) { const v = probYes(m, strike, S, sigmaMin * Math.exp(tails * z - tails * tails), minutesLeft, driftMin, settleAvg); if (v == null) return null; p += wt * v; }
    return Math.min(1, Math.max(0, p));
  }
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
  winFloor: 0,          // 90% target: Kalshi's ask for the side must be at least this (0 = off; public/winguard.js)
  fastSec: 0,           // fast lane: the steady wait drops to this many seconds (0 = off) when the bot is fastConf+ sure
  fastConf: 98,         //   and Kalshi's ask for the side is fastAsk or more
  fastAsk: 0.93,
  dailyLossLimit: 25,   // buy alerts stop for the day once your tracked trades lose this much today ($; 0 = off)
  lossStopUntil: 0,     //   (set by the phone when the limit is hit, so the server's pushes stop too)
  volTails: 0,          // fat tails: the spread of the volatility's own uncertainty (set by the volatility tuner once proven)
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
  // Late lane (public/engine.js buySignal): in the last lateMin minutes (0 = off) new calls must pass its stress test
  // and guards instead of the normal edge bar. Off (the 90% target level makes no new calls in the last 5 minutes
  // at all since v13.17: noCallLastMin 5; a win that late pays a few cents)
  // Early lane (public/engine.js buySignal): from earlyMin minutes left (0 = off) until the late lane, calls Kalshi prices
  // at earlyMinAsk up to the 90% floor; test calls until proven on real rounds (public/profitguard.js earlyProof)
  // Flip calls (public/engine.js buySignal): a locked call may switch sides flipMax times a round on clear evidence (0 = off)
  flipCalls: 0, flipConf: 0.9, flipSize: 0.5, flipMax: 1,
  earlyMin: 0, earlyConf: 0.93, earlyEdge: 0.06, earlyMinAsk: 0.8, earlyBid: 0.75, earlySize: 0.5,
  lateMin: 0, lateVol: 1.35, lateTails: 0.35, lateConf: 0.97, lateMargin: 0.005, lateMaxAsk: 0.98, lateBid: 0.9, lateCalm: 1.5, lateJump: 0.04, lateSteady: 20, lateSize: 0.5,
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
  // 90% target (v13.5): built for a 90%+ win rate. Only calls a side Kalshi itself prices at the floor or more (90c to
  // start; the win-rate guard raises it if the real record slips: public/winguard.js) and the bot rates higher still at
  // that price after the fee (1c gap, confidence 92+ held for a minute, likely to hold all round). Kalshi's price is a
  // well-calibrated win chance, so these win ~90%+ on their own and the bot's agreement lifts it (simulated 92-97%).
  // Wins pay 10c or less a contract, so fees can make it lose money even while it wins. Fast lane (v13.6): when the bot
  // is 98%+ sure and Kalshi prices the side at 93c+, the steady wait is 20 s instead of 60 (every other check unchanged),
  // so overwhelming leads get called early in the round
  target90: { label: '90% target', minEdge: 0.01, minConfidence: 92, bigEdgeOverride: 0, minHold: 0.9, steadySec: 60, lockCall: true, winFloor: 0.9, fastSec: 20, fastConf: 98, fastAsk: 0.93, lateMin: 0, noCallLastMin: 5, earlyMin: 10, flipCalls: 1, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'Built for a 90%+ win rate: only sides Kalshi prices at 90¢+ (raised automatically if the record slips) that the bot rates higher still. Many calls win; each win pays little' },
  safe: { label: 'Safe', minEdge: 0.08, minConfidence: 90, bigEdgeOverride: 0.15, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'Fewest calls, biggest gaps only' },
  balanced: { label: 'Balanced', minEdge: 0.06, minConfidence: 85, bigEdgeOverride: 0.12, scaleIn: false, scaleStep: 0.02, reentrySec: 15, limitEdgeFrac: 0.5, cutMargin: 0.03, kellyFraction: 0.25, maxStake: 25, hint: 'About 2× the calls of Safe' },
  // Picked by a 100-configuration search scored across 6 simulated market types, then confirmed on fresh seeds
  // it was not picked on (beat the previous Aggressive in 11 of 12 market/fill-speed cells).
  aggressive: { label: 'Aggressive', minEdge: 0.02, minConfidence: 80, scaleIn: true, scaleStep: 0.015, reentrySec: 5, limitEdgeFrac: 0.25, cutMargin: 0.01, kellyFraction: 0.5, maxStake: 50,
    bigEdgeOverride: 0.10, hint: 'Trades every small gap, adds as it grows, quick re-entry, double-size bets: biggest wins and biggest swings' },
};
// The strategy settings a risk level sets
export const RISK_KEYS = ['minEdge', 'minConfidence', 'bigEdgeOverride', 'minHold', 'steadySec', 'lockCall', 'kalshiAgree', 'winFloor', 'fastSec', 'fastConf', 'fastAsk', 'lateMin', 'noCallLastMin', 'earlyMin', 'flipCalls', 'scaleIn', 'scaleStep', 'reentrySec', 'limitEdgeFrac', 'cutMargin', 'kellyFraction', 'maxStake'];
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
  const p = probYes(market, strike, spot, sigmaMin * s.volMultiplier, minutesLeft, driftMin * s.momentumWeight, settleAvg, s.volTails);
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
  const p = (S) => probYes(market, strike, S, sigmaMin * s.volMultiplier, minutesLeft, driftMin * s.momentumWeight, null, s.volTails);
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
  // Richardson extrapolation: the grid's error shrinks with the square of its spacing, so two grids (spacing sd/4 and
  // sd/8) give v8 + (v8 - v4)/3 with that leading error cancelled
  const args = { market, strike, spot, sigmaMin, minutesLeft, side, floor, stopMin, confVol };
  const v4 = holdExact(args, 4), v8 = holdExact(args, 8), v = v4 == null || v8 == null ? v8 : Math.min(1, Math.max(0, v8 + (v8 - v4) / 3));
  if (holdCache.size > 500) holdCache.delete(holdCache.keys().next().value);
  holdCache.set(key, v);
  return v;
}
export function holdExact({ market, strike, spot, sigmaMin, minutesLeft, side, floor, stopMin, confVol }, GRID) {
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
    const h = sd / GRID, half = Math.ceil((6 * vol * Math.sqrt(steps * HOLD_DT) + 6 * sd) / h), n = 2 * half + 1;
    // the 10-second move: the normal density on the grid, normalised (this keeps the step's variance exactly sd^2;
    // integrating the density over each cell would add the cell's own spread, h^2/12 a step, and bias the answer),
    // out to 8.5 sd where the tail is below 1e-17
    const kr = Math.ceil(8.5 * sd / h), ker = [];
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
