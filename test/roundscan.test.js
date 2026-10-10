import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRound, scanRecord, leadLag } from '../public/roundscan.js';

const OPEN = 1_700_000_000_000;
const trade = (ex, s, side, price, size = 0.5) => ({ t: OPEN + s * 1000, ex, side, price, size });

test('buyers on every exchange, prices up, size on the buy side: strong buyers', () => {
  const ts = [];
  for (let i = 0; i < 240; i++) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US']) ts.push(trade(ex, i, i % 4 ? 'buy' : 'sell', 100000 + i * 0.5, i === 200 ? 1 : 0.2));
  const sc = scanRound(ts, { openTime: OPEN, now: OPEN + 241000 });
  assert.equal(sc.ready, true); assert.equal(sc.exchanges, 5);
  assert.ok(sc.score >= 40, String(sc.score)); assert.equal(sc.verdict, 'Strong buyers'); assert.equal(sc.lean, 'YES');
  assert.equal(sc.upPrice, 5);
  assert.ok(Math.abs(sc.buyShare - 0.75) < 0.05);
  const cb = sc.rows.find((r) => r.ex === 'Coinbase');
  assert.ok(cb.net > 0 && cb.change > 0 && cb.vwap > 100000);
});

test('split exchanges and flat prices: mixed, no lean; nothing traded yet: not ready', () => {
  const ts = [];
  for (let i = 0; i < 120; i++) { ts.push(trade('Coinbase', i, 'buy', 100000)); ts.push(trade('Kraken', i, 'sell', 100000)); }
  const sc = scanRound(ts, { openTime: OPEN, now: OPEN + 121000 });
  assert.equal(sc.verdict, 'Mixed'); assert.equal(sc.lean, null);
  assert.equal(scanRound([], { openTime: OPEN, now: OPEN + 1000 }).ready, false);
  assert.equal(scanRound([trade('Coinbase', -5, 'buy', 1)], { openTime: OPEN, now: OPEN + 1000 }).ready, false, 'trades before the open do not count');
});

test('leader: the exchange whose moves come first', () => {
  const ts = [];
  let p = 100000;
  const path = [];
  for (let i = 0; i < 300; i++) { p += Math.sin(i * 1.7) * 6 + Math.cos(i * 0.31) * 4; path.push(p); }
  for (let i = 0; i < 300; i++) {
    ts.push(trade('Kraken', i, 'buy', path[i]));
    for (const ex of ['Coinbase', 'Bitstamp', 'Gemini']) ts.push(trade(ex, i, 'buy', path[Math.max(0, i - 2)])); // 2 seconds behind
  }
  assert.equal(leadLag(ts, OPEN, OPEN + 300000)?.ex, 'Kraken');
});

test('record: how often the lean matched the result', () => {
  const r = scanRecord([{ lean: 'YES', score: 60, result: 'yes' }, { lean: 'NO', score: -20, result: 'yes' }, { lean: null, score: 3, result: 'no' }, { lean: 'YES', score: 30 }]);
  assert.deepEqual(r, { graded: 2, right: 1, strong: 1, strongRight: 1, mixed: 1 });
});

// ---------- v9.1: absorption, leader edge, scan chance, learning, the honest record ----------
import { featureVector, fitScan, fitModels, scanChance, scanStats, checkpointFor, MIN_SAMPLES } from '../public/roundscan.js';
import { createScanFeed } from '../scanfeed.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('absorption: heavy selling for 3 minutes that does not push the price down reads bullish', () => {
  const ts = [];
  for (let i = 0; i < 600; i++) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp']) ts.push(trade(ex, i, i >= 420 ? (i % 5 ? 'sell' : 'buy') : (i % 2 ? 'buy' : 'sell'), 100000 + (i >= 420 ? 2 : 0), 0.3));
  const sc = scanRound(ts, { openTime: OPEN, now: OPEN + 600000, sigmaMin: 0.0008 });
  assert.ok(sc.absorption.imb3 < -0.4, String(sc.absorption.imb3));
  assert.ok(sc.features.absorb > 0.5, String(sc.features.absorb));
  assert.ok(sc.parts.find((p) => p.name === 'Absorption').pts > 5);
  // the same selling with the price falling hard: the flow is getting its way, no absorption
  const fall = ts.map((x) => ({ ...x, price: x.t >= OPEN + 420000 ? 100000 - (x.t - OPEN - 420000) / 1000 * 1.5 : x.price }));
  assert.equal(scanRound(fall, { openTime: OPEN, now: OPEN + 600000, sigmaMin: 0.0008 }).features.absorb, 0);
});

test('leader edge: the leading exchange has just moved above the pack', () => {
  const ts = [];
  let p = 100000;
  const path = [];
  for (let i = 0; i < 300; i++) { p += Math.sin(i * 1.7) * 6 + Math.cos(i * 0.31) * 4; path.push(p); }
  path[299] = path[298] + 60; path[298] += 40; // a jump on the leader in the last seconds
  for (let i = 0; i < 300; i++) {
    ts.push(trade('Kraken', i, 'buy', path[i]));
    for (const ex of ['Coinbase', 'Bitstamp', 'Gemini']) ts.push(trade(ex, i, 'buy', path[Math.max(0, i - 2)]));
  }
  const sc = scanRound(ts, { openTime: OPEN, now: OPEN + 300000, sigmaMin: 0.0008 });
  assert.equal(sc.leader?.ex, 'Kraken');
  assert.ok(sc.leader.edge > 30 && sc.features.leader > 0.2, JSON.stringify(sc.leader));
});

