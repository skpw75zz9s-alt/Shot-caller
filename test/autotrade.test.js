import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoTrade, createVault, signerFor } from '../autotrade.js';
import { validateOrder } from '../server.js';

const SECRET = 'a-long-railway-secret-0123456789';
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_ID = 'abcd1234-ef56-7890';

test('vault: sealed keys open with the secret only; no secret, no vault', () => {
  const v = createVault(SECRET), box = v.seal(PEM);
  assert.ok(!JSON.stringify(box).includes('PRIVATE KEY'));
  assert.equal(v.open(box), PEM);
  assert.throws(() => createVault(`${SECRET}x`).open(box));
  assert.equal(createVault(''), null);
  assert.equal(createVault(undefined), null);
});

test('signatures Kalshi accepts: RSA-PSS (SHA-256, 32-byte salt) and Ed25519', () => {
  const sig = signerFor(PEM)('1700000000000GET/trade-api/v2/portfolio/balance');
  assert.ok(crypto.verify('sha256', Buffer.from('1700000000000GET/trade-api/v2/portfolio/balance'), { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, 'base64')));
  const ed = crypto.generateKeyPairSync('ed25519');
  const s2 = signerFor(ed.privateKey.export({ type: 'pkcs8', format: 'pem' }))('x');
  assert.ok(crypto.verify(null, Buffer.from('x'), ed.publicKey, Buffer.from(s2, 'base64')));
});

// A fake Kalshi behind fetch: checks every signed request, fills IOC orders from a fixed book
function fakeKalshi() {
  const k = { orders: [], cash: 50, pos: 0, signed: 0 };
  k.fetch = async (url, opts = {}) => {
    const u = new URL(url), method = opts.method || 'GET', path = u.pathname;
    const h = opts.headers || {};
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (path.startsWith('/trade-api/v2/portfolio')) {
      const ok = crypto.verify('sha256', Buffer.from(`${h['KALSHI-ACCESS-TIMESTAMP']}${method}${path}`), { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'] || '', 'base64'));
      if (!ok || h['KALSHI-ACCESS-KEY'] !== KEY_ID) return reply(401, { error: { code: 'unauthorized', message: 'bad signature' } });
      k.signed++;
    }
    if (path.endsWith('/portfolio/balance')) return reply(200, { balance: Math.round(k.cash * 100) });
    if (path.endsWith('/portfolio/positions')) return reply(200, { market_positions: k.pos ? [{ ticker: 'KXBTC15M-T1', position: k.pos }] : [] });
    if (path.endsWith('/orderbook')) return reply(200, { orderbook: { yes: [[40, 100]], no: [[55, 100]] } });
    if (path.endsWith('/portfolio/events/orders') && method === 'POST') {
      const o = JSON.parse(opts.body); k.orders.push(o);
      const n = Number(o.count); k.pos += n; k.cash -= n * 0.45 + 0.1;
      return reply(201, { order: { fill_count: n, status: 'executed' } });
    }
    if (/\/markets\/[^/]+$/.test(path)) return reply(200, { market: { result: '' } });
    return reply(404, {});
  };
  return k;
}
const live = { m: { ticker: 'KXBTC15M-T1', close_time: new Date(Date.now() + 10 * 60000).toISOString() }, ev: { minutesLeft: 10, quote: { yesAsk: 0.45 } } };
const snap = { now: Date.now(), bars: [], quoteLog: {}, rows: [], live };
const sig = { callSide: 'YES', limit: 0.46, contracts: 5, deep: { score: 90 } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('keys: checked with Kalshi, stored encrypted, never shown back; no KEY_SECRET means no keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-')), file = join(dir, 'autotrade.json'), k = fakeKalshi();
  const at = createAutoTrade({ file, secret: SECRET, kalshi: 'https://k.test/trade-api/v2', kalshiDemo: 'https://d.test/trade-api/v2', validateOrder, fetchImpl: k.fetch });
  await at.load();
  assert.equal((await at.setKey('m1', { env: 'live', keyId: KEY_ID, pem: 'nope' })).status, 400);
  const bad = await at.setKey('m1', { env: 'live', keyId: 'wrong-key-0000', pem: PEM });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /refused the key/);
  const ok = await at.setKey('m1', { env: 'live', keyId: KEY_ID, pem: PEM });
  assert.equal(ok.status, 200); assert.equal(ok.body.balance, 50);
  const disk = readFileSync(file, 'utf8');
  assert.ok(!disk.includes('PRIVATE KEY') && !disk.includes(PEM.split('\n')[1]), 'nothing readable on disk');
  const st = at.state('m1');
  assert.ok(!JSON.stringify(st).includes('PRIVATE') && st.keys.live.keyId.endsWith('…'));
  assert.equal(at.state('someone-else').keys.live, null, 'keys are per user');
  const none = createAutoTrade({ file: join(dir, 'x.json'), secret: '', kalshi: 'https://k.test/trade-api/v2', kalshiDemo: 'https://d.test/trade-api/v2', validateOrder, fetchImpl: k.fetch });
  assert.equal((await none.setKey('m1', { env: 'live', keyId: KEY_ID, pem: PEM })).status, 503);
});

