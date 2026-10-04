import test from 'node:test';
import assert from 'node:assert/strict';
import { exitSignal, sellTarget } from '../public/model.js';
import { flipSigns } from '../public/candles.js';

const pos = { side: 'YES', price: 0.40, contracts: 10 };

test('sellTarget covers the exit fee', () => {
  const t = sellTarget(0.60);
  assert.ok(t - Math.ceil(0.07 * t * (1 - t) * 100 - 1e-9) / 100 >= 0.60 - 1e-9);
  assert.equal(sellTarget(0.999), 0.99);
});

test('holds while the bot still values it above the bid and nothing is flipping', () => {
  const ex = exitSignal({ pos, bid: 0.45, pSide: 0.66, minutesLeft: 6 });
  assert.equal(ex.action, 'HOLD');
  assert.ok(ex.target >= 0.66);
});

test('takes profit when the bid catches up to the bot odds', () => {
  const ex = exitSignal({ pos, bid: 0.70, pSide: 0.66, minutesLeft: 6 });
  assert.equal(ex.action, 'SELL');
  assert.equal(ex.kind, 'take');
  assert.ok(ex.pnl > 2.5);
});

test('sells on any flip sign while in profit, but not at a loss', () => {
  const win = exitSignal({ pos, bid: 0.50, pSide: 0.66, flips: ['Shooting star'], minutesLeft: 6 });
  assert.equal(win.action, 'SELL');
  assert.equal(win.kind, 'flip');
  const lose = exitSignal({ pos, bid: 0.38, pSide: 0.66, flips: ['Shooting star'], minutesLeft: 6 });
  assert.equal(lose.action, 'HOLD');
});

test('trailing bid and falling odds count as flip signs', () => {
  const trail = exitSignal({ pos: { ...pos, peakBid: 0.58 }, bid: 0.52, pSide: 0.70, minutesLeft: 6 });
  assert.equal(trail.kind, 'flip');
  const odds = exitSignal({ pos: { ...pos, peakP: 0.80 }, bid: 0.50, pSide: 0.70, minutesLeft: 6 });
  assert.equal(odds.kind, 'flip');
});

test('cuts when the bot odds fall below what it sells for', () => {
  const ex = exitSignal({ pos, bid: 0.30, pSide: 0.25, minutesLeft: 6 });
  assert.equal(ex.action, 'SELL');
  assert.equal(ex.kind, 'cut');
  assert.ok(ex.pnl < 0);
});

test('closed market and no bids', () => {
  assert.equal(exitSignal({ pos, bid: 0.5, pSide: 0.6, minutesLeft: 0 }).kind, 'closed');
  assert.equal(exitSignal({ pos, bid: null, pSide: 0.6, minutesLeft: 3 }).kind, 'nobid');
});

test('flipSigns spots a shooting star after a run-up for YES only', () => {
  const T0 = 1_700_000_040_000;
  const closes = [...Array(30)].map((_, i) => 100000 + i * 12);
  const b = closes.map((c, i) => ({ t: T0 + i * 60000, o: i ? closes[i - 1] : c, c, h: c + 3, l: (i ? closes[i - 1] : c) - 3 }));
  const lc = closes[closes.length - 1];
  b.push({ t: T0 + 30 * 60000, o: lc, c: lc - 2, h: lc + 60, l: lc - 4 }); // shooting star
  const now = T0 + 31 * 60000;
  assert.ok(flipSigns(b, 'YES', now).includes('Shooting star'));
  assert.ok(!flipSigns(b, 'NO', now).includes('Shooting star'));
});
