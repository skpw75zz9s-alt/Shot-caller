// Market watch on the server (public/watch.js does the spotting): every bot tick (each second) it hands the detector
// everything the server can see: BTC and each exchange from the live trade feeds (scanfeed.js), and the live round's
// Kalshi order book (every 2 s) and trades (every 3 s), read from Kalshi's public market data. Its holds pause NEW
// calls (bot.js), its events go to the phones (/api/watch) and into each official call's record.
import { createDetector } from './public/watch.js';
import { parseBook } from './public/trader.js';
import { parseKalshiTrades } from './public/feeds.js';

export function createMarketWatch({ kalshi, scanFeed, futures = null, fetchJSON = defaultFetch, clock = () => Date.now(), log = console }) {
  const det = createDetector({ clock });
  let book = null, bookAt = 0, tradesAt = 0, busy = { book: false, trades: false }, seen = new Set(), pending = [], lastFlowAt = 0;
  async function pollBook(ticker, now) {
    if (busy.book || now - bookAt < 2000) return;
    busy.book = true; bookAt = now;
    try { book = { ticker, at: now, ...parseBook(await fetchJSON(`${kalshi}/markets/${encodeURIComponent(ticker)}/orderbook`)) }; } catch { /* next time */ } finally { busy.book = false; }
  }
  async function pollTrades(ticker, now) {
    if (busy.trades || now - tradesAt < 3000) return;
    busy.trades = true; tradesAt = now;
    try {
      const fresh = parseKalshiTrades(await fetchJSON(`${kalshi}/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=100`)).filter((x) => !seen.has(x.id));
      for (const x of fresh) { seen.add(x.id); pending.push({ t: x.t, count: x.count, side: x.side }); }
      if (seen.size > 5000) seen = new Set([...seen].slice(-2000));
    } catch { /* next time */ } finally { busy.trades = false; }
  }
  // The live round's book as the detector reads it: best bid/ask for YES, contracts within 3¢ of the price, top levels
  function kalshiView(ticker) {
    if (!book || book.ticker !== ticker || clock() - book.at > 10000) return { ticker };
    const yb = book.yes.length ? Math.max(...book.yes.map((l) => l[0])) : null, nb = book.no.length ? Math.max(...book.no.map((l) => l[0])) : null;
    const yesAsk = nb != null ? Math.round((1 - nb) * 100) / 100 : null;
    const near = book.yes.filter(([p]) => yb != null && p >= yb - 0.03).reduce((a, l) => a + l[1], 0) + book.no.filter(([p]) => nb != null && p >= nb - 0.03).reduce((a, l) => a + l[1], 0);
    const top = (side, rows) => [...rows].sort((a, b) => b[0] - a[0]).slice(0, 5).map(([p, q]) => [side, p, q]);
    return { ticker, yesBid: yb, yesAsk, near, levels: [...top('yes', book.yes), ...top('no', book.no)] };
  }
  function observe({ snap }, now = clock()) {
    const live = snap?.live;
    if (live) { pollBook(live.m.ticker, now); pollTrades(live.m.ticker, now); }
    const flowUsd = scanFeed.flowSince(Math.max(lastFlowAt, now - 5000)); lastFlowAt = now;
    const events = det.step({ now, price: scanFeed.spot(now) ?? snap?.spot ?? null, sigmaMin: snap?.sigmaMin ?? null, venues: scanFeed.venues(now), feeds: scanFeed.feedTimes(),
      flowUsd, kalshi: live ? kalshiView(live.m.ticker) : null, kTrades: pending.splice(0), futures: futures?.context(now) ?? null });
    for (const e of events) if (e.sev === 'severe') log.log?.(`market watch: ${e.text}`);
  }
  return { observe, hold: () => det.hold(), status: () => det.status(), api: () => ({ status: det.status(), events: det.events().slice(0, 40) }) };
}
async function defaultFetch(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
