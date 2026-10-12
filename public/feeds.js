// Live trades from every major USD bitcoin exchange and the global markets that lead price moves (GLOBAL_EXCHANGES),
// straight from their public WebSocket feeds (no keys, no server in between), plus the trades on the live Kalshi contract. Each parser turns one exchange message into
// trades { ex, t, price, size, side } where side is the TAKER (aggressor): 'buy' lifted the ask, 'sell' hit the bid.
// Coinbase runs on the app's own price socket (app.js) and is parsed here too.

const num = (v) => Number(v);
const tr = (ex, t, price, size, side) => (price > 0 && size > 0 && (side === 'buy' || side === 'sell') ? { ex, t: t || Date.now(), price, size, side } : null);

export const EXCHANGES = [
  {
    name: 'Kraken', url: 'wss://ws.kraken.com/v2',
    subscribe: [{ method: 'subscribe', params: { channel: 'trade', symbol: ['BTC/USD'] } }],
    // { channel: 'trade', type: 'update', data: [{ side: 'buy', price, qty, timestamp }] } (side is the taker's)
    parse: (m) => (m.channel === 'trade' && Array.isArray(m.data) ? m.data.map((d) => tr('Kraken', Date.parse(d.timestamp), num(d.price), num(d.qty), d.side)) : []),
  },
  {
    name: 'Bitstamp', url: 'wss://ws.bitstamp.net',
    subscribe: [{ event: 'bts:subscribe', data: { channel: 'live_trades_btcusd' } }],
    // { event: 'trade', data: { price, amount, type: 0 buy | 1 sell (the taker), microtimestamp } }
    parse: (m) => (m.event === 'trade' && m.data ? [tr('Bitstamp', Math.floor(num(m.data.microtimestamp) / 1000) || num(m.data.timestamp) * 1000, num(m.data.price), num(m.data.amount), m.data.type === 0 ? 'buy' : m.data.type === 1 ? 'sell' : null)] : []),
  },
  {
    name: 'Gemini', url: 'wss://api.gemini.com/v1/marketdata/BTCUSD?trades=true&bids=false&offers=false&heartbeat=true',
    subscribe: [],
    // { type: 'update', timestampms, events: [{ type: 'trade', price, amount, makerSide: 'bid' | 'ask' }] } (maker bid = taker sold)
    parse: (m) => (m.type === 'update' && Array.isArray(m.events) ? m.events.filter((e) => e.type === 'trade').map((e) => tr('Gemini', num(m.timestampms), num(e.price), num(e.amount), e.makerSide === 'bid' ? 'sell' : e.makerSide === 'ask' ? 'buy' : null)) : []),
  },
  {
    name: 'Binance.US', url: 'wss://stream.binance.us:9443/ws/btcusd@trade',
    subscribe: [],
    // { e: 'trade', p, q, T, m: buyer is the maker } (m true = the taker sold)
    parse: (m) => (m.e === 'trade' ? [tr('Binance.US', num(m.T), num(m.p), num(m.q), m.m ? 'sell' : 'buy')] : []),
  },
];

