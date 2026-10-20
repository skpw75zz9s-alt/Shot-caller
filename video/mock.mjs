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
// the finished candles, fixed once (real candles don't change after they close)
const HIST = closes.map(([t, c]) => { const o = c - gauss() * 12; return [t / 1000, Math.min(o, c) - 6, Math.max(o, c) + 6, o, c, 3 + rnd() * 5]; });
const spot = () => K + state.lead + Math.sin(Date.now() / 7000) * 9 + Math.sin(Date.now() / 2300) * 4;
// each coin at its own size (DOGE about 25 cents), the same shape of round
const SCALE = { BTC: 1, ETH: 0.04, SOL: 0.002, XRP: 0.000025, DOGE: 0.0000025 };
const scaleOf = (s) => SCALE[Object.keys(SCALE).find((k) => String(s).includes(k))] ?? 1;
const market = (series = 'KXBTC15M') => ({ ticker: `${series}-26OCT131715-15`, event_ticker: `${series}-26OCT131715`, title: 'Bitcoin price up in next 15 mins?', subtitle: 'Target', strike_type: 'greater_or_equal', floor_strike: +(K * scaleOf(series)).toPrecision(6),
  open_time: new Date(open).toISOString(), close_time: new Date(close).toISOString(), expiration_time: new Date(close).toISOString(), status: 'active',
  yes_bid: state.yb, yes_ask: state.ya, no_bid: 100 - state.ya, no_ask: 100 - state.yb, last_price: state.ya, volume: 18450, open_interest: 9200, liquidity: 250000 });
