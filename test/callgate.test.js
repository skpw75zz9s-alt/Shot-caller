import test from 'node:test';
import assert from 'node:assert/strict';
import { callFeatures, gateCheck, learnGate } from '../public/callgate.js';
import { BLEND_WEIGHTS, newPulse, pulseBlend } from '../public/pulse.js';

let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
// calls where late, jumpy-market calls lose a lot more than the rest
function record(n, lateLoses = true) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const mins = 2 + rnd() * 10, vr = 0.7 + rnd() * 1.2, price = 0.82 + rnd() * 0.08, conf = 86 + Math.floor(rnd() * 10);
    const bad = lateLoses && mins < 4 && vr > 1.4;
    const won = rnd() < (bad ? 0.55 : 0.95);
    out.push({ ticker: `T${i}`, side: 'YES', price, conf, at: i * 900000, result: won ? 'yes' : 'no', feat: { mins, stab: 60, vr } });
  }
  return out;
}

test('call filter: learns the losing kind of call and switches on only when the replay proves skipping them helped', () => {
  const g = learnGate(record(400));
  assert.equal(g.active, true, JSON.stringify(g.replay));
  assert.ok(g.replay.skippedPnl < 0 && g.replay.skippedWin < g.replay.keptWin);
  const late = gateCheck(g, { conf: 90, mins: 2.5, stab: 60, vr: 1.8 }, 0.86), early = gateCheck(g, { conf: 90, mins: 10, stab: 60, vr: 1 }, 0.86);
  assert.equal(late.skip, true, `late jumpy call: ${late.pWin}`);
  assert.equal(early.skip, false, `early calm call: ${early.pWin}`);
});

test('call filter stays off when nothing in the calls predicts losses, and with too few calls', () => {
  const g = learnGate(record(400, false));
  assert.equal(g.active, false, JSON.stringify(g.replay));
  assert.equal(gateCheck(g, { conf: 90, mins: 2.5, stab: 60, vr: 1.8 }, 0.86), null);
  assert.equal(learnGate(record(50)).active, false);
  assert.equal(learnGate(record(400).map(({ feat, ...e }) => e)).n, 0, 'old calls without features are left out');
  assert.equal(callFeatures({ conf: null, price: 0.8 }), null);
});

test('Kalshi blend: used only once 150 rounds show a blend clearly beats the bot alone', () => {
  const P = newPulse();
  assert.deepEqual(pulseBlend(P), { use: false, w: 0, rounds: 0 });
  P.blend.rounds = 200; P.blend.loss = BLEND_WEIGHTS.map((w) => 200 * (0.3 - 0.1 * w + 0.12 * w * w)); // best around 40%
  const b = pulseBlend(P);
  assert.equal(b.use, true); assert.ok(b.w >= 0.3 && b.w <= 0.5, String(b.w));
  P.blend.rounds = 100;
  assert.equal(pulseBlend(P).use, false, 'not before 150 rounds');
  P.blend.rounds = 200; P.blend.loss = BLEND_WEIGHTS.map((w) => 200 * (0.3 + 0.01 * w));
  assert.equal(pulseBlend(P).use, false, 'the bot alone scores best');
});
