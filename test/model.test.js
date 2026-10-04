import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, kalshiFee, normCdf, probAbove, quote, realizedVol, settlePnl, settleVariance } from '../public/model.js';

const close = (min, now = 0) => new Date(now + min * 60000).toISOString();

test('normCdf matches known values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1) - 0.1587) < 1e-3);
});

test('probAbove is 50% at the money and moves with distance and time', () => {
  assert.ok(Math.abs(probAbove(100000, 100000, 0.001, 10) - 0.5) < 1e-6);
  assert.ok(probAbove(100100, 100000, 0.001, 10) > 0.6);
  assert.ok(probAbove(100100, 100000, 0.001, 1) > probAbove(100100, 100000, 0.001, 10));
  assert.equal(probAbove(100100, 100000, 0.001, 0), 1);
});

test('settleVariance shrinks for the averaging window and is continuous', () => {
  assert.ok(Math.abs(settleVariance(1, 1) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(settleVariance(1, 0.999999) - 1 / 3) < 1e-5);
  assert.equal(settleVariance(1, 0), 0);
});

test('realizedVol recovers a known volatility', () => {
  const closes = [100000];
  for (let i = 0; i < 200; i++) closes.push(closes[i] * Math.exp((i % 2 ? 1 : -1) * 0.001));
  assert.ok(Math.abs(realizedVol(closes) - 0.001) < 1e-4);
  assert.equal(realizedVol([1, 2]), null);
});

test('kalshiFee rounds up to the cent', () => {
  assert.equal(kalshiFee(0.5), 0.02); // 0.0175 -> 0.02
  assert.equal(kalshiFee(0.5, 100), 1.75);
  assert.equal(kalshiFee(0.99), 0.01);
});

test('quote handles cents and dollar fields', () => {
  assert.deepEqual(quote({ yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60, last_price: 41 }),
    { yesBid: 0.4, yesAsk: 0.42, noBid: 0.58, noAsk: 0.6, last: 0.41 });
  const q = quote({ yes_bid_dollars: '0.4000', yes_ask_dollars: '0.4200' });
  assert.equal(q.noAsk, 0.6);
  assert.equal(quote({ yes_bid: 0, yes_ask: 100 }).yesAsk, null);
});

test('evaluate calls YES when the market underprices a likely outcome', () => {
  const market = { close_time: close(3), strike_type: 'greater', floor_strike: 100000, yes_bid: 50, yes_ask: 52 };
  const ev = evaluate({ market, spot: 100200, sigmaMin: 0.0008, now: 0 });
  assert.equal(ev.call, 'YES');
  assert.ok(ev.pYes > 0.8);
  assert.ok(ev.contracts >= 1);
});

test('evaluate calls NO when spot is well below strike', () => {
  const market = { close_time: close(3), strike_type: 'greater', floor_strike: 100000, yes_bid: 48, yes_ask: 50 };
  assert.equal(evaluate({ market, spot: 99800, sigmaMin: 0.0008, now: 0 }).call, 'NO');
});

test('evaluate passes when fairly priced, too wide, or out of the time window', () => {
  const base = { strike_type: 'greater', floor_strike: 100000 };
  assert.equal(evaluate({ market: { ...base, close_time: close(5), yes_bid: 49, yes_ask: 51 }, spot: 100000, sigmaMin: 0.0008, now: 0 }).call, 'PASS');
  assert.match(evaluate({ market: { ...base, close_time: close(5), yes_bid: 20, yes_ask: 60 }, spot: 100300, sigmaMin: 0.0008, now: 0 }).reason, /Spread/);
  assert.match(evaluate({ market: { ...base, close_time: close(0.2), yes_bid: 50, yes_ask: 52 }, spot: 100300, sigmaMin: 0.0008, now: 0 }).reason, /close/);
  assert.match(evaluate({ market: { ...base, close_time: close(5) }, spot: null, sigmaMin: 0.0008, now: 0 }).reason, /Waiting/);
});

test('between strikes use both bounds', () => {
  const market = { close_time: close(5), strike_type: 'between', floor_strike: 99900, cap_strike: 100100, yes_bid: 10, yes_ask: 12 };
  const ev = evaluate({ market, spot: 100000, sigmaMin: 0.0005, now: 0 });
  assert.ok(ev.pYes > 0.3 && ev.pYes < 0.9);
});

test('settlePnl', () => {
  assert.deepEqual(settlePnl({ side: 'YES', price: 0.5, contracts: 10 }, 'yes'), { won: true, pnl: 4.8 });
  const loss = settlePnl({ side: 'NO', price: 0.5, contracts: 10 }, 'yes');
  assert.equal(loss.won, false);
  assert.ok(Math.abs(loss.pnl + 5.2) < 1e-9);
});

test('effectiveVol floors frozen tapes so a $2 lead is not certainty', async () => {
  const { effectiveVol } = await import('../public/model.js');
  assert.equal(effectiveVol(0.000001, 0.000002), 0.00008);
  assert.equal(effectiveVol(0.0002, 0.0001), 0.0002);
  assert.ok(Math.abs(effectiveVol(0.0001, 0.0005) - 0.0003) < 1e-12);
  assert.equal(effectiveVol(null, null), null);
  // $1.78 above an $84,811 target with 1 minute left
  const p = probAbove(84812.70, 84810.92, effectiveVol(0.000001, 0.000002) * 1.15, 1);
  assert.ok(p > 0.55 && p < 0.8, `p=${p}`);
});

test('bot waits 5 minutes into the window before calling', () => {
  const now = Date.parse('2026-10-04T04:00:00Z');
  const mk = (minIn) => ({ open_time: new Date(now - minIn * 60000).toISOString(), close_time: new Date(now + (15 - minIn) * 60000).toISOString(),
    strike_type: 'greater', floor_strike: 100000, yes_bid: 30, yes_ask: 32 });
  const early = evaluate({ market: mk(2), spot: 100150, sigmaMin: 0.0008, now });
  assert.equal(early.call, 'PASS');
  assert.match(early.reason, /Watching the first 5 minutes/);
  assert.equal(early.callsAt, now + 3 * 60000);
  assert.ok(early.evYes > 0.1, 'still prices the edge while waiting');
  assert.equal(evaluate({ market: mk(5.5), spot: 100150, sigmaMin: 0.0008, now }).call, 'YES');
  assert.equal(evaluate({ market: mk(2), spot: 100150, sigmaMin: 0.0008, now, settings: { waitMinutes: 0 } }).call, 'YES');
});

test('default vol multiplier prices with measured volatility', async () => {
  const { DEFAULTS } = await import('../public/model.js');
  assert.equal(DEFAULTS.volMultiplier, 1);
});
