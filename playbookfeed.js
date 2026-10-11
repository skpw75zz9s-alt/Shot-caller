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
import { guideBacktest, guideNow, guideReport, guideShift } from './public/guide.js';
import { fee10, pnl10, quote as quoteOf } from './public/model.js';
import { PRED, fit, predictNow, predictorReport, predictorShift, series, walkForward } from './public/predictor.js';
import { cmFit, cmLive, cmReport, cmWalkForward } from './public/candlemodel.js';

const KEEP = 21 * 86400000;
export function createPlaybook({ coinbase, file, fetchJSON = defaultFetch, clock = () => Date.now(), log = console, sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }) }) {
  let bars = [], report = null, timer = null, busy = false, backfilling = false, oiFn = () => null, flowFn = () => null, lastLive = null, revNow = null, revAt = 0;
  let guideCal = null, guideCache = null, guideLive = [], guideDirty = false; // the shot-caller guide (public/guide.js)
  const liveFile = file.replace(/[^/\\]+$/, 'guide-live.json');
  let predModels = null, predS = null, predSKey = '', predCache = null, predLive = []; // the prediction engine (public/predictor.js)
  let cmW = null, cmRep = null, cmAt = 0, cmCache = null; // the candle model (public/candlemodel.js)
  const predFile = file.replace(/[^/\\]+$/, 'predictor-live.json');
  function merge(rows) {
    const m = new Map(bars.map((b) => [b.t, b]));
    for (const b of rows) if (b.t && b.c > 0) m.set(b.t, b);
    bars = [...m.values()].sort((a, b) => a.t - b.t).filter((b) => b.t >= clock() - KEEP);
  }
  async function load() {
    try { const d = JSON.parse(await readFile(file, 'utf8')); if (Array.isArray(d.bars)) merge(d.bars); } catch { /* none yet */ }
    try { const d = JSON.parse(await readFile(liveFile, 'utf8')); if (Array.isArray(d)) guideLive = d; } catch { /* none yet */ }
    try { const d = JSON.parse(await readFile(predFile, 'utf8')); if (Array.isArray(d)) predLive = d; } catch { /* none yet */ }
  }
  async function saveLive() {
    guideDirty = false;
    try { await mkdir(dirname(liveFile), { recursive: true }); await writeFile(`${liveFile}.tmp`, JSON.stringify(guideLive)); await rename(`${liveFile}.tmp`, liveFile); } catch (e) { log.error('saving the guide log failed', e.message); }
    try { await writeFile(`${predFile}.tmp`, JSON.stringify(predLive)); await rename(`${predFile}.tmp`, predFile); } catch (e) { log.error('saving the predictor log failed', e.message); }
  }
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
  function rerun() { rerunMain(); rerunCandles(); }
  function rerunMain() {
    const run = (variant, target) => { const tr = backtest(bars, { variant, target }); return { ...scorecard(tr), last: tr.slice(-8).reverse() }; };
    // the reversal guide (public/reversal.js): does its checklist predict the next round, and does its flip strategy pay?
    const flip = (o) => { const tr = flipBacktest(bars, o), card = scorecard(tr); return { ...card, needs: Math.max(0, 200 - card.n), last: tr.slice(-8).reverse(),
      withTrend: scorecard(tr.filter((t) => t.withTrend)), againstTrend: scorecard(tr.filter((t) => t.againstTrend)) }; };
    const reversal = { bands: bandStudy(bars), full: flip({ target: 2 }), full15: flip({ target: 1.5 }), noRsi: flip({ target: 2, needRsi: false }) };
    // the shot-caller guide: every past round predicted walk-forward, and the calibration the live forecast uses
    const gbt = guideBacktest(bars); guideCal = gbt.cal; guideCache = null;
    // the prediction engine: walk-forward over the whole history, then the live models fitted on all of it
    const wf = walkForward(bars), predReport = predictorReport(wf.rows);
    predModels = Object.fromEntries(PRED.checkpoints.map((m) => [m, fit(wf.samples.filter((s) => s.m === m))])); predCache = null;
    report = { at: clock(), bars: bars.length, from: bars[0]?.t ?? null, day: run('day', 2), day15: run('day', 1.5), hour: run('hour', 2), hour15: run('hour', 1.5), reversal, guide: guideReport(gbt), predictor: predReport };
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      try { merge(parseCandles(await fetchJSON(`${coinbase}/products/BTC-USD/candles?granularity=60`))); } catch { /* next time */ }
      if (!report || clock() - report.at >= 15 * 60000) { rerunMain(); save(); }
      // the candle model on its own beat (a few minutes after the rest), so no single tick carries all the work
      else if (clock() - cmAt >= 15 * 60000 && clock() - report.at >= 3 * 60000) rerunCandles();
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
  // The guide's forecast right now (UP / DOWN / NO CALL with its calibrated probability and Kalshi's price), every 5 s
  function guide(now = clock()) {
    if (!guideCal) return null;
    if (!guideCache || now - guideCache.at >= 5000) {
      let g = null;
      try { const fl = flowFn(); g = guideNow(bars, guideCal, { now, quote: lastLive?.quote ?? null, flow: fl != null ? (fl + 1) / 2 : null, futures: oiFn() }); } catch { g = null; }
      guideCache = { at: now, g };
    }
    return guideCache.g;
  }
  // The candle model: walk-forward over the whole history (moves per horizon, candle sizes), then fitted on all of it
  function rerunCandles() {
    cmAt = clock();
    try { const wf = cmWalkForward(bars); cmRep = cmReport(wf.rows); cmW = cmFit(wf.samples); cmCache = null; } catch (e) { log.error('candle model failed', e.message); }
  }
  // its live read (only the parts that beat their baselines are switched on), every 5 s
  function candleRead(now = clock()) {
    if (!cmW || !cmRep || !bars.length) return null;
    if (!cmCache || now - cmCache.at >= 5000) {
      const key = `${bars.length}|${bars.at(-1)?.t}`;
      if (key !== predSKey) { predS = series(bars); predSKey = key; }
      let v = null;
      try { v = cmLive(predS, cmW, cmRep, { now, price: lastLive?.spot ?? bars.at(-1).c }); } catch { v = null; }
      cmCache = { at: now, v };
    }
    return cmCache.v;
  }
  // The prediction engine's read of the live round (its factor series are rebuilt when a new candle arrives)
  function predictor(now = clock()) {
    if (!predModels || !lastLive) return null;
    if (!predCache || now - predCache.at >= 5000) {
      const key = `${bars.length}|${bars.at(-1)?.t}`;
      if (key !== predSKey) { predS = series(bars); predSKey = key; }
      const minutesLeft = (lastLive.closeTime - now) / 60000, price = lastLive.spot;
      let p = null;
      try { p = predictNow(predS, predModels, { price, strike: lastLive.strike, minutesLeft, now }); } catch { p = null; }
      if (p) {
        const q = lastLive.quote, less = /^less/.test(lastLive.strikeType || '');
        // Kalshi: UP = YES on a "greater" market (NO on a "less" one); the edge after fee and 1c slippage
        const side = (s) => { const buyYes = (s === 'UP') !== less, ask = buyYes ? q?.yesAsk : q?.noAsk, pr = s === 'UP' ? p.pUp : p.pDown; return ask > 0 && ask < 1 ? { contract: buyYes ? 'YES' : 'NO', ask, p: pr, fee: fee10(ask), edge: pr - ask - fee10(ask) - PRED.slip } : null; };
        p.kalshi = { UP: side('UP'), DOWN: side('DOWN') };
        p.closeTime = lastLive.closeTime; p.strike = lastLive.strike; p.price = price; p.at = now;
        p.invalidation = lastLive.strike; // the settlement reference: the call is losing on the wrong side of it
      }
      predCache = { at: now, p };
    }
    return predCache.p;
  }
  function observe({ snap }, now = clock()) {
    const lv = snap?.live, prevOpen = lastLive?.openTime;
    lastLive = lv ? { ticker: lv.m.ticker, strike: lv.strike, spot: snap.mSpot ?? snap.spot, sigmaMin: lv.sigma ?? snap.sigmaMin, minutesLeft: lv.ev.minutesLeft, strikeType: lv.m.strike_type, openTime: Date.parse(lv.m.open_time), closeTime: Date.parse(lv.m.close_time), quote: quoteOf(lv.m) } : null;
    // the live record: the guide's forecast for each round as it opens, with Kalshi's prices then, graded at the close
    if (lastLive && lastLive.openTime !== prevOpen && now - lastLive.openTime < 90000 && !guideLive.some((e) => e.ticker === lastLive.ticker)) {
      guideCache = null;
      const g = guide(now);
      if (g && g.at === lastLive.openTime && lastLive.strike > 0) {
        guideLive.push({ ticker: lastLive.ticker, open: lastLive.openTime, close: lastLive.closeTime, strike: lastLive.strike, less: /^less/.test(lastLive.strikeType || ''), call: g.call, reason: g.reason, pUp: g.pUp, yesAsk: lastLive.quote.yesAsk, noAsk: lastLive.quote.noAsk, up: null });
        if (guideLive.length > 1000) guideLive.splice(0, guideLive.length - 1000);
        guideDirty = true;
      }
    }
    // the engine's live record: its read at 15, 10, 5 and 2 minutes left, with Kalshi's prices then
    if (lastLive && predModels) {
      const left = (lastLive.closeTime - now) / 60000, m = PRED.checkpoints.find((c) => left <= c && left > c - 0.5);
      if (m && !predLive.some((e) => e.ticker === lastLive.ticker && e.m === m)) {
        predCache = null;
        const p = predictor(now);
        if (p && lastLive.strike > 0) {
          predLive.push({ ticker: lastLive.ticker, m, close: lastLive.closeTime, strike: lastLive.strike, less: /^less/.test(lastLive.strikeType || ''), pUp: p.pUp, base: p.base, yesAsk: lastLive.quote?.yesAsk ?? null, noAsk: lastLive.quote?.noAsk ?? null, up: null });
          if (predLive.length > 4000) predLive.splice(0, predLive.length - 4000);
          guideDirty = true;
        }
      }
    }
    for (const e of predLive) if (e.up == null && now > e.close + 60000) {
      const b = bars.find((x) => x.t === e.close - 60000);
      if (b) { e.up = b.c > e.strike; guideDirty = true; } else if (now > e.close + 6 * 3600000) { e.up = 'unknown'; guideDirty = true; }
    }
    for (const e of guideLive) if (e.up == null && now > e.close + 60000) {
      const b = bars.find((x) => x.t === e.close - 60000); // Coinbase's last minute of the round (Kalshi settles on its own index)
      if (b) { e.up = b.c > e.strike; guideDirty = true; } else if (now > e.close + 6 * 3600000) { e.up = 'unknown'; guideDirty = true; }
    }
    if (guideDirty) saveLive();
  }
  // The live record: calls, accuracy and profit at the Kalshi price there was when each round opened (+ fees, $10 a call)
  // The engine's live record at each confidence threshold: accuracy, and profit at the real ask (+ fee, 1c slippage)
  function predLiveStats() {
    const done = predLive.filter((e) => e.up === true || e.up === false);
    const at = (t) => {
      let n = 0, right = 0, usd = 0, priced = 0;
      for (const e of done) {
        const up = e.pUp >= 0.5, conf = up ? e.pUp : 1 - e.pUp;
        if (conf < t) continue;
        n++; const won = up === e.up; if (won) right++;
        const buyYes = up !== e.less, ask = buyYes ? e.yesAsk : e.noAsk;
        if (ask > 0 && ask < 1) { priced++; usd += pnl10(ask, won, PRED.slip); }
      }
      return { t, n, accuracy: n ? right / n : null, usd, priced };
    };
    return { reads: done.length, thresholds: PRED.thresholds.map(at) };
  }
  function guideLiveStats() {
    const done = guideLive.filter((e) => e.up === true || e.up === false), calls = done.filter((e) => e.call !== 'NO CALL');
    let usd = 0, wins = 0, priced = 0;
    for (const e of calls) {
      const yesWins = e.less ? !e.up : e.up, buyYes = (e.call === 'UP') !== e.less, won = buyYes === yesWins; // YES = above the target (or below it on a "less" market)
      if (won) wins++;
      const ask = buyYes ? e.yesAsk : e.noAsk;
      if (ask > 0 && ask < 1) { priced++; usd += pnl10(ask, won); }
    }
    return { rounds: done.length, calls: calls.length, wins, accuracy: calls.length ? wins / calls.length : null, usd, priced, skipped: done.length - calls.length, last: guideLive.slice(-10).reverse() };
  }
  // For the bot's calls: a proven checklist band nudges the round right after its signal (bot.js shifts)
  function shifts(now = clock()) {
    if (!lastLive || !report?.reversal) return null;
    const v = reversalShift(reversal(now), report.reversal.bands, lastLive) + (report.guide ? guideShift(guide(now), report.guide, lastLive) : 0) + (report.predictor ? predictorShift(predictor(now), report.predictor, lastLive.strikeType) : 0);
    return v ? { [lastLive.ticker]: Math.max(-0.06, Math.min(0.06, v)) } : null;
  }
  return { load, start, tick, backfill, rerun, structure, merge, reversal, guide, observe, shifts, setOi: (f) => { oiFn = f; }, setFlow: (f) => { flowFn = f; },
    api: () => ({ report, backfilling, bars: bars.length, reversal: reversal(), guide: guide(), guideLive: guideLiveStats(), predictor: predictor(), predictorLive: predLiveStats(), candle: { live: candleRead(), report: cmRep }, inCalls: shifts() }), bars: () => bars, predictor };
}
async function defaultFetch(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${url.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
}
