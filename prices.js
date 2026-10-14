// Prices for every asset (v13.30): crypto from Coinbase; stock indexes, gold and oil from Yahoo's public chart data.
// Everything comes out in Coinbase's shapes, so the bot and the phone read one format:
//   candles  [[time (s), low, high, open, close, volume], ...] newest first
//   ticker   { price, time (ISO), delayed }  delayed: the last print is more than FRESH old (Yahoo delays some
//            futures; markets close at night), and the bot makes no calls on a delayed price
import { parseCandles } from './public/engine.js';

export const PRICES = { fresh: 90000, yahoo: 'https://query1.finance.yahoo.com' };
const YAHOO_INTERVAL = { 60: '1m', 300: '5m', 900: '15m', 3600: '60m', 14400: '60m', 86400: '1d' };
const YAHOO_RANGE = { '1m': '5d', '5m': '1mo', '15m': '1mo', '60m': '3mo', '1d': '2y' };

// Yahoo's chart body -> Coinbase rows (newest first), skipping empty minutes
export function yahooRows(body) {
  const r = body?.chart?.result?.[0], ts = r?.timestamp, q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].every((v) => Number.isFinite(v) && v > 0)) out.push([ts[i], l, h, o, c, Number(q.volume?.[i]) || 0]);
  }
  return out.reverse();
}
export function yahooTicker(body, now = Date.now()) {
  const meta = body?.chart?.result?.[0]?.meta, p = Number(meta?.regularMarketPrice), t = Number(meta?.regularMarketTime) * 1000;
  if (!(p > 0) || !(t > 0)) return null;
  return { price: p, time: new Date(t).toISOString(), delayed: now - t > PRICES.fresh };
}

export function createPrices({ coinbase, yahoo = PRICES.yahoo, fetchJSON, clock = () => Date.now() }) {
  const ychart = (sym, interval, extra) => fetchJSON(`${yahoo}/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&${extra}&includePrePost=false`);
  async function candleRows(asset, { gran = 60, start = null, end = null } = {}) {
    if (asset.product) {
      const range = start && end ? `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}` : '';
      return fetchJSON(`${coinbase}/products/${asset.product}/candles?granularity=${gran}${range}`);
    }
    const iv = YAHOO_INTERVAL[gran] || '1m';
    const rows = yahooRows(await ychart(asset.yahoo, iv, start && end ? `period1=${Math.floor(start / 1000)}&period2=${Math.ceil(end / 1000)}` : `range=${YAHOO_RANGE[iv]}`));
    return start && end ? rows : rows.slice(0, 300);
  }
  async function ticker(asset) {
    if (asset.product) { const t = await fetchJSON(`${coinbase}/products/${asset.product}/ticker`); const p = Number(t?.price); return p > 0 ? { price: p, time: t.time ?? new Date(clock()).toISOString(), delayed: false, bid: t.bid, ask: t.ask } : null; }
    return yahooTicker(await ychart(asset.yahoo, '1m', 'range=1d'), clock());
  }
  return { candleRows, candles: async (asset, o) => parseCandles(await candleRows(asset, o)), ticker };
}
