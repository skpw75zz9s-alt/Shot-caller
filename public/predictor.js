// The prediction engine ("BTC market prediction system"): a statistical model trained on the 1-minute BTC history that
// gives a calibrated UP and DOWN probability for the live round at 15, 10, 5 and 2 minutes before its close, tested
// walk-forward against a 50/50 guess, the distance-to-target odds alone and a simple momentum strategy. Pure;
// playbookfeed.js runs it on the server.
//   The question   will BTC finish above the round's target (its price when the round opened)?
//   The start      the distance-to-target odds: N(ln(price / target) / (1-minute volatility x sqrt(minutes left))).
//                  This is what the bot's own odds are built on, and what makes late calls look so accurate: with
//                  BTC $150 over the target and 2 minutes left, most of the answer is already in.
//   The factors    (each around 0, + = up) layered on top by a logistic model, one per checkpoint:
//                  1-hour trend (the 20-hour vs 50-hour average), 15-minute EMA 20/50, VWAP, 5-minute RSI and whether
//                  it's rising, 5- and 15-minute momentum, signed volume (up-candle minus down-candle volume), volume
//                  rising with the move, a liquidity sweep and reclaim, and 5-minute market structure.
//   No peeking     every sample uses only candles closed by then; the model is refit each day on earlier days only
//                  and then predicts that day (walk-forward), so every graded probability is out of sample.
//   The test       Brier and log-loss vs 50/50 and vs the distance odds; accuracy and how often it calls at each
//                  confidence threshold (55-90%); momentum's accuracy at the open; and profit after Kalshi's fee and 1c
//                  slippage from betting every disagreement with a market that prices the distance odds (a stand-in: Kalshi's past prices aren't
//                  available; the live record uses real ones).
//   Proven         the model beats the distance odds on log-loss with z >= 2.5 over 1,000+ rounds. Only then does it
//                  touch the bot's calls (by its difference from the distance odds, capped at +-4 points).
import { ema, rsiSeries, aggregate } from './indicators.js';
import { swings } from './structure.js';
import { kalshiFee, normCdf as ncdf } from './model.js';

export const PRED = { checkpoints: [15, 10, 5, 2], l2: 100, minTrainDays: 3, thresholds: [0.55, 0.6, 0.7, 0.8, 0.9], slip: 0.01, provenZ: 2.5, provenRounds: 1000, cap: 0.04 };
export const FACTORS = ['trend1h', 'ema15', 'vwap', 'rsi5', 'rsiRising', 'mom5', 'mom15', 'signedVol', 'volTrend', 'sweep', 'structure'];
export const FACTOR_NAMES = { trend1h: '1-hour trend', ema15: '15-min EMA 20/50', vwap: 'VWAP', rsi5: '5-min RSI', rsiRising: 'RSI rising/falling', mom5: '5-min momentum', mom15: '15-min momentum', signedVol: 'buy vs sell volume', volTrend: 'volume with the move', sweep: 'liquidity sweep', structure: '5-min structure' };
const M = 60000, R15 = 900000, DAY = 86400000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (p) => Math.log(p / (1 - p)), sig = (z) => 1 / (1 + Math.exp(-z));

// Everything the factors need, worked out once over the whole history
export function series(bars) {
  const c = bars.map((b) => b.c), n = bars.length;
  const e300 = ema(c, 300), e750 = ema(c, 750), e1200 = ema(c, 1200), e3000 = ema(c, 3000), rsi = rsiSeries(c, 70);
  const vol = new Array(n).fill(null), vwap = new Array(n).fill(null), sv = new Array(n).fill(0);
  let s2 = 0, day = null, pv = 0, vv = 0;
  for (let i = 0; i < n; i++) {
    const r = i ? Math.log(c[i] / c[i - 1]) : 0; s2 += r * r;
    if (i > 60) { const o = Math.log(c[i - 60] / c[i - 61]); s2 -= o * o; }
    if (i >= 61) vol[i] = Math.max(2e-5, Math.sqrt(Math.max(0, s2) / 60));
    const d = Math.floor(bars[i].t / DAY); if (d !== day) { day = d; pv = 0; vv = 0; }
    const v = bars[i].v > 0 ? bars[i].v : 0; pv += ((bars[i].h + bars[i].l + bars[i].c) / 3) * v; vv += v; vwap[i] = vv > 0 ? pv / vv : null;
    sv[i] = (bars[i].c > bars[i].o ? 1 : bars[i].c < bars[i].o ? -1 : 0) * v;
  }
  const b5 = aggregate(bars, 5), at = new Map(bars.map((b, i) => [b.t, i]));
  return { bars, c, e300, e750, e1200, e3000, rsi, vol, vwap, sv, b5, at };
}

