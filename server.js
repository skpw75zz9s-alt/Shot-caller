// Zero-dependency server: serves the PWA, proxies the public Kalshi and Coinbase market-data
// APIs so the phone browser never hits CORS limits, runs the push bot, and enforces the paywall.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot } from './bot.js';
import { createAccess } from './access.js';

const PORT = Number(process.env.PORT || 8080);
const KALSHI = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = process.env.COINBASE_API || 'https://api.exchange.coinbase.com';
const PAYWALL = process.env.PAYWALL !== 'off';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

export const access = createAccess({
  file: join(DATA_DIR, 'access.json'),
  // Ping admins' phones when a buyer says they've paid, so the payment can be checked in Cash App
  onPaid: (m, cfg) => bot.notifyWhere((d) => access.isAdminToken(d.token), {
    tag: `pay-${m.code}`, title: `💵 Payment to verify: ${m.code}`,
    body: `Someone says they sent $${cfg.price} to $${cfg.cashtag} with note ${m.code}. Check Cash App, then approve it in Settings → Admin.`,
  }),
});
export const bot = createBot({
  kalshi: KALSHI, coinbase: COINBASE, dataFile: join(DATA_DIR, 'shot-caller.json'),
  canNotify: (d) => !PAYWALL || access.hasAccess(d.token),
});
const ready = Promise.all([bot.load(), access.load()]);
setInterval(() => access.prune(), 3600000).unref();

