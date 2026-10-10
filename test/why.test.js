import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMove } from '../public/why.js';

const NOW = 1_700_000_600_000, EX = ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US'];
// 9.5 quiet minutes at $100,000 (balanced, $20k a second), then the last 30 seconds from `last30(i, ex)`
function tape(last30) {
  const ts = [];
  for (let s = -570; s < 0; s++) for (const ex of EX) ts.push({ t: NOW - 30000 + s * 1000, ex, side: s % 2 ? 'buy' : 'sell', price: 100000, size: 0.04 });
  for (let i = 1; i <= 30; i++) for (const ex of EX) ts.push(...last30(i, ex).map((x) => ({ t: NOW - 30000 + i * 1000, ex, ...x })));
  return ts.sort((a, b) => a.t - b.t);
}

test('buyers lifting it on every exchange, a surge in volume and a sweep: explained, with the sweep first', () => {
  const ts = tape((i, ex) => [{ side: 'buy', price: 100000 + i * 4, size: 0.3 }, { side: 'sell', price: 100000 + i * 4, size: 0.05 }]);
  const impacts = [{ t: NOW - 5000, side: 'buy', ex: 'Coinbase', usd: 650000, move: 25, whale: true }];
  const n = explainMove({ trades: ts, impacts, now: NOW, sigmaMin: 0.0008 });
  assert.ok(n); assert.equal(n.dir, 'up'); assert.equal(Math.round(n.move), 120);
  assert.equal(n.headline, '▲ +$120 in 30s');
  assert.equal(n.tag, 'whale');
  assert.match(n.reasons[0], /🐋 A \$650k market buy on Coinbase swept the book \+\$25/);
  assert.ok(n.reasons.some((r) => /^Buyers drove it: .* \(86%\)$/.test(r)), n.reasons.join(' | '));
  assert.ok(n.reasons.some((r) => /Volume surge/.test(r)));
});

test('price fell while buyers were heavier: a thin book below', () => {
  const ts = tape((i) => [{ side: 'buy', price: 100000 - i * 4, size: 0.015 }, { side: 'sell', price: 100000 - i * 4, size: 0.005 }]);
  const n = explainMove({ trades: ts, now: NOW, sigmaMin: 0.0008 });
  assert.equal(n.dir, 'down'); assert.equal(n.tag, 'thin book');
  assert.ok(n.reasons.some((r) => /buyers pulled their bids/.test(r)));
  assert.ok(n.reasons.some((r) => /light volume/.test(r)), n.reasons.join(' | '));
});

test('one exchange moved first; crossing the target is called out', () => {
  const ts = tape((i, ex) => {
    const k = ex === 'Kraken' ? Math.min(30, i * 3) : Math.max(0, i - 10) * 1.5; // Kraken gets there 10+ seconds early
    return [{ side: 'buy', price: 100000 + k * 4, size: 0.04 }, { side: 'sell', price: 100000 + k * 4, size: 0.04 }];
  });
  const n = explainMove({ trades: ts, now: NOW, sigmaMin: 0.0008, strike: 100050 });
  assert.ok(n.reasons.some((r) => /^Kraken moved first, \d+s ahead of the others$/.test(r)), n.reasons.join(' | '));
  assert.ok(n.reasons.some((r) => /Crossed the target \$100,050: now above it, so UP is winning/.test(r)));
});

test('ordinary wiggles are not explained, and a move is explained once', () => {
  const small = tape((i) => [{ side: 'buy', price: 100000 + i, size: 0.04 }, { side: 'sell', price: 100000 + i, size: 0.04 }]);
  assert.equal(explainMove({ trades: small, now: NOW, sigmaMin: 0.0008 }), null, '$30 in 30s is normal');
  const big = tape((i) => [{ side: 'buy', price: 100000 + i * 4, size: 0.02 }, { side: 'sell', price: 100000 + i * 4, size: 0.02 }]);
  const n = explainMove({ trades: big, now: NOW, sigmaMin: 0.0008 });
  assert.equal(n.tag, 'drift');
  assert.equal(explainMove({ trades: big, now: NOW + 2000, sigmaMin: 0.0008, last: n }), null, 'already explained');
  assert.equal(explainMove({ trades: [], now: NOW }), null);
});
