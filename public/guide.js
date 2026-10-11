// The shot-caller guide ("THE ULTIMATE BTC 15-MINUTE SHOT-CALLER GUIDE"): an UP / DOWN / NO CALL forecast for the
// next 15 minutes (the next Kalshi round), with a calibrated UP probability, entry, invalidation, expiry and evidence.
// Pure; playbookfeed.js runs it on the 1-minute history, read as 15-minute candles (public/reversal.js to15).
//   Evidence on the latest closed 15-minute candle, each +1 (up), -1 (down) or 0:
//     VWAP       price above / below the day's VWAP
//     EMA        20 EMA above / below the 50 EMA
//     RSI        RSI 14 above / below 50
//     Structure  higher highs and higher lows, or a close above the last swing high (bullish); the mirror (bearish)
//   UP candidate = all four up; DOWN candidate = all four down. Anything else is NO CALL (conflicting).
//   Also NO CALL when: volatility is too low (ATR 14 in the bottom 20% of the last week: nothing to call), the
//   setup is untested (fewer than 30 past examples of this exact evidence), or its history doesn't back it (the
//   calibrated chance for the candidate's side is not above 50%). Major economic announcements aren't known to the
//   bot (no calendar feed), so they're the one NO CALL rule it can't apply by itself.
//   The UP probability is calibrated, never assumed: how often the next 15 minutes really finished up after the same
//   evidence (the sum, -4..+4), counted WALK-FORWARD (only rounds already finished at that time), shrunk toward 50%.
//   The backtest records every prediction, outcome and skipped round: accuracy, Brier score vs a 50% guess, a
//   calibration table, profit buying the called side at 50c plus Kalshi's fee (a round opens near 50c), and drawdown.
// Kalshi settles on its own index, not Coinbase; very close rounds can settle differently from these candles.
import { ema } from './indicators.js';
import { prep, to15 } from './reversal.js';
import { swings } from './structure.js';
import { fee10, oddsShift, pnl10 } from './model.js';

// the most worth paying for a $10 order at win chance p (the exact fee included)
const maxPay10 = (p) => { for (let c = 99; c >= 1; c--) if (p - c / 100 - fee10(c / 100) >= -1e-9) return c / 100; return null; };
export const GUIDE = { minTested: 30, shrink: 10, lowVolPct: 0.2, volWindow: 672, provenCalls: 300, provenZ: 2.5, cap: 0.04 };
const M15 = 900000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ATR 14 (Wilder) on 15-minute candles
function atrSeries(B) {
  const out = new Array(B.length).fill(null);
  let a = null;
  for (let i = 1; i < B.length; i++) {
    const tr = Math.max(B[i].h - B[i].l, Math.abs(B[i].h - B[i - 1].c), Math.abs(B[i].l - B[i - 1].c));
    if (i < 14) continue;
    a = a == null ? avg(B.slice(i - 13, i + 1).map((b, j) => { const p = B[i - 13 + j - 1]; return Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)); })) : (a * 13 + tr) / 14;
    out[i] = a;
  }
  return out;
}
export function guidePrep(B) {
  const P = prep(B), closes = B.map((b) => b.c);
  return { ...P, e20: ema(closes, 20), e50: ema(closes, 50), atr: atrSeries(B) };
}

// The evidence and the levels at candle k
export function evidenceAt(G, k) {
  const { B, rsi, e20, e50, atr } = G, b = B[k];
  if (e50[k] == null || rsi[k] == null || atr[k] == null || b.vwap == null) return null;
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const win = B.slice(Math.max(0, k - 40), k + 1), sw = swings(win, 2), [h1, h2] = sw.hi.slice(-2), [l1, l2] = sw.lo.slice(-2);
  let structure = 0;
  if ((h1 && h2 && l1 && l2 && h2.p > h1.p && l2.p > l1.p) || (h2 && b.c > h2.p)) structure = 1;
  if ((h1 && h2 && l1 && l2 && h2.p < h1.p && l2.p < l1.p) || (l2 && b.c < l2.p)) structure = structure === 1 ? 0 : -1;
  const ev = { vwap: sgn(b.c - b.vwap), ema: sgn(e20[k] - e50[k]), rsi: sgn(rsi[k] - 50), structure };
  // liquidity: the nearest swing high above and swing low below (where stops and liquidations cluster)
  const above = sw.hi.filter((x) => x.p > b.c).map((x) => x.p).sort((a, c) => a - c)[0] ?? null;
  const below = sw.lo.filter((x) => x.p < b.c).map((x) => x.p).sort((a, c) => c - a)[0] ?? null;
  // low volatility: ATR as a share of price in the bottom 20% of the last week
  const rel = (i) => (atr[i] != null ? atr[i] / B[i].c : null);
  const hist = []; for (let i = Math.max(0, k - GUIDE.volWindow); i < k; i++) { const r = rel(i); if (r != null) hist.push(r); }
  hist.sort((a, c) => a - c);
  const lowVol = hist.length >= 96 && rel(k) < hist[Math.floor(hist.length * GUIDE.lowVolPct)];
  return { ev, sum: ev.vwap + ev.ema + ev.rsi + ev.structure, atr: atr[k], close: b.c, vwap: b.vwap, e20: e20[k], e50: e50[k], rsi: rsi[k], above, below, lowVol, lastLo: l2?.p ?? null, lastHi: h2?.p ?? null };
}

