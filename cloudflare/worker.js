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

// ---------- the backup ----------
function statusBody(p, env) {
  return {
    access: !!p, role: p ? (p.t === 'a' ? 'admin' : 'member') : null, code: p?.c ?? null, state: p ? 'active' : null, expires: p?.e ?? null,
    price: Number(env.PRICE) || 5, days: Number(env.DAYS) || 30, cashtag: String(env.CASHTAG || 'Akizzle55').replace(/^\$/, ''),
    pass: null, paidAt: null, approvedAt: null, open: false, offline: true,
  };
}

async function accessApi(req, env, action, who) {
  if (action === 'status') return json(statusBody(who, env));
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!env.ACCESS_SECRET) return json({ error: `${OFFLINE} (The backup has no ACCESS_SECRET, so it can't sign anyone in.)` }, 503);
  const b = await req.json().catch(() => ({}));
  if (action === 'restore') {
    const p = await verifyPass(b.pass, env.ACCESS_SECRET);
    if (!p || !(p.e > Date.now()) || (p.t !== 'm' && p.t !== 'a')) return json({ error: 'Saved access is no longer valid' }, 401);
    const who2 = { t: p.t, c: p.t === 'm' ? p.c : null, e: p.e };
    return json({ ...statusBody(who2, env), pass: b.pass }, 200, { 'set-cookie': setEdge(await edgeCookie(who2, env.ACCESS_SECRET), p.e) });
  }
  if ((action === 'admin' || action === 'redeem') && env.ADMIN_CODE && sameText(String(b.code || '').trim().toLowerCase(), String(env.ADMIN_CODE).trim().toLowerCase())) {
    const who2 = { t: 'a', c: null, e: Date.now() + DAY };
    return json(statusBody(who2, env), 200, { 'set-cookie': setEdge(await edgeCookie(who2, env.ACCESS_SECRET), who2.e) });
  }
  if (action === 'logout') return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  return json({ error: `${OFFLINE} A phone that has signed in before gets back in on its own; new codes work once it's back.` }, 503);
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
  const who = await readEdge(req, env.ACCESS_SECRET);
  if (path === '/healthz') return json({ ok: false, offline: true, backup: 'cloudflare' }, 503);
  if (path === '/site' || path === '/site.html') return site(req, env);
  if (path === '/api/public/info') return json({ app: 'Shot Caller', discord: env.DISCORD_INVITE || null });
  if (path === '/api/public/record') return json({ error: OFFLINE, offline: true }, 503);
  const acc = path.match(/^\/api\/access\/(\w+)$/);
  if (acc) return accessApi(req, env, acc[1], who);
  if (LIVE_FILES.has(path)) return new Response(OFFLINE, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!who) {
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
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const r = await fromOrigin(req, env, body);
    if (r) return r;
    return offline(body === undefined ? req : new Request(req, { body }), env);
  },
};
