import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, holdOdds, riskSettings } from '../public/model.js';
import { buySignal } from '../public/engine.js';

const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002;
const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
const market = (min, yb, ya) => ({ ticker: 'T', close_time: new Date(NOW + min * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya });
// quoteLog with the bot's odds steady at p for the last `secs` seconds
const steadyLog = (p, secs) => ({ T: [...Array(secs / 2 + 1)].map((_, i) => ({ t: NOW - secs * 1000 + i * 2000, p, yesAsk: null, noAsk: null })) });
function setup(spot, min, yb, ya, log = {}) {
  const m = market(min, yb, ya);
  const ev = evaluate({ market: m, strike: K, spot, sigmaMin: SIG, now: NOW });
  return { row: { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } }, snap: { now: NOW, bars, sigmaMin: SIG, sigmaLong: SIG, driftMin: 0, spot, quoteLog: log } };
}

test('hold odds: higher the further BTC is on your side, lower with more time left', () => {
  const m = market(8, 50, 52);
  const near = holdOdds({ market: m, strike: K, spot: K + 70, sigmaMin: SIG, minutesLeft: 8, side: 'YES' });
  const far = holdOdds({ market: m, strike: K, spot: K + 150, sigmaMin: SIG, minutesLeft: 8, side: 'YES' });
  const late = holdOdds({ market: m, strike: K, spot: K + 70, sigmaMin: SIG, minutesLeft: 3, side: 'YES' });
  assert.ok(near < far && near < late, `${near} ${far} ${late}`);
  assert.equal(holdOdds({ market: m, strike: K, spot: K + 70, sigmaMin: SIG, minutesLeft: 8, side: 'YES' }), near, 'same inputs, same answer (no jitter)');
});

test('Steady: a confident call that probably will not hold waits; one that will, fires', () => {
  const st = riskSettings('steady');
  const shaky = setup(K + 75, 9, 60, 62, steadyLog(0.9, 70));
  const a = buySignal(shaky.row, shaky.snap, st, NOW, {});
  assert.ok(a.deep.score >= 85, `confident: ${a.deep.score}`);
  assert.ok(a.hold < 0.8 && !a.fire && !a.holdOk, `hold ${a.hold}`);
  assert.ok(a.deep.checks.some((c) => /stays above 80 to the end/.test(c.label)));
  assert.equal(buySignal(shaky.row, shaky.snap, { ...st, minHold: 0, steadySec: 0 }, NOW, {}).fire, true, 'without the hold rule it would have called');
  const solid = setup(K + 150, 9, 80, 82, steadyLog(0.97, 70));
  const b = buySignal(solid.row, solid.snap, st, NOW, {});
  assert.ok(b.hold >= 0.8 && b.fire, `hold ${b.hold}`);
});

test('Steady: needs a minute of steady odds, and never switches sides mid-round', () => {
  const st = riskSettings('steady');
  const fresh = setup(K + 150, 9, 80, 82, steadyLog(0.97, 20));
  const a = buySignal(fresh.row, fresh.snap, st, NOW, {});
  assert.ok(!a.fire && !a.steadyOk, 'only 20s of history');
  const flip = setup(K + 150, 9, 80, 82, steadyLog(0.97, 70));
  const mem = { T: { side: 'NO', at: NOW - 120000, n: 1 } };
  const locked = buySignal(flip.row, flip.snap, st, NOW, mem);
  assert.equal(locked.callSide, null, 'locked on NO: no switch to YES');
  assert.ok(locked.locked);
  const free = buySignal(flip.row, flip.snap, { ...st, lockCall: false }, NOW, { T: { side: 'NO', at: NOW - 120000, n: 1 } });
  assert.equal(free.callSide, 'YES', 'unlocked it would switch');
});

test('Steady waits by market stability: 30s when stable (👍), 60s moderate, 90s unstable', () => {
  const st = riskSettings('steady');
  const calm = setup(K + 150, 9, 80, 82, steadyLog(0.97, 40));
  const a = buySignal(calm.row, calm.snap, st, NOW, {});
  assert.equal(a.stability.level, 'stable');
  assert.equal(a.steadyNeed, 30);
  assert.ok(a.fire, '40s of steady odds is enough in a calm market');
  assert.equal(buySignal(calm.row, calm.snap, { ...st, steadyByStability: false }, NOW, {}).fire, false, 'the fixed 60s wait would still be waiting');
  // jumpy: volatility 2.2× its norm and a shock candle
  const jumpy = setup(K + 150, 9, 80, 82, steadyLog(0.97, 70));
  const shock = bars.map((b, i) => (i === bars.length - 3 ? { ...b, h: b.h + 120, l: b.l - 120 } : b));
  const b = buySignal(jumpy.row, { ...jumpy.snap, bars: shock, sigmaMin: SIG * 2.2 }, st, NOW, {});
  assert.equal(b.stability.level, 'unstable', JSON.stringify(b.stability));
  assert.equal(b.steadyNeed, 90);
  assert.ok(!b.fire && !b.steadyOk, '70s is not enough when unstable');
});
