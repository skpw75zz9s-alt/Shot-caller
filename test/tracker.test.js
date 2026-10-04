import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeWindow, mergeReports, newTracker, pendingWindows, summarize, trackWindow } from '../public/tracker.js';

const OPEN = 1_700_000_040_000, CLOSE = OPEN + 15 * 60000;
const m = { ticker: 'W1', title: 'BTC up?', open_time: new Date(OPEN).toISOString(), close_time: new Date(CLOSE).toISOString() };
const snap = { bars: [] };
// One sample: bot P(YES), its call (null = no call), and Kalshi quotes
function feed(tr, t, pYes, call, q) {
  const ev = { pYes, side: call, minutesLeft: (CLOSE - t) / 60000, quote: q };
  return trackWindow(tr, { ...snap, now: t }, { m, ev, strike: 100000 }, { confident: !!call, deep: { score: 70 } }, {}, t);
}
const Q = (yb, ya) => ({ yesBid: yb, yesAsk: ya, noBid: 1 - ya, noAsk: 1 - yb });

test('samples at most every 5 seconds and stops at close', () => {
  const tr = newTracker();
  assert.equal(feed(tr, OPEN + 1000, 0.5, null, Q(0.48, 0.5)), true);
  assert.equal(feed(tr, OPEN + 3000, 0.5, null, Q(0.48, 0.5)), false);
  assert.equal(feed(tr, OPEN + 6000, 0.5, null, Q(0.48, 0.5)), true);
  assert.equal(feed(tr, CLOSE + 1, 0.5, null, Q(0.48, 0.5)), false);
  assert.equal(tr.windows.W1.samples.length, 2);
});

test('scores the whole window, not the first call', () => {
  const tr = newTracker();
  // First 5 minutes the bot leans NO (wrong), then switches to YES for 10 minutes and the window settles YES
  for (let i = 0; i < 60; i++) feed(tr, OPEN + i * 5000, 0.4, null, Q(0.45, 0.47));
  for (let i = 60; i < 180; i++) feed(tr, OPEN + i * 5000, 0.72, null, Q(0.6, 0.62));
  const r = gradeWindow(tr, 'W1', 'yes');
  assert.ok(Math.abs(r.timeRight - 120 / 180) < 0.01);
  assert.ok(Math.abs(r.avgWinnerOdds - (60 * 0.4 + 120 * 0.72) / 180) < 0.01);
  assert.equal(r.flips, 1);
  assert.equal(r.grade, undefined, 'no letter grades');
  assert.ok(r.coverage > 0.99);
  assert.ok(r.spark.length <= 41 && r.spark[0][0] === 0);
  assert.equal(tr.windows.W1, undefined);
});

test('follow-the-bot paper trades: enter on call, cash out on flip, settle the rest', () => {
  const tr = newTracker();
  feed(tr, OPEN + 60000, 0.65, 'YES', Q(0.48, 0.50));          // buy YES at 50
  feed(tr, OPEN + 120000, 0.66, 'YES', Q(0.52, 0.54));         // hold
  feed(tr, OPEN + 180000, 0.30, 'NO', Q(0.40, 0.42));          // call flips: cash out YES at 40, buy NO at 60
  const w = tr.windows.W1;
  assert.equal(w.trades.length, 1);
  assert.equal(w.trades[0].how, 'flipped');
  assert.equal(w.paper.side, 'NO');
  assert.equal(w.paper.price, 0.6);
  const r = gradeWindow(tr, 'W1', 'no');                         // NO settles at $1
  assert.equal(r.calls, 2);
  assert.equal(r.trades[1].how, 'settled');
  const expected = (0.40 - 0.02 - 0.52) + (1 - 0.62);           // after fees on each side
  assert.ok(Math.abs(r.paperPts - expected) < 1e-9);
  assert.ok(r.paperUsd > 0);
  assert.ok(Math.abs(r.callsRight - 1 / 3) < 0.001); // stored to 3 decimals
});

test('take-profit exits, then waits before re-entering the same side', () => {
  const tr = newTracker();
  feed(tr, OPEN + 60000, 0.65, 'YES', Q(0.38, 0.40));
  feed(tr, OPEN + 65000, 0.66, 'YES', Q(0.70, 0.72));            // bid above bot odds: take profit
  assert.equal(tr.windows.W1.trades[0].how, 'take');
  feed(tr, OPEN + 70000, 0.80, 'YES', Q(0.70, 0.72));
  assert.equal(tr.windows.W1.paper, null, 'no instant re-entry');
  feed(tr, OPEN + 130000, 0.80, 'YES', Q(0.70, 0.72));
  assert.equal(tr.windows.W1.paper.side, 'YES');
});

test('pending, summary and merge', () => {
  const tr = newTracker();
  feed(tr, OPEN + 1000, 0.6, null, Q(0.5, 0.52));
  assert.equal(pendingWindows(tr, CLOSE + 30000).length, 0);
  assert.equal(pendingWindows(tr, CLOSE + 61000).length, 1);
  const r = gradeWindow(tr, 'W1', 'yes');
  const s = summarize([r, { ...r, ticker: 'W2', avgWinnerOdds: 0.4, paperUsd: -2, calls: 1 }]);
  assert.equal(s.windows, 2);
  assert.ok(Math.abs(s.avgWinnerOdds - (r.avgWinnerOdds + 0.4) / 2) < 1e-9);
  assert.equal(s.grades, undefined);
  const merged = mergeReports([{ ticker: 'A', coverage: 0.3, closeTime: 1 }], [{ ticker: 'A', coverage: 0.9, closeTime: 1 }, { ticker: 'B', coverage: 1, closeTime: 2 }]);
  assert.deepEqual(merged.map((x) => [x.ticker, x.coverage]), [['B', 1], ['A', 0.9]]);
});
