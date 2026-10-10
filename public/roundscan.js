// Round scan: one deep read of the current 15-minute round across the five exchanges the app streams live
// (Coinbase, Kraken, Bitstamp, Gemini, Binance.US), from every trade since the round opened.
//   per exchange   buy vs sell dollars (who's the aggressor), net, VWAP, move since the open, whales, pace
//   flow           buyers' share of the dollars, recent minutes counting more (half-life 3 minutes)
//   agreement      how many exchanges (by volume) lean the same way, on flow and on price
//   leader         which exchange's price moves first (lead-lag on 1-second returns vs the others), and whether
//                  it has just moved away from the pack (the rest tend to follow)
//   absorption     heavy selling that doesn't push the price down (or buying that doesn't lift it): someone big is
//                  soaking it up on the other side, which tends to win
//   dispersion     how far apart the exchanges' prices are right now (wide = stressed, fragmented market)
//   momentum       flow in the last minute vs the round's pace (speeding up, fading, flipping)
//   big prints     $25k+ trades: which side the size is on
// All of it rolls up into one verdict for the round (-100 sellers … +100 buyers).
//
// Flow alone can't call a round: what matters is whether BTC closes above the target. So the scan's reads also feed
// a "scan chance": the bot's own odds (which know the distance to the target, the volatility and the time left),
// nudged by the scan, with weights LEARNED from graded rounds (fitScan). It starts at zero weights (scan chance =
// the bot's odds) and only moves once enough rounds show the reads actually predict something. The server takes a
// sample at 10, 6 and 3 minutes left in every round, grades it after Kalshi settles, and scores it against the bot
// alone and Kalshi's own price, out of sample (each sample is scored with the weights from before its result was known).
export const SCAN_EXCHANGES = ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US'];
export const FEATURES = ['flow', 'agree', 'momentum', 'big', 'absorb', 'leader'];
export const FEATURE_NAMES = { flow: 'Flow', agree: 'Agreement', momentum: 'Momentum', big: 'Big prints', absorb: 'Absorption', leader: 'Leader' };
export const CHECKPOINTS = [10, 6, 3]; // minutes left when a sample is taken
export const MIN_SAMPLES = 150; // per checkpoint, before learned weights are used
const BIG = 25000;
const DECAY = Math.LN2 / (3 * 60000); // flow half-life: 3 minutes
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

