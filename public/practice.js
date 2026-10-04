// Practice auto-trader: runs the rules a live auto-trader would use, on live Kalshi prices, and records
// the trades it WOULD make with their P&L. It never talks to Kalshi's order API; nothing here sends orders.
// Fills are assumed at the quote shown at that moment (buys at the ask, sells at the bid), with Kalshi fees.
import { kalshiFee } from './model.js';
import { positionCheck, releaseCall } from './engine.js';

export const PRACTICE_DEFAULTS = { on: false, maxPerTrade: 5, dailyLoss: 20, maxTrades: 10, minConfidence: 60 };
export const newPractice = () => ({ positions: [], log: [], since: Date.now(), range: { positions: [], log: [] } });

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
  const ticker = row?.m.ticker;
  const held = row ? pr.positions.find((p) => p.ticker === ticker) : null;
  // Aggressive scale-in: the call's gap grew past the next tier while we hold it, so add
  const add = !!(held && sig?.add && sig.callSide === held.side);
  if (!row || !sig?.callSide || (!add && (!sig.fire || sig.stance !== 'new'))) return { ok: false, why: 'Waiting for a new call' };
  if ((sig.deep?.score ?? 0) < c.minConfidence) return { ok: false, why: `Skipped: confidence ${sig.deep?.score ?? '—'} is under ${c.minConfidence}` };
  if (held && !add) return { ok: false, why: 'Already holding this market' };
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
  return { ok: true, count, price, add };
}

// One step: sell what the exit rules say to sell, then buy a new call if the rules allow.
// Mutates `pr`; returns the actions taken (for toasts) and why it didn't buy (for the card).
export function practiceStep(pr, { snap, row, sig, settings, cfg, memory = null, now = Date.now() }) {
  const actions = [];
  for (const pos of [...pr.positions]) {
    if (!snap.rows.some((r) => r.m.ticker === pos.ticker)) continue;
    const ch = positionCheck(pos, snap, settings, now);
    if (ch.ex.action !== 'SELL' || !(ch.bid > 0)) continue;
    const proceeds = (ch.bid - kalshiFee(ch.bid)) * pos.contracts;
    const e = { at: now, ticker: pos.ticker, action: 'sell', kind: ch.ex.kind, side: pos.side, price: ch.bid, contracts: pos.contracts, proceeds: r2(proceeds), pnl: r2(proceeds - pos.cost), why: ch.ex.why };
    pr.log.push(e); actions.push(e);
    pr.positions = pr.positions.filter((p) => p !== pos);
    releaseCall(memory, pos.ticker, now, settings); // sold: a fresh call on this market can fire again after the cooldown
  }
  const b = wouldBuy(pr, { row, sig, cfg, now });
  if (b.ok) {
    const cost = (b.price + kalshiFee(b.price)) * b.count;
    let pos = b.add ? pr.positions.find((p) => p.ticker === row.m.ticker) : null;
    if (pos) { // average into the open position
      pos.price = r2((pos.price * pos.contracts + b.price * b.count) / (pos.contracts + b.count) * 100) / 100;
      pos.contracts += b.count; pos.cost = r2(pos.cost + cost);
    } else {
      pos = { id: `pr-${now}`, ticker: row.m.ticker, side: sig.callSide, price: b.price, contracts: b.count, cost: r2(cost), closeTime: row.m.close_time, at: now, peakBid: null, peakP: null };
      pr.positions.push(pos);
    }
    const e = { at: now, ticker: pos.ticker, action: 'buy', add: b.add, side: pos.side, price: b.price, contracts: b.count, cost: r2(cost), conf: sig.deep?.score ?? null, limit: sig.limit };
    pr.log.push(e); actions.push(e);
  }
  if (pr.log.length > 500) pr.log = pr.log.slice(-500);
  return { actions, why: b.ok ? null : b.why };
}

// A market settled: practice positions in it pay $1 or $0 (the bot's and Range watch's).
export function practiceSettle(pr, ticker, result, now = Date.now()) {
  const out = [];
  const rg = (pr.range ||= { positions: [], log: [] });
  for (const pos of rg.positions.filter((p) => p.ticker === ticker)) {
    const proceeds = pos.side.toLowerCase() === result ? pos.contracts : 0;
    const e = { at: now, ticker, action: 'settle', side: pos.side, price: proceeds ? 1 : 0, contracts: pos.contracts, proceeds: r2(proceeds), pnl: r2(proceeds - pos.cost), range: true };
    rg.log.push(e); out.push(e);
  }
  rg.positions = rg.positions.filter((p) => p.ticker !== ticker);
  for (const pos of pr.positions.filter((p) => p.ticker === ticker)) {
    const proceeds = pos.side.toLowerCase() === result ? pos.contracts : 0;
    const e = { at: now, ticker, action: 'settle', side: pos.side, price: proceeds ? 1 : 0, contracts: pos.contracts, proceeds: r2(proceeds), pnl: r2(proceeds - pos.cost) };
    pr.log.push(e); out.push(e);
  }
  pr.positions = pr.positions.filter((p) => p.ticker !== ticker);
  return out;
}

