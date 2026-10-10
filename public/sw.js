// App-shell cache; API calls always go to the network.
const CACHE = 'shot-caller-v92';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'model.js', 'candles.js', 'engine.js', 'analysis.js', 'tracker.js', 'kalshi.js', 'notify.js', 'health.js', 'record.js', 'learner.js', 'indicators.js', 'chart.js', 'flow.js', 'alerts.js', 'alertui.js', 'feeds.js', 'fx.js', 'suggest.js', 'trader.js', 'autopilot.js', 'roundscan.js', 'predict.js', 'tvchart.js', 'vendor/lightweight-charts.js', 'icon-192.png', 'manifest.webmanifest', 'icon.svg', 'bull.svg', 'bear.svg', 'sounds/bull.mp3', 'sounds/bear.mp3', 'sounds/wait.mp3', 'sounds/bail.mp3', 'sounds/register.mp3'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request)));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});

// Web Push from the server bot: show it even when the app is closed.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Shot Caller', {
    body: d.body, tag: d.tag, renotify: !!d.tag, icon: 'icon-192.png', badge: 'icon-192.png',
    vibrate: [200, 100, 200], data: { url: d.url || './' },
  }));
});
