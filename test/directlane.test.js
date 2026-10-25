import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';
import { directOrigin } from '../server.js';

const env = { ORIGIN: 'https://home.shotcaller.example.com', ACCESS_SECRET: 'test-access-secret-0123456789', EDGE_SECRET: 'e' };
const at = (path, init = {}) => new Request(`https://shotcaller.example.com${path}`, init);
async function withFetch(impl, fn) { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } }

test('server up: the Worker tells the app the server\'s own address, and copies the sign-in onto the whole domain', async () => {
  const r = await withFetch(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'sc_session=T1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure' } }),
    () => worker.fetch(at('/api/access/redeem', { method: 'POST', body: '{}' }), env));
  assert.equal(r.headers.get('x-sc-direct'), 'https://home.shotcaller.example.com');
  const set = r.headers.getSetCookie();
  assert.equal(set.length, 2, 'the server\'s own cookie, and the copy for the whole domain');
  assert.match(set[1], /^sc_session=T1;.*; Domain=shotcaller\.example\.com$/);
});

test('signed in before the direct lane: the cookie is copied once', async () => {
  const ok = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  const r = await withFetch(ok, () => worker.fetch(at('/api/state', { headers: { cookie: 'sc_session=OLD' } }), env));
  assert.deepEqual(r.headers.getSetCookie().map((c) => c.split(';')[0]), ['sc_session=OLD', 'sc_dom=1']);
  assert.match(r.headers.getSetCookie()[0], /Domain=shotcaller\.example\.com/);
  const again = await withFetch(ok, () => worker.fetch(at('/api/state', { headers: { cookie: 'sc_session=OLD; sc_dom=1' } }), env));
  assert.deepEqual(again.headers.getSetCookie(), []);
});

test('server down, or an origin that isn\'t a subdomain: no direct address', async () => {
  const down = await withFetch(async () => { throw new Error('off'); }, () => worker.fetch(at('/api/state'), env));
  assert.equal(down.headers.get('x-sc-direct'), null);
  const other = await withFetch(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }), () => worker.fetch(at('/api/state'), { ...env, ORIGIN: 'https://elsewhere.example.net' }));
  assert.equal(other.headers.get('x-sc-direct'), null);
});

test('the server lets only its parent domain\'s https pages read the API', () => {
  const req = (origin, host = 'home.shotcaller.example.com') => ({ headers: { origin, host } });
  assert.equal(directOrigin(req('https://shotcaller.example.com')), true);
  assert.equal(directOrigin(req('http://shotcaller.example.com')), false);
  assert.equal(directOrigin(req('https://evil.com')), false);
  assert.equal(directOrigin(req('https://com', 'home.com')), false);
  assert.equal(directOrigin(req('https://example.com')), false, 'only one level up');
  assert.equal(directOrigin(req(undefined)), false);
  assert.equal(directOrigin(req('https://shotcaller.example.com', 'localhost:8080')), false);
});
