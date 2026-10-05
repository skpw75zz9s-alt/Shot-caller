import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { balanceDollars, foldFills, importKey, parseFill, pemToPkcs8, signHeaders } from '../public/kalshi.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }); // what Kalshi hands out
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('signs exactly like Kalshi expects: RSA-PSS SHA-256 over timestamp + method + path', async () => {
  for (const pem of [pkcs1, pkcs8]) {
    const key = await importKey(pem);
    assert.equal(key.extractable, false, 'the key can never be read back out');
    const h = await signHeaders(key, 'key-id-1234', 'GET', '/trade-api/v2/portfolio/fills', 1700000000000);
    assert.equal(h['x-kalshi-ts'], '1700000000000');
    const ok = verify('sha256', Buffer.from('1700000000000GET/trade-api/v2/portfolio/fills'),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(h['x-kalshi-sig'], 'base64'));
    assert.ok(ok, 'signature verifies with the public key');
  }
});

test('Ed25519 keys (Kalshi\'s newer short keys) import and sign too', async () => {
  const ed = generateKeyPairSync('ed25519');
  const pem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.match(pem.replace(/-----[^-]+-----|\s/g, ''), /^MC4CAQAwBQYDK2Vw/, 'same shape as the key Kalshi hands out');
  const key = await importKey(pem);
  assert.equal(key.algorithm.name, 'Ed25519');
  assert.equal(key.extractable, false);
  const h = await signHeaders(key, 'key-id-1234', 'GET', '/trade-api/v2/portfolio/balance', 1700000000000);
  assert.ok(verify(null, Buffer.from('1700000000000GET/trade-api/v2/portfolio/balance'), ed.publicKey, Buffer.from(h['x-kalshi-sig'], 'base64')));
  assert.equal(Buffer.from(h['x-kalshi-sig'], 'base64').length, 64);
});

