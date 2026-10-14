import test from 'node:test';
import assert from 'node:assert/strict';
import { DRV, attribute, chartSvg, driverMove, events, explain, ffill, fitDrivers, volumeBars } from '../public/drivers.js';
import { ASSETS, DRIVERS } from '../public/markets.js';
import { createCrossFeed } from '../crossfeed.js';

const MIN = 60000, T0 = Date.UTC(2026, 9, 12, 0, 0); // a Monday
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; }
// 3 days of minutes: gold falls 0.6% per 1% of dollar strength and follows a metals-wide factor (silver), plus its own noise
function world(n = 3 * 1440, { own = 0.0002, seed = 4 } = {}) {
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  const lv = { DXY: 100, US10Y: 4.1, SPX: 6700, OIL: 70, SILVER: 30, PLAT: 1000, COPPER: 4.5, GOLD: 2400 }, maps = Object.fromEntries(Object.keys(lv).map((k) => [k, new Map()]));
  for (let i = 0; i < n; i++) {
    const t = T0 + i * MIN, dx = 0.0003 * g(), metals = 0.0006 * g(), mv = { DXY: dx, US10Y: 0.0008 * g(), SPX: 0.0004 * g(), OIL: 0.0007 * g(), SILVER: metals * 1.4 - 0.5 * dx + 0.0003 * g(), PLAT: metals + 0.0004 * g(), COPPER: 0.0005 * g() };
    mv.GOLD = -0.6 * dx + metals + own * g();
    for (const k of Object.keys(lv)) { lv[k] *= Math.exp(mv[k]); if (k !== 'GOLD' || i % 7) maps[k].set(t, lv[k]); } // gold skips a print now and then
  }
  return maps;
}
const GOLD = ASSETS.find((a) => a.key === 'GOLD');

test('every metal, oil and index lists drivers the reader knows', () => {
  const keys = new Set([...ASSETS.map((a) => a.key), ...DRIVERS.map((d) => d.key)]);
  for (const a of ASSETS.filter((x) => x.kind !== 'crypto')) {
    assert.ok(a.drivers && a.drivers.own, a.key);
    for (const k of [...a.drivers.macro, ...a.drivers.sector]) assert.ok(keys.has(k) && k !== a.key, `${a.key}: ${k}`);
  }
  for (const d of DRIVERS) assert.ok(d.yahoo && d.short && d.why, d.key);
});

test('the parts add up to the move exactly, and each driver gets the right sign', () => {
  const maps = world(), now = T0 + (3 * 1440 - 1) * MIN, m = fitDrivers(maps, GOLD, now);
  assert.equal(m.ready, true); assert.ok(m.r2All > 0.7 && m.r2All >= m.r2Macro, JSON.stringify([m.r2Macro, m.r2All]));
  const r = attribute(maps, m, GOLD, now - 240 * MIN, now);
  assert.ok(Math.abs(r.parts.reduce((s, p) => s + p.usd, 0) - r.move) < 1e-9, 'parts sum to the move');
  assert.equal(r.parts.at(-1).key, 'OWN'); assert.deepEqual(r.parts.map((p) => p.group), ['macro', 'macro', 'macro', 'macro', 'sector', 'sector', 'sector', 'own']);
  const dxy = r.parts.find((p) => p.key === 'DXY');
  assert.ok(Math.sign(dxy.usd) === -Math.sign(dxy.move) || Math.abs(dxy.move) < 1e-4, 'a stronger dollar pushes gold down');
  assert.ok(Math.abs(dxy.per1 + 0.6) < 0.15, `about -0.6% per +1% of the dollar: ${dxy.per1}`);
  assert.ok(Math.abs(r.parts.at(-1).usd) < Math.abs(r.move) + 30, 'its own part is the small leftover');
  assert.ok(r.series.length <= DRV.maxPoints && r.series[0].actual === 0 && Math.abs(r.series.at(-1).actual - r.move) < 1e-6);
});

test('a market with no drivers in the move: it\'s all its own', () => {
  const maps = world(3 * 1440, { own: 0.002, seed: 9 }), now = T0 + (3 * 1440 - 1) * MIN, m = fitDrivers(maps, GOLD, now);
  assert.ok(m.r2All < 0.25, String(m.r2All));
  const r = attribute(maps, m, GOLD, now - 60 * MIN, now);
  assert.match(explain(r, { name: 'Gold', w: 60, r2: m.r2All }), /Over the last hour Gold is (up|down) .*most of its moves are its own/);
});

