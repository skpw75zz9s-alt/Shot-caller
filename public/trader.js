// Auto buyer / auto seller. Buys the bot's locked calls and sells on its sell signals, through a pluggable exchange:
//   test  a simulator on live Kalshi prices: nothing is sent anywhere (start here)
//   demo  real orders on Kalshi's demo exchange (fake money): proves the order format end to end
//   live  real orders, real money
// Built so the errors that broke the old auto-trader can't happen:
//   - fill-now orders only (immediate_or_cancel): nothing waits on Kalshi's book holding cash
//   - right before every buy it re-reads the cash, what open orders hold, and the order book, and sizes the order
//     so price x contracts + Kalshi's fee fits, with a cushion. Can't afford one contract: no order is sent
//   - one request at a time, spaced out (no rate-limit bursts); retries reuse the client order id, so a retry
//     after a timeout can never buy twice
//   - sells are reduce-only and sized from Kalshi's own position count, so they can never sell more than you hold
//   - if an order's outcome is unknown (a timeout), it reads the position back before doing anything else, so a
//     fill it didn't hear about is still counted and never bought again
//   - 3 errors in a row pause it; anything that looks like a bug (a bad request, a refused key) stops it outright
export const TRADER_DEFAULTS = {
  mode: 'off',       // off | test | demo | live
  perTrade: 10,      // most one buy may cost, fees included ($)
  dailyLoss: 30,     // stop buying for the day once today's losses plus what's still open could reach this ($)
  maxTrades: 20,     // most buys per day
  maxOpen: 40,       // most money in open positions at once ($)
  tries: 3,          // buy attempts per call (price moved above the max, nothing to buy, a refused order)
  slipCents: 1,      // sells accept up to this much under the bid, so they fill
  testCash: 100,     // the simulator's starting balance ($)
};
export const MODES = { off: 'Off', test: 'Test', demo: 'Demo', live: 'Live' };
// Limits the user can edit: [key, label, min, max]
export const LIMITS = [
  ['perTrade', 'Max per trade ($)', 1, 100],
  ['dailyLoss', 'Daily loss stop ($)', 1, 1000],
  ['maxTrades', 'Max buys a day', 1, 200],
  ['maxOpen', 'Max open at once ($)', 1, 1000],
  ['testCash', 'Test balance ($)', 5, 100000],
];
// Live unlocks once Test has settled LIVE_UNLOCK trades without a serious error (one that means the trader itself
// is wrong: a cash refusal, a bad request, a refused key; not Kalshi having a hiccup)
export const LIVE_UNLOCK = 10;
const SERIOUS = new Set(['cash', 'bad', 'key']);
export function liveUnlocked(testState) {
  const settled = (testState?.ledger || []).filter((e) => e.closed).length;
  const serious = (testState?.log || []).some((x) => x.kind === 'error' && SERIOUS.has(x.err));
  return { ok: settled >= LIVE_UNLOCK && !serious, settled, serious };
}
// A limits update, clamped to the allowed ranges (anything else in `body` is ignored)
export function cleanLimits(body, cur = TRADER_DEFAULTS) {
  const out = {};
  for (const [k, , min, max] of LIMITS) if (body?.[k] != null && Number.isFinite(Number(body[k]))) out[k] = Math.min(max, Math.max(min, Math.floor(Number(body[k]))));
  return { ...cur, ...out };
}
const CUSHION = 0.05;             // dollars kept back from the cash: rounding and fees on Kalshi's side
const GAP_MS = 350;               // at least this long between two requests to Kalshi
const r2 = (x) => Math.round(x * 100) / 100;
export const feeFor = (count, price) => (count > 0 ? Math.ceil(0.07 * count * price * (1 - price) * 100 - 1e-9) / 100 : 0);
export const costFor = (count, price) => r2(count * price + feeFor(count, price));
const dayKey = (t) => new Date(t).toDateString();
const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `sc-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// ---------- Kalshi V2 order bodies (POST /portfolio/events/orders): one YES book ----------
//   buy YES at <= p -> bid at p             buy NO at <= p  -> ask at 1 - p
//   sell YES at >= p -> ask at p, reduce    sell NO at >= p -> bid at 1 - p, reduce
// Prices are dollar strings with 4 decimals ("0.4500"), counts whole contracts ("3.00"). Fill now or cancel.
const px = (p) => (Math.round(Math.min(0.99, Math.max(0.01, p)) * 100) / 100).toFixed(4);
const qty = (n) => `${Math.floor(n)}.00`;
const v2 = ({ ticker, book, price, count, reduce, id }) => ({ ticker, client_order_id: id || uid(), side: book, count: qty(count), price: px(price), time_in_force: 'immediate_or_cancel', reduce_only: !!reduce, self_trade_prevention_type: 'taker_at_cross' });
export const buyOrder = ({ ticker, side, count, limit, id }) => (side === 'NO' ? v2({ ticker, book: 'ask', price: 1 - limit, count, id }) : v2({ ticker, book: 'bid', price: limit, count, id }));
export const sellOrder = ({ ticker, side, count, floor, id }) => (side === 'NO' ? v2({ ticker, book: 'bid', price: 1 - floor, count, reduce: true, id }) : v2({ ticker, book: 'ask', price: floor, count, reduce: true, id }));

// ---------- order book: { yes: [[price, qty]], no: [[price, qty]] } bids, in dollars ----------
const num = (v) => (v == null || v === '' ? null : Number(v));
export function parseBook(body) {
  const ob = body?.orderbook ?? body?.orderbook_fp ?? body ?? {};
  const side = (k) => (ob[`${k}_dollars`] || ob[k] || []).map(([p, q]) => {
    let price = num(p); if (price > 1) price /= 100; // cents (classic) or dollars (V2)
    return [Math.round(price * 100) / 100, num(q)];
  }).filter(([p, q]) => p > 0 && p < 1 && q > 0);
  return { yes: side('yes'), no: side('no') };
}
// Best price and contracts available to BUY `side` at or under `limit` (asks for YES are the NO bids, and vice versa)
export function buyDepth(book, side, limit) {
  const bids = side === 'YES' ? book.no : book.yes;
  let best = null, count = 0, levels = 0;
  for (const [p, q] of bids) { const ask = Math.round((1 - p) * 100) / 100; if (best == null || ask < best) best = ask; if (ask <= limit + 1e-9) { count += q; levels++; } }
  return { best, count, levels };
}
// Best bid and contracts that would buy `side` from you at or above `floor`
export function sellDepth(book, side, floor) {
  let best = null, count = 0;
  for (const [p, q] of side === 'YES' ? book.yes : book.no) { if (best == null || p > best) best = p; if (p >= floor - 1e-9) count += q; }
  return { best, count };
}

// How many contracts to buy: within the per-trade limit, the room left under the daily stop and the open cap, what
// the book can fill at or under the max price, and the cash (fee included, with a cushion) after open orders' holds
// Kalshi rounds the fee up on each fill, so an order that fills at several prices can pay a cent more per extra
// price level: `levels` reserves that.
export function sizeBuy({ want, price, cash, held = 0, perTrade, room, depth = Infinity, shrink = 1, levels = 1 }) {
  const budget = Math.min(perTrade, room, Math.max(0, cash - held - CUSHION)) * shrink;
  const slack = Math.max(0, levels - 1) * 0.01;
  let n = Math.floor(Math.min(want, depth, budget / price));
  while (n > 0 && costFor(n, price) + slack > budget + 1e-9) n--;
  return Math.max(0, n);
}

// What kind of failure an order hit, and what to do about it
export function classify(err) {
  const s = err?.status ?? 0, text = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  if (/insufficient|balance/.test(text)) return 'cash';            // re-read the cash and try smaller
  if (s === 429 || /too many|rate/.test(text)) return 'busy';       // wait and try again; nothing was placed
  if (s === 401 || s === 403 || /permission|unauthori|forbidden|key/.test(text)) return 'key';  // stop: the key can't trade
  if (s === 409 || /duplicate|already/.test(text)) return 'dup';    // the first try went through: don't count twice
  if (!s || s >= 500) return 'unknown';                             // timeout / Kalshi hiccup: outcome unknown
  return 'bad';                                                     // a 400 we didn't expect: stop and show it
}

// ---------- the executor ----------
// exchange: { cash(): { balance, held }, book(ticker): parseBook() shape | null, positions(ticker?): [{ ticker, side, count }],
//             place(order): { filled, avgPrice, fees }, settle?(ticker, result) (the simulators) }
// Errors are thrown as { status, code, message }. It never runs two requests at once and never sends one within
// GAP_MS of the last.
export function createTrader({ exchange, settings, store = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const S = () => ({ ...TRADER_DEFAULTS, ...settings() });
  const st = { ledger: [], log: [], calls: {}, errors: 0, pausedUntil: 0, stopped: null, pending: null, ...(store?.load() || {}) };
  const save = () => store?.save(st);
  let busy = false, lastReq = 0;
  const word = (side) => (side === 'YES' ? 'UP' : 'DOWN');
  const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
  const note = (kind, text, extra = {}) => {
    st.log.unshift({ t: now(), kind, text, ...extra });
    if (st.log.length > 150) st.log.length = 150;
    save();
  };
  async function call(fn) { // spacing between requests to Kalshi
    const wait = lastReq + GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastReq = now();
    try { return await fn(); } finally { lastReq = Math.max(lastReq, now()); }
  }
  async function holding(ticker, side) {
    const p = (await call(() => exchange.positions(ticker))).find((x) => x.ticker === ticker && x.side === side);
    return Math.max(0, Math.floor(p?.count ?? 0));
  }
  // A failure: logged, counted (3 in a row pause it for 15 minutes); a refused key or a bad request stops it
  function fail(err, label) {
    const kind = classify(err);
    const detail = `${err?.status ?? '?'}${err?.code ? ` ${err.code}` : ''}: ${err?.message || 'no answer'}`;
    if (kind !== 'busy') st.errors++;
    note('error', `${label}: ${detail}`, { err: kind });
    if (kind === 'key') st.stopped = 'Kalshi refused the key for trading. Make a key with trading permission.';
    if (kind === 'bad') st.stopped = `Kalshi refused a request (${detail}). Stopped so nothing else goes wrong.`;
    if (st.errors >= 3) { st.pausedUntil = now() + 15 * 60000; st.errors = 0; note('pause', 'Three errors in a row: paused for 15 minutes'); }
    save();
    return { kind, detail };
  }

  function today() {
    const k = dayKey(now());
    const bought = st.ledger.filter((e) => dayKey(e.at) === k);
    const realized = st.ledger.reduce((a, e) => a + (e.closed ? (dayKey(e.closedAt) === k ? e.pnl : 0) : (e.realizedPart || 0)), 0);
    const open = st.ledger.filter((e) => !e.closed).reduce((a, e) => a + e.cost, 0);
    return { buys: bought.length, realized: r2(realized), open: r2(open), worst: r2(realized - open) };
  }

  function record({ ticker, side, count, price, fees, closeTime, conf }) {
    st.ledger.push({ ticker, side, count, price, fees, cost: r2(count * price + fees), at: now(), closeTime, conf, closed: false, realizedPart: 0 });
    if (st.ledger.length > 2000) st.ledger.splice(0, st.ledger.length - 2000);
    (st.calls[`${ticker}:${side}`] ||= { tries: 1 }).done = true;
  }
  function close(e, how, exit, proceeds) {
    e.closed = true; e.how = how; e.exit = exit; e.pnl = r2((e.realizedPart || 0) + proceeds - e.cost); e.closedAt = now();
  }
  // part of a position went (a partial sell, or a sell whose answer got lost): book it and keep the rest open
  function closePart(e, sold, price, fees) {
    const soldCost = e.cost * (sold / e.count);
    e.realizedPart = r2((e.realizedPart || 0) + sold * price - fees - soldCost);
    e.cost = r2(e.cost - soldCost); e.count -= sold;
  }

  // Close ledger entries for settled markets (resolve gives 'yes' | 'no' | null)
  function settle(resolve) {
    for (const e of st.ledger) {
      if (e.closed || !(Date.parse(e.closeTime) < now())) continue;
      const res = resolve(e.ticker);
      if (res !== 'yes' && res !== 'no') continue;
      const won = e.side.toLowerCase() === res;
      exchange.settle?.(e.ticker, res);
      close(e, 'settled', won ? 1 : 0, won ? e.count : 0);
      note(won ? 'win' : 'loss', `${word(e.side)} ${e.count} settled ${won ? 'WON' : 'lost'}: ${money(e.pnl)}`);
    }
  }

  // An order whose answer never came back (timeout, app closed mid-order): read the position to see what it did
  async function reconcile() {
    const p = st.pending;
    const after = await holding(p.ticker, p.side);
    st.pending = null;
    if (p.kind === 'sell') {
      const e = st.ledger.find((x) => !x.closed && x.ticker === p.ticker && x.side === p.side);
      const sold = e ? Math.max(0, e.count - after) : 0;
      if (sold >= e?.count) close(e, p.how, p.floor, sold * p.floor - feeFor(sold, p.floor));
      else if (sold > 0) closePart(e, sold, p.floor, feeFor(sold, p.floor));
      note('info', `Checked with Kalshi: the ${word(p.side)} sell ${sold > 0 ? `went through (${sold} contracts)` : "didn't go through"}`);
      save();
      return;
    }
    const got = Math.max(0, Math.min(p.count, after - p.before));
    if (got > 0) {
      record({ ...p, count: got, price: p.limit, fees: feeFor(got, p.limit) });
      note('fill', `Checked with Kalshi: the ${word(p.side)} buy went through (${got} contracts)`);
    } else note('info', `Checked with Kalshi: the ${word(p.side)} buy didn't go through`);
    save();
  }

  // One look at the market. live: snapshot row of the open market; sig: buySignal(); checks: positionCheck() by ticker
  async function step({ live, sig, checks = {}, resolve = () => null }) {
    const s = S();
    if (s.mode === 'off') return { why: 'Off' };
    if (busy) return { why: 'Working…' };
    settle(resolve);
    if (st.stopped) return { why: `Stopped: ${st.stopped}` };
    if (st.pausedUntil > now()) return { why: `Paused after errors until ${new Date(st.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` };
    busy = true;
    try {
      if (st.pending) await reconcile();
      // 1) sells: any open position whose sell signal is confirmed
      for (const e of st.ledger.filter((x) => !x.closed && Date.parse(x.closeTime) > now())) {
        const c = checks[e.ticker];
        if (c?.ex?.action !== 'SELL' || !(c.bid > 0)) continue;
        return await sell(e, c, s);
      }
      // 2) buys: the bot's locked call on this round
      return await buy({ live, sig, s });
    } catch (err) {
      const f = fail(err, 'Reading from Kalshi');
      return { why: `Couldn't read from Kalshi (${f.detail}): will try again` };
    } finally { busy = false; }
  }

  async function sell(e, c, s) {
    const have = await holding(e.ticker, e.side);
    if (have < 1) { // already gone (sold by hand, or a sell whose answer got lost)
      close(e, 'gone', c.bid, e.count * c.bid - feeFor(e.count, c.bid)); save();
      note('info', `${word(e.side)} position is already closed on Kalshi`);
      return { why: 'Position already closed on the exchange' };
    }
    if (have < e.count) closePart(e, e.count - have, c.bid, feeFor(e.count - have, c.bid));
    const n = Math.min(have, e.count);
    const floor = Math.max(0.01, Math.round((c.bid - s.slipCents / 100) * 100) / 100);
    const kind = c.ex.kind === 'take' ? 'SELL HIGH' : 'BAIL';
    st.pending = { kind: 'sell', ticker: e.ticker, side: e.side, floor, how: kind === 'SELL HIGH' ? 'sold high' : 'bailed' };
    save();
    const r = await send(sellOrder({ ticker: e.ticker, side: e.side, count: n, floor }), `${kind} ${word(e.side)} ${n} at ${Math.round(floor * 100)}¢ or better`);
    if (r.unsure) { await reconcile(); return { why: 'Checked the sell with Kalshi' }; }
    st.pending = null; save();
    if (r.filled > 0) {
      const got = Math.min(r.filled, e.count);
      const price = r.avgPrice ?? floor, fees = r.fees ?? feeFor(got, price);
      if (got >= e.count) close(e, kind === 'SELL HIGH' ? 'sold high' : 'bailed', price, got * price - fees);
      else closePart(e, got, price, fees);
      save();
      return { did: 'sell', filled: got };
    }
    return { why: r.why || 'Sell didn\'t fill: trying again' };
  }

  async function buy({ live, sig, s }) {
    if (!live || !sig?.callSide) return { why: 'Waiting for a call' };
    const ticker = live.m.ticker, side = sig.callSide;
    const rec = (st.calls[`${ticker}:${side}`] ||= { tries: 0, done: false });
    if (rec.done) return { why: `Bought this call: holding ${word(side)}` };
    if (st.ledger.some((e) => !e.closed && e.ticker === ticker)) return { why: 'Already holding this market' };
    if (rec.tries >= s.tries) return { why: `Gave up on this call after ${s.tries} tries` };
    if (!(live.ev.minutesLeft > 1)) return { why: 'Too close to the close to buy' };
    if (!(sig.limit > 0 && sig.limit < 1)) return { why: 'No max price on this call' };
    const t = today();
    if (t.buys >= s.maxTrades) return { why: `Done for today: ${s.maxTrades} buys` };
    if (-t.worst >= s.dailyLoss) return { why: `Done for today: the $${s.dailyLoss} loss stop` };
    // fresh numbers, right before the order
    const { balance, held = 0 } = await call(() => exchange.cash());
    const book = await call(() => exchange.book(ticker));
    if (!book) return { why: 'No order book right now: waiting' };
    const d = buyDepth(book, side, sig.limit);
    if (d.best == null) return { why: 'Nobody is selling right now' };
    if (d.best > sig.limit + 1e-9) return { why: `Price ${Math.round(d.best * 100)}¢ is over the ${Math.round(sig.limit * 100)}¢ max: waiting` };
    const room = Math.min(s.dailyLoss + t.worst, s.maxOpen - t.open);
    const n = sizeBuy({ want: Math.max(1, sig.contracts || 1), price: sig.limit, cash: balance, held, perTrade: s.perTrade, room, depth: d.count, shrink: rec.shrink ?? 1, levels: d.levels });
    if (n < 1) {
      const one = costFor(1, sig.limit);
      return { why: balance - held - CUSHION < one ? `Not enough cash: $${Math.max(0, balance - held).toFixed(2)} free, one contract costs $${one.toFixed(2)}` : `Limits leave no room for one contract ($${one.toFixed(2)})` };
    }
    const before = await holding(ticker, side);
    const order = buyOrder({ ticker, side, count: n, limit: sig.limit });
    rec.tries++;
    st.pending = { ticker, side, count: n, before, limit: sig.limit, closeTime: live.m.close_time, conf: sig.deep?.score ?? null };
    save(); // saved before sending: if the app dies mid-order, the next start checks what happened
    const r = await send(order, `BUY ${word(side)} ${n} at up to ${Math.round(sig.limit * 100)}¢ ($${costFor(n, sig.limit).toFixed(2)} max)`, { cash: balance, held });
    if (r.unsure) { await reconcile(); return { why: 'Checked the order with Kalshi' }; }
    st.pending = null;
    if (r.kind === 'cash') rec.shrink = (rec.shrink ?? 1) * 0.5;
    if (r.filled > 0) {
      const got = Math.min(r.filled, n), price = r.avgPrice ?? sig.limit;
      record({ ticker, side, count: got, price, fees: r.fees ?? feeFor(got, price), closeTime: live.m.close_time, conf: sig.deep?.score ?? null });
      save();
      return { did: 'buy', filled: got };
    }
    save();
    return { why: r.why || 'Order didn\'t fill' };
  }

  // Send one order; handle every outcome. Returns { filled, avgPrice, fees } or { why, kind, unsure }.
  // unsure: it may have gone through (a timeout, or Kalshi says the order id already exists), so check the position.
  async function send(order, label, ctx = {}) {
    let unsure = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await call(() => exchange.place(order));
        st.errors = 0;
        const filled = Math.max(0, Math.floor(r?.filled ?? 0));
        note(filled > 0 ? 'fill' : 'nofill', `${label}: ${filled > 0 ? `filled ${filled}${r.avgPrice != null ? ` at ${Math.round(r.avgPrice * 100)}¢` : ''}` : 'no fill (price moved)'}`, { order: { side: order.side, count: order.count, price: order.price } });
        return { ...r, filled };
      } catch (err) {
        const kind = classify(err);
        if (kind === 'dup') { note('info', `${label}: Kalshi already has this order: checking what it did`); return { unsure: true }; }
        if (kind === 'unknown') unsure = true;
        if ((kind === 'busy' || kind === 'unknown') && attempt < 2) { await sleep(kind === 'busy' ? 2000 * (attempt + 1) : 1000); continue; } // same client_order_id: can't double up
        const f = fail(err, kind === 'cash' ? `${label} (cash read $${(ctx.cash ?? 0).toFixed(2)}, held $${(ctx.held ?? 0).toFixed(2)}: trying smaller)` : label);
        return { why: `Order failed: ${f.detail}`, kind, unsure };
      }
    }
  }

  return {
    step, today, state: () => st,
    resume() { st.stopped = null; st.pausedUntil = 0; st.errors = 0; save(); },
    reset() { Object.assign(st, { ledger: [], log: [], calls: {}, stopped: null, pausedUntil: 0, errors: 0, pending: null }); save(); },
    stats() {
      const closed = st.ledger.filter((e) => e.closed);
      return { trades: st.ledger.length, closed: closed.length, wins: closed.filter((e) => e.pnl > 0).length, pnl: r2(closed.reduce((a, e) => a + e.pnl, 0)),
        open: st.ledger.filter((e) => !e.closed).length, errors: st.log.filter((x) => x.kind === 'error').length };
    },
  };
}

