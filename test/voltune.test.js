import test from 'node:test';
import assert from 'node:assert/strict';
import { VT, VT_BASE, logDensity, range90, tuneVolAsync, vtCandidates, vtLive } from '../public/voltune.js';
import { probYes } from '../public/model.js';
import { snapshot } from '../public/engine.js';
import { createVolTuneFeed } from '../voltunefeed.js';

const integrate = (f, a, b, n = 20000) => { let s = 0; const h = (b - a) / n; for (let i = 0; i <= n; i++) s += (i === 0 || i === n ? 0.5 : 1) * f(a + i * h); return s * h; };
function market(kind, days, seed = 3) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 2 ** 32; };
  const g = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const bars = []; let p = 80000, slow = 1;
  for (let i = 0; i < days * 1440; i++) {
    if (kind === 'jumps' && i % 30 === 0) slow = Math.exp(0.5 * g() - 0.125); // the volatility shifts every half hour, unseen
    const carry = kind === 'trend' && bars.length >= 15 ? 0.35 * Math.log(p / bars[bars.length - 15].c) / 15 : 0; // drift that carries
    p *= Math.exp(carry + 0.0008 * (kind === 'jumps' ? slow : 1) * g());
    bars.push({ t: 1.7e12 + i * 60000, o: p, h: p, l: p, c: p, v: 1 });
  }
  return bars;
}

test('fat tails: the same spread as the normal curve, more weight far out', () => {
  const sig = 0.001, h = 4, sd = sig * Math.sqrt(h);
  assert.ok(Math.abs(logDensity(0.0013, sig, h) - (-0.5 * Math.log(2 * Math.PI) - Math.log(sd) - 0.0013 ** 2 / (2 * sd * sd))) < 1e-12, 'no tails: the normal density');
  const f = (x) => Math.exp(logDensity(x, sig, h, 0.4));
  assert.ok(Math.abs(integrate(f, -30 * sd, 30 * sd) - 1) < 1e-6, 'a density');
  assert.ok(Math.abs(integrate((x) => x * x * f(x), -30 * sd, 30 * sd) / (sd * sd) - 1) < 1e-4, 'the same variance');
  assert.ok(integrate((x) => x ** 4 * f(x), -30 * sd, 30 * sd) / sd ** 4 > 3.5, 'fatter tails than the normal curve (kurtosis 3)');
  // the 90% range: 1.645 sd without tails; with them, the move size that really has a 10% chance of being beaten
  assert.ok(Math.abs(range90(sig, h) / sd - 1.6448536269514722) < 1e-5);
  const r = range90(sig, h, 0.4);
  assert.ok(Math.abs(integrate(f, -r, r) - 0.9) < 1e-4, `${integrate(f, -r, r)}`);
});

test('the bot\'s odds with fat tails: unchanged at the target, less sure of a big lead, a little surer of a modest one', () => {
  const m = { strike_type: 'greater', floor_strike: 100000 };
  assert.ok(Math.abs(probYes(m, 100000, 100000, 0.0008, 10, 0, null, 0.3) - probYes(m, 100000, 100000, 0.0008, 10, 0)) < 2e-3, 'at the target');
  const big = probYes(m, 100000, 100600, 0.0008, 10, 0), bigT = probYes(m, 100000, 100600, 0.0008, 10, 0, null, 0.3);
  assert.ok(big > 0.99 && bigT < big, `big lead ${big} -> ${bigT}`);
  const mod = probYes(m, 100000, 100150, 0.0008, 10, 0), modT = probYes(m, 100000, 100150, 0.0008, 10, 0, null, 0.3);
  assert.ok(modT > mod && modT - mod < 0.05, `modest lead ${mod} -> ${modT}`);
  const lead = probYes(m, 100000, 100300, 0.0008, 10, 0);
  assert.equal(probYes(m, 100000, 100300, 0.0008, 10, 0, null, 0), lead, 'no tails: exactly as before');
});

test('the tuner: finds the fat tails a market really has and proves them out of sample; the standard setting is in the grid', async () => {
  assert.equal(vtCandidates().length, VT.lambdas.length * VT.floors.length * VT.scales.length * VT.tails.length);
  assert.ok(vtCandidates().some((k) => k.lambda === VT_BASE.lambda && k.floor === VT_BASE.floor && k.scale === VT_BASE.scale && k.tails === VT_BASE.tails));
  const r = await tuneVolAsync(market('jumps', 12));
  assert.ok(r.proven && r.pick.tails > 0 && r.z >= VT.z, JSON.stringify({ z: r.z, pick: r.pick }));
  assert.ok(Math.abs(r.held90.tuned - 0.9) < Math.abs(r.held90.base - 0.9), 'its 90% range is closer to 90%');
  assert.deepEqual(vtLive(r), { use: true, ...r.pick, gain: r.gain, z: r.z, drift: null }, 'no momentum in a market without any');
  assert.equal(r.drift.proven, false);
  assert.deepEqual(vtLive({ ...r, proven: false }), { use: false, drift: null }, 'unproven: standard settings');
  assert.deepEqual(vtLive({ ...r, pick: VT_BASE }), { use: false, drift: null });
});

