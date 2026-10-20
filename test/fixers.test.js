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
    markets: () => ({ listed: 1, running: 1 }), news: () => ({ on: true, headlines: [], events: [] }), fixes: { restartFeeds: (s) => { calls.push(s); return true; } } });
  team.observe('S');
  const r1 = by(team.api('S').roster);
  assert.deepEqual(calls, ['S'], 'the Market desk fixer reconnected the feeds');
  assert.match(r1.fx_desk.status, /Fixing: Exchange runner \(reconnect the exchange feeds, try 1 of 3\)/);
  live = 2; t += 5000; team.observe('S');
  const r2 = by(team.api('S').roster);
  assert.match(r2.fx_desk.status, /No flags to fix · fixed 1 in the last day \(last: Exchange runner/);
  assert.ok(team.api('S').feed.some((e) => e.role === 'fx_desk' && /fixed Exchange runner/.test(e.text)));
});

// ---------- the floor helpers ----------
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELP_TRIES, helpPlans, helperRows } from '../public/fixers.js';
import { FLOORS } from '../public/team.js';
import { createBot } from '../bot.js';

test('the floor helpers take what the fixers escalated: the long retries, the bot watchdog, or the hand-off', () => {
  const plans = planFixes([flagged('exchanges', 'desk', 'broken', 'medic', 'Exchange runner'), flagged('price', 'desk', 'stuck', 'manager', 'Price clerk'), flagged('futures', 'desk', 'stuck', 'manager', 'Futures watcher'), flagged('archivist', 'ops', 'broken', 'medic', 'Archivist'), flagged('l_blend', 'lab', 'slacking', 'manager', 'Kalshi blender')]);
  const desk = { open: { 'exchanges:broken:medic': { tries: 3, status: 'escalated' }, 'price:stuck:manager': { tries: 3, status: 'escalated' }, 'futures:stuck:manager': { tries: 1, status: 'fixing' }, 'l_blend:slacking:manager': { tries: 3, status: 'escalated' } } };
  const hp = by(helpPlans(plans, desk));
  assert.deepEqual([hp.exchanges.how, hp.exchanges.action, hp.exchanges.fixerTries], ['fix', 'restartFeeds', 3]);
  assert.equal(hp.price.action, 'unstickBot', 'a frozen reading after the fixer\'s tries: the watchdog');
  assert.ok(!hp.futures, 'still with its fixer');
  assert.equal(hp.archivist.how, 'handoff'); assert.equal(hp.l_blend.how, 'handoff', 'the tune-up didn\'t do it: nothing more in code');
  const rows = by(helperRows([], Object.values(hp), { open: { 'exchanges:broken:medic': { tries: 2, status: 'fixing' } } }, { now, floors: FLOORS, depts: DEPTS }));
  assert.deepEqual(Object.keys(rows), FLOORS.map(([f]) => `fh_${f}`), 'one helper per floor');
  assert.match(rows.fh_f1.status, /Helping: Exchange runner \(keep reconnecting the exchange feeds every 30 minutes, try 2 of 6\); Price clerk \(let go of a hung bot cycle and restart the loop, try 1 of 6\) · Handed to the admin: Archivist/);
  assert.ok(rows.fh_f1.talks.some((t) => t.to === 'exchanges' && /^I've got you: the Market desk fixer tried 3 times/.test(t.text)));
  assert.ok(rows.fh_f1.talks.some((t) => t.to === 'fx_desk'));
  assert.deepEqual(rows.fh_f1.handoffs.map((h) => h.name), ['Archivist']);
  assert.match(rows.fh_f2.status, /Handed to the admin: Kalshi blender/);
  assert.match(rows.fh_f3.status, /^Nobody stuck on this floor$/);
});

test('in the team: a feed that stays down gets the fixer\'s 3 tries, then the helper\'s every 30 minutes, then the admin', () => {
  let t = now; const calls = [];
  const team = createTeam({ book: { get: () => ({ snap: { spot: 1, mSpot: 1, rows: [] }, sig: null }) }, botOf: () => null, watchOf: () => null, clock: () => t, markets: () => ({ listed: 1, running: 1 }), news: () => ({ on: true, headlines: [], events: [] }),
    stackOf: () => ({ scanFeed: { api: () => ({ feeds: { a: 'off' } }) }, asset: { kind: 'crypto' } }), fixes: { restartFeeds: () => { calls.push(t); return true; } } });
  const helper = () => team.api('S').roster.find((r) => r.role === 'fh_f1');
  for (let i = 0; i < 4 * 6 + 2; i++) { team.observe('S'); t += 5 * 60000; } // ~2 hours, a reading every 5 minutes
  assert.equal(calls.filter((c) => c < now + 25 * 60000).length, 3, 'the fixer: 3 tries, 10 minutes apart (the helper steps in at minute 30)');
  assert.ok(calls.length >= 5, `then the helper keeps going (${calls.length} reconnects)`);
  assert.match(helper().status, /Helping: Exchange runner \(keep reconnecting the exchange feeds every 30 minutes, try \d of 6\)/);
  for (let i = 0; i < 12 * 4; i++) { team.observe('S'); t += 5 * 60000; } // four more hours
  assert.equal(calls.length, 3 + HELP_TRIES, 'and stops after its 6');
  assert.match(helper().status, /Handed to the admin: Exchange runner/); assert.equal(helper().handoffs[0].tries, 3 + HELP_TRIES);
});

test('the watchdog: a bot tick that hangs is let go of, so the next one can run', async () => {
  const hang = http.createServer(() => {}); // takes the request and never answers
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${hang.address().port}`;
  const b = createBot({ kalshi: base, coinbase: base, dataFile: join(mkdtempSync(join(tmpdir(), 'wd-')), 'bot.json'), env: { INDEX: 'off' }, log: { warn() {}, error() {}, log() {} }, keepAlive: () => true });
  assert.equal(b.unstick(), 'running', 'nothing hung: it just makes sure the loop runs');
  b.stop();
  b.tick(); await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.unstick(Date.now(), 100), 'reset', 'hung past the limit: let go');
  b.stop(); hang.closeAllConnections(); hang.close();
});
