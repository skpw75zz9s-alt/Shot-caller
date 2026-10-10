import test from 'node:test';
import assert from 'node:assert/strict';
import { learnFeeRates } from '../public/fees.js';
import { feeRates, kalshiFee, setFeeRates } from '../public/model.js';
import { createFeeBook } from '../feebook.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fills = (k, n, taker = true) => Array.from({ length: n }, (_, i) => {
  const count = 1 + (i % 9) * 3, price = 0.55 + (i % 8) * 0.05;
  return { count, price, fee: Math.ceil(k * count * price * (1 - price) * 100 - 1e-9) / 100, taker };
});

test('measures Kalshi\'s real fee rate from fills, takers and makers apart', () => {
  const r = learnFeeRates([...fills(0.09, 30), ...fills(0.0225, 12, false)]);
  assert.ok(Math.abs(r.taker.k - 0.09) <= 0.0025, String(r.taker.k)); assert.equal(r.taker.n, 30);
  assert.ok(Math.abs(r.maker.k - 0.0225) <= 0.005, String(r.maker.k));
  assert.equal(learnFeeRates(fills(0.09, 5)).taker.k, null, 'too few to say');
});

test('the measured rate is used for every fee (and the published 7% until then)', () => {
  setFeeRates(null);
  assert.equal(kalshiFee(0.85, 10), 0.09, '7% default');
  setFeeRates({ taker: { k: 0.1, n: 20 }, maker: { k: 0.02, n: 3 } });
  assert.equal(kalshiFee(0.85, 10), 0.13, '10% measured');
  assert.equal(feeRates().measured.maker, false, 'makers: too few fills, still the default');
  setFeeRates({ taker: { k: 0.07, n: 20 } });
});

test('the server\'s fee book: dedupes reported fills, keeps garbage out, learns and applies', async () => {
  const book = createFeeBook({ file: join(mkdtempSync(join(tmpdir(), 'fees-')), 'fees.json'), log: { error() {} } });
  await book.load();
  const list = fills(0.08, 12).map((f, i) => ({ ...f, id: `f-${i}` }));
  assert.equal(book.add(list), 12);
  assert.equal(book.add(list), 0, 'the same fills again: nothing new');
  assert.equal(book.add([{ count: 5, price: 1.5, fee: 0.1 }, { count: -1, price: 0.5, fee: 0 }, null, { count: 2, price: 0.5, fee: 99 }]), 0);
  assert.ok(Math.abs(book.rates().taker.k - 0.08) <= 0.0025);
  assert.ok(Math.abs(feeRates().taker - 0.08) <= 0.0025, 'applied on the server');
  setFeeRates({ taker: { k: 0.07, n: 20 } });
});
