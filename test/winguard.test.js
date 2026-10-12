import test from 'node:test';
import assert from 'node:assert/strict';
import { GUARD, guardStats, wilsonLow, withGuard } from '../public/winguard.js';
import { evaluate, riskLevelOf, riskSettings } from '../public/model.js';
import { buySignal } from '../public/engine.js';

const calls = (n, wins) => Array.from({ length: n }, (_, i) => ({ side: 'YES', result: i < wins ? 'yes' : 'no' }));

test('the guard: floor at 90c while the record holds its 92% aim, raised when it slips, never past 97c', () => {
  assert.equal(guardStats([]).floor, 0.9, 'no record yet');
  assert.equal(guardStats(calls(100, 93)).floor, 0.9);
  const slip = guardStats(calls(100, 88)); // shrunk rate (88 + 36.8) / 140 = 0.891
  assert.ok(Math.abs(slip.rate - (88 + GUARD.aim * GUARD.prior) / (100 + GUARD.prior)) < 1e-12);
  assert.equal(slip.floor, Math.ceil((0.9 + 1.5 * (0.92 - slip.rate)) * 100 - 1e-6) / 100);
  assert.ok(slip.floor > 0.9 && slip.floor < 0.97, String(slip.floor));
  assert.equal(guardStats(calls(40, 30)).floor, 0.97, 'a bad record: the cap');
  assert.equal(guardStats(calls(3, 2)).floor, 0.93, 'one early loss: a nudge, not the cap');
  const recent = guardStats([...calls(200, 100), ...calls(100, 95)]);
  assert.deepEqual([recent.n, recent.wins, recent.total], [100, 95, 300], 'the last 100 graded calls');
  assert.equal(guardStats([{ side: 'NO', result: null }]).n, 0, 'unsettled calls don\'t count');
});

test('Wilson\'s lower bound and the settings helper', () => {
  assert.equal(wilsonLow(0, 0), null);
  const lo = wilsonLow(95, 100);
  assert.ok(lo > 0.89 && lo < 0.95, String(lo));
  assert.ok(wilsonLow(10, 10) < wilsonLow(100, 100), 'more evidence, higher floor of belief');
  assert.equal(withGuard({ winFloor: 0.9 }, 0.94).winFloor, 0.94);
  assert.equal(withGuard({ winFloor: 0.9 }, 0.85).winFloor, 0.9, 'never below the level\'s own floor');
  const steady = riskSettings('steady');
  assert.equal(withGuard(steady, 0.95), steady, 'levels without a floor are untouched');
});

// a confident YES with BTC well above the target (same harness as test/steady.test.js)
const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002;
const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
function setup(yb, ya, secs = 70) {
  const m = { ticker: 'T', close_time: new Date(NOW + 9 * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya };
  const ev = evaluate({ market: m, strike: K, spot: K + 150, sigmaMin: SIG, now: NOW });
  const log = { T: [...Array(secs / 2 + 1)].map((_, i) => ({ t: NOW - secs * 1000 + i * 2000, p: 0.99, yesAsk: null, noAsk: null })) };
  return { row: { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } }, snap: { now: NOW, bars, sigmaMin: SIG, sigmaLong: SIG, driftMin: 0, spot: K + 150, quoteLog: log } };
}
test('the 90% target level: calls only a side Kalshi prices at the floor or more, and only if the bot rates it higher still', () => {
  const t90 = riskSettings('target90');
  assert.equal(riskLevelOf(t90), 'target90');
  assert.equal(t90.winFloor, 0.9);
  const priced = setup(90, 91), a = buySignal(priced.row, priced.snap, t90, NOW, {});
  assert.ok(a.fire && a.callSide === 'YES', `ask 91c with the bot at ~99%: ${JSON.stringify({ fire: a.fire, side: a.callSide })}`);
  const cheap = setup(84, 85), b = buySignal(cheap.row, cheap.snap, t90, NOW, {});
  assert.equal(b.fire, false, 'ask 85c: Kalshi only gives it 85%, below the floor, however big the bot\'s gap');
  assert.equal(buySignal(cheap.row, cheap.snap, riskSettings('steady'), NOW, {}).fire, true, 'Steady would have called it');
  assert.equal(buySignal(priced.row, priced.snap, withGuard(t90, 0.95), NOW, {}).fire, false, 'the guard raised the floor to 95c');
  const dear = setup(98, 99);
  assert.equal(buySignal(dear.row, dear.snap, t90, NOW, {}).fire, false, 'at 99c there\'s no room left for the bot\'s 1c gap after the fee');
});

test('the fast lane: an overwhelming lead (bot 98%+, Kalshi 93c+) is called after 20 s of steady odds, not a full wait', () => {
  const t90 = riskSettings('target90');
  assert.deepEqual([t90.fastSec, t90.fastConf, t90.fastAsk], [20, 98, 0.93]);
  const strong = setup(93, 94, 24), a = buySignal(strong.row, strong.snap, t90, NOW, {});
  assert.ok(a.fire && a.callSide === 'YES', `bot ~99%, Kalshi 94c, 24 s of history: ${JSON.stringify({ fire: a.fire, need: a.steadyNeed })}`);
  const merely = setup(90, 91, 24);
  assert.equal(buySignal(merely.row, merely.snap, t90, NOW, {}).fire, false, 'Kalshi at 91c: not overwhelming, so the normal wait applies');
  assert.equal(buySignal(strong.row, strong.snap, { ...t90, fastSec: 0 }, NOW, {}).fire, false, 'without the fast lane it would still be waiting');
  assert.equal(buySignal(strong.row, strong.snap, withGuard(t90, 0.95), NOW, {}).fire, false, 'the guard\'s floor still applies in the fast lane');
});