// Calibration: per evidence sum, how often the next 15 minutes finished up (shrunk toward 50%)
const newCal = () => Object.fromEntries([-4, -3, -2, -1, 0, 1, 2, 3, 4].map((s) => [s, { n: 0, up: 0 }]));
export const calP = (c) => (c.up + GUIDE.shrink / 2) / (c.n + GUIDE.shrink);

// The forecast from evidence plus a calibration table
export function forecastFrom(e, cal) {
  if (!e) return { call: 'NO CALL', reason: 'not enough history', pUp: null };
  const c = cal[e.sum], pUp = calP(c);
  const dir = e.sum === 4 ? 'UP' : e.sum === -4 ? 'DOWN' : null;
  let reason = null;
  if (!dir) reason = 'conflicting indicators';
  else if (e.lowVol) reason = 'volatility too low';
  else if (c.n < GUIDE.minTested) reason = `untested setup (${c.n} past examples, needs ${GUIDE.minTested})`;
  else if ((dir === 'UP' ? pUp : 1 - pUp) <= 0.5) reason = `history doesn't back it (${dir} won ${Math.round((dir === 'UP' ? pUp : 1 - pUp) * 100)}% after this setup)`;
  // invalidation: the latest higher low (UP) / lower high (DOWN), kept within 1.5 ATR of the entry
  const inval = dir === 'UP' ? Math.max(e.lastLo ?? -Infinity, e.close - 1.5 * e.atr) : dir === 'DOWN' ? Math.min(e.lastHi ?? Infinity, e.close + 1.5 * e.atr) : null;
  return { call: reason ? 'NO CALL' : dir, candidate: dir, reason, pUp, n: c.n, sum: e.sum, invalidation: inval };
}

// The whole history, walk-forward: every candle's prediction, graded on the next one
export function guideBacktest(bars) {
  const B = to15(bars), G = guidePrep(B), cal = newCal(), rows = [];
  for (let k = 50; k + 1 < B.length; k++) {
    if (B[k + 1].t !== B[k].t + M15) continue;
    const e = evidenceAt(G, k);
    if (!e) continue;
    const f = forecastFrom(e, cal), up = B[k + 1].c > B[k].c;
    rows.push({ t: B[k].t + M15, call: f.call, reason: f.reason, pUp: f.pUp, up, sum: e.sum, y: Math.log(B[k + 1].c / B[k].c) / ((e.atr / e.close) || 1e-4) });
    cal[e.sum].n++; if (up) cal[e.sum].up++; // learned only after the prediction was made
  }
  return { rows, cal };
}