// ---------- Range watch (experiment) ----------
// The ceiling/floor rule from the user's chart guideline, tracked side by side with the bot so a week of live
// data can show whether it helps. Ceiling = highest high of the last `lookback` closed 1-minute candles,
// floor = lowest low; each must be touched at least `minTouches` times (within tol × ATR) and the range
// must be at least minRange × ATR wide. Rejected at the ceiling (poked up, closed back below) = expect down;
// rejected at the floor = expect up. Same test as the offline study on ~1,100 real candles.
export const RANGE_DEFAULTS = { lookback: 20, tol: 0.3, minTouches: 2, minRange: 2 };

export function rangeRead(bars, params = {}) {
  const p = { ...RANGE_DEFAULTS, ...params };
  if (!bars || bars.length < p.lookback + 1) return null;
  const look = bars.slice(-p.lookback - 1, -1), cur = bars[bars.length - 1];
  const atr = look.reduce((a, b) => a + (b.h - b.l), 0) / look.length;
  if (!(atr > 0)) return null;
  const ceil = Math.max(...look.map((b) => b.h)), floor = Math.min(...look.map((b) => b.l));
  const t = p.tol * atr;
  const ceilTouches = look.filter((b) => b.h >= ceil - t).length, floorTouches = look.filter((b) => b.l <= floor + t).length;
  const ranged = ceil - floor >= p.minRange * atr && ceilTouches >= p.minTouches && floorTouches >= p.minTouches;
  const base = { ranged, ceil, floor, ceilTouches, floorTouches, at: cur.t };
  if (!ranged) return { ...base, dir: 0, why: 'No clear ceiling and floor right now' };
  const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
  if (cur.h >= ceil - t && cur.c < ceil - t / 2) return { ...base, dir: -1, why: `Rejected at the ceiling ${usd(ceil)}: expect down` };
  if (cur.l <= floor + t && cur.c > floor + t / 2) return { ...base, dir: 1, why: `Rejected at the floor ${usd(floor)}: expect up` };
  return { ...base, dir: 0, why: `Ranging between ${usd(floor)} and ${usd(ceil)}` };
}

// One Range watch step: on a fresh rejection inside the calling window, paper-buy the side it points to
// (down = NO, up = YES) at Kalshi's ask, sized like practice, once per window, held to settlement.
export function rangeStep(pr, { snap, row, cfg, now = Date.now() }) {
  const c = { ...PRACTICE_DEFAULTS, ...cfg };
  const rg = (pr.range ||= { positions: [], log: [] });
  const closed = (snap?.bars || []).filter((b) => b.t + 60000 <= now);
  const read = rangeRead(closed);
  if (!c.on || !row || !row.ev.open || !read?.dir) return { actions: [], read };
  const ticker = row.m.ticker;
  if (rg.log.some((e) => e.ticker === ticker && e.action === 'buy')) return { actions: [], read };
  const side = read.dir > 0 ? 'YES' : 'NO';
  const q = row.ev.quote, price = side === 'YES' ? q.yesAsk : q.noAsk;
  if (price == null) return { actions: [], read };
  const spentToday = rg.log.filter((e) => e.action === 'buy' && e.at >= dayStart(now)).reduce((a, e) => a + e.cost, 0);
  const backToday = rg.log.filter((e) => e.action !== 'buy' && e.at >= dayStart(now)).reduce((a, e) => a + e.proceeds, 0);
  const budget = Math.min(c.maxPerTrade, c.dailyLoss - (spentToday - backToday));
  const per = price + kalshiFee(price), count = Math.floor(budget / per);
  if (count < 1) return { actions: [], read };
  const cost = per * count;
  rg.positions.push({ ticker, side, price, contracts: count, cost: r2(cost), closeTime: row.m.close_time, at: now });
  const e = { at: now, ticker, action: 'buy', side, price, contracts: count, cost: r2(cost), why: read.why, range: true };
  rg.log.push(e);
  if (rg.log.length > 500) rg.log = rg.log.slice(-500);
  return { actions: [e], read };
}

export function rangeStats(pr) {
  const closes = (pr.range?.log || []).filter((e) => e.action !== 'buy');
  return { trades: closes.length, wins: closes.filter((e) => e.pnl > 0).length, pnl: r2(closes.reduce((a, e) => a + e.pnl, 0)), open: pr.range?.positions.length || 0 };
}
