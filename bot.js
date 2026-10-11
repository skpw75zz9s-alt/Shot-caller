// Server-side bot: watches the markets on its own and sends Web Push notifications
// to subscribed phones, so alerts arrive even when the app is closed.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULTS, EXIT_DEFAULTS, quote, riskSettings } from './public/model.js';
import { addMessage, bailMessage, buyMessage, buySignal, parseCandles, positionCheck, releaseCall, sellMessage, snapshot, updateMessage } from './public/engine.js';
import { gradeWindow, newTracker, pendingWindows, pruneWindows, trackWindow } from './public/tracker.js';
import { generateVapidKeys, sendPush } from './push.js';
import { createIndex, defaultSources } from './index.js';
import { allowAlert, hourlyWindow } from './public/notify.js';
import { callStats, logCall, settleCalls, streaks, unsettledCalls } from './public/record.js';
import { basisOf, calTable, learnBasis, learnCandles, learnWindow, newLearned, publicLearned, volFactor, volProfile } from './public/learner.js';
import { newPulse, prunePulse, pulseBlend, pulseRound, pulseSecond, pulseSettle, pulseStatus } from './public/pulse.js';
import { learnGate } from './public/callgate.js';

const DEVICE_DEFAULTS = { series: 'KXBTC15M', waitForDip: false, notifyBuy: true, notifySell: true, notifyUpdates: true, updateMinutes: 60, ...DEFAULTS, ...EXIT_DEFAULTS };
const MAX_DEVICES = 100;
// Only send to real browser push services (stops the server being used to POST anywhere).
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