test('features point toward YES, flipped for "below the target" markets', () => {
  const sc = { features: { flow: 0.5, agree: 1, momentum: 0, big: -1, absorb: 0.2, leader: 0 } };
  assert.deepEqual(featureVector(sc, 'greater'), [0.5, 1, 0, -1, 0.2, 0]);
  assert.deepEqual(featureVector(sc, 'less'), [-0.5, -1, -0, 1, -0.2, -0]);
  assert.equal(checkpointFor(12), 10); assert.equal(checkpointFor(6), 6); assert.equal(checkpointFor(2), 3);
});

test('learning: weights grow only for reads that really predict, and the scan chance uses them', () => {
  let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const samples = [];
  for (let i = 0; i < 1500; i++) {
    const x = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, 0, 0, 0], pModel = 0.2 + rnd() * 0.6;
    const z = Math.log(pModel / (1 - pModel)) + 1.5 * x[0]; // only flow matters
    samples.push({ cp: 6, x, pModel, y: rnd() < 1 / (1 + Math.exp(-z)) ? 1 : 0 });
  }
  const w = fitScan(samples);
  assert.ok(w[0] > 1 && w[0] < 2, `flow weight ${w[0]}`);
  assert.ok(Math.abs(w[1]) < 0.3 && Math.abs(w[2]) < 0.3, `noise weights ${w}`);
  const models = fitModels(samples);
  assert.equal(models[6].active, true); assert.equal(models[10].active, false);
  const up = scanChance(0.6, [1, 0, 0, 0, 0, 0], models, 6);
  assert.ok(up.active && up.p > 0.75, String(up.p));
  assert.deepEqual(scanChance(0.6, [1, 0, 0, 0, 0, 0], models, 12), { p: 0.6, active: false, pModel: 0.6 }, 'no weights yet at 10 minutes: the bot alone');
  assert.ok(MIN_SAMPLES <= 1500);
});

test('record: Brier scores for the bot, the scan and Kalshi, and whether the scan helped', () => {
  const s = [
    { cp: 6, y: 1, pModel: 0.6, pScan: 0.8, kalshi: 0.65, active: true, lean: 'YES', score: 50 },
    { cp: 6, y: 0, pModel: 0.4, pScan: 0.2, kalshi: 0.35, active: true, lean: 'NO', score: -20 },
    { cp: 6, y: 1, pModel: 0.5, pScan: 0.5, kalshi: null, active: false, lean: 'NO', score: -30 },
    { cp: 3, y: null, pModel: 0.5, pScan: 0.5 },
  ];
  const r = scanStats(s);
  assert.equal(r[6].n, 3); assert.equal(r[6].leaned, 3); assert.equal(r[6].right, 2); assert.equal(r[6].strongRight, 1);
  assert.ok(Math.abs(r[6].bot - (0.16 + 0.16 + 0.25) / 3) < 1e-9);
  assert.ok(r[6].skill > 0.7, 'the scan beat the bot on the rounds it was used');
  assert.equal(r[3].n, 0);
});

test('server scan: samples at the checkpoints, graded when Kalshi settles, learned and served', async () => {
  let now = OPEN + 5 * 60000;
  const feed = createScanFeed({ file: join(mkdtempSync(join(tmpdir(), 'scan-')), 'scan.json'), clock: () => now, log: { error() {} } });
  await feed.load();
  const market = { ticker: 'KXBTC15M-T1', open_time: new Date(OPEN).toISOString(), close_time: new Date(OPEN + 15 * 60000).toISOString(), strike_type: 'greater', yes_bid: 55, yes_ask: 57 };
  const snap = (mLeft) => ({ sigmaMin: 0.0008, live: { m: market, ev: { minutesLeft: mLeft, pYes: 0.58 } } });
  const ts = [];
  for (let i = 0; i < 300; i++) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp']) ts.push(trade(ex, i, i % 3 ? 'buy' : 'sell', 100000 + i * 0.2));
  feed.add(ts);
  feed.observe({ snap: snap(10), known: new Map() }, now);
  assert.equal(feed.data().samples.length, 1);
  assert.equal(feed.data().samples[0].cp, 10);
  assert.equal(feed.data().samples[0].kalshi, 0.56);
  feed.observe({ snap: snap(9.9), known: new Map() }, (now += 5000));
  assert.equal(feed.data().samples.length, 1, 'one sample per checkpoint');
  const api = feed.api();
  assert.equal(api.live.sc.ready, true); assert.equal(api.live.chance.active, false); assert.equal(api.feeds.Kraken, 'live');
  assert.equal(api.live.sc.rows.length, 5);
  feed.observe({ snap: { live: null }, known: new Map([['KXBTC15M-T1', 'yes']]) }, (now += 600000));
  assert.equal(feed.data().samples[0].y, 1);
  assert.equal(feed.api().record[10].n, 1);
  feed.stop();
});

test('server scan: no samples while fewer than 3 exchanges stream', async () => {
  const now = OPEN + 5 * 60000;
  const feed = createScanFeed({ file: join(mkdtempSync(join(tmpdir(), 'scan-')), 'scan.json'), clock: () => now });
  await feed.load();
  feed.add(Array.from({ length: 200 }, (_, i) => trade('Coinbase', i, 'buy', 100000)));
  feed.observe({ snap: { sigmaMin: 0.0008, live: { m: { ticker: 'T', open_time: new Date(OPEN).toISOString(), close_time: new Date(OPEN + 900000).toISOString() }, ev: { minutesLeft: 10, pYes: 0.5 } } }, known: new Map() }, now);
  assert.equal(feed.data().samples.length, 0);
  assert.equal(feed.api().live.sc.ready, true, 'still scans and shows');
});
