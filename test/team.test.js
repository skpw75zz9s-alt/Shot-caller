import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPTS, LEARNERS, ROLES, STAFF, TEAM_ICON, teamChanges, teamPulse, teamRoster, teamTalk } from '../public/team.js';
import { CREW } from '../public/improve.js';
import { MANAGER } from '../public/manager.js';
import { DOCTOR } from '../public/doctor.js';
import { createTeam } from '../team.js';

const now = 1e12;
const snap = (spot = 100250, pYes = 0.96) => ({ spot, mSpot: spot, sigmaMin: 0.0005, sigmaLong: 0.0004, rows: [{ m: { ticker: 'T1' }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes } }] });
const by = (r) => Object.fromEntries(r.map((x) => [x.role, x]));

test('one teammate per action, each with a state and a status from the part it owns', () => {
  const r = by(teamRoster({ now, snap: snap(), sig: null, watch: { events60: 0 }, breaks: [], proven: 2, debate: null, pick: { live: { side: 'YES', p: 0.84 } }, record: { profitGuard: { paused: false }, guard: { floor: 0.9 } },
    learners: [{ on: true }, { on: false }], strength: { words: ['Stronger than a coin flip.'] }, autotraders: 0, discord: { on: true, sent: 12 }, ask: 'free answers' }));
  assert.deepEqual(Object.keys(r), [MANAGER, ...CREW, ...ROLES, ...STAFF].map(([k]) => k), 'the Manager, the Improvement crew, the nine leads, then the staff');
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
  assert.equal(a.roster.filter((x) => !x.fixer && !x.helper && !x.trainer).length, 2 + CREW.length + ROLES.length + STAFF.length); // (the Manager and the Doctor) assert.ok(a.roster.some((x) => x.fixer), 'and a fixer per team'); assert.deepEqual(a.feed.map((e) => e.text), ['DOWN took the lead']);
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
  assert.deepEqual(Object.keys(TEAM_ICON).filter((k) => !/^(f[xh]|tr|h)_/.test(k) && k !== 'recruiter').sort(), [MANAGER, DOCTOR, ...CREW, ...ROLES, ...STAFF].map(([k]) => k).sort());
  assert.ok(a.roster.every((x) => TEAM_ICON[x.role]), 'an icon for everyone, the fixers too');
});

test('the whole staff: everyone in a department, one researcher per learner, each status from its own part', () => {
  const learners = LEARNERS.map(([key], i) => ({ key, name: key, on: i === 0, detail: i === 0 ? 'EWMA 0.94: proven out of sample' : 'needs more rounds' }));
  const roster = teamRoster({ now, snap: { ...snap(), rows: [{ m: { ticker: 'T1' }, strike: 100000, sigma: 0.0005, ev: { minutesLeft: 9, pYes: 0.96, quote: { yesBid: 0.6, yesAsk: 0.62, noAsk: 0.4 } } }] },
    sig: { callSide: 'YES', price: 0.62, winProb: 0.8 }, watch: { hold: { until: now + 5000, why: 'x', kind: 'silent' } }, pick: { live: { side: 'NO' } }, learners,
    record: { graded: 45, wins: 41, usd: 12.3, profitGuard: { paused: false, n: 20, usd: 4 }, guard: { floor: 0.93, n: 20, wins: 17 }, early: { proven: true, live: true, graded: 10, wins: 9 } },
    parts: { feeds: { live: 9, total: 12 }, imbalance: 0.5, hasFutures: true, futures: { funding: 0.0001, oiChange5: 0.002, live: true }, liqs: { n: 40, long: 1.5e6, short: 0.9e6, minutes: 30 },
      cross: { proven: false }, flows: { live: 1, total: 2, err: null }, markets: { listed: 6, running: 3 }, flip: { inCalls: false, live: true }, proof: { proven: 2, opposite: 1, testing: 11, graded: 340 },
      records: { voices: 7, graded: 55 }, tuneUp: { at: now - 7200000, running: false }, devices: 3, persistent: false, lastTick: now - 1000, lastError: null } });
  const r = by(roster);
  assert.equal(roster.length, 1 + CREW.length + 9 + STAFF.length); assert.ok(roster.length >= 45, 'as many teammates as the bot has parts');
  for (const x of roster) { assert.ok(DEPTS.some(([d]) => d === x.dept), `${x.role} sits in a department`); assert.ok(x.status && x.state && x.key != null, `${x.role} reports`); }
  assert.equal(new Set(roster.map((x) => x.role)).size, roster.length, 'one owner per part');
  assert.match(r.quotes.status, /UP 60¢ bid \/ 62¢ ask · spread 2¢/);
  assert.match(r.exchanges.status, /9 of 12 exchange feeds live/); assert.match(r.tape.status, /75% of the money bought · buyers in charge/);
  assert.equal(r.liqs.state, 'warn'); assert.match(r.liqs.status, /\$2\.4M forced out in 30 min/);
  assert.equal(r.l_voltune.state, 'busy'); assert.match(r.l_voltune.status, /^In the calls: EWMA 0\.94/); assert.match(r.l_cal.status, /^On probation: needs more rounds/);
  assert.match(r.proof.status, /2 kinds of break proven, 1 proven backwards · 11 being tested · 340 cases graded/);
  assert.equal(r.winguard.state, 'warn'); assert.match(r.winguard.status, /Floor 93% · recent 17 of 20 won/);
  assert.match(r.fees.status, /^\$10 at 62¢: 16 contracts, fee \$0\.27, a win pays \$5\.81 after it$/, '16 × 38¢ = $6.08, less Kalshi\'s 27¢ taker fee');
  assert.equal(r.auditor.state, 'warn'); assert.match(r.auditor.status, /while Market Watch holds new calls; the buy \(UP\) and the round call \(DOWN\) disagree/);
  assert.match(r.clerk.status, /Official record: 41 of 45 won · \$12\.30 per \$10/); assert.match(r.early.status, /^Proven · 9 of 10 won/);
  assert.equal(r.archivist.state, 'warn'); assert.match(r.markets.status, /6 markets listed by Kalshi · 3 running a bot/);
  // nothing in: every staff member still answers, quietly
  const empty = by(teamRoster({ now, snap: null }));
  assert.equal(empty.exchanges.state, 'off'); assert.match(empty.l_scan.status, /Not reporting/); assert.equal(empty.auditor.state, 'ok');
});