// trades: [{ t, ex, side ('buy' = taker bought), price, size }] since the round opened (any order)
// sigmaMin: BTC's volatility per minute (log), from the bot; estimated from the trades if missing
export function scanRound(trades, { openTime, now = Date.now(), whaleMin = 100000, sigmaMin = null } = {}) {
  const ts = trades.filter((x) => x.t >= openTime && x.t <= now && x.price > 0 && x.size > 0 && (x.side === 'buy' || x.side === 'sell')).sort((a, b) => a.t - b.t);
  const per = Object.fromEntries(SCAN_EXCHANGES.map((ex) => [ex, { ex, n: 0, buyUsd: 0, sellUsd: 0, pv: 0, vol: 0, first: null, last: null, whales: 0, big: 0, lastMinNet: 0 }]));
  let bigBuy = 0, bigSell = 0, wBuy = 0, wAll = 0, net3 = 0, usd3 = 0;
  for (const x of ts) {
    const e = per[x.ex];
    if (!e) continue;
    const usd = x.price * x.size;
    e.n++; e.pv += x.price * x.size; e.vol += x.size;
    if (x.side === 'buy') e.buyUsd += usd; else e.sellUsd += usd;
    e.first ??= x.price; e.last = x.price;
    if (usd >= whaleMin) e.whales++;
    if (usd >= BIG) { e.big++; if (x.side === 'buy') bigBuy += usd; else bigSell += usd; }
    if (x.t >= now - 60000) e.lastMinNet += x.side === 'buy' ? usd : -usd;
    if (x.t >= now - 180000) { net3 += x.side === 'buy' ? usd : -usd; usd3 += usd; }
    const w = Math.exp((x.t - now) * DECAY); // recent trades count more
    wAll += w * usd; if (x.side === 'buy') wBuy += w * usd;
  }
  const mins = Math.max(0.25, (Math.min(now, openTime + 15 * 60000) - openTime) / 60000);
  const rows = Object.values(per).map((e) => {
    const usd = e.buyUsd + e.sellUsd;
    return { ex: e.ex, n: e.n, usd, buyUsd: e.buyUsd, sellUsd: e.sellUsd, net: e.buyUsd - e.sellUsd, buyShare: usd > 0 ? e.buyUsd / usd : null,
      vwap: e.vol > 0 ? e.pv / e.vol : null, last: e.last, change: e.first != null ? e.last - e.first : null, whales: e.whales, big: e.big, perMin: e.n / mins, lastMinNet: e.lastMinNet };
  });
  const live = rows.filter((r) => r.n > 0);
  const totalUsd = live.reduce((a, r) => a + r.usd, 0), buyUsd = live.reduce((a, r) => a + r.buyUsd, 0);
  if (!live.length || totalUsd <= 0) return { ready: false, rows, exchanges: 0, trades: ts.length };

  // agreement: share of volume on exchanges whose flow leans up, and how many moved up in price
  const upVol = live.filter((r) => r.buyShare > 0.5).reduce((a, r) => a + r.usd, 0);
  const flowAgree = upVol / totalUsd; // 1 = all volume on buy-leaning exchanges
  const priced = live.filter((r) => r.change != null && r.n >= 3);
  const upPrice = priced.filter((r) => r.change > 0).length, downPrice = priced.filter((r) => r.change < 0).length;

  // dispersion: spread of the latest prices across exchanges, and each one's premium to the median
  const lasts = live.filter((r) => r.last != null).map((r) => r.last), mid = median(lasts);
  for (const r of rows) r.premium = r.last != null && mid ? r.last - mid : null;
  const dispersion = lasts.length >= 2 ? Math.max(...lasts) - Math.min(...lasts) : null;
  const othersMid = median(live.filter((r) => r.ex !== 'Coinbase' && r.last != null).map((r) => r.last));
  const cbPremium = per.Coinbase.last != null && othersMid ? per.Coinbase.last - othersMid : null; // US spot demand

  // momentum: net flow in the last minute vs the round's average minute
  const net = buyUsd - (totalUsd - buyUsd);
  const lastMin = live.reduce((a, r) => a + r.lastMinNet, 0), perMinNet = net / mins;
  const momentum = { lastMin, perMin: perMinNet, state: Math.abs(lastMin) < totalUsd / mins * 0.05 ? 'quiet' : Math.sign(lastMin) !== Math.sign(perMinNet) && perMinNet !== 0 ? 'flipping' : Math.abs(lastMin) > Math.abs(perMinNet) * 1.5 ? 'speeding up' : Math.abs(lastMin) < Math.abs(perMinNet) * 0.5 ? 'fading' : 'steady' };

  // volatility for scaling moves: the bot's, or the trades' own (1-minute moves of the cross-exchange median)
  const sigma = sigmaMin > 0 ? sigmaMin : ownVol(ts, openTime, now);

  // absorption: the last 3 minutes' flow vs what the price did about it
  const pNow = midAt(ts, now), p3 = midAt(ts, now - 180000);
  const imb3 = usd3 > 0 ? net3 / usd3 : 0;
  const move3z = pNow && p3 && now - openTime >= 120000 ? Math.log(pNow / p3) / (sigma * Math.sqrt(3)) : null;
  let absorb = 0;
  if (move3z != null && Math.abs(imb3) >= 0.1 && usd3 >= Math.max(20000, totalUsd * 0.08)) {
    const follow = move3z * Math.sign(imb3); // how far price went the way the flow pushed, in typical 3-minute moves
    absorb = -Math.sign(imb3) * Math.min(1, Math.abs(imb3) / 0.4) * clamp((0.5 - follow) / 0.5, 0, 1); // full when price didn't budge
  }
  const absorption = { imb3, move3z, usd3, score: absorb };

  // leader: who moves first, and has it just moved away from the others?
  const leader = leadLag(ts, Math.max(openTime, now - 10 * 60000), now);
  let leaderZ = 0;
  if (leader) {
    const win = Math.max(10, leader.lag * 5) * 1000;
    const dL = moveOf(ts, leader.ex, now - win, now), dO = median(SCAN_EXCHANGES.filter((e) => e !== leader.ex).map((e) => moveOf(ts, e, now - win, now)).filter((v) => v != null));
    if (dL != null && dO != null && mid) {
      leader.edge = dL - dO; // $ the leader is ahead of the pack
      leaderZ = clamp(leader.edge / (mid * sigma * Math.sqrt(win / 60000)) / 1.5, -1, 1);
    }
  }

  // the verdict: flow (recent minutes weighted more), agreement, price moves, momentum, big prints, absorption, leader
  const buyShare = buyUsd / totalUsd, recentShare = wAll > 0 ? wBuy / wAll : buyShare;
  const bigTot = bigBuy + bigSell;
  const mom = clamp(lastMin / (Math.abs(perMinNet) + totalUsd / mins * 0.2) / 1.25, -1, 1);
  const features = {
    flow: clamp((recentShare - 0.5) * 2, -1, 1),
    agree: clamp((flowAgree - 0.5) * 2, -1, 1),
    momentum: mom,
    big: bigTot > 0 ? (bigBuy - bigSell) / bigTot : 0,
    absorb,
    leader: leaderZ,
  };
  const parts = [
    ['Flow', features.flow * 40, `${Math.round(recentShare * 100)}% buyers lately (${Math.round(buyShare * 100)}% of $${fmtK(totalUsd)} all round)`],
    ['Agreement', features.agree * 15, `${live.filter((r) => r.buyShare > 0.5).length} of ${live.length} exchanges lean buy`],
    ['Price', priced.length ? ((upPrice - downPrice) / priced.length) * 10 : 0, `${upPrice} up · ${downPrice} down since the open`],
    ['Momentum', mom * 8, `last minute ${lastMin >= 0 ? '+' : '−'}$${fmtK(Math.abs(lastMin))} (${momentum.state})`],
    ['Big prints', features.big * 7, bigTot > 0 ? `$${fmtK(bigBuy)} buys vs $${fmtK(bigSell)} sells in $25k+ trades` : 'no $25k+ trades yet'],
    ['Absorption', absorb * 12, absorb > 0.05 ? `sellers hit it for $${fmtK(-net3)} in 3 min but price held: buyers absorbing` : absorb < -0.05 ? `buyers lifted it for $${fmtK(net3)} in 3 min but price didn't rise: sellers absorbing` : 'price is following the flow'],
    ['Leader', leaderZ * 8, leader?.edge != null && Math.abs(leaderZ) > 0.1 ? `${leader.ex} is $${Math.abs(leader.edge).toFixed(0)} ${leader.edge > 0 ? 'above' : 'below'} the pack: the rest usually follow` : leader ? `${leader.ex} leads, in step with the rest` : 'no clear leader'],
  ].map(([name, pts, why]) => ({ name, pts: Math.round(pts), why }));
  const score = clamp(parts.reduce((a, p) => a + p.pts, 0), -100, 100);
  // (absorption and the leader are usually quiet, so 40 is already a strong read)
  const verdict = score >= 40 ? 'Strong buyers' : score >= 15 ? 'Leans up' : score <= -40 ? 'Strong sellers' : score <= -15 ? 'Leans down' : 'Mixed';
  return {
    ready: true, rows, exchanges: live.length, trades: ts.length, totalUsd, buyUsd, net, buyShare, recentShare, flowAgree,
    upPrice, downPrice, dispersion, mid, cbPremium, momentum, leader, absorption, bigBuy, bigSell, parts, score, verdict, features,
    lean: score >= 15 ? 'YES' : score <= -15 ? 'NO' : null,
  };
}

