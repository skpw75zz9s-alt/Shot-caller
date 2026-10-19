import test from 'node:test';
import assert from 'node:assert/strict';
import { XRAY, distance, flowWindows, kalshiBig, liqSummary, positioning, pulse, whaleSummary, xrayLayers, xraySummary } from '../public/xray.js';

const now = 1e10;
const live = { pYes: 0.7, pBot: 0.66, yesBid: 0.6, yesAsk: 0.64, spot: 100100, strike: 100000, sigmaMin: 0.0005, sigmaLong: 0.0004, minutesLeft: 4 };

test('Kalshi money: UP vs DOWN dollars and the biggest orders', () => {
  const k = kalshiBig([{ t: 1, side: 'YES', count: 100, price: 0.6, usd: 60 }, { t: 2, side: 'NO', count: 500, price: 0.4, usd: 200 }, { t: 3, side: 'YES', usd: 0 }]);
  assert.equal(k.up.usd, 60); assert.equal(k.down.usd, 200); assert.equal(k.top[0].usd, 200); assert.equal(kalshiBig(null).upShare, null);
});

test('order flow: buyers vs sellers over 1, 5 and 10 minutes, by dollars', () => {
  const tr = [{ t: now - 30000, price: 100, size: 3, side: 'buy' }, { t: now - 4 * 60000, price: 100, size: 1, side: 'sell' }, { t: now - 9 * 60000, price: 100, size: 6, side: 'sell' }, { t: now - 20 * 60000, price: 100, size: 99, side: 'buy' }];
  const [w1, w5, w10] = flowWindows(tr, now);
  assert.deepEqual([w1.buy, w1.sell, w1.lean], [300, 0, 1]);
  assert.deepEqual([w5.buy, w5.sell, w5.lean], [300, 100, 0.5]);
  assert.deepEqual([w10.buy, w10.sell, w10.n], [300, 700, 3]);
});

test('whales, liquidations and positioning in a window', () => {
  const w = whaleSummary([{ t: now - 10, side: 'buy', usd: 5e5 }, { t: now - 20, side: 'sell', usd: 2e5 }, { t: now - 3600000, side: 'buy', usd: 9e9 }], now);
  assert.equal(w.n, 2); assert.equal(w.net, 3e5);
  const L = liqSummary([{ t: now - 1000, ex: 'OKX', liq: 'long', usd: 3e6 }, { t: now - 2000, ex: 'Binance', liq: 'short', usd: 1e6 }, { t: now - 7200000, liq: 'long', usd: 1e9 }], now);
  assert.equal(L.long, 3e6); assert.equal(L.short, 1e6); assert.equal(L.biggest[0].ex, 'OKX');
  assert.match(positioning({ funding: 0.00008, oiChange5: 0.004, priceChange5: -0.002 }).words.join(' '), /longs paying shorts.*crowded.*selling the drop/);
  assert.equal(positioning(null), null);
});

test('distance to the target in typical moves, and the pulse against normal', () => {
  const d = distance(live);
  assert.ok(Math.abs(d.move - 100100 * 0.0005 * 2) < 1e-6); assert.equal(d.gap, 100);
  assert.ok(Math.abs(d.z - Math.log(100100 / 100000) / 0.001) < 1e-9);
  assert.equal(distance({ ...live, minutesLeft: 0 }), null);
  assert.equal(pulse(0.0005, 0.0004).label, 'normal'); assert.equal(pulse(0.0008, 0.0004).label, 'wild'); assert.equal(pulse(0.0002, 0.0004).label, 'calm'); assert.equal(pulse(0, 1), null);
});

