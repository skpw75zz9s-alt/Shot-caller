import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLOWS, dailyCloses, dailySamples, dailyTest, flowNumber, flowShift, parseFarside, parseStables, stablesChange, walkForward, whaleNet, whaleTest } from '../public/flows.js';
import { createFlowsFeed, resetFlowsCache } from '../flowsfeed.js';
import { signalBoard } from '../public/signals.js';

const FARSIDE = `<table class="etf"><thead><tr><th>Date</th><th>IBIT</th><th>FBTC</th><th>Total</th></tr></thead><tbody>
<tr><td><span>11 Jan 2024</span></td><td>111.7</td><td>227.0</td><td>655.3</td></tr>
<tr><td>12 Jan 2024</td><td>386.0</td><td>(50.0)</td><td><span class="redFont">(1,203.4)</span></td></tr>
<tr><td>15 Jan 2024</td><td>-</td><td>-</td><td>-</td></tr>
<tr><td>Total</td><td>497.7</td><td>177.0</td><td>-548.1</td></tr><tr><td>Average</td><td>1</td><td>2</td><td>3</td></tr></tbody></table>`;

test('Farside: one total per day, negatives in brackets, dashes as zero, summary rows skipped', () => {
  assert.deepEqual(parseFarside(FARSIDE), [{ date: '2024-01-11', total: 655.3 }, { date: '2024-01-12', total: -1203.4 }, { date: '2024-01-15', total: 0 }]);
  assert.equal(flowNumber('(56.2)'), -56.2); assert.equal(flowNumber('1,234.5'), 1234.5); assert.equal(flowNumber('—'), 0); assert.equal(flowNumber('n/a'), null);
  assert.deepEqual(parseFarside('<html>Access denied</html>'), []);
});

test('DefiLlama: total stablecoin supply per day, and its 7-day change', () => {
  const rows = parseStables(Array.from({ length: 10 }, (_, i) => ({ date: String(1704067200 + i * 86400), totalCirculatingUSD: { peggedUSD: 100e9 + i * 1e9, peggedEUR: 1e9 } })));
  assert.equal(rows.length, 10); assert.equal(rows[0].date, '2024-01-01'); assert.equal(rows[0].usd, 101e9);
  const ch = stablesChange(rows);
  assert.equal(ch.length, 3); assert.ok(Math.abs(ch[0].value - (108 / 101 - 1) * 100) < 1e-9);
  assert.deepEqual(parseStables({ error: 'nope' }), []);
});

test('Whale Alert: coins onto exchanges count +, off them -, exchange to exchange ignored, other coins and old ones skipped', () => {
  const now = 1.7e12, tx = (from, to, usd, sym = 'btc', ago = 60) => ({ symbol: sym, timestamp: (now - ago * 1000) / 1000, amount_usd: usd, from: { owner_type: from }, to: { owner_type: to } });
  const r = whaleNet([tx('unknown', 'exchange', 5e6), tx('exchange', 'unknown', 2e6), tx('exchange', 'exchange', 9e6), tx('unknown', 'exchange', 7e6, 'eth'), tx('unknown', 'exchange', 1e6, 'btc', 7200)], 'BTC', now - 3600000);
  assert.deepEqual(r, { net: 3e6, n: 2 });
});

// days of closes and a factor that leads the next day's move on cue
function days(n, { edge = 0, seed = 3 } = {}) {
  let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const closes = {}, readings = []; let p = 40000, t = Date.UTC(2023, 0, 1);
  for (let i = 0; i < n; i++) {
    const date = new Date(t + i * 86400000).toISOString().slice(0, 10), v = r() - 0.5;
    closes[date] = p; readings.push({ date, value: v });
    const up = r() < 0.5 + edge * Math.sign(v); p *= up ? 1.02 : 0.98;
  }
  return { closes, readings };
}

test('daily test: a reading is graded against the NEXT day, once per day; a real lead is proven on unseen days, noise is not', () => {
  const { closes, readings } = days(400, { edge: 0.2 });
  const smp = dailySamples(readings, closes);
  assert.equal(smp.length, 399, 'the last day has no next day yet');
  const real = dailyTest(readings, closes);
  assert.equal(real.proven, true, JSON.stringify(real.test)); assert.equal(real.dir, 1); assert.ok(real.test.n >= FLOWS.minTestDays);
  assert.ok(real.avgMove > 0.019 && real.avgMove < 0.021);
  const noise = days(400, { seed: 9 });
  assert.equal(dailyTest(noise.readings, noise.closes).proven, false);
  const fewer = days(120, { edge: 0.3 });
  assert.equal(dailyTest(fewer.readings, fewer.closes).proven, false, 'under 60 unseen days: not judged yet');
  assert.deepEqual(dailyCloses([[1704067200, 1, 2, 1, 42000, 9]]), { '2024-01-01': 42000 });
});

test('a factor that works backwards is faded (picked on the older days, checked on the newer)', () => {
  const { closes, readings } = days(400, { edge: -0.2 });
  const r = dailyTest(readings, closes);
  assert.equal(r.dir, -1); assert.equal(r.proven, true);
  assert.equal(walkForward([], { minTest: 1 }).proven, false);
  assert.equal(whaleTest([{ at: 1, value: 5, y: null }]).n, 0, 'ungraded hours are not counted');
});

test('the nudge: a daily edge moves a 15-minute round by a fraction of a point, capped at 2', () => {
  const base = { lean: 1, hit: 0.6, horizonMin: 1440, avgMove: 0.02, minutesLeft: 8, sigmaMin: 0.0008, spot: 100000, strike: 100000 };
  const v = flowShift(base);
  assert.ok(v > 0 && v < 0.01, String(v));
  assert.ok(flowShift({ ...base, lean: -1 }) < 0);
  assert.equal(flowShift({ ...base, hit: 0.5 }), null); assert.equal(flowShift({ ...base, lean: 0 }), null);
  assert.ok(flowShift({ ...base, horizonMin: 15, hit: 0.99, avgMove: 0.05 }) <= 0.02);
});

