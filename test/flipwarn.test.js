import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLIP_WARN, flipDue, flipRecord } from '../public/flipwarn.js';
import { createAlertWatcher } from '../discordalerts.js';

test('a dip under 50% is not a flip warning; 40% or under held 20 s is', () => {
  const w = {};
  assert.equal(flipDue(w, { p: 0.48, minutesLeft: 5, now: 0 }), false);
  assert.equal(flipDue(w, { p: 0.39, minutesLeft: 5, now: 1000 }), false, 'just went under: the count starts');
  assert.equal(flipDue(w, { p: 0.38, minutesLeft: 5, now: 15000 }), false);
  assert.equal(flipDue(w, { p: 0.37, minutesLeft: 5, now: 21000 }), true, '20 s at 40% or under');
  assert.equal(flipDue(w, { p: 0.2, minutesLeft: 5, now: 60000 }), false, 'once a round');
});

test('a wobble back over 45% starts the count again; under a minute left it never fires', () => {
  const w = {};
  flipDue(w, { p: 0.35, minutesLeft: 5, now: 0 });
  flipDue(w, { p: 0.46, minutesLeft: 5, now: 10000 });
  assert.equal(flipDue(w, { p: 0.35, minutesLeft: 5, now: 25000 }), false, 'reset by the wobble');
  assert.equal(flipDue(w, { p: 0.35, minutesLeft: 5, now: 46000 }), true);
  const late = {};
  flipDue(late, { p: 0.1, minutesLeft: 0.9, now: 0 });
  assert.equal(flipDue(late, { p: 0.1, minutesLeft: 0.5, now: 30000 }), false);
});

test('the record: no better than a coin flip over 20+ warnings turns on the strict bar', () => {
  assert.equal(flipRecord([]).mode, 'normal');
  const coin = Array.from({ length: 30 }, (_, i) => ({ right: i % 2 === 0 }));
  assert.equal(flipRecord(coin).mode, 'strict');
  const good = Array.from({ length: 30 }, (_, i) => ({ right: i % 6 !== 0 }));
  assert.equal(flipRecord(good).mode, 'normal');
  const w = {};
  flipDue(w, { p: 0.35, minutesLeft: 5, now: 0, mode: 'strict' });
  assert.equal(flipDue(w, { p: 0.35, minutesLeft: 5, now: 30000, mode: 'strict' }), false, 'strict needs 30% or under');
});

test('Discord: one warning after the hold, graded when the round settles, the record shown and kept', () => {
  const posts = [], file = join(mkdtempSync(join(tmpdir(), 'fw-')), 'flipwarn.json');
  const a = createAlertWatcher({ post: (e) => posts.push(e), kinds: new Set(['flip']), flipFile: file });
  const tick = (p, now) => a.tick({ snap: { live: { m: { ticker: 'T1' }, strike: 100, ev: { pYes: p, minutesLeft: 6 } }, spot: 100 }, sig: { called: 'YES' }, now });
  tick(0.45, 0); tick(0.38, 1000); tick(0.36, 10000);
  assert.equal(posts.length, 0, 'not yet: held 9 s');
  tick(0.35, 22000);
  assert.equal(posts.length, 1); assert.match(posts[0].title, /FLIP WARNING/); assert.match(posts[0].description, /stayed that low for 21 seconds/);
  tick(0.2, 40000);
  assert.equal(posts.length, 1, 'once a round');
  a.settled({ ticker: 'T1', result: 'no', called: true });
  assert.deepEqual(a.flipRecord().right, 1, 'UP was called and lost: the warning was right');
  const b = createAlertWatcher({ post: () => {}, kinds: new Set(['flip']), flipFile: file });
  return new Promise((r) => setTimeout(r, 50)).then(() => {
    const c = createAlertWatcher({ post: () => {}, kinds: new Set(['flip']), flipFile: file });
    assert.equal(c.flipRecord().n, 1, 'the record survives a restart');
    assert.ok(b);
  });
});

test('the strict bar is the stricter one', () => {
  assert.ok(FLIP_WARN.strict.p < FLIP_WARN.normal.p && FLIP_WARN.strict.holdMs > FLIP_WARN.normal.holdMs);
});
