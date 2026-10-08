// The Auto-trader, run by the server around the clock: it keeps trading with your phone closed.
// Each user (member code; 'admin'; or 'local' without the paywall) has their own settings, Kalshi keys and trade
// history. Every bot tick (bot.js, ~5s) it gets the official Steady call and the market snapshot, and steps each
// user's trader (public/trader.js: the same executor the tests hammer against a strict fake Kalshi).
//
// Keys: the private key is encrypted (AES-256-GCM) with a key derived from KEY_SECRET, a Railway variable that is
// never written to disk, and stored in the data volume. Without KEY_SECRET the server refuses to hold keys. Keys are
// only ever used here, to sign requests to Kalshi, and are never sent back to any phone. Every order also passes
// validateOrder (BTC 15-minute markets only, fill-now-or-cancel, the dollar cap) before it leaves.
import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MODES, TRADER_DEFAULTS, cleanLimits, createTestExchange, createTrader, liveUnlocked, parseBook } from './public/trader.js';
import { positionCheck } from './public/engine.js';
import { balanceDollars, parsePosition } from './public/kalshi.js';

const KEY_ENVS = ['live', 'demo'];
const n = (v) => (v == null || v === '' ? null : Number(v));

// ---------- the vault ----------
export function createVault(secret) {
  if (!secret || String(secret).length < 16) return null;
  const k = crypto.createHash('sha256').update(`shot-caller-vault:${secret}`).digest();
  return {
    seal(text) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
      const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), enc: enc.toString('base64') };
    },
    open(box) {
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(box.enc, 'base64')), d.final()]).toString('utf8');
    },
  };
}

// Kalshi's request signature: RSA-PSS (SHA-256, 32-byte salt) or Ed25519 over timestamp + method + path
export function signerFor(pem) {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'ed25519') throw new Error('Use the RSA or Ed25519 private key Kalshi gave you');
  const ed = key.asymmetricKeyType === 'ed25519';
  return (msg) => (ed ? crypto.sign(null, Buffer.from(msg), key)
    : crypto.sign('sha256', Buffer.from(msg), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })).toString('base64');
}

