import test from 'node:test';
import assert from 'node:assert/strict';
import { candle3, findPatterns, patternKeySignal, patternsNow, pivots, PATTERN_CANDIDATES } from '../public/chartpatterns.js';
import { CANDIDATES, FAMILY_NAMES } from '../public/tune.js';

const T0 = Date.UTC(2026, 9, 1);
// bars from a path of closes: each bar opens at the last close, a small wick either side
const fromPath = (ps, wick = 0.00005) => ps.map((c, i) => { const o = i ? ps[i - 1] : c; return { t: T0 + i * 60000, o, c, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick) }; });
// a quiet wiggle to warm up the typical move (60+ minutes), then the shape
const warm = (n = 80, p = 100000) => [...Array(n)].map((_, i) => p * (1 + 0.0003 * Math.sin(i * 1.3)));
const ramp = (a, b, n) => [...Array(n)].map((_, i) => a + (b - a) * (i + 1) / n);

test('head and shoulders: confirmed on the first close through the neckline, never before', () => {
  const p0 = 100000, w = warm(80, p0);
  // left shoulder, head, right shoulder (each up 8 minutes, down 8), then a break under the neckline
  const path = [...w, ...ramp(p0, p0 * 1.004, 8), ...ramp(p0 * 1.004, p0 * 1.001, 8), ...ramp(p0 * 1.001, p0 * 1.007, 8), ...ramp(p0 * 1.007, p0 * 1.001, 8),
    ...ramp(p0 * 1.001, p0 * 1.0041, 8), ...ramp(p0 * 1.0041, p0 * 1.0012, 8), ...ramp(p0 * 1.0012, p0 * 0.997, 6), ...ramp(p0 * 0.997, p0 * 0.996, 6)];
  const bars = fromPath(path), hs = findPatterns(bars, ['hs']).filter((e) => e.name === 'Head and shoulders');
  assert.equal(hs.length, 1, JSON.stringify(findPatterns(bars, ['hs']).map((e) => e.name)));
  assert.equal(hs[0].dir, -1); assert.equal(hs[0].lines.length, 3);
  assert.ok(bars[hs[0].i].c < p0 * 1.001 && bars[hs[0].i - 1].c >= p0 * 1.0009, 'the confirming candle is the first close under the neckline');
  assert.ok(hs[0].target < bars[hs[0].i].c, 'measured target: the head\'s height below the neckline');
});

test('an ascending triangle (flat top, rising lows) breaking up', () => {
  const p0 = 100000, top = p0 * 1.003, path = [...warm(80, p0)];
  let low = p0 * 0.998;
  for (let k = 0; k < 4; k++) { path.push(...ramp(path.at(-1), top, 6), ...ramp(top, low, 6)); low += p0 * 0.0006; }
  path.push(...ramp(path.at(-1), top * 1.002, 5), ...ramp(top * 1.002, top * 1.003, 4));
  const tri = findPatterns(fromPath(path), ['triangle']);
  assert.ok(tri.some((e) => e.shape === 'asc' && e.dir === 1), JSON.stringify(tri.map((e) => [e.name, e.shape])));
});

test('a bull flag: a sharp move, a tight pause, a break up', () => {
  const p0 = 100000, path = [...warm(80, p0), ...ramp(p0, p0 * 1.006, 6)];
  for (let i = 0; i < 8; i++) path.push(p0 * (1.0055 - 0.0002 * (i % 3)));
  path.push(p0 * 1.0068, p0 * 1.0072);
  const f = findPatterns(fromPath(path), ['flag']);
  assert.equal(f[0]?.name, 'Bull flag breakout'); assert.equal(f[0].dir, 1);
});

test('three-candle patterns', () => {
  const b = (o, c, h = Math.max(o, c) + 0.2, l = Math.min(o, c) - 0.2) => ({ o, c, h, l });
  assert.equal(candle3(b(110, 100), b(99.5, 99.8), b(100, 107))?.name, 'Morning star');
  assert.equal(candle3(b(100, 110), b(110.5, 110.2), b(110, 103))?.name, 'Evening star');
  assert.equal(candle3(b(100, 103), b(101, 106), b(104, 109))?.name, 'Three white soldiers');
  assert.equal(candle3(b(109, 106), b(108, 103), b(105, 100))?.name, 'Three black crows');
  assert.equal(candle3(b(1, 1.1), b(110, 100), b(98, 106))?.name, 'Piercing line');
});

test('no peeking: the patterns found on the first part of the history are exactly the ones the full history finds there', () => {
  let s = 3; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const ps = [100000]; for (let i = 1; i < 1500; i++) ps.push(ps.at(-1) * Math.exp(0.0009 * (r() + r() + r() - 1.5) * 2));
  const all = fromPath(ps, 0.0002), full = findPatterns(all);
  for (const cut of [400, 900, 1300]) {
    const part = findPatterns(all.slice(0, cut)).map((e) => `${e.i}|${e.name}`);
    assert.deepEqual(part, full.filter((e) => e.i < cut).map((e) => `${e.i}|${e.name}`), `cut at ${cut}`);
  }
  assert.ok(full.length > 20, `${full.length} patterns in 1,500 random minutes`);
  // pivots only become known k candles later
  for (const x of pivots(all).hi) assert.equal(x.known, x.i + 3);
});

test('each kind of pattern is a candidate in the indicator test, held 3 or 8 minutes', () => {
  assert.equal(PATTERN_CANDIDATES.length, 10);
  for (const c of PATTERN_CANDIDATES) { assert.ok(CANDIDATES.includes(c)); assert.ok(FAMILY_NAMES[c.family]); }
  const p0 = 100000, path = [...warm(80, p0), ...ramp(p0, p0 * 1.006, 6)];
  for (let i = 0; i < 8; i++) path.push(p0 * (1.0055 - 0.0002 * (i % 3)));
  path.push(p0 * 1.0068, p0 * 1.0072, p0 * 1.0072, p0 * 1.0072, p0 * 1.0072);
  const sig = patternKeySignal(fromPath(path), 'flag', 3), on = sig.map((v, i) => [v, i]).filter(([v]) => v);
  assert.equal(on.length, 3); assert.ok(on.every(([v]) => v === 1));
  const now = patternsNow(fromPath(path));
  assert.ok(now.recent.some((e) => e.key === 'flag'));
});
