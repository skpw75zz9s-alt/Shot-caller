import test from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_WEIGHTS, newPulse, publicPulse, pulseFix, pulseRound, pulseSecond, pulseSettle, pulseStatus } from '../public/pulse.js';
import { newLearned, publicLearned } from '../public/learner.js';

let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
// BTC whose real per-minute volatility is `trueSig` while the bot thinks it's `botSig`, one price a second
function run(P, secs, trueSig, botSig, t0 = 1_700_000_000_000, p0 = 100000) {
  let p = p0;
  for (let i = 0; i < secs; i++) { p *= Math.exp(trueSig / Math.sqrt(60) * gauss()); pulseSecond(P, { t: t0 + i * 1000, price: p, sigmaMin: botSig }); }
  return { t: t0 + secs * 1000, p };
}

test('every second: learns BTC is moving more than the bot expects, and switches the correction on once it helps', () => {
  const P = newPulse();
  run(P, 1800, 0.0012, 0.001);
  assert.equal(pulseFix(P), 1, 'not before an hour of grading');
  assert.ok(pulseStatus(P).needed > 0);
  run(P, 3 * 3600, 0.0012, 0.001, 1_700_000_000_000 + 1800 * 1000);
  const st = pulseStatus(P);
  assert.ok(st.expected > 1.1 && st.expected < 1.3, `expected ${st.expected}`);
  assert.equal(st.helping, true);
  assert.ok(pulseFix(P) > 1.1, String(pulseFix(P)));
  assert.equal(st.seconds, 1800 + 3 * 3600); assert.ok(st.graded > st.seconds - 120, 'every second after the first minute is graded');
});

test('when the bot\'s volatility is right, the correction stays near 1 and nothing changes', () => {
  const P = newPulse();
  run(P, 4 * 3600, 0.001, 0.001);
  assert.ok(Math.abs(pulseStatus(P).expected - 1) < 0.08, String(pulseStatus(P).expected));
  assert.ok(Math.abs(pulseFix(P) - 1) < 0.08);
});

test('seconds that repeat, missing prices and outages are handled', () => {
  const P = newPulse(), t = 1_700_000_000_000;
  assert.equal(pulseSecond(P, { t, price: 100000, sigmaMin: 0.001 }), true);
  assert.equal(pulseSecond(P, { t: t + 400, price: 100001, sigmaMin: 0.001 }), false, 'same second');
  assert.equal(pulseSecond(P, { t: t + 1000, price: null, sigmaMin: 0.001 }), false);
  pulseSecond(P, { t: t + 60000, price: 100000, sigmaMin: 0.001 });
  assert.equal(P.ring.length, 1, 'a gap over 10 seconds restarts the clock');
  assert.equal(P.n, 0);
});

test('Kalshi blend: every second of a round is scored after the result', () => {
  const P = newPulse();
  // Kalshi's price knew better than the bot: it was right every time
  for (let r = 0; r < 20; r++) {
    const yes = r % 2 === 0;
    for (let s = 0; s < 300; s++) pulseRound(P, { ticker: `T${r}`, closeTime: 1, pBot: 0.5, mid: yes ? 0.8 : 0.2 });
    assert.equal(pulseSettle(P, `T${r}`, yes ? 'yes' : 'no'), true);
  }
  const st = pulseStatus(P);
  assert.equal(st.blendRounds, 20);
  assert.equal(st.blendBest, 1, 'Kalshi alone scored best');
  assert.equal(st.blendLoss.length, BLEND_WEIGHTS.length);
  assert.equal(pulseSettle(P, 'nope', 'yes'), false);
  pulseRound(P, { ticker: 'short', closeTime: 1, pBot: 0.5, mid: 0.5 });
  assert.equal(pulseSettle(P, 'short', 'yes'), false, 'under a minute of seconds: not scored');
});

test('the phone gets the correction (not the per-second buffers) with the rest of what was learned', () => {
  const L = newLearned();
  assert.ok(L.pulse && L.pulse.v === 1);
  const pub = publicLearned(L);
  assert.deepEqual(Object.keys(pub.pulse).sort(), ['gain', 'n', 'v', 'z2']);
  assert.equal(pulseFix(publicPulse(L.pulse)), 1);
});