// learn: watch the market around the clock (even with no phones subscribed), backfill a few weeks of BTC history
// on first start, and keep what's learned in learned.json next to the data file (public/learner.js).
// indexSources: exchanges for the BTC index estimate (index.js); INDEX=off uses Coinbase alone.
// watch: () => Market watch's status (marketwatch.js): its holds pause new calls; its event count goes into the call record
// shiftInfo: () => { scan, micro } which nudges are in use right now (for the 'used in calls' panel)
// shifts: () => { ticker: points } proven learned nudges to the odds (the Round scan, scanfeed.js)
// liveSpot: () => the latest BTC price from the server's own exchange trade feeds (scanfeed.js), or null. The bot ticks
// every second; the exchanges' REST tickers are only polled every 5 seconds, and in between the live trades move the price.
export function createBot({ kalshi, coinbase, dataFile, env = process.env, log = console, canNotify = () => true, learn = false, indexSources = null, onObserve = null, keepAlive = () => false, liveSpot = () => null, shifts = () => null, watch = () => null, shiftInfo = () => ({}) }) {
  const extraHosts = (env.PUSH_HOST_ALLOW || '').split(',').filter(Boolean);
  const devices = new Map(); // endpoint -> device
  let vapid = null, saveTimer = null, timer = null, busy = false, dirty = false, lastSave = 0;
  const results = new Map(); // ticker -> 'yes' | 'no' once Kalshi settles it
  const market = { spot: null, candles: [], candlesAt: 0, indexAt: 0, feedOffset: 0, gradedAt: 0, markets: {}, strikes: {}, quoteLogs: {}, lastTick: 0, lastError: null };
  const learnFile = dataFile.replace(/[^/\\]+$/, 'learned.json');
  let learned = newLearned(), learnDirty = false, learnSavedAt = 0, backfilling = false, backfillStop = false;
  let learnedShifts = null, gateDirty = false, watchNow = null; // this tick's proven nudges (shifts())
  const lw = {}; // ticker -> { closeTime, samples: [raw P(YES) once a minute], minute, spots: [Coinbase in the last minute] }
  const settledValue = new Map(); // ticker -> Kalshi's settlement index value (expiration_value), when it reports one
  const LEARN_SERIES = 'KXBTC15M';
  // The official bot record: every call the server's own bot makes on the default (Steady) settings, around the
  // clock, graded against Kalshi's result. Kept in record.json next to the data file; the same for every user.
  const OFFICIAL = { ...DEVICE_DEFAULTS, ...riskSettings('steady') };
  const recordFile = dataFile.replace(/[^/\\]+$/, 'record.json');
  let record = [], recordDirty = false, recordSavedAt = 0;
  const officialMem = {};
  // Near-certain (v11.7): the same engine on the strictest level, with its own graded record next to the official one
  const CERTAIN = { ...DEVICE_DEFAULTS, ...riskSettings('certain') };
  const certainFile = dataFile.replace(/[^/\\]+$/, 'record-certain.json');
  let certainRecord = [], certainDirty = false;
  const certainMem = {};
  const sources = indexSources ?? (env.INDEX === 'off' ? defaultSources(coinbase).slice(0, 1) : defaultSources(coinbase));
  const index = createIndex({ sources, fetchJSON: (u) => getJSON(u) });

  // ---------- storage ----------
  async function load() {
    let data = {};
    try { data = JSON.parse(await readFile(dataFile, 'utf8')); } catch { /* first run */ }
    for (const d of data.devices || []) {
      if (d.settings?.minConfidence === 55) d.settings.minConfidence = 60; // v2.6: calls need B or better
      if (d.settings?.volMultiplier === 1.15) d.settings.volMultiplier = 1; // v3.2: measured vol
      if (d.settings?.momentumWeight === 0.25) d.settings.momentumWeight = 0; // v3.3: profit tuning
      if (d.settings?.minEdge === 0.04) d.settings.minEdge = 0.08;
      if (d.settings?.minEdge === 0.08 && d.settings?.minConfidence === 60) Object.assign(d.settings, { minEdge: 0.06, minConfidence: 55 }); // v3.9: Balanced
      if (d.settings?.minEdge === 0.04 && d.settings?.minConfidence === 50 && d.settings.scaleIn == null) d.settings.scaleIn = true; // v3.10: Aggressive scales in
      if (d.settings?.minEdge === 0.04 && d.settings?.minConfidence === 50) Object.assign(d.settings, riskSettings('aggressive')); // v3.12: optimized Aggressive
      if (d.settings && !d.confOdds) { // v4.1: confidence = win odds, bars double (risk levels get their new settings)
        const lvl = { 0.08: ['safe', 60], 0.06: ['balanced', 55], 0.02: ['aggressive', 40] }[d.settings.minEdge];
        if (lvl && d.settings.minConfidence === lvl[1]) Object.assign(d.settings, riskSettings(lvl[0]));
        else if (d.settings.minConfidence != null) d.settings.minConfidence = Math.min(95, Math.round(d.settings.minConfidence * 2));
      }
      if (d.settings) d.confOdds = true;
      devices.set(d.endpoint, d);
    }
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
    else if (data.vapid) vapid = data.vapid;
    else {
      vapid = generateVapidKeys();
      log.warn('Generated new VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY so phones stay subscribed across redeploys.');
    }
    vapid.subject = env.VAPID_SUBJECT || 'https://github.com/skpw75zz9s-alt/Shot-caller';
    try { const r = JSON.parse(await readFile(recordFile, 'utf8')); if (Array.isArray(r)) record = r; } catch { /* no record yet */ }
    try { const r = JSON.parse(await readFile(certainFile, 'utf8')); if (Array.isArray(r)) certainRecord = r; } catch { /* no record yet */ }
    try { const L = JSON.parse(await readFile(learnFile, 'utf8')); if (L?.v === 1 && L.vol?.s2?.length === 336) learned = { ...newLearned(), ...L, pulse: L.pulse?.v === 1 ? { ...newPulse(), ...L.pulse } : newPulse() }; } catch { /* first run: learns from scratch */ }
    await save();
    if (learn) startLearning();
  }
  function startLearning() {
    learn = true;
    start();
    backfill().catch((e) => log.warn('backfill stopped', e.message));
  }
  async function saveLearned() {
    learnDirty = false; learnSavedAt = Date.now();
    try {
      await mkdir(dirname(learnFile), { recursive: true });
      await writeFile(`${learnFile}.tmp`, JSON.stringify(learned));
      await rename(`${learnFile}.tmp`, learnFile);
    } catch (e) { log.error('saving what was learned failed', e.message); }
  }

  // First start (or a long outage): read up to 4 weeks of 1-minute BTC history so the time-of-week pattern is
  // known from day one. Coinbase serves 300 minutes per request; one request every ~0.4s.
  async function backfill(now = Date.now(), weeks = 4) {
    const from = Math.max(learned.vol.lastT + 60000, now - weeks * 7 * 86400000);
    if (now - from < 6 * 3600000) return;
    backfilling = true;
    try {
      for (let a = from; a < now && !backfillStop; a += 300 * 60000) {
        const b = Math.min(now, a + 300 * 60000);
        try {
          const rows = await getJSON(`${coinbase}/products/BTC-USD/candles?granularity=60&start=${new Date(a - 60000).toISOString()}&end=${new Date(b).toISOString()}`);
          if (Array.isArray(rows) && learnCandles(learned, parseCandles(rows))) learnDirty = true;
        } catch { /* a missing chunk just leaves a gap */ }
        await new Promise((r) => { const t = setTimeout(r, 400); t.unref?.(); });
      }
    } finally { backfilling = false; }
    log.log?.(`learned ${learned.vol.minutes} minutes of BTC history`);
    await saveLearned();
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
      settings: cleanSettings(settings), positions: next, alerted: prev?.alerted ?? {}, calls: prev?.calls ?? {}, notifyLog: prev?.notifyLog ?? {}, tracker: prev?.tracker ?? newTracker(), fails: 0,
      token: ctx.token ?? prev?.token ?? null, // paywall session, so alerts stop if access lapses
      tz: validTz(tz) ?? prev?.tz ?? null, lastWindow: prev?.lastWindow ?? null,
      createdAt: prev?.createdAt ?? Date.now(), lastSeen: Date.now(), confOdds: true,
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

  async function notify(device, msg, topic, ttl = 300) {
    try {
      const status = await sendPush(device, { ...msg, url: './' }, vapid, { topic, ttl });
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
    const series = [...new Set([LEARN_SERIES, ...[...devices.values()].map((d) => d.settings.series)])];
    // BTC: the multi-exchange index estimate, or Coinbase alone if the other exchanges don't answer. Polled every 5
    // seconds (the exchanges' rate limits); every second in between, the live trade feeds move it (kept on the
    // index's level by the offset measured at the last poll).
    const jobs = [];
    const feed = liveSpot();
    if (now - market.indexAt >= 5000 || !market.spot || !feed) {
      market.indexAt = now;
      jobs.push(index.poll(now).then((ix) => {
        const p = ix.index ?? ix.coinbase;
        if (!p) throw new Error('no BTC price from any exchange');
        market.spot = p; market.index = ix;
        market.feedOffset = feed ? p - feed : 0;
      }));
    } else market.spot = feed + market.feedOffset;
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
    if (busy || (!devices.size && !learn && !keepAlive())) return;
    busy = true;
    try {
      await refresh(now);
      market.lastTick = now; market.lastError = null;
      // the price every second (5 minutes kept): if a market ever comes without Kalshi's strike, its target is the
      // 60-second average before the open, the way Kalshi settles (instead of the first candle's open)
      if (market.spot) { (market.spotRing ||= []).push({ t: now, p: market.spot }); while (market.spotRing[0].t < now - 300000) market.spotRing.shift(); }
      for (const ms of Object.values(market.markets)) for (const m of ms) {
        if (m.floor_strike != null || m.cap_strike != null || market.strikes[m.ticker]) continue;
        const open = Date.parse(m.open_time), xs = (market.spotRing || []).filter((x) => x.t >= open - 60000 && x.t < open);
        if (now >= open && xs.length >= 30) market.strikes[m.ticker] = xs.reduce((a, x) => a + x.p, 0) / xs.length;
      }
      if (now - market.gradedAt >= 5000) { market.gradedAt = now; await gradeClosedWindows(now); } // first, so the 15-minute update can include the result
      learnedShifts = shifts();
      watchNow = watch();
      observe(now);
      const sends = [];
      for (const d of devices.values()) {
        if (!canNotify(d)) continue; // paywall: no access, no bot
        const s = d.settings;
        const quoteLog = (market.quoteLogs[s.series] ||= {});
        const snap = snapshot({ markets: market.markets[s.series] || [], candles: market.candles, spot: market.spot, settings: s, strikes: market.strikes, quoteLog, learned, now, shifts: learnedShifts });
        snap.watchHold = watchNow?.hold ?? null; snap.watchEvents60 = watchNow?.events60 ?? 0;
        // Each alert key goes out at most once, and only if the anti-spam limiter allows it (public/notify.js)
        const fire = (key, msg, ttl, kind, extra = {}) => {
          if (d.alerted[key]) return;
          d.alerted[key] = now; // held back counts as handled: a stale alert is never sent later
          if (!allowAlert((d.notifyLog ||= {}), kind, { ...extra, now })) return;
          sends.push(notify(d, msg, key, ttl));
        };

        if (snap.live) {
          d.calls ||= {}; // what this phone's bot has called per window, so it sticks with its calls
          const sig = buySignal(snap.live, snap, s, now, d.calls);
          d.tracker ||= newTracker();
          if (trackWindow(d.tracker, snap, snap.live, sig, s, now)) dirty = true;
          if (s.notifyBuy && sig.fire) fire(`buy:${snap.live.m.ticker}:${sig.callSide}:${sig.callN}`, buyMessage(snap.live, sig, market.spot), 45, 'buy', { ticker: snap.live.m.ticker }); // a buy call is stale within a minute: never deliver it late
          // The bot's call went bad: bail out (phones tracking a position on it get the position's own sell alert)
          if (s.notifySell && sig.bail && !d.positions.some((p) => p.ticker === snap.live.m.ticker)) fire(`bail:${snap.live.m.ticker}`, bailMessage(snap.live, sig), 120, 'sell', { ticker: snap.live.m.ticker, posId: `bail:${snap.live.m.ticker}` });
          // Aggressive scale-in: only phones holding that call hear about the add
          if (s.notifyBuy && sig.add && d.positions.some((p) => p.ticker === snap.live.m.ticker && p.side === sig.callSide)) {
            fire(`add:${snap.live.m.ticker}:${sig.tier}`, addMessage(snap.live, sig, market.spot), 45, 'add', { ticker: snap.live.m.ticker });
          }
          if (windowUpdate(d, snap, sig, now) && s.notifyUpdates && hourlyWindow(Date.parse(snap.live.m.open_time), s.updateMinutes)) { // hourly unless set to every window
            const open = Date.parse(snap.live.m.open_time);
            const prev = d.tracker.reports.find((r) => r.closeTime === open) ?? null;
            fire(`update:${snap.live.m.ticker}`, updateMessage({ prev, row: snap.live, sig, spot: market.spot, tz: d.tz, now }), 300, 'update', { ticker: snap.live.m.ticker });
          }
        }
        for (const pos of d.positions) {
          const check = positionCheck(pos, snap, s, now);
          if (check.ex.action === 'SELL') {
            if (s.notifySell) fire(`sell:${pos.id}:${check.ex.kind}`, sellMessage(pos, check, market.spot), 300, 'sell', { posId: pos.id });
            releaseCall(d.calls, pos.ticker, now, s); // after the sell call, a fresh buy call on this market can fire again
          }
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

  // ---------- learning (every window, all day, every day) ----------
  function observe(now) {
    if (!backfilling && learnCandles(learned, market.candles.filter((c) => c.t + 60000 <= now))) learnDirty = true;
    const snap = snapshot({ markets: market.markets[LEARN_SERIES] || [], candles: market.candles, spot: market.spot, settings: DEVICE_DEFAULTS, strikes: market.strikes, quoteLog: (market.quoteLogs.__learn ||= {}), learned, now, shifts: learnedShifts });
    snap.watchHold = watchNow?.hold ?? null; snap.watchEvents60 = watchNow?.events60 ?? 0;
    for (const row of snap.rows) {
      const close = Date.parse(row.m.close_time);
      if (!(close > now)) continue;
      const w = (lw[row.m.ticker] ||= { closeTime: close, samples: [], minute: null, spots: [] });
      const minute = Math.floor(now / 60000);
      // The bot's raw odds (before any calibration) once a minute while calls are allowed
      if (row.ev.callsAt && now >= row.ev.callsAt && close - now > 30000 && w.minute !== minute && row.pRaw != null) { w.samples.push(row.pRaw); w.minute = minute; }
      if (close - now <= 60000 && market.spot) w.spots.push(market.spot);
    }
    for (const [t, w] of Object.entries(lw)) if (w.closeTime < now - 2 * 3600000) delete lw[t];
    // Learning every second (public/pulse.js): grade the bot's volatility from a minute ago against the move, and keep
    // this second's bot odds and Kalshi price for the round's blend test
    const lv = snap.live;
    const baseSigma = snap.sigmaMin && lv ? snap.sigmaMin * volFactor(learned, now, Date.parse(lv.m.close_time)) : snap.sigmaMin;
    if (pulseSecond(learned.pulse, { t: now, price: market.spot, sigmaMin: baseSigma })) learnDirty = true;
    if (lv && lv.ev.minutesLeft > 0 && lv.pBot != null) {
      const q = quote(lv.m);
      if (q.yesBid != null && q.yesAsk != null) pulseRound(learned.pulse, { ticker: lv.m.ticker, closeTime: Date.parse(lv.m.close_time), pBot: lv.pBot, mid: (q.yesBid + q.yesAsk) / 2 });
    }
    if (learnDirty && now - learnSavedAt > 5 * 60000) saveLearned();
    // The official call for this round (same engine and rules as the phones on Steady)
    const sig = snap.live ? buySignal(snap.live, snap, OFFICIAL, now, officialMem) : null;
    // The server-side Auto-trader trades the same official call (autotrade.js)
    try { onObserve?.({ snap, sig, known: results }); } catch (e) { log.error('auto-trader step failed', e.message); }
    if (snap.live) {
      // what the bot saw at the call, for the call filter to learn from (public/callgate.js)
      const q = snap.live.ev.quote, spread = q.yesAsk != null && q.yesBid != null ? Math.round((q.yesAsk - q.yesBid) * 100) / 100 : null;
      const feat = { mins: Math.round(snap.live.ev.minutesLeft * 10) / 10, stab: sig.stability?.score ?? null, vr: snap.sigmaMin && snap.sigmaLong ? Math.round(snap.sigmaMin / snap.sigmaLong * 100) / 100 : null, spread, ev60: watchNow?.events60 ?? 0 };
      if (sig.fire && logCall(record, { ticker: snap.live.m.ticker, side: sig.callSide, price: sig.price, conf: sig.deep?.score ?? null, hold: sig.hold ?? null, at: now, closeTime: snap.live.m.close_time, n: sig.callN, feat }, 20000)) { recordDirty = true; saveRecord(); }
    }
    // Near-certain's own calls (graded like the official ones; never traded, never fed to the call filter)
    const sigC = snap.live ? buySignal(snap.live, snap, CERTAIN, now, certainMem) : null;
    if (sigC?.fire && logCall(certainRecord, { ticker: snap.live.m.ticker, side: sigC.callSide, price: sigC.price, conf: sigC.deep?.score ?? null, hold: sigC.hold ?? null, at: now, closeTime: snap.live.m.close_time, n: sigC.callN }, 20000)) saveCertain();
    for (const [k, c] of Object.entries(officialMem)) if (!(c.at > now - 2 * 3600000)) delete officialMem[k];
    for (const [k, c] of Object.entries(certainMem)) if (!(c.at > now - 2 * 3600000)) delete certainMem[k];
  }
  async function saveRecord() {
    recordDirty = false; recordSavedAt = Date.now();
    try {
      await mkdir(dirname(recordFile), { recursive: true });
      await writeFile(`${recordFile}.tmp`, JSON.stringify(record));
      await rename(`${recordFile}.tmp`, recordFile);
    } catch (e) { log.error('saving the bot record failed', e.message); }
  }
  async function saveCertain() {
    certainDirty = false;
    try { await mkdir(dirname(certainFile), { recursive: true }); await writeFile(`${certainFile}.tmp`, JSON.stringify(certainRecord)); await rename(`${certainFile}.tmp`, certainFile); } catch (e) { log.error('saving the near-certain record failed', e.message); }
  }
  function officialRecord() {
    return { level: 'Steady', since: record[0]?.at ?? null, ...callStats(record), ...streaks(record), calls: record.slice(-400),
      certain: { level: 'Near-certain', since: certainRecord[0]?.at ?? null, ...callStats(certainRecord), ...streaks(certainRecord), calls: certainRecord.slice(-100) } };
  }
  function learnFrom(t) {
    const w = lw[t];
    if (!w || !results.has(t)) return;
    delete lw[t];
    learnWindow(learned, w.samples, results.get(t));
    if (settledValue.has(t) && w.spots.length >= 6) learnBasis(learned, settledValue.get(t), w.spots.reduce((a, b) => a + b, 0) / w.spots.length);
    learnDirty = true;
  }
  function learnStatus(now = Date.now()) {
    const p = volProfile(learned);
    const live = (market.markets[LEARN_SERIES] || []).find((m) => Date.parse(m.close_time) > now);
    return {
      minutes: learned.vol.minutes, since: learned.vol.firstT, windows: learned.windows, backfilling,
      busiest: p?.busiest ?? null, quietest: p?.quietest ?? null, profile: p?.rel ?? null,
      nowFactor: live ? volFactor(learned, now, Date.parse(live.close_time)) : null,
      calibration: calTable(learned), basis: basisOf(learned), basisN: learned.basis.length,
      pulse: pulseStatus(learned.pulse),
      // every learner, and whether it shapes the bot's calls yet (each one only does once it has proven itself)
      using: usingStatus(p),
    };
  }

  function usingStatus(p) {
    const cal = calTable(learned), corrected = cal.filter((b) => b.shift).length, pb = pulseBlend(learned.pulse), g = learned.callGate, fixOn = pulseStatus(learned.pulse);
    const info = shiftInfo() || {}, scanOn = !!info.scan, microOn = !!info.micro, tuned = info.tune || [], revBands = info.reversal || [];
    return [
      { key: 'vol', name: 'Volatility by time of week', on: !!p, detail: p ? 'prices the coming minutes with how busy this half hour usually is' : 'needs a week of history' },
      { key: 'cal', name: 'Calibration', on: corrected > 0, detail: corrected ? `corrects ${corrected} confidence band${corrected === 1 ? '' : 's'} from graded rounds` : 'no band has needed (or earned) a correction yet' },
      { key: 'basis', name: 'Coinbase vs Kalshi\'s settlement', on: learned.basis.length >= 10, detail: learned.basis.length >= 10 ? `${basisOf(learned) >= 0 ? '+' : '−'}$${Math.abs(basisOf(learned)).toFixed(2)} folded into the price` : `${learned.basis.length} of 10 settlements` },
      { key: 'fix', name: 'Live volatility check (every second)', on: fixOn.fix !== 1, detail: fixOn.helping == null ? `switches on after an hour of grading` : fixOn.helping ? `×${fixOn.fix.toFixed(2)} volatility` : 'off: not beating no correction lately' },
      { key: 'blend', name: 'Kalshi\'s price', on: pb.use, detail: pb.use ? `${Math.round(pb.w * 100)}% Kalshi in the odds (${(pb.gain * 100).toFixed(1)}% more accurate over ${pb.rounds} rounds)` : `${pb.rounds}/150 rounds${pb.rounds >= 150 ? ': no blend beats the bot alone yet' : ''}` },
      { key: 'scan', name: 'Round scan', on: !!scanOn, detail: scanOn ? 'its proven reads nudge the odds (±8 pts max)' : 'until its graded record shows it makes the odds more accurate' },
      { key: 'micro', name: 'Small details (micro model)', on: microOn, detail: microOn ? 'its proven 1-5 minute read shifts the odds (±6 pts max)' : 'until it beats "no change" (500+ graded predictions, 0.5%+ better)' },
      { key: 'tune', name: 'Tuned indicators', on: tuned.length > 0, detail: tuned.length ? `${tuned.join(', ')}: proven on rounds they were never tuned on; nudges the odds (±4 pts max)` : 'no indicator setting has predicted the rounds out of sample yet (rechecked hourly)' },
      { key: 'reversal', name: 'Reversal checklist', on: revBands.length > 0, detail: revBands.length ? `its ${revBands.join(' and ')} signals have called the next round better than a coin flip (100+ signals); they nudge that round (±4 pts max)` : 'until a score band calls the next round better than a coin flip (z 2.5+ on 100+ signals)' },
      { key: 'gate', name: 'Call filter (learns from the bot\'s own calls)', on: !!g?.active, detail: g?.active ? `skips calls like the ones that lost: in the replay the ${g.replay.skipped} it would have skipped won ${Math.round(g.replay.skippedWin * 100)}% (vs ${Math.round(g.replay.keptWin * 100)}% kept) and lost $${Math.abs(g.replay.skippedPnl).toFixed(2)}/contract`
        : `${g?.n ?? 0}/120 graded calls${g?.replay ? ` · replay: skipping would have ${g.replay.skippedPnl < 0 ? 'helped, not proven yet' : 'cost money, so it stays off'}` : ''}` },
    ];
  }
  // Fetch results for closed windows (a few per tick) and grade every phone's tracker.
  async function gradeClosedWindows(now) {
    const pending = new Set();
    for (const d of devices.values()) if (d.tracker) for (const w of pendingWindows(d.tracker, now)) pending.add(w.ticker);
    for (const [t, w] of Object.entries(lw)) if (w.closeTime < now - 60000) pending.add(t);
    for (const [t, r] of Object.entries(learned.pulse.live)) if (r.closeTime < now - 60000) pending.add(t);
    for (const e of unsettledCalls(record, now)) pending.add(e.ticker);
    for (const e of unsettledCalls(certainRecord, now)) pending.add(e.ticker);
    for (const t of [...pending].filter((x) => !results.has(x)).slice(0, 3)) {
      try {
        const { market: mk } = await getJSON(`${kalshi}/markets/${encodeURIComponent(t)}`);
        if (mk?.result === 'yes' || mk?.result === 'no') {
          results.set(t, mk.result);
          const v = Number(mk.expiration_value);
          if (Number.isFinite(v) && v > 0) settledValue.set(t, v);
        } else if (lw[t] && lw[t].closeTime < now - 3600000) delete lw[t]; // voided or never settled: nothing to learn
      } catch { /* retry next tick */ }
    }
    for (const t of Object.keys(lw)) learnFrom(t);
    for (const t of Object.keys(learned.pulse.live)) if (results.has(t) && pulseSettle(learned.pulse, t, results.get(t))) learnDirty = true;
    prunePulse(learned.pulse, now);
    for (const e of unsettledCalls(record, now)) {
      if (results.has(e.ticker)) { settleCalls(record, e.ticker, results.get(e.ticker)); recordDirty = true; gateDirty = true; }
      else if (Date.parse(e.closeTime) < now - 6 * 3600000) { e.result = 'unknown'; recordDirty = true; } // voided or never reported
    }
    for (const e of unsettledCalls(certainRecord, now)) {
      if (results.has(e.ticker)) { settleCalls(certainRecord, e.ticker, results.get(e.ticker)); certainDirty = true; }
      else if (Date.parse(e.closeTime) < now - 6 * 3600000) { e.result = 'unknown'; certainDirty = true; }
    }
    if (certainDirty) saveCertain();
    if (recordDirty) saveRecord();
    if (gateDirty || !learned.callGate) { gateDirty = false; learned.callGate = learnGate(record); learnDirty = true; } // relearn the call filter after each settle
    if (settledValue.size > 500) settledValue.delete(settledValue.keys().next().value);
    for (const d of devices.values()) {
      if (!d.tracker) continue;
      for (const w of pendingWindows(d.tracker, now)) if (results.has(w.ticker)) { gradeWindow(d.tracker, w.ticker, results.get(w.ticker)); dirty = true; }
      pruneWindows(d.tracker, now);
    }
    if (results.size > 500) results.delete(results.keys().next().value);
  }

  function start(intervalMs = Number(env.BOT_INTERVAL_MS || 1000)) { // every second
    if (!timer) { timer = setInterval(() => tick(), intervalMs); timer.unref?.(); }
  }
  function stop() { clearInterval(timer); timer = null; clearTimeout(saveTimer); backfillStop = true; }

  const status = () => ({ devices: devices.size, lastTick: market.lastTick || null, lastError: market.lastError, learnedMinutes: learned.vol.minutes, learnedWindows: learned.windows });
  return { load, save, start, stop, tick, sync, unsubscribe, test, report, notifyWhere, status, publicKey: () => vapid.publicKey, devices,
    learned: () => publicLearned(learned), learnStatus, record: officialRecord, saveRecord, index: () => index.read(), backfill, saveLearned, startLearning };
}
