import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shot-srv-'));
process.env.PAYWALL = 'off'; // paywall has its own tests
process.env.ADMIN_CODE = 'test-only-admin'; // a throwaway code for the admin-only tests here
delete process.env.ANTHROPIC_API_KEY; // Ask's AI is off here (askai.test.js tests it with a stand-in client)

// Mock upstream standing in for both Kalshi and Coinbase.
const upstream = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/markets?')) return res.end(JSON.stringify({ markets: [{ ticker: 'KXBTC15M-T1', close_time: new Date(Date.now() + 300000).toISOString() }] }));
  if (req.url.startsWith('/markets/KXREFUSED')) { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
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

test('/healthz says which version is live', async () => {
  const { createRequire } = await import('node:module');
  const h = await (await fetch(`${app}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.version, createRequire(import.meta.url)('../package.json').version);
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

test('Discord role routes: status says off without config, linking needs a member, a stray callback goes back to the app', async () => {
  const st = await (await fetch(`${app}/api/discord/status`)).json();
  assert.equal(st.on, false); assert.equal(st.member, false); assert.equal(st.missing, undefined, 'which variables are missing: admins only');
  assert.equal((await fetch(`${app}/api/discord/link`, { method: 'POST', body: '{}' })).status, 400);
  const cb = await fetch(`${app}/api/discord/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /^\/\?discord=error&msg=/);
});

test('Ask without an API key: the free market answers, from the live lookups, at no cost', async () => {
  assert.deepEqual(await (await fetch(`${app}/api/ask`)).json(), { ai: false, model: null, markets: true, free: true });
  const r = await fetch(`${app}/api/ask`, { method: 'POST', body: JSON.stringify({ q: 'should I buy?', facts: { coin: 'BTC' } }) });
  assert.equal(r.status, 200); const d = await r.json();
  assert.equal(d.free, true); assert.equal(d.intent, 'buy'); assert.match(d.answer, /Bitcoin/); assert.match(d.answer, /not financial advice/);
  assert.equal((await fetch(`${app}/api/ask`, { method: 'POST', body: JSON.stringify({ q: '  ' }) })).status, 400);
});

test('the X-ray tab\'s server stats: forced closes and funding for crypto', async () => {
  const r = await (await fetch(`${app}/api/xray`)).json();
  assert.equal(typeof r.liqs?.n, 'number'); assert.ok('futures' in r);
});

test('an upstream 401 reaches the phone as a 502, never as the paywall\'s 401', async () => {
  const r = await fetch(`${app}/api/kalshi/markets/KXREFUSED-1`);
  assert.equal(r.status, 502); assert.equal(r.headers.get('x-paywall'), null);
});

test('a market whose bot isn\'t running yet answers "starting", never with Bitcoin\'s record or learning', async () => {
  for (const p of ['learn', 'pick', 'record', 'index']) {
    const r = await fetch(`${app}/api/${p}?m=KXDOGE15M`);
    assert.equal(r.status, 503, p); assert.equal((await r.json()).starting, true);
  }
  assert.equal((await fetch(`${app}/api/learn`)).status, 200, 'Bitcoin\'s own still answers');
});

test('a made-up market name never starts a bot, and only admins see which Discord variables are missing', async () => {
  const r = await fetch(`${app}/api/record?m=KXBTCMADEUP15M`);
  assert.notEqual(r.status, 500);
  const { stacks } = await import('../server.js');
  assert.equal(stacks.has('KXBTCMADEUP15M'), false);
  assert.equal('missing' in await (await fetch(`${app}/api/discord/status`)).json(), false);
});

test('the live bot-team window and its data: the admin only, paywall or not', async () => {
  for (const p of ['/team-live', '/team-live.html', '/team-live.js', '/api/admin/team']) assert.equal((await fetch(`${app}${p}`)).status, 403, p);
  const login = await fetch(`${app}/api/access/admin`, { method: 'POST', body: JSON.stringify({ code: 'test-only-admin', device: 'dev-live' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], h = { headers: { cookie } };
  const page = await fetch(`${app}/team-live`, h);
  assert.equal(page.status, 200); assert.match(await page.text(), /<title>Bot Team Live<\/title>/);
  assert.equal((await fetch(`${app}/team-live.js`, h)).status, 200);
  const t = await (await fetch(`${app}/api/admin/team`, h)).json();
  assert.ok(t.roster.length >= 45, 'the whole staff'); assert.ok(Array.isArray(t.feed) && Array.isArray(t.talk)); assert.ok('pulse' in t);
  assert.equal(t.markets[0].series, t.series, 'the home market first, and the default');
});

test('the phone\'s own Auto-trader feed: the call and sell checks for what the phone holds, junk ignored, the server trader\'s mode', async () => {
  const r = await fetch(`${app}/api/auto/feed`, { method: 'POST', body: JSON.stringify({ open: [{ ticker: 'KXBTC15M-26OCT201300-00', side: 'YES', price: 0.6, count: 3, closeTime: new Date(Date.now() + 6e5).toISOString(), at: 1 }, { ticker: '../x', side: 'UP' }, null] }) });
  assert.equal(r.status, 200);
  const f = await r.json();
  assert.equal(typeof f.ready, 'boolean'); assert.equal(f.server, 'off');
  if (f.ready) { assert.ok('sig' in f && 'live' in f); assert.ok(Object.keys(f.checks).every((t) => t === 'KXBTC15M-26OCT201300-00')); }
  assert.equal((await fetch(`${app}/api/auto/feed`)).status, 405, 'POST only');
});

test('the hiring center: the admin only; search, approve, and the hire is on the team', async () => {
  assert.equal((await fetch(`${app}/api/admin/hiring`)).status, 403);
  const login = await fetch(`${app}/api/access/admin`, { method: 'POST', body: JSON.stringify({ code: 'test-only-admin', device: 'dev-hire' }) });
  const h = { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } };
  const s = await (await fetch(`${app}/api/admin/hiring`, { ...h, method: 'POST', body: JSON.stringify({ search: true }) })).json();
  const app1 = s.applications.find((a) => a.key === 'restarts');
  assert.ok(app1, 'the Restart watcher always applies'); assert.ok(app1.why && app1.does && app1.cant);
  const after = await (await fetch(`${app}/api/admin/hiring`, { ...h, method: 'POST', body: JSON.stringify({ id: app1.id, decision: 'approve' }) })).json();
  assert.ok(after.hired.some((x) => x.key === 'restarts'));
  assert.equal((await fetch(`${app}/api/admin/hiring`, { ...h, method: 'POST', body: JSON.stringify({ id: 'nope', decision: 'approve' }) })).status, 400);
  await new Promise((r) => setTimeout(r, 1100)); // the live window reads fresh at most once a second
  const t = await (await fetch(`${app}/api/admin/team`, h)).json();
  assert.ok(t.roster.some((r) => r.role === 'h_restarts' && r.trial) && t.roster.some((r) => r.role === 'tr_h_restarts'), 'on the team, on probation, with a trainer');
});
