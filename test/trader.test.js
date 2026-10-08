import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADER_DEFAULTS, feeFor, costFor, sizeBuy, parseBook, buyDepth, sellDepth, classify, buyOrder, sellOrder, createTrader, createTestExchange } from '../public/trader.js';

// ---------- pieces ----------
test('fee and cost: Kalshi rounds the fee up to the cent', () => {
  assert.equal(feeFor(1, 0.5), 0.02);   // 0.0175 -> 2¢
  assert.equal(feeFor(10, 0.5), 0.18);  // 0.175 -> 18¢
  assert.equal(feeFor(100, 0.9), 0.63);
  assert.equal(feeFor(0, 0.5), 0);
  assert.equal(costFor(10, 0.5), 5.18);
});

test('sizing fits the fee, the cushion, holds and every limit', () => {
  // $10 per trade at 50¢: 19 contracts = 9.50 + 0.17 fee; 20 would be 10.18
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 1000, perTrade: 10, room: 1000 }), 19);
  // cash 5.25 minus 5¢ cushion = 5.20: 10 contracts cost 5.18
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 5.25, perTrade: 100, room: 100 }), 10);
  // an open order holding $2 leaves 3.20
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 5.25, held: 2, perTrade: 100, room: 100 }), 6);
  assert.equal(sizeBuy({ want: 3, price: 0.5, cash: 100, perTrade: 100, room: 100 }), 3, 'never more than wanted');
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 100, perTrade: 100, room: 100, depth: 7 }), 7, 'never more than the book has');
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 100, perTrade: 100, room: 2.1 }), 4, 'room left under the loss stop / open cap');
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 0.5, perTrade: 100, room: 100 }), 0, "can't afford one: zero, no order");
  assert.equal(sizeBuy({ want: 100, price: 0.5, cash: 5.25, perTrade: 100, room: 100, levels: 4 }), 9, 'a cent per extra price level');
  for (let i = 0; i < 5000; i++) { // never over budget, whatever the numbers
    const price = Math.round((0.02 + Math.random() * 0.96) * 100) / 100, cash = Math.random() * 50, held = Math.random() * 5, levels = 1 + Math.floor(Math.random() * 6);
    const perTrade = 1 + Math.random() * 30, room = Math.random() * 40;
    const n = sizeBuy({ want: 500, price, cash, held, perTrade, room, levels });
    if (n > 0) {
      assert.ok(costFor(n, price) + (levels - 1) * 0.01 <= cash - held - 0.05 + 1e-9);
      assert.ok(costFor(n, price) <= Math.min(perTrade, room) + 1e-9);
    }
  }
});

test('order bodies are Kalshi V2 fill-or-cancel orders on the YES book', () => {
  const b = buyOrder({ ticker: 'KXBTC15M-X', side: 'YES', count: 3, limit: 0.62, id: 'a' });
  assert.deepEqual(b, { ticker: 'KXBTC15M-X', client_order_id: 'a', side: 'bid', count: '3.00', price: '0.6200', time_in_force: 'immediate_or_cancel', reduce_only: false, self_trade_prevention_type: 'taker_at_cross' });
  assert.equal(buyOrder({ ticker: 'T', side: 'NO', count: 2, limit: 0.3 }).side, 'ask');
  assert.equal(buyOrder({ ticker: 'T', side: 'NO', count: 2, limit: 0.3 }).price, '0.7000');
  const s = sellOrder({ ticker: 'T', side: 'NO', count: 2, floor: 0.4 });
  assert.equal(s.side, 'bid'); assert.equal(s.price, '0.6000'); assert.equal(s.reduce_only, true);
  assert.equal(sellOrder({ ticker: 'T', side: 'YES', count: 2, floor: 0.4 }).side, 'ask');
  assert.notEqual(buyOrder({ ticker: 'T', side: 'YES', count: 1, limit: 0.5 }).client_order_id, buyOrder({ ticker: 'T', side: 'YES', count: 1, limit: 0.5 }).client_order_id);
});

