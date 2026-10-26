// The backup (v13.84): a Cloudflare Worker in front of the app's address, free plan.
//
// Home server up:   every request goes to it (ORIGIN, through the tunnel), exactly as before.
// Home server down: the Worker answers on its own. It serves the website and the app's files, signs members in with
//                   the signed pass their phone already keeps (the same ACCESS_SECRET as the server), and fetches the
//                   live market data the phone needs: Kalshi's and Coinbase's public prices, and Kraken's order book.
//                   The phone works the calls out itself, so prices, the chart and the bot's calls keep going.
//                   What only the server does (Discord, push, the Auto-trader, the official record, the bot team,
//                   buying a code) answers "offline" until it's back. Nothing is stored here.
//
// Settings (Worker → Settings → Variables and Secrets):
//   ORIGIN         the home server's own address through the tunnel, e.g. https://home.shotcaller.com.co (required)
//   ACCESS_SECRET  the server's ACCESS_SECRET (secret): checks members' passes
//   EDGE_SECRET    the server's EDGE_SECRET (secret): lets the server see visitors' real addresses
//   ADMIN_CODE     the server's ADMIN_CODE (secret, optional): the admin can sign in while the server is down
//   EDGE_KV        a KV namespace (binding): the member list, so codes, new purchases and approvals work while it's down
//   APP_URL, DISCORD_INVITE, PRICE, DAYS, CASHTAG  optional, for the website and the paywall page
import { BOOK_PAIRS, KRAKEN, summarizeBook } from '../bookmath.js';
import { ASSETS } from '../public/markets.js';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_DEMO = 'https://demo-api.kalshi.co/trade-api/v2';
const COINBASE = 'https://api.exchange.coinbase.com';
// the same read-only paths the server allows (server.js ROUTES)
const KALSHI_PUBLIC = /^(markets(\/[A-Za-z0-9._-]+(\/orderbook)?)?|events\/[A-Za-z0-9._-]+|series\/[A-Za-z0-9._-]+)$/;
const COINBASE_PUBLIC = new RegExp(`^products/(${ASSETS.filter((a) => a.product).map((a) => a.product).join('|')})/(ticker|candles)$`);
const PROXIES = [['/api/kalshi/', KALSHI, KALSHI_PUBLIC], ['/api/kalshi-demo/', KALSHI_DEMO, KALSHI_PUBLIC], ['/api/coinbase/', COINBASE, COINBASE_PUBLIC]];
// the files anyone may load without signing in (server.js OPEN_FILES)
const OPEN_FILES = new Set(['/site.html', '/site.js', '/robots.txt', '/paywall.html', '/paywall.js', '/styles.css', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/sw.js']);
const LIVE_FILES = new Set(['/team-live', '/team-live.html', '/team-live.js']);
const COOKIE = 'sc_edge';
const DAY = 86400000;
const OFFLINE = 'The Shot Caller server is offline right now. Prices and calls keep working; this comes back when it does.';

// ---------- small helpers ----------
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const sameText = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function hmacKey(label, secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`${label}:${secret}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
const mac = async (key, body) => b64url(await crypto.subtle.sign('HMAC', key, enc.encode(body))).slice(0, 32);

// signed text: base64url(JSON) + '.' + the first 32 characters of base64url(HMAC-SHA256), the way access.js signs passes
async function openSigned(v, label, secret) {
  if (!secret || typeof v !== 'string' || v.length > 600) return null;
  const [body, sig] = v.split('.');
  if (!body || !sig || !sameText(sig, await mac(await hmacKey(label, secret), body))) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64url(body))); } catch { return null; }
}
// a member's (or the admin's) pass from access.js, checked with the server's ACCESS_SECRET
export const verifyPass = (pass, secret) => openSigned(pass, 'shot-caller-pass', secret);
// the Worker's own sign-in cookie while the server is down: who and until when, signed with a key of its own
async function edgeCookie(p, secret) {
  const body = b64url(enc.encode(JSON.stringify({ t: p.t, c: p.c ?? null, e: p.e })));
  return `${body}.${await mac(await hmacKey('shot-caller-edge', secret), body)}`;
}
async function readEdge(req, secret) {
  const v = (req.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1];
  const p = v && await openSigned(v, 'shot-caller-edge', secret);
  return p && p.e > Date.now() ? p : null;
}
const setEdge = (value, until) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.min(30 * DAY, until - Date.now()) / 1000) | 0}`;

// ---------- the home server ----------
// Its answer, or null when it's down: unreachable, too slow, or Cloudflare's own error page for a dead tunnel
// (HTML 502/503/504/52x/530). The app's own errors are JSON or plain text, and pass straight through.
async function fromOrigin(req, env, body) {
  if (!env.ORIGIN) return null;
  const url = new URL(req.url), target = new URL(url.pathname + url.search, env.ORIGIN);
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.set('x-sc-client-ip', req.headers.get('cf-connecting-ip') || '');
  if (env.EDGE_SECRET) headers.set('x-sc-edge', env.EDGE_SECRET);
  try {
    const r = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(req.method === 'GET' ? 20000 : 30000) });
    const dead = (r.status >= 520 || [502, 503, 504].includes(r.status)) && /text\/html/i.test(r.headers.get('content-type') || '');
    return dead ? null : r;
  } catch {
    return null;
  }
}

// ---------- the direct lane (v13.92) ----------
// Every request through this Worker counts toward Cloudflare's free 100,000 a day, and an open phone polls the API a few
// times a second. So while the home server answers, this tells the app the server's own address (x-sc-direct: ORIGIN,
// only when it's a subdomain of this one, like home.shotcaller.com.co) and the app reads the API from there (server.js
// allows it). The sign-in cookie is copied onto the whole domain (Domain=) so it reaches that address too. When the
// server is down the header isn't sent, the app's direct requests fail, and it comes back here, to the backup.
export function direct(req, env, r) {
  let host, origin;
  try { host = new URL(req.url).hostname; origin = new URL(env.ORIGIN); } catch { return r; }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith(`.${host}`)) return r;
  const out = new Response(r.body, r);
  out.headers.set('x-sc-direct', origin.origin);
  const set = r.headers.getSetCookie?.() || [], dom = `; Domain=${host}`;
  for (const c of set) if (/^sc_session=/.test(c) && !/;\s*domain=/i.test(c)) out.headers.append('set-cookie', c + dom);
  const cookie = req.headers.get('cookie') || '', tok = /(?:^|;\s*)sc_session=([^;]+)/.exec(cookie)?.[1];
  if (tok && !/(?:^|;\s*)sc_dom=1/.test(cookie) && !set.some((c) => /^sc_session=/.test(c))) { // signed in before this: copy it once
    out.headers.append('set-cookie', `sc_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure${dom}`);
    out.headers.append('set-cookie', 'sc_dom=1; Path=/; SameSite=Lax; Max-Age=31536000; Secure');
  }
  return out;
}