test('Live is locked until Test runs clean, needs the key and a confirm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-')), k = fakeKalshi();
  const at = createAutoTrade({ file: join(dir, 'a.json'), secret: SECRET, kalshi: 'https://k.test/trade-api/v2', kalshiDemo: 'https://d.test/trade-api/v2', validateOrder, fetchImpl: k.fetch });
  await at.load();
  assert.match((await at.configure('m1', { mode: 'live', confirm: true })).body.error, /Run Test first/);
  assert.match((await at.configure('m1', { mode: 'demo' })).body.error, /demo key/);
  const r = await at.configure('m1', { mode: 'test', perTrade: 500, dailyLoss: 7 });
  assert.equal(r.status, 200); assert.equal(r.body.cfg.mode, 'test');
  assert.equal(r.body.cfg.perTrade, 100, 'clamped to the max'); assert.equal(r.body.cfg.dailyLoss, 7);
});

test('it trades with the phone closed, and picks up where it left off after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-')), file = join(dir, 'a.json'), k = fakeKalshi();
  const mk = () => createAutoTrade({ file, secret: SECRET, kalshi: 'https://k.test/trade-api/v2', kalshiDemo: 'https://d.test/trade-api/v2', validateOrder, fetchImpl: k.fetch });
  let at = mk(); await at.load();
  await at.configure('m1', { mode: 'test' });
  at.step({ snap, sig }); // what the bot does every tick; no phone involved
  await wait(1500);
  let st = at.state('m1');
  assert.equal(st.stats.trades, 1, JSON.stringify(st.log));
  assert.equal(k.orders.length, 0, 'Test sends nothing to Kalshi');
  await at.save();
  at = mk(); await at.load(); // a redeploy
  st = at.state('m1');
  assert.equal(st.cfg.mode, 'test', 'still on after a restart');
  assert.equal(st.stats.trades, 1);
  at.step({ snap, sig }); await wait(800);
  assert.equal(at.state('m1').stats.trades, 1, 'never buys the same call twice, even across a restart');
  assert.equal(at.running(), 1);
  await at.control('m1', 'stop');
  assert.equal(at.state('m1').cfg.mode, 'off'); assert.equal(at.running(), 0);
});

test('Live orders are signed by the server, checked by validateOrder, and fill-now only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-')), file = join(dir, 'a.json'), k = fakeKalshi();
  const at = createAutoTrade({ file, secret: SECRET, kalshi: 'https://k.test/trade-api/v2', kalshiDemo: 'https://d.test/trade-api/v2', validateOrder, fetchImpl: k.fetch });
  await at.load();
  await at.setKey('m1', { env: 'live', keyId: KEY_ID, pem: PEM });
  // pretend Test already ran clean
  const db = JSON.parse(readFileSync(file, 'utf8'));
  db.users.m1.st = { test: { ledger: Array.from({ length: 10 }, (_, i) => ({ closed: true, pnl: 1, at: i, closedAt: i, cost: 1, count: 1 })), log: [], calls: {}, errors: 0, pausedUntil: 0, stopped: null, pending: null } };
  const { writeFileSync } = await import('node:fs'); writeFileSync(file, JSON.stringify(db));
  const at2 = createAutoTrade({ file, secret: SECRET, kalshi: 'https://k.test/trade-api/v2', kalshiDemo: 'https://d.test/trade-api/v2', validateOrder, fetchImpl: k.fetch });
  await at2.load();
  assert.equal((await at2.configure('m1', { mode: 'live' })).status, 409, 'needs the confirm');
  assert.equal((await at2.configure('m1', { mode: 'live', confirm: true })).status, 200);
  at2.step({ snap, sig }); await wait(2000);
  assert.equal(k.orders.length, 1, JSON.stringify(at2.state('m1').log));
  const o = k.orders[0];
  assert.equal(validateOrder(o), null);
  assert.equal(o.time_in_force, 'immediate_or_cancel');
  assert.equal(o.side, 'bid'); assert.equal(o.price, '0.4600');
  assert.ok(k.signed >= 3, 'balance, positions and the order were all signed');
});
