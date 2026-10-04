import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccess, normalizeCode } from '../access.js';
import { fakeBrowser, fakePushService } from './helpers.js';

// ---------- access module ----------
test('normalizeCode', () => {
  assert.equal(normalizeCode(' sc-7kq2x4 '), 'SC-7KQ2X4');
  assert.equal(normalizeCode('7kq2x4'), 'SC-7KQ2X4');
  assert.equal(normalizeCode(''), '');
});

test('buyer flow: request, paid (admins pinged), approve, expire', async () => {
  let t = 1_700_000_000_000;
  const pings = [];
  const a = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json'), env: { ADMIN_CODE: 'profitbb' }, clock: () => t, onPaid: (m) => pings.push(m.code), log: { warn() {}, error() {} } });
  await a.load();
  const r = a.request(null, '1.1.1.1');
  assert.match(r.body.code, /^SC-[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(r.body.access, false);
  assert.equal(r.body.price, 20);
  assert.equal(r.body.cashtag, 'Akizzle55');
  assert.equal(a.request(r.token, '1.1.1.1').body.code, r.body.code, 'same visitor keeps their code');

  a.paid(r.token);
  a.paid(r.token);
  assert.deepEqual(pings, [r.body.code], 'admins pinged once');
  a.approve({ code: r.body.code });
  assert.equal(a.hasAccess(r.token), true);
  assert.equal(a.statusBody(r.token).state, 'active');

  t += 31 * 86400000;
  assert.equal(a.hasAccess(r.token), false);
  assert.equal(a.statusBody(r.token).state, 'expired');
  a.paid(r.token); // renewal with the same code pings again
  assert.equal(pings.length, 2);
  a.approve({ code: r.body.code, days: 7 });
  assert.equal(a.hasAccess(r.token), true);
});

test('admin code: built-in PROFITBB, override, both boxes, failure-only lockout', async () => {
  const a = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json'), env: { ADMIN_CODE: 'PROFITBB' }, log: { warn() {}, error() {} } });
  await a.load();
  assert.equal(a.admin('nope', '2.2.2.2').status, 403);
  const ok = a.admin('profitbb', '2.2.2.2');
  assert.equal(ok.status, 200);
  assert.equal(a.isAdminToken(ok.token), true);
  assert.equal(a.hasAccess(ok.token), true);
  for (let i = 0; i < 10; i++) a.admin('x', '3.3.3.3');
  assert.equal(a.admin('PROFITBB', '3.3.3.3').status, 429, 'guessing is throttled per IP');
  // Built-in default works with no ADMIN_CODE set, in either box, any case, with spaces
  const builtIn = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'b.json'), env: {}, log: { warn() {}, error() {} } });
  await builtIn.load();
  assert.equal(builtIn.admin(' ProfitBB ', '4.4.4.4').status, 200);
  const viaRedeem = builtIn.redeem('profitbb', '4.4.4.5');
  assert.equal(viaRedeem.status, 200);
  assert.equal(builtIn.isAdminToken(viaRedeem.token), true, 'admin code also works in the "enter your code" box');
  assert.equal(builtIn.admin('PROFITB', '4.4.4.4').status, 403);
  // ADMIN_CODE overrides the built-in code
  const custom = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'c.json'), env: { ADMIN_CODE: 'other' }, log: { warn() {}, error() {} } });
  await custom.load();
  assert.equal(custom.admin('PROFITBB', '5.5.5.5').status, 403);
  assert.equal(custom.admin('OTHER', '5.5.5.5').status, 200);
  // Only wrong codes count toward the lockout: 7 wrong + right still gets in
  const lim = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'd.json'), env: {}, log: { warn() {}, error() {} } });
  await lim.load();
  for (let i = 0; i < 7; i++) lim.admin('nope', '6.6.6.6');
  assert.equal(lim.admin('PROFITBB', '6.6.6.6').status, 200);
  for (let i = 0; i < 5; i++) assert.equal(lim.admin('PROFITBB', '6.6.6.7').status, 200, 'successful logins never lock you out');
});

test('redeem on other devices (max 3), revoke kicks everyone, deny', async () => {
  const a = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json'), env: {}, log: { warn() {}, error() {} } });
  await a.load();
  const r = a.request(null, 'ip');
  a.approve({ code: r.body.code });
  const devs = [1, 2, 3].map((i) => a.redeem(r.body.code.toLowerCase(), `ip${i}`).token);
  assert.equal(a.hasAccess(devs[2]), true);
  assert.equal(a.hasAccess(r.token), false, 'oldest device dropped past 3');
  assert.equal(a.redeem('SC-NOPE99', 'ip').status, 404);
  a.revoke({ code: r.body.code });
  assert.ok(devs.every((d) => !a.hasAccess(d)));
  assert.equal(a.redeem(r.body.code, 'ip').status, 404, 'revoked code cannot be redeemed');
  const r2 = a.request(null, 'ip9');
  a.deny({ code: r2.body.code });
  assert.notEqual(a.request(r2.token, 'ip9').body.code, r2.body.code, 'denied buyer gets a fresh code');
});

