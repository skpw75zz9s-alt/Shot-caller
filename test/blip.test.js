import test from 'node:test';
import assert from 'node:assert/strict';
import { blip } from '../public/blip.js';
import { kalshiFee } from '../public/model.js';

const live = { m: { ticker: 'T' } }, now = 1e12;

test('the blip lights only on the buy signal, with the cautious profit per $10', () => {
  const b = blip({ live, sig: { callSide: 'YES', price: 0.62, winProb: 0.8 }, showBuy: true, now });
  const per10 = ((0.8 * 0.38 - 0.2 * 0.62 - kalshiFee(0.62)) / 0.62) * 10;
  assert.equal(b.tone, 'buy'); assert.ok(Math.abs(b.per10 - per10) < 1e-9);
  assert.equal(b.text, `BUY UP 62¢ · +$${per10.toFixed(2)}/$10`); assert.match(b.title, /worst-case odds \(80%\).*never a guarantee/);
  assert.match(blip({ live, sig: { callSide: 'NO', price: 0.7, winProb: 0.6 }, showBuy: true, now }).text, /^BUY DOWN 70¢ · −\$/, 'a losing estimate says so');
  assert.equal(blip({ live, sig: { callSide: 'YES', price: 0.62, winProb: 0.8 }, showBuy: false, now }).tone, 'watch', 'no buy signal shown, no light');
});

test('Market Watch holds and paused calls come first; nothing without a round', () => {
  const sig = { callSide: 'YES', price: 0.6, winProb: 0.9 };
  const h = blip({ live, sig, showBuy: true, watchHold: { until: now + 5000, why: 'No fresh price for 30s+' }, now });
  assert.equal(h.tone, 'hold'); assert.match(h.title, /holding new calls: No fresh price/);
  assert.equal(blip({ live, sig, showBuy: true, watchHold: { until: now - 1 }, now }).tone, 'buy', 'an expired hold is no hold');
  assert.equal(blip({ live, sig, showBuy: true, block: { kind: 'loss' }, now }).tone, 'paused');
  assert.equal(blip({ live: null, now }).tone, 'off');
  assert.equal(blip({ live, now }).text, 'Watching');
});
