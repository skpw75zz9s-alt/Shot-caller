import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCTOR, careOf, clinicHtml, doctorRound, notAFault, secondOpinion } from '../public/doctor.js';
import { planFixes } from '../public/fixers.js';
import { snapshot } from '../public/incentives.js';
import { DEPTS, FLOORS } from '../public/team.js';
import { createTeam } from '../team.js';

const row = (role, name, dept, extra = {}) => ({ role, name, dept, state: 'ok', status: 'fine', key: 'ok', ...extra });
const broken = (note = 'Needs attention') => [{ by: 'medic', verdict: 'broken', note }];
const by = (r) => Object.fromEntries(r.map((x) => [x.role, x]));

test('second opinion: a warning that is the market or a guard is no fault, so the fixers leave it alone', () => {
  const roster = [
    row('medic', 'Feed medic', 'improve', { crew: true, state: 'warn', status: '3 parts need attention' }),
    row('quotes', 'Quote clerk', 'desk', { state: 'warn', key: 'wide', status: 'spread 20¢', reviews: broken() }),
    row('liqs', 'Liquidation watcher', 'desk', { state: 'warn', key: 'big', status: '$3M forced out', reviews: broken() }),
    row('scout', 'Scout', 'desk', { state: 'warn', key: 'hold:silent', status: 'Holding new calls', reviews: broken() }),
  ];
  const cleared = secondOpinion(roster);
  assert.deepEqual(cleared.map((c) => c.role), ['quotes', 'liqs', 'scout']);
  assert.deepEqual(planFixes(roster), [], 'no feed reconnects or kicked bot for the market');
  const m = by(roster).medic;
  assert.equal(m.state, 'ok'); assert.match(m.status, /the Doctor cleared Quote clerk, Liquidation watcher, Scout: the market, not a fault/);
  assert.deepEqual(snapshot(roster).flags.quotes, [], 'and no merit lost for it');
  assert.equal(by(roster).quotes.state, 'warn', 'the warning itself stays on show');
  assert.equal(notAFault(row('exchanges', 'Exchange runner', 'desk', { key: 'down' })), null, 'every feed down is a real fault');
  assert.equal(notAFault(row('scout', 'Scout', 'desk', { key: 'delayed' })), null, 'and so is a delayed price');
});

test('a real fault keeps its flag, and the medic still says so', () => {
  const roster = [row('medic', 'Feed medic', 'improve', { crew: true, state: 'warn' }), row('exchanges', 'Exchange runner', 'desk', { state: 'warn', key: 'down', reviews: broken() }), row('quotes', 'Quote clerk', 'desk', { state: 'warn', key: 'wide', reviews: broken() })];
  secondOpinion(roster);
  assert.deepEqual(planFixes(roster).map((p) => [p.role, p.action]), [['exchanges', 'restartFeeds']]);
  assert.equal(by(roster).medic.state, 'warn', 'one real fault left: the medic stays on it');
});

test('who is treating whom: the fixer, then the floor helper, then you; a rule that already handles it', () => {
  const plans = [
    { dept: 'desk', role: 'exchanges', name: 'Exchange runner', verdict: 'broken', by: 'medic', how: 'fix', action: 'restartFeeds', help: 'x' },
    { dept: 'desk', role: 'price', name: 'Price clerk', verdict: 'stuck', by: 'manager', how: 'fix', action: 'kickBot', help: 'x' },
    { dept: 'ops', role: 'archivist', name: 'Archivist', verdict: 'broken', by: 'medic', how: 'escalate', action: null, help: 'Add a volume' },
    { dept: 'council', role: 'l_scan', name: 'Scan analyst', verdict: 'hurting', by: 'reviewer', how: 'handled', action: null, help: 'The council vetoes it.' },
  ];
  const desk = { open: { 'exchanges:broken:medic': { tries: 2, status: 'fixing' }, 'price:stuck:manager': { tries: 3, status: 'escalated' } } };
  const hplans = [{ ...plans[1], how: 'fix', action: 'unstickBot' }, { ...plans[2], how: 'handoff', action: null }];
  const help = { open: { 'price:stuck:manager': { tries: 1, status: 'fixing' } } };
  const c = careOf(plans, desk, hplans, help, { depts: DEPTS, floors: FLOORS });
  assert.deepEqual(c.exchanges, { how: 'fixing', who: 'Market desk fixer', text: 'reconnect the exchange feeds (try 2 of 3)' });
  assert.deepEqual(c.price, { how: 'helping', who: 'Ground floor helper', text: 'let go of a hung bot cycle and restart the loop (try 1 of 6)' });
  assert.deepEqual(c.archivist, { how: 'you', text: 'Add a volume' });
  assert.equal(c.l_scan.how, 'handled');
});

