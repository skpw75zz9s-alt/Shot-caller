import test from 'node:test';
import assert from 'node:assert/strict';
import { signalBoard } from '../public/signals.js';

const T = 'KXBTC15M-26OCT171215-15';
const sources = () => ({
  ticker: T, side: 'YES', crypto: true,
  scan: { record: { 10: { activeN: 140, skill: 0.03 }, 6: { activeN: 90, skill: 0.0 } }, inCalls: { [T]: 0.021 }, live: { ticker: T, lean: 'YES' } },
  micro: { read: { horizons: { 1: { active: false }, 5: { active: false } } }, inCalls: null, models: { 1: { n: 400, skill: 0.004 }, 5: { n: 400, skill: -0.01 } } },
  tune: { report: { families: [{ name: 'MACD cross', setting: 'macd 12/26/9', proven: true, dir: 1, test: { z: 3.1, rounds: 400 } }, { name: 'RSI', setting: 'rsi 14 > 70', proven: false, dir: -1, test: { z: 1.45, rounds: 380 } }] }, read: { active: [{ setting: 'macd 12/26/9', push: -0.4 }] } },
  playbook: { report: { reversal: { bands: { strong: { n: 120, z15: 2.7 }, developing: { n: 300, z15: 1.0 }, insufficient: { n: 900, z15: 0 } } }, guide: { proven: false }, predictor: { proven: false, z: 1.2, rounds: 500 } },
    reversal: { best: { band: 'strong', dir: 'up' } }, guide: { call: 'DOWN' }, inCalls: { [T]: 0.012 } },
  cross: { model: { proven: false, n: 750, z: 1.1, need: { minTest: 1500 } }, inCalls: null },
  flip: { chart: { proven: false, nTest: 300 }, flow: { proven: false, nTest: 50 }, inCalls: null, need: { chart: 600, flow: 200 } },
  volTune: { report: { proven: true, z: 3, drift: { proven: false } } },
  lab: { official: { lessons: [{ label: 'Too close to call', proven: false, n: 12 }] }, pick: { lessons: [{ label: 'Late turn', proven: true, n: 40 }] } },
});

test('signal board: proven factors are in calls, the rest on probation, with progress', () => {
  const b = signalBoard(sources()), by = Object.fromEntries(b.rows.map((r) => [r.key, r]));
  assert.equal(by.scan.status, 'in'); assert.equal(by.scan.lean, 'YES'); assert.equal(by.scan.pts, 0.021); assert.equal(by.scan.vs, 'with');
  assert.equal(by.micro.status, 'probation'); assert.equal(by.micro.lean, null);
  assert.equal(by['tune:MACD cross'].status, 'in'); assert.equal(by['tune:MACD cross'].lean, 'NO'); assert.equal(by['tune:MACD cross'].vs, 'against');
  assert.equal(by['tune:RSI'].status, 'probation'); assert.ok(Math.abs(by['tune:RSI'].progress - 0.5) < 1e-9, 'z 1.45 of 2.9');
  assert.equal(by.reversal.status, 'in'); assert.equal(by.reversal.lean, 'YES'); assert.equal(by.reversal.pts, 0.012, 'the playbook\'s shared nudge');
  assert.equal(by.guide.status, 'probation'); assert.equal(by.guide.pts, null, 'unproven parts don\'t claim the nudge');
  assert.equal(by.predictor.progress, 0.5);
  assert.equal(by.cross.progress, 0.5); assert.equal(by.flip.progress, 0.5);
  assert.equal(by.voltune.status, 'in'); assert.equal(by.lessons.status, 'in'); assert.match(by.lessons.note, /Late turn/);
  assert.equal(b.rows[0].status, 'in', 'proven rows first');
  assert.deepEqual(b.counts, { in: 5, probation: 6, with: 2, against: 1 });
});

test('signal board: no side, no comparison; other markets skip the exchange feeds and show drivers as context', () => {
  const s = sources(); s.side = null;
  assert.ok(signalBoard(s).rows.every((r) => r.vs === null));
  const alt = signalBoard({ ...sources(), crypto: false }), keys = alt.rows.map((r) => r.key);
  assert.ok(!keys.includes('scan') && !keys.includes('micro'));
  assert.equal(alt.rows.at(-1).status, 'context');
});

test('signal board: missing sources make an empty board, not an error', () => {
  const b = signalBoard({});
  assert.deepEqual(b.rows, []);
  assert.deepEqual(b.counts, { in: 0, probation: 0, with: 0, against: 0 });
});