// ---------- members (v13.86) ----------
// The server's member list, copied here every few minutes by edgesync.js into this Worker's storage (KV, EDGE_KV),
// plus what happened here while the server was off ("changes": new purchases, "I've paid", the admin's approvals).
// The server takes the changes back and merges them (access.js mergeEdge: the newer side wins).
const CODE_RE = /^SC-[A-HJ-NP-Z2-9]{6}$/, ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // as access.js
const normalizeCode = (c) => { const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return x ? `SC-${x.replace(/^SC/, '')}` : ''; };
const newCode = () => `SC-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
const MAX_OFFLINE_BUYS = 200; // unpaid codes made here while the server is off
let memo = null; // { at, list } for 20 s: checking a sign-in on every request shouldn't read storage every time
async function memberList(env) {
  if (!env.EDGE_KV) return null;
  if (memo && Date.now() - memo.at < 20000) return memo.list;
  const [base, changes] = await Promise.all([env.EDGE_KV.get('members', 'json'), env.EDGE_KV.get('changes', 'json')]);
  const list = { config: base?.config || null, members: { ...(base?.members || {}) }, changes: changes || {} };
  for (const [k, r] of Object.entries(list.changes)) if (!list.members[k] || (r.updatedAt || 0) >= (list.members[k].updatedAt || 0)) list.members[k] = r;
  memo = { at: Date.now(), list };
  return list;
}
async function change(env, rec) {
  const changes = (await env.EDGE_KV.get('changes', 'json')) || {};
  changes[rec.code] = { code: rec.code, status: rec.status, createdAt: rec.createdAt, paidAt: rec.paidAt ?? null, approvedAt: rec.approvedAt ?? null, expires: rec.expires || 0, updatedAt: Date.now() };
  await env.EDGE_KV.put('changes', JSON.stringify(changes));
  memo = null;
  return changes[rec.code];
}
const isActive = (m) => !!m && m.status === 'active' && m.expires > Date.now();
// Who's signed in here: the admin; a member (a pass the server signed, or a code on the list); a buyer whose code waits
// for approval (t 'p'). The list has the last word: a revoked code is out, a renewed one runs to its new date.
async function accessOf(who, env) {
  if (!who) return { access: false, role: null, m: null };
  if (who.t === 'a') return { access: true, role: 'admin', m: null };
  const m = (await memberList(env))?.members[who.c] ?? null;
  return { access: m ? isActive(m) : who.t === 'm' && who.e > Date.now(), role: 'member', m };
}
function statusBody(who, acc, env, list) {
  const cfg = list?.config || {}, m = acc.m;
  return {
    access: acc.access, role: acc.role, code: who?.c ?? null,
    state: m ? (m.status === 'active' && m.expires <= Date.now() ? 'expired' : m.status) : acc.access && who?.t === 'm' ? 'active' : null,
    expires: m?.expires ?? (who?.t === 'm' ? who.e : null), paidAt: m?.paidAt ?? null, approvedAt: m?.approvedAt ?? null,
    price: Number(cfg.price ?? env.PRICE) || 5, days: Number(cfg.days ?? env.DAYS) || 30, cashtag: String(cfg.cashtag ?? env.CASHTAG ?? 'Akizzle55').replace(/^\$/, ''),
    pass: null, open: false, offline: true,
  };
}
// signed in as a member (t 'm', until the code expires) or a buyer (t 'p', for a week while it waits)
async function signIn(env, m) {
  const t = isActive(m) ? 'm' : 'p', e = t === 'm' ? m.expires : Date.now() + 7 * DAY, who = { t, c: m.code, e };
  return { who, cookie: setEdge(await edgeCookie(who, env.ACCESS_SECRET), e) };
}

async function accessApi(req, env, action, who) {
  const list = await memberList(env);
  const reply = async (w, extra = {}, headers = {}) => json({ ...statusBody(w, await accessOf(w, env), env, list), ...extra }, 200, headers);
  if (action === 'status') return reply(who);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!env.ACCESS_SECRET) return json({ error: `${OFFLINE} (The backup has no ACCESS_SECRET, so it can't sign anyone in.)` }, 503);
  const b = await req.json().catch(() => ({}));
  if (action === 'restore') {
    const p = await verifyPass(b.pass, env.ACCESS_SECRET);
    if (!p || !(p.e > Date.now()) || (p.t !== 'm' && p.t !== 'a')) return json({ error: 'Saved access is no longer valid' }, 401);
    const m = p.t === 'm' ? list?.members[p.c] : null;
    if (m && (m.status === 'revoked' || m.status === 'denied')) return json({ error: 'Access was revoked' }, 403);
    const w = { t: p.t, c: p.t === 'm' ? p.c : null, e: p.t === 'm' && isActive(m) ? m.expires : p.e };
    memo = null;
    return reply(w, { pass: b.pass }, { 'set-cookie': setEdge(await edgeCookie(w, env.ACCESS_SECRET), w.e) });
  }
  if ((action === 'admin' || action === 'redeem') && env.ADMIN_CODE && sameText(String(b.code || '').trim().toLowerCase(), String(env.ADMIN_CODE).trim().toLowerCase())) {
    const w = { t: 'a', c: null, e: Date.now() + DAY };
    return reply(w, {}, { 'set-cookie': setEdge(await edgeCookie(w, env.ACCESS_SECRET), w.e) });
  }
  if (action === 'logout') return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  if (!list) return json({ error: `${OFFLINE} A phone that has signed in before gets back in on its own; new codes work once it's back.` }, 503);
  if (action === 'redeem') {
    const m = list.members[normalizeCode(b.code)];
    if (!m || m.status === 'denied' || m.status === 'revoked') return json({ error: 'Code not found' }, 404);
    const s = await signIn(env, m);
    return reply(s.who, {}, { 'set-cookie': s.cookie });
  }
  if (action === 'request') { // a new buyer while the server is off: the code is made here, and the server takes it back later
    const cur = who?.c && list.members[who.c];
    if (cur && cur.status !== 'denied' && cur.status !== 'revoked') return reply(who);
    if (Object.values(list.changes).filter((x) => x.status === 'pending' && !x.paidAt).length >= MAX_OFFLINE_BUYS) return json({ error: 'Too many pending payments. Try again later.' }, 503);
    let code = normalizeCode(b.code);
    if (!CODE_RE.test(code) || list.members[code]) do code = newCode(); while (list.members[code]);
    const m = await change(env, { code, status: 'pending', createdAt: Date.now(), paidAt: null, approvedAt: null, expires: 0 });
    list.members[code] = m;
    const s = await signIn(env, m);
    return reply(s.who, {}, { 'set-cookie': s.cookie });
  }
  if (action === 'paid') {
    const m = who?.c && list.members[who.c];
    if (!m) return json({ error: 'No purchase started' }, 400);
    list.members[m.code] = await change(env, { ...m, paidAt: Date.now() });
    return reply(who);
  }
  return json({ error: OFFLINE }, 503);
}

