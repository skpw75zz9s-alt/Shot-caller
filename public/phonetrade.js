// The Auto-trader on this phone (v13.68): the same trader as the server's (trader.js: the executor the tests hammer
// against a strict fake Kalshi), run here, so the Kalshi key never leaves the phone. The key is the one linked in
// Settings → Kalshi account: a non-extractable WebCrypto key in IndexedDB that can sign but can't be read back out. Each
// order is signed on the phone; the server only forwards it, after its own check (validateOrder: BTC 15-minute markets,
// fill-now-or-cancel, the dollar cap). Every few seconds the server sends what its own traders get each tick
// (/api/auto/feed: the official call, a sell check per open position, known results).
//   Test  simulator on Kalshi's live order book: nothing is sent, no key needed
//   Live  real orders with the phone's key (it needs trading permission). Locked until Test has run clean
// The catch: it only trades while the app is open. A phone freezes a web app in the background, so with the app closed
// or the screen locked, nothing is bought or sold (the screen is kept awake while it runs, where the phone allows it).
// It never runs alongside this person's server Auto-trader in Demo or Live: it pauses rather than both buying.
import { LIMITS, LIVE_UNLOCK, TRADER_DEFAULTS, cleanLimits, createTestExchange, createTrader, liveUnlocked, parseBook, placedFrom } from './trader.js';
import { balanceDollars, parsePosition, signHeaders } from './kalshi.js';

export const PHONE_MODES = { off: 'Off', test: 'Test', live: 'Live' };
export const PHONE_LIMITS = LIMITS.filter(([k]) => k !== 'makerSec'); // fill-now-or-cancel only: the relay takes no resting orders
const STORE = 'sc_phone_trader', EVERY_MS = 4000;

