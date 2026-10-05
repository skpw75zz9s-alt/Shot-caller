// Self-check ("debug every 2 rounds"): every 30 minutes the app checks the things that can quietly break
// auto-trading and alerts, and says what to do about each. Pure function; app.js gathers the inputs.
// Each result: { level: 'ok' | 'warn' | 'bad', key, label, fix }
export const ROUND_MS = 15 * 60000;
export const HEALTH_EVERY_ROUNDS = 2;

// True when `now` is in a different 2-round block than `last` (checks line up with the market clock: :00 and :30)
export const healthDue = (last, now) => !last || Math.floor(now / (ROUND_MS * HEALTH_EVERY_ROUNDS)) !== Math.floor(last / (ROUND_MS * HEALTH_EVERY_ROUNDS));

const ago = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)} min`);

export function healthCheck(h) {
  const { now = Date.now() } = h;
  const out = [];
  const add = (level, key, label, fix = '') => out.push({ level, key, label, fix });

  // Server and Kalshi prices (the app fetches both through the server every few seconds)
  const mAge = h.marketsAt ? now - h.marketsAt : Infinity;
  if (mAge > 120000) add('bad', 'kalshi-prices', h.marketsAt ? `Kalshi prices are ${ago(mAge)} old` : 'No Kalshi prices yet', 'Check your internet. If it stays, the server may be down: open the app link again.');
  else add('ok', 'kalshi-prices', `Kalshi prices fresh (${ago(mAge)} old)`);
  if (h.noMarket) add('warn', 'no-market', 'No open 15-minute BTC market right now', 'Kalshi may be between markets or paused. Nothing to fix; it resumes on its own.');

  // BTC price
  const sAge = h.spotAt ? now - h.spotAt : Infinity;
  if (sAge > 60000) add('bad', 'btc', h.spotAt ? `BTC price is ${ago(sAge)} old` : 'No BTC price yet', 'Check your internet. The app retries on its own.');
  else add('ok', 'btc', h.streaming ? 'BTC price streaming live' : `BTC price fresh (${ago(sAge)} old, polling)`);
  const cAge = h.candlesAt ? now - h.candlesAt : Infinity;
  if (cAge > 5 * 60000) add('warn', 'candles', 'Candles haven\'t updated in a while', 'Usually a slow connection; they reload every 20 seconds.');

  // Phone clock: Kalshi rejects signed requests when the clock is off
  if (h.skewMs != null) {
    const s = Math.abs(h.skewMs) / 1000;
    if (s > 20) add('bad', 'clock', `Phone clock is off by ${Math.round(s)}s`, 'Turn on Settings → General → Date & Time → Set Automatically. Kalshi refuses orders from a wrong clock.');
    else if (s > 5) add('warn', 'clock', `Phone clock is off by ${Math.round(s)}s`, 'Turn on Set Automatically in your phone\'s Date & Time settings.');
    else add('ok', 'clock', 'Phone clock matches the server');
  }

  // Kalshi account link
  if (!h.linked) add(h.liveOn ? 'bad' : 'ok', 'kalshi-link', h.liveOn ? 'Live trading is on but Kalshi isn\'t linked on this phone' : 'Kalshi account not linked (optional)', h.liveOn ? 'Link your Kalshi account again in Settings.' : '');
  else {
    const bAge = h.balanceAt ? now - h.balanceAt : Infinity;
    if (h.kalshiError) add('bad', 'kalshi-sync', `Kalshi sync error: ${h.kalshiError}`, /401|403|signature|key/i.test(h.kalshiError) ? 'Your API key may be deleted or wrong. Make a new key in Kalshi and link it again.' : 'Tap Sync in the Kalshi card. If it keeps failing, link the key again.');
    else if (bAge > 5 * 60000) add('warn', 'kalshi-sync', `Kalshi balance last synced ${h.balanceAt ? `${ago(bAge)} ago` : 'never'}`, 'Tap Sync in the Kalshi card.');
    else add('ok', 'kalshi-sync', `Kalshi linked · balance $${(h.balance ?? 0).toFixed(2)}`);
  }

  // Live auto-trader
  if (h.liveOn) {
    if (h.busySince && now - h.busySince > 30000) add('bad', 'live-stuck', `An order has been waiting for ${ago(now - h.busySince)}`, 'Close and reopen the app. Check Kalshi to see if the order went through.');
    if (h.lastOrderError) add('bad', 'live-error', `Last live order failed: ${h.lastOrderError}`, 'Send a screenshot of the Live card if this keeps happening.');
    if (h.balance != null && h.balance < 1) add('warn', 'live-cash', `Kalshi cash is $${h.balance.toFixed(2)}`, 'Add money in the Kalshi app or it can\'t buy.');
    if (h.budget != null && h.exposure != null && h.exposure >= h.budget - 0.01) add('warn', 'live-budget', 'Live budget is full', 'It buys again after a position closes, or raise Budget.');
    if (h.seen && h.seen.minutes >= 60) {
      const at = h.seen.bars.find(([b]) => b === h.liveConf)?.[1] ?? 0;
      const lower = h.seen.bars.filter(([b, n]) => b < h.liveConf && n > 0);
      if (at === 0 && lower.length) add('warn', 'live-bar', `Min confidence ${h.liveConf} found no trades in ${h.seen.minutes} min`, `At ${lower[0][0]} it would have bought ${lower[0][1]}. Lower Min confidence in the Live card if you want more trades.`);
    }
    if (!out.some((r) => r.key.startsWith('live-') && r.level !== 'ok')) add('ok', 'live', 'Live auto-trader running normally');
  }

  // Push notifications (not required, but alerts with the app closed need them)
  if (h.pushSupported && !h.pushOn) add('warn', 'push', 'Push notifications are off', 'Settings → Turn on push notifications, for alerts with the app closed.');
  else if (h.pushOn) add('ok', 'push', 'Push notifications on');

  return out;
}

// Problems that weren't in the previous check (so you're only told about something once)
export const newProblems = (prev, cur) => cur.filter((r) => r.level !== 'ok' && !(prev || []).some((p) => p.key === r.key && p.level !== 'ok'));
