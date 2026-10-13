import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_LEVEL, evaluate, riskLevelOf, riskSettings } from '../public/model.js';
import { buySignal } from '../public/engine.js';

// BTC above the target with `mins` left (same harness as test/earlylane.test.js)
const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002;
const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
function sig({ yb, ya, lead = 250, mins = 8, secs = 70, sigmaLong = SIG, open = null }, s = riskSettings('profit')) {
  const m = { ticker: 'T', close_time: new Date(NOW + mins * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya, ...(open ? { open_time: new Date(open).toISOString() } : {}) };
  const ev = evaluate({ market: m, strike: K, spot: K + lead, sigmaMin: SIG, now: NOW, settings: s });
  const log = { T: [...Array(secs / 2 + 1)].map((_, i) => ({ t: NOW - secs * 1000 + i * 2000, p: 0.99, yesAsk: null, noAsk: null })) };
  return buySignal({ m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } }, { now: NOW, bars, sigmaMin: SIG, sigmaLong, driftMin: 0, spot: K + lead, quoteLog: log }, s, NOW, {});
}

test('Profit is the official level: calls that pay', () => {
  const p = riskSettings('profit');
  assert.equal(OFFICIAL_LEVEL, 'profit'); assert.equal(riskLevelOf(p), 'profit');
  assert.deepEqual([p.minAsk, p.maxAsk, p.minEdge, p.noCallLastMin, p.waitMinutes, p.flipCalls, p.winFloor], [0.6, 0.9, 0.08, 5, 3, 1, 0]);
});

test('the price band: 60 to 90c (a win pays 10c+ a dollar), nothing priced higher however sure', () => {
  for (const ya of [61, 75, 81, 90]) assert.equal(sig({ yb: ya - 1, ya }).fire, true, `${ya}c with the bot ~99%`);
  assert.equal(sig({ yb: 93, ya: 94 }).fire, false, '94c: a win pays 6c, too little');
  assert.equal(sig({ yb: 98, ya: 99 }).fire, false, '99c');
  assert.equal(sig({ yb: 54, ya: 55, lead: 20 }).fire, false, '55c: too much doubt');
});

test('it has to be sure of a good profit: an 8c+ worst-case gap, steady, calm, and never in the last 5 minutes', () => {
  assert.equal(sig({ yb: 84, ya: 85, lead: 90 }).fire, false, 'the bot only a bit surer than Kalshi: the gap is not 8c in the worst case');
  assert.equal(sig({ yb: 80, ya: 81, secs: 20 }).fire, false, 'not steady for a minute yet');
  assert.equal(sig({ yb: 80, ya: 81, sigmaLong: SIG / 2 }).fire, false, 'BTC moving twice its usual speed');
  assert.equal(sig({ yb: 80, ya: 81, mins: 4 }).fire, false, '4 minutes left: no new calls');
});

test('calls start 3 minutes into the round (12 minutes left)', () => {
  const open = NOW - 3.5 * 60000;
  assert.equal(sig({ yb: 80, ya: 81, mins: 11.5, lead: 400, open }).fire, true, '3.5 minutes in');
  assert.equal(sig({ yb: 80, ya: 81, mins: 13, lead: 400, open: NOW - 2 * 60000 }).fire, false, '2 minutes in: still watching');
});