// The factors at bar i (the candle that closed last), with price p (the live price, or that candle's close)
export function factorsAt(S, i, p = S.c[i]) {
  const { bars, c, vol } = S, sd = vol[i];
  if (sd == null || S.e3000[i] == null || S.rsi[i] == null || i < 75) return null;
  const z = (x, mins) => clamp(x / (sd * Math.sqrt(mins)), -3, 3);
  let up = 0, dn = 0, all = 0;
  for (let j = i - 14; j <= i; j++) { const v = Math.abs(S.sv[j]); all += v; if (S.sv[j] > 0) up += v; else if (S.sv[j] < 0) dn += v; }
  const mom5 = Math.log(p / c[i - 5]), v5 = (Math.abs(S.sv[i]) + Math.abs(S.sv[i - 1]) + Math.abs(S.sv[i - 2]) + Math.abs(S.sv[i - 3]) + Math.abs(S.sv[i - 4])) / 5;
  const v15 = all / 15;
  // a sweep: in the last 10 minutes price took out the hour's low (high) before that and is back above (below) it
  let lo = Infinity, hi = -Infinity, rlo = Infinity, rhi = -Infinity;
  for (let j = i - 70; j < i - 10; j++) { lo = Math.min(lo, bars[j].l); hi = Math.max(hi, bars[j].h); }
  for (let j = i - 9; j <= i; j++) { rlo = Math.min(rlo, bars[j].l); rhi = Math.max(rhi, bars[j].h); }
  const sweep = (rlo < lo && p > lo ? 1 : 0) - (rhi > hi && p < hi ? 1 : 0);
  // 5-minute structure over the last 3 hours: higher highs and higher lows (+1), lower highs and lower lows (-1)
  const t = bars[i].t + M, k5 = upper(S.b5, t - 5 * M), w5 = S.b5.slice(Math.max(0, k5 - 36), k5), sw = swings(w5, 2);
  const [h1, h2] = sw.hi.slice(-2), [l1, l2] = sw.lo.slice(-2);
  const structure = h1 && h2 && l1 && l2 ? (h2.p > h1.p && l2.p > l1.p ? 1 : h2.p < h1.p && l2.p < l1.p ? -1 : 0) : 0;
  return {
    trend1h: z(Math.log(S.e1200[i] / S.e3000[i]), 60), ema15: z(Math.log(S.e300[i] / S.e750[i]), 15),
    vwap: S.vwap[i] ? z(Math.log(p / S.vwap[i]), 15) : 0,
    rsi5: (S.rsi[i] - 50) / 25, rsiRising: S.rsi[i - 5] != null ? clamp((S.rsi[i] - S.rsi[i - 5]) / 10, -3, 3) : 0,
    mom5: z(mom5, 5), mom15: z(Math.log(p / c[i - 15]), 15),
    signedVol: all > 0 ? (up - dn) / all : 0, volTrend: v15 > 0 ? clamp(Math.log((v5 + 1e-9) / v15), -2, 2) * Math.sign(mom5) : 0,
    sweep, structure,
  };
}
const upper = (b5, t) => { let lo = 0, hi = b5.length; while (lo < hi) { const m = (lo + hi) >> 1; if (b5[m].t <= t) lo = m + 1; else hi = m; } return lo; }; // 5-minute bars closed by t

