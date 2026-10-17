import test from 'node:test';
import assert from 'node:assert/strict';
import { LAB, LESSONS, causeTally, contextOf, deepDive, lessonStudy, lessonsFor } from '../public/losslab.js';
import { resultMessage, pickMessage } from '../discord.js';

const T0 = Date.UTC(2026, 9, 1, 12), MIN = 60000;

test('the context at a call points toward the side, for above- and below-the-target markets', () => {
  const bars = [0, 1, 2, 3, 4].map((i) => ({ t: T0 - (5 - i) * MIN, c: 100 + i * 0.1 }));
  const up = contextOf({ side: 'YES', kalshi: 0.62, pBot: 0.7, spot: 100.4, strike: 100, sigma: 0.001, minutesLeft: 9, bars, now: T0, sigmaMin: 0.0012, sigmaLong: 0.001, flip: 0.2, flow: 30 });
  assert.ok(up.z > 1 && up.mom > 0 && Math.abs(up.gap - 0.08) < 1e-9 && up.vr === 1.2 && up.flow === 30);
  const dn = contextOf({ side: 'NO', spot: 100.4, strike: 100, sigma: 0.001, minutesLeft: 9, bars, now: T0 });
  assert.ok(dn.z < -1 && dn.mom < 0, 'the other side: the same distance counts against it');
  const below = contextOf({ side: 'YES', spot: 100.4, strike: 100, sigma: 0.001, minutesLeft: 9, strikeType: 'less', bars, now: T0 });
  assert.ok(below.z < 0, 'YES on a below-the-target market wins under the strike');
});

test('the deep dive names why a call lost', () => {
  const close = T0 + 10 * MIN, mk = (xs) => xs.map((c, i) => ({ t: T0 + i * MIN, c }));
  const base = { side: 'YES', strike: 100, at: T0, closeTime: new Date(close).toISOString(), sigma: 0.001, result: 'no' };
  const late = deepDive({ ...base, ctx: { z: 1.2 } }, mk([100.05, 100.1, 100.15, 100.2, 100.18, 100.15, 100.1, 100.05, 99.98, 99.95]));
  assert.ok(late.causes.some((c) => c.key === 'lateTurn'), JSON.stringify(late));
  assert.ok(late.maxFav >= 1.9 && late.lastCross <= 3);
  const never = deepDive({ ...base, ctx: { z: 0.1, kalshi: 0.4, flow: -40 } }, mk([99.99, 99.97, 99.95, 99.96, 99.94, 99.9, 99.92, 99.9, 99.88, 99.9]));
  assert.deepEqual(never.causes.map((c) => c.key).slice(0, 4), ['tooClose', 'neverAhead', 'market', 'flow']);
  const spike = deepDive({ ...base, ctx: { z: 0.8 } }, mk([100, 100.3, 99.8, 100.4, 99.7, 100.2, 99.6, 100.1, 99.7, 99.9]));
  assert.ok(spike.causes.some((c) => c.key === 'spike') && spike.speed >= 1.8);
  const luck = deepDive({ ...base, p: 0.7, ctx: { z: 0.9 } }, mk([100.05, 100.06, 100.07, 100.06, 100.05, 100.04, 100.03, 100.02, 100.01, 100.0]));
  assert.ok(luck.causes.some((c) => c.key === 'luck') || luck.causes.length, 'always a reason');
  assert.equal(causeTally([{ review: never }, { review: late }])[0].n >= 1, true);
});

// graded round calls: `rate` of those matching `ctx` won, the rest won 60%
function record(n, { ctx, rate, other = { z: 1 }, seed = 5 }) {
  let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return [...Array(n)].map((_, i) => { const hit = i % 3 === 0, win = r() < (hit ? rate : 0.6); return { side: 'YES', result: win ? 'yes' : 'no', at: T0 + i * 900000, p: 0.65, price: 0.6, ctx: hit ? ctx : other }; });
}

