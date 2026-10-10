// The Round scan on the server, around the clock: it streams the five exchanges' trades itself (the same public
// feeds the phone uses), scans every round, takes a sample at 10, 6 and 3 minutes left, grades each one once Kalshi
// settles the round and learns the scan's weights from them (public/roundscan.js). The phone shows this when its
// own feeds aren't live, and the record and weights always come from here, so the scan is graded every round
// whether or not anyone has the app open.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXCHANGES, parseCoinbase } from './public/feeds.js';
import { quote } from './public/model.js';
import { CHECKPOINTS, featureVector, fitModels, scanChance, scanRound, scanStats } from './public/roundscan.js';

const COINBASE = { name: 'Coinbase', url: 'wss://ws-feed.exchange.coinbase.com', subscribe: [{ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['matches'] }], parse: parseCoinbase };
const MAX_TRADES = 200000;
const MAX_SAMPLES = 6000;

export function createScanFeed({ file, log = console, WS = globalThis.WebSocket, clock = () => Date.now() } = {}) {
  let data = { samples: [], models: {} };
  let trades = [], roundOpen = null, last = null, lastScanAt = 0, saveTimer = null;
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
    for (const x of list) {
      if (!x) continue;
      (status[x.ex] ||= { state: 'live' }).lastAt = now;
      if (roundOpen == null || x.t >= roundOpen) trades.push(x);
    }
    if (trades.length > MAX_TRADES) trades.splice(0, trades.length - MAX_TRADES);
  }
  function open(ex) {
    if (stopped || socks[ex.name] || typeof WS !== 'function') return;
    let ws;
    try { ws = new WS(ex.url); } catch { status[ex.name] = { state: 'error' }; return; }
    socks[ex.name] = ws;
    status[ex.name] = { ...status[ex.name], state: 'connecting' };
    ws.onopen = () => { retry[ex.name] = 0; status[ex.name] = { ...status[ex.name], state: 'live' }; for (const s of ex.subscribe) ws.send(JSON.stringify(s)); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const got = ex.parse(m).filter(Boolean);
      if (got.length) add(got);
    };
    ws.onclose = () => {
      delete socks[ex.name];
      status[ex.name] = { ...status[ex.name], state: 'down' };
      if (!stopped) { const t = setTimeout(() => open(ex), Math.min(60000, 1000 * 2 ** (retry[ex.name] = (retry[ex.name] || 0) + 1))); t.unref?.(); }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }
  function start() { stopped = false; [COINBASE, ...EXCHANGES].forEach(open); }
  function stop() { stopped = true; clearTimeout(saveTimer); for (const [n, ws] of Object.entries(socks)) { ws.onclose = null; try { ws.close(); } catch { /* */ } delete socks[n]; } }
  // The latest BTC price from the trade feeds: the median of each exchange's last trade in the past 10 seconds (null
  // with fewer than 2 exchanges streaming). The bot moves its price with this every second (bot.js liveSpot).
  function spot(now = clock()) {
    const last = {};
    for (let i = trades.length - 1; i >= 0 && Object.keys(last).length < 5; i--) { const x = trades[i]; if (x.t < now - 10000) break; if (!(x.ex in last)) last[x.ex] = x.price; }
    const ps = Object.values(last).sort((a, b) => a - b);
    return ps.length >= 2 ? (ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2) : null;
  }
  const liveFeeds = (now) => Object.values(status).filter((s) => s.lastAt > now - 60000).length;

  // Every bot tick (bot.js onObserve): scan the live round, take checkpoint samples, grade settled ones
  function observe({ snap, known }, now = clock()) {
    let graded = false;
    for (const s of data.samples) if (s.y == null && known?.has(s.ticker)) { const r = known.get(s.ticker); s.y = r === 'yes' ? 1 : r === 'no' ? 0 : -1; graded = true; }
    if (graded) { data.samples = data.samples.filter((s) => s.y !== -1 && !(s.y == null && s.closeTime < now - 6 * 3600000)); data.models = fitModels(data.samples); save(); }
    const live = snap?.live;
    if (!live) return;
    const openT = Date.parse(live.m.open_time);
    if (openT !== roundOpen) { roundOpen = openT; trades = trades.filter((x) => x.t >= openT); }
    if (now - lastScanAt < 4000 && last?.ticker === live.m.ticker) return;
    lastScanAt = now;
    const sc = scanRound(trades, { openTime: openT, now, sigmaMin: snap.sigmaMin });
    const q = quote(live.m), kalshi = q.yesBid != null && q.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null;
    const mLeft = live.ev.minutesLeft, pModel = live.ev.pYes;
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
  function api() {
    const now = clock();
    const rounds = [];
    for (const s of [...data.samples].reverse()) {
      if (s.cp !== 6 || s.y == null) continue;
      rounds.push({ ticker: s.ticker, lean: s.lean, score: s.score, y: s.y, pModel: s.pModel, pScan: s.pScan });
      if (rounds.length >= 12) break;
    }
    return { live: last && now - last.at < 60000 ? last : null, models: data.models, record: scanStats(data.samples), rounds,
      feeds: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v.lastAt > now - 60000 ? 'live' : v.state || 'off'])) };
  }
  return { load, start, stop, observe, add, api, spot, data: () => data };
}
const round3 = (v) => Math.round(v * 1000) / 1000;
// The scan without what the phone doesn't need
function slim(sc) {
  if (!sc.ready) return { ready: false, trades: sc.trades };
  const { rows, ...rest } = sc;
  return { ...rest, rows: rows.map(({ ex, n, usd, net, buyShare, change, whales, premium }) => ({ ex, n, usd, net, buyShare, change, whales, premium })) };
}
