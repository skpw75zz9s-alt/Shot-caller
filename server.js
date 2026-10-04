// Zero-dependency server: serves the PWA and proxies the public Kalshi and
// Coinbase market-data APIs so the phone browser never hits CORS limits.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot } from './bot.js';

const PORT = Number(process.env.PORT || 8080);
const KALSHI = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = process.env.COINBASE_API || 'https://api.exchange.coinbase.com';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA_FILE = join(process.env.DATA_DIR || join(ROOT, 'data'), 'shot-caller.json');

export const bot = createBot({ kalshi: KALSHI, coinbase: COINBASE, dataFile: DATA_FILE });
const ready = bot.load();

// Only read-only market-data endpoints are reachable through the proxy.
const ROUTES = [
  { prefix: '/api/kalshi/', upstream: KALSHI, allow: /^(markets(\/[A-Za-z0-9._-]+)?|events\/[A-Za-z0-9._-]+|series\/[A-Za-z0-9._-]+)$/ },
  { prefix: '/api/coinbase/', upstream: COINBASE, allow: /^products\/BTC-USD\/(ticker|candles)$/ },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

const cache = new Map(); // tiny 2s cache so several open phones don't multiply upstream calls

async function proxy(route, url, res) {
  const path = url.pathname.slice(route.prefix.length);
  if (!route.allow.test(path)) return send(res, 404, { error: 'not allowed' });
  const target = `${route.upstream}/${path}${url.search}`;
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < 2000) return send(res, hit.status, hit.body);
  try {
    const r = await fetch(target, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    cache.set(target, { at: Date.now(), status: r.status, body });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    send(res, r.status, body);
  } catch (e) {
    send(res, 502, { error: `upstream failed: ${e.message}` });
  }
}

// POST /api/push/{sync,test,unsubscribe} with a small JSON body
async function pushApi(req, res, action) {
  const handlers = { sync: bot.sync, test: bot.test, unsubscribe: bot.unsubscribe, report: bot.report };
  if (!handlers[action]) return send(res, 404, { error: 'not found' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) return send(res, 413, { error: 'too large' });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); }
  await ready;
  const out = await handlers[action](body);
  send(res, out.status, out.body);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const push = url.pathname.match(/^\/api\/push\/(\w+)$/);
  if (push && req.method === 'POST') return pushApi(req, res, push[1]);
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (url.pathname === '/api/push/key') { await ready; return send(res, 200, { publicKey: bot.publicKey() }); }
  const route = ROUTES.find((r) => url.pathname.startsWith(r.prefix));
  if (route) return proxy(route, url, res);
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, bot: bot.status() });

  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(file);
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Shot Caller on http://localhost:${PORT}`));
  ready.then(() => { if (bot.status().devices) bot.start(); });
}