// Only read-only market-data endpoints are reachable through the proxy.
const ROUTES = [
  { prefix: '/api/kalshi/', upstream: KALSHI, allow: /^(markets(\/[A-Za-z0-9._-]+)?|events\/[A-Za-z0-9._-]+|series\/[A-Za-z0-9._-]+)$/ },
  { prefix: '/api/coinbase/', upstream: COINBASE, allow: /^products\/BTC-USD\/(ticker|candles)$/ },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
// Files anyone can load: the paywall page and what it (and "Add to Home Screen") needs.
const OPEN_FILES = new Set(['/paywall.html', '/paywall.js', '/styles.css', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/sw.js']);

const cache = new Map(); // tiny 2s cache so several open phones don't multiply upstream calls

// Compression: brotli or gzip when the phone accepts it (cuts the app's first download ~70%).
// Compressed copies are kept on the cached entry so each body is compressed once.
const encodingFor = (req) => { const a = req.headers['accept-encoding'] || ''; return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null; };
function compressed(entry, enc) {
  if (!enc || entry.raw.length < 1024) return null;
  return (entry[enc] ||= enc === 'br'
    ? brotliCompressSync(entry.raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } })
    : gzipSync(entry.raw, { level: 6 }));
}
function sendEntry(req, res, status, entry, type, extra = {}) {
  const enc = /^(text|application\/(json|manifest)|image\/svg)/.test(type) ? encodingFor(req) : null; // PNGs are already compressed
  const body = compressed(entry, enc);
  res.writeHead(status, { 'content-type': type, vary: 'accept-encoding', ...(body ? { 'content-encoding': enc } : {}), 'content-length': (body || entry.raw).length, ...extra });
  res.end(body || entry.raw);
}

async function proxy(route, url, req, res) {
  const path = url.pathname.slice(route.prefix.length);
  if (!route.allow.test(path)) return send(res, 404, { error: 'not allowed' });
  const target = `${route.upstream}/${path}${url.search}`;
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < 2000) return sendEntry(req, res, hit.status, hit, 'application/json', { 'cache-control': 'no-store' });
  try {
    const r = await fetch(target, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    const entry = { at: Date.now(), status: r.status, raw: Buffer.from(await r.text()) };
    cache.set(target, entry);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    sendEntry(req, res, r.status, entry, 'application/json', { 'cache-control': 'no-store' });
  } catch (e) {
    send(res, 502, { error: `upstream failed: ${e.message}` });
  }
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const cookieToken = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === 'sc_session')?.[1] || null;
// The platform proxy (Railway) appends the real client address as the LAST X-Forwarded-For entry;
// earlier entries are whatever the client sent, so trusting them would let anyone dodge rate limits.
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '?';
function sessionCookie(req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return { 'set-cookie': `sc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` };
}
function reply(req, res, out) {
  send(res, out.status, out.body, 'application/json', out.token ? sessionCookie(req, out.token) : {});
}

// /api/access/* — paywall actions anyone can call
async function accessApi(req, res, action, token) {
  if (action === 'status' && req.method === 'GET') return send(res, 200, access.statusBody(token));
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const ip = clientIp(req);
  const actions = {
    request: () => access.request(token, ip, body.code, body.device),
    paid: () => access.paid(token),
    redeem: () => access.redeem(body.code, ip, body.device),
    restore: () => access.restore(body.pass, ip, body.device),
    admin: () => access.admin(body.code, ip, body.device),
    logout: () => access.logout(token),
  };
  if (!actions[action]) return send(res, 404, { error: 'not found' });
  reply(req, res, actions[action]());
}

// /api/admin/* — admin only
async function adminApi(req, res, action, token) {
  if (!access.isAdminToken(token)) return send(res, 403, { error: 'admin only' });
  if (action === 'members' && req.method === 'GET') return reply(req, res, access.listMembers());
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const actions = { approve: access.approve, deny: access.deny, revoke: access.revoke, config: access.setConfig };
  if (!actions[action]) return send(res, 404, { error: 'not found' });
  reply(req, res, actions[action](body));
}

// POST /api/push/{sync,test,unsubscribe,report}
async function pushApi(req, res, action, token) {
  const handlers = { sync: bot.sync, test: bot.test, unsubscribe: bot.unsubscribe, report: bot.report };
  if (!handlers[action]) return send(res, 404, { error: 'not found' });
  const body = await readBody(req);
  const out = await handlers[action](body, { token });
  send(res, out.status, out.body);
}

const files = new Map(); // rel -> { mtime, raw, br?, gzip? }, refreshed when the file changes on disk
async function serveFile(req, res, rel) {
  try {
    const path = join(PUBLIC, rel), { mtimeMs } = await stat(path);
    let entry = files.get(rel);
    if (!entry || entry.mtime !== mtimeMs) files.set(rel, (entry = { mtime: mtimeMs, raw: await readFile(path) }));
    sendEntry(req, res, 200, entry, TYPES[extname(rel)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

export const server = http.createServer(async (req, res) => {
  try {
    await ready;
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const token = cookieToken(req);
    if (path === '/healthz') return send(res, 200, { ok: true, bot: bot.status() });

    const acc = path.match(/^\/api\/access\/(\w+)$/);
    if (acc) return await accessApi(req, res, acc[1], token);
    const adm = path.match(/^\/api\/admin\/(\w+)$/);
    if (adm) return await adminApi(req, res, adm[1], token);

    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const allowed = !PAYWALL || access.hasAccess(token);
    if (!allowed) {
      if (OPEN_FILES.has(rel) && req.method === 'GET') return serveFile(req, res, rel);
      if (rel === '/index.html') return serveFile(req, res, '/paywall.html'); // the app's URL shows the paywall
      return send(res, 401, { error: 'payment required', paywall: true });
    }

    const push = path.match(/^\/api\/push\/(\w+)$/);
    if (push && req.method === 'POST') return await pushApi(req, res, push[1], token);
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (path === '/api/push/key') return send(res, 200, { publicKey: bot.publicKey() });
    const route = ROUTES.find((r) => path.startsWith(r.prefix));
    if (route) return proxy(route, url, req, res);
    if (rel === '/paywall.html') return serveFile(req, res, '/index.html'); // already paid: go straight to the app
    return serveFile(req, res, rel);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Shot Caller on http://localhost:${PORT}${PAYWALL ? ' (paywall on)' : ''}`));
  ready.then(() => { if (bot.status().devices) bot.start(); });
}
