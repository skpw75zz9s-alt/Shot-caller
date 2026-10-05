import test from 'node:test';
import assert from 'node:assert/strict';
import { buyOrder, liveState, planBuy, planSell, sellOrder } from '../public/autotrade.js';
import { validateOrder } from '../server.js';

const now = Date.now();
const c2 = (v) => Math.round(v * 100) / 100;
const row = (yb, ticker = 'KXBTC15M-26OCT05-T1') => ({ m: { ticker }, ev: { quote: { yesBid: yb, yesAsk: c2(yb + 0.02), noBid: c2(0.98 - yb), noAsk: c2(1 - yb) } } });
const call = (o = {}) => ({ fire: true, callSide: 'YES', stance: 'new', deep: { score: 80 }, limit: 0.45, contracts: 100, ...o });
const cfg = { live: true, budget: 50, maxPerTrade: 10, dailyLoss: 40, maxTrades: 40, minConfidence: 40 };
const base = { cfg, positions: [], trades: [], orders: [], balance: 200, now };

test('V2 order bodies pass the server check, and the server refuses anything else', () => {
  const b = buyOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', count: 20, limit: 0.45 });
  assert.equal(validateOrder(b), null);
  assert.deepEqual([b.side, b.price, b.count, b.reduce_only, b.time_in_force], ['bid', '0.4500', '20.00', false, 'immediate_or_cancel']);
  const n = buyOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'NO', count: 5, limit: 0.3 });
  assert.equal(validateOrder(n), null);
  assert.deepEqual([n.side, n.price], ['ask', '0.7000'], 'buy NO at 30c = ask YES at 70c');
  const s = sellOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'NO', count: 5, floor: 0.6 });
  assert.equal(validateOrder(s), null);
  assert.deepEqual([s.side, s.price, s.reduce_only], ['bid', '0.4000', true], 'sell NO at 60c = bid YES at 40c, reduce only');
  const y = sellOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', count: 5, floor: 0.72 });
  assert.deepEqual([y.side, y.price, y.reduce_only], ['ask', '0.7200', true]);
  const bad = (o) => validateOrder({ ...b, ...o });
  assert.match(bad({ ticker: 'KXELECTION-26-X' }), /BTC 15-minute/);
  assert.match(bad({ time_in_force: 'good_till_canceled' }), /nothing left resting/);
  assert.match(bad({ side: 'yes' }), /bid or ask/);
  assert.match(bad({ count: '0.00' }), /count/);
  assert.match(bad({ count: 3 }), /count/);
  assert.match(bad({ count: '300.00' }), /\$100 cap/);
  assert.match(bad({ price: '0.0000' }), /price/);
  assert.match(bad({ price: 45 }), /price/);
  assert.match(bad({ reduce_only: 'no' }), /reduce_only/);
  assert.match(bad({ self_trade_prevention_type: 'maker' }), /self_trade/);
  assert.match(bad({ withdraw: true }), /not allowed: withdraw/);
  assert.match(validateOrder({ ...n, count: '400.00' }), /\$100 cap/, 'an ask opens NO at 1 - price');
  assert.equal(validateOrder({ ...y, count: '300.00' }), null, 'closing a position is not capped');
});

test('buys a new confident call at the max price, sized to the per-trade cap', () => {
  const p = planBuy({ ...base, sig: call(), row: row(0.40) });
  assert.equal(p.ok, true);
  assert.equal(p.order.side, 'bid');
  assert.equal(p.order.price, '0.4500', 'limit at the max price: fills at the ask or better, never higher');
  assert.equal(p.order.count, '21.00', '$10 / (45¢ + 2¢ fee)');
  assert.deepEqual(p.meta, { action: 'buy', side: 'YES', count: 21, cents: 45 });
});

