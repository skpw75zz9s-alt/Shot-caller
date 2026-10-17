import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_CANDIDATES, divergence, doublePatterns, emaBounce, lessonsNow, macdCross, openingRange, patternStats, rangeLadder, rangeSignal } from '../public/lessons.js';
import { rsiSeries } from '../public/indicators.js';
import { CANDIDATES, FAMILY_NAMES, signalSeries } from '../public/tune.js';

const T0 = Date.UTC(2026, 9, 1), MIN = 60000;
const fromCloses = (cs, t0 = T0) => cs.map((c, i) => ({ t: t0 + i * MIN, o: i ? cs[i - 1] : c, h: Math.max(c, i ? cs[i - 1] : c) + 0.05, l: Math.min(c, i ? cs[i - 1] : c) - 0.05, c, v: 1 }));
function walk(n, seed = 5, drift = 0) {
  let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const cs = []; let p = 100;
  for (let i = 0; i < n; i++) { p *= Math.exp(drift + 0.001 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())); cs.push(p); }
  return cs;
}

test('every lesson is in the indicator test, one signal per candle in -1..1', () => {
  const bars = fromCloses(walk(3000));
  for (const c of LESSON_CANDIDATES) {
    assert.ok(CANDIDATES.includes(c) && FAMILY_NAMES[c.family], c.id);
    const s = signalSeries(c, bars);
    assert.equal(s.length, bars.length, c.id); assert.ok(s.every((v) => v == null || [-1, 0, 1].includes(v)), c.id);
  }
});

test('MACD: a fresh cross of the signal line, for a few minutes only', () => {
  const cs = [...Array(80)].map((_, i) => 100 - 0.002 * i * i).concat([...Array(40)].map((_, i) => 87.2 + i * 0.4));
  const s = macdCross(cs, 3), at = s.findIndex((v, i) => i > 80 && v === 1);
  assert.ok(at > 80 && at < 100, String(at)); assert.ok(s.slice(60, 80).every((v) => v === 0), 'no cross on the steady fall'); assert.equal(s[at + 4], 0, 'not a cross any more 4 minutes later');
});

test('RSI divergence: a new high on weaker momentum warns down', () => {
  const cs = [...Array(30)].map((_, i) => 100 + i).concat([...Array(15)].map((_, i) => 129 - i * 0.8), [...Array(15)].map((_, i) => 117 + i * 0.95));
  const d = divergence(cs, rsiSeries(cs, 14), 30, 2);
  assert.equal(d.at(-1), -1);
  assert.equal(divergence(cs.map((x) => -x + 300), rsiSeries(cs.map((x) => -x + 300), 14), 30, 2).at(-1), 1, 'and the mirror warns up');
});

test('EMA bounce: a dip to a rising EMA that holds is support', () => {
  const cs = [...Array(60)].map((_, i) => 100 + i * 0.2);
  const bars = fromCloses(cs); bars[59] = { ...bars[59], l: bars[59].c - 3 };
  assert.equal(emaBounce(bars, 21).at(-1), 1);
});

test('ceiling / floor: the opening range, breakthroughs and rejections', () => {
  const rs = Math.ceil(T0 / 900000) * 900000, cs = [100, 101, 99, 100, 100.5, 102, 102.5, 101, 101, 100.5];
  const bars = fromCloses(cs, rs), r = openingRange(bars, 3);
  assert.equal(r[2], null, 'the first 3 minutes build it'); assert.ok(Math.abs(r[3].ceil - 101.05) < 1e-9 && Math.abs(r[3].floor - 98.95) < 1e-9);
  const br = rangeSignal(bars, 3, 'break');
  assert.equal(br[5], 1, 'closed above the ceiling'); assert.equal(br[4], 0);
  const rj = [...bars]; rj[8] = { ...rj[8], h: 103 }; rj[5] = { ...rj[5], c: 100.8 }; rj[6] = { ...rj[6], c: 100.8 }; rj[7] = { ...rj[7], c: 100.8, h: 100.9 }; rj[8].c = 100.9;
  assert.equal(rangeSignal(rj, 3, 'reject')[8], -1, 'a wick above that closed back inside');
});

test('double bottom: found when it breaks the neckline, and graded take profit vs stop as drawn', () => {
  const leg = (a, b, n) => [...Array(n)].map((_, i) => a + (b - a) * (i + 1) / n);
  const cs = [...leg(110, 100, 10), ...leg(100, 105, 6), ...leg(105, 100.2, 6), ...leg(100.2, 106, 6), ...leg(106, 112, 10), ...Array(20).fill(112)];
  const bars = cs.map((c, i) => ({ t: T0 + i * MIN, o: c, h: c + 0.05, l: c - 0.05, c, v: 1 })), ps = doublePatterns(bars, 60);
  const w = ps.find((p) => p.type === 'W');
  assert.ok(w, JSON.stringify(ps)); assert.ok(Math.abs(w.neckline - 105.05) < 0.2 && w.height > 4, JSON.stringify(w));
  assert.ok(bars[w.i].c > w.neckline && bars[w.i - 1].c <= w.neckline, 'the first close above the neckline');
  const st = patternStats(bars, 60);
  assert.equal(st.W.n, 1); assert.equal(st.W.win, 1, 'it ran to the take profit');
});

test('the "60% / 70% areas": on a fair random walk the ladder matches the bot\'s math, inside is a coin flip', () => {
  const bars = fromCloses(walk(40000, 9));
  const lad = rangeLadder(bars, 3), z = Object.fromEntries(lad.zones.map((x) => [x.zone, x]));
  assert.ok(lad.rounds > 2000);
  assert.ok(Math.abs(z.inside.hit - 0.5) < 0.12, JSON.stringify(z.inside));
  for (const k of ['far above', 'above', 'below', 'far below']) { assert.ok(z[k].n > 200 && z[k].hit > 0.5, k); assert.ok(Math.abs(z[k].hit - z[k].math) < 0.08, `${k}: ${z[k].hit} vs ${z[k].math}`); }
  assert.ok(z['far above'].hit > z.above.hit, 'further past the ceiling, more often up');
});

test('the live read for the Learn tab', () => {
  const cs = walk(200, 3), bars = fromCloses(cs), now = bars.at(-1).t + 2 * MIN;
  const L = lessonsNow(bars, now);
  for (const k of ['macd', 'ema', 'rsi']) assert.ok(L[k], k);
  assert.ok([-1, 0, 1].includes(L.macd.side) && L.rsi.v > 0 && L.rsi.v < 100);
  assert.equal(lessonsNow(bars.slice(0, 30), now), null, 'needs an hour of candles');
});