test('order book: cents or dollars; what you can buy and sell', () => {
  const a = parseBook({ orderbook: { yes: [[40, 10], [42, 5]], no: [[55, 7], [57, 3]] } });
  const b = parseBook({ orderbook_fp: { yes_dollars: [['0.4000', '10.00'], ['0.4200', '5.00']], no_dollars: [['0.5500', '7.00'], ['0.5700', '3.00']] } });
  assert.deepEqual(a, b);
  assert.deepEqual(buyDepth(a, 'YES', 0.44), { best: 0.43, count: 3, levels: 1 });
  assert.deepEqual(buyDepth(a, 'YES', 0.45), { best: 0.43, count: 10, levels: 2 });
  assert.deepEqual(buyDepth(a, 'NO', 0.6), { best: 0.58, count: 15, levels: 2 });
  assert.deepEqual(sellDepth(a, 'YES', 0.41), { best: 0.42, count: 5 });
  assert.deepEqual(parseBook(null), { yes: [], no: [] });
});

test('errors are sorted into what to do', () => {
  assert.equal(classify({ status: 400, code: 'insufficient_balance', message: 'Insufficient balance' }), 'cash');
  assert.equal(classify({ status: 429, message: 'Too many requests' }), 'busy');
  assert.equal(classify({ status: 403, message: 'forbidden' }), 'key');
  assert.equal(classify({ status: 409, code: 'order_already_exists' }), 'dup');
  assert.equal(classify({ status: 503 }), 'unknown');
  assert.equal(classify({ message: 'timeout' }), 'unknown');
  assert.equal(classify({ status: 400, code: 'invalid_parameters' }), 'bad');
});

// ---------- a strict fake Kalshi ----------
// Wire-level checks on every order (anything off is a 400), the collateral check with Kalshi's per-fill fee
// (insufficient_balance), fill-now matching against a real book, reduce-only, duplicate client order ids (409), and a
// rate limit (429). `chaos` adds what the real one does on a bad day: 503s, and timeouts where the order went
// through but the answer never came back.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const KEYS = ['ticker', 'client_order_id', 'side', 'count', 'price', 'time_in_force', 'reduce_only', 'self_trade_prevention_type'].sort();

