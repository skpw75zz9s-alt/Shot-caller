// BTC index estimate. Kalshi settles on CF Benchmarks' BRTI, which is built from several exchanges' order books.
// Coinbase alone can sit a few dollars off it, and near the target a few dollars decide the call. The server reads
// the mid price (halfway between best bid and ask) on several of the exchanges BRTI draws from and takes the
// median, dropping any quote that's stale or far from the rest. What's left between this and Kalshi's settlement
// is learned as the basis (public/learner.js).
const mid = (b, a) => { b = Number(b); a = Number(a); return b > 0 && a > 0 && a >= b ? (a + b) / 2 : null; };

export const defaultSources = (coinbase) => [
  { name: 'Coinbase', url: `${coinbase}/products/BTC-USD/ticker`, parse: (j) => mid(j.bid, j.ask) ?? (Number(j.price) || null) },
  { name: 'Kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse: (j) => { const r = Object.values(j.result || {})[0]; return mid(r?.b?.[0], r?.a?.[0]); } },
  { name: 'Bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse: (j) => mid(j.bid, j.ask) },
  { name: 'Gemini', url: 'https://api.gemini.com/v1/pubticker/btcusd', parse: (j) => mid(j.bid, j.ask) },
];

// quotes: [{ name, price, at }]. Median of fresh quotes within 0.3% of the first-pass median; needs 2 or more.
export function composite(quotes, now = Date.now(), maxAge = 15000) {
  const fresh = quotes.filter((q) => q.price > 0 && now - q.at <= maxAge);
  if (fresh.length < 2) return null;
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const m0 = med(fresh.map((q) => q.price));
  const used = fresh.filter((q) => Math.abs(q.price - m0) <= m0 * 0.003);
  if (used.length < 2) return null;
  return { price: med(used.map((q) => q.price)), used: used.map((q) => q.name), dropped: fresh.filter((q) => !used.includes(q)).map((q) => q.name) };
}

// Keeps the latest quote per exchange. poll() never throws: a dead exchange just drops out.
export function createIndex({ sources, fetchJSON }) {
  const quotes = new Map();
  async function poll(now = Date.now()) {
    await Promise.allSettled(sources.map(async (s) => {
      const p = s.parse(await fetchJSON(s.url));
      if (p > 0) quotes.set(s.name, { name: s.name, price: p, at: now });
    }));
    return read(now);
  }
  function read(now = Date.now()) {
    const all = [...quotes.values()];
    const c = composite(all, now);
    const cb = quotes.get('Coinbase');
    return { index: c?.price ?? null, used: c?.used ?? [], dropped: c?.dropped ?? [], coinbase: cb && now - cb.at <= 15000 ? cb.price : null,
      sources: all.map((q) => ({ name: q.name, price: q.price, age: now - q.at })), at: now };
  }
  return { poll, read };
}
