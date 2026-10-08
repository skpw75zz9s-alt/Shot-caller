import test from 'node:test';
import assert from 'node:assert/strict';
import { exitSignal, sellTarget } from '../public/model.js';
import { flipSigns } from '../public/candles.js';

const pos = { side: 'YES', price: 0.40, contracts: 10 };

test('sellTarget covers the exit fee', () => {
  const t = sellTarget(0.60);
  assert.ok(t - Math.ceil(0.07 * t * (1 - t) * 100 - 1e-9) / 100 >= 0.60 - 1e-9);
  assert.equal(sellTarget(0.999), 0.99);
});

test('holds while the bot still values it above the bid and nothing is flipping', () => {
  const ex = exitSignal({ pos, bid: 0.45, pSide: 0.66, minutesLeft: 6 });
  assert.equal(ex.action, 'HOLD');
  assert.ok(ex.target >= 0.66);
});

test('takes profit when the bid catches up to the bot odds', () => {
  const ex = exitSignal({ pos, bid: 0.70, pSide: 0.66, minutesLeft: 6 });
  assert.equal(ex.action, 'SELL');
  assert.equal(ex.kind, 'take');
  assert.ok(ex.pnl > 2.5);
});

test('flip signs are shown but never force a sale below what the contract is worth', () => {
  const win = exitSignal({ pos, bid: 0.50, pSide: 0.66, flips: ['Shooting star'], minutesLeft: 6 });
  assert.equal(win.action, 'HOLD');
  assert.deepEqual(win.signs, ['Shooting star']);
  assert.match(win.why, /flip signs/);
  const caught = exitSignal({ pos, bid: 0.70, pSide: 0.66, flips: ['Shooting star'], minutesLeft: 6 });
  assert.equal(caught.action, 'SELL');
  assert.equal(caught.kind, 'take');
});

test('trailing bid and falling odds are listed as flip signs', () => {
  const trail = exitSignal({ pos: { ...pos, peakBid: 0.58 }, bid: 0.52, pSide: 0.70, minutesLeft: 6 });
  assert.equal(trail.action, 'HOLD');
  assert.ok(trail.signs.some((x) => /peak/.test(x)));
  const odds = exitSignal({ pos: { ...pos, peakP: 0.80 }, bid: 0.50, pSide: 0.70, minutesLeft: 6 });
  assert.ok(odds.signs.some((x) => /Bot odds down/.test(x)));
});

test('cuts only when Kalshi pays clearly more than the bot\'s odds (3-pt margin; bail-out off to test the cut rule alone)', () => {
  const ex = exitSignal({ pos, bid: 0.30, pSide: 0.22, minutesLeft: 6, settings: { bailBelow: 0 } });
  assert.equal(ex.action, 'SELL');
  assert.equal(ex.kind, 'cut');
  assert.ok(ex.pnl < 0);
  // net 28% vs bot 27%: a hair over, not a reason to sell at a loss
  assert.equal(exitSignal({ pos, bid: 0.30, pSide: 0.27, minutesLeft: 6, settings: { bailBelow: 0 } }).action, 'HOLD');
});

