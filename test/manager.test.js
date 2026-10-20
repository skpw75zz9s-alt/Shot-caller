import test from 'node:test';
import assert from 'node:assert/strict';
import { STALE_MS, managerReport } from '../public/manager.js';
import { teamRoster, teamTalk } from '../public/team.js';
import { createTeam } from '../team.js';

const now = 1e12;
const row = (role, state, status, dept = 'desk', name = role) => ({ role, name, state, status, dept });

test('everyone accounted for: working, waiting with a reason, off by design, or stuck', () => {
  const roster = [row('price', 'ok', '$100,250.10 · live'), row('analyst', 'ok', 'UP 96% · 9.0 min left', 'lab'), row('futures', 'off', 'No futures market for this one'), row('l_cal', 'idle', 'On probation: …', 'lab'), row('proof', 'idle', 'Not reporting', 'xray'), row('nightwatch', 'warn', 'Last tick 45s ago', 'ops')];
  const m = managerReport(roster, { now, live: true, activity: { price: now - STALE_MS - 30000, analyst: now - 5000 }, depts: [['desk', 'Market desk'], ['lab', 'Research lab'], ['xray', 'X-ray room'], ['ops', 'Operations']], leads: { lab: 'analyst' } });
  assert.deepEqual(m.groups, { working: ['analyst'], waiting: ['l_cal'], off: ['futures'], stuck: ['price', 'proof', 'nightwatch'] });
  assert.match(m.flags.price, /^Stuck: its reading hasn't changed in 3 min while a round is open\. Flagged to the admin\.$/);
  assert.match(m.flags.proof, /not reporting at all/); assert.match(m.flags.nightwatch, /stopped ticking/);
  assert.equal(m.row.state, 'warn'); assert.match(m.row.status, /^1 of 6 working · 1 waiting for a reason · 1 off by design · 3 stuck: price, proof, nightwatch$/);
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
