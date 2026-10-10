import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRound, scanRecord, leadLag } from '../public/roundscan.js';

const OPEN = 1_700_000_000_000;
const trade = (ex, s, side, price, size = 0.5) => ({ t: OPEN + s * 1000, ex, side, price, size });

test('buyers on every exchange, prices up, size on the buy side: strong buyers', () => {
  const ts = [];
  for (let i = 0; i < 240; i++) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US']) ts.push(trade(ex, i, i % 4 ? 'buy' : 'sell', 100000 + i * 0.5, i === 200 ? 1 : 0.2));
  const sc = scanRound(ts, { openTime: OPEN, now: OPEN + 241000 });
  assert.equal(sc.ready, true); assert.equal(sc.exchanges, 5);
  assert.ok(sc.score >= 45, String(sc.score)); assert.equal(sc.verdict, 'Strong buyers'); assert.equal(sc.lean, 'YES');
  assert.equal(sc.upPrice, 5);
  assert.ok(Math.abs(sc.buyShare - 0.75) < 0.05);
  const cb = sc.rows.find((r) => r.ex === 'Coinbase');
  assert.ok(cb.net > 0 && cb.change > 0 && cb.vwap > 100000);
});

test('split exchanges and flat prices: mixed, no lean; nothing traded yet: not ready', () => {
  const ts = [];
  for (let i = 0; i < 120; i++) { ts.push(trade('Coinbase', i, 'buy', 100000)); ts.push(trade('Kraken', i, 'sell', 100000)); }
  const sc = scanRound(ts, { openTime: OPEN, now: OPEN + 121000 });
  assert.equal(sc.verdict, 'Mixed'); assert.equal(sc.lean, null);
  assert.equal(scanRound([], { openTime: OPEN, now: OPEN + 1000 }).ready, false);
  assert.equal(scanRound([trade('Coinbase', -5, 'buy', 1)], { openTime: OPEN, now: OPEN + 1000 }).ready, false, 'trades before the open do not count');
});

test('leader: the exchange whose moves come first', () => {
  const ts = [];
  let p = 100000;
  const path = [];
  for (let i = 0; i < 300; i++) { p += Math.sin(i * 1.7) * 6 + Math.cos(i * 0.31) * 4; path.push(p); }
  for (let i = 0; i < 300; i++) {
    ts.push(trade('Kraken', i, 'buy', path[i]));
    for (const ex of ['Coinbase', 'Bitstamp', 'Gemini']) ts.push(trade(ex, i, 'buy', path[Math.max(0, i - 2)])); // 2 seconds behind
  }
  assert.equal(leadLag(ts, OPEN, OPEN + 300000)?.ex, 'Kraken');
});

test('record: how often the lean matched the result', () => {
  const r = scanRecord([{ lean: 'YES', score: 60, result: 'yes' }, { lean: 'NO', score: -20, result: 'yes' }, { lean: null, score: 3, result: 'no' }, { lean: 'YES', score: 30 }]);
  assert.deepEqual(r, { graded: 2, right: 1, strong: 1, strongRight: 1, mixed: 1 });
});
