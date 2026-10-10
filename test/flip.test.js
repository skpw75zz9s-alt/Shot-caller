import test from 'node:test';
import assert from 'node:assert/strict';
import { flipForecast, flipOffset, flipRecord, turnBaseRate, turnHappened, turnPoints } from '../public/flip.js';
import { candleTurns, predictionCandles } from '../public/predict.js';

const NOW = Date.UTC(2026, 0, 1, 12, 7, 30), M = Math.floor(NOW / 60000) * 60000;
function bars(steps, lastWick = 10) { // 40 minutes; steps(i) = this minute's move (i = minutes before now)
  const out = []; let p = 100000;
  for (let i = 40; i > 0; i--) { const o = p; p += steps(i); out.push({ t: M - i * 60000, o, c: p, h: Math.max(o, p) + 10, l: Math.min(o, p) - (i === 1 ? lastWick : 10) }); }
  return out;
}

test('a stretched, oversold drop into the floor with a rejection wick and buyers stepping in: ripe for a bounce', () => {
  const b = bars((i) => (i <= 6 ? -70 : i % 2 ? 8 : -8), 90);
  const spot = b.at(-1).c + 5;
  const f = flipForecast({ bars: b, spot, sigmaMin: 0.0008, now: NOW, openTime: M - 8 * 60000, flowBuyShare: 0.75 });
  assert.equal(f.dir, 'up'); assert.ok(f.v0 < -40);
  assert.ok(f.score > 0.6, `score ${f.score}`);
  for (const k of ['Stretched', 'RSI', 'Wick', 'Flow']) assert.ok(f.parts.some((p) => p.name === k), k);
  // ripe: the bounce wins back part of the drop within a few minutes, then fades
  const d = [0.5, 1, 2, 3, 4, 5, 6, 8, 14].map((t) => flipOffset(f, t));
  const top = Math.max(...d);
  assert.ok(top > 20, `bounces back above the blend: ${d.map((v) => v.toFixed(0))}`);
  assert.ok(Math.abs(d.at(-1)) < top / 2, 'and fades');
  // the same drop, barely ripe: keeps falling for a bit first
  const mild = { ...f, score: 0.15, bounce: f.bounce * 0.15 / f.score, omega: 0.35 + 0.9 * 0.15, zeta: 1.15 - 0.95 * 0.15 };
  assert.ok(flipOffset(mild, 1) < 0, 'mild: still falling first');
});

test('a calm market: low score, the move just fades (no swing back)', () => {
  const b = bars((i) => (i % 2 ? 6 : -5));
  const f = flipForecast({ bars: b, spot: b.at(-1).c, sigmaMin: 0.0008, now: NOW });
  assert.ok(f.score < 0.15, String(f.score));
  const d = [1, 2, 3, 5, 8].map((t) => flipOffset(f, t));
  assert.ok(d.every((v) => Math.sign(v) === Math.sign(f.v0) || v === 0), 'no swing to the other side');
  assert.equal(flipForecast({ bars: b.slice(0, 5), spot: 1, sigmaMin: 0.0008, now: NOW }), null, 'too little data');
});

test('the prediction candles bend with the flip and the turn is found', () => {
  const b = bars((i) => (i <= 6 ? -70 : i % 2 ? 8 : -8), 90);
  const spot = b.at(-1).c + 5, close = M + 8 * 60000;
  const f = flipForecast({ bars: b, spot, sigmaMin: 0.0008, now: NOW, openTime: M - 8 * 60000, flowBuyShare: 0.75 });
  const lines = [{ key: 'bot', pts: [{ t: NOW, v: spot }, { t: close, v: spot }] }];
  const c = predictionCandles({ lines, spot, sigmaMin: 0.0008, now: NOW, close, bars: b, flip: f });
  const turns = candleTurns(c, spot, NOW, f.sd1, f.v0);
  assert.equal(turns[0]?.dir, 'up'); assert.equal(turns[0].now, true, 'the bounce starts now: flip up on the live candle');
  assert.ok(turns.some((x) => x.dir === 'down' && !x.now), `then it tops out on a prediction candle: ${JSON.stringify(turns)}`);
  assert.ok(Math.max(...c.map((x) => x.ec)) > spot + 20, 'bounces');
});

test('turn grading: a real V counts, a straight line does not; base rate and strength', () => {
  const V = [100, 90, 80, 70, 80, 90, 100].map((c, i) => ({ t: i * 60000, o: c, c, h: c + 1, l: c - 1 }));
  assert.equal(turnHappened(V, 3 * 60000, 'up', 15), true);
  assert.equal(turnHappened(V, 3 * 60000, 'down', 15), false);
  const line = [100, 101, 102, 103, 104, 105, 106].map((c, i) => ({ t: i * 60000, o: c, c, h: c + 1, l: c - 1 }));
  assert.equal(turnHappened(line, 3 * 60000, 'up', 15), false);
  assert.equal(turnHappened(V, 6 * 60000, 'up', 15), null, 'not enough bars after it yet');
  assert.equal(turnBaseRate(V, 15), 1 / 2, 'the one complete minute: up yes, down no');
  assert.deepEqual(turnPoints([{ t: 1, v: 5 }, { t: 2, v: 3 }, { t: 3, v: 6 }]).map((x) => x.dir), ['up']);
  const log = Array.from({ length: 20 }, (_, i) => ({ hit: i < 8 }));
  assert.deepEqual(flipRecord(log, 0.2), { n: 20, hits: 8, rate: 0.4, base: 0.2, amp: 1.3 }, 'twice the base rate: full strength (capped)');
  assert.equal(flipRecord(log.map((e, i) => ({ hit: i < 1 })), 0.2).amp, 0.3, 'worse than random: shrinks');
  assert.equal(flipRecord(log.slice(0, 5), 0.2).amp, 1, 'under 20 graded: unchanged');
});
