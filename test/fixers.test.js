import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TRIES, fixerRows, planFixes } from '../public/fixers.js';
import { createFixDesk } from '../fixdesk.js';
import { DEPTS } from '../public/team.js';
import { createTeam } from '../team.js';

const now = 1e12;
const flagged = (role, dept, verdict, by, name = role) => ({ role, name, dept, state: 'warn', status: 'x', reviews: [{ by, verdict, note: `${verdict} note` }] });
const by = (xs) => Object.fromEntries(xs.map((x) => [x.role, x]));

test('every flag gets an answer: a real fix, already handled, or escalated with what to do', () => {
  const p = by(planFixes([
    flagged('exchanges', 'desk', 'broken', 'medic'), flagged('futures', 'desk', 'stuck', 'manager'), flagged('price', 'desk', 'stuck', 'manager'),
    flagged('l_blend', 'lab', 'slacking', 'manager'), flagged('l_micro', 'lab', 'hurting', 'reviewer'), flagged('caller', 'calls', 'hurting', 'valuer'),
    flagged('archivist', 'ops', 'broken', 'medic'), flagged('caller2', 'calls', 'slacking', 'manager'), flagged('auditor', 'risk', 'stuck', 'manager'),
    { role: 'ok1', dept: 'desk', reviews: [{ by: 'reviewer', verdict: 'helping', note: 'good' }] },
  ]));
  assert.deepEqual([p.exchanges.how, p.exchanges.action], ['fix', 'restartFeeds']);
  assert.equal(p.futures.action, 'restartFutures'); assert.equal(p.price.action, 'kickBot'); assert.equal(p.l_blend.action, 'tuneUp');
  assert.equal(p.l_micro.how, 'handled'); assert.match(p.l_micro.help, /council already vetoes/);
  assert.equal(p.caller.how, 'handled'); assert.match(p.caller.help, /profit guard/);
  assert.equal(p.archivist.how, 'escalate'); assert.match(p.archivist.help, /volume in Railway.*DATA_DIR/);
  assert.equal(p.auditor.how, 'escalate', 'nothing in code fixes it: escalate, with the flag itself'); assert.equal(p.auditor.help, 'stuck note');
  assert.ok(!p.ok1, 'a good review is not a flag');
});

test('the desk: one try per cooldown, three tries, then the admin; fixed only when the flag clears', () => {
  let t = now; const ran = [];
  const desk = createFixDesk({ actions: { restartFeeds: (s) => { ran.push(['feeds', s]); return true; }, restartFutures: () => false }, clock: () => t, cooldownMs: 600000 });
  const plan = planFixes([flagged('exchanges', 'desk', 'broken', 'medic'), flagged('tape', 'desk', 'stuck', 'manager')]);
  desk.step('S', plan);
  assert.equal(ran.length, 1, 'one reconnect covers both flags');
  assert.deepEqual(Object.values(desk.state('S').open).map((o) => o.tries), [1, 1]);
  t += 60000; desk.step('S', plan); assert.equal(ran.length, 1, 'inside the cooldown: nothing');
  for (let i = 0; i < 2; i++) { t += 600000; desk.step('S', plan); }
  assert.equal(ran.length, MAX_TRIES); assert.ok(Object.values(desk.state('S').open).every((o) => o.status === 'fixing'));
  t += 600000; desk.step('S', plan);
  assert.ok(Object.values(desk.state('S').open).every((o) => o.status === 'escalated'), 'still up a cooldown after the third try: escalated');
  assert.equal(ran.length, MAX_TRIES, 'and it stops trying');
  // a fresh flag that clears after one try is logged as fixed
  const plan2 = planFixes([flagged('exchanges', 'desk', 'stuck', 'manager')]);
  const d2 = createFixDesk({ actions: { restartFeeds: () => true }, clock: () => t });
  d2.step('S', plan2); t += 5000; d2.step('S', []);
  assert.deepEqual(d2.state('S').fixed.map((f) => [f.role, f.action]), [['exchanges', 'restartFeeds']]);
  assert.deepEqual(d2.state('S').open, {});
  // nothing to run here (no futures for this market): straight to the admin
  const d3 = createFixDesk({ actions: { restartFutures: () => false }, clock: () => t });
  d3.step('S', planFixes([flagged('futures', 'desk', 'stuck', 'manager')]));
  assert.equal(Object.values(d3.state('S').open)[0].status, 'escalated');
});

