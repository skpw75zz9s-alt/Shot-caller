import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, riskSettings } from '../public/model.js';
import { buySignal } from '../public/engine.js';
import { EARLY, earlyProof } from '../public/profitguard.js';
import { accuracyRows } from '../public/accuracy.js';
import { callMessage } from '../discord.js';

// BTC well above the target with `mins` left (same harness as test/latelane.test.js)
const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002;
const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
function setup({ yb, ya, lead = 250, mins = 8, secs = 70, live = false }) {
  const m = { ticker: 'T', close_time: new Date(NOW + mins * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya };
  const ev = evaluate({ market: m, strike: K, spot: K + lead, sigmaMin: SIG, now: NOW });
  const log = { T: [...Array(secs / 2 + 1)].map((_, i) => ({ t: NOW - secs * 1000 + i * 2000, p: 0.99, yesAsk: null, noAsk: null })) };
  return { row: { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } }, snap: { now: NOW, bars, sigmaMin: SIG, sigmaLong: SIG, driftMin: 0, spot: K + lead, quoteLog: log, earlyLive: live } };
}
const t90 = riskSettings('target90'), sig = (o, s = t90) => { const x = setup(o); return buySignal(x.row, x.snap, s, NOW, {}); };

test('the early lane: 10 to 5 minutes left on the 90% target level', () => {
  assert.equal(t90.earlyMin, 10); assert.equal(riskSettings('steady').earlyMin, 0);
  assert.equal(sig({ yb: 84, ya: 85, mins: 3 }).early, null, '3 minutes left: the late lane\'s time');
  assert.equal(sig({ yb: 84, ya: 85, mins: 12 }).early, null, '12 minutes left: not yet');
});

test('until it has proven itself it only makes test calls; once live, real calls at half size', () => {
  const t = sig({ yb: 84, ya: 85 });
  assert.equal(t.fire, false, 'Kalshi at 85c is under the 90% floor and the lane isn\'t live: no call');
  assert.deepEqual([t.early.would?.side, t.early.would?.price, t.early.live], ['YES', 0.85, false], JSON.stringify(t.early));
  const l = sig({ yb: 84, ya: 85, live: true });
  assert.ok(l.fire && l.callSide === 'YES' && l.lane === 'early', JSON.stringify(l.early));
  const full = sig({ yb: 84, ya: 85, live: true }, { ...t90, earlySize: 1 });
  assert.ok(l.contracts < full.contracts, `${l.contracts} vs ${full.contracts}`);
  assert.equal(sig({ yb: 84, ya: 85 }, { ...t90, earlyMin: 0 }).early, null, 'off: no early lane at all');
});

test('what keeps it out: too much doubt, the floor, a thin lead, Kalshi disagreeing, no steady wait, a raised guard floor', () => {
  assert.match(sig({ yb: 74, ya: 75 }).early.why, /too much doubt/);
  const floor = sig({ yb: 90, ya: 91 });
  assert.equal(floor.early?.would ?? null, null, 'at 91c the normal rules decide');
  assert.match(sig({ yb: 84, ya: 85, lead: 60 }).early.why, /worst-case|holds to the end/);
  assert.match(sig({ yb: 74, ya: 80 }).early.why, /bid isn't at 75/);
  assert.match(sig({ yb: 60, ya: 85 }).early.why, /spread too wide/i, 'a wide spread: not open for calls');
  assert.match(sig({ yb: 84, ya: 85, secs: 20 }).early.why, /steady/);
  assert.match(sig({ yb: 84, ya: 85, lead: 120 }, { ...t90, winFloor: 0.97 }).early.why, /worst-case odds|needs 97%/);
});

test('the proof: 50+ graded test calls whose win rate is clearly above what their prices need, and a profit', () => {
  const calls = (n, wins, price = 0.85) => Array.from({ length: n }, (_, i) => ({ side: 'YES', price, result: i < wins ? 'yes' : 'no' }));
  assert.equal(EARLY.min, 50);
  const good = earlyProof(calls(60, 58));
  assert.equal(good.live, true, JSON.stringify(good));
  assert.ok(good.need > 0.85 && good.need < 0.87, `85c plus the fee: ${good.need}`);
  assert.equal(earlyProof(calls(49, 49)).live, false, 'not enough calls yet');
  const thin = earlyProof(calls(60, 54));
  assert.equal(thin.live, false, `90% won at 85c: profitable but not clearly above break-even (low ${thin.low.toFixed(3)})`);
  const slip = earlyProof([...calls(60, 60), ...calls(25, 18)]);
  assert.deepEqual([slip.paused, slip.live], [true, false], 'the last 40 lose money: back to testing');
  assert.equal(earlyProof([{ side: 'YES', price: 0.85, result: null }]).n, 0, 'unsettled calls don\'t count');
});

test('the early lane on the accuracy card and in the Discord post', () => {
  const row = (early) => accuracyRows({ bot: { graded: 10, wins: 10, usd: 1, early } }).find((r) => r.key === 'early');
  const testing = row({ n: 12, wins: 11, usd: 3, need: 0.86, live: false });
  assert.equal(testing.verdict, 'wait'); assert.match(testing.name, /testing/); assert.match(testing.vs, /12 so far/);
  const live = row({ n: 60, wins: 58, usd: 40, need: 0.86, live: true });
  assert.equal(live.verdict, 'good'); assert.match(live.vs, /LIVE/);
  const call = { ticker: 'T', side: 'YES', price: 0.85, conf: 95, at: NOW, closeTime: new Date(NOW + 480000).toISOString() };
  const e = callMessage(call, { early: true }).embeds[0];
  assert.match(e.title, /EARLY/); assert.ok(e.fields.some((f) => f.name === 'Early lane'));
});
