import test from 'node:test';
import assert from 'node:assert/strict';
import { crossings, distance, hiddenStats, kalshiBig, liqSummary, niceStep, positioning, xraySvg } from '../public/xray.js';
import { kalshiFee, normCdf } from '../public/model.js';

const now = 1e12, live = { pYes: 0.7, yesBid: 0.6, yesAsk: 0.64, spot: 100100, strike: 100000, sigmaMin: 0.0005, sigmaLong: 0.0004, minutesLeft: 4 };
const by = (xs) => Object.fromEntries(xs.map((x) => [x.key, x]));

test('readers: Kalshi orders, liquidations, funding per year, distance, round steps and target crossings', () => {
  const k = kalshiBig([{ side: 'YES', usd: 60 }, { side: 'NO', usd: 200 }, { side: 'YES', usd: 0 }]);
  assert.deepEqual([k.n, k.total, k.biggest], [2, 260, 200]);
  assert.deepEqual(liqSummary([{ t: now - 1, liq: 'long', usd: 3 }, { t: now - 2, liq: 'short', usd: 1 }, { t: now - 4e6, liq: 'long', usd: 9 }], now), { n: 2, long: 3, short: 1, minutes: 30 });
  assert.ok(Math.abs(positioning({ funding: 0.00001 }).fundingYear - 0.0876) < 1e-9); assert.equal(positioning(null), null);
  const d = distance(live); assert.equal(d.gap, 100); assert.ok(Math.abs(d.move - 100.1) < 1e-9); assert.equal(distance({ ...live, minutesLeft: 0 }), null);
  assert.deepEqual([niceStep(10.01), niceStep(2.7), niceStep(0.06), niceStep(80)], [10, 2, 0.05, 100]);
  assert.equal(crossings([99, 101, 102, 100, 98, 101], 100), 3, 'a close exactly on the target is no crossing by itself');
});

test('the hidden stats: cross chance, clock value, odds per move, break-even, the toll, crossings, volatility, lock-in', () => {
  const s = by(hiddenStats({ now, kind: 'crypto', settle: 'avg60', live, closes: [99900, 100050, 99950, 100080] }));
  const z = Math.log(1.001) / (0.0005 * 2);
  assert.equal(s.cross.value, `${Math.round(2 * normCdf(-z) * 100)}%`); assert.match(s.cross.note, /has to finish below it/);
  const gain = (normCdf(z * Math.sqrt(4 / 3)) - normCdf(z)) * 100;
  assert.equal(s.theta.value, `+${gain.toFixed(1)} pts/min`);
  assert.match(s.delta.value, / pts per \$10\.00$/);
  const be = 0.64 + kalshiFee(0.64);
  assert.equal(s.breakeven.value, `${(be * 100).toFixed(1)}% wins`); assert.equal(s.breakeven.tone, 'pos'); assert.match(s.breakeven.note, /UP at 64¢.*The bot gives it 70\.0%/);
  assert.match(s.toll.note, /Buying UP and selling it straight back costs/);
  assert.equal(s.crossings.value, '3×');
  assert.equal(s.regime.value, '1.25×');
  assert.equal(s.lockin.value, '1/60 per sec');
  assert.equal(by(hiddenStats({ now, kind: 'crypto', settle: 'avg60', live: { ...live, minutesLeft: 0.25 } })).lockin.value, '75%');
});

test('the bot favouring DOWN: break-even and the toll are for DOWN, priced off the YES bid', () => {
  const s = by(hiddenStats({ now, kind: 'index', settle: 'spot', live: { ...live, pYes: 0.2, yesBid: 0.25, yesAsk: 0.28 } }));
  assert.match(s.breakeven.note, /DOWN at 75¢/); assert.ok(!s.lockin, 'spot-settled markets have no 60-second average');
});

test('crypto extras: trade pace, the Kalshi crowd, the cost of leverage and forced closes; nothing without data', () => {
  const trades = [...Array.from({ length: 30 }, (_, i) => ({ t: now - 120000 - i * 10000 })), ...Array.from({ length: 12 }, (_, i) => ({ t: now - i * 4000 }))];
  const s = by(hiddenStats({ now, kind: 'crypto', live: null, trades, kalshiTrades: [{ side: 'YES', usd: 30 }, { side: 'NO', usd: 10 }],
    srv: { futures: { fundingYear: 0.42 }, liqs: { n: 3, long: 2e6, short: 5e5, minutes: 30 } } }));
  assert.equal(s.pace.value, `${(12 / 4.2).toFixed(1)}× · 12/min`);
  assert.equal(s.crowd.value, '$20 · 2 orders');
  assert.equal(s.funding.value, 'longs pay 42.0%/yr'); assert.equal(s.funding.tone, 'neg');
  assert.equal(s.liqs.value, '$2.5M · 30 min');
  assert.deepEqual(hiddenStats({ now, kind: 'crypto', live: null }), []);
});

test('the film: ribs per minute, the target, the spine, crossing bones, the cone to the close and the live dot', () => {
  const open = now - 5 * 60000, close = now + 10 * 60000;
  const bars = [{ t: open + 60000, c: 99950 }, { t: open + 120000, c: 100050 }, { t: open + 180000, c: 99980 }, { t: open - 60000, c: 1 }];
  const { svg, ok } = xraySvg({ bars, spot: 100020, strike: 100000, open, close, now, sigmaMin: 0.0005 });
  assert.equal(ok, true);
  assert.equal((svg.match(/class="rib"/g) || []).length, 16);
  assert.equal((svg.match(/class="bone cross"/g) || []).length, 3);
  assert.match(svg, /class="target"/); assert.match(svg, /class="spine"/); assert.match(svg, /class="tissue"/); assert.match(svg, /class="bone now"/);
  assert.doesNotMatch(svg, /NaN/);
  assert.equal(xraySvg({ open, close: open, strike: 1 }).ok, false);
});
