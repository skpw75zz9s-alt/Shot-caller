import test from 'node:test';
import assert from 'node:assert/strict';
import { MICRO_FEATURES, microActive, microLearn, microOffset, microPredict, microRead, microSkill, microVector, newMicro } from '../public/micro.js';
import { createMicroFeed } from '../microfeed.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let seed = 9; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const rndFeatures = () => Object.fromEntries(MICRO_FEATURES.map((k) => [k, gauss() * 0.5]));

test('learns a real push (buyers lead the next minutes) and switches on only once it beats "no change"', () => {
  const M = newMicro();
  for (let i = 0; i < 3000; i++) {
    const x = microVector(rndFeatures()), yh = microPredict(M, x);
    for (const h of [1, 3, 5]) microLearn(M, h, x, 0.4 * x[1 + MICRO_FEATURES.indexOf('flow30')] + gauss(), yh[h]); // flow30 matters, the rest is noise
  }
  const m = M.models[5];
  assert.ok(microActive(m), `skill ${microSkill(m)}`);
  const wFlow = m.w[1 + MICRO_FEATURES.indexOf('flow30')];
  assert.ok(wFlow > 0.25 && wFlow < 0.55, `flow weight ${wFlow}`);
  const others = MICRO_FEATURES.filter((k) => k !== 'flow30').map((k) => Math.abs(m.w[1 + MICRO_FEATURES.indexOf(k)]));
  assert.ok(Math.max(...others) < 0.1, `noise weights stay small: ${others.map((v) => v.toFixed(2))}`);
  const r = microRead(M, microVector({ flow30: 1 }), { price: 100000, sigmaMin: 0.0008 });
  assert.ok(r.horizons[5].move > 50, `buyers in control: +$${r.horizons[5].move.toFixed(0)} in 5 min`);
  assert.equal(r.sway[0].key, 'flow30');
});

test('pure noise: never proves itself, so it never bends the candles', () => {
  const M = newMicro();
  for (let i = 0; i < 3000; i++) { const x = microVector(rndFeatures()), yh = microPredict(M, x); for (const h of [1, 3, 5]) microLearn(M, h, x, gauss(), yh[h]); }
  for (const h of [1, 3, 5]) assert.equal(microActive(M.models[h]), false, `h=${h} skill ${microSkill(M.models[h])}`);
  const r = microRead(M, microVector(rndFeatures()), { price: 100000, sigmaMin: 0.0008 });
  assert.deepEqual([1, 3, 5].map((h) => r.horizons[h].move), [0, 0, 0]);
});

test('the bend runs through the 1-, 3- and 5-minute moves, then holds', () => {
  const read = { horizons: { 1: { move: 10 }, 3: { move: 30 }, 5: { move: 20 } } };
  assert.equal(microOffset(read, 0.5), 5); assert.equal(microOffset(read, 2), 20); assert.equal(microOffset(read, 4), 25); assert.equal(microOffset(read, 9), 20);
  assert.equal(microOffset(null, 3), 0);
});

test('the server feed: samples every 10 s, grades each at its horizon, learns', async () => {
  let now = 1_800_000_000_000, price = 100000;
  const scanFeed = { spot: () => price, spotAt: () => price, imbalance: () => 0.5, lastScan: () => null };
  const mf = createMicroFeed({ file: join(mkdtempSync(join(tmpdir(), 'micro-')), 'micro.json'), scanFeed, clock: () => now, log: { error() {} } });
  await mf.load();
  const snap = { sigmaMin: 0.0008, live: null };
  for (let s = 0; s < 400; s++) { now += 1000; price += 0.3; mf.observe({ snap }, now); } // buyers in control, price creeping up
  const api = mf.api();
  assert.ok(api.read && api.read.horizons[1]);
  assert.ok(api.models[1].n >= 30 && api.models[5].n >= 10, JSON.stringify(api.models));
});
