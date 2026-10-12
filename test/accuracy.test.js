import test from 'node:test';
import assert from 'node:assert/strict';
import { ACC, accuracyReport, accuracyRows } from '../public/accuracy.js';

test('the accuracy card: each record against its baseline, "wait" until there\'s enough data', () => {
  const rows = accuracyRows({
    bot: { graded: 50, wins: 40, usd: -3.2, level: 'Steady', certain: { graded: 3, wins: 3, usd: 1.1 } },
    predictor: { n: 4000, rounds: 1200, brier: 0.2, brierDistance: 0.21, z: 3, proven: true, thresholds: [{ t: 0.9, model: { n: 100, share: 0.3, accuracy: 0.96 }, distance: { n: 90, share: 0.27, accuracy: 0.95 } }] },
    blend: { n: 400, rounds: 30, blend: 120, still: 130, best: { key: 'kalshi', miss: 125, blend: 119, n: 400 } },
    path: { n: 300, called: 280, right: 150, miss: 40, still: 38, beta: 0.8 },
    cone: { n: 40, in50: 0.52, in90: 0.88, nKalshi: 40, brierSame: 0.2, brierKalshi: 0.21 },
    radar: { floor: { n: 200, hit: 182, rate: 0.91 }, ceil: { n: 200, hit: 170, rate: 0.85 }, range: { n: 200, hit: 181, rate: 0.905 }, dir: { n: 5, hit: 5, rate: 1 }, next: { n: 0, hit: 0, rate: null } },
    flip: { n: 10, hits: 4, rate: 0.4, base: 0.2 },
    tune: { use: true, lambda: 0.9, floor: 0.6, scale: 1.05, tails: 0.3, z: 3.1, drift: null },
  });
  const v = Object.fromEntries(rows.map((r) => [r.key, r.verdict]));
  assert.deepEqual(v, { calls: 'bad', certain: 'wait', engine: 'good', blend: 'good', path: 'bad', cone: 'good', radar: 'bad', flips: 'wait', tuning: 'good' });
  assert.match(rows.find((r) => r.key === 'radar').metric, /ceiling 85%/);
  assert.equal(ACC.min, 30);
  const empty = accuracyRows({ bot: { graded: 0, wins: 0 } });
  assert.deepEqual(empty.map((r) => [r.key, r.verdict]), [['calls', 'wait'], ['tuning', 'off']]);
  const rep = accuracyReport(rows, { version: 'v13.4', at: 0 });
  assert.equal(rep.at, '1970-01-01T00:00:00.000Z'); assert.equal(rep.rows.length, rows.length);
  assert.deepEqual(rep.rows[0].data, { graded: 50, wins: 40, usd: -3.2 });
  assert.ok(!JSON.stringify(rep).match(/key_id|private|balance/i), 'nothing personal');
});
