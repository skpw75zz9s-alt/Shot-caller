// Live trades from every major USD bitcoin exchange, straight from their public WebSocket feeds (no keys, no
// server in between), plus the trades on the live Kalshi contract. Each parser turns one exchange message into
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

// Coinbase "match": side is the MAKER's, so the taker is the other one
export const parseCoinbase = (m) => (m.type === 'match' || m.type === 'last_match' ? [tr('Coinbase', Date.parse(m.time), num(m.price), num(m.size), m.side === 'sell' ? 'buy' : m.side === 'buy' ? 'sell' : null)] : []);

export const ALL_FEEDS = ['Coinbase', ...EXCHANGES.map((e) => e.name)];

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
    ws.onopen = () => { retry[ex.name] = 0; set(ex.name, { state: 'live' }); for (const s of ex.subscribe) ws.send(JSON.stringify(s)); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const trades = ex.parse(m).filter(Boolean);
      if (trades.length) { set(ex.name, { state: 'live', lastAt: Date.now() }); onTrades(trades); }
    };
    ws.onclose = () => {
      delete socks[ex.name];
      set(ex.name, { state: 'down' });
      if (!stopped) setTimeout(() => !stopped && open(ex), Math.min(30000, 1000 * 2 ** (retry[ex.name] = (retry[ex.name] || 0) + 1)));
    };
    ws.onerror = () => ws.close();
  }
  let stopped = true;
  return {
    start() { stopped = false; EXCHANGES.forEach(open); },
    stop() { stopped = true; for (const [n, ws] of Object.entries(socks)) { ws.onclose = null; ws.close(); delete socks[n]; set(n, { state: 'off' }); } },
    status: () => status,
  };
}
