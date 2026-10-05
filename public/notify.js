// Notification limiter, shared by the server's push alerts and the app's own alerts, so the phone never gets spammed:
//   buy    at most 2 per 15-minute market (the first call, plus one real switch or re-entry), 3+ minutes apart
//   add    at most 1 per market
//   update hourly instead of every window (handled by the caller)
//   all of the above together: at most 6 an hour
//   sell   once per position (not once per sell reason), and never held back by the hourly cap: it's about money you hold
export const NOTIFY_LIMITS = { buysPerMarket: 2, buyGapMs: 3 * 60000, addsPerMarket: 1, perHour: 6 };

// log: a plain object kept per phone ({ sent: [{ t, kind, ticker }], sold: { [posId]: t } }). Mutates it when allowed.
export function allowAlert(log, kind, { ticker = null, posId = null, now = Date.now() } = {}) {
  log.sent ||= []; log.sold ||= {};
  log.sent = log.sent.filter((e) => e.t > now - 3600000);
  for (const [id, t] of Object.entries(log.sold)) if (t < now - 6 * 3600000) delete log.sold[id];
  if (kind === 'sell') {
    if (posId == null || log.sold[posId]) return false;
    log.sold[posId] = now;
    return true;
  }
  const L = NOTIFY_LIMITS;
  const here = log.sent.filter((e) => e.ticker === ticker && e.kind === kind);
  if (kind === 'buy' && (here.length >= L.buysPerMarket || here.some((e) => now - e.t < L.buyGapMs))) return false;
  if (kind === 'add' && here.length >= L.addsPerMarket) return false;
  if (log.sent.length >= L.perHour) return false;
  log.sent.push({ t: now, kind, ticker });
  return true;
}

// Updates go out once an hour by default, on the window that opens at the top of the hour (every = 15: every window)
export const hourlyWindow = (openTime, every = 60) => every <= 15 || new Date(openTime).getMinutes() % every === 0;
