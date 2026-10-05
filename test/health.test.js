import test from 'node:test';
import assert from 'node:assert/strict';
import { healthCheck, healthDue, newProblems } from '../public/health.js';

const NOW = Date.parse('2026-10-05T10:31:00Z');
const good = { now: NOW, marketsAt: NOW - 3000, candlesAt: NOW - 20000, spotAt: NOW - 1000, streaming: true, skewMs: 800,
  linked: true, balanceAt: NOW - 10000, kalshiError: null, balance: 20, liveOn: true, busySince: 0, lastOrderError: null,
  budget: 10, exposure: 0, liveConf: 80, seen: null, pushSupported: true, pushOn: true };
const bad = (r) => r.filter((x) => x.level !== 'ok').map((x) => x.key);

test('all good: no problems', () => { assert.deepEqual(bad(healthCheck(good)), []); });

test('catches stale prices, wrong clock, Kalshi errors, stuck or failing orders, empty cash, full budget, push off', () => {
  const r = healthCheck({ ...good, marketsAt: NOW - 300000, spotAt: NOW - 120000, skewMs: 45000, kalshiError: 'HTTP 403', balance: 0.4,
    busySince: NOW - 60000, lastOrderError: 'insufficient balance', exposure: 10, pushOn: false });
  assert.deepEqual(bad(r).sort(), ['btc', 'clock', 'kalshi-prices', 'kalshi-sync', 'live-budget', 'live-cash', 'live-error', 'live-stuck', 'push'].sort());
  assert.match(r.find((x) => x.key === 'clock').fix, /Set Automatically/);
  assert.match(r.find((x) => x.key === 'kalshi-sync').fix, /new key/);
});

test('live on without a Kalshi key on this phone is a problem; a bar that never trades is flagged', () => {
  assert.ok(bad(healthCheck({ ...good, linked: false })).includes('kalshi-link'));
  const r = healthCheck({ ...good, liveConf: 95, seen: { minutes: 90, bars: [[95, 0], [90, 0], [85, 2], [80, 5]] } });
  assert.match(r.find((x) => x.key === 'live-bar').fix, /At 85 it would have bought 2/);
});

test('runs every 2 rounds, lined up with :00 and :30; only new problems are announced', () => {
  const t = Date.parse('2026-10-05T10:29:59Z');
  assert.equal(healthDue(null, t), true);
  assert.equal(healthDue(t - 60000, t), false);
  assert.equal(healthDue(t, t + 1000), true, 'crossing 10:30');
  assert.equal(healthDue(t + 1000, t + 29 * 60000), false);
  const p = [{ key: 'btc', level: 'bad' }], c = [{ key: 'btc', level: 'bad' }, { key: 'push', level: 'warn' }];
  assert.deepEqual(newProblems(p, c).map((x) => x.key), ['push']);
});
