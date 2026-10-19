import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STRENGTH, addSecond, newRound, scoreRound, strengthSummary, strengthWords } from '../public/strength.js';
import { createStrength } from '../strength.js';

const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test('every second scored against the result: the Brier score from running sums, overall and by stage', () => {
  const acc = newRound();
  addSecond(acc, { math: 0.6, blend: 0.65, final: 0.7, kalshi: 0.5 }, 12);
  addSecond(acc, { math: 0.8, blend: 0.85, final: 0.9, kalshi: null }, 0.5);
  const r = scoreRound(acc, 1, { ticker: 'T', close: 5 });
  assert.ok(near(r.b.final, ((0.3 ** 2) + (0.1 ** 2)) / 2)); assert.ok(near(r.b.kalshi, 0.25), 'Kalshi had one second');
  assert.ok(near(r.st.early.final, 0.09)); assert.ok(near(r.st.close.final, 0.01)); assert.equal(r.st.mid, undefined);
  assert.equal(r.n, 2); assert.equal(r.ticker, 'T');
  assert.ok(near(scoreRound(acc, 0).b.final, ((0.7 ** 2) + (0.9 ** 2)) / 2), 'a DOWN result grades the same seconds the other way');
});

// synthetic rounds: the bot misses a little less than Kalshi, and Kalshi a lot less than a coin flip
function rounds(n, { start = 0, final = 0.17, kalshi = 0.19, math = 0.2, spread = 0.03, seed = 3 } = {}) {
  let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2 * spread;
  return Array.from({ length: n }, (_, i) => { const k = r(); return { close: start + i * 900000, y: i % 2, n: 840, b: { math: math + k + r() * 0.3, blend: math + k + r() * 0.3, final: final + k + r() * 0.3, kalshi: kalshi + k + r() * 0.3 }, st: { late: { final: final + k, kalshi: kalshi + k } } }; });
}
test('the meter: daily skill, against a coin flip and Kalshi, judged round by round', () => {
  const now = Date.UTC(2026, 9, 19), rs = rounds(400, { start: now - 4 * 86400000 });
  const m = strengthSummary(rs, now);
  assert.equal(m.rounds, 400); assert.ok(m.daily.length >= 4);
  assert.ok(near(m.skill.final, 1 - (rs.reduce((a, r) => a + r.b.final, 0) / 400) / 0.25, 1e-9));
  assert.ok(m.coin.z < -STRENGTH.z, 'clearly better than a coin flip'); assert.ok(m.vsKalshi.z < -STRENGTH.z, 'and than Kalshi');
  assert.match(m.words[0], /^Stronger than a coin flip/); assert.match(m.words[1], /^Beats Kalshi's own price/);
  assert.equal(m.stages.find((s) => s.key === 'late').rounds, 400);
  const even = strengthSummary(rounds(200, { start: now - 86400000, final: 0.19, kalshi: 0.19 }), now);
  assert.match(even.words.join(' '), /Level with Kalshi's own price/);
  assert.match(strengthSummary(rounds(10), now).words[0], /Still measuring: 10 of the 30/);
});

test('getting stronger only when the last week is clearly better than the week before', () => {
  const now = Date.UTC(2026, 9, 19), D = 86400000;
  const before = rounds(300, { start: now - 13 * D, final: 0.2 }), after = rounds(300, { start: now - 6 * D, final: 0.16, seed: 9 });
  const m = strengthSummary([...before, ...after], now);
  assert.ok(m.trend.z > STRENGTH.z); assert.match(m.words.join(' '), /Getting stronger/); assert.match(m.words.join(' '), /Judged on the last 7 days/);
  assert.match(strengthSummary([...rounds(300, { start: now - 13 * D }), ...rounds(300, { start: now - 6 * D, seed: 9 })], now).words.join(' '), /No clear change/);
});

test('what each stage added: the Kalshi blend and the council, only when they did something', () => {
  const w = strengthWords({ rounds: 100, base: 100, coin: { z: -3, diff: -0.05, n: 100 }, vsKalshi: null, trend: null, steps: { blend: { diff: -0.01, z: -2.5, n: 100 }, council: { diff: 0.002, z: 0.4, n: 100 } } });
  assert.match(w.join(' '), /Mixing in Kalshi's price clearly helped/); assert.match(w.join(' '), /The council's nudges: no clear effect yet/);
  assert.doesNotMatch(strengthWords({ rounds: 100, base: 100, coin: { z: 0, diff: 0, n: 100 }, steps: { blend: { diff: 0, z: 0 } } }).join(' '), /Mixing/, 'a stage that changed nothing says nothing');
});

test('the server samples once a second, scores at settlement and keeps the rounds', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'str-')), 'strength.json');
  let now = 1e12; const s = createStrength({ file, clock: () => now, log: { error() {} } });
  const row = (p) => ({ m: { ticker: 'T1', close_time: new Date(now + 300000).toISOString() }, pBot: p - 0.05, pPre: p - 0.02, ev: { minutesLeft: 5, pYes: p, quote: { yesBid: 0.5, yesAsk: 0.54 } } });
  s.observe('S', { rows: [row(0.7)] }); s.observe('S', { rows: [row(0.1)] }); // the same second: sampled once
  now += 1000; s.observe('S', { rows: [row(0.8)] });
  s.settle('S', 'T1', 'yes'); await s.save();
  const r = s.api('S');
  assert.equal(r.rounds, 1); assert.ok(near(r.daily[0].final, 1 - ((0.3 ** 2 + 0.2 ** 2) / 2) / 0.25));
  s.settle('S', 'nope', 'yes'); s.stop();
  const again = createStrength({ file, log: { error() {} } }); await again.load();
  assert.equal(again.api('S').rounds, 1); again.stop();
});