function strictKalshi({ cash, clock, rand, chaos = 0, minGapMs = 300 }) {
  const k = { cash, held: 0, pos: {}, books: {}, ids: new Map(), violations: [], orders: [], lastReq: -Infinity, injected: 0 };
  const err = (status, code, message) => { throw { status, code, message }; };
  function gate(what) {
    const t = clock();
    if (t - k.lastReq < minGapMs) { k.violations.push(`429 ${what}`); err(429, 'too_many_requests', 'Too many requests'); }
    k.lastReq = t;
    if (rand() < chaos) { k.injected++; err(503, 'service_unavailable', 'Service unavailable'); }
  }
  const bad = (msg) => { k.violations.push(`400 ${msg}`); err(400, 'invalid_parameters', msg); };
  const pos = (t) => (k.pos[t] ||= 0); // + YES contracts, - NO contracts
  k.api = {
    async cash() { gate('cash'); return { balance: Math.round(k.cash * 100) / 100, held: k.held }; },
    async book(t) { gate('book'); const b = k.books[t]; return b ? { yes: b.yes.map((x) => [...x]), no: b.no.map((x) => [...x]) } : null; },
    async positions() {
      gate('positions');
      return Object.entries(k.pos).filter(([, n]) => n !== 0).map(([ticker, n]) => ({ ticker, side: n > 0 ? 'YES' : 'NO', count: Math.abs(n) }));
    },
    async place(o) {
      gate('place');
      if (JSON.stringify(Object.keys(o).sort()) !== JSON.stringify(KEYS)) bad(`fields ${Object.keys(o)}`);
      if (typeof o.ticker !== 'string' || !k.books[o.ticker]) bad(`ticker ${o.ticker}`);
      if (typeof o.client_order_id !== 'string' || o.client_order_id.length < 8) bad('client_order_id');
      if (o.side !== 'bid' && o.side !== 'ask') bad(`side ${o.side}`);
      if (!/^\d{1,4}\.00$/.test(o.count) || Number(o.count) < 1) bad(`count ${o.count}`);
      if (!/^0\.\d{4}$/.test(o.price) || Number(o.price) < 0.01 || Number(o.price) > 0.99 || Math.round(Number(o.price) * 10000) % 100) bad(`price ${o.price}`);
      if (o.time_in_force !== 'immediate_or_cancel' || o.self_trade_prevention_type !== 'taker_at_cross' || typeof o.reduce_only !== 'boolean') bad('flags');
      const prev = k.ids.get(o.client_order_id);
      if (prev) { if (prev !== JSON.stringify(o)) k.violations.push('reused id for a different order'); err(409, 'order_already_exists', 'Order with this client_order_id already exists'); }
      k.ids.set(o.client_order_id, JSON.stringify(o));
      const count = Number(o.count), price = Number(o.price), p = pos(o.ticker), book = k.books[o.ticker];
      // reduce-only: the order may only shrink the position
      if (o.reduce_only && (o.side === 'ask' ? p < count : -p < count)) { k.violations.push('oversell'); err(400, 'reduce_only_violation', 'Reduce-only order would increase position'); }
      if (!o.reduce_only && (o.side === 'bid' ? p < 0 : p > 0)) k.violations.push('bought against an open position');
      // matching: a bid takes NO bids (YES asks at 1 - p); an ask takes YES bids
      const levels = o.side === 'bid'
        ? book.no.map((l) => ({ l, px: Math.round((1 - l[0]) * 100) / 100, ok: (x) => x <= price + 1e-9 })).sort((a, b) => a.px - b.px)
        : book.yes.map((l) => ({ l, px: l[0], ok: (x) => x >= price - 1e-9 })).sort((a, b) => b.px - a.px);
      // collateral: worst case at the limit for buys; what each fill actually costs, fee per fill, must fit too
      const unit = (x) => (o.side === 'bid' ? x : 1 - x); // what a contract costs the buyer of this side
      if (!o.reduce_only) {
        const worst = count * unit(price) + feeFor(count, unit(price));
        if (worst > k.cash - k.held + 1e-9) { k.violations.push(`insufficient_balance worst ${worst.toFixed(2)} > ${(k.cash - k.held).toFixed(2)}`); err(400, 'insufficient_balance', 'Insufficient balance'); }
      }
      let filled = 0, money = 0, fees = 0; const fills = [];
      for (const v of levels) {
        if (filled >= count || !v.ok(v.px)) break;
        const n = Math.min(v.l[1], count - filled);
        fills.push([v, n]); filled += n;
        const unitPx = o.reduce_only ? (o.side === 'ask' ? v.px : 1 - v.px) : unit(v.px);
        money += n * unitPx; fees += feeFor(n, unitPx);
      }
      if (!o.reduce_only && money + fees > k.cash - k.held + 1e-9) { k.violations.push('insufficient_balance on fills'); err(400, 'insufficient_balance', 'Insufficient balance'); }
      for (const [v, n] of fills) v.l[1] -= n;
      book.yes = book.yes.filter((l) => l[1] > 0); book.no = book.no.filter((l) => l[1] > 0);
      if (o.reduce_only) k.cash += money - fees; else k.cash -= money + fees;
      k.pos[o.ticker] = p + (o.side === 'bid' ? filled : -filled);
      if (k.cash < -1e-9) k.violations.push('negative cash');
      k.orders.push({ ...o, filled, cost: money + fees });
      if (rand() < chaos) { k.injected++; err(0, null, 'network timeout'); } // it went through; the answer got lost
      return { filled, avgPrice: filled ? money / filled : null, fees: Math.round(fees * 100) / 100 };
    },
  };
  k.settle = (t, res) => { const p = pos(t); if ((p > 0 && res === 'yes') || (p < 0 && res === 'no')) k.cash += Math.abs(p); k.pos[t] = 0; };
  return k;
}

function makeBook(rand, fair) {
  const yes = [], no = [];
  const yb = Math.max(0.01, Math.round((fair - 0.01 - rand() * 0.03) * 100) / 100), nb = Math.max(0.01, Math.round((1 - fair - 0.01 - rand() * 0.03) * 100) / 100);
  for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) { const p = Math.round((yb - i * 0.01) * 100) / 100; if (p > 0) yes.push([p, 1 + Math.floor(rand() * 40)]); }
  for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) { const p = Math.round((nb - i * 0.01) * 100) / 100; if (p > 0) no.push([p, 1 + Math.floor(rand() * 40)]); }
  return { yes, no };
}

