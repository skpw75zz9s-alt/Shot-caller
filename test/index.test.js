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