export function createPhoneTrade({ API, cred = () => null, fetchImpl = (...a) => fetch(...a), storage = globalThis.localStorage, now = () => Date.now(),
  sign = signHeaders, wake = globalThis.navigator?.wakeLock ?? null, doc = globalThis.document ?? null, onChange = () => {} }) {
  const db = load();
  function load() {
    try { const j = JSON.parse(storage?.getItem(STORE) || 'null'); if (j?.cfg) return { cfg: { ...TRADER_DEFAULTS, ...j.cfg, makerSec: 0 }, st: j.st || {}, testEx: j.testEx || null, lastAt: j.lastAt || 0 }; } catch { /* fresh */ }
    return { cfg: { ...TRADER_DEFAULTS, makerSec: 0 }, st: {}, testEx: null, lastAt: 0 };
  }
  const save = () => { try { storage?.setItem(STORE, JSON.stringify(db)); } catch { /* full or private: it still runs */ } };

  // ---------- talking to the server and, through its relay, to Kalshi ----------
  const err = (status, body) => { const e = body?.error; return { status, code: (typeof e === 'object' ? e?.code : null) ?? null, message: (typeof e === 'object' ? e?.message : e) || `HTTP ${status}` }; };
  async function http(path, init = {}) {
    let r;
    try { r = await fetchImpl(`${API}/${path}`, { cache: 'no-store', credentials: 'same-origin', ...init }); } catch (e) { throw { status: 0, message: e?.message || 'network error' }; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw err(r.status, body);
    return body;
  }
  const post = (path, body) => http(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let prefix = null;
  async function signed(method, endpoint, { query = null, body = null } = {}) {
    const c = cred();
    if (!c?.key || !c?.keyId) throw { status: 403, message: 'No Kalshi key on this phone: link it in Settings → Kalshi account' };
    prefix ||= (await http('kalshi-auth/info')).pathPrefix;
    const path = `${prefix}${method === 'POST' ? 'events/orders' : endpoint}`; // Kalshi signs the path without the query
    const headers = { ...(await sign(c.key, c.keyId, method, path, now())), ...(body ? { 'content-type': 'application/json' } : {}) };
    return http(`kalshi-auth/${endpoint}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }
  const book = async (t) => parseBook(await http(`kalshi/markets/${encodeURIComponent(t)}/orderbook`));
  // the trader's exchange on the phone's own key: no resting orders, so no cancel
  const liveEx = {
    async cash() { return { balance: balanceDollars(await signed('GET', 'balance')) ?? 0, held: 0 }; },
    book,
    async positions(ticker) {
      const b = await signed('GET', 'positions', { query: { count_filter: 'position', limit: '200', ...(ticker ? { ticker } : {}) } });
      return (b.market_positions || []).map(parsePosition).map((p) => ({ ticker: p.ticker, side: p.side, count: p.contracts }));
    },
    async place(o) { return placedFrom(await signed('POST', 'orders', { body: o })); },
  };
  const testEx = createTestExchange({ getBook: book, startCash: db.cfg.testCash, store: { load: () => db.testEx, save: (x) => { db.testEx = x; save(); } } });
  const traders = Object.fromEntries([['test', testEx], ['live', liveEx]].map(([m, exchange]) => [m, createTrader({
    exchange, now,
    settings: () => ({ ...db.cfg, makerSec: 0, mode: db.cfg.mode === m ? m : 'off' }),
    store: { load: () => db.st[m] || null, save: (x) => { db.st[m] = x; save(); } },
  })]));

  // market results: what the server already knows, else Kalshi's public answer (asked at most every 20 s per market)
  const results = new Map(), asked = new Map();
  function resolve(ticker) {
    if (results.has(ticker)) return results.get(ticker);
    if (!(asked.get(ticker) > now() - 20000)) {
      asked.set(ticker, now());
      http(`kalshi/markets/${encodeURIComponent(ticker)}`).then(({ market }) => { if (market?.result === 'yes' || market?.result === 'no') results.set(ticker, market.result); }).catch(() => {});
    }
    return null;
  }

  // ---------- the loop ----------
  let why = '', server = 'off', stepping = false, timer = null, lock = null, gapNote = '';
  async function step() {
    const m = db.cfg.mode;
    if (m === 'off' || stepping) return;
    stepping = true;
    try {
      const tr = traders[m];
      const open = tr.state().ledger.filter((e) => !e.closed).map((e) => ({ ticker: e.ticker, side: e.side, price: e.price, count: e.count, closeTime: e.closeTime, at: e.at, fees: e.fees }));
      const f = await post('auto/feed', { open });
      server = f.server || 'off';
      if (!f.ready) { why = 'Waiting for the server\'s first reading'; return; }
      if (m === 'live' && (server === 'live' || server === 'demo')) { why = `Paused: your Auto-trader on the server is on (${server === 'live' ? 'Live' : 'Demo'}). Turn one of them off so they never both buy.`; return; }
      for (const [t, r] of Object.entries(f.results || {})) results.set(t, r);
      const res = await tr.step({ live: f.live, sig: f.sig, checks: f.checks || {}, resolve });
      why = res?.did ? (res.did === 'buy' ? `Bought ${res.filled}` : `Sold ${res.filled}`) : res?.why || '';
      db.lastAt = now(); gapNote = '';
    } catch (e) {
      why = e?.status === 401 ? 'Signed out: sign in again to keep trading' : `Couldn't reach the server (${e?.message || e}): trying again`;
    } finally { stepping = false; save(); onChange(); }
  }
  async function keepAwake() {
    if (!wake || lock || db.cfg.mode === 'off' || doc?.hidden) return;
    try { lock = await wake.request('screen'); lock.addEventListener?.('release', () => { lock = null; }); } catch { lock = null; } // not allowed here: it still runs while the screen is on
  }
  function run() {
    clearInterval(timer); timer = null;
    if (db.cfg.mode === 'off') { lock?.release?.().catch?.(() => {}); lock = null; return; }
    // back after a gap (the app was closed or the screen locked): say so, honestly
    if (db.lastAt && now() - db.lastAt > 60000) gapNote = `The app was closed for ${Math.round((now() - db.lastAt) / 60000)} min: nothing was traded meanwhile.`;
    timer = setInterval(step, EVERY_MS); timer.unref?.();
    keepAwake(); step();
  }
  doc?.addEventListener?.('visibilitychange', () => { if (!doc.hidden && db.cfg.mode !== 'off') run(); });

  // ---------- what the Auto-trader card shows and does (the same shapes as the server's /api/auto/*) ----------
  function state() {
    const m = db.cfg.mode, tr = traders[m] || null, st = tr?.state(), c = cred();
    return {
      phone: true, canHoldKeys: true, cfg: db.cfg, modes: PHONE_MODES, server,
      keys: { live: c?.keyId ? { keyId: `${String(c.keyId).slice(0, 8)}…` } : null },
      unlock: liveUnlocked(traders.test.state()),
      why: m === 'off' ? '' : st?.stopped ? `Stopped: ${st.stopped}` : st?.pausedUntil > now() ? 'Paused after errors' : [gapNote, why].filter(Boolean).join(' '),
      stopped: !!st?.stopped, paused: st?.pausedUntil > now(), lastAt: db.lastAt, awake: !!lock,
      today: tr?.today() ?? null, stats: tr?.stats() ?? null, testCash: testEx.balance(),
      log: (st?.log || []).slice(0, 25),
    };
  }
  // path: state | config | stop | resume | reset-test. Returns the new state, or throws Error(message)
  async function handle(path, body = {}) {
    if (path === 'state') return state();
    if (path === 'config') {
      const next = cleanLimits(body, db.cfg);
      if (body.mode != null) {
        if (!PHONE_MODES[body.mode]) throw new Error('unknown mode');
        if (body.mode === 'live') {
          const un = liveUnlocked(traders.test.state());
          if (!un.ok) throw new Error(un.serious ? 'Test hit an error: reset Test and let it run clean first' : `Run Test first: Live unlocks after ${LIVE_UNLOCK} clean Test trades (${un.settled} so far)`);
          if (!cred()?.key) throw new Error('Link your Kalshi key on this phone first (Settings → Kalshi account). For Live it needs trading permission.');
          const srv = await http('auto/state').then((x) => x.cfg?.mode).catch(() => null);
          if (srv === 'live' || srv === 'demo') throw new Error(`Your Auto-trader on the server is on (${srv === 'live' ? 'Live' : 'Demo'}): turn it off first, so the two never both buy`);
          if (body.confirm !== true) throw new Error('Live needs confirming');
        }
        next.mode = body.mode;
      }
      if (next.mode !== db.cfg.mode) { why = ''; gapNote = ''; }
      db.cfg = { ...next, makerSec: 0 };
      save(); run();
      return state();
    }
    if (path === 'stop') { db.cfg.mode = 'off'; why = ''; save(); run(); return state(); }
    if (path === 'resume') { traders[db.cfg.mode]?.resume(); save(); return state(); }
    if (path === 'reset-test') { traders.test.reset(); testEx.reset(db.cfg.testCash); save(); return state(); }
    throw new Error('not found');
  }
  run();
  return { handle, state, step, running: () => db.cfg.mode !== 'off', mode: () => db.cfg.mode };
}
