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

test('PKCS#1 keys are wrapped to PKCS#8 byte-for-byte like OpenSSL does', () => {
  const ours = Buffer.from(pemToPkcs8(pkcs1));
  const openssl = Buffer.from(pkcs8.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  assert.deepEqual(ours, openssl);
  assert.throws(() => pemToPkcs8('hello'), /doesn't look like/);
});

test('parses fills in cents and in dollars', () => {
  const a = parseFill({ trade_id: 't1', ticker: 'KXBTC15M-X', side: 'yes', action: 'buy', count: 10, yes_price: 42, no_price: 58, created_time: '2026-10-04T17:01:02Z' });
  assert.deepEqual(a, { id: 't1', ticker: 'KXBTC15M-X', side: 'YES', action: 'buy', count: 10, price: 0.42, at: Date.parse('2026-10-04T17:01:02Z') });
  const b = parseFill({ trade_id: 't2', ticker: 'KXBTC15M-X', side: 'no', action: 'sell', count_fp: '3.00', yes_price_dollars: '0.3100', no_price_dollars: '0.6900', created_time: '2026-10-04T17:05:00Z' });
  assert.equal(b.side, 'NO'); assert.equal(b.action, 'sell'); assert.equal(b.count, 3); assert.equal(b.price, 0.69);
  assert.equal(balanceDollars({ balance: 12345 }), 123.45);
  assert.equal(balanceDollars({ balance_dollars: '50.10' }), 50.1);
});

test('folds fills into positions and sales: average in, partial sell, the other side nets out', () => {
  const f = (id, action, side, count, price, sec) => ({ id, ticker: 'T', action, side, count, price, at: sec * 1000 });
  let r = foldFills({}, [f('1', 'buy', 'YES', 10, 0.40, 1), f('2', 'buy', 'YES', 10, 0.50, 2)]);
  assert.deepEqual(r.holdings.T, { side: 'YES', contracts: 20, price: 0.45, at: 1000 });
  r = foldFills(r.holdings, [f('3', 'sell', 'YES', 5, 0.70, 3)]);
  assert.deepEqual(r.closes, [{ ticker: 'T', side: 'YES', contracts: 5, entry: 0.45, entryAt: 1000, exit: 0.70, at: 3000 }]);
  assert.equal(r.holdings.T.contracts, 15);
  // Buying 20 NO at 30¢ while holding 15 YES: closes the YES at 70¢, then holds 5 NO
  r = foldFills(r.holdings, [f('4', 'buy', 'NO', 20, 0.30, 4)]);
  assert.equal(r.closes[0].exit, 0.70);
  assert.equal(r.closes[0].contracts, 15);
  assert.deepEqual(r.holdings.T, { side: 'NO', contracts: 5, price: 0.30, at: 4000 });
  // Selling YES you don't hold opens NO at 1 - price
  r = foldFills({}, [f('5', 'sell', 'YES', 4, 0.65, 5)]);
  assert.deepEqual(r.holdings.T, { side: 'NO', contracts: 4, price: 0.35, at: 5000 });
});
