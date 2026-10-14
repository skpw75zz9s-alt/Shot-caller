// BTC futures as a leading signal (Hyperliquid's BTC perpetual: public data, no key; Binance and Bybit block US
// servers). Research finds futures often move before spot, though the lead has weakened since the spot ETFs, so
// nothing here is trusted on faith: its reads go into the Round scan as extra inputs, which only shape the odds once
// the scan's graded record proves them (public/roundscan.js), and into Market watch as events.
//   trades       wss://api.hyperliquid.xyz/ws, {"method":"subscribe","subscription":{"type":"trades","coin":"BTC"}}
//                -> { channel: 'trades', data: [{ coin, side: 'B' (taker bought) | 'A' (taker sold), px, sz, time }] }
//   context      POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"} every 15 s
//                -> [{ universe: [{ name }] }, [{ funding, openInterest, markPx, oraclePx, premium, midPx }]]
// The reads (features(), all 0 when the feed is down):
//   lead     how far futures moved over the last 30 s beyond what spot did, in typical 30-second moves (futures first)
//   flow     futures takers' buy share of the last 2 minutes' dollars, -1 (all selling) .. +1 (all buying)
//   oi       open interest change over 5 minutes x the price direction: +1 new money pushing the move, -1 positions
//            being closed (a flush or a squeeze)
//   premium  futures' premium to the oracle (spot) price, in tenths of a percent
const WS = 'wss://api.hyperliquid.xyz/ws', INFO = 'https://api.hyperliquid.xyz/info';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createFutures({ WSImpl = globalThis.WebSocket, fetchImpl = (...a) => fetch(...a), clock = () => Date.now(), log = console, coin = 'BTC' } = {}) { // coin: Hyperliquid's name for it (public/markets.js sym.hyper)
  const trades = [], ctxs = []; // trades: { t, px, usd, side }, ctxs: { t, funding, oi, mark, oracle, premium }
  let ws = null, stopped = true, retry = 0, ping = null, poll = null, lastTradeAt = 0;
  function onTrades(list) {
    const now = clock();
    for (const d of list || []) {
      const px = Number(d.px), sz = Number(d.sz);
      if (!(px > 0 && sz > 0) || (d.side !== 'B' && d.side !== 'A')) continue;
      trades.push({ t: Number(d.time) || now, px, usd: px * sz, side: d.side === 'B' ? 'buy' : 'sell' });
      lastTradeAt = now;
    }
    while (trades.length && trades[0].t < now - 600000) trades.shift();
  }
  function onCtx(body) {
    const uni = body?.[0]?.universe, list = body?.[1];
    if (!Array.isArray(uni) || !Array.isArray(list)) return;
    const i = uni.findIndex((u) => u.name === coin), c = list[i];
    if (!c) return;
    ctxs.push({ t: clock(), funding: Number(c.funding), oi: Number(c.openInterest), mark: Number(c.markPx), oracle: Number(c.oraclePx), premium: Number(c.premium) });
    while (ctxs.length && ctxs[0].t < clock() - 1800000) ctxs.shift();
  }
  function open() {
    if (stopped || ws || typeof WSImpl !== 'function') return;
    try { ws = new WSImpl(WS); } catch { return; }
    ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } })); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.channel === 'trades') onTrades(m.data); };
    ws.onclose = () => { ws = null; if (!stopped) { const t = setTimeout(open, Math.min(60000, 1000 * 2 ** ++retry)); t.unref?.(); } };
    ws.onerror = () => { try { ws?.close(); } catch { /* */ } };
  }
  async function pollCtx() {
    try {
      const r = await fetchImpl(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(8000) });
      if (r.ok) onCtx(await r.json());
    } catch { /* next time */ }
  }
  function start() {
    stopped = false; open(); pollCtx();
    poll = setInterval(pollCtx, 15000); poll.unref?.();
    ping = setInterval(() => { try { ws?.readyState === 1 && ws.send(JSON.stringify({ method: 'ping' })); } catch { /* */ } }, 20000); ping.unref?.();
  }
  function stop() { stopped = true; clearInterval(poll); clearInterval(ping); try { ws?.close(); } catch { /* */ } ws = null; }

  const pxAt = (t) => { for (let i = trades.length - 1; i >= 0; i--) if (trades[i].t <= t) return trades[i].px; return null; };
  // spotAt(t): the spot price at time t (scanfeed.js), sigmaMin: the bot's volatility per minute
  function features({ now = clock(), spotAt = () => null, sigmaMin = 0.0008 } = {}) {
    const out = { lead: 0, flow: 0, oi: 0, premium: 0, live: now - lastTradeAt < 30000 };
    if (!out.live) return out;
    const f0 = pxAt(now - 30000), f1 = pxAt(now), s0 = spotAt(now - 30000), s1 = spotAt(now);
    if (f0 && f1 && s0 && s1) out.lead = clamp((Math.log(f1 / f0) - Math.log(s1 / s0)) / (sigmaMin * Math.sqrt(0.5)), -3, 3) / 3;
    const recent = trades.filter((x) => x.t > now - 120000), tot = recent.reduce((a, x) => a + x.usd, 0);
    if (tot > 0) out.flow = clamp((recent.filter((x) => x.side === 'buy').reduce((a, x) => a + x.usd, 0) / tot - 0.5) * 2, -1, 1);
    const c1 = ctxs[ctxs.length - 1], c0 = ctxs.find((c) => c.t >= now - 330000);
    if (c1 && c0 && c0 !== c1 && c0.oi > 0 && c0.mark > 0) {
      const dOi = (c1.oi - c0.oi) / c0.oi, dir = Math.sign(c1.mark - c0.mark);
      out.oi = clamp(dOi / 0.01, -1, 1) * (dir || 0); // 1% of open interest in 5 minutes is a lot
      out.oiChange = dOi; out.priceDir = dir;
    }
    if (c1) { out.premium = clamp(c1.premium * 1000, -3, 3) / 3; out.funding = c1.funding; out.mark = c1.mark; out.oracle = c1.oracle; }
    return out;
  }
  // For Market watch: the raw context (funding, open interest, premium) and the 5-minute open interest change
  function context(now = clock()) {
    const c1 = ctxs[ctxs.length - 1];
    if (!c1 || now - c1.t > 60000) return null;
    const c0 = ctxs.find((c) => c.t >= now - 330000);
    return { ...c1, oiChange5: c0 && c0 !== c1 && c0.oi > 0 ? (c1.oi - c0.oi) / c0.oi : null, priceChange5: c0 && c0.mark > 0 ? (c1.mark - c0.mark) / c0.mark : null, live: now - lastTradeAt < 30000 };
  }
  return { start, stop, features, context, onTrades, onCtx, status: () => ({ live: clock() - lastTradeAt < 30000, trades: trades.length, ctx: ctxs.length }) };
}
