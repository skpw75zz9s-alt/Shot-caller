// Kalshi market discovery (v13.30): which of Kalshi's series the bot can call, found live every 10 minutes.
// Kalshi's series list (by category) is read and each series is matched to an asset by its ticker or title
// (public/markets.js classifySeries); the 15-minute seeds are always checked. For each one the open markets are read:
//   active   it has markets open that close within a day: a full bot runs for it (bot.js)
//   later    open, but every market closes further out (yearly highs, monthly ranges): listed, not run (the bot's
//            calls happen in a round's last 15 minutes)
//   closed   nothing open right now
// MARKETS_EXTRA (a Railway variable, "SERIES:ASSET,...") adds series discovery can't see; MARKETS_OFF removes some.
import { ASSETS, SEEDS, classifySeries } from './public/markets.js';

export const DISCOVERY = { every: 600000, categories: ['Crypto', 'Financials', 'Commodities', 'Economics'], horizon: 26 * 3600000, maxSeries: 80 };

export function createDiscovery({ kalshi, fetchJSON, env = process.env, log = console, clock = () => Date.now() }) {
  let list = SEEDS.map((s) => ({ ...s, title: null, open: 0, next: null, state: 'unknown' })), at = 0, running = null;
  const extra = String(env.MARKETS_EXTRA || '').split(',').map((x) => x.trim().split(':')).filter(([s, a]) => /^[A-Z0-9]+$/.test(s || '') && ASSETS.some((x) => x.key === a))
    .map(([series, asset]) => ({ series, asset, freq: /15M$/.test(series) ? '15m' : 'other', title: null }));
  const off = new Set(String(env.MARKETS_OFF || '').split(',').map((x) => x.trim()).filter(Boolean));

  async function scan(now = clock()) {
    const found = new Map(SEEDS.map((s) => [s.series, { ...s, title: null }]));
    for (const e of extra) found.set(e.series, e);
    for (const cat of DISCOVERY.categories) {
      try {
        const d = await fetchJSON(`${kalshi}/series?category=${encodeURIComponent(cat)}`);
        for (const x of d?.series || []) { const c = classifySeries(x); if (c && !found.has(c.series)) found.set(c.series, c); }
      } catch (e) { log.warn?.(`market discovery: ${cat}: ${e.message}`); }
    }
    const rows = [];
    for (const m of [...found.values()].filter((x) => !off.has(x.series)).slice(0, DISCOVERY.maxSeries)) {
      try {
        const d = await fetchJSON(`${kalshi}/markets?series_ticker=${m.series}&status=open&limit=200`);
        const ms = (d?.markets || []).filter((x) => x.floor_strike != null || x.cap_strike != null || /15M$/.test(m.series));
        const closes = ms.map((x) => Date.parse(x.close_time)).filter(Number.isFinite).sort((a, b) => a - b);
        const next = closes.find((t) => t > now) ?? null;
        const strikes = new Set(ms.map((x) => x.event_ticker)).size ? ms.length / new Set(ms.map((x) => x.event_ticker)).size : 0;
        rows.push({ ...m, open: ms.length, next: next ? new Date(next).toISOString() : null, strikes: Math.round(strikes), checked: true,
          state: !ms.length ? 'closed' : next && next - now <= DISCOVERY.horizon ? 'active' : 'later' });
      } catch { rows.push({ ...m, open: 0, next: null, checked: false, state: 'unknown' }); }
    }
    list = rows; at = now;
    return list;
  }
  return {
    refresh(now = clock()) { if (!running && now - at >= DISCOVERY.every) running = scan(now).catch((e) => log.warn?.('market discovery failed', e.message)).finally(() => { running = null; }); return running; },
    list: () => list,
    at: () => at,
    // the series a full bot runs for: active ones, plus the seeds (so a 15-minute market starts the moment Kalshi opens it)
    running: () => list.filter((m) => m.state === 'active' || SEEDS.some((s) => s.series === m.series)).map((m) => m.series),
  };
}
