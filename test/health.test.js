import test from 'node:test';
import assert from 'node:assert/strict';
import { healthCheck, healthDue, newProblems } from '../public/health.js';

const NOW = Date.parse('2026-10-05T10:31:00Z');
const good = { now: NOW, marketsAt: NOW - 3000, candlesAt: NOW - 20000, spotAt: NOW - 1000, streaming: true, skewMs: 800,
  linked: true, balanceAt: NOW - 10000, kalshiError: null, balance: 20, pushSupported: true, pushOn: true };
const bad = (r) => r.filter((x) => x.level !== 'ok').map((x) => x.key);

test('all good: no problems', () => { assert.deepEqual(bad(healthCheck(good)), []); });

test('catches stale prices, wrong clock, Kalshi errors, push off', () => {
  const r = healthCheck({ ...good, marketsAt: NOW - 300000, spotAt: NOW - 120000, skewMs: 45000, kalshiError: 'HTTP 403', pushOn: false });
  assert.deepEqual(bad(r).sort(), ['btc', 'clock', 'kalshi-prices', 'kalshi-sync', 'push'].sort());
  assert.match(r.find((x) => x.key === 'clock').fix, /Set Automatically/);
  assert.match(r.find((x) => x.key === 'kalshi-sync').fix, /new key/);
});

test('no Kalshi link is fine (it is optional)', () => {
  assert.deepEqual(bad(healthCheck({ ...good, linked: false })), []);
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

test('admins are told when server data resets on every deploy; members are not', () => {
  const warn = healthCheck({ ...good, admin: true, storagePersistent: false }).find((x) => x.key === 'storage');
  assert.equal(warn.level, 'warn');
  assert.match(warn.fix, /Volumes/);
  assert.equal(healthCheck({ ...good, admin: true, storagePersistent: true }).find((x) => x.key === 'storage').level, 'ok');
  assert.equal(healthCheck({ ...good, admin: false, storagePersistent: false }).find((x) => x.key === 'storage'), undefined);
});