// the admin panel while the server is off: the members, and approve / deny / revoke (they go back to the server later)
async function adminApi(req, env, action) {
  const list = await memberList(env);
  if (!list) return json({ error: OFFLINE, offline: true }, 503);
  const cfg = list.config || {};
  if (action === 'members' && req.method === 'GET') {
    const members = Object.values(list.members).sort((a, b) => (b.paidAt || b.createdAt || 0) - (a.paidAt || a.createdAt || 0)).map((m) => ({ ...m, devices: 0 }));
    return json({ config: { price: Number(cfg.price) || 5, days: Number(cfg.days) || 30, cashtag: cfg.cashtag || 'Akizzle55' }, members, discord: false, offline: true });
  }
  if (req.method !== 'POST' || !['approve', 'deny', 'revoke'].includes(action)) return json({ error: `${OFFLINE} This waits for it.`, offline: true }, 503);
  const b = await req.json().catch(() => ({})), code = normalizeCode(b.code);
  let m = list.members[code];
  if (!m && action === 'approve' && CODE_RE.test(code)) m = { code, status: 'pending', createdAt: Date.now(), paidAt: null, approvedAt: null, expires: 0 };
  if (!m) return json({ error: 'Code not found' }, 404);
  const now = Date.now(), days = Number(b.days) > 0 ? Number(b.days) : Number(cfg.days) || 30;
  const next = action === 'approve' ? { ...m, status: 'active', approvedAt: now, expires: Math.max(now, m.expires || 0) + days * DAY }
    : action === 'deny' ? { ...m, status: 'denied' } : { ...m, status: 'revoked', expires: now };
  const saved = await change(env, next);
  return json({ ok: true, member: { ...saved, devices: 0 } });
}