// The median of each exchange's latest price at time t (only prices from the minute before count). Walks back from
// the newest trade, so recent times cost little even in a busy round.
function midAt(ts, t) {
  const last = {};
  for (let i = ts.length - 1; i >= 0; i--) { const x = ts[i]; if (x.t > t) continue; if (x.t < t - 60000) break; if (!(x.ex in last)) last[x.ex] = x.price; }
  return median(Object.values(last));
}
// One exchange's price change between two times (its last trade at or before each)
function moveOf(ts, ex, from, to) {
  let a = null, b = null;
  for (let i = ts.length - 1; i >= 0; i--) {
    const x = ts[i];
    if (x.ex !== ex) continue;
    if (b == null && x.t <= to) b = x.price;
    if (x.t <= from) { a = x.price; break; }
  }
  return a != null && b != null ? b - a : null;
}
function ownVol(ts, openTime, now) {
  const r = [];
  let prev = null;
  for (let t = openTime + 60000; t <= now; t += 60000) { const p = midAt(ts, t); if (p && prev) r.push(Math.log(p / prev)); prev = p ?? prev; }
  if (r.length < 3) return 0.0008;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.max(0.0003, Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length));
}

// Which exchange moves first: cross-correlate each exchange's 1-second returns with the median of the others' at
// lags of 1-5 seconds (the strongest lag counts). The one whose moves best predict the rest leads, by `lag` seconds.
export function leadLag(trades, from, to) {
  const n = Math.floor((to - from) / 1000);
  if (n < 60) return null;
  const series = {};
  for (const ex of SCAN_EXCHANGES) series[ex] = new Array(n).fill(null);
  for (const x of trades) {
    const i = Math.floor((x.t - from) / 1000);
    if (i >= 0 && i < n && series[x.ex]) series[x.ex][i] = x.price;
  }
  const rets = {};
  for (const [ex, s] of Object.entries(series)) {
    let last = null, filled = 0;
    const p = s.map((v) => { if (v != null) { last = v; filled++; } return last; });
    if (filled < 20) continue;
    rets[ex] = p.map((v, i) => (i && v != null && p[i - 1] != null ? Math.log(v / p[i - 1]) : 0));
  }
  const names = Object.keys(rets);
  if (names.length < 3) return null;
  let best = null;
  for (const ex of names) {
    const others = names.filter((o) => o !== ex);
    const rest = rets[ex].map((_, i) => median(others.map((o) => rets[o][i])));
    let sc = -1, at = 0;
    for (let lag = 1; lag <= 5; lag++) { const c = corr(rets[ex].slice(0, n - lag), rest.slice(lag)); if (c > sc) { sc = c; at = lag; } }
    if (!best || sc > best.score) best = { ex, score: sc, lag: at };
  }
  return best && best.score > 0.2 ? best : null;
}
function corr(a, b) {
  const k = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < k; i++) { ma += a[i]; mb += b[i]; }
  ma /= k; mb /= k;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < k; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
