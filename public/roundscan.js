// Round scan: one deep read of the current 15-minute round across the five exchanges the app streams live
// (Coinbase, Kraken, Bitstamp, Gemini, Binance.US), from every trade since the round opened.
//   per exchange   buy vs sell dollars (who's the aggressor), net, VWAP, move since the open, whales, pace
//   agreement      how many exchanges (by volume) lean the same way, on flow and on price
//   leader         which exchange's price moves first (lead-lag on 1-second returns vs the others)
//   dispersion     how far apart the exchanges' prices are right now (wide = stressed, fragmented market)
//   momentum       flow in the last minute vs the round's pace (speeding up, fading, flipping)
//   big prints     $25k+ trades: which side the size is on
// All of it rolls up into one verdict for the round (-100 sellers … +100 buyers). It's graded against Kalshi's
// result at every settle (app.js keeps the record), so it shows whether it's actually worth anything. It's context:
// the bot's calls don't use it.
export const SCAN_EXCHANGES = ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US'];
const BIG = 25000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

// trades: [{ t, ex, side ('buy' = taker bought), price, size }] since the round opened (any order)
export function scanRound(trades, { openTime, now = Date.now(), whaleMin = 100000 } = {}) {
  const ts = trades.filter((x) => x.t >= openTime && x.t <= now && x.price > 0 && x.size > 0 && (x.side === 'buy' || x.side === 'sell')).sort((a, b) => a.t - b.t);
  const per = Object.fromEntries(SCAN_EXCHANGES.map((ex) => [ex, { ex, n: 0, buyUsd: 0, sellUsd: 0, pv: 0, vol: 0, first: null, last: null, whales: 0, big: 0, lastMinNet: 0 }]));
  let bigBuy = 0, bigSell = 0;
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

  // momentum: net flow in the last minute vs the round's average minute
  const net = buyUsd - (totalUsd - buyUsd);
  const lastMin = live.reduce((a, r) => a + r.lastMinNet, 0), perMinNet = net / mins;
  const momentum = { lastMin, perMin: perMinNet, state: Math.abs(lastMin) < totalUsd / mins * 0.05 ? 'quiet' : Math.sign(lastMin) !== Math.sign(perMinNet) && perMinNet !== 0 ? 'flipping' : Math.abs(lastMin) > Math.abs(perMinNet) * 1.5 ? 'speeding up' : Math.abs(lastMin) < Math.abs(perMinNet) * 0.5 ? 'fading' : 'steady' };

  const leader = leadLag(ts, Math.max(openTime, now - 10 * 60000), now);

  // the verdict: flow (volume-weighted buy share), agreement, price moves, momentum and big prints
  const buyShare = buyUsd / totalUsd;
  const bigTot = bigBuy + bigSell;
  const parts = [
    ['Flow', clamp((buyShare - 0.5) * 2 * 45, -45, 45), `${Math.round(buyShare * 100)}% of $${fmtK(totalUsd)} was buyers`],
    ['Agreement', clamp((flowAgree - 0.5) * 2 * 20, -20, 20), `${live.filter((r) => r.buyShare > 0.5).length} of ${live.length} exchanges lean buy`],
    ['Price', priced.length ? clamp(((upPrice - downPrice) / priced.length) * 15, -15, 15) : 0, `${upPrice} up · ${downPrice} down since the open`],
    ['Momentum', clamp((lastMin / (Math.abs(perMinNet) + totalUsd / mins * 0.2)) * 8, -10, 10), `last minute ${lastMin >= 0 ? '+' : '−'}$${fmtK(Math.abs(lastMin))} (${momentum.state})`],
    ['Big prints', bigTot > 0 ? clamp(((bigBuy - bigSell) / bigTot) * 10, -10, 10) : 0, bigTot > 0 ? `$${fmtK(bigBuy)} buys vs $${fmtK(bigSell)} sells in $25k+ trades` : 'no $25k+ trades yet'],
  ].map(([name, pts, why]) => ({ name, pts: Math.round(pts), why }));
  const score = clamp(parts.reduce((a, p) => a + p.pts, 0), -100, 100);
  const verdict = score >= 45 ? 'Strong buyers' : score >= 15 ? 'Leans up' : score <= -45 ? 'Strong sellers' : score <= -15 ? 'Leans down' : 'Mixed';
  return {
    ready: true, rows, exchanges: live.length, trades: ts.length, totalUsd, buyUsd, net, buyShare, flowAgree,
    upPrice, downPrice, dispersion, mid, momentum, leader, bigBuy, bigSell, parts, score, verdict,
    lean: score >= 15 ? 'YES' : score <= -15 ? 'NO' : null,
  };
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

// The record: how often the scan's lean (at the round's close) matched Kalshi's result
export function scanRecord(log) {
  const graded = log.filter((e) => e.lean && (e.result === 'yes' || e.result === 'no'));
  const right = graded.filter((e) => e.lean.toLowerCase() === e.result).length;
  const strong = graded.filter((e) => Math.abs(e.score) >= 45), strongRight = strong.filter((e) => e.lean.toLowerCase() === e.result).length;
  return { graded: graded.length, right, strong: strong.length, strongRight, mixed: log.filter((e) => !e.lean && e.result).length };
}