test('the engine prices with the proven settings, and only when learning is on', () => {
  const now = 1.7e12 + 200 * 60000, candles = market('none', 1).slice(0, 200).map((b, i) => ({ ...b, t: 1.7e12 + i * 60000 }));
  const markets = [{ ticker: 'X', strike_type: 'greater', floor_strike: candles.at(-1).c - 40, open_time: new Date(now - 5 * 60000).toISOString(), close_time: new Date(now + 10 * 60000).toISOString(), yes_bid: 60, yes_ask: 62, no_bid: 38, no_ask: 40 }];
  const learned = { basis: [], volByHour: {}, cal: {}, volTune: { use: true, lambda: 0.94, floor: 0.6, scale: 1.2, tails: 0.3 } };
  const base = snapshot({ markets, candles, spot: candles.at(-1).c, settings: { learn: false }, now });
  const tuned = snapshot({ markets, candles, spot: candles.at(-1).c, settings: {}, learned, now });
  assert.ok(Math.abs(tuned.sigmaMin / base.sigmaMin - 1.2) < 1e-9, 'scaled');
  assert.equal(tuned.volTails, 0.3); assert.equal(base.volTails, 0);
  const off = snapshot({ markets, candles, spot: candles.at(-1).c, settings: { learn: false }, learned, now });
  assert.equal(off.sigmaMin, base.sigmaMin, 'learning off: standard settings');
});

test('the feed: reruns hourly without blocking, and serves only a proven pick', async () => {
  let t = 0; const bars = market('jumps', 8);
  const feed = createVolTuneFeed({ playbook: { bars: () => bars }, clock: () => t, log: { error() {} } });
  assert.deepEqual(feed.live(), { use: false, drift: null }, 'nothing run yet');
  await feed.rerun();
  const r = feed.api().report;
  assert.equal(r.bars, bars.length); assert.equal(feed.live().use, r.proven && !(r.pick.lambda === 0.94 && r.pick.floor === 0.6 && r.pick.scale === 1 && r.pick.tails === 0));
  const short = createVolTuneFeed({ playbook: { bars: () => bars.slice(0, 100) }, clock: () => t });
  await short.rerun(); assert.equal(short.api().report, null, 'too little history: no report');
});

test('momentum: found and proven where drift really carries, and the engine carries it (unless you set your own weight)', async () => {
  const r = await tuneVolAsync(market('trend', 10));
  assert.ok(r.drift.proven && r.drift.pick.w > 0, JSON.stringify(r.drift));
  const live = vtLive(r);
  assert.deepEqual(live.drift, { ...r.drift.pick, gain: r.drift.gain, z: r.drift.z });
  const now = 1.7e12 + 200 * 60000, candles = market('trend', 1).slice(0, 200).map((b, i) => ({ ...b, t: 1.7e12 + i * 60000 }));
  const markets = [{ ticker: 'X', strike_type: 'greater', floor_strike: candles.at(-1).c, open_time: new Date(now - 5 * 60000).toISOString(), close_time: new Date(now + 10 * 60000).toISOString(), yes_bid: 50, yes_ask: 52, no_bid: 48, no_ask: 50 }];
  const learned = { basis: [], volByHour: {}, cal: {}, volTune: { use: false, drift: { n: 15, w: 0.4, gain: 0.01, z: 3 } } };
  const on = snapshot({ markets, candles, spot: candles.at(-1).c, settings: {}, learned, now });
  assert.equal(on.momentumWeight, 0.4); assert.equal(on.sigmaMin, snapshot({ markets, candles, spot: candles.at(-1).c, settings: { learn: false }, now }).sigmaMin, 'volatility untouched');
  const c = on.bars.map((b) => b.c); assert.ok(Math.abs(on.driftMin - Math.log(c.at(-1) / c.at(-16)) / 15) < 1e-12, 'the 15-minute drift (live bar included, as always)');
  const mine = snapshot({ markets, candles, spot: candles.at(-1).c, settings: { momentumWeight: 0.2 }, learned, now });
  assert.equal(mine.momentumWeight, 0.2, 'your own weight wins');
});
