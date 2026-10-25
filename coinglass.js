// CoinGlass (v13.90): what the whole futures market is doing, from coinglass.com's API (needs a key: COINGLASS_API_KEY,
// from coinglass.com/pricing; the cheapest plan is paid). Four readings per coin, each fetched on its own so one the plan
// doesn't include doesn't hide the others:
//   open interest   the dollars in open futures bets on every big exchange together (rising = new money coming in)
//   funding         what longs pay shorts (positive) or shorts pay longs, weighted by open interest
//   liquidations    longs and shorts forced out, in dollars
//   long/short      the share of Binance accounts betting up vs down
// Fetched only when someone looks, and kept 60 seconds. Context only: no call uses it.
export const COINGLASS = 'https://open-api-v4.coinglass.com';
export const CG_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);

// one series per reading: [{ t, v }] oldest first (CoinGlass gives OHLC rows or named fields)
export const READINGS = {
  oi: { path: '/api/futures/open-interest/aggregated-history', q: (c, iv) => ({ symbol: c, interval: iv }), row: (r) => ({ t: num(r.time), v: num(r.close) }) },
  funding: { path: '/api/futures/funding-rate/oi-weight-history', q: (c, iv) => ({ symbol: c, interval: iv }), row: (r) => ({ t: num(r.time), v: num(r.close) }) },
  liq: { path: '/api/futures/liquidation/aggregated-history', q: (c, iv) => ({ symbol: c, interval: iv, exchange_list: 'Binance,OKX,Bybit' }),
    row: (r) => ({ t: num(r.time), long: num(r.aggregated_long_liquidation_usd ?? r.long_liquidation_usd), short: num(r.aggregated_short_liquidation_usd ?? r.short_liquidation_usd) }) },
  ls: { path: '/api/futures/global-long-short-account-ratio/history', q: (c, iv) => ({ symbol: `${c}USDT`, exchange: 'Binance', interval: iv }),
    row: (r) => ({ t: num(r.time), long: num(r.global_account_long_percent), short: num(r.global_account_short_percent), ratio: num(r.global_account_long_short_ratio) }) },
};

// the plain-English read of one coin's readings (pure: tested)
export function cgSummary({ oi, funding, liq, ls } = {}) {
  const out = {};
  if (oi?.length) {
    const last = oi.at(-1).v, first = oi[0].v;
    out.oi = { usd: last, change: first ? (last - first) / first : null, series: oi.map((x) => x.v) };
  }
  if (funding?.length) {
    const f = funding.at(-1).v; // percent per 8 hours, as CoinGlass shows it
    out.funding = { rate: f, say: f == null ? null : f > 0.03 ? 'longs paying a lot: crowded long' : f < -0.01 ? 'shorts paying: crowded short' : f > 0 ? 'longs paying a little: normal' : 'about even' };
  }
  if (liq?.length) {
    const long = liq.reduce((a, x) => a + (x.long || 0), 0), short = liq.reduce((a, x) => a + (x.short || 0), 0);
    out.liq = { long, short, more: long > short * 1.5 ? 'longs' : short > long * 1.5 ? 'shorts' : 'both' };
  }
  if (ls?.length) { const x = ls.at(-1); out.ls = { long: x.long, short: x.short, ratio: x.ratio }; }
  return out;
}

export function createCoinGlass({ key = process.env.COINGLASS_API_KEY, interval = process.env.COINGLASS_INTERVAL || '4h', limit = 24, fetchImpl = (...a) => fetch(...a), clock = () => Date.now(), ttl = 60000 } = {}) {
  const cache = new Map(); // coin -> { at, out, pending }
  async function one(name, coin) {
    const R = READINGS[name], q = new URLSearchParams({ ...R.q(coin, interval), limit: String(limit) });
    const r = await fetchImpl(`${COINGLASS}${R.path}?${q}`, { headers: { accept: 'application/json', 'CG-API-KEY': key }, signal: AbortSignal.timeout(10000) });
    let j; try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
    if (!r.ok || String(j.code) !== '0') throw new Error(j.msg || `HTTP ${r.status}`);
    return (Array.isArray(j.data) ? j.data : []).map(R.row).filter((x) => x.t != null).sort((a, b) => a.t - b.t);
  }
  async function read(coin) {
    const names = Object.keys(READINGS), got = await Promise.allSettled(names.map((n) => one(n, coin)));
    const data = {}, errors = {};
    got.forEach((g, i) => { if (g.status === 'fulfilled') data[names[i]] = g.value; else errors[names[i]] = g.reason?.message || 'failed'; });
    return { coin, source: 'CoinGlass', interval, at: clock(), ...cgSummary(data), errors };
  }
  async function api(coin) {
    if (!key) return { off: 'no key', how: 'Get an API key at coinglass.com/pricing, then run: py scripts\\shotctl.py env set COINGLASS_API_KEY=your-key' };
    if (!CG_COINS.includes(coin)) return { off: 'CoinGlass is shown for BTC, ETH, SOL, XRP and DOGE' };
    const c = cache.get(coin) || {};
    if (c.out && clock() - c.at < ttl) return c.out;
    c.pending ??= read(coin).then((out) => { cache.set(coin, { at: clock(), out }); return out; }).finally(() => { c.pending = null; });
    cache.set(coin, c);
    return c.pending;
  }
  return { api, on: () => !!key };
}
