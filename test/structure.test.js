import test from 'node:test';
import assert from 'node:assert/strict';
import { dayVwap, fairValueGaps, findShift, findSweep, orderBlocks, structureRead, swings, volumeDivergence } from '../public/structure.js';
import { backtest, scorecard } from '../public/playbook.js';
import { createPlaybook } from '../playbookfeed.js';
import { createDetector } from '../public/watch.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = Date.UTC(2026, 0, 1);
const bar = (i, o, h, l, c, v = 10) => ({ t: T0 + i * 60000, o, h, l, c, v });
const flat = (i, p, v = 10, w = 1) => bar(i, p, p + w, p - w, p, v);
// a zigzag: up 4 bars, down 4 bars (clear swings)
const zig = (n, base = 100, amp = 5) => Array.from({ length: n }, (_, i) => { const p = base + amp * (1 - Math.abs((i % 8) - 4) / 2); return bar(i, p, p + 0.5, p - 0.5, p); });

test('swings: highs and lows a candle above/below its neighbours', () => {
  const s = swings(zig(40));
  assert.ok(s.hi.length >= 3 && s.lo.length >= 3);
  assert.ok(s.hi.every((x) => x.p > 104) && s.lo.every((x) => x.p < 96));
});

test('a liquidity sweep: wick below the last swing low, close back above (bullish)', () => {
  const bars = zig(80);
  const low = swings(bars.slice(-90, -5)).lo.at(-1).p;
  const i = bars.length;
  bars.push(bar(i, 100, 100.5, low - 3, low + 1)); // took it out and reclaimed it
  for (let k = 1; k <= 3; k++) bars.push(flat(i + k, low + 2));
  const s = findSweep(bars, bars.at(-1).t + 60000);
  assert.equal(s.dir, 1);
  assert.match(s.level, /low/);
  assert.equal(s.extreme, low - 3);
});

test('a market structure shift: a close above the last swing high after a down-leg', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(flat(i, 100 - i * 0.5)); // falling
  bars[10] = bar(10, 95, 99, 94.5, 95); // a swing high on the way down
  bars[22] = bar(22, 89, 89.5, 85, 89); // then a swing low
  for (let k = 0; k < 4; k++) bars.push(flat(30 + k, 86 + k));
  bars.push(bar(34, 90, 101, 89.5, 100)); // closes above 99
  const s = findShift(bars, 3);
  assert.equal(s?.dir, 1);
  assert.equal(s.p, 99);
});

test('fair value gaps stay until price comes back to fill them', () => {
  const bars = [flat(0, 100), flat(1, 103, 10, 2), bar(2, 105, 107, 105, 106), flat(3, 106)];
  assert.deepEqual(fairValueGaps(bars).map((g) => [g.dir, g.lo, g.hi]), [[1, 101, 105]]);
  bars.push(bar(4, 106, 106, 100.5, 101));
  assert.deepEqual(fairValueGaps(bars), [], 'filled');
});

test('order block: the last down candle before a big up move', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push(bar(i, 100, 100.6, 99.4, i % 2 ? 100.2 : 99.8));
  bars.push(bar(40, 100, 100.1, 99, 99.2)); // the last down candle
  bars.push(bar(41, 99.2, 104, 99.2, 104)); // displacement
  const ob = orderBlocks(bars).at(-1);
  assert.equal(ob.dir, 1);
  assert.equal(ob.t, bars[40].t);
});

test('volume divergence: a new high on weak volume is bearish, a new low on weak volume bullish', () => {
  const up = Array.from({ length: 30 }, (_, i) => flat(i, 100, 10));
  up[12] = bar(12, 100, 105, 99, 101, 100);
  up.push(flat(30, 101), bar(31, 101, 106, 100, 104, 30), flat(32, 103));
  assert.equal(volumeDivergence(up), -1);
  const strong = up.map((b) => ({ ...b })); strong[31].v = 200;
  assert.equal(volumeDivergence(strong), 0);
  const dn = Array.from({ length: 30 }, (_, i) => flat(i, 100, 10));
  dn[12] = bar(12, 100, 101, 95, 99, 100);
  dn.push(flat(30, 99), bar(31, 99, 100, 94, 96, 30), flat(32, 97));
  assert.equal(volumeDivergence(dn), 1);
});

test('day VWAP and the structure read (too few candles: all zero)', () => {
  const bars = [bar(0, 100, 100, 100, 100, 1), bar(1, 200, 200, 200, 200, 3)];
  assert.equal(dayVwap(bars, T0 + 120000), 175);
  const r0 = structureRead(bars, { now: T0 + 120000 });
  assert.deepEqual(r0.features, { sweep: 0, shift: 0, fvgPull: 0, obZone: 0, volDiv: 0, vwapDev: 0 });
  const many = zig(120);
  const r = structureRead(many, { now: many.at(-1).t + 60000, price: 110, sigmaMin: 0.001 });
  assert.ok(r.features.vwapDev > 0, 'above the VWAP');
  for (const v of Object.values(r.features)) assert.ok(Number.isFinite(v) && Math.abs(v) <= 3);
});