test('crypto layers: the odds, pulse, Kalshi money, flow, whales, leverage and money flows, each with a lean and its use', () => {
  const L = xrayLayers({ now, kind: 'crypto', live,
    kalshiTrades: [{ side: 'YES', usd: 3000, count: 5000, price: 0.6 }, { side: 'NO', usd: 1000, count: 2500, price: 0.4 }],
    trades: [{ t: now - 60000, price: 100, size: 30, side: 'sell' }, { t: now - 61000, price: 100, size: 10, side: 'buy' }],
    whales: [{ t: now - 1000, side: 'buy', usd: 4e5, ex: 'Coinbase' }],
    scan: { verdict: 'Buyers in control', score: 40, inCalls: true },
    srv: { liqs: { n: 2, long: 0, short: 2e6, minutes: 30, biggest: [] }, futures: { words: ['funding near zero: neither side crowded'] },
      flows: { etf: { on: true, read: { date: '2026-10-18', value: 250, lean: 1 }, test: { proven: false } }, stables: { on: true, read: null }, whale: { on: false } } } });
  const by = Object.fromEntries(L.map((l) => [l.key, l]));
  assert.deepEqual(L.map((l) => l.key), ['odds', 'pulse', 'crowd', 'flow', 'whales', 'leverage', 'money']);
  assert.ok(Math.abs(by.odds.lean - 0.4) < 1e-9); assert.match(by.odds.read, /Bot 70% UP · Kalshi 62%/); assert.equal(by.odds.inCalls, true);
  assert.match(by.odds.facts.join(' '), /\$100\.00 above the target: 1\.00 typical moves for the 4 minutes left/); assert.match(by.odds.facts.join(' '), /8 points more bullish/);
  assert.equal(by.pulse.lean, null); assert.match(by.pulse.read, /Normal · 1.25× normal/);
  assert.ok(Math.abs(by.crowd.lean - 0.5) < 1e-9, 'UP $3k of $4k: a full-size crowd');
  assert.ok(by.flow.lean < 0); assert.equal(by.flow.inCalls, true); assert.match(by.flow.facts.join(' '), /Round scan: Buyers in control \(\+40\)/);
  assert.equal(by.whales.lean, 1);
  assert.ok(by.leverage.lean > 0, 'shorts force-closed: a squeeze up');
  assert.ok(Math.abs(by.money.lean - 1 / 3) < 1e-9); assert.equal(by.money.inCalls, false); assert.match(by.money.facts.join(' '), /on probation/); assert.match(by.money.facts.join(' '), /needs WHALE_ALERT_API_KEY/);
  const s = xraySummary(L);
  assert.equal(s.up, 5); assert.equal(s.down, 1); assert.equal(s.tone, 'mixed'); assert.equal(s.headline, 'Mixed: 5 UP, 1 DOWN'); assert.equal(s.strongest.key, 'flow', 'sellers 75% of 5 minutes: a full lean, and first of the ties');
});

test('a small crowd leans little; no round and no data say so', () => {
  const L = xrayLayers({ now, kind: 'crypto', live: null, kalshiTrades: [{ side: 'YES', usd: 100, count: 200, price: 0.5 }], trades: [], whales: [], srv: null });
  const by = Object.fromEntries(L.map((l) => [l.key, l]));
  assert.ok(Math.abs(by.crowd.lean - 0.05) < 1e-9);
  assert.equal(by.odds.off, true); assert.equal(by.flow.lean, null); assert.equal(by.leverage.off, true);
  assert.ok(!L.some((l) => l.key === 'money'));
  assert.equal(xraySummary([{ key: 'a', lean: null }]).headline, 'Nothing to read yet');
  assert.equal(xraySummary([{ key: 'odds', name: 'The odds', lean: 0.9 }, { key: 'b', name: 'B', lean: 0 }]).headline, 'Only the odds lean UP so far');
  assert.equal(xraySummary([{ key: 'w', name: 'Whales', lean: -0.5 }, { key: 'f', name: 'Order flow', lean: -0.3 }]).headline, '2 layers lean DOWN, none UP');
});

test('stock indexes, gold and oil get what\'s moving them instead of the crypto layers', () => {
  const drivers = { supported: true, move: 6, w: 60, parts: [{ group: 'macro', usd: 4 }, { group: 'sector', usd: 3 }, { group: 'own', usd: -1 }] };
  const L = xrayLayers({ now, kind: 'index', live: { ...live, spot: 6000, strike: 5990, sigmaMin: 0.0003 }, kalshiTrades: [], drivers, fmt: (v) => `$${v.toFixed(2)}` });
  assert.deepEqual(L.map((l) => l.key), ['odds', 'pulse', 'crowd', 'drivers']);
  const d = L.at(-1);
  assert.match(d.read, /Up \$6.00 in 60 min/); assert.deepEqual(d.facts, ['The dollar, rates and stocks: +$4.00', 'The rest of its market: +$3.00', 'Its own buyers and sellers: −$1.00']);
  assert.equal(d.lean, 1, '$6 against a typical $3.60 move: capped at full UP');
  assert.equal(xraySummary([{ key: 'a', lean: XRAY.flat - 0.01 }]).tone, 'flat');
});
