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

import { deviceKind } from '../public/split.js';
test('split screen is for computers: any desktop system, touchscreen or not; phones and tablets no', () => {
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0';
  assert.equal(deviceKind({ ua: edge, platform: 'Windows', maxTouchPoints: 10, mobile: false }), 'computer', 'Dell 2-in-1 with a touchscreen');
  assert.equal(deviceKind({ ua: edge, platform: 'Win32', maxTouchPoints: 0 }), 'computer');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'macOS', maxTouchPoints: 0 }), 'computer', 'Mac');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/129.0', platform: 'Chrome OS', maxTouchPoints: 10 }), 'computer', 'Chromebook');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', platform: 'Linux x86_64' }), 'computer', 'Linux');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), 'tablet', 'iPad asking for the desktop site');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad' }), 'tablet');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Chrome/129.0 Safari/537.36', platform: 'Android' }), 'tablet', 'Android tablet');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36', platform: 'Android', mobile: true }), 'phone');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', platform: 'iPhone' }), 'phone');
});
