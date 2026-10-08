import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shot-srv-'));
process.env.PAYWALL = 'off'; // paywall has its own tests

// Mock upstream standing in for both Kalshi and Coinbase.
const upstream = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/markets?')) return res.end(JSON.stringify({ markets: [{ ticker: 'KXBTC15M-T1', close_time: new Date(Date.now() + 300000).toISOString() }] }));
  if (req.url === '/products/BTC-USD/ticker') return res.end(JSON.stringify({ price: '100000.00' }));
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => upstream.listen(0, r));
const base = `http://127.0.0.1:${upstream.address().port}`;
process.env.KALSHI_API = base;
process.env.COINBASE_API = base;
const { server, bot } = await import('../server.js');
await new Promise((r) => server.listen(0, r));
const app = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstream.close(); bot.stop(); });

test('proxies Kalshi markets', async () => {
  const r = await fetch(`${app}/api/kalshi/markets?series_ticker=KXBTC15M&status=open`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).markets[0].ticker, 'KXBTC15M-T1');
});

test('proxies Coinbase ticker', async () => {
  const r = await fetch(`${app}/api/coinbase/products/BTC-USD/ticker`);
  assert.equal((await r.json()).price, '100000.00');
});

test('blocks non-market-data paths', async () => {
  for (const p of ['/api/kalshi/portfolio/balance', '/api/coinbase/orders', '/api/kalshi/markets/../portfolio']) {
    assert.equal((await fetch(app + p)).status, 404, p);
  }
});

test('serves the app shell and blocks traversal', async () => {
  const r = await fetch(`${app}/`);
  assert.match(await r.text(), /Shot Caller/);
  assert.equal((await fetch(`${app}/model.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${app}/..%2fserver.js`)).status, 404);
});

test('push API: key, validation and method guards', async () => {
  const key = await (await fetch(`${app}/api/push/key`)).json();
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);
  const bad = await fetch(`${app}/api/push/sync`, { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'https://evil.com/x' } }) });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${app}/api/push/sync`, { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await fetch(`${app}/api/push/nothing`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${app}/api/kalshi/markets`, { method: 'POST' })).status, 405);
});

test('rate limits use the proxy-added (last) X-Forwarded-For hop, not client-supplied ones', async () => {
  // Fake first hop changes every time; the last hop (what the platform proxy adds) stays the same
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${app}/api/access/admin`, { method: 'POST', headers: { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.7` }, body: JSON.stringify({ code: 'nope' }) });
    codes.push(r.status);
  }
  assert.deepEqual(codes.slice(0, 8), Array(8).fill(403));
  assert.equal(codes[8], 429, 'locked out after 8 wrong codes despite spoofed first hops');
});

test('compresses the app and market data when the phone accepts it, plain otherwise', async () => {
  const { readFileSync } = await import('node:fs');
  const { brotliDecompressSync, gunzipSync } = await import('node:zlib');
  const raw = (path, enc) => new Promise((ok) => http.get(app + path, { headers: enc ? { 'accept-encoding': enc } : {} }, (r) => {
    const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => ok({ h: r.headers, body: Buffer.concat(parts) }));
  }));
  const file = readFileSync(new URL('../public/app.js', import.meta.url));
  const br = await raw('/app.js', 'gzip, deflate, br');
  assert.equal(br.h['content-encoding'], 'br');
  assert.ok(br.body.length < file.length * 0.4, `brotli ${br.body.length} vs ${file.length}`);
  assert.deepEqual(brotliDecompressSync(br.body), file);
  const gz = await raw('/app.js', 'gzip');
  assert.equal(gz.h['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(gz.body), file);
  const plain = await raw('/app.js');
  assert.equal(plain.h['content-encoding'], undefined);
  assert.deepEqual(plain.body, file);
  assert.equal((await raw('/icon-192.png', 'br')).h['content-encoding'], undefined, 'PNGs are sent as-is');
  assert.equal((await fetch(`${app}/api/kalshi/markets?series_ticker=KXBTC15M&status=open`)).status, 200); // fetch decodes it transparently
});

test('Kalshi account reads: signed GETs to portfolio only, headers forwarded, never cached, 401 becomes 403', async () => {
  const seen = [];
  const kal = http.createServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['kalshi-access-key'], ts: req.headers['kalshi-access-timestamp'], sig: req.headers['kalshi-access-signature'] });
    res.setHeader('content-type', 'application/json');
    if (req.headers['kalshi-access-key'] === 'bad-key-0000') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    res.end(JSON.stringify({ fills: [{ n: seen.length }] }));
  });
  await new Promise((r) => kal.listen(0, r));
  // Same handler the server uses, aimed at a mock Kalshi
  const { kalshiAuthFor } = await import('../server.js');
  const handler = kalshiAuthFor(`http://127.0.0.1:${kal.address().port}/trade-api/v2`);
  const srv = http.createServer((req, res) => handler(req, res, req.url.split('?')[0].split('/').pop(), new URL(req.url, 'http://x')));
  await new Promise((r) => srv.listen(0, r));
  const at = `http://127.0.0.1:${srv.address().port}/api/kalshi-auth`;
  const h = { 'x-kalshi-key': 'good-key-1234', 'x-kalshi-ts': '1700000000000', 'x-kalshi-sig': 'A'.repeat(344) };
  const info = await (await fetch(`${at}/info`)).json();
  assert.equal(info.pathPrefix, '/trade-api/v2/portfolio/');
  const r1 = await fetch(`${at}/fills?min_ts=1&limit=200&evil=1`, { headers: h });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('cache-control'), 'no-store, private');
  assert.deepEqual(seen[0], { url: '/trade-api/v2/portfolio/fills?min_ts=1&limit=200', key: 'good-key-1234', ts: '1700000000000', sig: 'A'.repeat(344) });
  await fetch(`${at}/fills?min_ts=1&limit=200`, { headers: h });
  assert.equal(seen.length, 2, 'not cached');
  assert.equal((await fetch(`${at}/orders-create`, { headers: h })).status, 404);
  assert.equal((await fetch(`${at}/fills`)).status, 400, 'unsigned requests are refused');
  assert.equal((await fetch(`${at}/balance`, { headers: { ...h, 'x-kalshi-key': 'bad-key-0000' } })).status, 403);
  // Through the real app server: GET only
  assert.equal((await fetch(`${app}/api/kalshi-auth/fills`, { method: 'POST', headers: h })).status, 405);
  srv.close(); kal.close();
});