test('trusts the call: a losing sell has to hold for 30s before SELL NOW; profit-taking is instant (bail-out off)', async () => {
  const { positionCheck } = await import('../public/engine.js');
  const close = new Date(Date.now() + 6 * 60000).toISOString();
  const snapAt = (yb, pYes, now) => ({ now, bars: [], quoteLog: {}, rows: [{ m: { ticker: 'T' }, rej: null, ev: { pYes, quote: { yesBid: yb, noBid: 1 - yb - 0.02 } } }] });
  const p = { id: 'a', ticker: 'T', side: 'YES', price: 0.40, contracts: 10, closeTime: close };
  const t0 = Date.now();
  let c = positionCheck(p, snapAt(0.30, 0.20, t0), { bailBelow: 0 }, t0);
  assert.equal(c.ex.action, 'HOLD');
  assert.equal(c.ex.kind, 'steady');
  assert.match(c.ex.why, /isn't a reason to bail/);
  c = positionCheck(p, snapAt(0.30, 0.20, t0 + 15000), { bailBelow: 0 }, t0 + 15000);
  assert.equal(c.ex.kind, 'steady');
  // the dip reverses: the countdown resets
  c = positionCheck(p, snapAt(0.38, 0.45, t0 + 20000), { bailBelow: 0 }, t0 + 20000);
  assert.equal(c.ex.kind, 'hold');
  assert.equal(p.sellSince, null);
  c = positionCheck(p, snapAt(0.30, 0.20, t0 + 25000), { bailBelow: 0 }, t0 + 25000);
  assert.equal(c.ex.kind, 'steady');
  c = positionCheck(p, snapAt(0.30, 0.20, t0 + 56000), { bailBelow: 0 }, t0 + 56000);
  assert.equal(c.ex.action, 'SELL', 'still true after 30s: sell');
  assert.equal(c.ex.kind, 'cut');
  // in profit and Kalshi caught up: no waiting
  const q = { id: 'b', ticker: 'T', side: 'YES', price: 0.40, contracts: 10, closeTime: close };
  assert.equal(positionCheck(q, snapAt(0.70, 0.66, t0), { bailBelow: 0 }, t0).ex.kind, 'take');
});

test('closed market and no bids', () => {
  assert.equal(exitSignal({ pos, bid: 0.5, pSide: 0.6, minutesLeft: 0 }).kind, 'closed');
  assert.equal(exitSignal({ pos, bid: null, pSide: 0.6, minutesLeft: 3 }).kind, 'nobid');
});

test('flipSigns spots a shooting star after a run-up for YES only', () => {
  const T0 = 1_700_000_040_000;
  const closes = [...Array(30)].map((_, i) => 100000 + i * 12);
  const b = closes.map((c, i) => ({ t: T0 + i * 60000, o: i ? closes[i - 1] : c, c, h: c + 3, l: (i ? closes[i - 1] : c) - 3 }));
  const lc = closes[closes.length - 1];
  b.push({ t: T0 + 30 * 60000, o: lc, c: lc - 2, h: lc + 60, l: lc - 4 }); // shooting star
  const now = T0 + 31 * 60000;
  assert.ok(flipSigns(b, 'YES', now).includes('Shooting star'));
  assert.ok(!flipSigns(b, 'NO', now).includes('Shooting star'));
});


test('bail out: a losing position sells once the bot\'s odds fall under 40%, right away, not in the last 30s', async () => {
  const { exitSignal } = await import('../public/model.js');
  const pos = { side: 'YES', price: 0.7, contracts: 10 };
  const ex = exitSignal({ pos, bid: 0.33, pSide: 0.36, minutesLeft: 6 });
  assert.equal(ex.action, 'SELL'); assert.equal(ex.kind, 'bail');
  assert.match(ex.why, /Bail out: the bot now gives it only 36%/);
  assert.equal(exitSignal({ pos, bid: 0.43, pSide: 0.45, minutesLeft: 6 }).kind, 'hold', 'above the line: hold');
  assert.equal(exitSignal({ pos, bid: 0.33, pSide: 0.36, minutesLeft: 0.4 }).action, 'HOLD', 'last 30 seconds: no bail');
  assert.equal(exitSignal({ pos, bid: 0.33, pSide: 0.36, minutesLeft: 6, settings: { bailBelow: 0 } }).action, 'HOLD', 'off');
});

test('bail out on the bot\'s own call: the Deck flips to BAIL OUT and it stays for the round', async () => {
  const { buySignal } = await import('../public/engine.js');
  const { evaluate } = await import('../public/model.js');
  const NOW = 1_700_000_040_000, K = 100000;
  const m = { ticker: 'T', close_time: new Date(NOW + 6 * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: 30, yes_ask: 32 };
  const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: K, c: K, h: K + 10, l: K - 10 }));
  const ev = evaluate({ market: m, strike: K, spot: K - 40, sigmaMin: 0.0002, now: NOW });
  const row = { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } };
  const snap = { now: NOW, bars, sigmaMin: 0.0002, sigmaLong: 0.0002, driftMin: 0, spot: K - 40, quoteLog: {} };
  const mem = { T: { side: 'YES', at: NOW - 120000, n: 1, price: 0.7 } };
  const sig = buySignal(row, snap, {}, NOW, mem);
  assert.ok(ev.pYes < 0.4, String(ev.pYes));
  assert.deepEqual({ side: sig.bail.side, bid: sig.bail.bid }, { side: 'YES', bid: 0.3 });
  assert.ok(buySignal(row, { ...snap, spot: K + 40 }, {}, NOW + 2000, mem).bail, 'still shown after a bounce');
  assert.equal(buySignal(row, snap, { bailBelow: 0 }, NOW, { T: { side: 'YES', at: NOW - 120000, n: 1 } }).bail, null, 'off');
});