test('the tune-up runs at most once an hour, however many learners are slacking', () => {
  let t = now, tunes = 0;
  const desk = createFixDesk({ actions: { tuneUp: () => { tunes++; return true; } }, clock: () => t });
  const plan = planFixes([flagged('l_blend', 'lab', 'slacking', 'manager'), flagged('l_basis', 'lab', 'slacking', 'manager')]);
  desk.step('A', plan); desk.step('B', plan);
  assert.equal(tunes, 1);
  t += 11 * 60000; desk.step('A', plan); assert.equal(tunes, 1, 'the hour isn\'t up');
  t += 50 * 60000; desk.step('A', plan); assert.equal(tunes, 2);
});

test('one fixer per team, saying what it is doing, to whom, and what needs the admin', () => {
  const roster = [flagged('exchanges', 'desk', 'broken', 'medic', 'Exchange runner'), flagged('archivist', 'ops', 'broken', 'medic', 'Archivist'), flagged('l_micro', 'lab', 'hurting', 'reviewer', 'Micro modeler'), { role: 'caller', name: 'Caller', dept: 'calls', state: 'ok' }];
  const plans = planFixes(roster), rows = by(fixerRows(roster, plans, { open: { 'exchanges:broken:medic': { tries: 2, status: 'fixing' } }, fixed: [{ t: now - 1000, dept: 'calls', role: 'caller', name: 'Caller', action: 'kickBot' }] }, { now, depts: DEPTS }));
  assert.deepEqual(Object.keys(rows).sort(), ['fx_calls', 'fx_desk', 'fx_lab', 'fx_ops'], 'a fixer for each team that has members');
  assert.match(rows.fx_desk.status, /^Fixing: Exchange runner \(reconnect the exchange feeds, try 2 of 3\)$/); assert.equal(rows.fx_desk.state, 'busy');
  assert.ok(rows.fx_desk.talks.some((x) => x.to === 'exchanges' && /^On it: I'll reconnect the exchange feeds \(try 2 of 3\)\.$/.test(x.text)));
  assert.ok(rows.fx_desk.talks.some((x) => x.to === 'manager'));
  assert.equal(rows.fx_ops.state, 'warn'); assert.match(rows.fx_ops.status, /Escalated to the admin: Archivist/); assert.match(rows.fx_ops.escalations[0].help, /Railway/);
  assert.match(rows.fx_lab.status, /Already handled: Micro modeler/); assert.ok(rows.fx_lab.talks.some((x) => /^Handled: The council already vetoes/.test(x.text)));
  assert.match(rows.fx_calls.status, /^No flags to fix · fixed 1 in the last day \(last: Caller, make sure the bot's loop is running\)$/);
});

test('in the team: a dead exchange feed gets reconnected, and counts as fixed once it is back', () => {
  let t = now, live = 0; const calls = [];
  const snap = { spot: 100250, mSpot: 100250, sigmaMin: 0.0005, rows: [] };
  const team = createTeam({ book: { get: () => ({ snap, sig: null }) }, botOf: () => null, watchOf: () => null, clock: () => t,
    stackOf: () => ({ scanFeed: { api: () => ({ feeds: { a: live ? 'live' : 'off', b: live ? 'live' : 'off' } }) }, asset: { kind: 'crypto' } }),
    markets: () => ({ listed: 1, running: 1 }), fixes: { restartFeeds: (s) => { calls.push(s); return true; } } });
  team.observe('S');
  const r1 = by(team.api('S').roster);
  assert.deepEqual(calls, ['S'], 'the Market desk fixer reconnected the feeds');
  assert.match(r1.fx_desk.status, /Fixing: Exchange runner \(reconnect the exchange feeds, try 1 of 3\)/);
  live = 2; t += 5000; team.observe('S');
  const r2 = by(team.api('S').roster);
  assert.match(r2.fx_desk.status, /No flags to fix · fixed 1 in the last day \(last: Exchange runner/);
  assert.ok(team.api('S').feed.some((e) => e.role === 'fx_desk' && /fixed Exchange runner/.test(e.text)));
});