// ---------- talking to Kalshi ----------
function kalshiClient(base, fetchImpl) {
  const prefix = new URL(base).pathname.replace(/\/$/, '');
  async function req(method, path, { cred = null, query = null, body = null } = {}) {
    const q = query ? `?${new URLSearchParams(query)}` : '';
    const headers = { accept: 'application/json', 'user-agent': 'shot-caller/1.0', ...(body ? { 'content-type': 'application/json' } : {}) };
    if (cred) {
      const ts = String(Date.now());
      Object.assign(headers, { 'KALSHI-ACCESS-KEY': cred.keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': cred.sign(`${ts}${method}${prefix}${path}`) });
    }
    let r;
    try { r = await fetchImpl(`${base}${path}${q}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) }); }
    catch (e) { throw { status: 0, message: e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error' }; }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const er = out.error;
      throw { status: r.status, code: (typeof er === 'object' ? er?.code : null) ?? out.code ?? null, message: (typeof er === 'object' ? er?.message : er) || out.message || `HTTP ${r.status}` };
    }
    return out;
  }
  return { req };
}

// The trader's exchange for one user and one environment
function kalshiExchange(k, cred, validateOrder) {
  return {
    async cash() { return { balance: balanceDollars(await k.req('GET', '/portfolio/balance', { cred: cred() })) ?? 0, held: 0 }; }, // net of open orders already
    async book(t) { return parseBook(await k.req('GET', `/markets/${encodeURIComponent(t)}/orderbook`)); },
    async positions(ticker) {
      const b = await k.req('GET', '/portfolio/positions', { cred: cred(), query: { count_filter: 'position', limit: '200', ...(ticker ? { ticker } : {}) } });
      return (b.market_positions || []).map(parsePosition).map((p) => ({ ticker: p.ticker, side: p.side, count: p.contracts }));
    },
    async place(o) {
      const bad = validateOrder(o);
      if (bad) throw { status: 422, code: 'refused_by_shot_caller', message: `order refused: ${bad}` };
      const out = await k.req('POST', '/portfolio/events/orders', { cred: cred(), body: o });
      const x = out.order || out;
      const filled = n(x.fill_count_fp) ?? n(x.fill_count) ?? n(x.taker_fill_count);
      if (filled == null || Number.isNaN(filled)) throw { status: 0, message: 'Kalshi answered without a fill count' }; // checked by position
      return { filled, avgPrice: null, fees: null }; // booked at the max price (the worst case)
    },
  };
}

// ---------- the service ----------
export function createAutoTrade({ file, secret, kalshi, kalshiDemo, validateOrder, settings: botSettings = {}, fetchImpl = fetch, log = console, now = () => Date.now() }) {
  const vault = createVault(secret);
  const api = { live: kalshiClient(kalshi, fetchImpl), demo: kalshiClient(kalshiDemo, fetchImpl) };
  let db = { users: {} }, saveTimer = null;
  const run = {}; // owner -> { traders, exchanges, creds, why, pseudo }
  const results = { live: new Map(), demo: new Map() }, asked = { live: new Map(), demo: new Map() };

  async function load() {
    try { db = JSON.parse(await readFile(file, 'utf8')); db.users ||= {}; } catch { db = { users: {} }; }
  }
  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(db));
      await rename(`${file}.tmp`, file);
    } catch (e) { log.error('saving the auto-trader failed', e.message); }
  }
  const soon = () => { if (!saveTimer) { saveTimer = setTimeout(save, 1500); saveTimer.unref?.(); } };
  const user = (owner) => (db.users[owner] ||= { cfg: { ...TRADER_DEFAULTS }, keys: {}, st: {}, testEx: null });

  function runner(owner) {
    if (run[owner]) return run[owner];
    const u = user(owner);
    const creds = {};
    const cred = (env) => () => {
      if (creds[env]) return creds[env];
      const box = u.keys[env];
      if (!box || !vault) throw { status: 403, message: env === 'demo' ? 'No demo key on the server' : 'No Kalshi key on the server' };
      creds[env] = { keyId: box.keyId, sign: signerFor(vault.open(box)) };
      return creds[env];
    };
    const testEx = createTestExchange({
      getBook: async (t) => parseBook(await api.live.req('GET', `/markets/${encodeURIComponent(t)}/orderbook`)),
      startCash: u.cfg.testCash,
      store: { load: () => u.testEx, save: (x) => { u.testEx = x; soon(); } },
    });
    const exchanges = { test: testEx, demo: kalshiExchange(api.demo, cred('demo'), validateOrder), live: kalshiExchange(api.live, cred('live'), validateOrder) };
    const traders = Object.fromEntries(['test', 'demo', 'live'].map((m) => [m, createTrader({
      exchange: exchanges[m],
      settings: () => ({ ...u.cfg, mode: u.cfg.mode === m ? m : 'off' }),
      store: { load: () => u.st[m] || null, save: (x) => { u.st[m] = x; soon(); } },
      now,
    })]));
    return (run[owner] = { traders, testEx, creds, why: '', pseudo: {}, lastAt: 0 });
  }

  // Market results for what the traders hold (the bot also passes the ones it already knows)
  function resolver(env, known) {
    return (ticker) => {
      const hit = (env === 'live' ? known?.get(ticker) : null) ?? results[env].get(ticker);
      if (hit) return hit;
      if (!(asked[env].get(ticker) > now() - 20000)) {
        asked[env].set(ticker, now());
        api[env].req('GET', `/markets/${encodeURIComponent(ticker)}`).then(({ market }) => {
          if (market?.result === 'yes' || market?.result === 'no') results[env].set(ticker, market.result);
        }).catch(() => {});
      }
      return null;
    };
  }

  // Every bot tick: step each user whose trader is on. Never blocks the bot (each step runs on its own).
  function step({ snap, sig, known = null }) {
    for (const [owner, u] of Object.entries(db.users)) {
      if (u.cfg.mode === 'off') continue;
      const r = runner(owner), tr = r.traders[u.cfg.mode];
      const checks = {};
      for (const e of tr.state().ledger.filter((x) => !x.closed)) {
        const id = `${u.cfg.mode}:${e.ticker}:${e.at}`;
        const pos = (r.pseudo[id] ||= { id, ticker: e.ticker, side: e.side, price: e.price, contracts: e.count, closeTime: e.closeTime, at: e.at, fees: e.fees, peakBid: null, peakP: null });
        pos.contracts = e.count;
        const c = positionCheck(pos, snap, botSettings, snap.now);
        checks[e.ticker] = { bid: c.bid, ex: c.ex };
      }
      tr.step({ live: snap.live, sig, checks, resolve: resolver(u.cfg.mode === 'demo' ? 'demo' : 'live', known) }).then((res) => {
        r.why = res?.did ? (res.did === 'buy' ? `Bought ${res.filled}` : `Sold ${res.filled}`) : res?.why || '';
        r.lastAt = now();
      }).catch((e) => { r.why = `Error: ${e?.message || e}`; });
    }
  }

  // ---------- what the phone sees and does ----------
  function state(owner) {
    const u = user(owner), r = runner(owner), m = u.cfg.mode, tr = r.traders[m] || null, st = tr?.state();
    const unlock = liveUnlocked(r.traders.test.state());
    return {
      canHoldKeys: !!vault, cfg: u.cfg, modes: MODES,
      keys: Object.fromEntries(KEY_ENVS.map((e) => [e, u.keys[e] ? { keyId: `${u.keys[e].keyId.slice(0, 8)}…`, at: u.keys[e].at } : null])),
      unlock, why: m === 'off' ? '' : st?.stopped ? `Stopped: ${st.stopped}` : st?.pausedUntil > now() ? 'Paused after errors' : r.why,
      stopped: !!st?.stopped, paused: st?.pausedUntil > now(), lastAt: r.lastAt,
      today: tr?.today() ?? null, stats: tr?.stats() ?? null, testCash: r.testEx.balance(),
      log: (st?.log || []).slice(0, 25),
    };
  }
  async function setKey(owner, { env, keyId, pem }) {
    if (!vault) return { status: 503, body: { error: 'The server can\'t hold keys yet: add a KEY_SECRET variable in Railway (see the README), then redeploy.' } };
    if (!KEY_ENVS.includes(env)) return { status: 400, body: { error: 'env must be live or demo' } };
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(keyId.trim())) return { status: 400, body: { error: 'Enter the API key ID from Kalshi' } };
    if (typeof pem !== 'string' || pem.length > 8000 || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) return { status: 400, body: { error: 'Paste the private key (the whole -----BEGIN … PRIVATE KEY----- block)' } };
    let sign;
    try { sign = signerFor(pem.trim()); } catch (e) { return { status: 400, body: { error: `That private key didn't load: ${e.message}` } }; }
    let balance;
    try { balance = balanceDollars(await api[env].req('GET', '/portfolio/balance', { cred: { keyId: keyId.trim(), sign } })); }
    catch (e) { return { status: 400, body: { error: `Kalshi${env === 'demo' ? ' demo' : ''} refused the key (${e.status || '?'}: ${e.message}). Check the key ID, and that it's a ${env === 'demo' ? 'demo.kalshi.co' : 'kalshi.com'} key.` } }; }
    const u = user(owner);
    u.keys[env] = { keyId: keyId.trim(), at: now(), ...vault.seal(pem.trim()) };
    if (run[owner]) delete run[owner].creds[env];
    await save();
    return { status: 200, body: { ok: true, balance } };
  }
  async function deleteKey(owner, { env }) {
    const u = user(owner);
    delete u.keys[env];
    if (run[owner]) delete run[owner].creds[env];
    if (u.cfg.mode === env) u.cfg.mode = 'off';
    await save();
    return { status: 200, body: state(owner) };
  }
  async function configure(owner, body = {}) {
    const u = user(owner), r = runner(owner);
    const next = cleanLimits(body, u.cfg);
    if (body.mode != null) {
      if (!MODES[body.mode]) return { status: 400, body: { error: 'unknown mode' } };
      if (body.mode === 'live') {
        const un = liveUnlocked(r.traders.test.state());
        if (!un.ok) return { status: 409, body: { error: un.serious ? 'Test hit an error: reset Test and let it run clean first' : `Run Test first: Live unlocks after ${un.settled}/10 clean Test trades` } };
        if (!u.keys.live) return { status: 409, body: { error: 'Give the server your Kalshi key first (it needs trading permission)' } };
        if (body.confirm !== true) return { status: 409, body: { error: 'Live needs confirming' } };
      }
      if (body.mode === 'demo' && !u.keys.demo) return { status: 409, body: { error: 'Give the server a Kalshi demo key first' } };
      next.mode = body.mode;
    }
    if (next.mode !== u.cfg.mode) r.why = '';
    u.cfg = next;
    await save();
    return { status: 200, body: state(owner) };
  }
  async function control(owner, action) {
    const u = user(owner), r = runner(owner);
    if (action === 'stop') { u.cfg.mode = 'off'; r.why = ''; }
    else if (action === 'resume') r.traders[u.cfg.mode]?.resume();
    else if (action === 'reset-test') { r.traders.test.reset(); r.testEx.reset(u.cfg.testCash); }
    else return { status: 404, body: { error: 'not found' } };
    await save();
    return { status: 200, body: state(owner) };
  }
  const running = () => Object.values(db.users).filter((u) => u.cfg.mode !== 'off').length;
  return { load, save, step, state, setKey, deleteKey, configure, control, running, canHoldKeys: () => !!vault };
}
