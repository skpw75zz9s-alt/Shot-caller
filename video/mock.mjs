// A stand-in Kalshi + Coinbase for tutorial screenshots: one 15-minute round, BTC ~$250 above the target, Kalshi's
// price controllable via /__set?yb=..&ya=.. (cents)
import http from 'node:http';
const PORT = +process.argv[2] || 8801, T0 = Date.now();
const MIN = 60000, open = Math.floor(T0 / MIN) * MIN - 5 * MIN, close = open + 15 * MIN, K = 100000;
export const state = { yb: 97, ya: 98, lead: 250 };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
// 300 one-minute candles: a calm walk (~$40 a minute) ending near the target at the open, then easing up to the lead
const closes = []; let p = K - 300;
for (let i = 0; i < 300; i++) { const t = open - (300 - i) * MIN + 5 * MIN; const toOpen = (open - t) / MIN; p += gauss() * 38 + (toOpen > 0 && toOpen < 120 ? (K - p) * 0.02 : 0) + (t >= open ? (K + state.lead - p) * 0.25 : 0); closes.push([t, p]); }
const spot = () => K + state.lead + Math.sin(Date.now() / 7000) * 9 + Math.sin(Date.now() / 2300) * 4;
const market = () => ({ ticker: 'KXBTC15M-26OCT131715-15', event_ticker: 'KXBTC15M-26OCT131715', title: 'Bitcoin price up in next 15 mins?', subtitle: 'Target $100,000.00', strike_type: 'greater_or_equal', floor_strike: K,
  open_time: new Date(open).toISOString(), close_time: new Date(close).toISOString(), expiration_time: new Date(close).toISOString(), status: 'active',
  yes_bid: state.yb, yes_ask: state.ya, no_bid: 100 - state.ya, no_ask: 100 - state.yb, last_price: state.ya, volume: 18450, open_interest: 9200, liquidity: 250000 });
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'application/json');
  if (u.pathname === '/__set') { for (const k of ['yb', 'ya', 'lead']) if (u.searchParams.has(k)) state[k] = +u.searchParams.get(k); return res.end(JSON.stringify(state)); }
  if (u.pathname.endsWith('/candles')) {
    const g = +u.searchParams.get('granularity') || 60, rows = [];
    if (g === 60) { for (const [t, c] of closes) { const o = c - gauss() * 12; rows.push([t / 1000, Math.min(o, c) - 6, Math.max(o, c) + 6, o, c, 3 + rnd() * 5]); } const t = Math.floor(Date.now() / MIN) * MIN, c = spot(); rows.push([t / 1000, c - 8, c + 8, closes.at(-1)[1], c, 2]); }
    else { let q = K - 400; for (let i = 0; i < 300; i++) { const c = q + gauss() * 38 * Math.sqrt(g / 60); rows.push([(Date.now() - (300 - i) * g * 1000) / 1000, Math.min(q, c) - 10, Math.max(q, c) + 10, q, c, 10]); q = c; } }
    return res.end(JSON.stringify(rows.reverse()));
  }
  if (u.pathname.endsWith('/ticker')) return res.end(JSON.stringify({ price: spot().toFixed(2), time: new Date().toISOString() }));
  if (u.pathname.endsWith('/markets/trades')) return res.end(JSON.stringify({ trades: [], cursor: '' }));
  if (u.pathname === '/markets') return res.end(JSON.stringify({ markets: [market()], cursor: '' }));
  if (/\/markets\/[^/]+\/orderbook$/.test(u.pathname)) return res.end(JSON.stringify({ orderbook: { yes: [[state.yb, 500]], no: [[100 - state.ya, 500]] } }));
  if (/\/markets\/[^/]+$/.test(u.pathname)) return res.end(JSON.stringify({ market: market() }));
  if (u.pathname.startsWith('/series') || u.pathname.startsWith('/events')) return res.end(JSON.stringify({}));
  res.statusCode = 404; res.end('{}');
}).listen(PORT, () => console.log('mock on', PORT, 'close', new Date(close).toISOString()));
