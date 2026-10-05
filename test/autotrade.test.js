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

test('order bodies pass the server check, and the server refuses anything else', () => {
  const b = buyOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', count: 20, limit: 0.45 });
  assert.equal(validateOrder(b), null);
  assert.equal(b.yes_price, 45); assert.equal(b.time_in_force, 'immediate_or_cancel');
  const s = sellOrder({ ticker: 'KXBTC15M-26OCT05-T1', side: 'NO', count: 5, floor: 0.6 });
  assert.equal(validateOrder(s), null);
  assert.equal(s.sell_position_floor, 0);
  const bad = (o) => validateOrder({ ...b, ...o });
  assert.match(bad({ ticker: 'KXELECTION-26-X' }), /BTC 15-minute/);
  assert.match(bad({ time_in_force: 'good_till_canceled' }), /nothing left resting/);
  assert.match(bad({ type: 'market' }), /limit/);
  assert.match(bad({ count: 0 }), /count/);
  assert.match(bad({ count: 300 }), /\$100 cap/);
  assert.match(bad({ yes_price: 0 }), /1-99/);
  assert.match(bad({ no_price: 50 }), /only yes_price/);
  assert.match(bad({ withdraw: true }), /not allowed: withdraw/);
  assert.match(validateOrder({ ...s, sell_position_floor: undefined }), /go short/);
});

test('buys a new confident call at the max price, sized to the per-trade cap', () => {
  const p = planBuy({ ...base, sig: call(), row: row(0.40) });
  assert.equal(p.ok, true);
  assert.equal(p.order.side, 'yes');
  assert.equal(p.order.yes_price, 45, 'limit at the max price: fills at the ask or better, never higher');
  assert.equal(p.order.count, 21, '$10 / (45¢ + 2¢ fee)');
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
  assert.equal(p.order.count, 10, '$5 / 47¢');
  assert.match(planBuy({ ...base, cfg: small, positions: [open(30)], sig: call(), row: row(0.4) }).why, /Budget full/);
  // open positions count as possibly lost, so at-risk money can never pass the daily loss stop either
  assert.equal(planBuy({ ...base, positions: [open(36)], sig: call(), row: row(0.4) }).order.count, 8, '$4 left under the $40 stop / 47¢');
  // lost $30 today and $10 still open: worst case hits the $40 stop
  const lost = [{ source: 'kalshi', closedAt: now, pnl: -30 }];
  assert.match(planBuy({ ...base, trades: lost, positions: [open(10)], sig: call(), row: row(0.4) }).why, /\$40 loss limit/);
  const orders = Array.from({ length: 40 }, (_, i) => ({ at: now - 60000 - i, ticker: `T${i}`, action: 'buy' }));
  assert.match(planBuy({ ...base, orders, sig: call(), row: row(0.4) }).why, /40 trades/);
  assert.match(planBuy({ ...base, balance: 0.3, sig: call(), row: row(0.4) }).why, /Not enough Kalshi cash/);
  assert.equal(planBuy({ ...base, balance: 4, sig: call(), row: row(0.4) }).order.count, 8, 'never more than the Kalshi balance');
  const st = liveState({ positions: [open(10)], trades: lost, orders: [], now });
  assert.ok(Math.abs(st.worstCase + 40) < 1e-6);
});

test('scale-in adds to a held Kalshi position; sells follow the exit rules at the bid or better', () => {
  const pos = { ticker: 'KXBTC15M-26OCT05-T1', side: 'YES', price: 0.4, contracts: 10, source: 'kalshi' };
  const add = planBuy({ ...base, positions: [pos], sig: call({ fire: false, stance: 'holding', add: true }), row: row(0.38) });
  assert.equal(add.ok, true); assert.equal(add.add, true);
  const sell = planSell({ cfg, pos, check: { ex: { action: 'SELL' }, bid: 0.72 }, orders: [], now });
  assert.deepEqual([sell.action, sell.side, sell.count, sell.yes_price, sell.sell_position_floor], ['sell', 'yes', 10, 72, 0]);
  assert.equal(planSell({ cfg, pos, check: { ex: { action: 'HOLD' }, bid: 0.72 }, orders: [], now }), null);
  assert.equal(planSell({ cfg: { ...cfg, live: false }, pos, check: { ex: { action: 'SELL' }, bid: 0.72 }, orders: [], now }), null);
  assert.equal(planSell({ cfg, pos: { ...pos, source: undefined }, check: { ex: { action: 'SELL' }, bid: 0.72 }, orders: [], now }), null, 'only Kalshi-synced positions');
});