// The global markets (v13.8): where most of bitcoin's price discovery happens, so moves often show up there first.
// Perpetual futures (Binance, Bybit, OKX, Deribit) and the biggest USDT market (Binance spot) lead; Bitfinex and
// Crypto.com add more USD flow. They stream from the phone (Binance and Bybit block US servers) and feed the tape, the
// tug of war, whales, the bubbles, "why it moved", the exchanges' trend line and the flip forecast. They never set the
// bot's price or the bad-data checks: USDT prices and futures premiums sit off the USD spot price Kalshi settles on, so
// each one's price LEVEL is aligned to USD spot (createAligner) while its MOVES are kept as they are.
//   ping   [ms, payload]: a keep-alive some venues need (a string is sent as is)
//   reply  an answer the venue expects to a message (Crypto.com's heartbeat)
//   delay  ms to wait after connecting before subscribing
export const GLOBAL_EXCHANGES = [
  {
    name: 'Binance', url: 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade', align: true, subscribe: [],
    // { e: 'aggTrade', p, q, T, m: buyer is the maker } (one taker order's fills, merged)
    parse: (m) => (m.e === 'aggTrade' ? [tr('Binance', num(m.T), num(m.p), num(m.q), m.m ? 'sell' : 'buy')] : []),
  },
  {
    name: 'Binance perp', url: 'wss://fstream.binance.com/ws/btcusdt@aggTrade', align: true, subscribe: [],
    parse: (m) => (m.e === 'aggTrade' ? [tr('Binance perp', num(m.T), num(m.p), num(m.q), m.m ? 'sell' : 'buy')] : []),
  },
  {
    name: 'Bybit perp', url: 'wss://stream.bybit.com/v5/public/linear', align: true, ping: [20000, { op: 'ping' }],
    subscribe: [{ op: 'subscribe', args: ['publicTrade.BTCUSDT'] }],
    // { topic: 'publicTrade.BTCUSDT', data: [{ T, S: 'Buy' | 'Sell' (the taker), v, p }] }
    parse: (m) => (m.topic === 'publicTrade.BTCUSDT' && Array.isArray(m.data) ? m.data.map((d) => tr('Bybit perp', num(d.T), num(d.p), num(d.v), d.S === 'Buy' ? 'buy' : d.S === 'Sell' ? 'sell' : null)) : []),
  },
  {
    name: 'OKX perp', url: 'wss://ws.okx.com:8443/ws/v5/public', align: true, ping: [25000, 'ping'],
    subscribe: [{ op: 'subscribe', args: [{ channel: 'trades', instId: 'BTC-USDT-SWAP' }] }],
    // { arg: { channel: 'trades' }, data: [{ px, sz (contracts of 0.01 BTC), side (the taker), ts }] }
    parse: (m) => (m.arg?.channel === 'trades' && Array.isArray(m.data) ? m.data.map((d) => tr('OKX perp', num(d.ts), num(d.px), num(d.sz) * 0.01, d.side)) : []),
  },
  {
    name: 'Deribit perp', url: 'wss://www.deribit.com/ws/api/v2', align: true,
    subscribe: [{ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['trades.BTC-PERPETUAL.100ms'] } }],
    // { method: 'subscription', params: { channel, data: [{ timestamp, price, amount (USD), direction (the taker) }] } }
    parse: (m) => (m.method === 'subscription' && /^trades\.BTC-PERPETUAL/.test(m.params?.channel || '') && Array.isArray(m.params.data)
      ? m.params.data.map((d) => tr('Deribit perp', num(d.timestamp), num(d.price), num(d.amount) / num(d.price), d.direction)) : []),
  },
  {
    name: 'Bitfinex', url: 'wss://api-pub.bitfinex.com/ws/2', align: true,
    subscribe: [{ event: 'subscribe', channel: 'trades', symbol: 'tBTCUSD' }],
    // [chanId, 'te', [id, mts, amount (+ taker bought, - sold), price]]
    parse: (m) => (Array.isArray(m) && m[1] === 'te' && Array.isArray(m[2]) ? [tr('Bitfinex', num(m[2][1]), num(m[2][3]), Math.abs(num(m[2][2])), num(m[2][2]) > 0 ? 'buy' : 'sell')] : []),
  },
  {
    name: 'Crypto.com', url: 'wss://stream.crypto.com/exchange/v1/market', align: true, delay: 1000,
    subscribe: [{ id: 1, method: 'subscribe', params: { channels: ['trade.BTC_USD'] } }],
    reply: (m) => (m.method === 'public/heartbeat' ? { id: m.id, method: 'public/respond-heartbeat' } : null),
    // { result: { channel: 'trade', data: [{ t, p, q, s: 'BUY' | 'SELL' (the taker) }] } }
    parse: (m) => (m.result?.channel === 'trade' && Array.isArray(m.result.data) ? m.result.data.map((d) => tr('Crypto.com', num(d.t), num(d.p), num(d.q), d.s === 'BUY' ? 'buy' : d.s === 'SELL' ? 'sell' : null)) : []),
  },
];

// Price-level alignment for the global markets: each one's offset to the USD spot price, applied to its prices. The
// offset is measured only when the venue and USD spot (the latest Coinbase / Kraken / Bitstamp / Gemini / Binance.US
// trade) traded within a second of each other, at most once a second, and moves slowly (a ~3-minute time constant):
// futures premiums and the USDT rate drift over minutes, while a lead move happens in seconds, so the moves are kept
// (a fast offset would swallow exactly the moves that show up on futures first). Trades are held back until the
// first offset is known (a few seconds), so nothing is ever drawn at a USDT or futures price.
export function createAligner(alpha = 0.005) {
  const usd = new Set(['Coinbase', ...EXCHANGES.map((e) => e.name)]), aligned = new Set(GLOBAL_EXCHANGES.filter((e) => e.align).map((e) => e.name));
  const off = {}, at = {}; let ref = null, refT = 0;
  const fn = (trades) => {
    const out = [];
    for (const x of trades) {
      if (!x) continue;
      if (usd.has(x.ex)) { ref = x.price; refT = x.t; out.push(x); continue; }
      if (!aligned.has(x.ex)) { out.push(x); continue; }
      if (ref && Math.abs(x.t - refT) <= 1000 && !(x.t - (at[x.ex] ?? -Infinity) < 1000)) {
        const o = Math.log(ref / x.price);
        off[x.ex] = off[x.ex] == null ? o : off[x.ex] + alpha * (o - off[x.ex]); at[x.ex] = x.t;
      }
      if (off[x.ex] == null) continue;
      out.push({ ...x, raw: x.price, price: x.price * Math.exp(off[x.ex]) });
    }
    return out;
  };
  fn.offsets = () => ({ ...off });
  return fn;
}