// The samples: each round x checkpoint -> { round, m, x (factors), base (distance odds), up, mom15 }
export function samples(bars, S = series(bars)) {
  const out = [];
  if (bars.length < 3200) return out;
  for (let open = Math.ceil(bars[3100].t / R15) * R15; open + R15 <= bars.at(-1).t + M; open += R15) {
    const io = S.at.get(open - M), ie = S.at.get(open + R15 - M);
    if (io == null || ie == null) continue;
    const strike = S.c[io], up = S.c[ie] > strike;
    for (const m of PRED.checkpoints) {
      const i = S.at.get(open + R15 - m * M - M);
      if (i == null) continue;
      const f = factorsAt(S, i);
      if (!f) continue;
      const base = clamp(ncdf(Math.log(S.c[i] / strike) / (S.vol[i] * Math.sqrt(m))), 0.002, 0.998);
      out.push({ round: open, m, x: f, base, up, mom15: f.mom15 });
    }
  }
  return out;
}

// Logistic regression with the distance odds as the starting point (offset), ridge-penalised, by Newton steps
const vec = (s) => [1, logit(s.base), ...FACTORS.map((k) => s.x[k])];
export function fit(ss) {
  const K = FACTORS.length + 2, w = new Array(K).fill(0);
  if (ss.length < 50) return w;
  const X = ss.map(vec), off = ss.map((s) => logit(s.base)), y = ss.map((s) => (s.up ? 1 : 0));
  for (let it = 0; it < 10; it++) {
    const H = Array.from({ length: K }, (_, a) => Array.from({ length: K }, (_, b) => (a === b ? PRED.l2 : 0))), g = w.map((v) => -PRED.l2 * v);
    for (let n = 0; n < X.length; n++) {
      const x = X[n], p = sig(off[n] + x.reduce((a, v, j) => a + v * w[j], 0)), r = y[n] - p, q = p * (1 - p);
      for (let a = 0; a < K; a++) { g[a] += r * x[a]; for (let b = 0; b < K; b++) H[a][b] += q * x[a] * x[b]; }
    }
    const step = solve(H, g);
    if (!step) break;
    for (let a = 0; a < K; a++) w[a] += step[a];
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return w;
}
export const predict = (w, s) => clamp(sig(logit(s.base) + vec(s).reduce((a, v, j) => a + v * (w?.[j] ?? 0), 0)), 0.002, 0.998);

// Walk-forward: refit every day on the days before it, predict that day
export function walkForward(bars) {
  const S = series(bars), ss = samples(bars, S), days = [...new Set(ss.map((s) => Math.floor(s.round / DAY)))].sort((a, b) => a - b);
  const out = [];
  for (let d = PRED.minTrainDays; d < days.length; d++) {
    const train = ss.filter((s) => Math.floor(s.round / DAY) < days[d]), test = ss.filter((s) => Math.floor(s.round / DAY) === days[d]);
    for (const m of PRED.checkpoints) { const w = fit(train.filter((s) => s.m === m)); for (const s of test.filter((x) => x.m === m)) out.push({ ...s, p: predict(w, s) }); }
  }
  return { rows: out, samples: ss, S };
}

// The report the system asks for
export function predictorReport(rows) {
  const brier = (xs, f) => (xs.length ? xs.reduce((a, r) => a + (f(r) - (r.up ? 1 : 0)) ** 2, 0) / xs.length : null);
  const ll = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));
  const fee = (p) => kalshiFee(p) + PRED.slip;
  const one = (xs) => {
    // paired log-loss gain over the distance odds, per round
    const byRound = new Map();
    for (const r of xs) byRound.set(r.round, (byRound.get(r.round) || 0) + ll(r.base, r.up) - ll(r.p, r.up));
    const g = [...byRound.values()], n = g.length, mean = n ? g.reduce((a, b) => a + b, 0) / n : 0, sd = n > 1 ? Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const thresholds = PRED.thresholds.map((t) => {
      const pick = (f) => { const c = xs.filter((r) => Math.max(f(r), 1 - f(r)) >= t); const right = c.filter((r) => (f(r) >= 0.5) === r.up).length; return { n: c.length, share: xs.length ? c.length / xs.length : 0, accuracy: c.length ? right / c.length : null }; };
      return { t, model: pick((r) => r.p), distance: pick((r) => r.base) };
    });
    // simple momentum: at the round's open, call the way the last 15 minutes went (later in the round that move is
    // mostly the distance to the target, so it's only fair at the open)
    const mom = xs.filter((r) => r.m === 15 && r.mom15 !== 0), momRight = mom.filter((r) => (r.mom15 > 0) === r.up).length;
    // profit: buy the side the model rates above the distance-odds price by more than fee + slippage ($10 a call).
    // An unproven model loses here: its disagreements are noise, which is why it never trades until proven
    let usd = 0, bets = 0, wins = 0, eq = 0, peak = 0, dd = 0;
    for (const r of xs) {
      const yes = r.p >= r.base, pSide = yes ? r.p : 1 - r.p, price = Math.round(clamp(yes ? r.base : 1 - r.base, 0.01, 0.99) * 100) / 100;
      if (pSide - price - fee(price) <= 0) continue;
      const won = yes === r.up; bets++; if (won) wins++;
      const v = (10 / price) * ((won ? 1 : 0) - price - fee(price)); usd += v; eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    }
    return { n: xs.length, rounds: n, brier: brier(xs, (r) => r.p), brierDistance: brier(xs, (r) => r.base), brierCoin: 0.25, gain: mean, z: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0,
      thresholds, momentum: { n: mom.length, accuracy: mom.length ? momRight / mom.length : null }, trades: { n: bets, wins, usd, maxDD: dd } };
  };
  const all = one(rows);
  return { ...all, proven: all.rounds >= PRED.provenRounds && all.z >= PRED.provenZ, byCheckpoint: Object.fromEntries(PRED.checkpoints.map((m) => [m, one(rows.filter((r) => r.m === m))])) };
}

