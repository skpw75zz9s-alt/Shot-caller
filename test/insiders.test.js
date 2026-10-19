import test from 'node:test';
import assert from 'node:assert/strict';
import { kalshiBig, liqSummary, positioning, transferDir, whaleSummary } from '../public/insiders.js';

test('Kalshi: UP vs DOWN money this round and the biggest orders first', () => {
  const k = kalshiBig([{ t: 1, side: 'YES', count: 100, price: 0.6, usd: 60 }, { t: 2, side: 'NO', count: 500, price: 0.4, usd: 200 }, { t: 3, side: 'YES', count: 10, price: 0.6, usd: 6 }, { t: 4, side: 'NO', usd: 0 }]);
  assert.deepEqual(k.up, { usd: 66, n: 2 }); assert.deepEqual(k.down, { usd: 200, n: 1 });
  assert.equal(k.top[0].usd, 200); assert.equal(k.top.length, 3); assert.ok(Math.abs(k.upShare - 66 / 266) < 1e-12);
  assert.equal(kalshiBig(null).total, 0); assert.equal(kalshiBig([]).upShare, null);
});

test('exchange whales: the last hour only, newest first, bought vs sold', () => {
  const now = 1e10, w = whaleSummary([{ t: now - 10, side: 'buy', usd: 5e5 }, { t: now - 20, side: 'sell', usd: 2e5 }, { t: now - 2 * 3600000, side: 'buy', usd: 9e9 }], now);
  assert.equal(w.n, 2); assert.equal(w.buy, 5e5); assert.equal(w.sell, 2e5); assert.equal(w.net, 3e5); assert.equal(w.list[0].t, now - 10);
});

test('liquidations: longs (forced selling) vs shorts (forced buying) in the last 30 minutes, biggest first', () => {
  const now = 1e10, L = liqSummary([{ t: now - 1000, ex: 'OKX', liq: 'long', usd: 3e6, price: 1 }, { t: now - 2000, ex: 'Binance', liq: 'short', usd: 1e6, price: 1 }, { t: now - 3600000, ex: 'OKX', liq: 'long', usd: 1e9 }], now);
  assert.equal(L.n, 2); assert.equal(L.long, 3e6); assert.equal(L.short, 1e6); assert.equal(L.biggest[0].usd, 3e6); assert.equal(L.minutes, 30);
});

test('futures positioning in plain words: who pays funding, and what open interest says', () => {
  const p = positioning({ funding: 0.00008, oi: 1e9, oiChange5: 0.004, priceChange5: -0.002, premium: 0.0003, live: true });
  assert.match(p.words[0], /longs paying shorts .*crowded/); assert.match(p.words[1], /open interest up 0\.40% .*selling the drop/);
  assert.ok(Math.abs(p.fundingYear - 0.00008 * 8760) < 1e-12);
  assert.match(positioning({ funding: -0.00002 }).words[0], /shorts paying longs/);
  assert.match(positioning({ funding: 0.000001 }).words[0], /near zero/);
  assert.match(positioning({ oiChange5: -0.003, priceChange5: 0.001 }).words[0], /positions closing \(shorts covering\?\)/);
  assert.equal(positioning(null), null);
});

test('a transfer\'s direction: onto an exchange, off one, between two, or between wallets', () => {
  const t = (f, to) => ({ from: { owner_type: f }, to: { owner_type: to } });
  assert.equal(transferDir(t('unknown', 'exchange')), 'onto'); assert.equal(transferDir(t('exchange', 'unknown')), 'off');
  assert.equal(transferDir(t('exchange', 'exchange')), 'between'); assert.equal(transferDir(t('unknown', 'unknown')), 'wallets');
});
