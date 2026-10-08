import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, bollinger, ema, floorCeiling, forecastCone, macd, rma, rsiSeries, vwap } from '../public/indicators.js';
import { addTrade, flowStats, newFlow, pressureUpdate, takerSide } from '../public/flow.js';
import { ALERT_EVENTS, alertPrefs, routeAlert, sustained } from '../public/alerts.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('EMA, RMA, Bollinger line up with the bars and match hand math', () => {
  const xs = [1, 2, 3, 4, 5, 6];
  const e = ema(xs, 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);                 // SMA seed
  assert.ok(near(e[3], 3));              // 4*0.5 + 2*0.5
  const r = rma(xs, 3);
  assert.ok(near(r[3], (2 * 2 + 4) / 3));
  const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  assert.ok(near(b[7].mid, 5) && near(b[7].up, 9) && near(b[7].lo, 1));
});

test('VWAP from the round open, RSI and MACD shapes', () => {
  const c = [{ t: 0, h: 10, l: 10, c: 10, v: 1 }, { t: 60000, h: 20, l: 20, c: 20, v: 3 }];
  assert.deepEqual(vwap(c, 60000), [null, 20]);
  assert.equal(vwap(c)[1], (10 + 60) / 4);
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsiSeries(up, 14)[29], 100);
  assert.equal(rsiSeries(up, 14)[10], null);
  const m = macd(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5));
  assert.equal(m.length, 60);
  assert.ok(m[59].hist != null && near(m[59].hist, m[59].macd - m[59].signal));
  assert.equal(m[20].signal, null);
});

test('timeframes, floor/ceiling and the forecast cone', () => {
  const one = Array.from({ length: 10 }, (_, i) => ({ t: i * 60000, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
  const five = aggregate(one, 5);
  assert.equal(five.length, 2);
  assert.deepEqual(five[0], { t: 0, o: 0, h: 5, l: -1, c: 4.5, v: 5 });
  assert.deepEqual(floorCeiling(one, 5 * 60000), { floor: 4, ceiling: 10 });
  const cone = forecastCone(100000, 0.0002, 0, 4 * 60000);
  assert.equal(cone.length, 5);
  assert.equal(cone[0].hi90, 100000);
  assert.ok(near(cone[4].hi90 - 100000, 1.645 * 100000 * 0.0002 * 2), 'sd grows with sqrt(time)');
  assert.ok(cone[4].hi50 < cone[4].hi90);
});

test('order flow: aggressor side, round totals reset, whales, sustained pressure flips', () => {
  assert.equal(takerSide('sell'), 'buy', 'a resting sell got lifted: buyer was the aggressor');
  const f = newFlow();
  addTrade(f, { t: 1000, price: 100000, size: 0.5, side: 'buy' }, { round: 1 });
  const w = addTrade(f, { t: 2000, price: 100000, size: 2, side: 'sell' }, { round: 1, whaleMin: 100000 });
  assert.equal(w.usd, 200000);
  let s = flowStats(f, 2000);
  assert.equal(s.buyUsd, 50000); assert.equal(s.sellUsd, 200000); assert.equal(s.roundBuyShare, 0.2); assert.equal(s.whaleSells, 1);
  addTrade(f, { t: 3000, price: 100000, size: 1, side: 'buy' }, { round: 2 });
  s = flowStats(f, 3000);
  assert.equal(s.buyUsd, 100000, 'new round: totals start over');
  assert.equal(s.nowUsd, 350000, 'the 2-minute window carries across rounds');
  // sustained pressure: sells dominate for 10s, then buys take over for 10s
  const g = newFlow();
  for (let t = 0; t <= 12000; t += 1000) { addTrade(g, { t, price: 100000, size: 1, side: 'sell' }); pressureUpdate(g, t); }
  assert.equal(g.pressure, 'sell');
  let flipped = false;
  for (let t = 13000; t <= 60000; t += 500) { addTrade(g, { t, price: 100000, size: 3, side: 'buy' }); flipped ||= pressureUpdate(g, t).flipped; }
  assert.ok(flipped && g.pressure === 'buy');
});

test('alerts: per-event switches, cooldown, quiet mode keeps history, sustained conditions fire once', () => {
  const p = alertPrefs({ sounds: true, events: { win: { sound: false } } });
  assert.equal(p.events.call.sound, true);
  assert.equal(p.events.win.sound, false);
  assert.equal(Object.keys(p.events).length, Object.keys(ALERT_EVENTS).length);
  const log = {};
  assert.deepEqual(routeAlert(p, log, 'call', 'x', 0), { sound: true, visual: true });
  assert.deepEqual(routeAlert(p, log, 'call', 'x', 10000), { sound: false, visual: false }, 'inside the 30s cooldown');
  assert.deepEqual(routeAlert(p, log, 'call', 'x', 40000), { sound: true, visual: true });
  assert.deepEqual(routeAlert({ ...p, quiet: true }, log, 'win', 'y', 50000), { sound: false, visual: false });
  assert.equal(log.history.length, 4, 'everything is in the history');
  const st = {};
  assert.equal(sustained(st, 'flip', true, 0), false);
  assert.equal(sustained(st, 'flip', true, 9000), false);
  assert.equal(sustained(st, 'flip', true, 10000), true);
  assert.equal(sustained(st, 'flip', true, 20000), false, 'once');
  sustained(st, 'flip', false, 21000);
  assert.equal(sustained(st, 'flip', true, 22000), false, 'starts over');
});

test('trend turns: confirmed after 15s, the first trend is not a turn, flips fire once', async () => {
  const { trendTurn } = await import('../public/fx.js');
  const st = {};
  assert.equal(trendTurn(st, 'bear', 0), null);
  assert.equal(trendTurn(st, 'bear', 20000), null, 'first confirmed trend: no animation on app open');
  assert.equal(trendTurn(st, 'bull', 21000), null);
  assert.equal(trendTurn(st, 'bear', 25000), null, 'a 4-second wiggle across');
  assert.equal(trendTurn(st, 'bull', 26000), null);
  assert.equal(trendTurn(st, 'bull', 41000), 'bull', 'held 15s: the bull charges');
  assert.equal(trendTurn(st, 'bull', 60000), null, 'once');
});
