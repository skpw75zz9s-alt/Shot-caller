// Pending orders (v13.83): the buy and sell orders waiting on Kraken's order book for BTC, ETH, SOL, XRP and DOGE.
// The server tracks all five around the clock (every 15 seconds, BOOK=off to stop it), and a phone that's looking
// gets a fresh read at most every 3 seconds.
//   GET https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=500  (public, no key; up to 500 price levels a side)
//   -> { error: [], result: { XXBTZUSD: { bids: [[price, volume, time], ...], asks: [...] } } }
// It reports how many dollars wait to buy and to sell near the price and which side is stacked (with a 2-hour
// history), the walls (one price holding far more than the prices around it) and how long each has stood, and a log
// of walls going up, getting hit (the price reached them) and getting pulled (cancelled before the price got there:
// often a bluff). History and log are kept in DATA_DIR/orderbook.json. Context only: no call uses it.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeAtomic } from './atomicfile.js';

const KRAKEN = 'https://api.kraken.com/0/public/Depth';
export const BOOK_PAIRS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD', DOGE: 'XDGUSD' };
export const BANDS = [0.1, 0.5, 1, 2]; // % from the mid price
const WALL_X = 5; // a wall holds at least 5x the median level within 2%
const WALL_MIN_USD = 25000;
const STOOD = 30000; // a wall counts (logged, and can be "pulled") once it has stood 30 seconds
const HISTORY_EVERY = 60000, HISTORY_KEEP = 120; // one point a minute, the last 2 hours
const EVENTS_KEEP = 40;

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

export function createOrderBook({ file = null, fetchImpl = (...a) => fetch(...a), clock = () => Date.now(), every = 3000, trackEvery = 15000, log = console } = {}) {
  const books = new Map(); // asset -> { at, out, seen, pending, history: [], events: [] }
  const timers = [];
  let dirty = false;
  const book = (asset) => {
    if (!books.has(asset)) books.set(asset, { at: 0, out: null, seen: new Map(), pending: null, history: [], events: [] });
    return books.get(asset);
  };

  async function load() {
    if (!file) return;
    try {
      const d = JSON.parse(await readFile(file, 'utf8'));
      for (const [asset, v] of Object.entries(d.assets || {})) if (BOOK_PAIRS[asset]) Object.assign(book(asset), { history: v.history || [], events: v.events || [] });
    } catch { /* first run */ }
  }
  async function save() {
    if (!file || !dirty) return;
    dirty = false;
    const assets = Object.fromEntries([...books].map(([a, b]) => [a, { history: b.history, events: b.events }]));
    try { await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify({ v: 1, assets })); } catch (e) { log.error?.('saving the order book log failed', e.message); }
  }

  async function read(asset) {
    const r = await fetchImpl(`${KRAKEN}?pair=${BOOK_PAIRS[asset]}&count=500`, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok || j.error?.length) throw new Error(j.error?.[0] || `HTTP ${r.status}`);
    const raw = Object.values(j.result || {})[0]; // Kraken names the pair its own way (XXBTZUSD...)
    const s = raw && summarizeBook(raw.bids || [], raw.asks || []);
    if (!s) throw new Error('empty book');
    return s;
  }

  function refresh(asset) {
    const b = book(asset);
    b.pending ??= read(asset).then((s) => {
      const now = clock(), t = trackWalls(b.seen, s, now);
      b.seen = t.seen;
      if (t.events.length) { b.events = [...t.events.reverse(), ...b.events].slice(0, EVENTS_KEEP); dirty = true; }
      const last = b.history[b.history.length - 1];
      if (!last || now - last.t >= HISTORY_EVERY) {
        const half = s.bands[1];
        b.history = [...b.history, { t: now, imb: Math.round(s.imbalance * 1000) / 1000, bid: Math.round(half.bid), ask: Math.round(half.ask), mid: s.mid }].slice(-HISTORY_KEEP);
        dirty = true;
      }
      const { usdAt, inView, walls, ...plain } = s;
      const standing = [...b.seen.values()].map(({ side, price, usd, away, since }) => ({ side, price, usd, away, since, standing: now - since }));
      const top = (side) => standing.filter((w) => w.side === side).sort((x, y) => y.usd - x.usd).slice(0, 4);
      b.out = { asset, source: 'Kraken', at: now, ...plain, walls: [...top('buy'), ...top('sell')], events: b.events, history: b.history };
      b.at = now;
      return b.out;
    }).catch((e) => (b.out ? { ...b.out, stale: true, why: e.message } : { error: `Couldn't read Kraken's order book: ${e.message}` }))
      .finally(() => { b.pending = null; });
    return b.pending;
  }

  // a phone asking: answered at once from the last read (the tracker keeps it under 15 seconds old), and a read older
  // than 3 seconds is refreshed in the background for the next ask. Only the very first ask, or one after a minute
  // without a good read, waits for Kraken: on a busy server that wait outlasted the phone's 10-second patience.
  async function api(asset) {
    if (!BOOK_PAIRS[asset]) return { off: 'pending orders are for BTC, ETH, SOL, XRP and DOGE' };
    const b = book(asset), age = clock() - b.at;
    if (b.out && age < every) return b.out;
    if (b.out && age < 60000) { refresh(asset); return b.out; }
    return refresh(asset);
  }

  // around the clock: each coin every 15 seconds, spread out so the reads don't bunch up
  function start() {
    const assets = Object.keys(BOOK_PAIRS);
    assets.forEach((a, i) => {
      const t = setTimeout(() => {
        refresh(a);
        const iv = setInterval(() => refresh(a), trackEvery);
        iv.unref?.(); timers.push(iv);
      }, (trackEvery / assets.length) * i);
      t.unref?.(); timers.push(t);
    });
    const s = setInterval(save, 120000); s.unref?.(); timers.push(s);
  }
  function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.length = 0; return save(); }
  return { api, load, save, start, stop, refresh };
}
