import test from 'node:test';
import assert from 'node:assert/strict';
import { allowAlert, hourlyWindow } from '../public/notify.js';

const M = 60000, T0 = Date.parse('2026-10-05T10:00:00Z');

test('buy alerts: at most 2 per market, 3+ minutes apart', () => {
  const log = {};
  assert.equal(allowAlert(log, 'buy', { ticker: 'A', now: T0 }), true);
  assert.equal(allowAlert(log, 'buy', { ticker: 'A', now: T0 + 30000 }), false, 're-entry 30s later: held back');
  assert.equal(allowAlert(log, 'buy', { ticker: 'A', now: T0 + 4 * M }), true);
  assert.equal(allowAlert(log, 'buy', { ticker: 'A', now: T0 + 9 * M }), false, 'third call on the same market');
  assert.equal(allowAlert(log, 'buy', { ticker: 'B', now: T0 + 15 * M }), true, 'next market is fresh');
});

test('adds once per market; everything but sells is capped at 6 an hour', () => {
  const log = {};
  assert.equal(allowAlert(log, 'add', { ticker: 'A', now: T0 }), true);
  assert.equal(allowAlert(log, 'add', { ticker: 'A', now: T0 + M }), false);
  for (let i = 0; i < 5; i++) assert.equal(allowAlert(log, 'buy', { ticker: `M${i}`, now: T0 + (i + 1) * M }), true);
  assert.equal(allowAlert(log, 'buy', { ticker: 'M9', now: T0 + 10 * M }), false, '7th alert in the hour');
  assert.equal(allowAlert(log, 'buy', { ticker: 'M9', now: T0 + 61 * M }), true, 'an hour later the cap resets');
});

test('sells: once per position, whatever the reason, and never capped', () => {
  const log = { sent: Array.from({ length: 6 }, (_, i) => ({ t: T0, kind: 'buy', ticker: `X${i}` })) };
  assert.equal(allowAlert(log, 'sell', { posId: 'p1', now: T0 + M }), true, 'over the hourly cap, still sent');
  assert.equal(allowAlert(log, 'sell', { posId: 'p1', now: T0 + 2 * M }), false, 'a second sell reason for the same position');
  assert.equal(allowAlert(log, 'sell', { posId: 'p2', now: T0 + 2 * M }), true);
});

test('updates are hourly: only the window that opens on the hour', () => {
  assert.equal(hourlyWindow(new Date(2026, 9, 5, 10, 0).getTime()), true);
  assert.equal(hourlyWindow(new Date(2026, 9, 5, 10, 15).getTime()), false);
});