test('persists to disk', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json');
  const a = createAccess({ file, env: {}, log: { warn() {}, error() {} } });
  await a.load();
  const r = a.request(null, 'ip');
  a.approve({ code: r.body.code });
  await a.save();
  const b = createAccess({ file, env: {}, log: { warn() {}, error() {} } });
  await b.load();
  assert.equal(b.hasAccess(r.token), true);
});

// ---------- server gate ----------
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shot-pw-'));
process.env.ADMIN_CODE = 'PROFITBB';
process.env.PUSH_HOST_ALLOW = '127.0.0.1';
delete process.env.PAYWALL;
const upstream = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ markets: [], price: '1' })); });
await new Promise((r) => upstream.listen(0, r));
process.env.KALSHI_API = process.env.COINBASE_API = `http://127.0.0.1:${upstream.address().port}`;
const { server, bot } = await import('../server.js');
await new Promise((r) => server.listen(0, r));
const app = `http://127.0.0.1:${server.address().port}`;
const svc = await fakePushService();
test.after(() => { server.close(); upstream.close(); svc.server.close(); bot.stop(); });

const jar = () => {
  let cookie = '';
  return async (path, body) => {
    const r = await fetch(app + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
};

test('without access: paywall page, open assets only, APIs locked', async () => {
  const get = jar();
  const home = await (await get('/')).text();
  assert.match(home, /paywall\.js/);
  assert.doesNotMatch(home, /app\.js/);
  assert.equal((await get('/icon-192.png')).headers.get('content-type'), 'image/png');
  assert.equal((await get('/manifest.webmanifest')).status, 200);
  for (const p of ['/app.js', '/engine.js', '/model.js', '/api/kalshi/markets?series_ticker=X', '/api/push/key', '/api/admin/members']) {
    assert.ok([401, 403].includes((await get(p)).status), p);
  }
  assert.equal((await get('/api/push/sync', {})).status, 401);
});

test('buyer pays, admin approves from the app, buyer is unlocked', async () => {
  const buyer = jar(), admin = jar();
  // Admin logs in with the bypass code and turns on push
  assert.equal((await admin('/api/access/admin', { code: 'wrong' })).status, 403);
  assert.equal((await admin('/api/access/admin', { code: 'profitbb' })).status, 200);
  assert.match(await (await admin('/')).text(), /app\.js/, 'admin sees the app');
  const phone = fakeBrowser();
  assert.equal((await admin('/api/push/sync', { subscription: { endpoint: `${svc.base}/push/admin`, keys: phone.keys }, settings: {}, positions: [] })).status, 200);

  const st = await (await buyer('/api/access/request', {})).json();
  assert.match(st.code, /^SC-/);
  assert.equal((await buyer('/app.js')).status, 401);
  await buyer('/api/access/paid', {});
  await new Promise((r) => setTimeout(r, 50));
  const ping = JSON.parse(phone.decrypt(svc.received.at(-1).body));
  assert.match(ping.title, new RegExp(`Payment to verify: ${st.code}`));
  assert.match(ping.body, /\$20 to \$Akizzle55/);

  const list = await (await admin('/api/admin/members')).json();
  assert.ok(list.members.some((m) => m.code === st.code && m.paidAt));
  assert.equal((await buyer('/api/admin/approve', { code: st.code })).status, 403, 'buyers cannot approve themselves');
  assert.equal((await admin('/api/admin/approve', { code: st.code })).status, 200);
  assert.equal((await (await buyer('/api/access/status')).json()).access, true);
  assert.match(await (await buyer('/')).text(), /app\.js/);
  assert.equal((await buyer('/app.js')).status, 200);
  assert.match(await (await buyer('/paywall.html')).text(), /app\.js/, 'paid users skip the paywall');

  // Admin changes the price
  await admin('/api/admin/config', { price: 25, days: 14 });
  const fresh = await (await jar()('/api/access/status')).json();
  assert.equal(fresh.price, 25);
  assert.equal(fresh.days, 14);

  // Revoke: locked out again
  await admin('/api/admin/revoke', { code: st.code });
  assert.equal((await buyer('/app.js')).status, 401);
});

test('every user gets their own random payment code; the same user keeps theirs', async () => {
  const a = createAccess({ file: join(mkdtempSync(join(tmpdir(), 'acc-')), 'u.json'), env: {}, log: { warn() {}, error() {} } });
  await a.load();
  const codes = [], tokens = [];
  for (let i = 0; i < 500; i++) { const r = a.request(null, `10.1.${i >> 8}.${i & 255}`); codes.push(r.body.code); tokens.push(r.token); }
  assert.equal(new Set(codes).size, 500, 'no two users share a code');
  assert.ok(codes.every((c) => /^SC-[A-HJ-NP-Z2-9]{6}$/.test(c)));
  const firstChars = new Set(codes.map((c) => c[3]));
  assert.ok(firstChars.size > 20, 'characters are spread across the alphabet, not sequential');
  assert.equal(a.request(tokens[0], '10.1.0.0').body.code, codes[0], 'reopening the paywall on the same phone shows the same code');
});
