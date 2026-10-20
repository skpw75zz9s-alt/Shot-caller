import test from 'node:test';
import assert from 'node:assert/strict';
import { CREW, crewRoster, priceCheck } from '../public/improve.js';
import { teamRoster, teamTalk } from '../public/team.js';
import { createTeam } from '../team.js';

const now = 1e12;
const by = (r) => Object.fromEntries(r.map((x) => [x.role, x]));
const calls = (n, winRate, price) => Array.from({ length: n }, (_, i) => ({ side: 'YES', price, result: i < Math.round(n * winRate) ? 'yes' : 'no' }));

test('the price check: wins against the prices paid, with a z only a real edge clears', () => {
  assert.deepEqual(priceCheck([]), { n: 0 });
  const even = priceCheck(calls(100, 0.9, 0.9));
  assert.equal(even.n, 100); assert.equal(even.wins, 90); assert.ok(Math.abs(even.edge) < 1e-9 && Math.abs(even.z) < 1e-9, 'winning exactly what the price needs: no edge');
  const losing = priceCheck(calls(100, 0.8, 0.9));
  assert.ok(losing.edge < -0.09 && losing.z <= -3, `10 points short over 100 calls is clear (z ${losing.z.toFixed(1)})`);
  assert.equal(priceCheck([{ side: 'NO', price: 0.7, result: 'no' }, { side: 'NO', price: 0.7, result: null }]).n, 1, 'only graded calls count');
});

test('the crew grades each part on its record and tells the teammate it coaches', () => {
  const x = {
    now, snap: null,
    council: { scan: { n: 40, hit: 0.65, z: 2.3, veto: false }, micro: { n: 30, hit: 0.35, z: -1.8, veto: true }, tune: { n: 6, hit: 0.5, z: 0, veto: false }, flows: { n: 25, hit: 0.55, z: 0.5, veto: false } },
    kinds: { jump: { status: 'proven' }, lag: { status: 'noise' }, lead: { status: 'opposite' }, gap: { status: 'testing' }, book: { status: 'fact' } },
    calls: calls(60, 0.75, 0.9),
    strength: { rounds: 80, steps: { blend: { n: 80, diff: -0.01, z: -2.6 }, council: { n: 80, diff: 0.004, z: 2.2 } }, vsKalshi: { n: 80, diff: 0.001, z: 0.4 }, words: ['Stronger than a coin flip.'] },
    learners: [{ key: 'voltune', name: 'v', on: true }, { key: 'cal', name: 'c', on: false }],
    parts: { autoTune: { on: true, everyH: 6, at: now - 2 * 3600000, changed: 1, of: 3, running: false }, learnerSince: { cal: now - 3 * 3600000 }, persistent: false },
  };
  const roster = teamRoster(x), r = by(roster), rv = (role, who) => r[role].reviews?.find((v) => v.by === who);
  assert.deepEqual(roster.slice(0, CREW.length).map((c) => c.role), CREW.map(([k]) => k), 'the crew sits first, in its own room');
  assert.ok(roster.slice(0, CREW.length).every((c) => c.dept === 'improve' && c.crew));
  // the Tune-up runner: the one that acts, on the tune-up's own rule
  assert.match(r.tuner.status, /Last tune-up 2 h ago: proven settings in use on 1 of 3 markets · runs every 6 h · next in 4 h/);
  // the reviewer: the council's records, voice by voice
  assert.equal(rv('l_scan', 'reviewer').verdict, 'helping'); assert.equal(rv('l_micro', 'reviewer').verdict, 'hurting'); assert.match(rv('l_micro', 'reviewer').note, /right 35% of 30.*vetoes/);
  assert.equal(rv('l_tune', 'reviewer').verdict, 'data'); assert.equal(rv('flows', 'reviewer').verdict, 'ok');
  assert.match(r.reviewer.status, /4 voices reviewed: 1 helping, 1 hurting \(vetoed\), 1 no edge yet, 1 still gathering data/); assert.equal(r.reviewer.state, 'warn');
  // the break coach
  assert.match(rv('inspector', 'breakcoach').note, /Trust: jump\. Read the other way: lead\. Noise, ignore: lag\. Still being tested: 1\./);
  // the price checker: 75% won at 90¢ over 60 calls is clearly losing to the prices
  assert.equal(r.valuer.state, 'warn'); assert.match(r.valuer.status, /Calls won 45 of 60 \(75%\) at an average 90¢: −15\.0 pts against breakeven \(z −3\.9\)/);
  assert.equal(rv('caller', 'valuer').verdict, 'hurting');
  // the accuracy coach: the blend helps, the council's nudges hurt, versus Kalshi not clear
  assert.equal(rv('l_blend', 'accuracy').verdict, 'helping'); assert.equal(rv('judge', 'accuracy').verdict, 'hurting'); assert.equal(rv('analyst', 'accuracy').verdict, 'ok');
  // the medic: the archivist isn't on a volume
  assert.equal(rv('archivist', 'medic').verdict, 'broken'); assert.equal(r.medic.state, 'warn');
  // the mentor: a time only where it saw the change happen
  assert.match(rv('l_cal', 'mentor').note, /^On probation for 3 h:/); assert.match(rv('l_voltune', 'mentor').note, /^Proven and shaping the calls\. /);
  // and they say it to the teammate
  const talk = teamTalk(roster);
  assert.ok(talk.some((m) => m.from === 'reviewer' && m.to === 'l_micro' && /vetoes/.test(m.text)));
  assert.ok(talk.some((m) => m.from === 'valuer' && m.to === 'caller'));
  assert.ok(talk.some((m) => m.from === 'medic' && m.to === 'archivist'));
});

test('with too little data nobody is called helping or hurting', () => {
  const { crew, reviews } = crewRoster({ now, calls: calls(10, 1, 0.5), strength: { rounds: 5, steps: { blend: { n: 5, diff: -0.2, z: -5 } } }, council: { scan: { n: 5, hit: 1, z: 3, veto: false } } }, teamRoster({ now, snap: null }).filter((x) => !x.crew));
  const all = Object.values(reviews).flat();
  assert.ok(!all.some((v) => (v.verdict === 'helping' || v.verdict === 'hurting') && v.by !== 'medic'), JSON.stringify(all));
  assert.match(by(crew).valuer.status, /\(10 of 30 needed to judge\)/);
});

test('the server crew: the mentor only gives a time once it has seen a learner change', () => {
  let t = now, on = false;
  const team = createTeam({ book: { get: () => ({ snap: null, sig: null }) }, botOf: () => ({ learnStatus: () => ({ using: [{ key: 'cal', name: 'Calibration', on, detail: 'x' }] }) }), watchOf: () => null,
    autoTune: () => ({ on: false, everyH: 6 }), clock: () => t });
  const note = () => by(team.api('S').roster).l_cal.reviews.find((v) => v.by === 'mentor').note;
  team.observe('S');
  assert.match(note(), /^On probation: it shapes nothing/, 'found on probation at the start: no "for"');
  t += 7200000; on = true; team.observe('S'); t += 3600000; team.observe('S');
  assert.match(note(), /^Proven and shaping the calls for 1 h\./);
  assert.match(by(team.api('S').roster).tuner.status, /Automatic tune-ups are off/);
});
