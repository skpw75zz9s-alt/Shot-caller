// The Round scan on the server, around the clock: it streams the five USD exchanges' and the global markets' trades itself (the same public
// feeds the phone uses), scans every round, takes a sample at 10, 6 and 3 minutes left, grades each one once Kalshi
// settles the round and learns the scan's weights from them (public/roundscan.js). The phone shows this when its
// own feeds aren't live, and the record and weights always come from here, so the scan is graded every round
// whether or not anyone has the app open.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXCHANGES, GLOBAL_EXCHANGES, createAligner, parseCoinbase } from './public/feeds.js';
import { quote } from './public/model.js';
import { CHECKPOINTS, checkpointFor, featureVector, fitModels, scanChance, scanRound, scanStats } from './public/roundscan.js';
import { LIQ_FEEDS } from './public/liquidations.js';

const COINBASE = { name: 'Coinbase', url: 'wss://ws-feed.exchange.coinbase.com', subscribe: [{ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['matches'] }], parse: parseCoinbase };
const MAX_TRADES = 200000, MAX_GLOBAL = 150000;
const MAX_SAMPLES = 6000;

// futures: futures.js (Hyperliquid's BTC perpetual), its reads become extra scan inputs
// onTrade: each USD exchange trade as it arrives (the Discord whale alerts: discordalerts.js); onLiq: each futures
// liquidation (public/liquidations.js: the scan's 'liq' input and the Discord cascade alert)
export function createScanFeed({ file, log = console, WS = globalThis.WebSocket, clock = () => Date.now(), futures = null, onTrade = null, onLiq = null } = {}) {
  let data = { samples: [], models: {} };
  // trades: the five USD exchanges (the bot's price, Market watch, the micro model); gtrades: the global markets (v13.10),
  // kept apart and level-aligned to USD spot, read only by the scan's global inputs (Binance and Bybit block US servers:
  // whatever connects is used)
  let liqs = []; // futures liquidations, the last 30 minutes
  let trades = [], gtrades = [], roundOpen = null, last = null, lastScanAt = 0, saveTimer = null;
  const align = createAligner(), globalNames = new Set(GLOBAL_EXCHANGES.map((e) => e.name));
  const socks = {}, status = {}, retry = {};
  let stopped = true;

  async function load() {
    try { const d = JSON.parse(await readFile(file, 'utf8')); data = { samples: d.samples || [], models: d.models || {} }; } catch { /* first run */ }
    if (!Object.keys(data.models).length) data.models = fitModels(data.samples);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(data));
        await rename(`${file}.tmp`, file);
      } catch (e) { log.error('saving the round scan failed', e.message); }
    }, 2000);
    saveTimer.unref?.();
  }

  function add(list) {
    const now = clock();
    for (const x of align(list)) {
      if (!x) continue;
      (status[x.ex] ||= { state: 'live' }).lastAt = now;
      if (roundOpen == null || x.t >= roundOpen) (globalNames.has(x.ex) ? gtrades : trades).push(x);
      if (onTrade && !globalNames.has(x.ex)) try { onTrade(x, now); } catch { /* an alert never breaks the feed */ }
    }
    if (trades.length > MAX_TRADES) trades.splice(0, trades.length - MAX_TRADES);
    if (gtrades.length > MAX_GLOBAL) gtrades.splice(0, gtrades.length - MAX_GLOBAL);
  }
  function addLiq(list) {
    const now = clock();
    for (const x of list) { liqs.push(x); if (onLiq) try { onLiq(x, now); } catch { /* an alert never breaks the feed */ } }
    while (liqs.length && liqs[0].t < now - 30 * 60000) liqs.shift();
    if (liqs.length > 5000) liqs.splice(0, liqs.length - 5000);
  }
  function open(ex) {
    if (stopped || socks[ex.name] || typeof WS !== 'function') return;
    let ws;
    try { ws = new WS(ex.url); } catch { status[ex.name] = { state: 'error' }; return; }
    socks[ex.name] = ws;
    status[ex.name] = { ...status[ex.name], state: 'connecting' };
    const send = (x) => { try { ws.send(typeof x === 'string' ? x : JSON.stringify(x)); } catch { /* closing */ } };
    let pinger = null;
    ws.onopen = () => {
      retry[ex.name] = 0; status[ex.name] = { ...status[ex.name], state: 'live' };
      const sub = () => { for (const s of ex.subscribe) send(s); };
      if (ex.delay) setTimeout(sub, ex.delay).unref?.(); else sub();
      if (ex.ping) { pinger = setInterval(() => send(ex.ping[1]), ex.ping[0]); pinger.unref?.(); } // keep-alives (Bybit, OKX)
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const r = ex.reply?.(m);
      if (r) send(r); // heartbeat answers (Crypto.com)
      const got = ex.parse(m).filter(Boolean);
      if (got.length) (ex.onData || add)(got);
    };
    ws.onclose = () => {
      clearInterval(pinger);
      delete socks[ex.name];
      status[ex.name] = { ...status[ex.name], state: 'down' };
      if (!stopped) { const t = setTimeout(() => open(ex), Math.min(60000, 1000 * 2 ** (retry[ex.name] = (retry[ex.name] || 0) + 1))); t.unref?.(); }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }
  function start() { stopped = false; [COINBASE, ...EXCHANGES, ...GLOBAL_EXCHANGES, ...LIQ_FEEDS.map((f) => ({ ...f, name: `${f.name} liquidations`, onData: addLiq }))].forEach(open); }
  function stop() { stopped = true; clearTimeout(saveTimer); for (const [n, ws] of Object.entries(socks)) { ws.onclose = null; try { ws.close(); } catch { /* */ } delete socks[n]; } }
  // The latest BTC price from the trade feeds: the median of each exchange's last trade in the past 10 seconds (null
  // with fewer than 2 exchanges streaming). The bot moves its price with this every second (bot.js liveSpot).
  function spot(now = clock()) {
    const last = {};
    for (let i = trades.length - 1; i >= 0 && Object.keys(last).length < 5; i--) { const x = trades[i]; if (x.t < now - 10000) break; if (!(x.ex in last)) last[x.ex] = x.price; }
    const ps = Object.values(last).sort((a, b) => a - b);
    return ps.length >= 2 ? (ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2) : null;
  }
  // For Market watch (marketwatch.js): each exchange's latest trade price (last 10 s), when each feed last delivered,
  // and the dollars traded since a time
  function venues(now = clock()) {
    const out = {};
    for (let i = trades.length - 1; i >= 0; i--) { const x = trades[i]; if (x.t < now - 10000) break; if (!(x.ex in out)) out[x.ex] = x.price; }
    return out;
  }
  // the spot price at time t: the median of each exchange's last trade at or before t (within 30 s)
  function spotAt(t) {
    const last = {};
    for (let i = trades.length - 1; i >= 0; i--) { const x = trades[i]; if (x.t > t) continue; if (x.t < t - 30000) break; if (!(x.ex in last)) last[x.ex] = x.price; }
    const ps = Object.values(last).sort((a, b) => a - b);
    return ps.length ? (ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2) : null;
  }
  const usdNames = new Set([COINBASE.name, ...EXCHANGES.map((e) => e.name)]); // what counts as a live feed (a global market being down or blocked is normal)
  const feedTimes = () => Object.fromEntries(Object.entries(status).filter(([k, v]) => v.lastAt && usdNames.has(k)).map(([k, v]) => [k, v.lastAt]));
  // takers' buy share of the dollars since t, as -1 (all selling) .. +1 (all buying); null with no trades
  function imbalance(since) { let b = 0, all = 0; for (let i = trades.length - 1; i >= 0 && trades[i].t > since; i--) { const u = trades[i].price * trades[i].size; all += u; if (trades[i].side === 'buy') b += u; } return all > 0 ? (b / all - 0.5) * 2 : null; }
  function flowSince(t) { let usd = 0; for (let i = trades.length - 1; i >= 0 && trades[i].t > t; i--) usd += trades[i].price * trades[i].size; return usd; }
  // a liquidation feed is live if it connected (liquidations come in bursts: quiet minutes are normal)
  const liveLiq = (now) => LIQ_FEEDS.some((f) => status[`${f.name} liquidations`]?.state === 'live') || liqs.some((x) => x.t > now - 30 * 60000);
  const liveFeeds = (now) => Object.entries(status).filter(([k, s]) => usdNames.has(k) && s.lastAt > now - 60000).length;

  // Every bot tick (bot.js onObserve): scan the live round, take checkpoint samples, grade settled ones
  function observe({ snap, known }, now = clock()) {
    let graded = false;
    for (const s of data.samples) if (s.y == null && known?.has(s.ticker)) { const r = known.get(s.ticker); s.y = r === 'yes' ? 1 : r === 'no' ? 0 : -1; graded = true; }
    if (graded) { data.samples = data.samples.filter((s) => s.y !== -1 && !(s.y == null && s.closeTime < now - 6 * 3600000)); data.models = fitModels(data.samples); save(); }
    const live = snap?.live;
    if (!live) return;
    const openT = Date.parse(live.m.open_time);
    if (openT !== roundOpen) { roundOpen = openT; trades = trades.filter((x) => x.t >= openT); gtrades = gtrades.filter((x) => x.t >= openT); }
    if (now - lastScanAt < 4000 && last?.ticker === live.m.ticker) return;
    lastScanAt = now;
    const f = futures?.features({ now, spotAt, sigmaMin: snap.sigmaMin || undefined });
    const extra = f?.live ? { fLead: f.lead, fFlow: f.flow, fOi: f.oi, fPremium: f.premium, live: true, funding: f.funding, oiChange: f.oiChange } : null;
    const sc = scanRound(gtrades.length ? trades.concat(gtrades) : trades, { openTime: openT, now, sigmaMin: snap.sigmaMin, extra, liqs: liveLiq(now) ? liqs : null });
    const q = quote(live.m), kalshi = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null;
    const mLeft = live.ev.minutesLeft, pModel = live.pPre ?? live.ev.pYes; // the odds before the scan's own nudge
    const x = sc.ready ? featureVector(sc, live.m.strike_type) : null;
    const chance = scanChance(pModel, x, data.models, mLeft);
    last = { ticker: live.m.ticker, at: now, minutesLeft: mLeft, sc: slim(sc), chance, kalshi, feeds: liveFeeds(now) };
    // a sample at each checkpoint, only with at least 3 exchanges streaming (an outage would teach it nonsense)
    const cp = CHECKPOINTS.find((c) => mLeft <= c && mLeft > c - 1.5);
    if (cp && sc.ready && pModel != null && liveFeeds(now) >= 3 && !data.samples.some((s) => s.ticker === live.m.ticker && s.cp === cp)) {
      data.samples.push({ ticker: live.m.ticker, closeTime: Date.parse(live.m.close_time), cp, at: now, x: x.map((v) => Math.round(v * 1000) / 1000),
        pModel: round3(pModel), pScan: round3(chance.p), active: chance.active, kalshi: kalshi == null ? null : round3(kalshi), score: sc.score, lean: sc.lean, y: null });
      if (data.samples.length > MAX_SAMPLES) data.samples.splice(0, data.samples.length - MAX_SAMPLES);
      save();
    }
  }

  // What the phone gets: the live scan, the scan chance, the learned weights and the graded record
  // Is the scan proven at this point of the round? (graded out of sample: 100+ samples where it was used, and it made
  // the bot's odds measurably more accurate). Then its nudge goes into the bot's odds for calls (bot.js shifts).
  function proven(mLeft) {
    const r = scanStats(data.samples)[checkpointFor(mLeft)];
    return !!r && r.activeN >= 100 && r.skill != null && r.skill > 0.01;
  }
  function shifts(now = clock()) {
    if (!last || now - last.at > 20000 || !last.chance?.active || !proven(last.minutesLeft)) return null;
    return { [last.ticker]: Math.max(-0.08, Math.min(0.08, last.chance.p - last.chance.pModel)) }; // capped at ±8 pts
  }
  function api() {
    const now = clock();
    const rounds = [];
    for (const s of [...data.samples].reverse()) {
      if (s.cp !== 6 || s.y == null) continue;
      rounds.push({ ticker: s.ticker, lean: s.lean, score: s.score, y: s.y, pModel: s.pModel, pScan: s.pScan });
      if (rounds.length >= 12) break;
    }
    return { live: last && now - last.at < 60000 ? last : null, inCalls: shifts(now), models: data.models, record: scanStats(data.samples), rounds,
      feeds: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v.lastAt > now - 60000 ? 'live' : v.state || 'off'])) };
  }
  return { load, start, stop, observe, add, api, spot, shifts, proven, venues, feedTimes, flowSince, spotAt, imbalance, lastScan: () => last, data: () => data };
}
const round3 = (v) => Math.round(v * 1000) / 1000;
// The scan without what the phone doesn't need
function slim(sc) {
  if (!sc.ready) return { ready: false, trades: sc.trades };
  const { rows, ...rest } = sc;
  return { ...rest, rows: rows.map(({ ex, n, usd, net, buyShare, change, whales, premium }) => ({ ex, n, usd, net, buyShare, change, whales, premium })) };
}