// edgesync.js on the server: GET /__edge/changes, POST /__edge/members (both with EDGE_SECRET; answered here, never passed on)
async function edgeApi(req, env, path) {
  if (!env.EDGE_SECRET || !sameText(req.headers.get('x-sc-edge') || '', env.EDGE_SECRET)) return json({ error: 'forbidden' }, 403);
  if (!env.EDGE_KV) return json({ error: 'this backup has no storage (EDGE_KV): run shotctl.py cloud-backup' }, 501);
  if (path === '/__edge/changes' && req.method === 'GET') return json({ changes: (await env.EDGE_KV.get('changes', 'json')) || {} });
  if (path === '/__edge/members' && req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (!b || !Array.isArray(b.members)) return json({ error: 'expected { members: [...] }' }, 400);
    const members = Object.fromEntries(b.members.filter((m) => CODE_RE.test(m?.code || '')).map((m) => [m.code, m]));
    await env.EDGE_KV.put('members', JSON.stringify({ members, config: b.config || null, at: Date.now() }));
    // what the server merged leaves the change list; anything newer made here since stays for the next round
    const changes = (await env.EDGE_KV.get('changes', 'json')) || {}, ack = b.ack || {};
    for (const [k, r] of Object.entries(changes)) if (ack[k] && ack[k] >= (r.updatedAt || 0)) delete changes[k];
    await env.EDGE_KV.put('changes', JSON.stringify(changes));
    memo = null;
    return json({ ok: true, members: Object.keys(members).length, waiting: Object.keys(changes).length });
  }
  return json({ error: 'not found' }, 404);
}

