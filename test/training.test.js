import test from 'node:test';
import assert from 'node:assert/strict';
import { counterOf, trainees, trainerRows } from '../public/training.js';
import { createTeam } from '../team.js';

const now = 1e12;
const by = (xs) => Object.fromEntries(xs.map((x) => [x.role, x]));

test('a trainee\'s own counter, read from its status', () => {
  assert.deepEqual(counterOf('On probation: 40/150 rounds'), { n: 40, need: 150, what: 'rounds' });
  assert.deepEqual(counterOf('On probation: 3 of 10 settlements'), { n: 3, need: 10, what: 'settlements' });
  assert.deepEqual(counterOf('On probation: 0/120 graded calls · replay: skipping would have cost money'), { n: 0, need: 120, what: 'graded calls' });
  assert.equal(counterOf('On probation: until it beats "no change" (500+ graded predictions, 0.5%+ better)'), null);
  assert.equal(trainees().length, 15, 'the 14 learners and the Flip checker');
});

test('a trainer for every trainee: the pace, the path, graduation, and no shortcuts', () => {
  const roster = [
    { role: 'l_blend', name: 'Kalshi blender', state: 'idle', status: 'On probation: 40/150 rounds' },
    { role: 'l_vol', name: 'Clock watcher', state: 'idle', status: 'On probation: needs a week of history' },
    { role: 'l_voltune', name: 'Volatility tuner', state: 'busy', status: 'In the calls: EWMA 0.94' },
    { role: 'l_tune', name: 'Indicator tuner', state: 'idle', status: 'On probation: no indicator setting has predicted the rounds out of sample yet' },
    { role: 'l_scan', name: 'Scan analyst', state: 'idle', status: 'On probation: until its graded record shows…' },
    { role: 'l_basis', name: 'Settlement matcher', state: 'idle', status: 'On probation: 10 of 10 settlements' },
    { role: 'exchanges', name: 'Exchange runner', dept: 'desk', state: 'warn', status: '0 of 14 exchange feeds live' },
  ];
  const r = by(trainerRows(roster, { progress: { l_vol: { n: 3360, need: 10080, what: 'minutes of history' } }, pace: { l_blend: 4, l_vol: 60 } }));
  assert.match(r.tr_l_blend.status, /^On probation · 40 of 150 rounds \(27%\) · about 28 h to go at this pace$/);
  assert.match(r.tr_l_vol.status, /3,360 of 10,080 minutes of history \(33%\) · about 5 days to go/, 'the server\'s own counter wins over the status text');
  assert.match(r.tr_l_voltune.status, /graduated/); assert.equal(r.tr_l_voltune.state, 'ok');
  assert.match(r.tr_l_tune.status, /no counter to push, and rerunning it to fish for a pass would be cheating/);
  assert.equal(r.tr_l_scan.state, 'warn'); assert.match(r.tr_l_scan.status, /^Blocked: the Scan analyst can't gather data without the exchange feeds/);
  assert.ok(r.tr_l_scan.talks.some((t) => t.to === 'fx_desk' && /can't gather data without the exchange feeds/.test(t.text)), 'it tells the fixer');
  assert.match(r.tr_l_basis.status, /the bar is reached: it's judged on its next test/);
  assert.ok(r.tr_l_blend.talks.some((t) => t.to === 'l_blend' && /no shortcut/.test(t.text)));
  assert.equal(Object.keys(r).length, 6, 'one per trainee present (the Exchange runner is not a trainee)');
});

test('in the team: the pace is measured, and a trainee that proves itself pays its trainer', () => {
  let t = now, n = 40, on = false;
  const team = createTeam({ book: { get: () => ({ snap: null, sig: null }) }, watchOf: () => null, clock: () => t, markets: () => ({ listed: 1, running: 1 }), news: () => ({ on: true, headlines: [], events: [] }),
    botOf: () => ({ learnStatus: () => ({ minutes: 20000, using: [{ key: 'blend', name: 'Kalshi\'s price', on, detail: on ? '40% Kalshi in the odds' : `${n}/150 rounds` }] }) }) });
  team.observe('S');
  for (let i = 0; i < 12; i++) { t += 5 * 60000; if (i % 3 === 2) n++; team.observe('S'); } // an hour, 4 more rounds
  const r1 = by(team.api('S').roster);
  assert.match(r1.tr_l_blend.status, /44 of 150 rounds \(29%\) · about 2\d h to go at this pace/);
  assert.match(r1.tr_l_vol.status, /isn't reporting: nothing to train on/, 'a learner this bot didn\'t report: said plainly');
  on = true; t += 5000; team.observe('S');
  const r2 = by(team.api('S').roster);
  assert.match(r2.tr_l_blend.status, /graduated/);
  assert.equal(r1.tr_l_blend.score.day < 50, true); assert.ok(r2.tr_l_blend.score.day >= 50, 'graduation pays the trainer +50 (plus any hour on the job)');
  assert.ok(r2.l_blend.score.day >= 50, 'the trainee its own +50 (plus an hour on the job)');
});
