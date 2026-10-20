import test from 'node:test';
import assert from 'node:assert/strict';
import { SLACK, STALE_MS, managerReport } from '../public/manager.js';
import { teamRoster, teamTalk } from '../public/team.js';
import { createTeam } from '../team.js';

const now = 1e12;
const row = (role, state, status, dept = 'desk', name = role) => ({ role, name, state, status, dept });

test('everyone accounted for: working, waiting with a reason, off by design, or stuck', () => {
  const roster = [row('price', 'ok', '$100,250.10 · live'), row('analyst', 'ok', 'UP 96% · 9.0 min left', 'lab'), row('futures', 'off', 'No futures market for this one'), row('l_cal', 'idle', 'On probation: …', 'lab'), row('proof', 'idle', 'Not reporting', 'xray'), row('nightwatch', 'warn', 'Last tick 45s ago', 'ops')];
  const m = managerReport(roster, { now, live: true, activity: { price: now - STALE_MS - 30000, analyst: now - 5000 }, depts: [['desk', 'Market desk'], ['lab', 'Research lab'], ['xray', 'X-ray room'], ['ops', 'Operations']], leads: { lab: 'analyst' } });
  assert.deepEqual(m.groups, { working: ['analyst'], waiting: ['l_cal'], off: ['futures'], slacking: [], stuck: ['price', 'proof', 'nightwatch'] });
  assert.equal(m.flags.price.verdict, 'stuck'); assert.match(m.flags.price.note, /^Stuck: its reading hasn't changed in 3 min while a round is open\. Flagged to the admin\.$/);
  assert.match(m.flags.proof.note, /not reporting at all/); assert.match(m.flags.nightwatch.note, /stopped ticking/);
  assert.equal(m.row.state, 'warn'); assert.match(m.row.status, /^1 of 6 working · 1 waiting for a reason · 1 off by design · nobody slacking · 3 stuck: price, proof, nightwatch$/);
  assert.ok(m.row.talks.some((t) => t.to === 'price' && /Stuck/.test(t.text)), 'tells the stuck one');
  assert.ok(m.row.talks.some((t) => t.to === 'analyst' && /^Research lab: 1 of 2 working, 1 waiting$/.test(t.text)), 'and each department, through its lead');
});

test('no false alarms: between rounds nothing is frozen, and a fresh reading is working', () => {
  const roster = [row('price', 'ok', '$100,250.10 · live'), row('analyst', 'idle', 'Between rounds', 'lab')];
  assert.deepEqual(managerReport(roster, { now, live: false, activity: { price: now - 10 * STALE_MS } }).groups.stuck, [], 'no open round: a still price is fine');
  assert.deepEqual(managerReport(roster, { now, live: true, activity: { price: now - 1000 } }).groups.stuck, []);
  const m = managerReport([row('a', 'ok', 'x')], { now });
  assert.equal(m.row.state, 'busy'); assert.match(m.row.status, /nobody stuck/);
});

test('in the roster: the Manager sits first, flags land on the teammate as a review, and it talks', () => {
  const snap = { spot: 100250, mSpot: 100250, sigmaMin: 0.0005, rows: [{ m: { ticker: 'T1' }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes: 0.96 } }] };
  const roster = teamRoster({ now, snap, parts: { activity: { price: now - 5 * 60000 } } }), price = roster.find((r) => r.role === 'price');
  assert.equal(roster[0].role, 'manager'); assert.equal(roster[0].dept, 'mgmt');
  assert.deepEqual(price.reviews.find((v) => v.by === 'manager')?.verdict, 'stuck');
  assert.ok(teamTalk(roster).some((m) => m.from === 'manager' && m.to === 'price'));
});