export const fmtK = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : `${Math.round(v)}`);

// ---------- scan chance: the bot's odds nudged by the scan, with learned weights ----------
const logit = (p) => { const q = clamp(p, 0.02, 0.98); return Math.log(q / (1 - q)); };
const sigm = (z) => 1 / (1 + Math.exp(-z));

// The scan's reads as numbers pointing toward YES (for "below the target" markets, buying points to NO)
export function featureVector(sc, strikeType = 'greater') {
  const dir = /^less/.test(strikeType || '') ? -1 : 1;
  return FEATURES.map((k) => (sc?.features?.[k] ?? 0) * dir);
}
export const checkpointFor = (minutesLeft) => (minutesLeft > 8 ? 10 : minutesLeft > 4.5 ? 6 : 3);

// models: { [checkpoint]: { w: [...], n, active } } from fitScan. Inactive (or missing): the bot's odds unchanged.
export function scanChance(pModel, x, models, minutesLeft) {
  if (pModel == null) return null;
  const m = models?.[checkpointFor(minutesLeft)];
  if (!m?.active || !x) return { p: pModel, active: false, pModel };
  const z = logit(pModel) + m.w.reduce((a, w, i) => a + w * (x[i] || 0), 0);
  return { p: sigm(z), active: true, pModel, shift: sigm(z) - pModel };
}

