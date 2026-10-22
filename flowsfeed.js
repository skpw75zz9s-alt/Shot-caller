// Money flows on the server (v13.53; public/flows.js parses and tests them): Farside's spot-ETF flows, DefiLlama's
// stablecoin supply and, with WHALE_ALERT_API_KEY, Whale Alert's large on-chain transfers, for one crypto asset. Each is
// a probation factor until it proves itself on data it never trained on; a proven one nudges the live round's odds a
// little (flowShift). Every source says whether it's working and, if not, why (api().<source>.err), since any of them can
// block or change its page.
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FLOWS, dailyCloses, dailyTest, flowShift, parseFarside, parseStables, stablesChange, whaleNet, whaleTest } from './public/flows.js';
import { writeAtomic } from './atomicfile.js';

const HOUR = 3600000;
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; ShotCaller; daily flow reader)', accept: 'text/html,application/json' };
// the stablecoin supply is market-wide: fetched once for every asset
const shared = { stables: null, at: 0, err: null, inflight: null };

export function createFlowsFeed({ asset, file, prices, playbook = null, fetchImpl = (...a) => fetch(...a), env = process.env, clock = () => Date.now(), log = console }) {
  const slug = FLOWS.farside[asset.key] || null, key = (env.WHALE_ALERT_API_KEY || '').trim();
  const s = { etf: { rows: [], at: 0, err: null }, closes: { map: {}, at: 0, err: null }, whale: { txs: [], log: [], at: 0, err: null, sampledAt: 0 } };
  let tests = { etf: null, stables: null, whale: null }, lastLive = null, busy = false, dirty = false;

  async function get(url, type = 'json') {
    const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout?.(15000) });
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return type === 'json' ? r.json() : r.text();
  }
  async function etf(now) {
    if (!slug || now - s.etf.at < 3 * HOUR) return;
    s.etf.at = now;
    try { const rows = parseFarside(await get(`https://farside.co.uk/${slug}/`, 'text')); if (!rows.length) throw new Error('no daily rows found on the page (its layout may have changed)'); s.etf.rows = rows.slice(-900); s.etf.err = null; }
    catch (e) { s.etf.err = String(e?.message || e); }
  }
  async function stables(now) {
    if (now - shared.at < 6 * HOUR) return;
    if (shared.inflight) return shared.inflight;
    shared.inflight = (async () => {
      shared.at = now;
      try { const rows = parseStables(await get('https://stablecoins.llama.fi/stablecoincharts/all')); if (rows.length < 30) throw new Error('too little history came back'); shared.stables = rows.slice(-900); shared.err = null; }
      catch (e) { shared.err = String(e?.message || e); }
    })().finally(() => { shared.inflight = null; });
    return shared.inflight;
  }
  async function closes(now) {
    if (now - s.closes.at < 6 * HOUR) return;
    s.closes.at = now;
    try { // two 300-day windows: enough days for the walk-forward test
      const day = 86400000, end = Math.floor(now / day) * day, map = {};
      for (const [a, b] of [[end - 300 * day, end], [end - 600 * day, end - 300 * day]]) Object.assign(map, dailyCloses(await prices.candleRows(asset, { gran: 86400, start: a, end: b })));
      if (Object.keys(map).length < 60) throw new Error('too few daily candles came back');
      s.closes.map = map; s.closes.err = null;
    } catch (e) { s.closes.err = String(e?.message || e); }
  }
  // the price n minutes after a time, from the 1-minute candles the bot keeps
  const priceAt = (t) => { const bars = playbook?.bars?.() || []; for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t <= t) return bars[i].t > t - 120000 ? bars[i].c : null; return null; };
  async function whales(now) {
    if (!key || now - s.whale.at < 60000) return;
    s.whale.at = now;
    try {
      const since = Math.floor(Math.max(now - HOUR, (s.whale.txs.at(-1)?.timestamp ?? 0) * 1000 + 1000) / 1000);
      const j = await get(`https://api.whale-alert.io/v1/transactions?api_key=${encodeURIComponent(key)}&min_value=${FLOWS.whaleMin}&start=${since}&currency=${asset.key.toLowerCase()}&limit=100`);
      if (j?.result !== 'success') throw new Error(j?.message || 'Whale Alert refused the request (check WHALE_ALERT_API_KEY and its plan)');
      const seen = new Set(s.whale.txs.map((t) => t.hash + t.to?.address));
      for (const t of j.transactions || []) if (!seen.has(t.hash + t.to?.address)) s.whale.txs.push({ hash: t.hash, symbol: t.symbol, timestamp: t.timestamp, amount_usd: t.amount_usd, amount: t.amount, from: { owner_type: t.from?.owner_type, owner: t.from?.owner }, to: { owner_type: t.to?.owner_type, owner: t.to?.owner, address: t.to?.address } });
      s.whale.txs = s.whale.txs.filter((t) => t.timestamp * 1000 > now - 2 * HOUR);
      s.whale.err = null;
      // one sample an hour (a reading overlaps the next 60 minutes' readings, so more often would count the same flow twice)
      if (now - s.whale.sampledAt >= HOUR) { s.whale.sampledAt = now; s.whale.log.push({ at: now, value: whaleNet(s.whale.txs, asset.key, now - HOUR).net, y: null }); dirty = true; }
    } catch (e) { s.whale.err = String(e?.message || e).replace(key, '…'); }
    // grade the hours whose next 15 minutes are in the candles
    for (const x of s.whale.log) if (x.y == null && now - x.at > 17 * 60000) { const a = priceAt(x.at), b = priceAt(x.at + 15 * 60000); if (a && b && a !== b) { x.y = b > a ? 1 : -1; dirty = true; } else if (now - x.at > 6 * HOUR) { x.y = 0; dirty = true; } }
    if (s.whale.log.length > 5000) s.whale.log.splice(0, s.whale.log.length - 5000);
  }
  function retest() {
    const c = s.closes.map;
    tests = {
      etf: slug && s.etf.rows.length ? dailyTest(s.etf.rows.map((r) => ({ date: r.date, value: r.total })), c) : null,
      stables: shared.stables ? dailyTest(stablesChange(shared.stables), c) : null,
      whale: key ? { ...whaleTest(s.whale.log), avgMove: avg15() } : null,
    };
  }
  function avg15() { const b = playbook?.bars?.() || [], m = []; for (let i = 15; i < b.length; i += 15) if (b[i].c > 0 && b[i - 15].c > 0) m.push(Math.abs(Math.log(b[i].c / b[i - 15].c))); return m.length ? m.reduce((a, x) => a + x, 0) / m.length : null; }

  async function refresh(now = clock()) {
    if (busy) return;
    busy = true;
    try { await Promise.all([etf(now), stables(now), closes(now), whales(now)]); retest(); if (dirty) { dirty = false; await save(); } }
    catch (e) { log.error?.(`${asset.key} flows failed`, e.message); }
    finally { busy = false; }
  }
  function observe({ snap }, now = clock()) {
    const lv = snap?.live;
    lastLive = lv ? { ticker: lv.m.ticker, strike: lv.strike, spot: snap.mSpot ?? snap.spot, sigmaMin: lv.sigma ?? snap.sigmaMin, minutesLeft: lv.ev.minutesLeft } : null;
    refresh(now);
  }
  // what each factor says right now: +1 up, -1 down (after its tested direction), or 0; a daily reading counts for 3 days
  function reads(now = clock()) {
    const fresh = (d) => d && now - Date.parse(`${d}T00:00:00Z`) < 3 * 86400000;
    const etfLast = s.etf.rows.at(-1), stLast = shared.stables ? stablesChange(shared.stables).at(-1) : null;
    const net = key ? whaleNet(s.whale.txs, asset.key, now - HOUR) : null;
    const lean = (v, t) => (v == null || !t ? 0 : Math.sign(v) * t.dir);
    return {
      etf: etfLast && fresh(etfLast.date) ? { date: etfLast.date, value: etfLast.total, lean: lean(etfLast.total, tests.etf) } : null,
      stables: stLast && fresh(stLast.date) ? { date: stLast.date, value: stLast.value, lean: lean(stLast.value, tests.stables) } : null,
      whale: net ? { value: net.net, n: net.n, lean: net.n ? lean(net.net, tests.whale) : 0 } : null,
    };
  }
  function shifts(now = clock()) {
    if (!lastLive) return null;
    const r = reads(now);
    let total = 0;
    for (const [k, horizonMin] of [['etf', 1440], ['stables', 1440], ['whale', 15]]) {
      const t = tests[k], x = r[k];
      if (!t?.proven || !x?.lean) continue;
      total += flowShift({ lean: x.lean, hit: t.test.hit, horizonMin, avgMove: t.avgMove, ...lastLive }) || 0;
    }
    return total ? { [lastLive.ticker]: Math.max(-0.03, Math.min(0.03, total)) } : null;
  }
  async function load() { try { const j = JSON.parse(await readFile(file, 'utf8')); if (Array.isArray(j?.whale)) s.whale.log = j.whale; } catch { /* none yet */ } }
  async function save() { try { await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify({ whale: s.whale.log })); } catch (e) { log.error?.('saving flows failed', e.message); } }
  function api(now = clock()) {
    const r = reads(now), slim = (t) => (t ? { n: t.n, dir: t.dir, test: t.test, train: t.train, proven: t.proven, need: t.need, zNeed: t.zNeed, unit: t.unit } : null);
    return {
      etf: { on: !!slug, read: r.etf, test: slim(tests.etf), days: s.etf.rows.length, recent: s.etf.rows.slice(-10).reverse(), err: s.etf.err },
      stables: { on: true, read: r.stables, test: slim(tests.stables), recent: shared.stables ? stablesChange(shared.stables).slice(-8).reverse() : [], err: shared.err },
      whale: { on: !!key, read: r.whale, test: slim(tests.whale), samples: s.whale.log.length, err: key ? s.whale.err : 'set WHALE_ALERT_API_KEY to turn it on',
        recent: s.whale.txs.filter((t) => String(t.symbol).toLowerCase() === asset.key.toLowerCase()).slice(-15).reverse().map((t) => ({ t: t.timestamp * 1000, usd: t.amount_usd, amount: t.amount, from: t.from?.owner || t.from?.owner_type || 'unknown', to: t.to?.owner || t.to?.owner_type || 'unknown', fromType: t.from?.owner_type, toType: t.to?.owner_type })) },
      prices: { days: Object.keys(s.closes.map).length, err: s.closes.err },
      inCalls: shifts(now),
    };
  }
  return { load, observe, refresh, shifts, api };
}
// for tests: forget the market-wide stablecoin cache
export const resetFlowsCache = () => { shared.stables = null; shared.at = 0; shared.err = null; shared.inflight = null; };
