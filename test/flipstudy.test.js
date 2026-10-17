import test from 'node:test';
import assert from 'node:assert/strict';
import { FLIP_GATES, flipFeatures, flipGateOk, flipSamples, liveFlipFeatures, studyFlips } from '../public/flipstudy.js';

const T0 = Date.UTC(2026, 9, 1); // a round boundary
// 3 hours of quiet bars, then one round where price is above the target at 10:00 left and falls well below it
function bars({ drop = 0.004, at = 7 } = {}) {
  const out = []; let p = 100000;
  for (let i = 0; i < 180; i++) { const o = p; p *= 1 + 0.0003 * Math.sin(i * 1.7); out.push({ t: T0 - (180 - i) * 60000, o, h: Math.max(o, p) * 1.0001, l: Math.min(o, p) * 0.9999, c: p }); }
  const K = p;
  for (let k = 0; k < 15; k++) { const o = p; p = k < at ? K * (1 + 0.0004 * Math.min(k + 1, 3)) : K * (1 - drop); out.push({ t: T0 + k * 60000, o, h: Math.max(o, p) * 1.0001, l: Math.min(o, p) * 0.9999, c: p }); }
  return { bars: out, K };
}

test('the replay: the side ahead at 10:00 left is locked, the first minute the other side reaches the bar is the flip', () => {
  const { bars: b } = bars();
  const s = flipSamples(b, { lastMin: 1 });
  assert.equal(s.length, 1);
  assert.equal(s[0].side, 'NO'); assert.equal(s[0].won, true, 'the round closed below the target');
  // the crossing minute also lifts the volatility, so the worst case reaches 90% a little after it, not on it
  assert.ok(s[0].f.left <= 7, `flagged at or after the crossing (${s[0].f.left} left)`);
  assert.equal(s[0].f.crossAge, 7 - s[0].f.left + 1, 'every minute since the crossing on the new side');
  assert.ok(s[0].f.spike < 1, 'the flagged minute itself was quiet');
  assert.equal(flipSamples(b, { lastMin: 8 }).length, 0, 'outside the lane\'s window: no flip');
  assert.equal(flipSamples(bars({ drop: 0.00002 }).bars, { lastMin: 1 }).length, 0, 'a crossing too small for 90% worst case: no flip');
});

test('features and the rules read the same way live as in the replay', () => {
  const f = flipFeatures({ closes: [100, 101, 102, 99, 98], last: { o: 99, c: 98, h: 99.5, l: 97.5 }, strike: 100, side: 'NO', sigma: 0.002, ratio: 1.2, left: 6 });
  assert.equal(f.crossAge, 2); assert.equal(f.left, 6); assert.ok(f.mom3 > 0, 'pushing down, toward NO');
  assert.ok(Math.abs(f.rejWick - 0.5 / (98 * 0.002)) < 1e-9, 'NO: the low wick is the push back toward the target');
  assert.equal(flipGateOk({ key: 'crossAge', op: '>=', v: 2 }, f), true); assert.equal(flipGateOk({ key: 'crossAge', op: '>=', v: 3 }, f), false);
  assert.equal(flipGateOk(null, f), true); assert.equal(flipGateOk(FLIP_GATES[0], null), true, 'nothing to read: never blocks');
  const live = liveFlipFeatures({ bars: [{ t: 0, o: 100, c: 101, h: 101, l: 100 }, { t: 60000, o: 101, c: 99, h: 101, l: 98.5 }, { t: 120000, o: 99, c: 98, h: 99, l: 98 }], spot: 98, strike: 100, side: 'NO', sigmaMin: 0.002, sigmaLong: 0.002, minutesLeft: 6, openTime: 60000 });
  assert.equal(live.crossAge, 2, 'the forming minute (live price) plus the last closed one; the minute before the open counts, none earlier');
});

test('the study picks the rule on older flips and proves it only on newer ones it never saw', () => {
  // spike flips (one minute did the crossing) lose 6 in 10; the rest win 97 in 100
  let n = 0; const mk = (spike) => { n++; const won = spike ? n % 10 < 4 : n % 100 !== 0; return { t: n, side: 'YES', won, f: { left: 7, z: 2, crossAge: spike ? 1 : 3, spike: spike ? 3 : 0.5, mom3: 1, volRatio: 1, rejWick: 0.1 } }; };
  const s = [...Array(600)].map((_, i) => mk(i % 4 === 0));
  const r = studyFlips(s, { laneLastMin: 5 });
  assert.ok(r.gate, 'a rule was found'); assert.ok(['spike', 'crossAge'].includes(r.gate.key), r.gate.label);
  assert.equal(r.proven, true);
  assert.ok(r.gate.test.kept.wins / r.gate.test.kept.n > 0.95 && r.gate.test.blocked.wins / r.gate.test.blocked.n < 0.5);
  assert.equal(r.lane.n, 600, 'all at 7 minutes left: inside the lane');
  // no pattern: nothing is proven
  let m = 0; const flat = [...Array(600)].map(() => { m++; return { t: m, side: 'YES', won: m % 10 !== 0, f: { left: 7, z: 2, crossAge: 1 + (m % 3), spike: (m % 5) / 2, mom3: (m % 7) / 7 - 0.3, volRatio: 1 + (m % 4) / 4, rejWick: (m % 6) / 6 } }; });
  assert.equal(studyFlips(flat).proven, false);
});

test('late flips: allowed only down to the minute history proves they hold, in both halves', () => {
  // flips at 4 and 3 minutes left win 96 in 100; at 2 left only 80 in 100
  let n = 0; const s = [];
  for (let i = 0; i < 300; i++) for (const left of [6, 4, 3, 2]) { n++; s.push({ t: n, side: 'YES', won: left === 2 ? n % 5 !== 0 : n % 25 !== 0, f: { left, z: 2, crossAge: 3, spike: 0.5, mom3: 1, volRatio: 1, rejWick: 0.1 } }); }
  const r = studyFlips(s, { laneLastMin: 5 });
  assert.equal(r.late.lastMin, 3, 'down to 3 minutes; 2 isn\'t proven');
  assert.deepEqual(r.late.bands.map((b) => [b.lastMin, b.ok]), [[4, true], [3, true], [2, false]]);
  assert.equal(r.lane.n, 300, 'the lane: 5+ minutes left');
  const few = studyFlips(s.slice(0, 40), { laneLastMin: 5 });
  assert.equal(few.late.lastMin, null, 'too few late flips: the last-minutes rule stands');
});
