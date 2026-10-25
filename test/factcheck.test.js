import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATES, factCheck, runsTest } from '../public/hires.js';

// n calls at a price, with a win pattern (i -> won?)
const calls = (n, { price = 0.6, side = 'yes', win = (i) => i % 10 < 6, t0 = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => { const w = win(i); return { side, price, result: w ? side : side === 'yes' ? 'no' : 'yes', at: t0 + i * 60000 }; });
const by = (c) => Object.fromEntries(factCheck(c).claims.map((x) => [x.key, x]));

test('under 30 calls: everything unproven', () => {
  const f = by(calls(20));
  assert.ok(Object.values(f).every((x) => x.verdict === 'unproven'));
});

test('a record winning 80% at 60¢: more than half TRUE, beats its prices TRUE', () => {
  const f = by(calls(200, { win: (i) => i % 5 !== 0 }));
  assert.equal(f.half.verdict, 'true'); assert.equal(f.edge.verdict, 'true');
  assert.match(f.half.why, /won 160 of 200 \(80\.0%/);
});

test('winning 85% at 90¢ is more than half, but it loses to its prices', () => {
  const f = by(calls(400, { price: 0.9, win: (i) => i % 20 > 2 }));
  assert.equal(f.half.verdict, 'true'); assert.equal(f.edge.verdict, 'false');
});

test('streaks: clumped results are TRUE, alternating ones FALSE, random-looking ones unproven', () => {
  assert.ok(runsTest(Array.from({ length: 60 }, (_, i) => Math.floor(i / 10) % 2 === 0)).z < -4);
  assert.equal(by(calls(60, { win: (i) => Math.floor(i / 10) % 2 === 0 })).streaks.verdict, 'true');
  assert.equal(by(calls(60, { win: (i) => i % 2 === 0 })).streaks.verdict, 'false');
  assert.equal(runsTest([true, false]).few, true);
});

test('getting better: a weak older half and a strong newer half is TRUE; the same record both halves is FALSE (no real difference) once there is enough', () => {
  assert.equal(by(calls(200, { win: (i) => (i < 100 ? i % 2 === 0 : i % 10 !== 0) })).better.verdict, 'true');
  const flat = by(calls(4000, { win: (i) => i % 10 < 6 }));
  assert.equal(flat.better.verdict, 'false'); assert.match(flat.better.why, /no real difference/);
});

test('UP vs DOWN: DOWN clearly ahead makes "UP beats DOWN" FALSE, the other way round', () => {
  const c = [...calls(100, { side: 'yes', win: (i) => i % 2 === 0 }), ...calls(100, { side: 'no', win: (i) => i % 10 !== 0, t0: 1e8 })];
  const f = by(c);
  assert.equal(f.updown.verdict, 'false'); assert.match(f.updown.why, /^the other way round/);
});

test('the hire: one line per claim, and settled claims are told to the Caller', () => {
  const hire = CANDIDATES.find((x) => x.key === 'facts');
  assert.equal(hire.fit({ calls: calls(40) }), null, 'not before 60 graded calls');
  assert.match(hire.fit({ calls: calls(60) }), /60 graded official calls/);
  const r = hire.row({ calls: calls(200, { win: (i) => i % 5 !== 0 }) });
  assert.match(r.status, /^✔ TRUE: The calls win more than half the time/);
  assert.ok(r.talks.some((t) => t.to === 'caller' && /^Proven true: "The calls win more than half the time"/.test(t.text)));
  assert.equal(hire.row({ calls: calls(10) }).state, 'idle');
});
