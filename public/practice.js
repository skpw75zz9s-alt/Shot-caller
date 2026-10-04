// Practice auto-trader: runs the rules a live auto-trader would use, on live Kalshi prices, and records
// the trades it WOULD make with their P&L. It never talks to Kalshi's order API; nothing here sends orders.
// Fills are assumed at the quote shown at that moment (buys at the ask, sells at the bid), with Kalshi fees.
import { kalshiFee } from './model.js';
import { positionCheck } from './engine.js';

export const PRACTICE_DEFAULTS = { on: false, maxPerTrade: 5, dailyLoss: 20, maxTrades: 10, minConfidence: 70 };
export const newPractice = () => ({ positions: [], log: [], since: Date.now() });

const dayStart = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const r2 = (v) => Math.round(v * 100) / 100;

// Today's numbers: what was spent on buys, what came back, realized P&L, and how many buys.
// atRisk counts open positions as fully at risk, so the daily loss limit can never be overrun.
export function todayStats(pr, now = Date.now()) {
  const since = dayStart(now);
  let spent = 0, back = 0, buys = 0, pnl = 0, closed = 0, wins = 0;
  for (const e of pr.log) {
    if (e.at < since) continue;
    if (e.action === 'buy') { spent += e.cost; buys++; } else {
      back += e.proceeds; pnl += e.pnl; closed++; if (e.pnl > 0) wins++;
    }
  }
  return { spent: r2(spent), back: r2(back), atRisk: r2(spent - back), buys, pnl: r2(pnl), closed, wins };
}

// All-time numbers since the practice log was started (or reset).
export function allStats(pr) {
  const closes = pr.log.filter((e) => e.action !== 'buy');
  return { trades: closes.length, wins: closes.filter((e) => e.pnl > 0).length, pnl: r2(closes.reduce((a, e) => a + e.pnl, 0)) };
}

// Would the auto-trader buy this call right now? { ok, why, count, price }
export function wouldBuy(pr, { row, sig, cfg, now = Date.now() }) {
  const c = { ...PRACTICE_DEFAULTS, ...cfg };
  if (!c.on) return { ok: false, why: 'Practice is off' };
  if (!row || !sig?.fire || !sig.callSide || sig.stance !== 'new') return { ok: false, why: 'Waiting for a new call' };
  const ticker = row.m.ticker;
  if ((sig.deep?.score ?? 0) < c.minConfidence) return { ok: false, why: `Skipped: confidence ${sig.deep?.score ?? '—'} is under ${c.minConfidence}` };
  if (pr.positions.some((p) => p.ticker === ticker)) return { ok: false, why: 'Already holding this market' };
  if (pr.log.some((e) => e.ticker === ticker && e.action === 'buy')) return { ok: false, why: 'Already bought once this window' };
  const t = todayStats(pr, now);
  if (t.buys >= c.maxTrades) return { ok: false, why: `Skipped: hit today's limit of ${c.maxTrades} trades` };
  if (t.atRisk >= c.dailyLoss) return { ok: false, why: `Skipped: hit today's $${c.dailyLoss} loss limit` };
  const q = row.ev.quote;
  const price = sig.callSide === 'YES' ? q.yesAsk : q.noAsk;
  if (price == null) return { ok: false, why: 'No Kalshi price' };
  if (sig.limit != null && price > sig.limit + 1e-9) return { ok: false, why: `Skipped: price ${Math.round(price * 100)}¢ is over the ${Math.round(sig.limit * 100)}¢ max` };
  const per = price + kalshiFee(price);
  const budget = Math.min(c.maxPerTrade, c.dailyLoss - t.atRisk);
  const count = Math.min(Math.floor(budget / per), Math.max(1, sig.contracts || 1));
  if (count < 1) return { ok: false, why: `Skipped: $${c.maxPerTrade} buys less than one contract at ${Math.round(price * 100)}¢` };
  return { ok: true, count, price };
}

// One step: sell what the exit rules say to sell, then buy a new call if the rules allow.
// Mutates `pr`; returns the actions taken (for toasts) and why it didn't buy (for the card).
export function practiceStep(pr, { snap, row, sig, settings, cfg, now = Date.now() }) {
  const actions = [];
  for (const pos of [...pr.positions]) {
    if (!snap.rows.some((r) => r.m.ticker === pos.ticker)) continue;
    const ch = positionCheck(pos, snap, settings, now);
    if (ch.ex.action !== 'SELL' || !(ch.bid > 0)) continue;
    const proceeds = (ch.bid - kalshiFee(ch.bid)) * pos.contracts;
    const e = { at: now, ticker: pos.ticker, action: 'sell', kind: ch.ex.kind, side: pos.side, price: ch.bid, contracts: pos.contracts, proceeds: r2(proceeds), pnl: r2(proceeds - pos.cost), why: ch.ex.why };
    pr.log.push(e); actions.push(e);
    pr.positions = pr.positions.filter((p) => p !== pos);
  }
  const b = wouldBuy(pr, { row, sig, cfg, now });
  if (b.ok) {
    const cost = (b.price + kalshiFee(b.price)) * b.count;
    const pos = { id: `pr-${now}`, ticker: row.m.ticker, side: sig.callSide, price: b.price, contracts: b.count, cost: r2(cost), closeTime: row.m.close_time, at: now, peakBid: null, peakP: null };
    pr.positions.push(pos);
    const e = { at: now, ticker: pos.ticker, action: 'buy', side: pos.side, price: b.price, contracts: b.count, cost: r2(cost), conf: sig.deep?.score ?? null, limit: sig.limit };
    pr.log.push(e); actions.push(e);
  }
  if (pr.log.length > 500) pr.log = pr.log.slice(-500);
  return { actions, why: b.ok ? null : b.why };
}

// A market settled: practice positions in it pay $1 or $0.
export function practiceSettle(pr, ticker, result, now = Date.now()) {
  const out = [];
  for (const pos of pr.positions.filter((p) => p.ticker === ticker)) {
    const proceeds = pos.side.toLowerCase() === result ? pos.contracts : 0;
    const e = { at: now, ticker, action: 'settle', side: pos.side, price: proceeds ? 1 : 0, contracts: pos.contracts, proceeds: r2(proceeds), pnl: r2(proceeds - pos.cost) };
    pr.log.push(e); out.push(e);
  }
  pr.positions = pr.positions.filter((p) => p.ticker !== ticker);
  return out;
}
