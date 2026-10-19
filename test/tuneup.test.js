import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TUNE_UP, blendTest, calibrate, calibrationTest, gradedPicks, split, tuneUpPicks } from '../public/tuneup.js';
import { createTuneUp } from '../tuneup.js';

// a seeded history of graded round calls: truth is the real chance the called side wins; the bot and Kalshi each report
// their own odds (noisy or over-confident on cue)
function history(n, { botNoise = 0, kalshiNoise = 0, over = 1, seed = 7 } = {}) {
  let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const g = () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  const lg = (p) => Math.log(p / (1 - p)), sg = (x) => 1 / (1 + Math.exp(-x));
  return Array.from({ length: n }, (_, i) => {
    const truth = 0.55 + 0.4 * r(), y = r() < truth;
    return { ticker: `T${i}`, at: i * 900000, side: 'YES', result: y ? 'yes' : 'no',
      pb: sg(over * lg(truth) + botNoise * g()), kalshi: sg(over * lg(truth) + kalshiNoise * g()), p: truth };
  });
}

test('only graded round calls with both odds count, oldest first; the split keeps time order', () => {
  const xs = gradedPicks([{ at: 2, side: 'YES', result: 'yes', pb: 0.6, kalshi: 0.6 }, { at: 1, side: 'NO', result: 'no', pb: 0.7, kalshi: 0.7 },
    { at: 3, side: 'YES', result: null, pb: 0.6, kalshi: 0.6 }, { at: 4, side: 'YES', result: 'no', pb: 0.6, kalshi: null }, { at: 5, side: 'YES', result: 'yes', pb: 0.6, kalshi: 0.6, fallback: 'kalshi' }]);
  assert.deepEqual(xs.map((e) => e.at), [1, 2]);
  const { train, test: tst } = split([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(train, [1, 2, 3, 4, 5, 6, 7]); assert.deepEqual(tst, [8, 9, 10]);
});

test('too few graded rounds: nothing changes, and it says how many it needs', () => {
  const r = tuneUpPicks(history(40), 0.5);
  assert.equal(r.blend.apply, false); assert.equal(r.calibration.apply, false);
  assert.match(r.blend.why, /needs 80\+/);
  assert.deepEqual(r.settings, { mix: null, temp: null });
});

test('blend: when Kalshi knows and the bot is noise, it moves toward Kalshi, proven on unseen rounds', () => {
  const r = blendTest(history(600, { botNoise: 2.5, kalshiNoise: 0.05 }), 0.5);
  assert.equal(r.apply, true, r.why);
  assert.ok(r.chosen <= 0.2, `chose ${r.chosen}`);
  assert.ok(r.z >= TUNE_UP.z); assert.ok(r.testLoss.best < r.testLoss.current);
  assert.equal(r.train + r.test, 600);
});

test('blend: when it already has the best blend, or the difference is noise, it stays', () => {
  assert.equal(blendTest(history(600, { botNoise: 0.4, kalshiNoise: 0.4 }), 0.5).apply, false);
});

test('calibration: over-confident odds get pulled back toward 50%; well-calibrated ones are left alone', () => {
  const over = calibrationTest(history(800, { over: 2.2 }), 0.5);
  assert.equal(over.apply, true, over.why); assert.ok(over.temp > 1.4, `temp ${over.temp}`);
  assert.ok(over.brier.tuned < over.brier.now); assert.match(over.why, /over-confident/);
  assert.ok(over.said > over.won, 'said more than it won');
  const fine = calibrationTest(history(800), 0.5);
  assert.equal(fine.apply, false); assert.equal(fine.temp, 1);
  assert.equal(calibrate(0.8, 1), 0.8); assert.ok(calibrate(0.8, 2) < 0.8 && calibrate(0.8, 2) > 0.5); assert.ok(calibrate(0.2, 2) > 0.2);
});

test('the server tune-up: reruns each learner once per asset, keeps proven settings, drops ones that stop proving, saves the report', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tuneup-')), 'tuneup.json'), calls = [];
  const stack = { tuneFeed: { rerun: () => calls.push('tune'), api: () => ({ report: { bars: 30000, families: [{ setting: 'RSI 14', proven: true }, { setting: 'MACD', proven: false }] } }) },
    volTuneFeed: { rerun: async () => calls.push('vol'), live: () => ({ use: false, drift: null }) }, flipFeed: { refit: () => calls.push('flip'), api: () => ({ chart: { proven: false }, flow: { proven: true } }) } };
  let picks = history(800, { over: 2.2 }); // over-confident odds: something the bot doesn't correct by itself
  const bot = { picks: () => picks };
  const tu = createTuneUp({ file, log: { error: () => {} } });
  const r = await tu.run([{ series: 'KXBTC15M', bot, stack }, { series: 'KXBTCD', bot, stack }]);
  assert.deepEqual(calls, ['tune', 'vol', 'flip'], 'a shared asset is refreshed once');
  assert.deepEqual(r.markets[0].learners.after.indicators, ['RSI 14']); assert.equal(r.markets[0].learners.after.flipCheck.flow, true);
  assert.equal(r.markets[1].learners.shared, true);
  assert.ok(tu.get('KXBTC15M')?.temp > 1.4, 'the proven calibration is in use');
  assert.equal(r.markets[0].blend.apply, false, 'the blend the bot learned itself is already right');
  assert.ok(existsSync(file)); assert.ok(JSON.parse(readFileSync(file, 'utf8')).settings.KXBTC15M);
  picks = history(800, { seed: 11 }); // well calibrated now: back to the bot's own
  await tu.run([{ series: 'KXBTC15M', bot, stack }]);
  assert.equal(tu.get('KXBTC15M'), null);
  assert.equal(tu.status().history.length, 2);
  const again = createTuneUp({ file, log: { error: () => {} } }); await again.load(); // a restart keeps what was saved
  assert.equal(again.status().last.markets[0].series, 'KXBTC15M');
  tu.stop(); again.stop();
});

test('one run at a time: a second request while it runs gets the same result', async () => {
  const tu = createTuneUp({ file: join(mkdtempSync(join(tmpdir(), 'tuneup-')), 't.json'), log: { error: () => {} } });
  const m = [{ series: 'X', bot: { picks: () => history(100) } }];
  const [a, b] = await Promise.all([tu.run(m), tu.run(m)]);
  assert.equal(a, b); tu.stop();
});
