import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RSI, rsiRead, rsiTest } from '../public/rsiagent.js';
import { CANDIDATES, hireRows } from '../public/hires.js';

const T0 = Date.UTC(2026, 9, 1); // a round boundary
// 1-minute bars from a list of closes (each bar opens at the last close)
const barsOf = (closes) => closes.map((c, i) => ({ t: T0 + i * 60000, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c), l: Math.min(c, i ? closes[i - 1] : c), c }));

test('the read: a steady climb is overbought on every timeframe, a steady fall oversold', () => {
  const up = rsiRead(barsOf(Array.from({ length: 400 }, (_, i) => 100 + i * 0.1 + (i % 3 === 0 ? -0.02 : 0))));
  assert.deepEqual(up.tfs.map((x) => x.zone), ['overbought', 'overbought', 'overbought']);
  const down = rsiRead(barsOf(Array.from({ length: 400 }, (_, i) => 200 - i * 0.1 + (i % 3 === 0 ? 0.02 : 0))));
  assert.equal(down.tfs[0].zone, 'oversold');
  assert.equal(up.tfs[0].min, 1); assert.equal(up.tfs[2].min, 15);
});

// one 15-minute round per direction (+1 up, -1 down): each round moves steadily, so the RSI it leaves behind is at the
// extreme of its direction, and a reversal is the next round going the other way
function history(dirs) {
  const closes = [100];
  for (const d of dirs) for (let k = 0; k < 15; k++) closes.push(closes.at(-1) + d * (k % 4 === 3 ? -0.1 : 0.5));
  return barsOf(closes);
}

test('the test: extremes that reverse are proven to fade; ones that keep going are proven to run', () => {
  const fade = rsiTest(history(Array.from({ length: 80 }, (_, i) => (i % 2 ? 1 : -1)))); // every round turns
  assert.ok(fade.extremes >= RSI.minExtremes, `${fade.extremes} extreme rounds`);
  assert.equal(fade.verdict, 'fade');
  const run = rsiTest(history(Array.from({ length: 120 }, (_, i) => (Math.floor(i / 4) % 2 ? 1 : -1)))); // turns 1 round in 4
  assert.equal(run.verdict, 'run');
  const few = rsiTest(history(Array.from({ length: 12 }, (_, i) => (i % 2 ? 1 : -1))));
  assert.equal(few.verdict, 'few', 'under 30 extreme rounds proves nothing');
});

test('the agent on the team: applies once there is history, and reports RSI with its proof', () => {
  const c = CANDIDATES.find((x) => x.key === 'rsi');
  assert.equal(c.fit({ bars: [] }), null);
  const bars = history(Array.from({ length: 80 }, (_, i) => (i % 2 ? 1 : -1)));
  assert.match(c.fit({ bars }), /hours of saved price history/);
  const [row] = hireRows(['rsi'], { now: bars.at(-1).t, bars, series: 'TEST', trials: {} });
  assert.equal(row.role, 'h_rsi');
  assert.match(row.status, /RSI 1m .* 5m .* 15m/);
  assert.match(row.status, /proven: extremes fade/);
});
