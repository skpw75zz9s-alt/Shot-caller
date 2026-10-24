// The order book math (orderbook.js): pure, with no Node modules, so the Cloudflare backup Worker
// (cloudflare/worker.js) reads Kraken's book with exactly the same rules as the server.
export const KRAKEN = 'https://api.kraken.com/0/public/Depth';
export const BOOK_PAIRS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'XDGUSD' };
export const BANDS = [0.1, 0.5, 1, 2]; // % from the mid price
const WALL_X = 5; // a wall holds at least 5x the median level within 2%
const WALL_MIN_USD = 25000;
const STOOD = 30000; // a wall counts (logged, and can be "pulled") once it has stood 30 seconds

const level = ([p, v]) => [Number(p), Number(v)];
const ok = ([p, v]) => p > 0 && v > 0;

// bids/asks: [[price, size], ...] (any order). Pure, so the tests can feed it any book.
export function summarizeBook(rawBids, rawAsks) {
  const bids = rawBids.map(level).filter(ok).sort((a, b) => b[0] - a[0]);
  const asks = rawAsks.map(level).filter(ok).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  const bid = bids[0][0], ask = asks[0][0], mid = (bid + ask) / 2;
  const pct = (p) => ((p - mid) / mid) * 100;
  // how far the 500 levels reach on each side: a band past that is only partly counted
  const reach = { bid: -pct(bids[bids.length - 1][0]), ask: pct(asks[asks.length - 1][0]) };
  const usdWithin = (side, band) => side.reduce((s, [p, v]) => (Math.abs(pct(p)) <= band ? s + p * v : s), 0);
  const bands = BANDS.map((band) => ({ band, bid: usdWithin(bids, band), ask: usdWithin(asks, band), partial: band > Math.min(reach.bid, reach.ask) }));
  const b5 = bands[1], imbalance = b5.bid + b5.ask > 0 ? (b5.bid - b5.ask) / (b5.bid + b5.ask) : 0;
  const near = [...bids, ...asks].filter(([p]) => Math.abs(pct(p)) <= 2).map(([p, v]) => p * v).sort((a, b) => a - b);
  const median = near.length ? near[Math.floor(near.length / 2)] : 0, bar = Math.max(WALL_MIN_USD, median * WALL_X);
  const walls = (side, name) => side.filter(([p, v]) => Math.abs(pct(p)) <= 2 && p * v >= bar)
    .map(([p, v]) => ({ side: name, price: p, usd: p * v, away: Math.abs(pct(p)) }))
    .sort((a, b) => b.usd - a.usd);
  const sizes = { buy: new Map(bids.map(([p, v]) => [p, p * v])), sell: new Map(asks.map(([p, v]) => [p, p * v])) };
  return {
    bid, ask, mid, spreadBps: ((ask - bid) / mid) * 10000, bands, imbalance,
    lean: imbalance > 0.2 ? 'buyers' : imbalance < -0.2 ? 'sellers' : 'even',
    walls: [...walls(bids, 'buy'), ...walls(asks, 'sell')], wallBar: bar, reach,
    // dollars resting at one price now (0 when nothing's there), and whether that price is within the book's view
    usdAt: (side, price) => sizes[side].get(price) ?? 0,
    inView: (side, price) => (side === 'buy' ? -pct(price) <= reach.bid : pct(price) <= reach.ask),
  };
}

// Follows every wall from one read to the next. Returns the walls standing now (with since), and what happened:
//   up      a wall has stood 30 seconds (logged once)
//   hit     a wall that stood is gone and the price reached it: it was traded into
//   pulled  a wall that stood is gone, the price never reached it, and its price now holds under a fifth of it:
//           cancelled. (A wall that only shrank a little, slipped out of the 500-level view, stopped counting as a
//           wall because the prices around it grew, or moved: a wall at least 60% its size now stands within 0.15% on
//           the same side, a trader repricing, is not called pulled.)
// Only big walls go in the log: at least 2% of the dollars waiting within 0.5% on an average side (and the wall bar).
// Smaller walls still show on the card while they stand; logging them all buried the big ones in market makers'
// constant repricing.
export const logBar = (s) => Math.max(s.wallBar, (0.02 * (s.bands[1].bid + s.bands[1].ask)) / 2);
export function trackWalls(seen, s, now) {
  const next = new Map(), events = [], big = logBar(s);
  for (const w of s.walls) {
    const key = `${w.side}:${w.price}`, was = seen.get(key);
    const cur = { ...w, since: was?.since ?? now, seenAt: now, logged: was?.logged ?? false };
    if (!cur.logged && now - cur.since >= STOOD && w.usd >= big) { cur.logged = true; events.push({ kind: 'up', side: w.side, price: w.price, usd: w.usd, at: now }); }
    next.set(key, cur);
  }
  for (const [key, w] of seen) {
    if (next.has(key) || !w.logged) continue; // still there, or never logged (a flicker or a small wall)
    const reached = w.side === 'buy' ? s.bid <= w.price : s.ask >= w.price;
    const stood = w.seenAt - w.since;
    const moved = s.walls.some((x) => x.side === w.side && x.usd >= w.usd * 0.6 && Math.abs(x.price - w.price) / s.mid <= 0.0015);
    if (reached) events.push({ kind: 'hit', side: w.side, price: w.price, usd: w.usd, stood, at: now });
    else if (!moved && s.inView(w.side, w.price) && s.usdAt(w.side, w.price) < w.usd / 5) events.push({ kind: 'pulled', side: w.side, price: w.price, usd: w.usd, stood, at: now });
  }
  return { seen: next, events };
}
