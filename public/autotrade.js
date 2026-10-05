// Live auto-trading: decides when to place REAL Kalshi orders for the linked account. Pure functions only;
// the app signs and sends the orders. Same rules as Practice mode, plus hard money limits:
//   budget      most it will ever have at risk at once (open positions at cost)
//   maxPerTrade most one order may cost
//   dailyLoss   stop buying for the day once today's realized losses plus everything still open could reach this
//   maxTrades   most buy orders per day
// Orders are limit orders at the call's max price that fill now or cancel, so nothing is left resting on Kalshi,
// and a sell can never sell more than is held. It can only ever use the cash in the Kalshi account.
import { kalshiFee } from './model.js';

export const LIVE_DEFAULTS = { live: false, budget: 50, maxPerTrade: 10, dailyLoss: 40, maxTrades: 40, minConfidence: 80 };

const dayStart = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const cents = (p) => Math.round(p * 100);
const orderId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// Kalshi V2 order bodies (POST /portfolio/events/orders; the server re-checks every field). V2 has one YES book:
//   buy YES at <= p  -> bid at p          buy NO at <= p  -> ask at 1 - p
//   sell YES at >= p -> ask at p (reduce)  sell NO at >= p -> bid at 1 - p (reduce)
// Prices are fixed-point dollar strings ("0.4500"), counts "N.00". Fill now or cancel: nothing rests on Kalshi.
const px = (p) => (Math.round(Math.min(0.99, Math.max(0.01, p)) * 100) / 100).toFixed(4);
const qty = (n) => `${Math.floor(n)}.00`;
const v2 = ({ ticker, book, price, count, reduce }) => ({
  ticker, client_order_id: orderId(), side: book, count: qty(count), price: px(price),
  time_in_force: 'immediate_or_cancel', reduce_only: !!reduce, self_trade_prevention_type: 'taker_at_cross',
});
export function buyOrder({ ticker, side, count, limit }) {
  return side === 'NO' ? v2({ ticker, book: 'ask', price: 1 - limit, count }) : v2({ ticker, book: 'bid', price: limit, count });
}
export function sellOrder({ ticker, side, count, floor }) {
  return side === 'NO' ? v2({ ticker, book: 'bid', price: 1 - floor, count, reduce: true }) : v2({ ticker, book: 'ask', price: floor, count, reduce: true });
}

// Where the account stands today, from Kalshi-synced positions and trades plus the auto-trader's own order log.
export function liveState({ positions, trades, orders, now = Date.now() }) {
  const since = dayStart(now);
  const open = positions.filter((p) => p.source === 'kalshi');
  const exposure = open.reduce((a, p) => a + (p.price + kalshiFee(p.price)) * p.contracts, 0);
  const realized = trades.filter((t) => t.source === 'kalshi' && t.closedAt >= since).reduce((a, t) => a + t.pnl, 0);
  const buys = orders.filter((o) => o.at >= since && o.action === 'buy').length;
  return { exposure, realized, buys, worstCase: realized - exposure };
}

// Should it buy right now, and how many contracts? Returns { ok, why, order }.
export function planBuy({ cfg, sig, row, positions, trades, orders, balance, now = Date.now() }) {
  const c = { ...LIVE_DEFAULTS, ...cfg };
  if (!c.live) return { ok: false, why: 'Live auto-trading is off' };
  if (!row || !sig?.callSide) return { ok: false, why: 'Waiting for a call' };
  const ticker = row.m.ticker;
  const held = positions.find((p) => p.ticker === ticker);
  const add = !!(held && held.source === 'kalshi' && sig.add && held.side === sig.callSide);
  if (!add && !sig.fire) return { ok: false, why: 'Waiting for a new call' }; // a fresh call or a real switch
  if (held && !add) return { ok: false, why: 'Already holding this market' };
  if (!sig.bigGap && (sig.deep?.score ?? 0) < c.minConfidence) return { ok: false, why: `Skipped: confidence ${sig.deep?.score ?? '—'} is under ${c.minConfidence}` };
  if (orders.some((o) => o.ticker === ticker && now - o.at < 5000)) return { ok: false, why: 'Just sent an order on this market' };
  const st = liveState({ positions, trades, orders, now });
  if (st.buys >= c.maxTrades) return { ok: false, why: `Stopped for today: ${c.maxTrades} trades` };
  if (-st.worstCase >= c.dailyLoss) return { ok: false, why: `Stopped for today: $${c.dailyLoss} loss limit` };
  if (!(sig.limit > 0)) return { ok: false, why: 'No max price' };
  const q = row.ev.quote, ask = sig.callSide === 'YES' ? q.yesAsk : q.noAsk;
  if (ask == null) return { ok: false, why: 'No Kalshi price' };
  if (ask > sig.limit + 1e-9) return { ok: false, why: `Skipped: price ${cents(ask)}¢ is over the ${cents(sig.limit)}¢ max` };
  const per = sig.limit + kalshiFee(sig.limit); // worst case: filled at the max price
  const room = Math.min(c.maxPerTrade, c.budget - st.exposure, c.dailyLoss + st.worstCase, balance ?? 0);
  const count = Math.min(Math.floor(room / per), Math.max(1, sig.contracts || 1));
  if (count < 1) {
    if ((balance ?? 0) < per) return { ok: false, why: `Not enough Kalshi cash ($${(balance ?? 0).toFixed(2)})` };
    return { ok: false, why: `Budget full ($${st.exposure.toFixed(2)} of $${c.budget} at risk)` };
  }
  return { ok: true, add, order: buyOrder({ ticker, side: sig.callSide, count, limit: sig.limit }), meta: { action: 'buy', side: sig.callSide, count, cents: cents(sig.limit) } };
}

// Should it sell this Kalshi position now? `check` is positionCheck() for it. Sells at the bid or better.
export function planSell({ cfg, pos, check, orders, now = Date.now() }) {
  if (!cfg?.live || pos.source !== 'kalshi') return null;
  if (check.ex.action !== 'SELL' || !(check.bid > 0)) return null;
  if (orders.some((o) => o.ticker === pos.ticker && now - o.at < 5000)) return null;
  const count = Math.floor(pos.contracts);
  if (count < 1) return null;
  return { order: sellOrder({ ticker: pos.ticker, side: pos.side, count, floor: check.bid }), meta: { action: 'sell', side: pos.side, count, cents: cents(check.bid) } };
}