// L2-regularised logistic regression with the bot's odds as a fixed offset: logit(p) = logit(pModel) + w·x.
// Newton's method (6 weights). The penalty keeps weights near zero until the data clearly says otherwise.
export function fitScan(samples, { l2 = 20 } = {}) {
  const k = FEATURES.length, xs = samples.filter((s) => s.y === 0 || s.y === 1);
  const w = new Array(k).fill(0);
  if (!xs.length) return w;
  for (let it = 0; it < 12; it++) {
    const g = w.map((wi) => l2 * wi), H = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? l2 : 0)));
    for (const s of xs) {
      const p = sigm(logit(s.pModel) + w.reduce((a, wi, i) => a + wi * (s.x[i] || 0), 0)), r = p - s.y, v = p * (1 - p);
      for (let i = 0; i < k; i++) { g[i] += r * (s.x[i] || 0); for (let j = 0; j < k; j++) H[i][j] += v * (s.x[i] || 0) * (s.x[j] || 0); }
    }
    const step = solve(H, g);
    if (!step) break;
    let moved = 0;
    for (let i = 0; i < k; i++) { w[i] -= step[i]; moved += Math.abs(step[i]); }
    if (moved < 1e-6) break;
  }
  return w.map((v) => clamp(v, -3, 3));
}
function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
export function fitModels(samples, opts) {
  const out = {};
  for (const cp of CHECKPOINTS) {
    const xs = samples.filter((s) => s.cp === cp && (s.y === 0 || s.y === 1));
    out[cp] = { w: fitScan(xs.slice(-3000), opts), n: xs.length, active: xs.length >= MIN_SAMPLES };
  }
  return out;
}

// The honest record, per checkpoint: Brier score (lower = better) of the bot alone, the scan chance (scored with the
// weights it had BEFORE the round's result was known) and Kalshi's own price; how often the lean matched the result
export function scanStats(samples) {
  const out = {};
  for (const cp of CHECKPOINTS) {
    const xs = samples.filter((s) => s.cp === cp && (s.y === 0 || s.y === 1));
    const brier = (f) => { const v = xs.filter((s) => f(s) != null); return v.length ? v.reduce((a, s) => a + (f(s) - s.y) ** 2, 0) / v.length : null; };
    const leaned = xs.filter((s) => s.lean);
    const right = leaned.filter((s) => (s.lean === 'YES') === (s.y === 1)).length;
    const strong = leaned.filter((s) => Math.abs(s.score) >= 40), strongRight = strong.filter((s) => (s.lean === 'YES') === (s.y === 1)).length;
    const active = xs.filter((s) => s.active);
    const bA = active.length ? active.reduce((a, s) => a + (s.pModel - s.y) ** 2, 0) / active.length : null;
    const sA = active.length ? active.reduce((a, s) => a + (s.pScan - s.y) ** 2, 0) / active.length : null;
    out[cp] = { n: xs.length, bot: brier((s) => s.pModel), scan: brier((s) => s.pScan), kalshi: brier((s) => s.kalshi),
      leaned: leaned.length, right, strong: strong.length, strongRight,
      activeN: active.length, skill: bA && sA != null ? 1 - sA / bA : null }; // > 0: the scan made the bot's odds better
  }
  return out;
}

// The old record (kept for the phone's past data): how often the scan's lean matched Kalshi's result
export function scanRecord(log) {
  const graded = log.filter((e) => e.lean && (e.result === 'yes' || e.result === 'no'));
  const right = graded.filter((e) => e.lean.toLowerCase() === e.result).length;
  const strong = graded.filter((e) => Math.abs(e.score) >= 45), strongRight = strong.filter((e) => e.lean.toLowerCase() === e.result).length;
  return { graded: graded.length, right, strong: strong.length, strongRight, mixed: log.filter((e) => !e.lean && e.result).length };
}