test('a lesson is proven only when the record clearly says so, in both halves', () => {
  const bad = lessonStudy(record(300, { ctx: { z: 1, kalshi: 0.35 }, rate: 0.25 }), 'flip');
  const m = bad.lessons.find((x) => x.id === 'marketAgainst');
  assert.ok(m.proven && m.n === 100 && m.rate < 0.4 && m.z >= LAB.z, JSON.stringify(m));
  assert.deepEqual(bad.active, ['marketAgainst']);
  assert.deepEqual(lessonsFor(bad, { kalshi: 0.4 }).map((x) => x.id), ['marketAgainst']); assert.deepEqual(lessonsFor(bad, { kalshi: 0.6 }), []);
  const coin = lessonStudy(record(300, { ctx: { z: 1, kalshi: 0.35 }, rate: 0.5, seed: 9 }), 'flip');
  assert.deepEqual(coin.active, [], 'losing half the time is a coin flip, not a lesson');
  const few = lessonStudy(record(45, { ctx: { z: 1, kalshi: 0.35 }, rate: 0.1 }), 'flip');
  assert.deepEqual(few.active, [], 'too few calls');
  // a lesson already applied: judged as the call it would have been, so it stays proven
  const applied = record(300, { ctx: { z: 1, kalshi: 0.35 }, rate: 0.25 }).map((e) => (e.ctx.kalshi === 0.35 ? { ...e, side: 'NO', result: e.result, orig: { side: 'YES', ctx: e.ctx }, ctx: { z: -1, kalshi: 0.65 } } : e));
  assert.deepEqual(lessonStudy(applied, 'flip').active, ['marketAgainst']);
});

test('calls worth buying: a lesson skips them when they win less often than their price needs', () => {
  const xs = record(240, { ctx: { z: 1, vr: 1.8 }, rate: 0.5, other: { z: 1, vr: 1 } }).map((e) => ({ ...e, price: 0.85 }));
  const st = lessonStudy(xs, 'skip'), j = st.lessons.find((x) => x.id === 'jumpy');
  assert.ok(j.proven && j.need > 0.85, JSON.stringify(j));
});

test('the engine skips a call a proven lesson rules out, and says so', async () => {
  const { evaluate, riskSettings } = await import('../public/model.js');
  const { buySignal } = await import('../public/engine.js');
  const NOW = 1_700_000_040_000, K = 100000, SIG = 0.0002, s = riskSettings('target90');
  const bars = [...Array(30)].map((_, i) => ({ t: NOW - (30 - i) * 60000, o: 100000, c: 100002, h: 100010, l: 99992 }));
  const m = { ticker: 'T', close_time: new Date(NOW + 8 * 60000).toISOString(), strike_type: 'greater', floor_strike: K, yes_bid: 90, yes_ask: 91 };
  const ev = evaluate({ market: m, strike: K, spot: K + 250, sigmaMin: SIG, now: NOW });
  const log = { T: [...Array(36)].map((_, i) => ({ t: NOW - 70000 + i * 2000, p: 0.99, yesAsk: null, noAsk: null })) };
  const snap = { now: NOW, bars, sigmaMin: SIG, sigmaLong: SIG, driftMin: 0, spot: K + 250, quoteLog: log, earlyLive: true };
  const row = { m, strike: K, ev, rej: { tilt: 0, summary: [], events: [] } };
  assert.ok(buySignal(row, snap, s, NOW, {}).fire, 'fires without lessons');
  const calm = { ...snap, sigmaLong: SIG * 2 }; // volatility at half its 2-hour norm: a "dead-calm market"
  assert.ok(buySignal(row, calm, s, NOW, {}).fire, 'calm alone isn\'t a reason');
  const blocked = buySignal(row, { ...calm, lessons: ['calm'] }, s, NOW, {});
  assert.equal(blocked.fire, false); assert.equal(blocked.gated?.lesson?.id, 'calm');
  assert.ok(buySignal(row, { ...calm, lessons: ['jumpy'] }, s, NOW, {}).fire, 'a lesson that doesn\'t match changes nothing');
});

test('Discord: why a call lost, and a round call a lesson turned', () => {
  const e = { ticker: 'KXBTC15M-26OCT011215-15', side: 'YES', price: 0.9, result: 'no', at: T0, review: { summary: 'Late turn: it was winning by 1.4 typical moves and turned in the last 2 minutes' } };
  const f = resultMessage(e).embeds[0].fields.find((x) => x.name === 'Why it lost');
  assert.match(f.value, /Late turn/);
  assert.equal(resultMessage({ ...e, result: 'yes' }).embeds[0].fields.some((x) => x.name === 'Why it lost'), false);
  const pk = pickMessage({ ...e, p: 0.62, closeTime: new Date(T0 + 600000).toISOString(), orig: { side: 'NO' }, lessons: ['Kalshi disagreed'], strike: 100000 }, { prev: e }).embeds[0];
  assert.match(pk.title, /ROUND CALL/); assert.match(pk.description, /lesson from past losses turned it from DOWN: Kalshi disagreed/);
  assert.match(pk.fields.find((x) => x.name === 'Last pick').value, /Why: Late turn/);
});
