// Order flow from live trades: who is hitting whom. Every Coinbase trade has an aggressor: a taker BUY lifted the
// ask (buyers pushing up), a taker SELL hit the bid (sellers pushing down). Pure functions; app.js feeds trades.
// This is context, not part of the call: it hasn't been tested as a predictor of the 15-minute result.

export const newFlow = () => ({ round: null, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, recent: [], whales: [], pressure: null, pressureSince: null });

// Coinbase "match" messages name the MAKER's side, so the taker (aggressor) is the opposite one
export const takerSide = (makerSide) => (makerSide === 'sell' ? 'buy' : makerSide === 'buy' ? 'sell' : null);

const RECENT_MS = 120000;

// Add one trade { t, price, size, side: taker 'buy' | 'sell' }. `round` is the current window's open time:
// totals reset when it changes. Returns a whale event when the trade is at least whaleMin dollars.
export function addTrade(f, trade, { round, whaleMin = 100000 } = {}) {
  if (!(trade.price > 0 && trade.size > 0) || (trade.side !== 'buy' && trade.side !== 'sell')) return null;
  if (round != null && f.round !== round) Object.assign(f, newFlow(), { round, recent: f.recent, pressure: f.pressure, pressureSince: f.pressureSince });
  const usd = trade.price * trade.size;
  if (trade.side === 'buy') { f.buyUsd += usd; f.buys++; } else { f.sellUsd += usd; f.sells++; }
  f.recent.push({ t: trade.t, usd, side: trade.side });
  while (f.recent.length && f.recent[0].t < trade.t - RECENT_MS) f.recent.shift();
  if (usd >= whaleMin) {
    const w = { t: trade.t, usd, side: trade.side, price: trade.price, size: trade.size, ex: trade.ex ?? null };
    f.whales.unshift(w);
    f.whales.length = Math.min(f.whales.length, 30);
    return w;
  }
  return null;
}

// Buy share of dollar volume: over the round, and over the last 2 minutes (the "tug of war" right now)
export function flowStats(f, now = Date.now()) {
  const recent = f.recent.filter((x) => x.t >= now - RECENT_MS);
  const rb = recent.filter((x) => x.side === 'buy').reduce((a, x) => a + x.usd, 0);
  const rs = recent.reduce((a, x) => a + x.usd, 0) - rb;
  const total = f.buyUsd + f.sellUsd;
  return {
    buyUsd: f.buyUsd, sellUsd: f.sellUsd, net: f.buyUsd - f.sellUsd, prints: f.buys + f.sells,
    roundBuyShare: total > 0 ? f.buyUsd / total : null,
    nowBuyShare: rb + rs > 0 ? rb / (rb + rs) : null, nowUsd: rb + rs,
    whaleBuys: f.whales.filter((w) => w.side === 'buy').length, whaleSells: f.whales.filter((w) => w.side === 'sell').length,
  };
}

// Sustained pressure: which side has had 60%+ of the last 2 minutes' volume for at least `holdMs`.
// Returns { side, flipped } where flipped is true the moment a sustained side replaces the opposite one.
export function pressureUpdate(f, now = Date.now(), { share = 0.6, holdMs = 10000, minUsd = 50000 } = {}) {
  const st = flowStats(f, now);
  const side = st.nowBuyShare == null || st.nowUsd < minUsd ? null : st.nowBuyShare >= share ? 'buy' : 1 - st.nowBuyShare >= share ? 'sell' : null;
  if (side !== f.candidate) { f.candidate = side; f.candidateSince = now; }
  if (!side || now - f.candidateSince < holdMs || f.pressure === side) return { side: f.pressure, flipped: false };
  const flipped = f.pressure != null && f.pressure !== side;
  f.pressure = side; f.pressureSince = now;
  return { side, flipped };
}