// The live forecast: P(UP) and P(DOWN) for the round now, from the models fitted on the whole history
// (UP = BTC finishing above the target; on a "less than" market that's NO)
export function predictNow(S, models, { price, strike, minutesLeft, now }) {
  if (!(price > 0) || !(strike > 0) || !(minutesLeft > 0.3) || minutesLeft > 15.5) return null;
  let i = S.bars.length - 1;
  while (i >= 0 && S.bars[i].t + M > now) i--; // the last closed candle
  if (i < 0 || now - (S.bars[i].t + M) > 3 * M) return null; // stale candles: no live signal
  const f = factorsAt(S, i, price);
  if (!f) return null;
  const m = PRED.checkpoints.reduce((a, b) => (Math.abs(b - minutesLeft) < Math.abs(a - minutesLeft) ? b : a));
  const base = clamp(ncdf(Math.log(price / strike) / (S.vol[i] * Math.sqrt(minutesLeft))), 0.002, 0.998);
  const s = { base, x: f }, pUp = predict(models[m], s), w = models[m] || [];
  const push = FACTORS.map((k, j) => ({ key: k, name: FACTOR_NAMES[k], v: f[k], push: (w[j + 2] ?? 0) * f[k] })).sort((a, b) => Math.abs(b.push) - Math.abs(a.push));
  return { pUp, pDown: 1 - pUp, base, checkpoint: m, factors: f, push, sd: S.vol[i], m1: price - S.c[i - 1] }; // m1: the last minute's move (entry timing)
}
// For the bot's calls: the model's difference from the distance odds, once proven, capped
export function predictorShift(live, report, strikeType = 'greater') {
  if (!live || !report?.proven) return 0;
  const d = clamp(live.pUp - live.base, -PRED.cap, PRED.cap);
  return /^less/.test(strikeType || '') ? -d : d;
}

export function solve(A, b) { // Gaussian elimination with partial pivoting (also used by public/candlemodel.js)
  const n = b.length, M2 = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M2[r][c]) > Math.abs(M2[p][c])) p = r;
    if (Math.abs(M2[p][c]) < 1e-12) return null;
    [M2[c], M2[p]] = [M2[p], M2[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M2[r][c] / M2[c][c]; for (let k = c; k <= n; k++) M2[r][k] -= f * M2[c][k]; }
  }
  return M2.map((r, i) => r[n] / r[i]);
}
