// The coin's index estimate (BTC's first, v13.30 every coin's). Kalshi settles on CF Benchmarks' BRTI, which is built from several exchanges' order books.
// Coinbase alone can sit a few dollars off it, and near the target a few dollars decide the call. The server reads
// the mid price (halfway between best bid and ask) on several of the exchanges BRTI draws from and takes the
// median, dropping any quote that's stale or far from the rest. What's left between this and Kalshi's settlement
// is learned as the basis (public/learner.js).
import { HOME_ASSET } from './public/markets.js';

const mid = (b, a) => { b = Number(b); a = Number(a); return b > 0 && a > 0 && a >= b ? (a + b) / 2 : null; };

// Order books, the way the real index reads them: [[price, size], ...] best first
const lvl = (rows, pick) => (Array.isArray(rows) ? rows.map(pick).filter(([p, q]) => p > 0 && q > 0) : []);
const arr = (r) => [Number(r[0]), Number(r[1])], obj = (r) => [Number(r.price), Number(r.amount ?? r.size ?? r.quantity)];

// The exchanges a coin's index is read from (public/markets.js sym; a venue that doesn't list the coin is left out).
// Stock indexes, gold and oil have no exchange books here: their price comes from prices.js.
export const sourcesFor = (coinbase, asset = HOME_ASSET) => {
  const y = asset.sym, low = (v) => String(v).toLowerCase();
  if (!y) return [];
  return [
    { name: 'Coinbase', url: `${coinbase}/products/${asset.product}/ticker`, parse: (j) => mid(j.bid, j.ask) ?? (Number(j.price) || null),
      book: `${coinbase}/products/${asset.product}/book?level=2`, parseBook: (j) => ({ bids: lvl(j.bids?.slice(0, 200), arr), asks: lvl(j.asks?.slice(0, 200), arr) }) },
    y.krakenRest && { name: 'Kraken', url: `https://api.kraken.com/0/public/Ticker?pair=${y.krakenRest}`, parse: (j) => { const r = Object.values(j.result || {})[0]; return mid(r?.b?.[0], r?.a?.[0]); },
      book: `https://api.kraken.com/0/public/Depth?pair=${y.krakenRest}&count=100`, parseBook: (j) => { const r = Object.values(j.result || {})[0] || {}; return { bids: lvl(r.bids, arr), asks: lvl(r.asks, arr) }; } },
    y.bitstamp && { name: 'Bitstamp', url: `https://www.bitstamp.net/api/v2/ticker/${y.bitstamp}/`, parse: (j) => mid(j.bid, j.ask),
      book: `https://www.bitstamp.net/api/v2/order_book/${y.bitstamp}/`, parseBook: (j) => ({ bids: lvl(j.bids?.slice(0, 200), arr), asks: lvl(j.asks?.slice(0, 200), arr) }) },
    y.gemini && { name: 'Gemini', url: `https://api.gemini.com/v1/pubticker/${low(y.gemini)}`, parse: (j) => mid(j.bid, j.ask),
      book: `https://api.gemini.com/v1/book/${low(y.gemini)}?limit_bids=100&limit_asks=100`, parseBook: (j) => ({ bids: lvl(j.bids, obj), asks: lvl(j.asks, obj) }) },
    // itBit (Paxos), one of the venues the CF Benchmarks indexes have drawn from
    y.paxos && { name: 'itBit', url: `https://api.paxos.com/v2/markets/${y.paxos}/ticker`, parse: (j) => mid(j.best_bid?.price, j.best_ask?.price),
      book: `https://api.paxos.com/v2/markets/${y.paxos}/order-book`, parseBook: (j) => ({ bids: lvl(j.bids, obj), asks: lvl(j.asks, obj) }) },
  ].filter(Boolean);
};
export const defaultSources = (coinbase) => sourcesFor(coinbase, HOME_ASSET);

// One exchange's mid and depth: the dollars resting within 0.1% of its mid on both sides (how much it can move the
// consolidated book, the way the index weighs venues by their order books)
export function bookQuote({ bids, asks }) {
  if (!bids?.length || !asks?.length || !(asks[0][0] >= bids[0][0])) return null;
  const m = (bids[0][0] + asks[0][0]) / 2, band = m * 0.001;
  const usd = (rows, ok) => rows.reduce((a, [p, q]) => a + (ok(p) ? p * q : 0), 0);
  return { price: m, depth: usd(bids, (p) => p >= m - band) + usd(asks, (p) => p <= m + band) };
}

// quotes: [{ name, price, at, depth? }]. Of the fresh quotes within 0.3% of the first-pass median (needs 2 or more):
// the depth-weighted median when every one has a book depth (deeper venues count for more, as in the index),
// otherwise the plain median.
export function composite(quotes, now = Date.now(), maxAge = 15000) {
  const fresh = quotes.filter((q) => q.price > 0 && now - q.at <= maxAge);
  if (fresh.length < 2) return null;
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const m0 = med(fresh.map((q) => q.price));
  const used = fresh.filter((q) => Math.abs(q.price - m0) <= m0 * 0.003);
  if (used.length < 2) return null;
  let price = med(used.map((q) => q.price)), weighted = false;
  if (used.every((q) => q.depth > 0)) {
    const s = [...used].sort((a, b) => a.price - b.price), total = s.reduce((a, q) => a + q.depth, 0);
    let acc = 0;
    for (const q of s) { acc += q.depth; if (acc >= total / 2) { price = q.price; break; } }
    weighted = true;
  }
  return { price, weighted, used: used.map((q) => q.name), dropped: fresh.filter((q) => !used.includes(q)).map((q) => q.name) };
}

// Keeps the latest quote per exchange. poll() never throws: a dead exchange just drops out.
export function createIndex({ sources, fetchJSON }) {
  const quotes = new Map(), bookAt = new Map();
  async function poll(now = Date.now()) {
    await Promise.allSettled(sources.map(async (s) => {
      // the order book (mid + depth) every 15 seconds at most (some are large); the ticker in between keeps the price
      // fresh and the last depth carries over. The ticker alone if the book can't be read.
      if (s.book && !(now - (bookAt.get(s.name) || 0) < 15000)) {
        try { const q = bookQuote(s.parseBook(await fetchJSON(s.book))); if (q) { bookAt.set(s.name, now); quotes.set(s.name, { name: s.name, ...q, at: now }); return; } } catch { /* fall back */ }
      }
      const p = s.parse(await fetchJSON(s.url));
      const prev = quotes.get(s.name);
      if (p > 0) quotes.set(s.name, { name: s.name, price: p, at: now, ...(prev?.depth && now - (bookAt.get(s.name) || 0) < 60000 ? { depth: prev.depth } : {}) });
    }));
    return read(now);
  }
  function read(now = Date.now()) {
    const all = [...quotes.values()];
    const c = composite(all, now);
    const cb = quotes.get('Coinbase');
    return { index: c?.price ?? null, weighted: !!c?.weighted, used: c?.used ?? [], dropped: c?.dropped ?? [], coinbase: cb && now - cb.at <= 15000 ? cb.price : null,
      sources: all.map((q) => ({ name: q.name, price: q.price, depth: q.depth ?? null, age: now - q.at })), at: now };
  }
  return { poll, read };
}
