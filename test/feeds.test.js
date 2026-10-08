import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGES, byExchange, kalshiFlow, parseCoinbase, parseKalshiTrades } from '../public/feeds.js';

const ex = (name) => EXCHANGES.find((e) => e.name === name);

test('each exchange message becomes taker-side trades', () => {
  assert.deepEqual(parseCoinbase({ type: 'match', price: '100000.5', size: '0.1', side: 'sell', time: '2026-10-08T12:00:00Z' }),
    [{ ex: 'Coinbase', t: Date.parse('2026-10-08T12:00:00Z'), price: 100000.5, size: 0.1, side: 'buy' }], 'resting sell lifted: buyer was the taker');
  const k = ex('Kraken').parse({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: 'sell', price: 99990.1, qty: 0.25, timestamp: '2026-10-08T12:00:01.123Z' }] });
  assert.deepEqual(k.map((x) => [x.side, x.price, x.size]), [['sell', 99990.1, 0.25]]);
  const b = ex('Bitstamp').parse({ event: 'trade', channel: 'live_trades_btcusd', data: { price: 100001, amount: 0.5, type: 0, microtimestamp: '1791460800123456' } });
  assert.deepEqual(b.map((x) => [x.side, x.size, x.t]), [['buy', 0.5, 1791460800123]]);
  const g = ex('Gemini').parse({ type: 'update', timestampms: 1791460800000, events: [{ type: 'trade', price: '100002', amount: '0.01', makerSide: 'bid' }, { type: 'change' }] });
  assert.deepEqual(g.map((x) => x.side), ['sell'], 'maker bid got hit: taker sold');
  const n = ex('Binance.US').parse({ e: 'trade', p: '100003.00', q: '0.002', T: 1791460800000, m: false });
  assert.deepEqual(n.map((x) => [x.side, x.price]), [['buy', 100003]]);
  assert.deepEqual(ex('Kraken').parse({ channel: 'heartbeat' }), []);
  assert.deepEqual(ex('Bitstamp').parse({ event: 'bts:subscription_succeeded' }), []);
});

test('Kalshi contract trades: side, price paid, contracts, flow share', () => {
  const t = parseKalshiTrades({ trades: [
    { trade_id: 'a', ticker: 'T', count_fp: '100.00', yes_price_dollars: '0.6500', taker_side: 'yes', created_time: '2026-10-08T12:00:00Z' },
    { trade_id: 'b', ticker: 'T', count: 50, yes_price: 65, taker_side: 'no', created_time: '2026-10-08T12:00:02Z' },
    { trade_id: 'c', ticker: 'T', count: 0, yes_price: 65, taker_side: 'no', created_time: '2026-10-08T12:00:03Z' },
  ] });
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].side, t[0].price, t[0].count], ['YES', 0.65, 100]);
  assert.ok(Math.abs(t[1].price - 0.35) < 1e-9, 'a NO taker paid 1 - yes price');
  const f = kalshiFlow(t);
  assert.ok(Math.abs(f.YES.usd - 65) < 1e-9 && Math.abs(f.NO.usd - 17.5) < 1e-9);
  assert.ok(Math.abs(f.yesShare - 65 / 82.5) < 1e-9);
  const by = byExchange([{ ex: 'Kraken', price: 100, size: 2, side: 'buy' }, { ex: 'Kraken', price: 100, size: 1, side: 'sell' }]);
  assert.deepEqual(by.Kraken, { buy: 200, sell: 100, n: 2 });
});