test('skips: off, holding, low confidence, price over max, just ordered', () => {
  assert.match(planBuy({ ...base, cfg: { ...cfg, live: false }, sig: call(), row: row(0.4) }).why, /off/);
  assert.match(planBuy({ ...base, sig: call({ deep: { score: 30 } }), row: row(0.4) }).why, /confidence 30/);
  assert.match(planBuy({ ...base, sig: call({ limit: 0.41 }), row: row(0.4) }).why, /over the 41¢ max/);
  assert.match(planBuy({ ...base, sig: call({ fire: false, stance: 'holding' }), row: row(0.4) }).why, /new call/);
  assert.equal(planBuy({ ...base, sig: call({ stance: 'switching' }), row: row(0.4) }).ok, true, 'a real switch is tradable when not holding');
  const pos = { ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', price: 0.4, contracts: 10, source: 'kalshi' };
  assert.match(planBuy({ ...base, positions: [pos], sig: call(), row: row(0.4) }).why, /Already holding/);
  assert.match(planBuy({ ...base, orders: [{ at: now - 2000, ticker: 'KXBTC15M-26OCT05-T1', action: 'buy' }], sig: call(), row: row(0.4) }).why, /Just sent/);
});

test('money limits: budget, daily loss stop, trades per day, Kalshi cash', () => {
  const open = (cost) => ({ ticker: 'KXBTC15M-OTHER', side: 'NO', price: 0.5, contracts: cost / 0.52, source: 'kalshi' });
  // $25 of a $30 budget at risk: only $5 of room
  const small = { ...cfg, budget: 30 };
  const p = planBuy({ ...base, cfg: small, positions: [open(25)], sig: call(), row: row(0.4) });
  assert.equal(p.meta.count, 10, '$5 / 47¢');
  assert.match(planBuy({ ...base, cfg: small, positions: [open(30)], sig: call(), row: row(0.4) }).why, /Budget full/);
  // open positions count as possibly lost, so at-risk money can never pass the daily loss stop either
  assert.equal(planBuy({ ...base, positions: [open(36)], sig: call(), row: row(0.4) }).meta.count, 8, '$4 left under the $40 stop / 47¢');
  // lost $30 today and $10 still open: worst case hits the $40 stop
  const lost = [{ source: 'kalshi', closedAt: now, pnl: -30 }];
  assert.match(planBuy({ ...base, trades: lost, positions: [open(10)], sig: call(), row: row(0.4) }).why, /\$40 loss limit/);
  const orders = Array.from({ length: 40 }, (_, i) => ({ at: now - 60000 - i, ticker: `T${i}`, action: 'buy' }));
  assert.match(planBuy({ ...base, orders, sig: call(), row: row(0.4) }).why, /40 trades/);
  assert.match(planBuy({ ...base, balance: 0.3, sig: call(), row: row(0.4) }).why, /Not enough Kalshi cash/);
  assert.equal(planBuy({ ...base, balance: 4, sig: call(), row: row(0.4) }).meta.count, 8, 'never more than the Kalshi balance');
  const st = liveState({ positions: [open(10)], trades: lost, orders: [], now });
  assert.ok(Math.abs(st.worstCase + 40) < 1e-6);
});

test('scale-in adds to a held Kalshi position; sells follow the exit rules at the bid or better', () => {
  const pos = { ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', price: 0.4, contracts: 10, source: 'kalshi' };
  const add = planBuy({ ...base, positions: [pos], sig: call({ fire: false, stance: 'holding', add: true }), row: row(0.38) });
  assert.equal(add.ok, true); assert.equal(add.add, true);
  const sell = planSell({ cfg, pos, check: { ex: { action: 'SELL' }, bid: 0.72 }, orders: [], now });
  assert.deepEqual([sell.order.side, sell.order.count, sell.order.price, sell.order.reduce_only], ['ask', '10.00', '0.7200', true]);
  assert.deepEqual(sell.meta, { action: 'sell', side: 'YES', count: 10, cents: 72 });
  assert.equal(planSell({ cfg, pos, check: { ex: { action: 'HOLD' }, bid: 0.72 }, orders: [], now }), null);
  assert.equal(planSell({ cfg: { ...cfg, live: false }, pos, check: { ex: { action: 'SELL' }, bid: 0.72 }, orders: [], now }), null);
  assert.equal(planSell({ cfg, pos: { ...pos, source: undefined }, check: { ex: { action: 'SELL' }, bid: 0.72 }, orders: [], now }), null, 'only Kalshi-synced positions');
});

test('confidence bar is 80 (win odds); the Aggressive big-gap exception may trade under it', () => {
  const lowConf = call({ deep: { score: 60 } });
  assert.match(planBuy({ ...base, cfg: { ...cfg, minConfidence: 80 }, sig: lowConf, row: row(0.4) }).why, /confidence 60 is under 80/);
  assert.equal(planBuy({ ...base, cfg: { ...cfg, minConfidence: 80 }, sig: { ...lowConf, bigGap: true }, row: row(0.4) }).ok, true);
});

test('keeps trying an active call it has not bought: no fill, an error, or Live turned on mid-call (max 3 tries)', () => {
  const T = 'KXBTC15M-26OCT05-T1';
  const holdingCall = call({ fire: false, stance: 'holding', called: 'YES', calledAt: now - 60000 });
  // turned on mid-call: no order yet
  assert.equal(planBuy({ ...base, sig: holdingCall, row: row(0.4) }).ok, true);
  // first order didn't fill: try again
  const miss = { at: now - 20000, ticker: T, action: 'buy', side: 'YES', status: 'no fill (cancelled)', filled: 0 };
  assert.equal(planBuy({ ...base, orders: [miss], sig: holdingCall, row: row(0.4) }).ok, true);
  const err = { ...miss, at: now - 10000, status: 'error', filled: undefined };
  assert.equal(planBuy({ ...base, orders: [miss, err], sig: holdingCall, row: row(0.4) }).ok, true);
  assert.match(planBuy({ ...base, orders: [miss, err, { ...miss, at: now - 6000 }], sig: holdingCall, row: row(0.4) }).why, /Gave up on this call after 3/);
  // it filled (or may have, still in flight): never buy the same call twice while Kalshi sync catches up
  assert.match(planBuy({ ...base, orders: [{ ...miss, status: 'filled', filled: 5 }], sig: holdingCall, row: row(0.4) }).why, /new call/);
  assert.match(planBuy({ ...base, orders: [{ at: now - 6000, ticker: T, action: 'buy', side: 'YES', status: 'sent' }], sig: holdingCall, row: row(0.4) }).why, /new call/);
  // orders from an earlier call don't count against this one
  assert.equal(planBuy({ ...base, orders: [{ ...miss, at: now - 120000 }, { ...miss, at: now - 110000 }, { ...miss, at: now - 100000 }], sig: holdingCall, row: row(0.4) }).ok, true);
});

test('only buys that went through count toward Max trades / day', () => {
  const misses = Array.from({ length: 40 }, (_, i) => ({ at: now - 60000 - i, ticker: `T${i}`, action: 'buy', side: 'YES', status: i % 2 ? 'error' : 'no fill (cancelled)', filled: i % 2 ? undefined : 0 }));
  assert.equal(planBuy({ ...base, orders: misses, sig: call(), row: row(0.4) }).ok, true);
  assert.equal(liveState({ positions: [], trades: [], orders: misses, now }).buys, 0);
});


test('instant orders: the server checks the live book and places the order in one step', async () => {
  const { bookAdjust } = await import('../server.js');
  // YES bids 40c x10, 42c x5; NO bids 55c x8 (= YES ask 45c), 50c x20 (= YES ask 50c)
  const book = { orderbook: { yes: [[40, 10], [42, 5]], no: [[50, 20], [55, 8]] } };
  const buyYes = buyOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', count: 20, limit: 0.46 });
  assert.deepEqual([bookAdjust(buyYes, book).order.count, bookAdjust(buyYes, book).order.price], ['8.00', '0.4600'], 'sized to the 8 for sale at <= 46c');
  assert.deepEqual(bookAdjust({ ...buyYes, price: '0.4400' }, book), { skip: true, best: 0.45 }, 'bargain gone: no order');
  const buyNo = buyOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'NO', count: 50, limit: 0.6 }); // ask YES at 40c
  assert.equal(bookAdjust(buyNo, book).order.count, '15.00', 'YES bids at >= 40c: 5 + 10');
  // sells step to the live bid when it's within 2c, never further
  const sellYes = sellOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', count: 7, floor: 0.44 });
  assert.deepEqual([bookAdjust(sellYes, book, 0.02).order.price, bookAdjust(sellYes, book, 0.02).order.count], ['0.4200', '7.00']);
  assert.equal(bookAdjust({ ...sellYes, price: '0.4700' }, book, 0.02).skip, true, 'live bid 5c under: wait');
  const fp = { orderbook_fp: { yes_dollars: [['0.3000', '12.00']], no_dollars: null } };
  assert.equal(bookAdjust(buyYes, fp).skip, true, 'no YES for sale');
});
