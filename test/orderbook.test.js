import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrderBook, logBar, summarizeBook, trackWalls } from '../orderbook.js';

// a book around $100: 1 unit at every 1 cent, plus a buy wall at 99.50 and a sell wall at 101.00
const side = (from, step, n) => Array.from({ length: n }, (_, i) => [String((from + step * i).toFixed(2)), '1', 0]);
const book = ({ buyWall = '2000', sellWall = '900', shift = 0, buyAt = '99.50', extra = [] } = {}) => ({
  bids: [...side(99.99 + shift, -0.01, 300), ...(buyWall ? [[buyAt, buyWall, 0]] : []), ...extra],
  asks: [...side(100.01 + shift, 0.01, 300), ...(sellWall ? [['101.00', sellWall, 0]] : [])],
});
const sum = (o) => { const b = book(o); return summarizeBook(b.bids, b.asks); };

test('the summary: best prices, spread, dollars waiting near the price, and which side is stacked', () => {
  const s = sum();
  assert.equal(s.bid, 99.99);
  assert.equal(s.ask, 100.01);
  assert.ok(Math.abs(s.spreadBps - 2) < 0.01);
  const half = s.bands.find((b) => b.band === 0.5);
  assert.ok(half.bid > half.ask, 'the buy wall at 99.50 is within 0.5%, the sell wall at 101 is not');
  assert.equal(s.lean, 'buyers');
});

test('walls: a level far bigger than the ones around it, biggest first', () => {
  const s = sum();
  assert.deepEqual(s.walls.map((w) => [w.side, w.price]), [['buy', 99.5], ['sell', 101]]);
  assert.ok(Math.abs(s.walls[0].away - 0.5) < 0.01);
});

test('an empty or one-sided book gives nothing', () => {
  const b = book();
  assert.equal(summarizeBook([], b.asks), null);
  assert.equal(summarizeBook([['0', '5']], b.asks), null);
});

test('tracking: a wall is logged once it stood 30 s, and listed as pulled when cancelled before the price got there', () => {
  let t = trackWalls(new Map(), sum(), 0);
  assert.deepEqual(t.events, [], 'not logged yet: it could be a flicker');
  t = trackWalls(t.seen, sum(), 45000);
  assert.deepEqual(t.events.map((e) => [e.kind, e.side]).sort(), [['up', 'buy'], ['up', 'sell']]);
  t = trackWalls(t.seen, sum({ sellWall: null }), 60000);
  assert.deepEqual(t.events.map((e) => [e.kind, e.side, e.price, e.stood]), [['pulled', 'sell', 101, 45000]]);
});

test('tracking: a wall the price reached is "hit", not pulled; a flicker, a small trim or a wall out of view is nothing', () => {
  let t = trackWalls(new Map(), sum(), 0);
  t = trackWalls(t.seen, sum(), 40000);
  const reached = trackWalls(t.seen, sum({ buyWall: null, shift: -0.6 }), 50000); // the price fell to 99.39: through the wall
  assert.deepEqual(reached.events.map((e) => e.kind), ['hit']);
  const trimmed = trackWalls(t.seen, sum({ buyWall: '1500' }), 50000); // still a wall, just smaller
  assert.deepEqual(trimmed.events, []);
  const flicker = trackWalls(trackWalls(new Map(), sum(), 0).seen, sum({ buyWall: null, sellWall: null }), 10000);
  assert.deepEqual(flicker.events, []);
});

test('the feed: reads Kraken at most every 3 s for a phone, keeps a history and a log, survives a restart', async () => {
  let now = 0, calls = 0, fail = false, current = book();
  const fetchImpl = async (url) => {
    calls++;
    assert.match(url, /pair=XBTUSD&count=500/);
    if (fail) throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ error: [], result: { XXBTZUSD: current } }) };
  };
  const file = join(mkdtempSync(join(tmpdir(), 'ob-')), 'orderbook.json');
  const ob = createOrderBook({ file, fetchImpl, clock: () => now });
  const a = await ob.api('BTC');
  assert.equal(a.source, 'Kraken');
  assert.equal(a.lean, 'buyers');
  assert.equal(a.usdAt, undefined, 'internal helpers stay on the server');
  await ob.api('BTC');
  assert.equal(calls, 1, 'a second ask within 3 seconds is served from the last read');
  now = 40000; await ob.refresh('BTC');
  now = 70000; current = book({ sellWall: null }); const c = await ob.refresh('BTC');
  assert.deepEqual(c.events.map((e) => e.kind), ['pulled', 'up', 'up']);
  assert.equal(c.history.length, 2, 'one point a minute');
  now = 80000; fail = true;
  const d = await ob.api('BTC');
  assert.equal(d.stale, true);
  assert.equal(d.bid, 99.99);
  await ob.save();
  const again = createOrderBook({ file, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: [], result: { X: book() } }) }), clock: () => 90000 });
  await again.load();
  const e = await again.api('BTC');
  assert.equal(e.events[0].kind, 'pulled', 'the log came back after the restart');
  assert.deepEqual(await ob.api('SPX'), { off: 'pending orders are for BTC, ETH, SOL, XRP and DOGE' });
});

test('only big walls go in the log, and a wall that moved a little is not called pulled', () => {
  // thin $100 levels, two $2M walls inside 0.5% (so a log-worthy wall is about $40k+), and a $29.9k wall at 99.80
  const deep = (o = {}) => summarizeBook([...book(o).bids, ['99.70', '20000', 0], ['99.80', '300', 0]], [...book(o).asks, ['100.30', '20000', 0]]);
  const s0 = deep();
  assert.ok(s0.walls.some((w) => w.price === 99.8), 'still shown on the card as a wall');
  assert.ok(logBar(s0) > 29940, 'but under the bar for the log');
  let t = trackWalls(new Map(), s0, 0);
  t = trackWalls(t.seen, s0, 40000);
  assert.deepEqual(t.events.filter((e) => e.price === 99.8), []);
  assert.ok(t.events.some((e) => e.price === 99.7), 'the $2M wall is logged');
  // the buy wall at 99.50 slides to 99.45 (0.05% away, same size): a trader repricing, not a pull
  let m = trackWalls(new Map(), sum(), 0);
  m = trackWalls(m.seen, sum(), 40000);
  const slid = trackWalls(m.seen, sum({ buyAt: '99.45' }), 55000);
  assert.deepEqual(slid.events.filter((e) => e.kind === 'pulled'), []);
});
