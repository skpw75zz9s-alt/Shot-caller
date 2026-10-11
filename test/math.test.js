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
  assert.equal(oddsShift(50, mk, 1), probAbove(100050, 100000, 0.0008, 5) - probAbove(100000, 100000, 0.0008, 5), 'the nudge is the settlement odds\' own difference');
  // the settlement odds match the plain log-normal with the average's exact spread to within the averaging's own tiny
  // upward skew (an average of a random walk sits a hair above its median: ~1e-5 here)
  assert.ok(Math.abs(probAbove(100050, 100000, 0.0008, 5) - normCdf(Math.log(100050 / 100000) / Math.sqrt(settleVariance(0.0008, 5)))) < 1e-4);
  // the cone's chance above the target at the close is the settlement chance
  const now = Date.UTC(2026, 0, 1, 12, 10), close = now + 5 * 60000;
  const c = marketCone({ path: () => 100050, spot: 100000, sigmaMin: 0.0008, now, close, strike: 100000 }).summary;
  assert.ok(Math.abs(c.pAbove - normCdf(50 / (100000 * Math.sqrt(settleVariance(c.sig, 5))))) < 1e-9);
});
test('range to volatility uses the exact random-walk constant sqrt(8/pi)', () => {
  const now = 1e12, bars = Array.from({ length: 30 }, (_, i) => ({ t: now - (31 - i) * 60000, o: 1e5, c: 1e5, h: 1e5 + 80, l: 1e5 - 80 }));
  assert.ok(Math.abs(candleSigma(bars, 0.0008, now) - (160 / 1e5) / Math.sqrt(8 / Math.PI)) < 1e-12);
});

test('the settlement average: exact mean and spread, checked against brute force over all 60 x 60 print pairs', async () => {
  const { SETTLE } = await import('../public/model.js');
  const s = 0.0008, t = 3, a = s * s / 2, d = SETTLE.w / SETTLE.prints, tau = Array.from({ length: 60 }, (_, i) => t - 1 + (i + 1) * d);
  let m1 = 0, cov = 0;
  for (const x of tau) m1 += Math.exp(a * x);
  for (const x of tau) for (const y of tau) cov += Math.exp(a * (x + y)) * Math.expm1(s * s * Math.min(x, y));
  assert.ok(Math.abs(settleVariance(s, t) - Math.log1p(cov / (m1 * m1))) < 1e-15);
  // inside the last minute, the prints already made count at face value
  assert.ok(probAbove(100000, 100000, s, 0.3, 0, 1, 100040) > 0.999 && probAbove(100000, 100000, s, 0.3, 0, 1, 99960) < 0.001);
  assert.equal(probAbove(100000, 99999, s, 0), 1);
});
test('fees: each order\'s exact fee (rounded once per order) in the edges, the exits and the $10 records', async () => {
  const { feeEach, orderFee, pnl10, evaluate, DEFAULTS } = await import('../public/model.js');
  assert.equal(feeEach(0.5, 48), kalshiFee(0.5, 48) / 48);
  assert.ok(feeEach(0.5, 48) < kalshiFee(0.5), '48 contracts pay less each than a lone contract');
  assert.equal(pnl10(0.5, true), 20 * 0.5 - kalshiFee(0.5, 20));
  assert.equal(pnl10(0.37, false), -27 * 0.37 - kalshiFee(0.37, 27), '27 whole contracts for $10 at 37c');
  // the edge uses the fee of the order the bot would place
  const now = Date.UTC(2026, 0, 1, 12, 8), market = { ticker: 'T', strike_type: 'greater', floor_strike: 100000, open_time: new Date(now - 8 * 60000).toISOString(), close_time: new Date(now + 7 * 60000).toISOString(), yes_ask: 60, yes_bid: 58, no_ask: 42, no_bid: 40 };
  const ev = evaluate({ market, strike: 100000, spot: 100080, sigmaMin: 0.0008, now, settings: {} });
  assert.ok(Math.abs(ev.evYes - (ev.pYes - 0.6 - orderFee(0.6, ev.pYes, DEFAULTS))) < 1e-12);
});
test('calibration\'s standard error: one observation per round per bin, older rounds at their faded weight', async () => {
  const { learnWindow, newLearned } = await import('../public/learner.js');
  const L = newLearned();
  for (let r = 0; r < 50; r++) learnWindow(L, Array.from({ length: 10 }, () => 0.9), r % 10 ? 'yes' : 'no'); // 10 samples a round, one bin
  const b = L.cal.find((x) => x.n > 0), f = 0.9995;
  let n = 0, n2 = 0; for (let k = 0; k < 50; k++) { n += f ** k; n2 += f ** (2 * k); } // each round weighs 1, faded per round
  assert.ok(Math.abs(b.n - n) < 1e-9, `${b.n} vs ${n}`);
  assert.ok(Math.abs(b.n2 - n2) < 1e-9, 'each round is ONE observation of weight 1 (not 10 of weight 0.1)');
});

