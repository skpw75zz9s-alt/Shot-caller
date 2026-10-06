import test from 'node:test';
import assert from 'node:assert/strict';
import { basisOf, calShift, calTable, learnBasis, learnCandles, learnWindow, newLearned, slotLabel, slotOf, volFactor, volProfile } from '../public/learner.js';
import { snapshot } from '../public/engine.js';
import { DEFAULTS } from '../public/model.js';

test('half hours of the week are in New York time (DST included)', () => {
  assert.equal(slotLabel(slotOf(Date.parse('2026-10-06T13:30:00Z'))), 'Tue 9:30 AM ET'); // EDT
  assert.equal(slotLabel(slotOf(Date.parse('2026-12-08T14:30:00Z'))), 'Tue 9:30 AM ET'); // EST
  assert.equal(slotOf(Date.parse('2026-10-04T04:00:00Z')), 0, 'Sunday midnight ET');
});

// Four weeks of candles where 9:30-10:00 ET on weekdays is 3x as wild as the rest of the week
function trained() {
  const L = newLearned();
  const start = Date.parse('2026-09-06T04:00:00Z'); // Sun 00:00 ET
  let c = 85000, x = 12345;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
  const candles = [];
  for (let t = start; t < start + 28 * 86400000; t += 60000) {
    const slot = slotOf(t), day = Math.floor(slot / 48), hh = slot % 48;
    const sig = day > 0 && day < 6 && hh === 19 ? 0.0006 : 0.0002;
    c *= Math.exp(sig * rnd() * Math.sqrt(12));
    candles.push({ t, c });
  }
  assert.equal(learnCandles(L, candles), candles.length - 1);
  assert.equal(learnCandles(L, candles), 0, 'the same candles are never learned twice');
  return L;
}

test('learns volatility by time of week and prices the coming minutes with it', () => {
  const L = trained();
  const p = volProfile(L);
  assert.equal(slotLabel(p.busiest.slot).slice(4), '9:30 AM ET');
  const beforeOpen = Date.parse('2026-10-06T13:25:00Z'); // Tue 9:25 ET, window runs to 9:40
  const f = volFactor(L, beforeOpen, beforeOpen + 15 * 60000);
  assert.ok(f > 1.4, `the open is coming: ${f}`);
  const afterOpen = Date.parse('2026-10-06T14:05:00Z');
  assert.ok(volFactor(L, afterOpen, afterOpen + 10 * 60000) < 0.9, 'the open is over: calmer ahead than the last 30 min');
  const quiet = Date.parse('2026-10-04T08:00:00Z');
  assert.ok(Math.abs(volFactor(L, quiet, quiet + 600000) - 1) < 0.1, 'nothing special at 4am Sunday');
  assert.equal(volFactor(newLearned(), beforeOpen, beforeOpen + 600000), 1, 'no history: no change');
});

test('calibration: no correction while the bot is right, a capped one after a real lasting miss', () => {
  const L = newLearned();
  for (let i = 0; i < 400; i++) learnWindow(L, Array(10).fill(0.88), i % 100 < 88 ? 'yes' : 'no');
  assert.equal(calShift(L, 0.88), 0, 'won 88% when it said 88%');
  const M = newLearned();
  for (let i = 0; i < 400; i++) learnWindow(M, Array(10).fill(0.12), i % 100 < 75 ? 'no' : 'yes'); // said 88% NO, won 75%
  const s = calShift(M, 0.12);
  assert.ok(s > 0.04 && s <= 0.05, `pulls NO back toward 75%: ${s}`);
  assert.equal(calShift(M, 0.55), 0, 'other odds untouched');
  const n = calTable(M).find((b) => b.from === 0.85).n;
  assert.ok(n > 350 && n <= 400, `a window counts once, not once per sample (old ones fade slowly): ${n}`);
});

test('basis: median of sane settlements, ignored until 10', () => {
  const L = newLearned();
  for (let i = 0; i < 9; i++) learnBasis(L, 85012 + (i % 3), 85000);
  assert.equal(basisOf(L), 0);
  learnBasis(L, 85013, 85000);
  assert.equal(learnBasis(L, 95000, 85000), false, 'a broken read is not a basis');
  assert.equal(basisOf(L), 13);
});

test('the engine uses what was learned (and can be told not to)', () => {
  const L = newLearned();
  for (let i = 0; i < 10; i++) learnBasis(L, 85030, 85000); // Kalshi's index runs $30 over Coinbase
  const now = Date.parse('2026-10-06T15:10:00Z');
  const m = { ticker: 'T', open_time: '2026-10-06T15:00:00Z', close_time: '2026-10-06T15:15:00Z', floor_strike: 85010, strike_type: 'greater', yes_ask_dollars: '0.5', yes_bid_dollars: '0.48' };
  const candles = Array.from({ length: 120 }, (_, i) => ({ t: now - (120 - i) * 60000, o: 85000, h: 85020, l: 84980, c: 85000 + (i % 2 ? 8 : -8) }));
  const a = snapshot({ markets: [m], candles, spot: 85000, settings: DEFAULTS, now });
  const b = snapshot({ markets: [m], candles, spot: 85000, settings: DEFAULTS, learned: L, now });
  const c = snapshot({ markets: [m], candles, spot: 85000, settings: { ...DEFAULTS, learn: false }, learned: L, now });
  assert.ok(a.rows[0].ev.pYes < 0.5 && b.rows[0].ev.pYes > 0.5, `Coinbase is $10 under the target but the index is $20 over: ${a.rows[0].ev.pYes} -> ${b.rows[0].ev.pYes}`);
  assert.equal(b.rows[0].learnedAdj.basis, 30);
  assert.equal(c.rows[0].ev.pYes, a.rows[0].ev.pYes);
});
