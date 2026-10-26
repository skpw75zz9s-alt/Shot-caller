// The app moved (MOVED_TO): this server only sends everyone to the new address. Set MOVED_TO on the old host (for
// example Railway) to the new site's https address; the bots, feeds and Discord posts don't start there, so the old
// host stops doing the work twice. /healthz still answers, so the host's health check passes.
import http from 'node:http';

export function movedTarget(env = process.env) {
  const raw = String(env.MOVED_TO ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[\w.-]+(?::\d+)?$/.test(raw) ? raw : null;
}

// a phone that installed the app at the old address keeps its service worker; this one replaces it, removes itself and
// sends the open windows to the new address
const RETIRE_SW = (to) => `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()
  .then(() => self.clients.matchAll({ type: 'window' }))
  .then((cs) => Promise.all(cs.map((c) => c.navigate(${JSON.stringify(to)} + new URL(c.url).pathname).catch(() => {}))))));
`;

export function createMovedServer(to) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, movedTo: to }));
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end(RETIRE_SW(to));
    }
    // 301 for pages, 308 for anything else so a POST stays a POST
    const code = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    res.writeHead(code, { location: to + url.pathname + url.search, 'cache-control': 'no-store' });
    res.end();
  });
}
