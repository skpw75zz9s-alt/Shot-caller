// Related markets on the server (v13.33, public/cross.js): one reader for every asset's 1-minute closes, shared by
// every market's bot. On start it reads about a week of history (Coinbase for crypto, Yahoo's 5 days for the indexes,
// gold and oil), then the latest candles every 30 seconds; every 30 minutes it refits each market's model and scores
// it walk-forward. Each bot hands it its snapshot (observe) and gets back its nudges once proven (shifts).
import { ASSETS, DRIVERS, seriesOf } from './public/markets.js';
import { CROSS, closeMap, crossShift, dataset, evaluate, features, moveOver, predict, relation, ridgeFit } from './public/cross.js';
import { parseCandles } from './public/engine.js';
import { DRV, attribute, events, fitDrivers, volumeBars } from './public/drivers.js';

export function createCrossFeed({ prices, assets = ASSETS, drivers = DRIVERS, clock = () => Date.now(), log = console, refreshMs = 30000, refitMs = 1800000, keepDays = 7,
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }) } = {}) {
  // v13.34: the drivers the indexes, metals and oil list (the dollar, yields, other metals, Brent, fuels) are read too
  const used = new Set(assets.flatMap((a) => (a.drivers ? [...a.drivers.macro, ...a.drivers.sector] : [])));
  const extra = drivers.filter((d) => used.has(d.key) && !assets.some((a) => a.key === d.key)), all = [...assets, ...extra];
  const maps = Object.fromEntries(all.map((a) => [a.key, new Map()])), vols = Object.fromEntries(assets.map((a) => [a.key, new Map()]));
  const models = {}, snaps = {}, relCache = {}, dmodels = {}, whyCache = {};
  let timer = null, refitAt = 0, busy = false, backfilled = false, polls = 0;
  // every other asset, plus the drivers this one lists
  const others = (k) => { const a = assets.find((x) => x.key === k); return [...assets.map((x) => x.key).filter((x) => x !== k), ...extra.map((d) => d.key).filter((d) => a?.drivers && [...a.drivers.macro, ...a.drivers.sector].includes(d))]; };

  function merge(key, candles) {
    const m = maps[key]; if (!m) return;
    for (const [t, c] of closeMap(candles)) m.set(t, c);
    const v = vols[key];
    if (v) for (const x of candles || []) if (x.c > 0) v.set(Math.floor(x.t / 60000) * 60000, Number(x.v) || 0);
    const cut = clock() - keepDays * 86400000;
    for (const mm of [m, v]) if (mm && mm.size > keepDays * 1440 + 600) for (const t of [...mm.keys()]) if (t < cut) mm.delete(t);
  }
  async function backfill(now = clock()) {
    for (const a of all) {
      const days = a.product ? keepDays : 5, step = 300 * 60000;
      if (a.product) {
        for (let s = now - days * 86400000; s < now; s += step) {
          try { merge(a.key, parseCandles(await prices.candleRows(a, { gran: 60, start: s, end: Math.min(now, s + step) }))); } catch { /* a gap */ }
          await sleep(350);
        }
      } else {
        try { merge(a.key, parseCandles(await prices.candleRows(a, { gran: 60, start: now - days * 86400000, end: now }))); } catch (e) { log.warn?.(`related markets: ${a.key} history`, e.message); }
      }
    }
    backfilled = true;
    refit();
  }
  async function poll() {
    if (busy) return; busy = true;
    try {
      // the markets every time, their drivers every other time (Yahoo's limits)
      for (const a of polls++ % 2 ? assets : all) { try { merge(a.key, parseCandles(await prices.candleRows(a, { gran: 60 }))); } catch { /* next time */ } }
      if (clock() - refitAt >= refitMs) refit();
    } finally { busy = false; }
  }
  function refit(now = clock()) {
    refitAt = now;
    for (const a of assets) {
      try {
        const o = others(a.key), { X, y } = dataset(maps, a.key, o);
        models[a.key] = X.length < 300 ? { n: 0, rows: X.length, proven: false, at: now, model: null, others: o }
          : { ...evaluate(X, y), rows: X.length, model: ridgeFit(X, y), at: now, others: o };
      } catch (e) { log.warn?.(`related markets: ${a.key} model`, e.message); }
      try { if (a.drivers) dmodels[a.key] = fitDrivers(maps, a, now); } catch (e) { log.warn?.(`why it's moving: ${a.key}`, e.message); }
    }
  }
  // Why it's moving (public/drivers.js) over the last w minutes: the move split into its drivers' parts, the chart's
  // series, the volume and scheduled reports
  function why(key, w = 60, now = clock()) {
    const a = assets.find((x) => x.key === key);
    if (!a?.drivers) return { key, supported: false };
    w = DRV.windows.includes(+w) ? +w : 60;
    const ck = `${key}:${w}`;
    if (whyCache[ck] && now - whyCache[ck].at < 10000) return whyCache[ck].v;
    const m = dmodels[key], end = Math.floor(now / 60000) * 60000, r = m?.ready ? attribute(maps, m, a, end - w * 60000, end) : null;
    const v = { key, name: a.name, supported: true, w, digits: a.digits, at: now, backfilled,
      fit: m ? { ready: m.ready, n: m.n, r2Macro: m.r2Macro ?? null, r2All: m.r2All ?? null, need: DRV.minRows } : null,
      drivers: [...a.drivers.macro, ...a.drivers.sector].map((k) => ({ key: k, name: seriesOf(k)?.name ?? k, minutes: maps[k]?.size ?? 0 })),
      own: a.drivers.own, ...(r || {}), vol: r ? volumeBars(vols[key], r.from, r.to) : null, events: r ? events(a, r.from, r.to) : [] };
    whyCache[ck] = { at: now, v };
    return v;
  }
  // this market's expected move over the next 5 minutes from what moves it (a log return), or null
  function expected(key, now = clock()) {
    const m = models[key];
    return m?.model ? predict(m.model, features(maps, key, m.others, Math.floor(now / 60000) * 60000)) : null;
  }
  function observe(key, { snap } = {}, now = clock()) {
    if (!snap) return;
    snaps[key] = { at: now, rows: snap.rows.filter((r) => r.ev?.minutesLeft > 0 && (r.pPre ?? r.ev.pYes) != null).map((r) => ({ ticker: r.m.ticker, pYes: r.pPre ?? r.ev.pYes, sigma: r.sigma ?? snap.sigmaMin, minutesLeft: r.ev.minutesLeft, strikeType: r.m.strike_type || 'greater' })) };
  }
  // proven nudges for this market's open rounds: { ticker: points }
  function shifts(key, now = clock()) {
    const m = models[key], s = snaps[key];
    if (!m?.proven || !s || now - s.at > 20000) return null;
    const mu5 = expected(key, now);
    if (mu5 == null) return null;
    const out = {};
    for (const r of s.rows) { const v = crossShift({ pYes: r.pYes, mu5, sigmaMin: r.sigma, minutesLeft: r.minutesLeft, strikeType: r.strikeType }); if (v) out[r.ticker] = v; }
    return Object.keys(out).length ? out : null;
  }
  function api(key, now = clock()) {
    const a = assets.find((x) => x.key === key);
    if (!a) return null;
    if (!relCache[key] || now - relCache[key].at > 60000) {
      const own5 = moveOver(maps[key], now, 5), own15 = moveOver(maps[key], now, 15);
      const related = others(key).map((k) => {
        const b = seriesOf(k) ?? { name: k }, rel = relation(maps, key, k, now), m5 = moveOver(maps[k], now, 5), m15 = moveOver(maps[k], now, 15);
        const last = maps[k].size ? maps[k].get([...maps[k].keys()].reduce((p, t) => (t > p ? t : p), 0)) : null;
        return { key: k, name: b.name, kind: b.kind ?? 'driver', price: last, m5, m15, rho: rel.rho, beta: rel.beta, n: rel.n,
          catchup: rel.beta != null && m5 != null && own5 != null ? rel.beta * m5 - own5 : null };
      }).sort((x, y) => Math.abs(y.rho ?? 0) - Math.abs(x.rho ?? 0));
      relCache[key] = { at: now, own: { m5: own5, m15: own15 }, related };
    }
    const m = models[key];
    return { key, name: a.name, ...relCache[key], backfilled, minutes: maps[key].size,
      model: m ? { proven: m.proven, n: m.n, rows: m.rows, gain: m.gain, z: m.z, at: m.at, expected5: expected(key, now), need: { minTest: CROSS.minTest, minGain: CROSS.minGain, z: CROSS.z } } : null,
      inCalls: shifts(key, now) };
  }
  return {
    // the last 5 hours of every market first (the card fills in seconds), then the week behind them
    start() { if (timer) return; poll().then(() => { refit(); return backfill(); }).catch((e) => log.warn?.('related markets backfill failed', e.message)); timer = setInterval(() => poll(), refreshMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    merge, refit, poll, backfill, observe, shifts, expected, api, why, maps: () => maps, models: () => models, driverModels: () => dmodels,
  };
}
