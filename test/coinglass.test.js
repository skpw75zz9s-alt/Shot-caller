import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cgSummary, createCoinGlass } from '../coinglass.js';

const rows = {
  'open-interest': [{ time: 1, close: '100' }, { time: 2, close: '110' }],
  'funding-rate': [{ time: 1, close: '0.01' }, { time: 2, close: '0.05' }],
  liquidation: [{ time: 1, aggregated_long_liquidation_usd: 300, aggregated_short_liquidation_usd: 100 }, { time: 2, aggregated_long_liquidation_usd: 200, aggregated_short_liquidation_usd: 0 }],
  'long-short': [{ time: 2, global_account_long_percent: 62, global_account_short_percent: 38, global_account_long_short_ratio: 1.63 }],
};

test('no key: off, with how to connect it, and nothing fetched', async () => {
  let calls = 0;
  const cg = createCoinGlass({ key: '', fetchImpl: async () => { calls++; } });
  const r = await cg.api('BTC');
  assert.equal(r.off, 'no key'); assert.match(r.how, /COINGLASS_API_KEY/); assert.equal(calls, 0);
});

test('with a key: the four readings, the key in the header, cached for a minute', async () => {
  const seen = [];
  let t = 0;
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers['CG-API-KEY']]);
    const k = Object.keys(rows).find((x) => url.includes(x));
    return { ok: true, status: 200, json: async () => ({ code: '0', msg: 'success', data: rows[k] }) };
  };
  const cg = createCoinGlass({ key: 'k1', fetchImpl, clock: () => t });
  const r = await cg.api('BTC');
  assert.equal(seen.length, 4); assert.ok(seen.every(([u, k]) => u.startsWith('https://open-api-v4.coinglass.com/api/futures/') && k === 'k1'));
  assert.ok(seen.some(([u]) => u.includes('symbol=BTCUSDT')), 'long/short is per Binance pair');
  assert.equal(r.oi.usd, 110); assert.ok(Math.abs(r.oi.change - 0.1) < 1e-9);
  assert.equal(r.funding.rate, 0.05); assert.match(r.funding.say, /crowded long/);
  assert.deepEqual([r.liq.long, r.liq.short, r.liq.more], [500, 100, 'longs']);
  assert.equal(r.ls.long, 62);
  assert.deepEqual(r.errors, {});
  await cg.api('BTC'); assert.equal(seen.length, 4, 'cached');
  t += 61000; await cg.api('BTC'); assert.equal(seen.length, 8, 'refetched after a minute');
  assert.ok((await cg.api('GOLD')).off);
});

test('a reading the plan does not include shows its error; the rest still show', async () => {
  const fetchImpl = async (url) => (url.includes('liquidation')
    ? { ok: true, status: 200, json: async () => ({ code: '40001', msg: 'Upgrade plan' }) }
    : url.includes('long-short') ? { ok: false, status: 500, json: async () => { throw new Error('html'); } }
      : { ok: true, status: 200, json: async () => ({ code: 0, data: rows[url.includes('open-interest') ? 'open-interest' : 'funding-rate'] }) });
  const r = await createCoinGlass({ key: 'k', fetchImpl }).api('ETH');
  assert.equal(r.errors.liq, 'Upgrade plan'); assert.equal(r.errors.ls, 'HTTP 500');
  assert.equal(r.oi.usd, 110); assert.equal(r.liq, undefined);
});

test('the summary reads funding and liquidations in plain words', () => {
  assert.match(cgSummary({ funding: [{ v: -0.02 }] }).funding.say, /crowded short/);
  assert.equal(cgSummary({ liq: [{ long: 100, short: 400 }] }).liq.more, 'shorts');
  assert.deepEqual(cgSummary({}), {});
});
