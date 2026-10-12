import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, riskSettings } from '../public/model.js';
import { buySignal } from '../public/engine.js';
import { accuracyRows } from '../public/accuracy.js';
import { callMessage } from '../discord.js';

// BTC above the target with `mins` left (same harness as test/winguard.test.js)
const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002;
const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
function setup({ yb, ya, lead = 150, mins = 3, secs = 24, sigmaLong = SIG, askThen = null }) {
  const m = { ticker: 'T', close_time: new Date(NOW + mins * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: yb, yes_ask: ya };
  const ev = evaluate({ market: m, strike: K, spot: K + lead, sigmaMin: SIG, now: NOW });
  const log = { T: [...Array(secs / 2 + 1)].map((_, i) => ({ t: NOW - secs * 1000 + i * 2000, p: 0.99, yesAsk: i === 1 && askThen != null ? askThen : null, noAsk: null })) };
  return { row: { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } }, snap: { now: NOW, bars, sigmaMin: SIG, sigmaLong, driftMin: 0, spot: K + lead, quoteLog: log } };
}
// the late lane is off on the 90% target level since v13.17 (no new calls in the last 5 minutes); these tests turn it on
const t90 = { ...riskSettings('target90'), lateMin: 5, noCallLastMin: 0 }, sig = (o, s = t90, mem = {}) => { const x = setup(o); return buySignal(x.row, x.snap, s, NOW, mem); };

test('the 90% target level makes no new calls in the last 5 minutes (late lane off)', () => {
  const real = riskSettings('target90');
  assert.deepEqual([real.lateMin, real.noCallLastMin], [0, 5]);
  const a = sig({ yb: 93, ya: 94 }, real);
  assert.equal(a.fire, false, 'a big lead with 3 minutes left: no call'); assert.equal(a.late, null);
  assert.equal(sig({ yb: 93, ya: 94, mins: 6, secs: 70 }, real).fire, true, 'with 6 minutes left the normal rules still call it');
  assert.equal(riskSettings('steady').lateMin, 0, 'other levels: off');
});

test('the late lane (when turned on) covers the last 5 minutes only', () => {
  assert.equal(sig({ yb: 93, ya: 94, mins: 9 }).late, null, '9 minutes left: the normal rules');
});

test('a big lead late: called through the late lane, at half size', () => {
  const a = sig({ yb: 93, ya: 94 });
  assert.ok(a.fire && a.callSide === 'YES', JSON.stringify(a.late));
  assert.equal(a.lane, 'late'); assert.equal(a.late.made, true);
  assert.ok(a.late.p >= 0.97, `stress-test odds ${a.late.p}`);
  const full = sig({ yb: 93, ya: 94 }, { ...t90, lateSize: 1 });
  assert.ok(a.contracts < full.contracts && a.contracts >= Math.floor(full.contracts * 0.5), `${a.contracts} vs ${full.contracts}`);
});

test('the late lane replaces the normal bar late: a lead the normal rules would call can fail its stress test', () => {
  const o = { yb: 90, ya: 91, lead: 70, secs: 70 };
  assert.equal(sig(o, { ...t90, lateMin: 0 }).fire, true, 'the normal rules call it');
  const a = sig(o);
  assert.equal(a.fire, false);
  assert.match(a.late.why, /stress test/); assert.ok(a.late.p < 0.97);
});

test('what keeps it out: the price, Kalshi disagreeing, a fast market, a jump, too short a wait, its own losing record', () => {
  assert.match(sig({ yb: 98, ya: 99 }).late.why, /over 98¢/, 'a win at 99c pays almost nothing');
  assert.match(sig({ yb: 88, ya: 94 }).late.why, /doesn't agree/);
  assert.match(sig({ yb: 93, ya: 94, sigmaLong: SIG / 2 }).late.why, /faster than usual/);
  assert.match(sig({ yb: 93, ya: 94, askThen: 0.88 }).late.why, /just jumped/);
  assert.match(sig({ yb: 93, ya: 94, secs: 10 }).late.why, /waiting for 20 s/);
  const x = setup({ yb: 93, ya: 94 }); x.snap.lateOff = true;
  const off = buySignal(x.row, x.snap, t90, NOW, {});
  assert.equal(off.fire, false); assert.match(off.late.why, /losing money/);
});

test('the late lane on the accuracy card and in the Discord post', () => {
  const rows = accuracyRows({ bot: { graded: 50, wins: 47, usd: 3, late: { graded: 30, wins: 30, usd: 4.2, profitGuard: { paused: false } } } });
  const late = rows.find((r) => r.key === 'late');
  assert.equal(late.verdict, 'good'); assert.match(late.metric, /won 30 of 30/); assert.match(late.vs, /half size/);
  const off = accuracyRows({ bot: { graded: 50, wins: 47, usd: 3, late: { graded: 30, wins: 27, usd: -9, profitGuard: { paused: true } } } }).find((r) => r.key === 'late');
  assert.equal(off.verdict, 'bad'); assert.match(off.vs, /OFF/);
  const call = { ticker: 'T', side: 'YES', price: 0.94, conf: 99, at: NOW, closeTime: new Date(NOW + 180000).toISOString() };
  const e = callMessage(call, { late: true }).embeds[0];
  assert.match(e.title, /LATE/); assert.ok(e.fields.some((f) => f.name === 'Late lane'));
  assert.ok(!callMessage(call).embeds[0].title.includes('LATE'));
});