test('PKCS#1 keys are wrapped to PKCS#8 byte-for-byte like OpenSSL does', () => {
  const ours = Buffer.from(pemToPkcs8(pkcs1));
  const openssl = Buffer.from(pkcs8.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  assert.deepEqual(ours, openssl);
  assert.throws(() => pemToPkcs8('hello'), /doesn't look like/);
});

test('parses fills in cents and in dollars', () => {
  const a = parseFill({ trade_id: 't1', ticker: 'KXBTC15M-X', side: 'yes', action: 'buy', count: 10, yes_price: 42, no_price: 58, created_time: '2026-10-04T17:01:02Z' });
  assert.deepEqual(a, { id: 't1', ticker: 'KXBTC15M-X', side: 'YES', action: 'buy', count: 10, price: 0.42, fee: null, orderId: null, at: Date.parse('2026-10-04T17:01:02Z') });
  const b = parseFill({ trade_id: 't2', ticker: 'KXBTC15M-X', side: 'no', action: 'sell', count_fp: '3.00', yes_price_dollars: '0.3100', no_price_dollars: '0.6900', created_time: '2026-10-04T17:05:00Z' });
  assert.equal(b.side, 'NO'); assert.equal(b.action, 'sell'); assert.equal(b.count, 3); assert.equal(b.price, 0.69);
  assert.equal(balanceDollars({ balance: 12345 }), 123.45);
  assert.equal(balanceDollars({ balance_dollars: '50.10' }), 50.1);
});

test('folds fills into positions and sales: average in, partial sell, the other side nets out', () => {
  const f = (id, action, side, count, price, sec) => ({ id, ticker: 'T', action, side, count, price, at: sec * 1000 });
  let r = foldFills({}, [f('1', 'buy', 'YES', 10, 0.40, 1), f('2', 'buy', 'YES', 10, 0.50, 2)]);
  assert.deepEqual(r.holdings.T, { side: 'YES', contracts: 20, price: 0.45, at: 1000, fees: null });
  r = foldFills(r.holdings, [f('3', 'sell', 'YES', 5, 0.70, 3)]);
  assert.deepEqual(r.closes, [{ ticker: 'T', side: 'YES', contracts: 5, entry: 0.45, entryAt: 1000, exit: 0.70, at: 3000, fees: null }]);
  assert.equal(r.holdings.T.contracts, 15);
  // Buying 20 NO at 30¢ while holding 15 YES: closes the YES at 70¢, then holds 5 NO
  r = foldFills(r.holdings, [f('4', 'buy', 'NO', 20, 0.30, 4)]);
  assert.equal(r.closes[0].exit, 0.70);
  assert.equal(r.closes[0].contracts, 15);
  assert.deepEqual(r.holdings.T, { side: 'NO', contracts: 5, price: 0.30, at: 4000, fees: null });
  // Selling YES you don't hold opens NO at 1 - price
  r = foldFills({}, [f('5', 'sell', 'YES', 4, 0.65, 5)]);
  assert.deepEqual(r.holdings.T, { side: 'NO', contracts: 4, price: 0.35, at: 5000, fees: null });
});

test('fills: outcome_side decides YES/NO (a "bid"/"ask" side no longer reads as YES), and the exact fee is kept', async () => {
  const { parseFill } = await import('../public/kalshi.js');
  const no = parseFill({ fill_id: 'f1', ticker: 'KXBTC15M-X', outcome_side: 'no', side: 'ask', book_side: 'ask', action: 'buy', count_fp: '3.00', yes_price_dollars: '0.3000', no_price_dollars: '0.7000', fee_cost: '0.0441', created_time: '2026-10-05T14:00:00Z' });
  assert.deepEqual([no.side, no.action, no.count, no.price, no.fee, no.id], ['NO', 'buy', 3, 0.7, 0.0441, 'f1']);
  assert.equal(parseFill({ ticker: 'K', side: 'ask', action: 'buy', count_fp: '1.00', yes_price_dollars: '0.30' }).side, 'NO', 'V2 book side without outcome_side');
  assert.equal(parseFill({ ticker: 'K', side: 'yes', action: 'buy', count: 1, yes_price: 30 }).fee, null, 'older fills without a fee');
});

test("folding fills carries Kalshi's real fees into each close", async () => {
  const { foldFills } = await import('../public/kalshi.js');
  const fills = [
    { ticker: 'T', side: 'YES', action: 'buy', count: 4, price: 0.40, fee: 0.08, at: 1 },
    { ticker: 'T', side: 'YES', action: 'sell', count: 3, price: 0.60, fee: 0.06, at: 2 },
  ];
  const { holdings, closes } = foldFills({}, fills);
  assert.deepEqual([closes[0].contracts, closes[0].entry, closes[0].exit, closes[0].fees], [3, 0.4, 0.6, 0.12], '3/4 of 8c entry fees + the 6c exit fee');
  assert.deepEqual([holdings.T.contracts, Math.round(holdings.T.fees * 100) / 100], [1, 0.02]);
  assert.equal(foldFills({}, [{ ...fills[0], fee: null }, fills[1]]).closes[0].fees, null, 'unknown if any fee is missing');
});

test('Kalshi positions, settlements and orders parse from the documented fields', async () => {
  const { parsePosition, parseSettlement, parseOrder } = await import('../public/kalshi.js');
  assert.deepEqual(parsePosition({ ticker: 'T', position_fp: '-5.00', market_exposure_dollars: '3.5000', realized_pnl_dollars: '1.2000', fees_paid_dollars: '0.1500', resting_orders_count: 1 }),
    { ticker: 'T', side: 'NO', contracts: 5, cost: 3.5, realized: 1.2, fees: 0.15, resting: 1 });
  const st = parseSettlement({ ticker: 'T', market_result: 'no', yes_count_fp: '0.00', no_count_fp: '5.00', yes_total_cost_dollars: '0.0000', no_total_cost_dollars: '3.5000', revenue: 500, fee_cost: '0.1500', settled_time: '2026-10-05T14:15:30Z' });
  assert.deepEqual([st.result, st.no, st.cost, st.revenue, st.fees], ['no', 5, 3.5, 5, 0.15]);
  const o = parseOrder({ order_id: 'o1', client_order_id: 'c1', ticker: 'T', status: 'executed', fill_count_fp: '3.00', remaining_count_fp: '0.00', taker_fill_cost_dollars: '0.9000', maker_fill_cost_dollars: '0.3300', taker_fees_dollars: '0.0500', maker_fees_dollars: '0.0100' });
  assert.deepEqual([o.filled, o.cost, o.fees, o.avgPrice, o.status], [3, 1.23, 0.06, 0.41, 'executed']);
});

test("reconcile: Kalshi's positions win; exact fill prices are kept when Kalshi agrees", async () => {
  const { reconcilePositions } = await import('../public/kalshi.js');
  const app = [
    { source: 'kalshi', ticker: 'KXBTC15M-A', side: 'YES', contracts: 3, price: 0.4133, at: 1 }, // agrees
    { source: 'kalshi', ticker: 'KXBTC15M-B', side: 'YES', contracts: 3, price: 0.40, at: 1 },   // Kalshi: 5 NO
    { source: 'kalshi', ticker: 'KXBTC15M-C', side: 'NO', contracts: 2, price: 0.70, at: 1 },    // gone on Kalshi
    { source: 'kalshi', ticker: 'KXBTC15M-D', side: 'NO', contracts: 2, price: 0.70, at: 5000 }, // newer than Kalshi's answer
    { ticker: 'KXBTC15M-E', side: 'YES', contracts: 1, price: 0.5, at: 1 },                       // a manual tap: not touched
  ];
  const kalshi = [
    { ticker: 'KXBTC15M-A', side: 'YES', contracts: 3, cost: 1.24 },
    { ticker: 'KXBTC15M-B', side: 'NO', contracts: 5, cost: 3.0 },
    { ticker: 'KXBTC15M-F', side: 'YES', contracts: 2, cost: 0.9 },
    { ticker: 'KXETH15M-G', side: 'YES', contracts: 9, cost: 1 },
  ];
  const r = reconcilePositions(app, kalshi, { series: 'KXBTC15M', asOf: 1000 });
  assert.deepEqual(r.set.map((x) => [x.ticker, x.side, x.contracts, x.price]), [['KXBTC15M-B', 'NO', 5, 0.6]]);
  assert.deepEqual(r.remove.map((x) => x.ticker), ['KXBTC15M-C']);
  assert.deepEqual(r.add.map((x) => [x.ticker, x.side, x.contracts, x.price]), [['KXBTC15M-F', 'YES', 2, 0.45]]);
});

test('reconcile never takes an impossible average price', async () => {
  const { reconcilePositions } = await import('../public/kalshi.js');
  const r = reconcilePositions([{ source: 'kalshi', ticker: 'KXBTC15M-A', side: 'YES', contracts: 3, price: 0.4, at: 1 }], [{ ticker: 'KXBTC15M-A', side: 'NO', contracts: 9, cost: 26.4 }], { series: 'KXBTC15M', asOf: 10 });
  assert.deepEqual([r.set[0].side, r.set[0].contracts, r.set[0].price], ['NO', 9, 0.4]);
});
