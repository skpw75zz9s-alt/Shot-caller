// Copy the sharps, on the server (public/sharps.js does the grading). Every 10 seconds it reads Polymarket's public
// data for the current 15-minute BTC Up/Down round (the same windows as Kalshi's): the round's market from the Gamma
// API (slug btc-updown-15m-<window start, unix seconds>), then every trade from the Data API. After a round ends it
// waits for Polymarket's result, grades every wallet that put $20+ in, and checks the sharps' lean recorded at 5
// minutes left. Kept in DATA_DIR/sharps.json. No keys; read-only.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { copyRecord, foldRound, gradeRound, parseTrade, sharpLean, sharpList } from './public/sharps.js';

const GAMMA = 'https://gamma-api.polymarket.com', DATA = 'https://data-api.polymarket.com';
const W = 15 * 60000;
const json = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return null; } };

export function createSmartMoney({ file, fetchJSON = defaultFetch, clock = () => Date.now(), log = console } = {}) {
  let book = {}, copyLog = [], timer = null, busy = false, saveTimer = null, lastError = null, lastOk = 0;
  const rounds = new Map(); // window start -> { start, conditionId, outcomes, pos, seen, done }

  async function load() {
    try { const d = JSON.parse(await readFile(file, 'utf8')); book = d.book || {}; copyLog = d.copyLog || []; } catch { /* first run */ }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      // keep the wallet book bounded: the 5,000 most active, nobody silent for 30 days
      const cut = clock() - 30 * 86400000;
      const keep = Object.entries(book).filter(([, b]) => b.last > cut).sort((a, b) => b[1].rounds - a[1].rounds).slice(0, 5000);
      book = Object.fromEntries(keep);
      try { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify({ book, copyLog })); await rename(`${file}.tmp`, file); } catch (e) { log.error('saving sharps failed', e.message); }
    }, 3000);
    saveTimer.unref?.();
  }
  async function market(start) {
    const r = rounds.get(start) || { start, conditionId: null, outcomes: null, pos: {}, seen: new Set(), done: false };
    rounds.set(start, r);
    if (!r.conditionId) {
      const list = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-15m-${Math.floor(start / 1000)}`);
      const m = Array.isArray(list) ? list[0] : list?.markets?.[0] ?? list;
      if (m?.conditionId) { r.conditionId = m.conditionId; r.outcomes = json(m.outcomes) || ['Up', 'Down']; }
    }
    return r;
  }
  async function readTrades(r) {
    if (!r.conditionId) return;
    const body = await fetchJSON(`${DATA}/trades?market=${r.conditionId}&limit=500`);
    const rows = (Array.isArray(body) ? body : body?.trades || body?.data || []).map(parseTrade).filter((x) => x && !r.seen.has(x.id));
    for (const x of rows) r.seen.add(x.id);
    foldRound(r.pos, rows);
  }
  async function result(r) {
    const list = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-15m-${Math.floor(r.start / 1000)}`);
    const m = Array.isArray(list) ? list[0] : list;
    const prices = json(m?.outcomePrices)?.map(Number), outs = json(m?.outcomes) || r.outcomes || ['Up', 'Down'];
    if (!prices || !m?.closed) return null;
    const i = prices.findIndex((p) => p >= 0.99);
    return i >= 0 ? (/^up$/i.test(outs[i]) ? 'Up' : 'Down') : null;
  }
  async function tick(now = clock()) {
    if (busy) return;
    busy = true;
    try {
      const cur = Math.floor(now / W) * W;
      const r = await market(cur);
      await readTrades(r);
      // the copy signal at 5 minutes left: the sharps' lean, from wallets graded on past rounds only
      if (now >= cur + 10 * 60000 && !copyLog.some((e) => e.window === cur)) {
        const lean = sharpLean(book, r.pos);
        copyLog.unshift({ window: cur, lean: lean.lean, upShare: lean.upShare, n: lean.n, result: null });
        if (copyLog.length > 400) copyLog.length = 400;
        save();
      }
      // earlier rounds: their last trades, then the result, then the grading
      for (const [start, old] of rounds) {
        if (start >= cur) continue;
        if (now < start + W + 60000) { await readTrades(old); continue; }
        const winner = await result(old);
        if (winner) {
          gradeRound(book, old.pos, winner, now);
          for (const e of copyLog) if (e.window === start && !e.result) e.result = winner;
          rounds.delete(start); save();
        } else if (now > start + W + 3 * 3600000) rounds.delete(start); // never resolved: drop it
      }
      lastOk = now; lastError = null;
    } catch (e) { lastError = e.message; } finally { busy = false; }
  }
  function start() { if (!timer) { timer = setInterval(() => tick(), 10000); timer.unref?.(); tick(); } }
  function stop() { clearInterval(timer); timer = null; clearTimeout(saveTimer); }
  function api(now = clock()) {
    const cur = Math.floor(now / W) * W, r = rounds.get(cur);
    const lean = r ? sharpLean(book, r.pos) : null;
    return {
      live: r ? { window: cur, close: cur + W, traders: Object.keys(r.pos).length, ...lean } : null,
      sharps: sharpList(book, 15), wallets: Object.keys(book).length, record: copyRecord(copyLog),
      recent: copyLog.filter((e) => e.result).slice(0, 12),
      status: { ok: !lastError, lastOk, error: lastError },
    };
  }
  return { load, start, stop, tick, api, book: () => book, log: () => copyLog };
}
async function defaultFetch(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${url.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
}
