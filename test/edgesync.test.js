import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createAccess } from '../access.js';
import { createEdgeSync } from '../edgesync.js';
import worker, { offline } from '../cloudflare/worker.js';

const SECRET = 'test-access-secret-0123456789', EDGE = 'edge-secret-xyz';
const PUBLIC = new URL('../public/', import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const ASSETS = { fetch: async (req) => { const p = new URL(req.url).pathname; try { return new Response(readFileSync(new URL(`.${p}`, PUBLIC)), { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream' } }); } catch { return new Response('not found', { status: 404 }); } } };
// Cloudflare KV, in memory
const kv = () => { const m = new Map(); return { get: async (k, type) => (m.has(k) ? (type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, m }; };
const quiet = { log() {}, warn() {}, error() {} };
const at = (path, init = {}) => new Request(`https://shotcaller.example.com${path}`, init);
const post = (path, body, cookie) => at(path, { method: 'POST', body: JSON.stringify(body), headers: cookie ? { cookie } : {} });
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];

function setup() {
  const env = { ORIGIN: 'https://home.example.com', ACCESS_SECRET: SECRET, EDGE_SECRET: EDGE, ADMIN_CODE: 'Boss123', ASSETS, EDGE_KV: kv() };
  const access = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'es-')), 'a.json'), env: { ACCESS_SECRET: SECRET }, log: quiet });
  // the server reaching the Worker (the home server itself is off: every other request falls through to the backup)
  const fetchImpl = async (url, init = {}) => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('home server off'); };
    try { return await worker.fetch(new Request(url, init), env); } finally { globalThis.fetch = real; }
  };
  const sync = createEdgeSync({ access, base: 'https://shotcaller.example.com', secret: EDGE, fetchImpl, log: quiet });
  return { env, access, sync };
}

test('the backup\'s member storage answers only the server, with the edge secret', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(at('/__edge/changes'), env)).status, 403);
  assert.equal((await worker.fetch(at('/__edge/changes', { headers: { 'x-sc-edge': 'guess' } }), env)).status, 403);
  const r = await worker.fetch(at('/__edge/changes', { headers: { 'x-sc-edge': EDGE } }), env);
  assert.deepEqual(await r.json(), { changes: {} });
});

test('server off: a member signs in with their code from the copied list; a revoked code does not', async () => {
  const { env, access, sync } = setup();
  await access.load();
  access.approve({ code: 'SC-ABCDEF', days: 10 });
  access.approve({ code: 'SC-GHJKMN', days: 10 }); access.revoke({ code: 'SC-GHJKMN' });
  await sync.sync();
  const r = await offline(post('/api/access/redeem', { code: 'sc abcdef' }), env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.access, true); assert.equal(body.code, 'SC-ABCDEF');
  const cookie = cookieOf(r);
  assert.equal((await offline(at('/app.js', { headers: { cookie } }), env)).status, 200);
  assert.equal((await offline(post('/api/access/redeem', { code: 'SC-GHJKMN' }), env)).status, 404, 'revoked');
  assert.equal((await offline(post('/api/access/redeem', { code: 'SC-ZZZZZZ' }), env)).status, 404, 'unknown');
});

test('server off: a new buyer gets a code and pays; the admin approves; the buyer is in; the server takes it all back', async () => {
  const { env, access, sync } = setup();
  await access.load();
  await sync.sync(); // the backup has the (empty) list and the price
  // the buyer
  const req1 = await offline(post('/api/access/request', { device: 'd1' }), env);
  const buyer = await req1.json(), bc = cookieOf(req1);
  assert.match(buyer.code, /^SC-[A-HJ-NP-Z2-9]{6}$/); assert.equal(buyer.state, 'pending'); assert.equal(buyer.access, false); assert.equal(buyer.price, 5);
  const again = await (await offline(post('/api/access/request', {}, bc), env)).json();
  assert.equal(again.code, buyer.code, 'asking again keeps the same code');
  assert.ok((await (await offline(post('/api/access/paid', {}, bc), env)).json()).paidAt, 'I\'ve paid');
  assert.equal((await offline(at('/app.js', { headers: { cookie: bc } }), env)).status, 401, 'not before approval');
  // the admin, offline too
  const adm = cookieOf(await offline(post('/api/access/admin', { code: 'boss123' }), env));
  const list = await (await offline(at('/api/admin/members', { headers: { cookie: adm } }), env)).json();
  assert.deepEqual(list.members.map((m) => [m.code, m.status]), [[buyer.code, 'pending']]);
  const ok = await offline(post('/api/admin/approve', { code: buyer.code, days: 30 }, adm), env);
  assert.equal(ok.status, 200);
  assert.equal((await (await offline(at('/api/access/status', { headers: { cookie: bc } }), env)).json()).access, true, 'approved: the buyer is in');
  assert.equal((await offline(at('/app.js', { headers: { cookie: bc } }), env)).status, 200);
  // the server comes back: the buyer and the approval are merged, and the backup's change list empties
  let paidPings = 0;
  const access2 = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'es-')), 'b.json'), env: { ACCESS_SECRET: SECRET }, log: quiet, onPaid: () => { paidPings++; } });
  await access2.load();
  const sync2 = createEdgeSync({ access: access2, base: 'https://shotcaller.example.com', secret: EDGE, fetchImpl: (u, i) => worker.fetch(new Request(u, i), env), log: quiet });
  const res = await sync2.sync();
  assert.equal(res.merged, 1);
  const m = access2.exportMembers().members.find((x) => x.code === buyer.code);
  assert.equal(m.status, 'active'); assert.ok(m.expires > Date.now() + 29 * 86400000); assert.equal(m.viaBackup, true);
  const left = await (await worker.fetch(at('/__edge/changes', { headers: { 'x-sc-edge': EDGE } }), env)).json();
  assert.deepEqual(left.changes, {}, 'merged changes leave the backup');
  assert.equal(access2.redeem(buyer.code, '1.1.1.1', 'd1').status, 200, 'and the code works on the server');
  assert.equal(paidPings, 0, 'already approved: no "payment to verify" ping');
});

test('merging: the newer side wins, and a payment made on the backup pings the admin', async () => {
  const access = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'es-')), 'c.json'), env: { ACCESS_SECRET: SECRET }, log: quiet, onPaid: (m) => pings.push(m.code) });
  const pings = [];
  await access.load();
  access.approve({ code: 'SC-ABCDEF', days: 10 });
  const ours = access.exportMembers().members[0];
  const stale = { ...ours, status: 'revoked', updatedAt: ours.updatedAt - 1000 };
  assert.equal(access.mergeEdge({ [ours.code]: stale }).merged, 0, 'older than ours: ignored');
  const t = Date.now() + 1000;
  const r = access.mergeEdge({ 'SC-PQRSTU': { code: 'SC-PQRSTU', status: 'pending', createdAt: t, paidAt: t, approvedAt: null, expires: 0, updatedAt: t }, 'SC-BAD': { code: 'nope', status: 'active', updatedAt: t } });
  assert.equal(r.merged, 1); assert.deepEqual(Object.keys(r.ack), ['SC-PQRSTU']);
  assert.deepEqual(pings, ['SC-PQRSTU']);
});