// ---------- the Test exchange: simulates Kalshi on live prices; nothing is sent ----------
// getBook(ticker) gives the real live order book (or null); fills are the same IOC walk Kalshi does, at the prices
// on the book, with Kalshi's fee. Cash starts at testCash and moves with every fill and settlement.
export function createTestExchange({ getBook, startCash = 100, store = null }) {
  const st = store?.load() || { cash: startCash, pos: {} };
  const save = () => store?.save(st);
  return {
    async cash() { return { balance: r2(st.cash), held: 0 }; },
    async book(ticker) { return getBook(ticker); },
    async positions() { return Object.entries(st.pos).filter(([, p]) => p.count > 0).map(([ticker, p]) => ({ ticker, side: p.side, count: p.count })); },
    async place(o) {
      const book = await getBook(o.ticker);
      if (!book) throw { status: 503, message: 'no live book (test)' };
      const count = Number(o.count), price = Number(o.price);
      const buying = !o.reduce_only, side = o.side === 'bid' ? (buying ? 'YES' : 'NO') : (buying ? 'NO' : 'YES');
      const limit = buying ? (side === 'YES' ? price : 1 - price) : (side === 'YES' ? price : 1 - price);
      let filled = 0, spend = 0;
      if (buying) {
        if (count * limit + feeFor(count, limit) > st.cash + 1e-9) throw { status: 400, code: 'insufficient_balance', message: 'insufficient balance (test)' };
        const asks = (side === 'YES' ? book.no : book.yes).map(([p, q]) => [r2(1 - p), q]).sort((a, b) => a[0] - b[0]);
        let fees = 0;
        for (const [p, q] of asks) { if (p > limit + 1e-9 || filled >= count) break; const k = Math.min(q, count - filled); filled += k; spend += k * p; fees += feeFor(k, p); }
        if (!filled) return { filled: 0 };
        const avg = spend / filled, cost = r2(spend + fees);
        if (cost > st.cash + 1e-9) throw { status: 400, code: 'insufficient_balance', message: 'insufficient balance (test)' };
        st.cash = r2(st.cash - cost);
        const p = (st.pos[o.ticker] ||= { side, count: 0 });
        p.side = side; p.count += filled; save();
        return { filled, avgPrice: avg, fees: r2(fees) };
      }
      const p = st.pos[o.ticker];
      if (!p || p.side !== side || p.count < 1) throw { status: 400, code: 'reduce_only', message: 'nothing to sell (test)' };
      const bids = (side === 'YES' ? book.yes : book.no).slice().sort((a, b) => b[0] - a[0]);
      const want = Math.min(count, p.count);
      let fees = 0;
      for (const [bp, q] of bids) { if (bp < limit - 1e-9 || filled >= want) break; const k = Math.min(q, want - filled); filled += k; spend += k * bp; fees += feeFor(k, bp); }
      if (!filled) return { filled: 0 };
      st.cash = r2(st.cash + spend - fees); p.count -= filled; save();
      return { filled, avgPrice: spend / filled, fees: r2(fees) };
    },
    // Kalshi pays $1 a contract on the winning side at settlement
    settle(ticker, result) {
      const p = st.pos[ticker];
      if (!p || !(p.count > 0)) return;
      if (p.side.toLowerCase() === result) st.cash = r2(st.cash + p.count);
      p.count = 0; save();
    },
    balance: () => r2(st.cash),
    reset(cash) { st.cash = cash; st.pos = {}; save(); },
  };
}
