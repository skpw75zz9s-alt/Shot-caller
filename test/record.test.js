import test from 'node:test';
import assert from 'node:assert/strict';
import { callStats, logCall, settleCalls, unsettledCalls } from '../public/record.js';

const close = '2026-10-05T10:45:00Z';
const call = (o) => ({ ticker: 'T1', side: 'YES', price: 0.8, conf: 88, at: 1, closeTime: close, n: 1, ...o });

test('one entry per call; a switch is a new call', () => {
  const log = [];
  assert.equal(logCall(log, call()), true);
  assert.equal(logCall(log, call()), false, 'same call again (every render) is not logged twice');
  assert.equal(logCall(log, call({ side: 'NO', n: 2 })), true);
  assert.equal(logCall(log, call({ ticker: 'T2', price: 0 })), false, 'no price, no call');
  assert.equal(log.length, 2);
});

test('waits for close, grades on Kalshi result, scores claimed vs real win odds', () => {
  const log = [];
  logCall(log, call());
  logCall(log, call({ ticker: 'T2', side: 'NO', price: 0.9, conf: 93 }));
  logCall(log, call({ ticker: 'T3', price: 0.85, conf: 91 }));
  assert.equal(unsettledCalls(log, Date.parse(close)).length, 0, 'not before the market closes');
  assert.equal(unsettledCalls(log, Date.parse(close) + 120000).length, 3);
  settleCalls(log, 'T1', 'yes'); settleCalls(log, 'T2', 'no'); settleCalls(log, 'T3', 'no');
  const s = callStats(log);
  assert.equal(s.graded, 3);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.said - (88 + 93 + 91) / 3) < 1e-9);
  assert.deepEqual(Object.keys(s.buckets).sort(), ['80–89', '90+']);
  assert.equal(s.buckets['90+'].calls, 2);
  assert.equal(s.buckets['90+'].wins, 1);
  // $10 per call to settlement after fees: T1 +$2.50 - fee, T2 +$1.11 - fee, T3 -$10 - fee
  assert.ok(s.usd < -6 && s.usd > -7, `usd ${s.usd}`);
});

test('streaks and the daily record', async () => {
  const { streaks, dailyRecord } = await import('../public/record.js');
  const day = Date.parse('2026-10-08T15:00:00Z');
  const e = (side, result, dt = 0) => ({ side, result, closeTime: new Date(day - dt).toISOString() });
  const log = [e('YES', 'yes'), e('NO', 'no'), e('YES', 'no'), e('YES', 'yes'), e('NO', 'no'), e('YES', 'yes'), e('YES', 'unknown')];
  assert.deepEqual(streaks(log), { streak: { kind: 'W', n: 3 }, bestWin: 3 });
  assert.deepEqual(streaks([]), { streak: null, bestWin: 0 });
  const d = dailyRecord([...log, e('YES', 'no', 86400000)], 3, day, 'UTC');
  assert.deepEqual(d.map((x) => [x.w, x.l]), [[0, 0], [0, 1], [5, 1]]);
});