test('too little history: not ready, nothing claimed', () => {
  const maps = world(100), m = fitDrivers(maps, GOLD, T0 + 99 * MIN);
  assert.equal(m.ready, false); assert.equal(attribute(maps, m, GOLD, T0, T0 + 99 * MIN), null);
});

test('moves, yields in basis points, filling gaps, volume and the EIA report', () => {
  const y = new Map([[T0, 4.1], [T0 + 10 * MIN, 4.13]]);
  assert.ok(Math.abs(driverMove(y, 'yield', T0, T0 + 10 * MIN) - 3) < 1e-9);
  assert.ok(Math.abs(driverMove(new Map([[T0, 41], [T0 + MIN, 41.3]]), 'yield', T0, T0 + MIN) - 3) < 1e-9, 'the old x10 quote');
  assert.equal(ffill(y, T0 + 5 * MIN), 4.1); assert.equal(ffill(y, T0 + 40 * MIN), null);
  const v = new Map(Array.from({ length: 120 }, (_, i) => [T0 + i * MIN, i === 100 ? 900 : 100])), vb = volumeBars(v, T0, T0 + 119 * MIN, 60);
  assert.equal(vb.typical, 100); assert.ok(vb.bars.length <= 60 && vb.bars.some((b) => b.v > 300));
  const wed = Date.UTC(2026, 9, 14, 12), ev = events({ key: 'OIL' }, wed, wed + 6 * 3600000);
  assert.equal(ev.length, 1); assert.equal(ev[0].t, Date.UTC(2026, 9, 14, 14, 30), '10:30 New York in daylight time');
  assert.equal(events({ key: 'OIL' }, Date.UTC(2026, 11, 2, 12), Date.UTC(2026, 11, 2, 18))[0].t, Date.UTC(2026, 11, 2, 15, 30), 'and in winter');
  assert.deepEqual(events({ key: 'GOLD' }, wed, wed + 6 * 3600000), []);
});

test('the chart: an SVG with both lines, the shaded gap and the volume', () => {
  const maps = world(), now = T0 + (3 * 1440 - 1) * MIN, m = fitDrivers(maps, GOLD, now), r = attribute(maps, m, GOLD, now - 60 * MIN, now);
  const c = chartSvg(r, { vol: { bars: [{ t: r.from, v: 5 }, { t: r.from + 30 * MIN, v: 40 }], typical: 5 }, evs: [{ t: r.from + 10 * MIN, label: 'EIA oil inventories' }] });
  for (const cls of ['dv-act', 'dv-drv', 'dv-own', 'dv-vol hot', 'dv-ev', 'dv-cross']) assert.ok(c.svg.includes(cls), cls);
  assert.equal(c.xs.length, r.series.length); assert.ok(c.xs.every((x) => x >= 0 && x <= 1));
  assert.equal(chartSvg(null).svg, '');
});

test('the server reader serves why gold is moving, and the related list carries its drivers', () => {
  const maps = world(), now = T0 + (3 * 1440 - 1) * MIN, feed = createCrossFeed({ prices: { candleRows: async () => [] }, clock: () => now, log: { warn() {} } });
  for (const [k, mm] of Object.entries(maps)) feed.merge(k, [...mm].map(([t, c]) => ({ t, c, v: 10 })));
  feed.refit(now);
  const w = feed.why('GOLD', 240, now);
  assert.equal(w.supported, true); assert.equal(w.w, 240); assert.ok(w.fit.ready && w.parts.length === 8 && w.vol.bars.length);
  assert.ok(Math.abs(w.parts.reduce((s, p) => s + p.usd, 0) - w.move) < 1e-9);
  assert.equal(feed.why('BTC', 60, now).supported, false, 'crypto has its own cards');
  assert.equal(feed.why('GOLD', 7, now).w, 60, 'unknown windows fall back to an hour');
  const rel = feed.api('GOLD', now).related.map((r) => r.key);
  for (const k of ['DXY', 'US10Y', 'PLAT', 'COPPER', 'SILVER']) assert.ok(rel.includes(k), k);
  assert.ok(!feed.api('ETH', now).related.some((r) => r.key === 'DXY'), 'the coins keep their list');
  // the first poll (about 300 minutes) is enough to start explaining, before the related-markets model has its 300
  const short = createCrossFeed({ prices: { candleRows: async () => [] }, clock: () => now, log: { warn() {} } });
  for (const [k, mm] of Object.entries(maps)) short.merge(k, [...mm].slice(-290).map(([t, c]) => ({ t, c, v: 10 })));
  short.refit(now);
  assert.equal(short.why('GOLD', 60, now).fit.ready, true);
});
