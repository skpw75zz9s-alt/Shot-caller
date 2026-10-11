// The playbook check on the server (public/playbook.js): keeps the last 21 days of Coinbase 1-minute candles (two
// weeks read on first start, then topped up every minute), reruns the playbook's 15-minute sweep strategy every
// 15 minutes on all of them (the rules never change, so the backtest and the live paper trades are one walk-forward
// test), and serves the scorecard. Also the market-structure read (public/structure.js) for Market watch and the
// micro model. Kept in DATA_DIR/bars.json.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseCandles } from './public/engine.js';
import { backtest, scorecard } from './public/playbook.js';
import { structureRead } from './public/structure.js';
import { bandStudy, flipBacktest, reversalNow, reversalShift } from './public/reversal.js';

const KEEP = 21 * 86400000;
export function createPlaybook({ coinbase, file, fetchJSON = defaultFetch, clock = () => Date.now(), log = console, sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }) }) {
  let bars = [], report = null, timer = null, busy = false, backfilling = false, oiFn = () => null, lastLive = null, revNow = null, revAt = 0;
  function merge(rows) {
    const m = new Map(bars.map((b) => [b.t, b]));
    for (const b of rows) if (b.t && b.c > 0) m.set(b.t, b);
    bars = [...m.values()].sort((a, b) => a.t - b.t).filter((b) => b.t >= clock() - KEEP);
  }
  async function load() { try { const d = JSON.parse(await readFile(file, 'utf8')); if (Array.isArray(d.bars)) merge(d.bars); } catch { /* none yet */ } }
  async function save() {
    try { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify({ bars })); await rename(`${file}.tmp`, file); } catch (e) { log.error('saving bars failed', e.message); }
  }
  // Two weeks of history on first start (Coinbase serves 300 minutes a request; one every 0.4 s), any gap after that
  async function backfill(now = clock(), days = 14) {
    const from = Math.max(bars.at(-1)?.t ?? 0, now - days * 86400000);
    if (now - from < 30 * 60000 || backfilling) return;
    backfilling = true;
    try {
      for (let a = from; a < now; a += 300 * 60000) {
        const b = Math.min(now, a + 300 * 60000);
        try { merge(parseCandles(await fetchJSON(`${coinbase}/products/BTC-USD/candles?granularity=60&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`))); } catch { /* a gap */ }
        await sleep(400);
      }
    } finally { backfilling = false; }
    await save();
  }
  function rerun() {
    const run = (variant, target) => { const tr = backtest(bars, { variant, target }); return { ...scorecard(tr), last: tr.slice(-8).reverse() }; };
    // the reversal guide (public/reversal.js): does its checklist predict the next round, and does its flip strategy pay?
    const flip = (o) => { const tr = flipBacktest(bars, o), card = scorecard(tr); return { ...card, needs: Math.max(0, 200 - card.n), last: tr.slice(-8).reverse(),
      withTrend: scorecard(tr.filter((t) => t.withTrend)), againstTrend: scorecard(tr.filter((t) => t.againstTrend)) }; };
    const reversal = { bands: bandStudy(bars), full: flip({ target: 2 }), full15: flip({ target: 1.5 }), noRsi: flip({ target: 2, needRsi: false }) };
    report = { at: clock(), bars: bars.length, from: bars[0]?.t ?? null, day: run('day', 2), day15: run('day', 1.5), hour: run('hour', 2), hour15: run('hour', 1.5), reversal };
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      try { merge(parseCandles(await fetchJSON(`${coinbase}/products/BTC-USD/candles?granularity=60`))); } catch { /* next time */ }
      if (!report || clock() - report.at >= 15 * 60000) { rerun(); save(); }
    } finally { busy = false; }
  }
  function start() {
    backfill().then(() => { rerun(); }).catch((e) => log.warn?.('playbook backfill stopped', e.message));
    tick(); timer = setInterval(tick, 60000); timer.unref?.(); // fresh candles every minute (a sweep is a 5-minute thing)
  }
  // The structure read right now (with the live price): sweeps, shifts, gaps, blocks, divergence, VWAP
  // (the last two days are all it needs; worked out at most once a second, however many parts of the server ask)
  let cache = null;
  function structure(price, sigmaMin, now = clock()) {
    if (cache && now - cache.at < 1000 && cache.price === price) return cache.read;
    cache = { at: now, price, read: structureRead(bars.slice(-3000), { now, price, sigmaMin }) };
    return cache.read;
  }
  // The reversal checklist right now (with the futures' open interest when there is one), at most every 5 seconds
  function reversal(now = clock()) {
    if (!revNow || now - revAt >= 5000) { revAt = now; try { revNow = reversalNow(bars, { now, oi: oiFn() }); } catch { revNow = null; } }
    return revNow;
  }
  function observe({ snap }) {
    const lv = snap?.live;
    lastLive = lv ? { ticker: lv.m.ticker, strike: lv.strike, spot: snap.mSpot ?? snap.spot, sigmaMin: lv.sigma ?? snap.sigmaMin, minutesLeft: lv.ev.minutesLeft, strikeType: lv.m.strike_type, openTime: Date.parse(lv.m.open_time) } : null;
  }
  // For the bot's calls: a proven checklist band nudges the round right after its signal (bot.js shifts)
  function shifts(now = clock()) {
    if (!lastLive || !report?.reversal) return null;
    const v = reversalShift(reversal(now), report.reversal.bands, lastLive);
    return v ? { [lastLive.ticker]: v } : null;
  }
  return { load, start, tick, backfill, rerun, structure, merge, reversal, observe, shifts, setOi: (f) => { oiFn = f; },
    api: () => ({ report, backfilling, bars: bars.length, reversal: reversal(), inCalls: shifts() }), bars: () => bars };
}
async function defaultFetch(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${url.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
}