// Runs the trader against the strict fake for `rounds` 15-minute rounds, a look every few seconds, with calls, sell
// signals and settlements, checking the invariants after every single step.
async function simulate({ seed, rounds, chaos = 0, cash = 60, settings = {} }) {
  const rand = rng(seed);
  let t = Date.UTC(2026, 0, 5, 14);
  const clock = () => t;
  const k = strictKalshi({ cash, clock, rand, chaos });
  const S = { ...TRADER_DEFAULTS, mode: 'demo', ...settings };
  const saved = { v: null };
  const store = { load: () => (saved.v ? JSON.parse(saved.v) : null), save: (x) => { saved.v = JSON.stringify(x); } };
  let trader = createTrader({ exchange: { ...k.api, settle: k.settle }, settings: () => S, store, now: clock, sleep: async (ms) => { t += ms; } });
  const results = {}, perRound = {}, maxOrderCost = [], allErrs = [];
  for (let r = 0; r < rounds; r++) {
    const ticker = `KXBTC15M-R${r}`, open = t, close = t + 15 * 60000;
    let fair = 0.2 + rand() * 0.6;
    const callAt = open + rand() * 12 * 60000, side = rand() < 0.5 ? 'YES' : 'NO';
    let callOn = rand() < 0.8;
    while (t < close + 20000) {
      if (rand() < 0.15) fair = Math.min(0.97, Math.max(0.03, fair + (rand() - 0.5) * 0.2));
      if (t < close) k.books[ticker] = makeBook(rand, fair);
      const quote = { yesAsk: Math.round((1 - (k.books[ticker].no[0]?.[0] ?? 0.01)) * 100) / 100, noAsk: Math.round((1 - (k.books[ticker].yes[0]?.[0] ?? 0.01)) * 100) / 100 };
      const ask = side === 'YES' ? quote.yesAsk : quote.noAsk;
      const sig = callOn && t >= callAt && t < close ? { callSide: side, limit: Math.min(0.99, Math.round((ask + (rand() - 0.3) * 0.06) * 100) / 100), contracts: 1 + Math.floor(rand() * 60), deep: { score: 88 } } : null;
      const live = t < close ? { m: { ticker, close_time: new Date(close).toISOString() }, ev: { minutesLeft: (close - t) / 60000, quote } } : null;
      const bid = side === 'YES' ? k.books[ticker].yes[0]?.[0] : k.books[ticker].no[0]?.[0];
      const checks = rand() < 0.04 && bid ? { [ticker]: { bid, ex: { action: 'SELL', kind: rand() < 0.5 ? 'take' : 'cut' } } } : {};
      const before = k.orders.length;
      const seenLog = new Set(trader.state().log);
      await trader.step({ live, sig, checks, resolve: (tk) => results[tk] ?? null });
      for (const x of trader.state().log) if (!seenLog.has(x) && (x.kind === 'error' || x.kind === 'pause')) allErrs.push(x);
      for (const o of k.orders.slice(before)) {
        if (!o.reduce_only) {
          const lim = o.side === 'bid' ? Number(o.price) : 1 - Number(o.price);
          maxOrderCost.push(costFor(Number(o.count), lim));
          assert.ok(costFor(Number(o.count), lim) <= S.perTrade + 1e-9, `order over the per-trade limit: ${JSON.stringify(o)}`);
          if (o.filled > 0) perRound[o.ticker] = (perRound[o.ticker] || 0) + 1;
        }
      }
      // invariants, every step
      assert.deepEqual(k.violations, [], `seed ${seed}: Kalshi would have refused`);
      for (const [tk, n] of Object.entries(perRound)) assert.ok(n <= 1, `seed ${seed}: bought ${tk} twice`);
      const st = trader.state();
      assert.equal(st.stopped, null, `seed ${seed}: stopped: ${st.stopped}`);
      if (!st.pending) for (const e of st.ledger.filter((x) => !x.closed && Date.parse(x.closeTime) > t)) {
        const p = k.pos[e.ticker] || 0;
        assert.equal(e.side === 'YES' ? p : -p, e.count, `seed ${seed}: ledger and Kalshi disagree on ${e.ticker}`);
      }
      assert.ok(trader.today().open <= S.maxOpen + 1e-9, 'open cap');
      assert.ok(trader.today().buys <= S.maxTrades, 'trades per day');
      if (rand() < 0.001) trader = createTrader({ exchange: { ...k.api, settle: k.settle }, settings: () => S, store, now: clock, sleep: async (ms) => { t += ms; } }); // the app restarts
      t += 3000 + Math.floor(rand() * 5000);
    }
    results[ticker] = rand() < fair ? 'yes' : 'no';
    callOn = false;
  }
  await trader.step({ live: null, sig: null, resolve: (tk) => results[tk] ?? null });
  const errs = allErrs.filter((x) => x.kind === 'error');
  return { trader, k, errs, maxOrderCost };
}

