// Market watch: the bot's sharp eye. Every second it checks every detail it can see and logs anything unusual:
//   jump        BTC moved far more in 5 seconds than it normally does (3x = notable, 5x = severe)
//   burst       a volume burst on the exchanges (5x the usual 10 seconds)
//   breakaway   one exchange's price split from the others for 5+ seconds (a local squeeze, or a broken feed)
//   silent      an exchange's feed went quiet while the others trade; or the price itself stopped (severe)
//   spread      Kalshi's spread on the live round blew out (severe: the price can't be trusted to trade at)
//   pulled      the contracts resting near Kalshi's price suddenly vanished (makers stepping back before news)
//   wall        a single huge order resting on Kalshi's book
//   flurry      a burst of Kalshi trades on the live round (and which way they lean)
//   reprice     Kalshi's price jumped while BTC barely moved (someone may know something)
//   flush       futures open interest fell sharply while the price moved: positions forced out (liquidations)
//   funding     futures funding is extreme (one side crowded, squeeze risk)
//   premium     futures trading well above or below spot
// Severe events hold NEW calls for a short while (bad data or an untradeable book); everything else is logged, shown
// on the Deck, and counted into each call's record so the call filter can learn whether it matters.
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const fmt$ = (v) => `$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const k$ = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
export const WATCH = { dedupeMs: 30000, keep: 200 };

export function createDetector({ clock = () => Date.now() } = {}) {
  const prices = [], flows = [], spreads = [], depths = [], mids = [], kTrades = [];
  const events = [], last = {}, breakSince = {};
  let hold = null, round = null;
  const push = (arr, x, ms) => { arr.push(x); while (arr.length && arr[0].t < x.t - ms) arr.shift(); };
  const at = (arr, t) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t <= t) return arr[i]; return null; };
  function emit(now, kind, sev, text, key = kind, holdSec = 0) {
    if (last[key] && now - last[key] < WATCH.dedupeMs) return null;
    last[key] = now;
    const e = { t: now, kind, sev, text };
    events.unshift(e); if (events.length > WATCH.keep) events.length = WATCH.keep;
    if (holdSec > 0 && (!hold || hold.until < now + holdSec * 1000)) hold = { until: now + holdSec * 1000, why: text, kind };
    return e;
  }

  // One second of everything (any field may be missing):
  //   price, sigmaMin            BTC now (index or feeds) and its volatility per minute
  //   venues { name: price }     each exchange's latest trade (last 10 s)
  //   feeds { name: lastAt }     when each exchange's feed last delivered a trade
  //   flowUsd                    dollars traded on the exchanges in the last second
  //   kalshi { ticker, yesBid, yesAsk, near, levels: [[side, price, qty]] }  the live round's book
  //   kTrades [{ t, count, side }] Kalshi trades on the live round since the last step
  //   futures { funding, premium, oiChange5, priceChange5 }  Hyperliquid's BTC perpetual (futures.js)
  function step({ now = clock(), price = null, sigmaMin = null, venues = {}, feeds = {}, flowUsd = 0, kalshi = null, kTrades: newK = [], futures = null } = {}) {
    const out = [];
    const add = (e) => { if (e) out.push(e); };
    // BTC: jumps
    if (price > 0) {
      push(prices, { t: now, p: price }, 120000);
      const then = at(prices, now - 5000);
      if (then && sigmaMin > 0 && now - then.t <= 8000) {
        const sd = price * sigmaMin * Math.sqrt(5 / 60), d = price - then.p, z = Math.abs(d) / sd;
        if (z >= 5) add(emit(now, 'jump', 'severe', `BTC ${d > 0 ? 'jumped' : 'dropped'} ${d > 0 ? '+' : '−'}${fmt$(d)} in 5s (${z.toFixed(1)}× a normal 5 seconds): new calls wait 30s for the dust to settle`, 'jump', 30));
        else if (z >= 3) add(emit(now, 'jump', 'warn', `BTC ${d > 0 ? 'jumped' : 'dropped'} ${d > 0 ? '+' : '−'}${fmt$(d)} in 5s (${z.toFixed(1)}× a normal 5 seconds)`));
      }
      // the price itself stopped: no fresh price for 30 s while the bot is running
    }
    const lastPrice = prices[prices.length - 1];
    if (prices.length && now - lastPrice.t > 30000) add(emit(now, 'silent', 'severe', 'No fresh BTC price for 30s+: new calls are on hold until the feeds are back', 'price-dead', 30));
    // exchanges: volume bursts
    push(flows, { t: now, usd: flowUsd || 0 }, 600000);
    const span = flows.length ? (now - flows[0].t) / 1000 : 0;
    if (span >= 120) {
      const recent = flows.filter((f) => f.t > now - 10000).reduce((a, f) => a + f.usd, 0);
      const usual = flows.filter((f) => f.t <= now - 10000).reduce((a, f) => a + f.usd, 0) / Math.max(1, span - 10) * 10;
      if (usual > 0 && recent >= 5 * usual && recent >= 200000) add(emit(now, 'burst', 'warn', `Volume burst: ${k$(recent)} traded in 10s (${(recent / usual).toFixed(1)}× the usual pace)`));
    }
    // exchanges: one breaking away from the others (5 s in a row), and silent feeds
    const names = Object.keys(venues).filter((n) => venues[n] > 0);
    if (names.length >= 3) {
      for (const n of names) {
        const others = median(names.filter((o) => o !== n).map((o) => venues[o])), gap = venues[n] - others;
        if (Math.abs(gap) >= Math.max(25, others * 0.0003)) {
          breakSince[n] ??= now;
          if (now - breakSince[n] >= 5000) add(emit(now, 'breakaway', 'warn', `${n} is ${fmt$(gap)} ${gap > 0 ? 'above' : 'below'} the other exchanges for ${Math.round((now - breakSince[n]) / 1000)}s`, `break-${n}`));
        } else delete breakSince[n];
      }
    }
    const fresh = Object.entries(feeds).filter(([, t]) => now - t <= 30000);
    if (fresh.length >= 3) for (const [n, t] of Object.entries(feeds)) if (now - t > 30000 && now - t < 3600000) add(emit(now, 'silent', 'warn', `${n} feed silent for ${Math.round((now - t) / 1000)}s while the others trade`, `silent-${n}`));
    // Kalshi: the live round's book
    if (kalshi?.ticker) {
      if (kalshi.ticker !== round) { round = kalshi.ticker; spreads.length = 0; depths.length = 0; mids.length = 0; kTrades.length = 0; }
      if (kalshi.yesBid != null && kalshi.yesAsk != null) {
        const spread = kalshi.yesAsk - kalshi.yesBid, mid = (kalshi.yesAsk + kalshi.yesBid) / 2;
        const usualSpread = median(spreads.map((s) => s.v));
        push(spreads, { t: now, v: spread }, 300000);
        if (spread >= 0.08 || (usualSpread != null && spreads.length >= 30 && spread >= 0.05 && spread >= 3 * usualSpread)) add(emit(now, 'spread', 'severe', `Kalshi's spread blew out to ${Math.round(spread * 100)}¢ (usually ${Math.round((usualSpread ?? 0.01) * 100)}¢): new calls wait until it tightens`, 'spread', 20));
        push(mids, { t: now, v: mid }, 120000);
        const m10 = at(mids, now - 10000), p10 = at(prices, now - 10000);
        if (m10 && now - m10.t <= 15000 && Math.abs(mid - m10.v) >= 0.08) {
          const z10 = p10 && sigmaMin > 0 && price > 0 ? Math.abs(price - p10.p) / (price * sigmaMin * Math.sqrt(10 / 60)) : null;
          if (z10 != null && z10 < 1) add(emit(now, 'reprice', 'warn', `Kalshi repriced ${mid > m10.v ? '+' : '−'}${Math.round(Math.abs(mid - m10.v) * 100)}¢ in 10s while BTC barely moved: someone may know something`));
        }
      }
      if (kalshi.near != null) {
        const usual = median(depths.map((d) => d.v));
        push(depths, { t: now, v: kalshi.near }, 60000);
        if (usual != null && depths.length >= 20 && usual >= 200 && kalshi.near < 0.3 * usual) add(emit(now, 'pulled', 'warn', `Kalshi liquidity pulled: ${Math.round(kalshi.near).toLocaleString()} contracts near the price (usually ${Math.round(usual).toLocaleString()})`));
      }
      if (kalshi.levels?.length >= 4) {
        const qs = kalshi.levels.map((l) => l[2]), typical = median(qs), big = kalshi.levels.reduce((a, l) => (l[2] > a[2] ? l : a));
        if (big[2] >= 1000 && big[2] >= 5 * typical) add(emit(now, 'wall', 'info', `Wall on Kalshi: ${Math.round(big[2]).toLocaleString()} contracts bid at ${Math.round(big[1] * 100)}¢ for ${big[0] === 'yes' ? 'UP' : 'DOWN'}`, `wall-${big[0]}-${big[1]}`));
      }
      for (const x of newK) push(kTrades, x, 600000);
      if (kTrades.length) {
        const kspan = Math.max(60, (now - kTrades[0].t) / 1000);
        const r30 = kTrades.filter((x) => x.t > now - 30000), c30 = r30.reduce((a, x) => a + x.count, 0);
        const usual = kTrades.filter((x) => x.t <= now - 30000).reduce((a, x) => a + x.count, 0) / Math.max(1, kspan - 30) * 30;
        if (c30 >= 500 && usual > 0 && c30 >= 4 * usual) {
          const up = r30.filter((x) => x.side === 'YES').reduce((a, x) => a + x.count, 0) / c30;
          add(emit(now, 'flurry', 'info', `Kalshi flurry: ${Math.round(c30).toLocaleString()} contracts in 30s (${(c30 / usual).toFixed(1)}× usual), ${Math.round(Math.max(up, 1 - up) * 100)}% buying ${up >= 0.5 ? 'UP' : 'DOWN'}`));
        }
      }
    }
    // futures: forced position closes, crowded funding, a stretched premium
    if (futures) {
      const { oiChange5: oi, priceChange5: pc, funding, premium } = futures;
      if (oi != null && pc != null && oi <= -0.015 && Math.abs(pc) >= 0.002) add(emit(now, 'flush', 'warn', `Futures open interest fell ${(Math.abs(oi) * 100).toFixed(1)}% in 5 min while price ${pc < 0 ? 'fell' : 'rose'} ${(Math.abs(pc) * 100).toFixed(2)}%: ${pc < 0 ? 'longs' : 'shorts'} being forced out (liquidations)`));
      if (funding != null && Math.abs(funding) >= 0.0001) add(emit(now, 'funding', 'info', `Futures funding ${funding > 0 ? '+' : '−'}${(Math.abs(funding) * 100).toFixed(3)}%/hour: ${funding > 0 ? 'longs' : 'shorts'} crowded (squeeze risk ${funding > 0 ? 'down' : 'up'})`, 'funding', 0));
      if (premium != null && Math.abs(premium) >= 0.001) add(emit(now, 'premium', 'info', `Futures trading ${(Math.abs(premium) * 100).toFixed(2)}% ${premium > 0 ? 'above' : 'below'} spot`));
    }
    return out;
  }
  const holdNow = (now = clock()) => (hold && hold.until > now ? hold : null);
  // what's going on, in one line, and how busy the last minute was (for the call record)
  function status(now = clock()) {
    const min = events.filter((e) => e.t > now - 60000);
    return { hold: holdNow(now), events60: min.filter((e) => e.sev !== 'info').length, calm: !min.length, last: events[0] ?? null };
  }
  return { step, hold: holdNow, status, events: () => events };
}