test('the rounds: the root cause first, its symptoms under it, guards just watched, a chart on every patient', () => {
  const roster = [
    row('manager', 'Manager', 'mgmt', { manager: true, state: 'warn' }),
    row('nightwatch', 'Night watch', 'ops', { state: 'warn', key: 'slow', status: 'Last tick 95s ago', reviews: broken('Needs attention: Last tick 95s ago') }),
    row('price', 'Price clerk', 'desk', { reviews: [{ by: 'manager', verdict: 'stuck', note: 'Stuck: its reading hasn\'t changed in 3 min while a round is open.' }] }),
    row('analyst', 'Analyst', 'lab', { reviews: [{ by: 'manager', verdict: 'stuck', note: 'Stuck: frozen.' }] }),
    row('certain', 'Near-certain desk', 'calls', { state: 'warn', key: 'true', status: 'Paused by the profit guard' }),
    row('archivist', 'Archivist', 'ops', { state: 'warn', key: 'temp', status: 'Not on a volume', reviews: broken() }),
    row('fx_ops', 'Operations fixer', 'ops', { fixer: true, state: 'busy' }),
    row('tr_l_scan', 'Scan trainer', 'train', { trainer: true, state: 'warn' }),
  ];
  const care = { nightwatch: { how: 'fixing', who: 'Operations fixer', text: 'make sure the bot\'s loop is running (try 1 of 3)' }, archivist: { how: 'you', text: 'Add a volume in Railway.' } };
  const d = doctorRound(roster, { care });
  const ch = Object.fromEntries(d.charts.map((c) => [c.role, c]));
  assert.deepEqual(d.charts.map((c) => [c.role, c.triage]), [['nightwatch', 'critical'], ['price', 'critical'], ['analyst', 'critical'], ['archivist', 'you'], ['certain', 'watch']], 'worst first; the Manager, the fixers and the trainers are staff, not patients');
  assert.deepEqual(ch.nightwatch.symptoms, ['Price clerk', 'Analyst']);
  assert.match(ch.price.rx, /Treat the cause: the Night watch is down and this reads from it/);
  assert.match(ch.nightwatch.rx, /^Operations fixer is on it: make sure the bot's loop is running \(try 1 of 3\)\.$/);
  assert.match(ch.archivist.rx, /^Needs you: Add a volume/); assert.match(ch.certain.rx, /^No treatment needed: The profit guard paused it/);
  assert.equal(by(roster).price.chart.cause, 'Night watch', 'each patient carries its chart');
  assert.equal(d.state, 'warn'); assert.equal(d.say, 'Night watch: critical');
  assert.match(d.status, /^5 patients: 3 critical, 1 needs you, 1 just watching · root cause: the Night watch \(behind 2 more\)$/);
  assert.ok(d.talks.some((t) => t.to === 'fx_ops' && /Fixing it clears 2 more \(Price clerk, Analyst\)/.test(t.text)), 'the cause\'s fixer is told what fixing it clears');
  assert.ok(d.talks.some((t) => t.to === 'manager'));
  assert.match(clinicHtml([...roster, d]), /🔴 {2}<b>Night watch<\/b>.*Root cause of: Price clerk, Analyst/s);
});

test('nobody needs the Doctor: it says so, and lists the false alarms it cleared', () => {
  const d = doctorRound([row('price', 'Price clerk', 'desk')], { cleared: [{ role: 'quotes', name: 'Quote clerk', why: 'Kalshi\'s spread is wide.' }] });
  assert.equal(d.state, 'ok'); assert.equal(d.status, 'Everyone is healthy · cleared 1 false alarm (Quote clerk)');
  assert.ok(d.talks.some((t) => t.to === 'medic' && /Second opinion on the Quote clerk/.test(t.text)));
  assert.match(clinicHtml([d]), /✅ {2}<b>Quote clerk<\/b><\/span><em>false alarm/);
  assert.match(clinicHtml([{ ...d, cleared: [] }]), /Everyone is healthy/);
  assert.equal(clinicHtml([]), '', 'no Doctor on an older server: nothing to show');
  assert.equal(DOCTOR[0], 'doctor');
});

test('on the server: a wide Kalshi spread no longer kicks the bot, and the Doctor makes its rounds', () => {
  const t = 1e12, kicked = [];
  const snap = { spot: 100250, mSpot: 100250, sigmaMin: 0.0005, sigmaLong: 0.0004, rows: [{ m: { ticker: 'T1' }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes: 0.6, quote: { yesBid: 0.4, yesAsk: 0.6, noAsk: 0.6 } } }] };
  const team = createTeam({ book: { get: () => ({ snap, sig: null }) }, botOf: () => null, watchOf: () => null, clock: () => t, fixes: { kickBot: (s) => { kicked.push(s); return true; } } });
  team.observe('S');
  const r = by(team.api('S').roster);
  assert.equal(r.quotes.state, 'warn'); assert.deepEqual(kicked, [], 'no fix for the market\'s own spread');
  assert.ok(r.doctor, 'the Doctor is on the roster'); assert.equal(r.doctor.dept, 'mgmt');
  assert.ok(r.doctor.cleared.some((c) => c.role === 'quotes')); assert.equal(r.quotes.chart.triage, 'watch');
});