test('orders: only checked fill-now orders on the BTC 15-minute markets reach Kalshi; demo goes to the demo exchange', async () => {
  const got = [];
  const mk = (name) => http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { got.push({ at: name, method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null }); res.setHeader('content-type', 'application/json'); res.end('{"order":{"fill_count":"2.00"}}'); });
  });
  const kal = mk('live'), demo = mk('demo');
  await new Promise((r) => kal.listen(0, r)); await new Promise((r) => demo.listen(0, r));
  const { kalshiAuthFor, validateOrder } = await import('../server.js');
  const handler = kalshiAuthFor(`http://127.0.0.1:${kal.address().port}/trade-api/v2`, `http://127.0.0.1:${demo.address().port}/trade-api/v2`);
  const srv = http.createServer((req, res) => handler(req, res, req.url.split('?')[0].split('/').pop(), new URL(req.url, 'http://x')));
  await new Promise((r) => srv.listen(0, r));
  const at = `http://127.0.0.1:${srv.address().port}/api/kalshi-auth`;
  const h = { 'x-kalshi-key': 'good-key-1234', 'x-kalshi-ts': '1700000000000', 'x-kalshi-sig': 'B'.repeat(88), 'content-type': 'application/json' };
  const order = { ticker: 'KXBTC15M-26OCT05-T1', client_order_id: 'abcd-1234-efgh', side: 'bid', count: '3.00', price: '0.4500', time_in_force: 'immediate_or_cancel', reduce_only: false, self_trade_prevention_type: 'taker_at_cross' };
  try {
    assert.equal(validateOrder(order), null);
    assert.match(validateOrder({ ...order, time_in_force: 'good_till_canceled' }), /fill-now/);
    assert.match(validateOrder({ ...order, ticker: 'KXPRES-28' }), /BTC 15-minute/);
    assert.match(validateOrder({ ...order, price: '0.4550' }), /whole cents/);
    assert.match(validateOrder({ ...order, count: '500.00', price: '0.9000' }), /cap/);
    assert.equal(validateOrder({ ...order, count: '500.00', price: '0.9000', side: 'ask', reduce_only: true }), null, 'sells are not capped');
    assert.match(validateOrder({ ...order, expiration_time: 1 }), /not allowed/);
    const r = await fetch(`${at}/orders`, { method: 'POST', headers: h, body: JSON.stringify(order) });
    assert.equal(r.status, 200);
    assert.deepEqual(got[0], { at: 'live', method: 'POST', url: '/trade-api/v2/portfolio/events/orders', body: order });
    await fetch(`${at}/orders`, { method: 'POST', headers: { ...h, 'x-kalshi-env': 'demo' }, body: JSON.stringify(order) });
    assert.equal(got[1].at, 'demo');
    const bad = await fetch(`${at}/orders`, { method: 'POST', headers: h, body: JSON.stringify({ ...order, time_in_force: 'good_till_canceled' }) });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error.message, /order refused/);
    assert.equal((await fetch(`${at}/orders`, { method: 'DELETE', headers: h })).status, 405, 'cancelling');
    assert.equal((await fetch(`${at}/orders`, { headers: h })).status, 404, 'reading orders');
    assert.equal((await fetch(`${at}/positions`, { method: 'POST', headers: h, body: '{}' })).status, 405);
    assert.equal(got.length, 2, 'nothing else reached Kalshi');
  } finally { srv.close(); kal.close(); demo.close(); }
});