function fakeSources({ farside = FARSIDE, failLlama = false, whale = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('farside')) return { ok: true, text: async () => farside };
    if (url.includes('llama')) return failLlama ? { ok: false, status: 503 } : { ok: true, json: async () => Array.from({ length: 60 }, (_, i) => ({ date: String(1704067200 + i * 86400), totalCirculatingUSD: { peggedUSD: 1e11 + i * 1e8 } })) };
    if (url.includes('whale-alert')) return { ok: true, json: async () => whale ?? { result: 'success', transactions: [] } };
    return { ok: false, status: 404 };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const prices = { candleRows: async () => Array.from({ length: 300 }, (_, i) => [1704067200 + i * 86400, 1, 2, 1, 40000 + (i % 7) * 100, 1]) };

test('the feed: reads each source, reports broken ones plainly, and nudges nothing while nothing is proven', async () => {
  resetFlowsCache();
  const fetchImpl = fakeSources({ failLlama: true });
  const f = createFlowsFeed({ asset: { key: 'BTC' }, file: join(mkdtempSync(join(tmpdir(), 'flows-')), 'f.json'), prices, fetchImpl, env: {}, clock: () => Date.UTC(2024, 0, 16), log: { error: () => {} } });
  await f.refresh();
  const a = f.api();
  assert.equal(a.etf.on, true); assert.equal(a.etf.days, 3); assert.equal(a.etf.err, null);
  assert.equal(a.etf.read.date, '2024-01-15'); assert.ok(a.etf.test, 'tested (on too few days to judge)'); assert.equal(a.etf.test.proven, false);
  assert.match(a.stables.err, /answered 503/);
  assert.equal(a.whale.on, false); assert.match(a.whale.err, /WHALE_ALERT_API_KEY/);
  assert.ok(!fetchImpl.calls.some((u) => u.includes('whale-alert')), 'no key: Whale Alert is never called');
  assert.equal(f.shifts(), null);
  const eth = createFlowsFeed({ asset: { key: 'XRP' }, file: join(mkdtempSync(join(tmpdir(), 'flows-')), 'f.json'), prices, fetchImpl: fakeSources(), env: {}, log: { error: () => {} } });
  await eth.refresh();
  assert.equal(eth.api().etf.on, false, 'no spot ETF table for XRP on Farside');
});

test('the feed with a Whale Alert key: reads the last hour, keeps the key out of errors, samples once an hour', async () => {
  resetFlowsCache();
  let now = Date.UTC(2024, 0, 16, 12);
  const tx = { hash: 'h1', symbol: 'btc', timestamp: now / 1000 - 300, amount_usd: 4e6, from: { owner_type: 'unknown' }, to: { owner_type: 'exchange', address: 'a' } };
  const f = createFlowsFeed({ asset: { key: 'BTC' }, file: join(mkdtempSync(join(tmpdir(), 'flows-')), 'f.json'), prices, fetchImpl: fakeSources({ whale: { result: 'success', transactions: [tx] } }), env: { WHALE_ALERT_API_KEY: 'secret-key-123' }, clock: () => now, log: { error: () => {} } });
  await f.refresh();
  const a = f.api();
  assert.equal(a.whale.on, true); assert.equal(a.whale.read.value, 4e6); assert.equal(a.whale.read.n, 1); assert.equal(a.whale.samples, 1);
  now += 120000; await f.refresh(); assert.equal(f.api().whale.samples, 1, 'still the same hour');
  const bad = createFlowsFeed({ asset: { key: 'BTC' }, file: join(mkdtempSync(join(tmpdir(), 'flows-')), 'f.json'), prices, fetchImpl: fakeSources({ whale: { result: 'error', message: 'invalid api_key secret-key-123' } }), env: { WHALE_ALERT_API_KEY: 'secret-key-123' }, log: { error: () => {} } });
  await bad.refresh();
  assert.doesNotMatch(bad.api().whale.err, /secret-key-123/); assert.match(bad.api().whale.err, /invalid api_key/);
});

test('the signal board shows the flows on probation, with what they read and why they are not used', () => {
  const flows = { etf: { on: true, read: { date: '2024-01-15', value: -120, lean: -1 }, test: { n: 300, dir: 1, test: { n: 90, hits: 47, hit: 0.52, z: 0.4 }, proven: false, need: 60, zNeed: 2.5 }, err: null },
    stables: { on: true, read: null, test: null, err: 'stablecoins.llama.fi answered 503' }, whale: { on: false }, inCalls: null };
  const b = signalBoard({ ticker: 'T', side: 'YES', flows });
  const etf = b.rows.find((r) => r.key === 'flows_etf'), st = b.rows.find((r) => r.key === 'flows_stables'), wh = b.rows.find((r) => r.key === 'flows_whale');
  assert.equal(etf.status, 'probation'); assert.equal(etf.verdict, 'noedge'); assert.match(etf.note, /−\$120M out · right 52% of 90 unseen days/); assert.equal(etf.lean, 'NO'); assert.equal(etf.vs, 'against');
  assert.equal(st.verdict, 'gathering'); assert.match(st.why, /answered 503/);
  assert.match(wh.why, /WHALE_ALERT_API_KEY/);
  assert.equal(signalBoard({ crypto: false, flows }).rows.some((r) => r.key.startsWith('flows_')), false, 'not for indexes, gold or oil');
});
