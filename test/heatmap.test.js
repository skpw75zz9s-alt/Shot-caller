import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookBuckets, niceStep } from '../bookmath.js';
import { createOrderBook } from '../orderbook.js';

const side = (from, step, n, size = '1') => Array.from({ length: n }, (_, i) => [String((from + step * i).toFixed(2)), size, 0]);

test('the grid step is a round number about 0.04% of the price', () => {
  assert.equal(niceStep(100000), 50);
  assert.equal(niceStep(2500), 1);
  assert.equal(niceStep(150), 0.05);
  assert.ok(Math.abs(niceStep(0.2) - 0.0001) < 1e-12);
});

test('buckets: dollars per grid step, only near the price, biggest first', () => {
  const bids = [...side(99.99, -0.01, 300), ['99.50', '1000', 0], ['90.00', '9999', 0]], asks = side(100.01, 0.01, 300);
  const h = bookBuckets(bids, asks, 0.1);
  assert.ok(Math.abs(h.mid - 100) < 1e-9);
  assert.equal(h.b[0][0], 995, 'the 99.50 wall leads, in the 99.5 bucket');
  assert.ok(h.b[0][1] > 99000);
  assert.ok(!h.b.some(([k]) => k === 900), 'the order 10% away is out of the window');
  assert.ok(h.b.length <= 40 && h.a.length <= 40);
  assert.equal(bookBuckets([], asks, 0.1), null);
});

test('the server keeps a heatmap column every 30 s on one grid, and it survives a restart', async () => {
  let t = 0, px = 100;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: [], result: { X: { bids: side(px - 0.01, -0.01, 300), asks: side(px + 0.01, 0.01, 300) } } }) });
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'hm-')), 'b.json');
  const ob = createOrderBook({ file, fetchImpl, clock: () => t, log: { error() {} } });
  for (let i = 0; i < 5; i++) { await ob.refresh('BTC'); t += 15000; px += 0.05; }
  const h = ob.heatmap('BTC');
  assert.equal(h.snaps.length, 3, 'every 30 s, not every refresh');
  assert.equal(h.step, niceStep(100));
  assert.ok(h.snaps[2].mid > h.snaps[0].mid);
  await ob.save();
  const ob2 = createOrderBook({ file, fetchImpl, clock: () => t, log: { error() {} } });
  await ob2.load();
  assert.equal(ob2.heatmap('BTC').snaps.length, 3);
  assert.ok(ob.heatmap('GOLD').off);
});
