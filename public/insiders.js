// The Insiders tab (v13.54): where the big money is moving, in one place. Pure summaries of what the app already
// collects; the tab (app.js renderInsiders) shows them, and /api/insiders (server.js) sends the server-side parts.
//   Kalshi      the biggest orders on this round's contract (the phone polls Kalshi's trades)
//   exchanges   whale trades on the coin's exchanges (the phone's live feeds)
//   futures     liquidations (forced closes) and positioning: funding, open interest (scanfeed.js, futures.js)
//   on-chain    Whale Alert's large transfers onto and off exchanges (flowsfeed.js, with WHALE_ALERT_API_KEY)
//   funds       spot-ETF flows and the stablecoin supply (flowsfeed.js)
// None of it is a call by itself: the tab says, for each, how the bot uses it (context, or on probation until proven).

// this round's Kalshi orders: UP vs DOWN totals and the biggest ones ([{ t, side: 'YES'|'NO', count, price, usd }])
export function kalshiBig(trades, { top = 8 } = {}) {
  const xs = Array.isArray(trades) ? trades.filter((x) => x && x.usd > 0) : [];
  const sum = (side) => xs.filter((x) => x.side === side).reduce((a, x) => ({ usd: a.usd + x.usd, n: a.n + 1 }), { usd: 0, n: 0 });
  const up = sum('YES'), down = sum('NO');
  return { up, down, total: up.usd + down.usd, upShare: up.usd + down.usd > 0 ? up.usd / (up.usd + down.usd) : null, top: [...xs].sort((a, b) => b.usd - a.usd).slice(0, top) };
}
// exchange whales in the last window ([{ t, ex, side: 'buy'|'sell', usd, price, size }])
export function whaleSummary(whales, now, windowMs = 3600000) {
  const xs = (Array.isArray(whales) ? whales : []).filter((x) => x && x.t >= now - windowMs).sort((a, b) => b.t - a.t);
  const buy = xs.filter((x) => x.side === 'buy').reduce((a, x) => a + x.usd, 0), sell = xs.filter((x) => x.side === 'sell').reduce((a, x) => a + x.usd, 0);
  return { n: xs.length, buy, sell, net: buy - sell, list: xs.slice(0, 12) };
}
// liquidations in the last window ([{ t, ex, liq: 'long'|'short', usd, price }]): longs force-sold (pushes down),
// shorts force-bought (pushes up, a squeeze)
export function liqSummary(liqs, now, windowMs = 1800000) {
  const xs = (Array.isArray(liqs) ? liqs : []).filter((x) => x && x.t >= now - windowMs);
  const long = xs.filter((x) => x.liq === 'long').reduce((a, x) => a + x.usd, 0), short = xs.filter((x) => x.liq === 'short').reduce((a, x) => a + x.usd, 0);
  return { n: xs.length, long, short, minutes: Math.round(windowMs / 60000), biggest: [...xs].sort((a, b) => b.usd - a.usd).slice(0, 8).map(({ t, ex, liq, usd, price }) => ({ t, ex, liq, usd, price })) };
}
// futures positioning, in plain words (Hyperliquid's context: funding is per hour; premium is perp vs index)
export function positioning(ctx) {
  if (!ctx) return null;
  const f = Number.isFinite(ctx.funding) ? ctx.funding : null, oi5 = Number.isFinite(ctx.oiChange5) ? ctx.oiChange5 : null, px5 = Number.isFinite(ctx.priceChange5) ? ctx.priceChange5 : null;
  const words = [];
  if (f != null) words.push(Math.abs(f) < 0.000005 ? 'funding near zero: neither side crowded' : f > 0 ? `longs paying shorts (${(f * 100).toFixed(4)}%/h): more traders betting up${f > 0.00005 ? ', crowded' : ''}` : `shorts paying longs (${(Math.abs(f) * 100).toFixed(4)}%/h): more traders betting down${f < -0.00005 ? ', crowded' : ''}`);
  if (oi5 != null && px5 != null && Math.abs(oi5) >= 0.001) words.push(oi5 > 0 ? `open interest up ${(oi5 * 100).toFixed(2)}% in 5 min: new money ${px5 >= 0 ? 'buying the rise' : 'selling the drop'}` : `open interest down ${(Math.abs(oi5) * 100).toFixed(2)}% in 5 min: positions closing${px5 >= 0 ? ' (shorts covering?)' : ' (longs giving up?)'}`);
  return { funding: f, fundingYear: f != null ? f * 24 * 365 : null, oi: ctx.oi ?? null, oiChange5: oi5, priceChange5: px5, premium: Number.isFinite(ctx.premium) ? ctx.premium : null, live: !!ctx.live, words };
}
// a Whale Alert transfer's direction: coins onto an exchange (often to sell), off one (often to hold), or neither
export function transferDir(tx) {
  const to = tx?.to?.owner_type === 'exchange', from = tx?.from?.owner_type === 'exchange';
  return to && !from ? 'onto' : from && !to ? 'off' : to && from ? 'between' : 'wallets';
}
