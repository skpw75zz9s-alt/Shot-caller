import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATES, hireRows, recordMath } from '../public/hires.js';
import { pnl10 } from '../public/model.js';

const calls = (wins, n, price = 0.5) => Array.from({ length: n }, (_, i) => ({ side: 'YES', price, result: i < wins ? 'yes' : 'no', at: 1e12 + i }));

test('the money math is exact: totals, average and breakeven come straight from each call\'s price and fee', () => {
  const m = recordMath(calls(30, 40, 0.6));
  const w = pnl10(0.6, true), l = pnl10(0.6, false);
  assert.equal(m.n, 40); assert.equal(m.wins, 30);
  assert.ok(Math.abs(m.total - (30 * w + 10 * l)) < 1e-9);
  assert.ok(Math.abs(m.mean - m.total / 40) < 1e-9);
  assert.ok(Math.abs(m.breakeven - -l / (w - l)) < 1e-12, 'the win rate at which a win and a loss cancel out');
  assert.ok(m.breakeven > 0.6, 'fees push breakeven above the price');
});

test('the 95% range is Wilson\'s: 50 of 100 gives 40.4%-59.6%', () => {
  const m = recordMath(calls(50, 100));
  assert.ok(Math.abs(m.lo - 0.4038) < 1e-3 && Math.abs(m.hi - 0.5962) < 1e-3, `${m.lo} ${m.hi}`);
});

test('proven only when the whole range clears breakeven; Kelly only once proven', () => {
  assert.equal(recordMath(calls(35, 40)).verdict, 'ahead');
  assert.ok(recordMath(calls(35, 40)).kelly > 0);
  assert.equal(recordMath(calls(5, 40)).verdict, 'behind');
  const open = recordMath(calls(22, 40));
  assert.equal(open.verdict, 'open'); assert.equal(open.kelly, 0); assert.ok(open.more > 0, 'and how many more calls it would take');
  assert.equal(recordMath(calls(18, 20)).verdict, 'few', 'under 30 calls proves nothing');
  assert.deepEqual(recordMath([]), { n: 0 });
});

test('on the team: reports the record and tells the Risk officer and the Trader once it\'s proven', () => {
  const c = CANDIDATES.find((x) => x.key === 'math');
  assert.equal(c.fit({ calls: calls(3, 5) }), null);
  assert.match(c.fit({ calls: calls(20, 40) }), /40 graded official calls/);
  const [row] = hireRows(['math'], { now: 2e12, calls: calls(35, 40), trials: {} });
  assert.match(row.status, /Won 35 of 40 \(87\.5%, 95% range/);
  assert.match(row.status, /proven ahead of its prices · Kelly stake/);
  assert.deepEqual(row.talks.map((t) => t.to), ['risk', 'trader']);
  const [bad] = hireRows(['math'], { now: 2e12, calls: calls(5, 40), trials: {} });
  assert.equal(bad.state, 'warn');
});
