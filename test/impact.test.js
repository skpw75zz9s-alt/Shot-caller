import test from 'node:test';
import assert from 'node:assert/strict';
import { createImpact, liveBubbles } from '../public/chart.js';

const T = 1_700_000_000_000;
const tr = (ex, ms, side, price, size, whale = false) => ({ ex, t: T + ms, side, price, size, whale });
const opt = { sigmaMin: 0.0008, now: T }; // typical 10-second move ~$33 at $100k: needs a $10 push

test('a market order sweeping the book (several fills, one side, under a second) that moves the price bubbles once', () => {
  const push = createImpact();
  assert.equal(push(tr('Coinbase', 0, 'sell', 100000, 0.01), opt), null, 'first trade: nothing to compare with');
  assert.equal(push(tr('Coinbase', 1500, 'buy', 100001, 0.1), opt), null);
  assert.equal(push(tr('Coinbase', 1501, 'buy', 100004, 0.1), opt), null, '$4 so far: not enough');
  const b = push(tr('Coinbase', 1502, 'buy', 100012, 0.2), opt);
  assert.ok(b, 'pushed the price $12: bubbles');
  assert.equal(b.side, 'buy'); assert.equal(b.move, 12); assert.ok(Math.abs(b.usd - (0.1 * 100001 + 0.1 * 100004 + 0.2 * 100012)) < 1e-6);
  assert.equal(push(tr('Coinbase', 1503, 'buy', 100030, 0.3), opt), null, 'the same order keeps going: no second bubble');
  assert.equal(b.move, 30, 'its bubble grows instead'); assert.equal(b.price, 100030);
});

test('trades the book soaks up do not bubble, not even whales', () => {
  const push = createImpact();
  push(tr('Kraken', 0, 'buy', 100000, 0.01), opt);
  assert.equal(push(tr('Kraken', 2000, 'sell', 100000, 8, true), opt), null, '$800k whale sell, price did not move');
  assert.equal(push(tr('Kraken', 2100, 'sell', 100002, 3), opt), null, 'price went the other way');
});

test('small trades that jiggle a thin book do not count, and quiet markets need at least $5', () => {
  const push = createImpact();
  push(tr('Gemini', 0, 'buy', 100000, 0.01), opt);
  assert.equal(push(tr('Gemini', 3000, 'sell', 99980, 0.01), opt), null, '$1k moved it $20: too small to matter');
  const calm = createImpact();
  calm(tr('Bitstamp', 0, 'buy', 100000, 0.01), { sigmaMin: 0.0001 });
  assert.equal(calm(tr('Bitstamp', 3000, 'buy', 100004, 0.5), { sigmaMin: 0.0001 }), null, '$4 is under the $5 floor');
  assert.ok(calm(tr('Bitstamp', 3100, 'buy', 100006, 0.5), { sigmaMin: 0.0001 }), '$6 in a calm market counts');
});

test('a whale that moves the price is gold; bubbles disappear after 3 seconds', () => {
  const push = createImpact();
  push(tr('Binance.US', 0, 'buy', 100000, 0.01), opt);
  const b = push(tr('Binance.US', 2000, 'sell', 99970, 3, true), opt);
  assert.ok(b.whale && b.side === 'sell' && b.move === 30);
  assert.deepEqual(liveBubbles([b], T + 1000), [b]);
  assert.deepEqual(liveBubbles([b], T + 3500), []);
});
