import test from 'node:test';
import assert from 'node:assert/strict';
import { stability } from '../public/analysis.js';

const NOW = 1_700_000_000_000;
// 1-minute bars ending just before NOW; `big` makes one of the last few candles a shock
const bars = (n = 60, big = 0) => [...Array(n)].map((_, i) => {
  const t = NOW - (n - i) * 60000, r = i === n - 3 ? big || 10 : 10;
  return { t, o: 100000, c: 100002, h: 100000 + r / 2, l: 100000 - r / 2 };
});
const log = (ps, asks = []) => ps.map((p, i) => ({ t: NOW - (ps.length - i) * 2000, p, yesAsk: asks[i] ?? 0.5, noAsk: 0.5 }));

test('stable: normal volatility, no shocks, steady odds', () => {
  const s = stability({ bars: bars(), sigmaMin: 0.0005, sigmaLong: 0.0005, log: log(Array(30).fill(0.8)), now: NOW });
  assert.equal(s.level, 'stable'); assert.equal(s.score, 100); assert.deepEqual(s.parts, []);
});

test('unstable: volatility spike, a shock candle and the odds whipsawing', () => {
  const ps = [...Array(30)].map((_, i) => (i % 3 ? 0.65 : 0.35));
  const s = stability({ bars: bars(60, 80), sigmaMin: 0.0011, sigmaLong: 0.0005, log: log(ps), now: NOW });
  assert.equal(s.level, 'unstable');
  assert.ok(s.score < 45, String(s.score));
  assert.ok(s.parts.some((p) => /Volatility 2\.2×/.test(p.label)));
  assert.ok(s.parts.some((p) => /8\.0× candle/.test(p.label)));
  assert.ok(s.parts.some((p) => /crossed 50\/50/.test(p.label)));
});

test('moderate: one thing off', () => {
  const s = stability({ bars: bars(60, 45), sigmaMin: 0.0008, sigmaLong: 0.0005, now: NOW });
  assert.equal(s.level, 'moderate', JSON.stringify(s));
});

test('Kalshi price jumps and a busier time of week count too; not enough candles is unknown', () => {
  const s = stability({ bars: bars(), sigmaMin: 0.0005, sigmaLong: 0.0005, log: log(Array(12).fill(0.7), [0.5, 0.6, 0.5, 0.62, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), now: NOW, aheadFactor: 1.5 });
  assert.ok(s.parts.some((p) => /jumped 4 times/.test(p.label)));
  assert.ok(s.parts.some((p) => /1\.5× busier/.test(p.label)));
  assert.equal(stability({ bars: bars(10), now: NOW }).level, 'unknown');
});
