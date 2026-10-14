import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf } from '../public/model.js';
import { CROSS, closeMap, crossShift, dataset, evaluate, invNorm, relation } from '../public/cross.js';
import { createCrossFeed } from '../crossfeed.js';
import { ASSETS } from '../public/markets.js';

const T0 = Date.UTC(2026, 9, 1), MIN = 60000;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; }
// minutes of two assets: B is a random walk; A follows B's last minute by `lead` (plus its own noise) and moves with it by beta
function pair(n, { lead = 0, beta = 1, seed = 3 } = {}) {
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  const A = [], B = []; let a = 100, b = 100, prevB = 0;
  for (let i = 0; i < n; i++) {
    const rb = 0.001 * g(), ra = beta * rb + lead * prevB + 0.0006 * g();
    b *= Math.exp(rb); a *= Math.exp(ra); prevB = rb;
    A.push({ t: T0 + i * MIN, c: a }); B.push({ t: T0 + i * MIN, c: b });
  }
  return { A: closeMap(A), B: closeMap(B) };
}

test('the model finds a real lead (A follows what B just did) and proves it on minutes it never trained on', () => {
  const { A, B } = pair(9000, { lead: 0.6 });
  const { X, y } = dataset({ A, B }, 'A', ['B']);
  const ev = evaluate(X, y);
  assert.equal(ev.proven, true, JSON.stringify(ev)); assert.ok(ev.gain > CROSS.minGain && ev.z > CROSS.z);
});

test('no lead, no proof: moving together isn\'t predicting', () => {
  const { A, B } = pair(9000, { lead: 0, beta: 1.2, seed: 11 });
  const ev = evaluate(...Object.values(dataset({ A, B }, 'A', ['B'])).slice(0, 2));
  assert.equal(ev.proven, false, JSON.stringify(ev));
});

test('correlation and beta between two markets, minute by minute', () => {
  const { A, B } = pair(3000, { beta: 1.2, seed: 5 });
  const r = relation({ A, B }, 'A', 'B', T0 + 2999 * MIN, 3000);
  assert.ok(Math.abs(r.beta - 1.2) < 0.08, String(r.beta)); assert.ok(r.rho > 0.85 && r.rho < 1, String(r.rho));
  assert.equal(relation({ A, B: new Map() }, 'A', 'B', T0 + 2999 * MIN).rho, null, 'no overlap: nothing claimed');
});

test('an expected move becomes a capped shift to the odds, the right way for each kind of market', () => {
  for (const p of [0.01, 0.2, 0.5, 0.83, 0.999]) assert.ok(Math.abs(normCdf(invNorm(p)) - p) < 1e-9, String(p));
  const up = crossShift({ pYes: 0.5, mu5: 0.00005, sigmaMin: 0.0005, minutesLeft: 5 });
  assert.ok(up > 0 && up < CROSS.cap); assert.ok(Math.abs(up - (normCdf(0.1 / Math.sqrt(5)) - 0.5)) < 1e-9, 'drift / (sigma sqrt t) in z');
  assert.ok(crossShift({ pYes: 0.5, mu5: 0.00005, sigmaMin: 0.0005, minutesLeft: 5, strikeType: 'less' }) < 0, 'a below-the-target market moves the other way');
  assert.equal(crossShift({ pYes: 0.5, mu5: 0.05, sigmaMin: 0.0005, minutesLeft: 5 }), CROSS.cap, 'capped');
  assert.ok(Math.abs(crossShift({ pYes: 0.5, mu5: 0.00005, sigmaMin: 0.0005, minutesLeft: 12 }) - (normCdf(0.00005 / (0.0005 * Math.sqrt(12))) - 0.5)) < 1e-9, 'at most 5 minutes of the move');
});

test('the server reader: every market sees the others, and nudges only once proven', async () => {
  const keys = ASSETS.map((a) => a.key), { A, B } = pair(9000, { lead: 0.6, seed: 21 }), noise = pair(9000, { seed: 33 });
  const series = Object.fromEntries(keys.map((k) => [k, k === 'ETH' ? A : k === 'BTC' ? B : noise.B]));
  const now = T0 + 8999 * MIN, feed = createCrossFeed({ prices: { candleRows: async () => [] }, clock: () => now, log: { warn() {} } });
  for (const k of keys) feed.merge(k, [...series[k]].map(([t, c]) => ({ t, c })));
  feed.refit(now);
  const eth = feed.api('ETH', now);
  assert.equal(eth.related.length, keys.length - 1); assert.equal(eth.related[0].key, 'BTC', 'its strongest relation first');
  assert.equal(eth.model.proven, true); assert.equal(feed.api('SPX', now).model.proven, false, 'noise proves nothing');
  const snap = { sigmaMin: 0.0007, rows: [{ m: { ticker: 'KXETH15M-X', strike_type: 'greater_or_equal' }, ev: { minutesLeft: 8, pYes: 0.55 }, pPre: 0.55, sigma: 0.0007 }] };
  feed.observe('ETH', { snap }, now); feed.observe('SPX', { snap }, now);
  const sh = feed.shifts('ETH', now);
  assert.ok(sh && Math.abs(sh['KXETH15M-X']) > 0 && Math.abs(sh['KXETH15M-X']) <= CROSS.cap, JSON.stringify(sh));
  assert.equal(feed.shifts('SPX', now), null, 'unproven: shown, never used');
});