test('the talk: each teammate tells whoever uses its part, the live reading word for word; the quiet ones say nothing', () => {
  const roster = teamRoster({ now, snap: snap(), record: { guard: { floor: 0.9, n: 0, wins: 0 }, profitGuard: { paused: false, n: 0, usd: 0 } }, parts: { feeds: null, markets: { listed: 2, running: 1 } } }), talk = teamTalk(roster), r = by(roster);
  const roles = new Set(roster.map((x) => x.role));
  for (const m of talk) { assert.ok(roles.has(m.from) && roles.has(m.to) && m.from !== m.to, `${m.from} → ${m.to}`); if (!r[m.from].crew && !r[m.from].manager) assert.equal(m.text, r[m.from].status); }
  assert.ok(talk.some((m) => m.from === 'price' && m.to === 'analyst'), 'the price goes to the Analyst');
  assert.ok(talk.some((m) => m.from === 'analyst' && m.to === 'caller'), 'the odds go to the Caller');
  assert.ok(talk.some((m) => m.from === 'winguard' && m.to === 'risk'), 'the guards report to the Risk officer');
  assert.ok(!talk.some((m) => m.from === 'exchanges'), 'off (no feeds for this market): quiet');
  assert.ok(!talk.some((m) => m.from === 'l_scan'), 'not reporting: quiet');
  assert.ok(new Set(talk.map((m) => m.from)).size >= 20, 'most of the team has something to say');
});

test('the server staff: each reader is optional, and one that throws leaves the rest of the team talking', () => {
  const team = createTeam({ book: { get: () => ({ snap: snap(), sig: null }) }, botOf: () => ({ status: () => ({ devices: 2, lastTick: now }), record: () => { throw new Error('x'); } }), watchOf: () => null,
    stackOf: () => { throw new Error('no stack'); }, tuneUp: { status: () => ({ running: true }) }, markets: () => ({ listed: 4, running: 2 }), persistent: true, clock: () => now });
  const a = team.api('S'), r = by(a.roster);
  assert.equal(a.roster.filter((x) => !x.fixer && !x.helper && !x.trainer).length, 2 + CREW.length + ROLES.length + STAFF.length); // (the Manager and the Doctor) assert.ok(a.roster.some((x) => x.fixer), 'and a fixer per team'); assert.ok(a.talk.length > 10);
  assert.match(r.push.status, /2 phones get push alerts/); assert.equal(r.mechanic.state, 'busy'); assert.match(r.archivist.status, /survives a deploy/);
  assert.equal(r.exchanges.state, 'off', 'no stack: no feeds, said plainly');
});

test('the Near-certain desk says why it is warning', () => {
  const r = Object.fromEntries(teamRoster({ now, snap: snap(), record: { certain: { graded: 25, wins: 23, usd: -4.1, profitGuard: { paused: true, n: 25, usd: -4.1 } } } }).map((x) => [x.role, x]));
  assert.equal(r.certain.state, 'warn');
  assert.match(r.certain.status, /^Paused by the profit guard: its last 25 graded calls lost \$4\.10 at \$10 each, so Near-certain buy alerts are off until they're back in profit · 23 of 25 won · −\$4\.10 per \$10$/);
});