test('stress: 2,000 rounds on a strict Kalshi, calm day: zero refusals, zero errors, no double buys', async () => {
  for (const seed of [1, 2, 3, 4]) {
    const { trader, k, errs } = await simulate({ seed, rounds: 500 });
    assert.deepEqual(errs, [], `seed ${seed}`);
    assert.ok(k.orders.length > 100, `seed ${seed}: it traded (${k.orders.length} orders)`);
    assert.ok(trader.stats().trades > 50);
  }
});

test('stress: little cash, big limits: sizes down instead of insufficient balance', async () => {
  for (const seed of [11, 12, 13]) {
    const { errs, k } = await simulate({ seed, rounds: 400, cash: 3, settings: { perTrade: 50, maxOpen: 500, dailyLoss: 500, maxTrades: 500 } });
    assert.deepEqual(errs, []);
    assert.deepEqual(k.violations, []);
  }
});

test('stress: bad day (5% of requests fail or time out after going through): never buys twice, books lost fills', async () => {
  for (const seed of [21, 22, 23, 24]) {
    const { errs, k, trader } = await simulate({ seed, rounds: 500, chaos: 0.05 });
    assert.ok(k.injected > 50, 'chaos happened');
    assert.ok(errs.length > 0, 'the hiccups were logged');
    assert.ok(errs.every((e) => e.err === 'unknown'), `only Kalshi's own hiccups: ${JSON.stringify(errs.filter((e) => e.err !== 'unknown').slice(0, 3))}`);
    assert.equal(trader.state().stopped, null);
  }
});

test('limits: per trade, open cap, daily trades and the daily loss stop', async () => {
  const { trader, maxOrderCost } = await simulate({ seed: 31, rounds: 300, cash: 1000, settings: { perTrade: 4, maxOpen: 6, maxTrades: 3, dailyLoss: 5 } });
  assert.ok(Math.max(...maxOrderCost) <= 4);
  const byDay = {};
  for (const e of trader.state().ledger) byDay[new Date(e.at).toDateString()] = (byDay[new Date(e.at).toDateString()] || 0) + 1;
  assert.ok(Object.values(byDay).every((n) => n <= 3), JSON.stringify(byDay));
  // losses in a day never pass the stop: each buy fit inside what was left of it
  const lossByDay = {};
  for (const e of trader.state().ledger.filter((x) => x.closed)) lossByDay[new Date(e.closedAt).toDateString()] = (lossByDay[new Date(e.closedAt).toDateString()] || 0) + e.pnl;
  assert.ok(Object.values(lossByDay).every((x) => x >= -5 - 1e-9), JSON.stringify(lossByDay));
});

test('a timeout after the order went through: checks Kalshi, books the fill, never buys again', async () => {
  let t = 0; const clock = () => t;
  const k = strictKalshi({ cash: 50, clock, rand: () => 0.5 });
  k.books.T = { yes: [[0.4, 50]], no: [[0.45, 50]] };
  const place = k.api.place;
  let lose = true;
  k.api.place = async (o) => { const r = await place(o); if (lose) { lose = false; throw { message: 'network timeout' }; } return r; };
  const tr = createTrader({ exchange: k.api, settings: () => ({ mode: 'demo' }), now: clock, sleep: async (ms) => { t += ms; } });
  const live = { m: { ticker: 'T', close_time: new Date(15 * 60000).toISOString() }, ev: { minutesLeft: 10, quote: { yesAsk: 0.55 } } };
  const sig = { callSide: 'YES', limit: 0.56, contracts: 10 };
  const r = await tr.step({ live, sig });
  // the retry with the same id gets a 409; it reads the position back
  assert.equal(r.why, 'Checked the order with Kalshi');
  assert.equal(k.orders.length, 1);
  assert.equal(tr.state().ledger.length, 1);
  assert.equal(tr.state().ledger[0].count, k.pos.T);
  t += 5000;
  assert.match((await tr.step({ live, sig })).why, /Bought this call/);
  assert.equal(k.orders.length, 1);
  assert.deepEqual(k.violations, []);
});

