import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PHONE_MODES, createPhoneTrade } from '../public/phonetrade.js';
import { validateOrder } from '../server.js';

const subtle = webcrypto.subtle;
// the phone's key: non-extractable, as the app imports it (it can sign, nothing can read it back out)
const keys = await subtle.generateKey({ name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign', 'verify']);
const KEY_ID = 'abcd1234-ef56-7890';
const PREFIX = '/trade-api/v2/portfolio/';
const memory = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), raw: m }; };
const live = () => ({ m: { ticker: 'KXBTC15M-T1', close_time: new Date(Date.now() + 10 * 60000).toISOString() }, ev: { minutesLeft: 10, quote: { yesAsk: 0.45 } } });
const sig = { callSide: 'YES', limit: 0.46, contracts: 5, deep: { score: 90 } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settledTest = () => ({ ledger: Array.from({ length: 10 }, (_, i) => ({ ticker: `KXBTC15M-X${i}`, side: 'YES', count: 1, price: 0.5, fees: 0.02, cost: 0.52, at: 1, closeTime: '2026-01-01T00:00:00Z', closed: true, pnl: 0.48 })), log: [], calls: {} });

// our server and, behind its relay, Kalshi: every signed request is verified like Kalshi would, every order checked like the relay does
function fakeServer({ server = 'off', ready = true } = {}) {
  const f = { server, ready, orders: [], signed: 0, bodies: [], cash: 50, pos: 0, feeds: 0 };
  f.fetch = async (url, opts = {}) => {
    const path = url.replace(/^\/api\//, '').split('?')[0], method = opts.method || 'GET', h = opts.headers || {};
    if (opts.body) f.bodies.push(String(opts.body));
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (path === 'auto/feed') { f.feeds++; return reply(200, f.ready ? { ready: true, live: live(), sig, checks: {}, results: {}, server: f.server } : { ready: false, server: f.server }); }
    if (path === 'auto/state') return reply(200, { cfg: { mode: f.server } });
    if (path === 'kalshi-auth/info') return reply(200, { pathPrefix: PREFIX, orderPath: 'events/orders' });
    if (path.startsWith('kalshi/markets/') && path.endsWith('/orderbook')) return reply(200, { orderbook: { yes: [[40, 100]], no: [[55, 100]] } });
    if (path.startsWith('kalshi/markets/')) return reply(200, { market: { result: '' } });
    if (path.startsWith('kalshi-auth/')) {
      const ep = path.slice('kalshi-auth/'.length), signedPath = `${PREFIX}${method === 'POST' ? 'events/orders' : ep}`;
      const ok = h['x-kalshi-key'] === KEY_ID && await subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, keys.publicKey, Buffer.from(h['x-kalshi-sig'] || '', 'base64'), new TextEncoder().encode(`${h['x-kalshi-ts']}${method}${signedPath}`));
      if (!ok) return reply(403, { error: { code: 'unauthorized', message: 'bad signature' } });
      f.signed++;
      if (ep === 'balance') return reply(200, { balance: Math.round(f.cash * 100) });
      if (ep === 'positions') return reply(200, { market_positions: f.pos ? [{ ticker: 'KXBTC15M-T1', position: f.pos }] : [] });
      if (ep === 'orders' && method === 'POST') {
        const o = JSON.parse(opts.body), bad = validateOrder(o);
        if (bad) return reply(422, { error: { code: 'refused_by_shot_caller', message: `order refused: ${bad}` } });
        f.orders.push(o); const n = Number(o.count); f.pos += n; f.cash -= n * 0.4 + 0.1;
        return reply(201, { order: { fill_count: n, status: 'executed', order_id: 'ord-1' } });
      }
    }
    return reply(404, {});
  };
  return f;
}
const phone = (f, { storage = memory(), withKey = true } = {}) => createPhoneTrade({ API: '/api', fetchImpl: f.fetch, storage, cred: () => (withKey ? { key: keys.privateKey, keyId: KEY_ID } : { key: null, keyId: null }), wake: null, doc: null });

test('Test mode on the phone: trades the official call on the simulator, nothing signed, no key needed', async () => {
  const f = fakeServer(), p = phone(f, { withKey: false });
  assert.deepEqual(p.state().modes, PHONE_MODES, 'Off, Test, Live: no Demo on the phone');
  await p.handle('config', { mode: 'test' });
  await wait(1500);
  const s = p.state();
  assert.ok(f.feeds >= 1, 'asked the server for the call');
  assert.equal(f.signed, 0); assert.equal(f.orders.length, 0, 'nothing reaches Kalshi in Test');
  assert.equal(s.today.buys, 1); assert.match(s.log[0].text, /UP/);
  await p.handle('stop');
  assert.equal(p.state().cfg.mode, 'off');
});

test('Live is locked until Test runs clean, needs the phone\'s key and a confirm', async () => {
  const f = fakeServer();
  await assert.rejects(phone(f).handle('config', { mode: 'live', confirm: true }), /Run Test first: Live unlocks after 10 clean Test trades \(0 so far\)/);
  const unlocked = () => memory({ sc_phone_trader: JSON.stringify({ cfg: { mode: 'off' }, st: { test: settledTest() } }) });
  await assert.rejects(phone(f, { storage: unlocked(), withKey: false }).handle('config', { mode: 'live', confirm: true }), /Link your Kalshi key on this phone first/);
  await assert.rejects(phone(f, { storage: unlocked() }).handle('config', { mode: 'live' }), /Live needs confirming/);
  const p = phone(f, { storage: unlocked() });
  assert.equal((await p.handle('config', { mode: 'live', confirm: true })).cfg.mode, 'live');
  await p.handle('stop');
});

test('Live on the phone: the order is signed on the phone, passes the server\'s check, and the key never travels', async () => {
  const f = fakeServer(), storage = memory({ sc_phone_trader: JSON.stringify({ cfg: { mode: 'off' }, st: { test: settledTest() } }) }), p = phone(f, { storage });
  await p.handle('config', { mode: 'live', confirm: true });
  await wait(2500);
  assert.equal(f.orders.length, 1, 'one buy for the call'); assert.ok(f.signed >= 3, 'balance, book check, order: each signed and verified');
  const o = f.orders[0];
  assert.equal(o.ticker, 'KXBTC15M-T1'); assert.equal(o.side, 'bid'); assert.equal(o.time_in_force, 'immediate_or_cancel'); assert.equal(o.reduce_only, false);
  assert.equal(validateOrder(o), null, 'the relay\'s own check passes');
  assert.ok(!f.bodies.some((b) => /PRIVATE|BEGIN/.test(b)), 'no key in any request');
  assert.ok(!storage.raw.get('sc_phone_trader').includes('PRIVATE'), 'none saved either');
  assert.equal(keys.privateKey.extractable, false);
  const s = p.state();
  assert.equal(s.today.buys, 1); assert.match(s.keys.live.keyId, /^abcd1234…$/);
  await p.handle('stop');
});

test('never both: the phone won\'t go Live while the server\'s Auto-trader is on, and pauses if it comes on later', async () => {
  const f = fakeServer({ server: 'live' }), storage = memory({ sc_phone_trader: JSON.stringify({ cfg: { mode: 'off' }, st: { test: settledTest() } }) });
  await assert.rejects(phone(f, { storage }).handle('config', { mode: 'live', confirm: true }), /Auto-trader on the server is on \(Live\): turn it off first/);
  f.server = 'off';
  const p = phone(f, { storage });
  await p.handle('config', { mode: 'live', confirm: true });
  await wait(1500);
  const before = f.orders.length;
  f.server = 'demo'; p.handle('resume');
  await p.step(); await wait(200);
  assert.match(p.state().why, /Paused: your Auto-trader on the server is on \(Demo\)/);
  assert.equal(f.orders.length, before, 'no order while both are on');
  await p.handle('stop');
});

test('honest about the gaps: closed for a while means nothing traded, and it says so; no server reading yet, it waits', async () => {
  const f = fakeServer({ ready: false });
  const p = phone(f, { storage: memory({ sc_phone_trader: JSON.stringify({ cfg: { mode: 'test' }, st: {}, lastAt: Date.now() - 10 * 60000 }) }) });
  await wait(300);
  assert.match(p.state().why, /The app was closed for 10 min: nothing was traded meanwhile\. Waiting for the server's first reading/);
  await p.handle('stop');
});