async function proxy(path, search, upstream, allow) {
  if (!allow.test(path)) return json({ error: 'not allowed' }, 404);
  try {
    const r = await fetch(`${upstream}/${path}${search}`, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    return json({ error: `upstream failed: ${e.message}` }, 502);
  }
}

async function bookSnapshot(series) {
  const asset = (ASSETS.find((a) => a.match?.test(series || 'KXBTC15M')) || {}).key || 'BTC';
  if (!BOOK_PAIRS[asset]) return json({ off: 'pending orders are for BTC, ETH, SOL, XRP and DOGE' });
  try {
    const r = await fetch(`${KRAKEN}?pair=${BOOK_PAIRS[asset]}&count=500`, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json(), raw = Object.values(j.result || {})[0], s = raw && summarizeBook(raw.bids || [], raw.asks || []);
    if (!s) throw new Error(j.error?.[0] || 'empty book');
    const { usdAt, inView, walls, ...plain } = s;
    const top = (side) => walls.filter((w) => w.side === side).slice(0, 4).map((w) => ({ ...w, since: Date.now(), standing: 0 }));
    return json({ asset, source: 'Kraken', at: Date.now(), ...plain, walls: [...top('buy'), ...top('sell')], events: [], history: [], offline: true });
  } catch (e) {
    return json({ error: `Couldn't read Kraken's order book: ${e.message}` });
  }
}

// a page or file from the app's own folder (the Worker's static assets: public/)
async function asset(req, env, path) {
  const r = await env.ASSETS.fetch(new Request(new URL(path, req.url), { headers: req.headers }));
  const headers = new Headers(r.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(r.body, { status: r.status, headers });
}
async function site(req, env) {
  const r = await env.ASSETS.fetch(new Request(new URL('/site.html', req.url)));
  const html = (await r.text()).replaceAll('%BASE%', String(env.APP_URL || new URL(req.url).origin).replace(/\/+$/, ''));
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
}
async function app(req, env) {
  const r = await env.ASSETS.fetch(new Request(new URL('/index.html', req.url)));
  const note = '<div role="status" style="position:sticky;top:0;z-index:99;padding:6px 12px;font:600 12px system-ui,sans-serif;text-align:center;color:#111;background:#ffb020">Backup mode: the home server is offline. Prices and calls keep working; alerts, the Auto-trader and the record come back with it.</div>';
  const html = (await r.text()).replace(/<body([^>]*)>/i, (m) => `${m}${note}`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
}

export async function offline(req, env) {
  const url = new URL(req.url), path = url.pathname;
  const who = await readEdge(req, env.ACCESS_SECRET), acc = await accessOf(who, env);
  if (path === '/healthz') return json({ ok: false, offline: true, backup: 'cloudflare' }, 503);
  if (path === '/site' || path === '/site.html') return site(req, env);
  if (path === '/api/public/info') return json({ app: 'Shot Caller', discord: env.DISCORD_INVITE || null });
  if (path === '/api/public/record') return json({ error: OFFLINE, offline: true }, 503);
  const accessCall = path.match(/^\/api\/access\/(\w+)$/);
  if (accessCall) return accessApi(req, env, accessCall[1], who);
  if (LIVE_FILES.has(path)) return new Response(OFFLINE, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (who?.t === 'a') { const adm = path.match(/^\/api\/admin\/(\w+)$/); if (adm) return adminApi(req, env, adm[1]); }
  if (!acc.access) {
    if (path.startsWith('/api/')) return json({ error: 'payment required', paywall: true }, 401, { 'x-paywall': '1' });
    if (path === '/' || path === '/index.html') return site(req, env); // like the server: the address shows the website
    if (OPEN_FILES.has(path) && req.method === 'GET') return asset(req, env, path);
    return json({ error: 'payment required', paywall: true }, 401, { 'x-paywall': '1' });
  }
  for (const [prefix, upstream, allow] of PROXIES) if (path.startsWith(prefix)) return proxy(path.slice(prefix.length), url.search, upstream, allow);
  if (path === '/api/book') return bookSnapshot(url.searchParams.get('m'));
  if (path.startsWith('/api/')) return json({ error: OFFLINE, offline: true }, 503);
  if (path === '/' || path === '/index.html' || path === '/paywall.html') return app(req, env); // signed in: straight to the app
  return asset(req, env, path);
}

export default {
  async fetch(req, env) {
    // a request body can be read once: keep it, so it can go to the home server and, if that's down, to the backup
    const path = new URL(req.url).pathname;
    if (path.startsWith('/__edge/')) return edgeApi(req, env, path); // the server keeping the members in step (edgesync.js)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const r = await fromOrigin(req, env, body);
    if (r) return direct(req, env, r);
    return offline(body === undefined ? req : new Request(req, { body }), env);
  },
};
