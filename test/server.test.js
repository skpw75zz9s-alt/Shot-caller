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
