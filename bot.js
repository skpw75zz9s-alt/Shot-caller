// Server-side bot: watches the markets on its own and sends Web Push notifications
// to subscribed phones, so alerts arrive even when the app is closed.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULTS, EXIT_DEFAULTS } from './public/model.js';
import { buyMessage, buySignal, parseCandles, positionCheck, sellMessage, snapshot, updateMessage } from './public/engine.js';
import { gradeWindow, newTracker, pendingWindows, pruneWindows, trackWindow } from './public/tracker.js';
import { generateVapidKeys, sendPush } from './push.js';

const DEVICE_DEFAULTS = { series: 'KXBTC15M', waitForDip: false, notifyBuy: true, notifySell: true, notifyUpdates: true, ...DEFAULTS, ...EXIT_DEFAULTS };
const MAX_DEVICES = 100;
// Only send to real browser push services (stops the server being used to POST anywhere).
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export function createBot({ kalshi, coinbase, dataFile, env = process.env, log = console, canNotify = () => true }) {
  const extraHosts = (env.PUSH_HOST_ALLOW || '').split(',').filter(Boolean);
  const devices = new Map(); // endpoint -> device
  let vapid = null, saveTimer = null, timer = null, busy = false, dirty = false, lastSave = 0;
  const results = new Map(); // ticker -> 'yes' | 'no' once Kalshi settles it
  const market = { spot: null, candles: [], candlesAt: 0, markets: {}, strikes: {}, quoteLogs: {}, lastTick: 0, lastError: null };

  // ---------- storage ----------
  async function load() {
    let data = {};
    try { data = JSON.parse(await readFile(dataFile, 'utf8')); } catch { /* first run */ }
    for (const d of data.devices || []) {
      if (d.settings?.minConfidence === 55) d.settings.minConfidence = 60; // v2.6: calls need B or better
      if (d.settings?.volMultiplier === 1.15) d.settings.volMultiplier = 1; // v3.2: measured vol
      if (d.settings?.momentumWeight === 0.25) d.settings.momentumWeight = 0; // v3.3: profit tuning
      if (d.settings?.minEdge === 0.04) d.settings.minEdge = 0.08;
      devices.set(d.endpoint, d);
    }
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
    else if (data.vapid) vapid = data.vapid;
    else {
      vapid = generateVapidKeys();
      log.warn('Generated new VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY so phones stay subscribed across redeploys.');
    }
    vapid.subject = env.VAPID_SUBJECT || 'https://github.com/skpw75zz9s-alt/Shot-caller';
    await save();
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1000);
  }
  async function save() {
    const fromEnv = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    const data = { vapid: fromEnv ? undefined : { publicKey: vapid.publicKey, privateKey: vapid.privateKey }, devices: [...devices.values()] };
    try {
      await mkdir(dirname(dataFile), { recursive: true });
      await writeFile(`${dataFile}.tmp`, JSON.stringify(data));
      await rename(`${dataFile}.tmp`, dataFile);
    } catch (e) { log.error('save failed', e.message); }
  }

  // ---------- API ----------
  function validSubscription(sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return false;
    try {
      const u = new URL(sub.endpoint);
      if (extraHosts.includes(u.hostname)) return true;
      return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
    } catch { return false; }
  }

  function cleanPositions(list) {
    return (Array.isArray(list) ? list : []).slice(0, 20).map((p) => ({
      id: String(p.id), ticker: String(p.ticker), side: p.side === 'NO' ? 'NO' : 'YES', closeTime: String(p.closeTime),
      price: Number(p.price), contracts: Number(p.contracts), peakBid: p.peakBid ?? null, peakP: p.peakP ?? null,
    })).filter((p) => p.price > 0 && p.price < 1 && p.contracts > 0 && !Number.isNaN(Date.parse(p.closeTime)));
  }

  function cleanSettings(s = {}) {
    const out = {};
    for (const [k, def] of Object.entries(DEVICE_DEFAULTS)) {
      const v = s[k];
      if (typeof def === 'number' && Number.isFinite(Number(v))) out[k] = Number(v);
      else if (typeof def === 'boolean' && typeof v === 'boolean') out[k] = v;
      else if (typeof def === 'string' && typeof v === 'string' && /^[A-Z0-9_-]{1,40}$/.test(v)) out[k] = v;
      else out[k] = def;
    }
    return out;
  }

  // Phone sends its subscription, settings and open positions; we keep the highest peaks seen.
  const validTz = (tz) => {
    if (typeof tz !== 'string' || tz.length > 64) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
  };

  function sync({ subscription, settings, positions, tz }, ctx = {}) {
    if (!validSubscription(subscription)) return { status: 400, body: { error: 'invalid subscription' } };
    const prev = devices.get(subscription.endpoint);
    if (!prev && devices.size >= MAX_DEVICES) return { status: 429, body: { error: 'too many devices' } };
    const next = cleanPositions(positions).map((p) => {
      const old = prev?.positions.find((o) => o.id === p.id);
      return old ? { ...p, peakBid: Math.max(p.peakBid ?? 0, old.peakBid ?? 0) || null, peakP: Math.max(p.peakP ?? 0, old.peakP ?? 0) || null } : p;
    });
    devices.set(subscription.endpoint, {
      endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      settings: cleanSettings(settings), positions: next, alerted: prev?.alerted ?? {}, tracker: prev?.tracker ?? newTracker(), fails: 0,
      token: ctx.token ?? prev?.token ?? null, // paywall session, so alerts stop if access lapses
      tz: validTz(tz) ?? prev?.tz ?? null, lastWindow: prev?.lastWindow ?? null,
      createdAt: prev?.createdAt ?? Date.now(), lastSeen: Date.now(),
    });
    scheduleSave();
    start();
    return { status: 200, body: { ok: true, positions: next.length } };
  }

  function unsubscribe({ endpoint }) {
    devices.delete(endpoint);
    scheduleSave();
    return { status: 200, body: { ok: true } };
  }

  async function notify(device, msg, topic) {
    try {
      const status = await sendPush(device, { ...msg, url: './' }, vapid, { topic });
      if (status === 404 || status === 410) { devices.delete(device.endpoint); scheduleSave(); return false; }
      if (status >= 400) throw new Error(`push service ${status}`);
      device.fails = 0;
      return true;
    } catch (e) {
      device.fails = (device.fails || 0) + 1;
      log.warn('push failed', e.message);
      if (device.fails >= 20) { devices.delete(device.endpoint); scheduleSave(); }
      return false;
    }
  }

  // Report cards for the windows this phone's bot was graded on (whole 15 minutes each).
  function report({ endpoint }) {
    const d = devices.get(endpoint);
    if (!d) return { status: 404, body: { error: 'not subscribed' } };
    return { status: 200, body: { reports: d.tracker?.reports ?? [] } };
  }

  // Send one message to every device matching `pred` (e.g. admins' phones).
  async function notifyWhere(pred, msg) {
    await Promise.all([...devices.values()].filter(pred).map((d) => notify(d, msg, msg.tag)));
  }

  async function test({ endpoint }) {
    const d = devices.get(endpoint);
    if (!d) return { status: 404, body: { error: 'not subscribed, tap Enable push first' } };
    const ok = await notify(d, { tag: 'test', title: 'Shot Caller ✓', body: 'Push works. You\'ll get BUY THE LOW and SELL NOW alerts even with the app closed.' });
    return { status: ok ? 200 : 502, body: { ok } };
  }

  // ---------- market loop ----------
  async function getJSON(url) {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function refresh(now) {
    const series = [...new Set([...devices.values()].map((d) => d.settings.series))];
    const jobs = [getJSON(`${coinbase}/products/BTC-USD/ticker`).then((t) => { market.spot = Number(t.price); })];
    if (now - market.candlesAt > 20000) {
      jobs.push(getJSON(`${coinbase}/products/BTC-USD/candles?granularity=60`).then((rows) => { market.candles = parseCandles(rows); market.candlesAt = now; }));
    }
    for (const s of series) {
      jobs.push(getJSON(`${kalshi}/markets?series_ticker=${encodeURIComponent(s)}&status=open&limit=50`).then((d) => {
        market.markets[s] = (d.markets || []).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
      }));
    }
    await Promise.all(jobs);
  }

  async function tick(now = Date.now()) {
    if (busy || !devices.size) return;
    busy = true;
    try {
      await refresh(now);
      market.lastTick = now; market.lastError = null;
      await gradeClosedWindows(now); // first, so the 15-minute update can include the result
      const sends = [];
      for (const d of devices.values()) {
        if (!canNotify(d)) continue; // paywall: no access, no bot
        const s = d.settings;
        const quoteLog = (market.quoteLogs[s.series] ||= {});
        const snap = snapshot({ markets: market.markets[s.series] || [], candles: market.candles, spot: market.spot, settings: s, strikes: market.strikes, quoteLog, now });
        const fire = (key, msg) => {
          if (d.alerted[key]) return;
          d.alerted[key] = now;
          sends.push(notify(d, msg, key));
        };

        if (snap.live) {
          d.calls ||= {}; // what this phone's bot has called per window, so it sticks with its calls
          const sig = buySignal(snap.live, snap, s, now, d.calls);
          d.tracker ||= newTracker();
          if (trackWindow(d.tracker, snap, snap.live, sig, s, now)) dirty = true;
          if (s.notifyBuy && sig.fire) fire(`buy:${snap.live.m.ticker}:${sig.callSide}:${sig.buyNow ? 'low' : 'call'}`, buyMessage(snap.live, sig, market.spot));
          if (windowUpdate(d, snap, sig, now) && s.notifyUpdates) {
            const open = Date.parse(snap.live.m.open_time);
            const prev = d.tracker.reports.find((r) => r.closeTime === open) ?? null;
            fire(`update:${snap.live.m.ticker}`, updateMessage({ prev, row: snap.live, sig, spot: market.spot, tz: d.tz, now }));
          }
        }
        for (const pos of d.positions) {
          const check = positionCheck(pos, snap, s, now);
          if (s.notifySell && check.ex.action === 'SELL') fire(`sell:${pos.id}:${check.ex.kind}`, sellMessage(pos, check, market.spot));
        }

        // Drop positions 5 minutes after their market closes, and alert keys after 2 hours
        d.positions = d.positions.filter((p) => Date.parse(p.closeTime) > now - 5 * 60000);
        for (const [k, t] of Object.entries(d.alerted)) if (t < now - 2 * 3600000) delete d.alerted[k];
        for (const [k, c] of Object.entries(d.calls || {})) if (!(c.at > now - 2 * 3600000)) delete d.calls[k];
      }
      await Promise.all(sends);
      if (sends.length) scheduleSave();
      if (dirty && now - lastSave > 30000) { dirty = false; lastSave = now; scheduleSave(); }
    } catch (e) {
      market.lastError = e.message;
      log.warn('bot tick failed', e.message);
    } finally {
      busy = false;
    }
  }

  // A new 15-minute window has opened for this phone: time for an update. Waits up to 4 minutes
  // for Kalshi to settle the previous window so its result rides along. The window that was open
  // when the phone subscribed doesn't count (no update right after turning push on).
  function windowUpdate(d, snap, sig, now) {
    const ticker = snap.live.m.ticker;
    if (d.lastWindow === ticker) return false;
    if (d.lastWindow == null) { d.lastWindow = ticker; return false; }
    const open = Date.parse(snap.live.m.open_time);
    const settling = Object.values(d.tracker.windows).some((w) => w.closeTime === open);
    if (settling && now - open < 4 * 60000) return false;
    d.lastWindow = ticker;
    dirty = true;
    return true;
  }

  // Fetch results for closed windows (a few per tick) and grade every phone's tracker.
  async function gradeClosedWindows(now) {
    const pending = new Set();
    for (const d of devices.values()) if (d.tracker) for (const w of pendingWindows(d.tracker, now)) pending.add(w.ticker);
    for (const t of [...pending].filter((x) => !results.has(x)).slice(0, 3)) {
      try {
        const { market: mk } = await getJSON(`${kalshi}/markets/${encodeURIComponent(t)}`);
        if (mk?.result === 'yes' || mk?.result === 'no') results.set(t, mk.result);
      } catch { /* retry next tick */ }
    }
    for (const d of devices.values()) {
      if (!d.tracker) continue;
      for (const w of pendingWindows(d.tracker, now)) if (results.has(w.ticker)) { gradeWindow(d.tracker, w.ticker, results.get(w.ticker)); dirty = true; }
      pruneWindows(d.tracker, now);
    }
    if (results.size > 500) results.delete(results.keys().next().value);
  }

  function start(intervalMs = Number(env.BOT_INTERVAL_MS || 5000)) {
    if (!timer) timer = setInterval(() => tick(), intervalMs);
  }
  function stop() { clearInterval(timer); timer = null; clearTimeout(saveTimer); }

  const status = () => ({ devices: devices.size, lastTick: market.lastTick || null, lastError: market.lastError });
  return { load, save, start, stop, tick, sync, unsubscribe, test, report, notifyWhere, status, publicKey: () => vapid.publicKey, devices };
}