// The scorecard the guide asks for
export function guideReport(bt) {
  const { rows } = bt, calls = rows.filter((r) => r.call !== 'NO CALL');
  const won = (r) => (r.call === 'UP') === r.up;
  const usd = (r) => pnl10(0.5, won(r)); // $10 at 50c = 20 contracts, with the order's exact fee
  let eq = 0, peak = 0, dd = 0;
  for (const r of calls) { eq += usd(r); peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const wins = calls.filter(won).length, acc = calls.length ? wins / calls.length : null;
  const z = calls.length ? (acc - 0.5) / Math.sqrt(0.25 / calls.length) : 0;
  const graded = rows.filter((r) => r.pUp != null);
  const brier = graded.length ? avg(graded.map((r) => (r.pUp - (r.up ? 1 : 0)) ** 2)) : null;
  const bins = [[0, 0.4], [0.4, 0.45], [0.45, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 1.01]].map(([a, b]) => {
    const xs = graded.filter((r) => r.pUp >= a && r.pUp < b);
    return { from: a, to: Math.min(1, b), n: xs.length, said: xs.length ? avg(xs.map((r) => r.pUp)) : null, actual: xs.length ? xs.filter((r) => r.up).length / xs.length : null };
  }).filter((x) => x.n);
  const skipped = {};
  for (const r of rows) if (r.call === 'NO CALL') { const k = r.reason.replace(/ \(.*$/, ''); skipped[k] = (skipped[k] || 0) + 1; }
  const side = (d) => { const xs = calls.filter((r) => r.call === d); return { n: xs.length, wins: xs.filter(won).length, mean: xs.length ? avg(xs.map((r) => (d === 'UP' ? 1 : -1) * r.y)) : 0 }; };
  return { rounds: rows.length, calls: calls.length, wins, accuracy: acc, z, proven: calls.length >= GUIDE.provenCalls && z >= GUIDE.provenZ,
    usd: eq, maxDD: dd, brier, brierBase: 0.25, calibration: bins, skipped, up: side('UP'), down: side('DOWN'), last: calls.slice(-10).reverse() };
}

// The forecast right now, in the guide's output format, with Kalshi's prices compared
export function guideNow(bars, cal, { now = Date.now(), quote = null, flow = null, futures = null } = {}) {
  const B = to15(bars, now);
  if (B.length < 60) return null;
  const G = guidePrep(B), k = B.length - 1, e = evidenceAt(G, k), f = forecastFrom(e, cal);
  if (!e) return null;
  const at = B[k].t + M15, $ = (p) => `$${Math.round(p).toLocaleString()}`, ud = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'neutral');
  const evidence = [
    `Trend: price ${e.ev.vwap > 0 ? 'above' : 'below'} VWAP (${$(e.vwap)}); 20 EMA ${e.ev.ema > 0 ? 'above' : 'below'} 50 EMA (${$(e.e20)} vs ${$(e.e50)})`,
    `Momentum: RSI ${Math.round(e.rsi)} (${e.ev.rsi > 0 ? 'above' : 'below'} 50)${flow != null ? `; buyers ${Math.round(flow * 100)}% of the last 15 minutes' volume (CVD ${flow >= 0.5 ? 'rising' : 'falling'})` : ''}`,
    `Structure: ${e.ev.structure > 0 ? 'bullish (higher highs and lows, or a break above the last swing high)' : e.ev.structure < 0 ? 'bearish (lower highs and lows, or a break below the last swing low)' : 'no clear structure'}`,
    `Liquidity: ${e.above ? `stops likely above ${$(e.above)}` : 'no swing high above'}; ${e.below ? `below ${$(e.below)}` : 'no swing low below'}`,
    `Volatility: ATR ${$(e.atr)} per 15 minutes${e.lowVol ? ' (unusually low)' : ''}`,
  ];
  if (futures?.funding != null) evidence.push(`Positioning: funding ${(futures.funding * 100).toFixed(4)}%${futures.oiChange5 != null ? `, open interest ${futures.oiChange5 >= 0 ? '+' : ''}${(futures.oiChange5 * 100).toFixed(2)}% in 5 min` : ''}`);
  let kalshi = null;
  if (quote && f.pUp != null) {
    const side = f.call === 'DOWN' ? 'NO' : 'YES', ask = side === 'YES' ? quote.yesAsk : quote.noAsk, p = side === 'YES' ? f.pUp : 1 - f.pUp;
    if (ask != null && ask > 0 && ask < 1) kalshi = { side, ask, p, fee: fee10(ask), edge: p - ask - fee10(ask), maxPay: maxPay10(p) }; // a $10 order's exact fee
  }
  return { at, expiry: at + M15, ...f, entry: e.close, evidence, signals: e.ev, atr: e.atr, kalshi, levels: { above: e.above, below: e.below }, ud: ud(e.sum) };
}

// For the bot's calls: once the guide's calls are proven (300+ calls, accuracy z >= 2.5, walk-forward), its call nudges
// the round it was made for by the measured move, capped at +-4 points
export function guideShift(g, report, { spot, strike, sigmaMin, minutesLeft, strikeType = 'greater', openTime }) {
  if (!g || g.call === 'NO CALL' || !report?.proven || g.at !== openTime || !(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0)) return 0;
  const s = g.call === 'UP' ? report.up : report.down, rel = g.atr / g.entry;
  if (!(s?.n > 0) || !(rel > 0)) return 0;
  const move = (g.call === 'UP' ? 1 : -1) * s.mean * (s.n / (s.n + 100)) * rel * spot * Math.min(1, minutesLeft / 15);
  return oddsShift(move, { spot, strike, sigmaMin, minutesLeft, strikeType }, GUIDE.cap);
}
