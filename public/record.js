// The bot's call record: every BUY THE LOW call it makes, graded when Kalshi settles the market.
// Confidence is the bot's claimed win odds, so this is the honest test of accuracy: calls it gave
// 85-90% should win about 85-90% of the time. Pure functions; app.js keeps the log in localStorage.
import { kalshiFee } from './model.js';
import { confBucket } from './analysis.js';

const MAX = 500;

// One entry per call (a switch to the other side is a new call). Returns true if it was added.
export function logCall(log, { ticker, side, price, conf, at, closeTime, n = 1 }) {
  if (!ticker || !side || !(price > 0 && price < 1)) return false;
  if (log.some((e) => e.ticker === ticker && e.side === side && e.n === n)) return false;
  log.push({ ticker, side, price, conf: conf ?? null, at, closeTime, n, result: null });
  if (log.length > MAX) log.splice(0, log.length - MAX);
  return true;
}

// Calls whose market has closed and still need Kalshi's result
export const unsettledCalls = (log, now = Date.now()) => log.filter((e) => !e.result && Date.parse(e.closeTime) < now - 60000);

export function settleCalls(log, ticker, result) {
  let n = 0;
  for (const e of log) if (e.ticker === ticker && !e.result) { e.result = result; n++; }
  return n;
}

// Per $10 call held to settlement, after Kalshi's fee
const usd10 = (e, won) => (10 / e.price) * ((won ? 1 : 0) - e.price - kalshiFee(e.price));

export function callStats(log) {
  const graded = log.filter((e) => e.result === 'yes' || e.result === 'no');
  const won = (e) => e.side.toLowerCase() === e.result;
  const sum = (xs, f) => xs.reduce((a, e) => a + f(e), 0);
  const withConf = graded.filter((e) => e.conf != null);
  const buckets = {};
  for (const e of withConf) {
    const b = (buckets[confBucket(e.conf)] ||= { calls: 0, wins: 0, said: 0, usd: 0 });
    b.calls++; b.wins += won(e) ? 1 : 0; b.said += e.conf; b.usd += usd10(e, won(e));
  }
  for (const b of Object.values(buckets)) b.said /= b.calls;
  return {
    calls: log.length, graded: graded.length, wins: graded.filter(won).length,
    said: withConf.length ? sum(withConf, (e) => e.conf) / withConf.length : null, // average claimed win odds
    usd: sum(graded, (e) => usd10(e, won(e))), buckets,
  };
}
