import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestExchange, createTrader, feeFor, makerBuyOrder, makerPrice } from '../public/trader.js';
import { validateOrder } from '../server.js';

const close = 15 * 60000;
const live = { m: { ticker: 'KXBTC15M-T', close_time: new Date(close).toISOString() }, ev: { minutesLeft: 10, quote: { yesAsk: 0.6 } } };
const sig = { callSide: 'YES', limit: 0.62, contracts: 10, deep: { score: 90 } };
function rig(book, makerSec = 20) {
  let t = 60000;
  const ex = createTestExchange({ getBook: async () => book.now, startCash: 50 });
  const tr = createTrader({ exchange: ex, settings: () => ({ mode: 'test', makerSec, perTrade: 10 }), now: () => t, sleep: async () => {} });
  return { ex, tr, at: (ms) => { t = ms; } };
}

test('maker price: a cent above the best bid, never at the ask or over the max', () => {
  const book = { yes: [[0.57, 50]], no: [[0.4, 50]] }; // YES bid 57¢, YES ask 60¢
  assert.equal(makerPrice(book, 'YES', 0.62), 0.58);
  assert.equal(makerPrice({ yes: [[0.59, 5]], no: [[0.4, 5]] }, 'YES', 0.62), 0.59, 'a 1¢ spread: no room to improve, so it joins the bid');
  assert.equal(makerPrice({ yes: [], no: [[0.4, 5]] }, 'YES', 0.62), null, 'no bid to rest against');
  assert.equal(makerPrice(book, 'YES', 0.55), 0.55, 'capped at the max price');
  assert.equal(makerPrice(book, 'NO', 0.45), 0.41, 'NO side: its bid is the NO book');
  const o = makerBuyOrder({ ticker: 'KXBTC15M-T', side: 'YES', count: 3, price: 0.58, id: 'abcdefgh1' });
  assert.equal(o.time_in_force, 'good_till_canceled'); assert.equal(o.post_only, true); assert.equal(o.price, '0.5800');
});

test('a resting maker buy fills when the ask comes down to it: booked at its price with the maker fee', async () => {
  const book = { now: { yes: [[0.57, 50]], no: [[0.4, 50]] } };
  const { ex, tr, at } = rig(book);
  const r1 = await tr.step({ live, sig });
  assert.match(r1.why, /^Maker buy resting at 58¢/);
  const st = tr.state();
  assert.ok(st.maker && st.maker.count > 0);
  const n = st.maker.count;
  assert.ok(ex.balance() < 50, 'cash held while it rests');
  at(70000); assert.match((await tr.step({ live, sig })).why, /resting at 58¢: 0\/\d+ filled/);
  book.now = { yes: [[0.57, 50]], no: [[0.42, 50]] }; // a seller comes down to 58¢
  at(75000); const r3 = await tr.step({ live, sig });
  assert.deepEqual(r3, { did: 'buy', filled: n });
  const e = tr.state().ledger[0];
  assert.equal(e.price, 0.58); assert.equal(e.fees, feeFor(n, 0.58, true));
  assert.equal(ex.balance(), Math.round((50 - n * 0.58 - feeFor(n, 0.58, true)) * 100) / 100);
  assert.equal(tr.state().maker, null);
});

test('no fill by the deadline: cancelled, cash back, then a normal buy', async () => {
  const book = { now: { yes: [[0.57, 50]], no: [[0.4, 50]] } };
  const { ex, tr, at } = rig(book);
  await tr.step({ live, sig });
  at(60000 + 21000); const r2 = await tr.step({ live, sig });
  assert.equal(r2.did, 'buy', 'the step carried on to a normal buy');
  assert.equal(tr.state().maker, null);
  assert.ok(tr.state().log.some((x) => /didn't fill.*cancelled; next try is a normal buy/.test(x.text)));
  assert.equal(tr.state().ledger.length, 1, 'the normal buy went through at the ask');
  assert.equal(tr.state().ledger[0].price, 0.6);
  assert.ok(ex.balance() > 40, 'the held cash came back before the normal buy');
});

test('the call goes away: the resting buy is cancelled at once', async () => {
  const book = { now: { yes: [[0.57, 50]], no: [[0.4, 50]] } };
  const { tr, at } = rig(book);
  await tr.step({ live, sig });
  at(62000); await tr.step({ live, sig: null });
  assert.equal(tr.state().maker, null);
  assert.ok(tr.state().log.some((x) => /the call is gone/.test(x.text)));
});

test('a post-only refusal is not an error; maker off means plain fill-now buys', async () => {
  const book = { now: { yes: [[0.57, 50]], no: [[0.4, 50]] } };
  const { tr } = rig(book, 0);
  const r = await tr.step({ live, sig });
  assert.equal(r.did, 'buy'); assert.equal(tr.state().ledger[0].price, 0.6);
  // the simulator refuses a post-only buy that would take
  const ex = createTestExchange({ getBook: async () => book.now, startCash: 50 });
  await assert.rejects(ex.place(makerBuyOrder({ ticker: 'KXBTC15M-T', side: 'YES', count: 1, price: 0.6, id: 'abcdefgh2' })), (e) => e.code === 'post_only_cross');
});

test('the server lets only its own Auto-trader rest post-only buys', () => {
  const o = makerBuyOrder({ ticker: 'KXBTC15M-26OCT10-T1', side: 'YES', count: 3, price: 0.58, id: 'abcdefgh3' });
  assert.match(validateOrder(o), /only fill-now-or-cancel/, 'the phone route: never');
  assert.equal(validateOrder(o, { allowMaker: true }), null);
  assert.match(validateOrder({ ...o, post_only: false }, { allowMaker: true }), /only fill-now-or-cancel/, 'resting must be post-only');
  assert.match(validateOrder({ ...o, reduce_only: true }, { allowMaker: true }), /only fill-now-or-cancel/, 'no resting sells');
  assert.match(validateOrder({ ...o, count: '500.00' }, { allowMaker: true }), /cap/, 'still under the dollar cap');
});
