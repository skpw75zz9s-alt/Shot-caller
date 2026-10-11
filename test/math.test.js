import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, holdOdds, contractsFor, kalshiFee, oddsShift, settleVariance, probAbove } from '../public/model.js';
import { normInv, splitCdf, splitQuantile, blendWeights, candleSigma, marketCone } from '../public/predict.js';

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
test('normal CDF to full precision, tails included (reference values)', () => {
  const ref = [[0, 0.5], [-1, 0.15865525393145707], [0.5, 0.6914624612740131], [1.959963984540054, 0.975], [-3, 0.0013498980316300946],
    [3.5, 0.9997673709209645], [-5, 2.866515718791939e-7], [-10, 7.619853024160527e-24], [-20, 2.7536241186062337e-89]];
  for (const [x, v] of ref) assert.ok(rel(normCdf(x), v) < 1e-12, `${x}: ${normCdf(x)} vs ${v}`);
  for (let x = -6; x <= 6; x += 0.37) assert.ok(Math.abs(normCdf(x) + normCdf(-x) - 1) < 1e-15, 'symmetric');
});
test('inverse normal CDF exactly inverts it, deep into the tails', () => {
  for (const p of [1e-15, 1e-10, 1e-4, 0.025, 0.25, 0.5, 0.75, 0.975, 1 - 1e-10]) {
    const x = normInv(p), back = normCdf(x);
    assert.ok(rel(Math.min(back, 1 - back), Math.min(p, 1 - p)) < 1e-9, `${p}: ${x}`);
  }
  assert.ok(Math.abs(normInv(0.975) - 1.959963984540054) < 1e-14);
  assert.equal(normInv(0), -Infinity); assert.equal(normInv(1), Infinity);
});
test('split normal: the quantile is the exact inverse of the CDF; symmetric is the normal', () => {
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.6, 0.95, 0.99]) assert.ok(Math.abs(splitCdf(splitQuantile(q, 100, 10, 25), 100, 10, 25) - q) < 1e-12);
  assert.ok(Math.abs(splitQuantile(0.95, 0, 1, 1) - 1.6448536269514722) < 1e-12);
  assert.ok(Math.abs(splitCdf(100, 100, 10, 30) - 0.75) < 1e-12, 'a 30/10 split puts 3/4 of the mass below the centre');
});
test('hold odds: deterministic, and matches a 40,000-path simulation of the same model', () => {
  const m = { ticker: 'T', strike_type: 'greater', floor_strike: 100000 };
  const o = { market: m, strike: 100000, sigmaMin: 0.0002 };
  // reference values from 40,000 simulated paths each (95% intervals about +-0.005, +-0.002, +-0.0015)
  for (const [x, ref, tol] of [[{ spot: 100075, minutesLeft: 9, side: 'YES' }, 0.447, 0.008], [{ spot: 100150, minutesLeft: 9, side: 'YES' }, 0.9683, 0.004], [{ spot: 99850, minutesLeft: 8, side: 'NO' }, 0.9771, 0.003]]) {
    const v = holdOdds({ ...o, ...x });
    assert.ok(Math.abs(v - ref) < tol, `${JSON.stringify(x)}: ${v} vs ${ref}`);
    assert.equal(holdOdds({ ...o, ...x }), v, 'same inputs, same answer');
  }
  assert.ok(holdOdds({ ...o, spot: 100150, minutesLeft: 9, side: 'YES' }) > holdOdds({ ...o, spot: 100075, minutesLeft: 9, side: 'YES' }));
  assert.equal(holdOdds({ ...o, spot: 100000, minutesLeft: 0.5, side: 'YES' }), null, 'nothing left to hold through');
});
test('order sizing: Kalshi rounds the fee once per order, and the count is the most that fits the stake exactly', () => {
  const s = { bankroll: 1000, kellyFraction: 0.25, maxStake: 25 };
  const n = contractsFor(0.9, 0.5, s);
  assert.ok(n * 0.5 + kalshiFee(0.5, n) <= 25 + 1e-9, 'fits');
  assert.ok((n + 1) * 0.5 + kalshiFee(0.5, n + 1) > 25, 'one more would not');
  assert.equal(n, 48, '48 x 50c + $0.84 fee = $24.84 (charging every contract the 1-contract 2c fee would have allowed only 47)');
});
test('blend weights: inverse mean squared error (inverse-variance), not inverse squared average miss', () => {
  // same average miss, but one line's misses are erratic (bigger squared error): it gets less weight
  const w = blendWeights({ bot: { miss: 10, mse: 100, n: 10 }, kalshi: { miss: 10, mse: 400, n: 10 }, exch: null });
  assert.ok(Math.abs(w.bot / w.kalshi - 4) < 1e-12);
});
test('every nudge and implied price uses the settlement average\'s variance, like the bot\'s own odds', () => {
  const mk = { spot: 100000, strike: 100000, sigmaMin: 0.0008, minutesLeft: 5 };
  const sd = 100000 * Math.sqrt(settleVariance(0.0008, 5));
  assert.ok(Math.abs(oddsShift(50, mk, 1) - (normCdf(50 / sd) - 0.5)) < 1e-12);
  assert.ok(Math.abs(probAbove(100050, 100000, 0.0008, 5) - normCdf(Math.log(100050 / 100000) / Math.sqrt(settleVariance(0.0008, 5)))) < 1e-15);
  // the cone's chance above the target at the close is the settlement chance
  const now = Date.UTC(2026, 0, 1, 12, 10), close = now + 5 * 60000;
  const c = marketCone({ path: () => 100050, spot: 100000, sigmaMin: 0.0008, now, close, strike: 100000 }).summary;
  assert.ok(Math.abs(c.pAbove - normCdf(50 / (100000 * c.sig * Math.sqrt(settleVariance(1, 5))))) < 1e-9);
});
test('range to volatility uses the exact random-walk constant sqrt(8/pi)', () => {
  const now = 1e12, bars = Array.from({ length: 30 }, (_, i) => ({ t: now - (31 - i) * 60000, o: 1e5, c: 1e5, h: 1e5 + 80, l: 1e5 - 80 }));
  assert.ok(Math.abs(candleSigma(bars, 0.0008, now) - (160 / 1e5) / Math.sqrt(8 / Math.PI)) < 1e-12);
});
