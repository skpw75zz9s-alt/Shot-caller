// Live results: how the auto-trader's REAL trades went. Pure function over the closed trades (from Kalshi fills) and
// the bot's own order log, so it reports only what the bot bought, not trades you made yourself in the Kalshi app.
const r2 = (v) => Math.round(v * 100) / 100;
export const EXIT_NAMES = { take: 'Take profit', lock: 'Profit lock', cut: 'Cut loss', settle: 'Held to settlement', sell: 'Other sell' };
export const confGroup = (c) => (c == null ? 'unknown' : c >= 90 ? '90+' : c >= 80 ? '80–89' : 'under 80 (big gap)');

// The bot's buy for a closed trade: a filled live buy on the same market and side, before the trade closed
function botBuy(t, orders) {
  return orders.filter((o) => o.action === 'buy' && o.ticker === t.ticker && o.side === t.side && (o.filled > 0 || o.status === 'filled') && o.at <= t.closedAt)
    .sort((a, b) => b.at - a.at)[0] ?? null;
}
// How it exited: settlement, or the kind of the bot's last sell on that market before it closed
function exitKind(t, orders) {
  if (t.how === 'settled') return 'settle';
  const sell = orders.filter((o) => o.action === 'sell' && o.ticker === t.ticker && o.at <= t.closedAt + 60000).sort((a, b) => b.at - a.at)[0];
  return sell?.kind && EXIT_NAMES[sell.kind] ? sell.kind : 'sell';
}

const sum = (xs) => xs.reduce((a, t) => a + t.pnl, 0);
function stats(ts) {
  const wins = ts.filter((t) => t.pnl > 0), losses = ts.filter((t) => t.pnl <= 0);
  return {
    // exact = trades using Kalshi's own fills and fees
    n: ts.length, wins: wins.length, pnl: r2(sum(ts)), exact: ts.filter((t) => t.exact).length, winRate: ts.length ? wins.length / ts.length : null,
    avgWin: wins.length ? r2(sum(wins) / wins.length) : null, avgLoss: losses.length ? r2(sum(losses) / losses.length) : null,
    perTrade: ts.length ? r2(sum(ts) / ts.length) : null,
    best: ts.length ? r2(Math.max(...ts.map((t) => t.pnl))) : null, worst: ts.length ? r2(Math.min(...ts.map((t) => t.pnl))) : null,
  };
}

export function liveReport({ trades, orders, since = 0 }) {
  const bot = [];
  for (const t of trades) {
    if (t.source !== 'kalshi' || !(t.closedAt >= since)) continue;
    const buy = botBuy(t, orders);
    if (buy) bot.push({ ...t, kind: exitKind(t, orders), conf: buy.conf ?? null });
  }
  const group = (key) => {
    const g = {};
    for (const t of bot) (g[key(t)] ||= []).push(t);
    return Object.fromEntries(Object.entries(g).map(([k, ts]) => [k, stats(ts)]));
  };
  const recent = orders.filter((o) => o.at >= since);
  const buys = recent.filter((o) => o.action === 'buy');
  const errs = {};
  for (const o of recent.filter((x) => x.status === 'error')) { const k = String(o.error || 'unknown').split(' · ')[0].slice(0, 60); errs[k] = (errs[k] || 0) + 1; }
  return {
    trades: bot, total: stats(bot), byExit: group((t) => t.kind), byConf: group((t) => confGroup(t.conf)),
    orders: {
      buys: buys.length, filled: buys.filter((o) => o.filled > 0 || o.status === 'filled').length,
      noFill: buys.filter((o) => o.filled === 0 && o.status !== 'error' && o.status !== 'resting').length,
      errors: recent.filter((o) => o.status === 'error').length,
      topErrors: Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 3),
    },
  };
}