test('fees in exact integer arithmetic: the boundary cases floating point gets wrong', () => {
  assert.equal(kalshiFee(0.5, 4), 0.07, '0.07 x 4 x 0.25 = exactly 7c (floating point says 7.000000000000001)');
  assert.equal(kalshiFee(0.5, 48), 0.84); assert.equal(kalshiFee(0.57), 0.02); assert.equal(kalshiFee(0.01, 100), 0.07);
  assert.equal(kalshiFee(0.5, 10, true), 0.05, 'maker: 0.0175 x 10 x 0.25 = 4.375c, up to 5c');
  assert.equal(kalshiFee(0.5655, 10), Math.ceil(7 * 10 * 5655 * 4345 / 1e8 - 1e-12) / 100, 'sub-cent prices (4 decimals)');
  assert.equal(kalshiFee(0.5, 0), 0); assert.equal(kalshiFee(1, 5), 0);
});
test('the settlement odds are exact to a billionth: two prints left, against the exact one-dimensional integral', () => {
  // R = e^e1 (1 + e^e2): P(R > y) = E_e1[ P(e2 > ln(y e^-e1 - 1)) ], by a 40,000-point Simpson rule; at a volatility 25x
  // BTC's usual so the shape is as visible as it gets
  const s = 0.02, sd = s * Math.sqrt(1 / 60), t = 2 / 60 - 1e-9, S = 100000;
  for (const z of [-0.6, -0.2, 0, 0.3, 0.8]) {
    const K = S * (1 + z * sd), y = (60 * K - 58 * S) / S;
    let p = 0; const M = 40000;
    for (let i = 0; i <= M; i++) { const x = -12 + 24 * i / M, w = (i === 0 || i === M ? 1 : i % 2 ? 4 : 2) * (24 / M) / 3 * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); const r = y * Math.exp(-sd * x) - 1; p += w * (r <= 0 ? 1 : normCdf(-Math.log(r) / sd)); }
    assert.ok(Math.abs(probAbove(S, K, s, t) - p) < 1e-8, `z ${z}: ${probAbove(S, K, s, t)} vs exact ${p}`);
  }
});
test('hold odds: converged, within 3e-5 of a reference on a grid four times finer', async () => {
  const { holdExact } = await import('../public/model.js');
  const m = { ticker: 'T', strike_type: 'greater', floor_strike: 100000 };
  for (const [spot, ml, side] of [[100075, 9, 'YES'], [99850, 8, 'NO']]) {
    const a = { market: m, strike: 100000, sigmaMin: 0.0002, spot, minutesLeft: ml, side, floor: 0.8, stopMin: 1, confVol: 1.25 };
    const r16 = holdExact(a, 16), r32 = holdExact(a, 32), ref = r32 + (r32 - r16) / 3;
    assert.ok(Math.abs(holdOdds(a) - ref) < 3e-5, `${spot}: ${holdOdds(a)} vs ${ref}`);
  }
});