// Coinbase "match": side is the MAKER's, so the taker is the other one
export const parseCoinbase = (m) => (m.type === 'match' || m.type === 'last_match' ? [tr('Coinbase', Date.parse(m.time), num(m.price), num(m.size), m.side === 'sell' ? 'buy' : m.side === 'buy' ? 'sell' : null)] : []);

export const ALL_FEEDS = ['Coinbase', ...EXCHANGES.map((e) => e.name), ...GLOBAL_EXCHANGES.map((e) => e.name)];

// Kalshi public trades on one contract: { trades: [{ trade_id, count(_fp), yes_price(_dollars), taker_side, created_time }] }
export function parseKalshiTrades(body) {
  return (body?.trades || []).map((x) => {
    const yes = x.yes_price_dollars != null ? num(x.yes_price_dollars) : num(x.yes_price) / 100;
    const count = x.count_fp != null ? num(x.count_fp) : num(x.count);
    const side = x.taker_side === 'yes' ? 'YES' : x.taker_side === 'no' ? 'NO' : null;
    if (!(yes > 0 && yes < 1 && count > 0 && side)) return null;
    return { id: x.trade_id, ticker: x.ticker, t: Date.parse(x.created_time), side, price: side === 'YES' ? yes : 1 - yes, count, usd: count * (side === 'YES' ? yes : 1 - yes) };
  }).filter(Boolean);
}

// Kalshi contract flow this round: contracts and dollars bought on each side by takers
export function kalshiFlow(trades) {
  const out = { YES: { count: 0, usd: 0 }, NO: { count: 0, usd: 0 } };
  for (const x of trades) { out[x.side].count += x.count; out[x.side].usd += x.usd; }
  const total = out.YES.usd + out.NO.usd;
  return { ...out, yesShare: total > 0 ? out.YES.usd / total : null };
}

// Per-exchange share of the round's flow, from the trades seen this round
export function byExchange(trades) {
  const m = {};
  for (const x of trades) {
    const e = (m[x.ex] ||= { buy: 0, sell: 0, n: 0 });
    e[x.side] += x.price * x.size; e.n++;
  }
  return m;
}

// Browser side: one socket per exchange, reconnecting with backoff, closed while the app is in the background.
export function createFeeds({ onTrades, onStatus }) {
  const socks = {}, status = {}, retry = {};
  const set = (name, s) => { status[name] = { ...(status[name] || {}), ...s }; onStatus?.(status); };
  function open(ex) {
    if (socks[ex.name] || typeof WebSocket === 'undefined') return;
    let ws;
    try { ws = new WebSocket(ex.url); } catch { set(ex.name, { state: 'error' }); return; }
    socks[ex.name] = ws;
    set(ex.name, { state: 'connecting' });
    const send = (x) => { try { ws.send(typeof x === 'string' ? x : JSON.stringify(x)); } catch { /* closing */ } };
    let pinger = null;
    ws.onopen = () => {
      retry[ex.name] = 0; set(ex.name, { state: 'live' });
      const sub = () => { for (const s of ex.subscribe) send(s); };
      if (ex.delay) setTimeout(sub, ex.delay); else sub();
      if (ex.ping) pinger = setInterval(() => send(ex.ping[1]), ex.ping[0]);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const r = ex.reply?.(m);
      if (r) send(r);
      const trades = ex.parse(m).filter(Boolean);
      if (trades.length) { set(ex.name, { state: 'live', lastAt: Date.now() }); onTrades(trades); }
    };
    ws.onclose = () => {
      clearInterval(pinger);
      delete socks[ex.name];
      set(ex.name, { state: 'down' });
      if (!stopped) setTimeout(() => !stopped && open(ex), Math.min(30000, 1000 * 2 ** (retry[ex.name] = (retry[ex.name] || 0) + 1)));
    };
    ws.onerror = () => ws.close();
  }
  let stopped = true;
  return {
    start() { stopped = false; [...EXCHANGES, ...GLOBAL_EXCHANGES].forEach(open); },
    stop() { stopped = true; for (const [n, ws] of Object.entries(socks)) { ws.onclose = null; ws.close(); delete socks[n]; set(n, { state: 'off' }); } },
    status: () => status,
  };
}