test('the app closes mid-order: the next start reads back what happened first', async () => {
  let t = 0; const clock = () => t;
  const k = strictKalshi({ cash: 50, clock, rand: () => 0.5 });
  k.books.T = { yes: [[0.4, 50]], no: [[0.45, 50]] };
  const saved = { v: null }, store = { load: () => (saved.v ? JSON.parse(saved.v) : null), save: (x) => { saved.v = JSON.stringify(x); } };
  const place = k.api.place;
  k.api.place = async (o) => { await place(o); return new Promise(() => {}); }; // went through, the app died waiting
  const live = { m: { ticker: 'T', close_time: new Date(15 * 60000).toISOString() }, ev: { minutesLeft: 10, quote: { yesAsk: 0.55 } } };
  const sig = { callSide: 'YES', limit: 0.56, contracts: 10 };
  createTrader({ exchange: k.api, settings: () => ({ mode: 'demo' }), store, now: clock, sleep: async (ms) => { t += ms; } }).step({ live, sig });
  await new Promise((r) => setTimeout(r, 10));
  k.api.place = place; t += 5000;
  const tr = createTrader({ exchange: k.api, settings: () => ({ mode: 'demo' }), store, now: clock, sleep: async (ms) => { t += ms; } });
  assert.match((await tr.step({ live, sig })).why, /Bought this call/);
  assert.equal(k.orders.length, 1);
  assert.equal(tr.state().ledger[0].count, 10);
});

test('a refused key stops it; three Kalshi errors in a row pause it', async () => {
  let t = 0; const clock = () => t;
  const live = { m: { ticker: 'T', close_time: new Date(15 * 60000).toISOString() }, ev: { minutesLeft: 10, quote: { yesAsk: 0.55 } } };
  const sig = { callSide: 'YES', limit: 0.56, contracts: 10 };
  const ok = { cash: async () => ({ balance: 50, held: 0 }), book: async () => ({ yes: [[0.4, 50]], no: [[0.45, 50]] }), positions: async () => [] };
  const tr = createTrader({ exchange: { ...ok, place: async () => { throw { status: 403, message: 'Forbidden' }; } }, settings: () => ({ mode: 'demo' }), now: clock, sleep: async (ms) => { t += ms; } });
  await tr.step({ live, sig });
  assert.match(tr.state().stopped, /refused the key/);
  assert.match((await tr.step({ live, sig })).why, /^Stopped/);
  tr.resume(); assert.equal(tr.state().stopped, null);

  const tr2 = createTrader({ exchange: { ...ok, cash: async () => { throw { status: 502 }; }, place: async () => ({ filled: 0 }) }, settings: () => ({ mode: 'demo' }), now: clock, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 3; i++) await tr2.step({ live, sig });
  assert.match((await tr2.step({ live, sig })).why, /^Paused/);
});

test('off does nothing at all', async () => {
  const tr = createTrader({ exchange: {}, settings: () => ({ mode: 'off' }) });
  assert.deepEqual(await tr.step({ live: {}, sig: { callSide: 'YES' } }), { why: 'Off' });
});

test('Test exchange: fills on the live book with fees, sells only what it holds, pays winners', async () => {
  const book = { yes: [[0.4, 5], [0.39, 10]], no: [[0.55, 3], [0.54, 10]] };
  const ex = createTestExchange({ getBook: async () => book, startCash: 20 });
  const r = await ex.place(buyOrder({ ticker: 'T', side: 'YES', count: 5, limit: 0.46 }));
  assert.equal(r.filled, 5); // 3 at 45¢ + 2 at 46¢
  assert.equal(r.fees, feeFor(3, 0.45) + feeFor(2, 0.46));
  assert.equal(ex.balance(), Math.round((20 - (3 * 0.45 + 2 * 0.46) - r.fees) * 100) / 100);
  assert.deepEqual(await ex.positions(), [{ ticker: 'T', side: 'YES', count: 5 }]);
  await assert.rejects(ex.place(sellOrder({ ticker: 'T', side: 'NO', count: 1, floor: 0.5 })), (e) => e.code === 'reduce_only');
  await assert.rejects(ex.place(buyOrder({ ticker: 'T', side: 'YES', count: 500, limit: 0.99 })), (e) => e.code === 'insufficient_balance');
  const s = await ex.place(sellOrder({ ticker: 'T', side: 'YES', count: 2, floor: 0.4 }));
  assert.equal(s.filled, 2);
  const cash = ex.balance();
  ex.settle('T', 'yes');
  assert.equal(ex.balance(), Math.round((cash + 3) * 100) / 100);
});