test('the server keeps when each status last changed, so a frozen reading shows up', () => {
  let t = now;
  const snap = { spot: 100250, mSpot: 100250, sigmaMin: 0.0005, rows: [{ m: { ticker: 'T1' }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes: 0.96 } }] };
  const team = createTeam({ book: { get: () => ({ snap, sig: null }) }, botOf: () => null, watchOf: () => null, clock: () => t });
  team.observe('S');
  for (let i = 0; i < 30; i++) { t += 5000; team.observe('S'); } // 2.5 minutes, the same price to the cent
  const r = Object.fromEntries(team.api('S').roster.map((x) => [x.role, x]));
  assert.ok(r.price.reviews?.some((v) => v.by === 'manager' && /hasn't changed in 3 min/.test(v.note)), JSON.stringify(r.price.reviews));
  assert.ok(r.analyst.reviews?.some((v) => v.by === 'manager'), 'a snapshot that never moves: the Analyst is frozen too');
  const told = team.api('S').roster[0].talks.map((x) => x.to);
  assert.ok(told.includes('price') && told.includes('analyst'), 'the Manager tells both');
});

test('slacking: work that should move every round, and rounds going by with nothing new', () => {
  const roster = [row('caller', 'idle', 'Watching for an edge', 'calls', 'Caller'), row('accuracy', 'ok', '40 rounds graded', 'improve', 'Accuracy coach'), row('quotes', 'ok', 'UP 60¢ bid / 62¢ ask'),
    row('l_blend', 'idle', 'On probation: 40/150 rounds', 'lab'), row('l_basis', 'busy', 'In the calls: +$3.10 folded in', 'lab'), row('scout', 'ok', 'Calm: feeds live, nothing unusual')];
  const m = managerReport(roster, { now, live: true, rounds: { caller: 3, accuracy: 2, quotes: 4, l_blend: 3, l_basis: 9, scout: 20 } });
  assert.deepEqual(m.groups.slacking, ['caller', 'quotes', 'l_blend']);
  assert.equal(m.flags.caller.verdict, 'slacking'); assert.match(m.flags.caller.note, /^Slacking: nothing new in 3 rounds, and its work should move every round\. Get back to it\.$/);
  assert.ok(!m.groups.slacking.includes('accuracy'), `under its limit (${SLACK.accuracy})`);
  assert.ok(!m.groups.slacking.includes('l_basis'), 'proven: its status is meant to sit still');
  assert.ok(!m.groups.slacking.includes('scout'), 'a calm market is not slacking: only work that has to move each round counts');
  assert.match(m.row.status, /3 slacking: Caller, quotes, l_blend · nobody stuck$/); assert.equal(m.row.state, 'warn');
  assert.ok(m.row.talks.some((t) => t.to === 'caller' && /Get back to it/.test(t.text)));
  assert.deepEqual(managerReport([row('caller', 'off', 'x')], { now, rounds: { caller: 50 } }).groups.slacking, [], 'off by design is never slacking');
});

test('the Tune-up runner slacks when its tune-up is overdue', () => {
  const tuner = [row('tuner', 'ok', 'Last tune-up 9 h ago', 'improve', 'Tune-up runner')];
  assert.match(managerReport(tuner, { now, autoTune: { on: true, everyH: 6, at: now - 9 * 3600000, running: false } }).flags.tuner.note, /its tune-up is 3 h overdue/);
  assert.deepEqual(managerReport(tuner, { now, autoTune: { on: true, everyH: 6, at: now - 6.5 * 3600000, running: false } }).groups.slacking, [], 'an hour of grace');
  assert.deepEqual(managerReport(tuner, { now, autoTune: { on: false, everyH: 6, at: now - 99 * 3600000 } }).groups.slacking, [], 'turned off: off by design');
});

test('the server counts rounds and keeps a time sheet for everyone', () => {
  let t = now, close = '2026-10-20T14:15:00Z', pYes = 0.96;
  const snap = () => ({ spot: 100250 + (t % 7), mSpot: 100250 + (t % 7), sigmaMin: 0.0005, rows: [{ m: { ticker: 'T1', close_time: close }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes } }] });
  const team = createTeam({ book: { get: () => ({ snap: snap(), sig: null }) }, botOf: () => null, watchOf: () => null, clock: () => t });
  team.observe('S');
  for (const c of ['2026-10-20T14:30:00Z', '2026-10-20T14:45:00Z', '2026-10-20T15:00:00Z']) { t += 5000; close = c; team.observe('S'); }
  const r = Object.fromEntries(team.api('S').roster.map((x) => [x.role, x]));
  assert.equal(r.caller.timesheet.rounds, 3, 'three rounds ended without the Caller saying anything new');
  assert.equal(r.caller.reviews?.find((v) => v.by === 'manager')?.verdict, 'slacking');
  assert.ok(r.price.timesheet.hour >= 2 && r.price.timesheet.rounds === 0, 'the price kept moving');
});

test('no false alarm: a teammate that does something in the same reading a round ends is not called slacking', () => {
  let t = now, close = '2026-10-20T14:15:00Z', locked = null;
  const snap = () => ({ spot: 100250 + (t % 7), mSpot: 100250 + (t % 7), sigmaMin: 0.0005, rows: [{ m: { ticker: 'T1', close_time: close }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes: 0.96 } }] });
  const team = createTeam({ book: { get: () => ({ snap: snap(), sig: null }) }, botOf: () => ({ pick: () => (locked ? { live: { side: locked, p: 0.8 } } : null) }), watchOf: () => null, clock: () => t });
  team.observe('S');
  for (const c of ['2026-10-20T14:30:00Z', '2026-10-20T14:45:00Z']) { t += 5000; close = c; team.observe('S'); }
  t += 5000; close = '2026-10-20T15:00:00Z'; locked = 'YES'; team.observe('S'); // the third round ends and the Caller locks a call, in one reading
  const c = team.api('S').roster.find((x) => x.role === 'caller');
  assert.equal(c.timesheet.rounds, 0); assert.ok(!c.reviews?.some((v) => v.by === 'manager'), JSON.stringify(c.reviews));
  assert.ok(!team.api('S').feed.some((e) => /slacking/.test(e.text)), 'and no "caught slacking" line in the feed');
});
