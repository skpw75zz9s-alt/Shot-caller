import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, TEAM_ICON, teamChanges, teamPulse, teamRoster } from '../public/team.js';
import { createTeam } from '../team.js';

const now = 1e12;
const snap = (spot = 100250, pYes = 0.96) => ({ spot, mSpot: spot, sigmaMin: 0.0005, sigmaLong: 0.0004, rows: [{ m: { ticker: 'T1' }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes } }] });
const by = (r) => Object.fromEntries(r.map((x) => [x.role, x]));

test('one teammate per action, each with a state and a status from the part it owns', () => {
  const r = by(teamRoster({ now, snap: snap(), sig: null, watch: { events60: 0 }, breaks: [], proven: 2, debate: null, pick: { live: { side: 'YES', p: 0.84 } }, record: { profitGuard: { paused: false }, guard: { floor: 0.9 } },
    learners: [{ on: true }, { on: false }], strength: { words: ['Stronger than a coin flip.'] }, autotraders: 0, discord: { on: true, sent: 12 }, ask: 'free answers' }));
  assert.deepEqual(Object.keys(r), ROLES.map(([k]) => k));
  assert.equal(r.scout.state, 'ok'); assert.match(r.scout.status, /Calm/);
  assert.match(r.analyst.status, /^UP 96% · UP ahead by \d\.\d\d typical moves · 9\.0 min left · volatility 1\.25×/);
  assert.match(r.inspector.status, /No breaks · 2 kinds of break proven/); assert.equal(r.judge.state, 'idle');
  assert.match(r.caller.status, /Round call locked UP at 84%: a lean, not a buy/); assert.match(r.risk.status, /All guards clear · win-rate floor 90%/);
  assert.equal(r.trader.state, 'off'); assert.match(r.coach.status, /Stronger than a coin flip\. · 1 of 2 learners proven/); assert.match(r.reporter.status, /Discord on · 12 posts sent · Ask: free answers/);
});

test('warnings: a Market Watch hold, a delayed price, breaks, the profit guard, a buy signal, the council, auto-traders', () => {
  const r = by(teamRoster({ now, snap: snap(), sig: { callSide: 'NO', price: 0.62, winProb: 0.8 }, watch: { hold: { until: now + 5000, why: 'No fresh price for 30s+', kind: 'silent' } },
    breaks: [{ title: 'High flip risk: 65/100' }, { title: 'Kalshi swing: 30 points toward DOWN' }], debate: { rulings: [{}, {}], vetoed: 1, net: 0.02, verdict: 'A real debate…' }, record: { profitGuard: { paused: false } }, autotraders: 3 }));
  assert.equal(r.scout.state, 'warn'); assert.match(r.scout.status, /Holding new calls: No fresh price/);
  assert.equal(r.inspector.state, 'warn'); assert.match(r.inspector.status, /2 breaks open/);
  assert.equal(r.judge.state, 'busy'); assert.equal(r.caller.state, 'busy'); assert.match(r.caller.status, /BUY DOWN at 62% · 80% at its worst-case odds/);
  assert.match(r.risk.status, /on hold while Market Watch sees a problem/, 'the hold outranks the flip risk');
  assert.match(r.trader.status, /3 auto-traders trading the official calls/);
  assert.match(by(teamRoster({ now, snap: { ...snap(), delayed: true } })).scout.status, /delayed/);
  assert.match(by(teamRoster({ now, snap: snap(), record: { profitGuard: { paused: true, why: 'recent calls lost money' } } })).risk.status, /paused by the profit guard/);
  assert.equal(by(teamRoster({ now, snap: null })).analyst.status, 'Between rounds');
});

test('the feed logs a change of position, not every tick, and nothing on the first reading', () => {
  const a = teamRoster({ now, snap: snap(100250) }), first = teamChanges({}, a, now);
  assert.deepEqual(first.events, []);
  const same = teamChanges(first.keys, teamRoster({ now, snap: snap(100260, 0.97) }), now + 5000);
  assert.deepEqual(same.events, [], 'new numbers, same situation: no line');
  const flip = teamChanges(same.keys, teamRoster({ now, snap: snap(99900, 0.2) }), now + 10000);
  assert.deepEqual(flip.events.map((e) => [e.role, e.text]), [['analyst', 'DOWN took the lead']]);
});

test('the server team reads each part every 5 seconds and keeps the feed', () => {
  let t = now, b = snap(100250);
  const team = createTeam({ book: { get: () => ({ snap: b, sig: null }) }, botOf: () => ({ pick: () => null, record: () => ({ profitGuard: { paused: false } }), learnStatus: () => ({ using: [{ on: true }] }) }),
    watchOf: () => ({ status: () => ({ events60: 0 }) }), council: null, breakLab: null, strength: null, discord: { status: () => ({ on: false, sent: 0 }) }, clock: () => t });
  team.observe('S'); b = snap(99900, 0.2); t += 1000; team.observe('S');
  assert.equal(team.api('S').feed.length, 0, 'within 5 seconds: not read again');
  t += 5000; team.observe('S');
  const a = team.api('S');
  assert.equal(a.roster.length, ROLES.length); assert.deepEqual(a.feed.map((e) => e.text), ['DOWN took the lead']);
  assert.ok(createTeam({ book: { get: () => null }, botOf: () => null, watchOf: () => null }).api('X').roster.length, 'answers before its first reading');
});

test('the live window: a fresh reading at most once a second, the round\'s numbers, and an icon for everyone', () => {
  let t = now, b = snap(100250), reads = 0;
  const team = createTeam({ book: { get: () => ({ snap: b, sig: null }) }, botOf: () => { reads++; return null; }, watchOf: () => null, clock: () => t });
  team.live('S'); t += 400; team.live('S');
  assert.equal(reads, 1, 'twice within a second: one reading');
  b = snap(99900, 0.2); t += 700;
  const a = team.live('S');
  assert.equal(reads, 2); assert.deepEqual(a.feed.map((e) => e.text), ['DOWN took the lead']);
  assert.deepEqual(a.pulse, { ticker: 'T1', spot: 99900, strike: 100000, pYes: 0.2, minutesLeft: 9 });
  assert.equal(teamPulse(null), null); assert.equal(teamPulse({ rows: [{ m: { ticker: 'X' }, ev: { minutesLeft: 0 } }] }), null, 'between rounds');
  assert.deepEqual(Object.keys(TEAM_ICON), ROLES.map(([k]) => k));
});
