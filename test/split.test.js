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

import { isComputer } from '../public/split.js';
test('split screen is for computers: touchscreen laptops yes, phones and tablets no', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0';
  assert.equal(isComputer({ ua: win, platform: 'Windows', maxTouchPoints: 10, mobile: false, finePointer: true, width: 1093 }), true, 'Dell 2-in-1, touchscreen, 125%');
  assert.equal(isComputer({ ua: win, platform: 'Windows', maxTouchPoints: 10, mobile: false, finePointer: true, width: 911 }), true, '1366 at 150%');
  assert.equal(isComputer({ ua: win, platform: 'Windows', finePointer: true, width: 800 }), false, 'window too narrow');
  assert.equal(isComputer({ ua: win, platform: 'Windows', finePointer: false, width: 1400 }), false, 'tablet mode, no trackpad');
  assert.equal(isComputer({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0, finePointer: true, width: 1440 }), true, 'Mac');
  assert.equal(isComputer({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5, finePointer: true, width: 1366 }), false, 'iPad with a trackpad');
  assert.equal(isComputer({ ua: 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', finePointer: true, width: 1280 }), false, 'Android tablet');
  assert.equal(isComputer({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', finePointer: false, width: 390 }), false, 'iPhone');
});
