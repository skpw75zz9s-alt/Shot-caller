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
import { BOOK_PAIRS, KRAKEN, summarizeBook, trackWalls } from './bookmath.js'; // the math, shared with cloudflare/worker.js

export { BANDS, BOOK_PAIRS, logBar, summarizeBook, trackWalls } from './bookmath.js';

const HISTORY_EVERY = 60000, HISTORY_KEEP = 120; // one point a minute, the last 2 hours
const EVENTS_KEEP = 40;

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