// Yahoo's 1-minute charts for the indexes, metals, oil and their drivers: 3 days, gold and oil built from the dollar,
// yields and their sector so "Why it's moving" has something to explain
const YSYM = { 'DX-Y.NYB': 104, '^TNX': 4.1, '^GSPC': 6700, '^NDX': 24000, '^DJI': 46000, 'GC=F': 2400, 'SI=F': 30, 'PL=F': 1000, 'HG=F': 4.5, 'CL=F': 70, 'BZ=F': 74, 'RB=F': 2.2, 'HO=F': 2.4, 'NG=F': 3 };
const YDATA = (() => {
  const lv = { ...YSYM }, out = Object.fromEntries(Object.keys(YSYM).map((k) => [k, []])), n = 3 * 1440, end = Math.floor(T0 / MIN) * MIN;
  for (let i = 0; i < n; i++) {
    const t = end - (n - 1 - i) * MIN, dx = 0.00025 * gauss(), ry = 0.0008 * gauss(), eq = 0.0004 * gauss(), metals = 0.0005 * gauss(), crude = 0.0007 * gauss(), late = i > n - 90;
    const mv = { 'DX-Y.NYB': dx - (late ? 0.00012 : 0), '^TNX': ry, '^GSPC': eq, '^NDX': eq * 1.3 + 0.0002 * gauss(), '^DJI': eq * 0.8 + 0.0002 * gauss(),
      'SI=F': metals * 1.4 - 0.4 * dx + 0.0003 * gauss(), 'PL=F': metals + 0.0004 * gauss(), 'HG=F': 0.3 * eq + 0.0005 * gauss(),
      'BZ=F': crude + 0.0002 * gauss(), 'RB=F': 0.8 * crude + 0.0005 * gauss(), 'HO=F': 0.7 * crude + 0.0005 * gauss(), 'NG=F': 0.0012 * gauss() };
    mv['GC=F'] = -0.5 * mv['DX-Y.NYB'] - 0.1 * ry + 0.9 * metals + 0.00025 * gauss() + (late ? 0.0001 : 0);
    mv['CL=F'] = 1.02 * crude - 0.3 * dx + 0.2 * eq + 0.0003 * gauss() + (i > n - 40 ? -0.0002 : 0);
    for (const k of Object.keys(lv)) { const o = lv[k]; lv[k] *= Math.exp(mv[k]); out[k].push([t / 1000, o, lv[k], Math.round(50 + 400 * rnd() * (k === 'CL=F' && i > n - 40 ? 4 : 1))]); }
  }
  return out;
})();
const yahooChart = (sym, q) => {
  const rows = YDATA[sym]; if (!rows) return null;
  const a = +q.get('period1') || 0, b = +q.get('period2') || Infinity, sel = rows.filter((r) => r[0] >= a && r[0] <= b), last = rows.at(-1);
  return { chart: { result: [{ meta: { regularMarketPrice: last[2], regularMarketTime: Math.floor(Date.now() / 1000) - 5 }, timestamp: sel.map((r) => r[0]),
    indicators: { quote: [{ open: sel.map((r) => r[1]), close: sel.map((r) => r[2]), high: sel.map((r) => Math.max(r[1], r[2])), low: sel.map((r) => Math.min(r[1], r[2])), volume: sel.map((r) => r[3]) }] } }] } };
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'application/json');
  if (u.pathname === '/__set') { for (const k of ['yb', 'ya', 'lead']) if (u.searchParams.has(k)) state[k] = +u.searchParams.get(k); return res.end(JSON.stringify(state)); }
  // stand-ins for the News scout's sources (newsfeed.js): a few headlines and a calendar release
  if (u.pathname === '/news/rss') { const ago = (m) => new Date(Date.now() - m * 60000).toUTCString(); res.setHeader('content-type', 'application/rss+xml'); return res.end(`<rss><channel>${[['Spot bitcoin ETF inflows top $500M - Reuters', 12], ['Bitcoin surges as shorts get squeezed - Bloomberg', 25], ['Exchange pauses withdrawals after exploit - CoinDesk', 48]].map(([t, m]) => `<item><title>${t.replace('&', '&amp;')}</title><link>https://example.com/n</link><pubDate>${ago(m)}</pubDate></item>`).join('')}</channel></rss>`); }
  if (u.pathname === '/news/calendar') return res.end(JSON.stringify([{ title: 'CPI m/m', country: 'USD', date: new Date(Date.now() + 40 * 60000).toISOString(), impact: 'High', forecast: '0.3%', previous: '0.4%' }]));
  if (u.pathname.startsWith('/v8/finance/chart/')) { const b = yahooChart(decodeURIComponent(u.pathname.slice(18)), u.searchParams); if (b) return res.end(JSON.stringify(b)); }
  const sc = scaleOf(u.pathname), sz = (r) => [r[0], r[1] * sc, r[2] * sc, r[3] * sc, r[4] * sc, r[5]];
  if (u.pathname.endsWith('/candles')) {
    const g = +u.searchParams.get('granularity') || 60, rows = [];
    if (g === 60) { for (const r of HIST) rows.push(r); const t = Math.floor(Date.now() / MIN) * MIN, c = spot(); rows.push([t / 1000, c - 8, c + 8, closes.at(-1)[1], c, 2]); }
    else { let q = K - 400; for (let i = 0; i < 300; i++) { const c = q + gauss() * 38 * Math.sqrt(g / 60); rows.push([(Date.now() - (300 - i) * g * 1000) / 1000, Math.min(q, c) - 10, Math.max(q, c) + 10, q, c, 10]); q = c; } }
    return res.end(JSON.stringify(rows.map(sz).reverse()));
  }
  if (u.pathname.endsWith('/ticker')) return res.end(JSON.stringify({ price: (spot() * sc).toPrecision(8), time: new Date().toISOString() }));
  if (u.pathname.endsWith('/markets/trades')) return res.end(JSON.stringify({ trades: [], cursor: '' }));
  if (u.pathname === '/markets') return res.end(JSON.stringify({ markets: [market(u.searchParams.get('series_ticker') || 'KXBTC15M')], cursor: '' }));
  if (/\/markets\/[^/]+\/orderbook$/.test(u.pathname)) return res.end(JSON.stringify({ orderbook: { yes: [[state.yb, 500]], no: [[100 - state.ya, 500]] } }));
  if (/\/markets\/[^/]+$/.test(u.pathname)) return res.end(JSON.stringify({ market: market(u.pathname.split('/').pop().split('-')[0]) }));
  if (u.pathname.startsWith('/series')) return res.end(JSON.stringify(u.searchParams.get('category') === 'Crypto' ? { series: [{ ticker: 'KXDOGE15M', title: 'Dogecoin price up in next 15 mins?', frequency: 'fifteen_min' }] } : {}));
  if (u.pathname.startsWith('/events')) return res.end(JSON.stringify({}));
  res.statusCode = 404; res.end('{}');
}).listen(PORT, () => console.log('mock on', PORT, 'close', new Date(close).toISOString()));