// ---- the playbook's 15-minute sweep strategy ----
// 30 hours of a steady climb (with a zigzag, so there are swings), then the setup: a 15-minute candle sweeps the last
// hour's low and closes back inside, a high-volume close through the last swing high, a retest, and a rally
function setup() {
  const P = (i) => 50000 + i * 100 / 60 + 10 * Math.sin(2 * Math.PI * i / 7);
  const bars = [];
  const iS = 30 * 60 + 30; // half past an hour
  for (let i = 0; i < iS; i++) { const p = P(i); bars.push(bar(i, p, p + 1, p - 1, p)); }
  const pS = P(iS);
  const path = [];
  for (let k = 0; k <= 6; k++) path.push(pS - (250 * k) / 6);          // the sweep down
  for (let k = 1; k <= 8; k++) path.push(pS - 250 + (230 * k) / 8);    // and back (closes at pS - 20)
  path.push(pS - 10, pS, pS + 5);                                         // edging up
  let i = iS, prev = bars.at(-1).c;
  for (const p of path) { bars.push(bar(i++, prev, Math.max(p, prev) + 1, Math.min(p, prev) - 1, p)); prev = p; }
  bars.push(bar(i++, prev, pS + 62, prev - 1, pS + 60, 50)); prev = pS + 60; // the shift, on 5x volume
  bars.push(bar(i++, prev, prev + 1, pS - 30, pS - 20)); prev = pS - 20;     // the retest
  for (let k = 1; k <= 40; k++) { const p = pS - 20 + 30 * k; bars.push(bar(i++, prev, p + 1, prev - 1, p)); prev = p; }
  for (let k = 0; k < 60; k++) bars.push(flat(i++, prev));
  return { bars, slot: T0 + iS * 60000, pS };
}

test('the playbook strategy: finds the sweep, waits for the shift and the retest, and wins 2R less fees', () => {
  const { bars, slot, pS } = setup();
  const trades = backtest(bars, { variant: 'hour', target: 2 });
  const t = trades.find((x) => x.t > slot && x.t < slot + 3600000);
  assert.ok(t, `no trade: ${JSON.stringify(trades)}`);
  assert.equal(t.dir, 1);
  assert.ok(t.stop < pS - 250, 'stop beyond the sweep extreme');
  assert.ok(t.won && Math.abs(t.r - (2 - t.fees)) < 1e-9, `r ${t.r}`);
  // no trade before the setup (a steady climb never sweeps the last hour's low)
  assert.ok(trades.every((x) => x.t > slot));
  // without the volume there's no confirmation, so no trade
  const quiet = bars.map((b) => ({ ...b, v: 10 }));
  assert.ok(!backtest(quiet, { variant: 'hour' }).some((x) => x.t > slot && x.t < slot + 3600000));
});

test('the scorecard: count, win rate, average R, drawdown, fees, how many more it needs', () => {
  const s = scorecard([{ r: 2, won: true, fees: 0.1 }, { r: -1, won: false, fees: 0.1 }, { r: -1, won: false, fees: 0.1 }, { r: 2, won: true, fees: 0.1 }, { open: true }]);
  assert.equal(s.n, 4); assert.equal(s.open, 1); assert.equal(s.wins, 2);
  assert.equal(s.winRate, 0.5); assert.equal(s.avgR, 0.5); assert.equal(s.totalR, 2); assert.equal(s.maxDD, 2);
  assert.ok(Math.abs(s.feesR - 0.4) < 1e-9); assert.equal(s.needs, 96);
  assert.equal(scorecard([]).winRate, null);
});

test('playbook feed: backfills, tops up, reruns and serves the scorecard; keeps the candles', async () => {
  const { bars } = setup();
  const end = bars.at(-1).t + 60000;
  const rows = (from, to) => bars.filter((b) => b.t >= from && b.t < to).map((b) => [b.t / 1000, b.l, b.h, b.o, b.c, b.v]);
  const seen = [];
  const fetchJSON = async (url) => {
    seen.push(url);
    const u = new URL(url);
    const s = u.searchParams.get('start'), e = u.searchParams.get('end');
    return s ? rows(Date.parse(s), Date.parse(e)) : rows(end - 300 * 60000, end);
  };
  const file = join(mkdtempSync(join(tmpdir(), 'pb-')), 'bars.json');
  const pb = createPlaybook({ coinbase: 'http://cb', file, fetchJSON, clock: () => end, sleep: async () => {}, log: { error() {}, warn() {} } });
  await pb.backfill(end, 2);
  assert.equal(pb.bars().length, bars.length);
  pb.rerun();
  const api = pb.api();
  assert.equal(api.bars, bars.length);
  assert.ok(api.report.hour.n >= 1 && api.report.hour.wins >= 1);
  assert.ok(['day', 'day15', 'hour', 'hour15'].every((k) => api.report[k] && 'winRate' in api.report[k]));
  await pb.tick();
  assert.ok(seen.at(-1).endsWith('granularity=60'));
  // saved and loaded again
  const pb2 = createPlaybook({ coinbase: 'http://cb', file, fetchJSON, clock: () => end, log: { error() {}, warn() {} } });
  await pb2.load();
  assert.equal(pb2.bars().length, bars.length);
  // the structure read is cached within a second
  const a = pb.structure(bars.at(-1).c, 0.0008, end), b = pb.structure(bars.at(-1).c, 0.0008, end + 500);
  assert.equal(a, b);
});

test('Market watch notes a sweep and a structure shift once each', () => {
  const d = createDetector(), now = T0 + 3600000;
  const structure = { sweep: { dir: 1, t: now - 60000, level: "the last hour's low", p: 50000, extreme: 49950 }, shift: { dir: 1, t: now - 30000, p: 50100, text: 'closed above the last swing high ($50100) after a down-leg' } };
  d.step({ now, price: 50120, sigmaMin: 0.0008, structure });
  d.step({ now: now + 1000, price: 50121, sigmaMin: 0.0008, structure });
  const ks = d.events().map((e) => e.kind);
  assert.equal(ks.filter((k) => k === 'sweep').length, 1);
  assert.equal(ks.filter((k) => k === 'shift').length, 1);
  assert.match(d.events().find((e) => e.kind === 'sweep').text, /Bullish liquidity sweep/);
});
