import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createAccess } from '../access.js';
import worker, { offline, verifyPass } from '../cloudflare/worker.js';

const SECRET = 'test-access-secret-0123456789';
const PUBLIC = new URL('../public/', import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
// the Worker's static assets binding, served from public/
const ASSETS = { fetch: async (req) => { const p = new URL(req.url).pathname; try { return new Response(readFileSync(new URL(`.${p}`, PUBLIC)), { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream' } }); } catch { return new Response('not found', { status: 404 }); } } };
const env = { ORIGIN: 'https://home.example.com', ACCESS_SECRET: SECRET, EDGE_SECRET: 'edge-secret-abc', ADMIN_CODE: 'Boss123', ASSETS };
const at = (path, init = {}) => new Request(`https://shotcaller.example.com${path}`, init);

// a real member's pass, made by the server's own access.js with the same secret
async function memberPass() {
  const a = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'wk-')), 'a.json'), env: { ACCESS_SECRET: SECRET }, log: { log() {}, warn() {}, error() {} } });
  await a.load();
  a.approve({ code: 'SC-ABCDEF', days: 10 });
  const r = a.redeem('SC-ABCDEF', '1.2.3.4', 'dev');
  return r.body.pass;
}
const cookieFrom = (r) => r.headers.get('set-cookie').split(';')[0];

function withFetch(fn, impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = real; });
}

test('a pass signed by the server is accepted, a forged one is not', async () => {
  const pass = await memberPass();
  const p = await verifyPass(pass, SECRET);
  assert.equal(p.t, 'm'); assert.equal(p.c, 'SC-ABCDEF');
  assert.equal(await verifyPass(pass, 'another-secret'), null);
  assert.equal(await verifyPass(pass.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), SECRET), null);
});

test('home server up: requests go to it, with the visitor\'s address and the edge secret', async () => {
  let seen;
  await withFetch(async () => {
    const r = await worker.fetch(at('/api/record', { headers: { 'cf-connecting-ip': '9.9.9.9', cookie: 'sc_session=x' } }), env);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{"from":"home"}');
  }, async (url, init) => { seen = { url: String(url), h: init.headers }; return new Response('{"from":"home"}', { headers: { 'content-type': 'application/json' } }); });
  assert.equal(seen.url, 'https://home.example.com/api/record');
  assert.equal(seen.h.get('x-sc-client-ip'), '9.9.9.9');
  assert.equal(seen.h.get('x-sc-edge'), 'edge-secret-abc');
  assert.equal(seen.h.get('cookie'), 'sc_session=x');
});

test('the app\'s own errors pass through; Cloudflare\'s dead-tunnel page means "down"', async () => {
  await withFetch(async () => {
    const r = await worker.fetch(at('/api/kalshi/markets'), env);
    assert.equal(r.status, 502, 'the server\'s JSON 502 is the server talking, not a dead tunnel');
  }, async () => new Response('{"error":"upstream failed"}', { status: 502, headers: { 'content-type': 'application/json' } }));
  await withFetch(async () => {
    const r = await worker.fetch(at('/'), env);
    assert.match(await r.text(), /<html/i, 'a 530 tunnel error: the backup serves the website');
  }, async () => new Response('<html>Error 1033</html>', { status: 530, headers: { 'content-type': 'text/html' } }));
});

test('home server down: the website is public, the app and its data need a sign-in', async () => {
  const site = await offline(at('/'), env);
  assert.match(await site.text(), /<html/i);
  assert.equal((await offline(at('/paywall.html'), env)).status, 200);
  const app = await offline(at('/app.js'), env);
  assert.equal(app.status, 401); assert.equal(app.headers.get('x-paywall'), '1');
  assert.equal((await offline(at('/api/kalshi/markets'), env)).status, 401);
  const st = await (await offline(at('/api/access/status'), env)).json();
  assert.equal(st.access, false); assert.equal(st.offline, true);
});

test('home server down: a member gets back in with their saved pass, then gets the app and live prices', async () => {
  const pass = await memberPass();
  const r = await offline(at('/api/access/restore', { method: 'POST', body: JSON.stringify({ pass, device: 'dev' }) }), env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.access, true); assert.equal(body.code, 'SC-ABCDEF'); assert.equal(body.pass, pass, 'the phone keeps its pass');
  const cookie = cookieFrom(r);
  assert.match(cookie, /^sc_edge=/);
  const app = await offline(at('/', { headers: { cookie } }), env);
  const html = await app.text();
  assert.match(html, /Backup mode/); assert.match(html, /SC_BUILD/);
  assert.equal((await offline(at('/app.js', { headers: { cookie } }), env)).status, 200);
  await withFetch(async () => {
    const k = await offline(at('/api/kalshi/markets?series_ticker=KXBTC15M', { headers: { cookie } }), env);
    assert.equal(k.status, 200);
    assert.equal((await offline(at('/api/kalshi/portfolio/balance', { headers: { cookie } }), env)).status, 404, 'only the read-only market paths');
  }, async (url) => { assert.match(String(url), /^https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/markets\?series_ticker=KXBTC15M$/); return new Response('{"markets":[]}'); });
  const rec = await offline(at('/api/record', { headers: { cookie } }), env);
  assert.equal(rec.status, 503); assert.equal((await rec.json()).offline, true);
});

test('home server down: a forged cookie or a bad pass gets nowhere; buying a code waits for the server', async () => {
  assert.equal((await offline(at('/app.js', { headers: { cookie: 'sc_edge=eyJ0IjoiYSJ9.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }), env)).status, 401);
  assert.equal((await offline(at('/api/access/restore', { method: 'POST', body: JSON.stringify({ pass: 'nope.nope' }) }), env)).status, 401);
  assert.equal((await offline(at('/api/access/request', { method: 'POST', body: '{}' }), env)).status, 503);
  const admin = await offline(at('/api/access/admin', { method: 'POST', body: JSON.stringify({ code: 'boss123' }) }), env);
  assert.equal(admin.status, 200, 'the admin code works, case-insensitively');
  assert.equal((await offline(at('/api/access/admin', { method: 'POST', body: JSON.stringify({ code: 'wrong' }) }), env)).status, 503);
  const noSecret = await offline(at('/api/access/restore', { method: 'POST', body: JSON.stringify({ pass: await memberPass() }) }), { ...env, ACCESS_SECRET: '' });
  assert.equal(noSecret.status, 503, 'without the secret it signs no one in');
});

test('home server down: the order book is read straight from Kraken', async () => {
  const pass = await memberPass();
  const cookie = cookieFrom(await offline(at('/api/access/restore', { method: 'POST', body: JSON.stringify({ pass }) }), env));
  const side = (from, step) => Array.from({ length: 50 }, (_, i) => [String(from + step * i), '1', 0]);
  await withFetch(async () => {
    const b = await (await offline(at('/api/book', { headers: { cookie } }), env)).json();
    assert.equal(b.source, 'Kraken'); assert.equal(b.offline, true); assert.equal(b.bid, 100); assert.deepEqual(b.events, []);
  }, async (url) => { assert.match(String(url), /pair=XBTUSD/); return new Response(JSON.stringify({ error: [], result: { XXBTZUSD: { bids: side(100, -0.01), asks: side(100.02, 0.01) } } })); });
});
