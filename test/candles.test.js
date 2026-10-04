import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, bollinger, detectPattern, entrySignal, levels, rsi, withLiveBar } from '../public/candles.js';
import { dipLimit, maxPay } from '../public/model.js';

const T0 = 1_700_000_040_000; // on a minute boundary
// Build closed 1-min bars from a list of closes with a small range around each.
const bars = (closes, wick = 5) => closes.map((c, i) => {
  const o = i ? closes[i - 1] : c;
  return { t: T0 + i * 60000, o, c, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick };
});
const nowAfter = (b) => b[b.length - 1].t + 60000;

test('rsi: all gains is 100, all losses is 0, flat-ish is mid', () => {
  assert.equal(rsi([...Array(20)].map((_, i) => 100 + i)).value, 100);
  assert.equal(rsi([...Array(20)].map((_, i) => 100 - i)).value, 0);
  const zig = rsi([...Array(40)].map((_, i) => 100 + (i % 2)));
  assert.ok(zig.value > 40 && zig.value < 60);
  assert.equal(rsi([1, 2, 3]), null);
});

test('bollinger pctB is low after a drop', () => {
  const closes = [...Array(19)].map(() => 100).concat([95]);
  assert.ok(bollinger(closes).pctB < 0.1);
});

test('atr and levels', () => {
  const b = bars([100, 102, 101, 103]);
  assert.ok(atr(b) > 0);
  assert.deepEqual(levels(b), { support: 95, resistance: 108 });
});

test('detectPattern finds hammers, stars and engulfing bars', () => {
  assert.equal(detectPattern(null, { o: 100, c: 101, h: 101.5, l: 95 }).name, 'Hammer');
  assert.equal(detectPattern(null, { o: 101, c: 100, h: 106, l: 99.6 }).name, 'Shooting star');
  assert.equal(detectPattern({ o: 102, c: 100, h: 102.5, l: 99.5 }, { o: 99.8, c: 103, h: 103.2, l: 99.5 }).name, 'Bullish engulfing');
  assert.equal(detectPattern({ o: 100, c: 102, h: 102.5, l: 99.5 }, { o: 102.2, c: 99, h: 102.5, l: 98.8 }).name, 'Bearish engulfing');
  assert.equal(detectPattern(null, { o: 100, c: 104, h: 104.2, l: 99.8 }), null);
});

test('withLiveBar updates the current minute or appends one', () => {
  const b = bars([100, 101]);
  const next = withLiveBar(b, 99, nowAfter(b) + 5000);
  assert.equal(next.length, 3);
  assert.deepEqual([next[2].o, next[2].c, next[2].l], [101, 99, 99]);
  const same = withLiveBar(b, 110, b[1].t + 5000);
  assert.equal(same.length, 2);
  assert.equal(same[1].h, 110);
});

test('entrySignal: a selloff into support with a hammer is a YES low', () => {
  const closes = [...Array(30)].map((_, i) => 100000 + Math.sin(i) * 20).concat([99980, 99950, 99910, 99870, 99830]);
  const b = bars(closes);
  b.push({ t: b[b.length - 1].t + 60000, o: 99830, c: 99845, h: 99848, l: 99760 }); // hammer
  const sig = entrySignal(b, 'YES', nowAfter(b));
  assert.equal(sig.state, 'NOW', sig.reasons.join(', '));
  assert.ok(sig.reasons.includes('Hammer'));
  // The same tape is a spike-high for nobody: NO side should not be told to buy
  assert.notEqual(entrySignal(b, 'NO', nowAfter(b)).state, 'NOW');
});

test('entrySignal: a straight run-up is chasing for YES and a low for NO', () => {
  const b = bars([...Array(35)].map((_, i) => 100000 + i * 15));
  assert.equal(entrySignal(b, 'YES', nowAfter(b)).state, 'CHASE');
  assert.equal(entrySignal(b, 'NO', nowAfter(b)).state, 'NOW');
});

test('entrySignal waits on a quiet tape and handles thin data', () => {
  const b = bars([...Array(40)].map((_, i) => 100000 + (i % 2) * 3), 2);
  assert.equal(entrySignal(b, 'YES', nowAfter(b)).state, 'WAIT');
  assert.equal(entrySignal(bars([1, 2, 3]), 'YES').state, 'WAIT');
});

test('maxPay clears the edge after fees', () => {
  assert.equal(maxPay(0.7, 0.04), 0.64); // 0.70 - 0.64 - 0.02 fee = 0.04
  assert.equal(maxPay(0.03, 0.04), null);
});

test('dipLimit sits below the ask and keeps edge at the dip', () => {
  const market = { close_time: new Date(T0 + 6 * 60000).toISOString(), strike_type: 'greater', floor_strike: 100000, yes_bid: 60, yes_ask: 62 };
  const lim = dipLimit({ market, spot: 100150, dipLevel: 100050, sigmaMin: 0.0008, side: 'YES', now: T0, settings: { minEdge: 0.04 } });
  assert.ok(lim.price < 0.62, `limit ${lim.price}`);
  assert.ok(lim.fairAtDip - lim.price >= 0.04);
  const no = dipLimit({ market, spot: 99900, dipLevel: 100000, sigmaMin: 0.0008, side: 'NO', now: T0 });
  assert.ok(no === null || no.price < 0.40);
});
