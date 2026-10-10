import test from 'node:test';
import assert from 'node:assert/strict';
import { assignView, panesFor, SPLIT_VIEWS } from '../public/split.js';

test('panes: up to four distinct screens, keeping the ones chosen', () => {
  assert.deepEqual(panesFor(4), ['live', 'chart', 'alerts', 'history']);
  assert.deepEqual(panesFor(2, ['learn', 'learn', 'nope']), ['learn', 'live'], 'no repeats, unknown screens dropped');
  assert.deepEqual(panesFor(3, ['settings', 'chart']), ['settings', 'chart', 'live']);
  assert.equal(SPLIT_VIEWS.length, 6);
});

test('picking a screen another pane shows swaps the two', () => {
  assert.deepEqual(assignView(['live', 'chart', 'alerts'], 0, 'alerts'), ['alerts', 'chart', 'live']);
  assert.deepEqual(assignView(['live', 'chart'], 1, 'learn'), ['live', 'learn']);
  assert.deepEqual(assignView(['live', 'chart'], 1, 'chart'), ['live', 'chart']);
});
