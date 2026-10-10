import test from 'node:test';
import assert from 'node:assert/strict';
import { composite, createIndex, defaultSources } from '../index.js';

test('median of fresh exchange quotes; stale and far-off quotes drop out; needs two', () => {
  const now = 1e12;
  const q = (name, price, age = 1000) => ({ name, price, at: now - age });
  assert.deepEqual(composite([q('A', 100000), q('B', 100010), q('C', 100006)], now).price, 100006);
  const c = composite([q('A', 100000), q('B', 100010), q('C', 101000), q('D', 100004, 60000)], now);
  assert.equal(c.price, 100005, 'C is 1% off, D is a minute old');
  assert.deepEqual(c.dropped, ['C']);
  assert.equal(composite([q('A', 100000)], now), null);
});

test('parses each exchange and survives dead ones', async () => {
  const replies = {
    cb: { bid: '100000.00', ask: '100002.00', price: '100001' },
    'https://api.kraken.com/0/public/Ticker?pair=XBTUSD': { result: { XXBTZUSD: { b: ['100004.0', '1'], a: ['100006.0', '1'] } } },
    'https://www.bitstamp.net/api/v2/ticker/btcusd/': { bid: '100008', ask: '100010' },
  };
  const sources = defaultSources('X').map((s) => ({ ...s, url: s.name === 'Coinbase' ? 'cb' : s.url }));
  const ix = createIndex({ sources, fetchJSON: async (u) => { if (!replies[u]) throw new Error('down'); return replies[u]; } });
  const r = await ix.poll(1e12);
  assert.deepEqual(r.used.sort(), ['Bitstamp', 'Coinbase', 'Kraken']);
  assert.equal(r.index, 100005);
  assert.equal(r.coinbase, 100001);
});

import { bookQuote } from '../index.js';
test('order books: each venue\'s mid and depth; the index weighs deeper venues more (like the real one)', async () => {
  const q = bookQuote({ bids: [[100000, 2], [99950, 5], [99000, 50]], asks: [[100010, 1], [100090, 3], [101000, 50]] });
  assert.equal(q.price, 100005);
  assert.ok(Math.abs(q.depth - (100000 * 2 + 99950 * 5 + 100010 + 100090 * 3)) < 1, 'only what sits within 0.1% of the mid');
  assert.equal(bookQuote({ bids: [[10, 1]], asks: [[9, 1]] }), null, 'crossed book');
  const now = 1e12, at = now - 1000;
  const c = composite([{ name: 'Deep', price: 100000, depth: 9e6, at }, { name: 'Thin1', price: 100020, depth: 1e6, at }, { name: 'Thin2', price: 100030, depth: 1e6, at }], now);
  assert.equal(c.price, 100000, 'the deep venue outweighs two thin ones'); assert.equal(c.weighted, true);
  assert.equal(composite([{ name: 'A', price: 100000, at }, { name: 'B', price: 100020, depth: 5, at }, { name: 'C', price: 100030, at }], now).price, 100020, 'plain median when not every venue has a book');
  // books first, tickers when a book can't be read; itBit is one of the venues
  const sources = defaultSources('X');
  assert.ok(sources.some((s) => s.name === 'itBit'));
  const ix = createIndex({ sources: sources.slice(0, 2), fetchJSON: async (u) => {
    if (u.includes('/book')) return { bids: [['100000', '3']], asks: [['100002', '3']] };
    if (u.includes('Depth')) throw new Error('down');
    return { result: { XXBTZUSD: { b: ['100004.0', '1'], a: ['100006.0', '1'] } } };
  } });
  const r = await ix.poll(now);
  assert.deepEqual(r.sources.map((x) => [x.name, x.depth != null]), [['Coinbase', true], ['Kraken', false]]);
  assert.equal(r.weighted, false, 'Kraken fell back to its ticker');
});
