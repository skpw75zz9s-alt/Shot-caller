import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COUNCIL, councilFacts, credibility, debate } from '../public/council.js';
import { createCouncil } from '../council.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const by = (d) => Object.fromEntries(d.rulings.map((r) => [r.key, r]));

test('agreeing features from different families are all counted; one alone says so', () => {
  const d = debate([{ key: 'scan', pts: 0.03 }, { key: 'tune', pts: 0.02 }], { pYes: 0.6, z: 0.5, minutesLeft: 6 });
  assert.ok(near(d.net, 0.05)); assert.equal(d.argued, false); assert.equal(d.vetoed, 0);
  assert.match(d.verdict, /2 features agree for UP: 5\.0 pts/);
  assert.match(debate([{ key: 'cross', pts: -0.01 }], { pYes: 0.5 }).verdict, /Related markets argues for DOWN: 1\.0 pts/);
  assert.match(debate([], {}).verdict, /No proven feature is arguing/);
});

test('rule 1: the facts beat opinions: no arguing against a big lead or a mostly-settled average', () => {
  const big = debate([{ key: 'scan', pts: -0.05 }, { key: 'tune', pts: 0.02 }], { pYes: 0.95, z: 2.8, minutesLeft: 4 });
  assert.equal(by(big).scan.status, 'vetoed'); assert.match(by(big).scan.why, /the facts settle it: UP leads by 2\.8 typical moves/);
  assert.equal(by(big).tune.status, 'counted', 'arguing with the leader is fine'); assert.ok(near(big.net, 0.02));
  const late = debate([{ key: 'flows', pts: 0.01 }], { pYes: 0.4, z: -1, minutesLeft: 0.2, settle: 'avg60' });
  assert.match(by(late).flows.why, /the settlement average is mostly in/);
  assert.equal(by(debate([{ key: 'flows', pts: 0.01 }], { pYes: 0.4, z: -1, minutesLeft: 0.2, settle: 'spot' })).flows.status, 'counted', 'spot-settled markets have no average');
});

test('rule 2: a feature clearly wrong lately is vetoed, a shaky one discounted, a good record never adds weight', () => {
  const bad = Array(24).fill(0).map((_, i) => (i < 6 ? 1 : 0)); // right 6 of 24
  assert.equal(credibility(bad).veto, true);
  const d = debate([{ key: 'scan', pts: 0.04 }], { pYes: 0.6 }, { scan: bad });
  assert.equal(by(d).scan.status, 'vetoed'); assert.match(by(d).scan.why, /wrong lately: right 6 of its last 24 arguments/);
  const shaky = Array(12).fill(0).map((_, i) => (i < 4 ? 1 : 0)); // right 4 of 12: not enough to veto, enough to doubt
  const c = credibility(shaky); assert.equal(c.veto, false); assert.ok(c.weight < 1 && c.weight >= COUNCIL.floorW);
  const d2 = debate([{ key: 'scan', pts: 0.04 }], { pYes: 0.6 }, { scan: shaky });
  assert.ok(near(d2.net, 0.04 * c.weight)); assert.match(by(d2).scan.why, /counted at \d+%: a shaky record \(right 4 of 12\)/);
  assert.equal(credibility(Array(40).fill(1)).weight, 1, 'proof gets it in; results only take it out');
  // the server sends the records already summed up
  assert.equal(by(debate([{ key: 'scan', pts: 0.04 }], { pYes: 0.6 }, { scan: credibility(bad) })).scan.status, 'vetoed');
});

test('rule 3: one family counts once: echoes are dropped, a split family is vetoed', () => {
  const echo = debate([{ key: 'scan', pts: 0.04 }, { key: 'micro', pts: 0.02 }, { key: 'flip', pts: 0.01 }], { pYes: 0.55 });
  assert.equal(by(echo).scan.status, 'counted'); assert.match(by(echo).micro.why, /an echo of Round scan/); assert.equal(by(echo).flip.status, 'vetoed');
  assert.ok(near(echo.net, 0.04), 'the same order flow, counted once');
  const split = debate([{ key: 'scan', pts: 0.04 }, { key: 'flip', pts: -0.03 }, { key: 'tune', pts: 0.01 }], { pYes: 0.55 });
  assert.equal(by(split).scan.status, 'vetoed'); assert.equal(by(split).flip.status, 'vetoed'); assert.match(by(split).flip.why, /its own data is split: buyers and sellers argue both ways/);
  assert.ok(near(split.net, 0.01));
});

test('rule 4: a real debate across families nets out by weight, capped at 10 points', () => {
  const d = debate([{ key: 'scan', pts: 0.05 }, { key: 'tune', pts: -0.02 }, { key: 'cross', pts: -0.01 }], { pYes: 0.6, z: 0.4 });
  assert.equal(d.argued, true); assert.ok(near(d.net, 0.02));
  assert.match(d.verdict, /A real debate: Round scan for UP against Tuned indicators, Related markets for DOWN\. UP carries it by 2\.0 pts\./);
  assert.match(debate([{ key: 'scan', pts: 0.03 }, { key: 'tune', pts: -0.03 }], { pYes: 0.5 }).verdict, /They cancel out/);
  const cap = debate([{ key: 'scan', pts: 0.08 }, { key: 'playbook', pts: 0.06 }], { pYes: 0.5 });
  assert.equal(cap.net, COUNCIL.cap); assert.match(cap.verdict, /\(capped\)/);
  assert.equal(debate([{ key: 'scan', pts: 0.05 }, { key: 'tune', pts: -0.04 }], { pYes: 0.5 }).rulings.filter((r) => r.status === 'counted').length, 2);
});

test('the round facts from a snapshot row', () => {
  const f = councilFacts({ ev: { minutesLeft: 4, pYes: 0.7 }, pPre: 0.66, strike: 100000, sigma: 0.0005 }, { mSpot: 100100 }, 'avg60');
  assert.equal(f.pYes, 0.66); assert.equal(f.settle, 'avg60'); assert.ok(near(f.z, Math.log(1.001) / 0.001));
  assert.deepEqual(councilFacts(null), {});
});

test('the server council: decides per round, grades what each feature argued at settlement, and remembers', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'council-')), 'council.json');
  let now = 1e12; const c = createCouncil({ file, clock: () => now, log: { error() {} } });
  const snap = { mSpot: 100050, sigmaMin: 0.0005, rows: [{ m: { ticker: 'T1' }, ev: { minutesLeft: 6, pYes: 0.6 }, pPre: 0.6, strike: 100000 }] };
  c.observe('KXBTC15M', snap, 'avg60');
  const out = c.decide('KXBTC15M', [['scan', { T1: 0.04 }], ['micro', { T1: 0.02 }], ['tune', { T1: -0.01 }], ['flows', null]]);
  assert.ok(near(out.T1, 0.03), 'micro echoes the scan; the indicators argue back');
  const a = c.api('KXBTC15M');
  assert.equal(a.ticker, 'T1'); assert.equal(a.debate.argued, true); assert.equal(a.debate.vetoed, 1);
  // the round settles UP: the scan and micro were right, the indicators wrong
  c.settle('KXBTC15M', 'T1', 'yes'); await c.save();
  const r = c.api('KXBTC15M').records;
  assert.deepEqual([r.scan.hits, r.micro.hits, r.tune.hits, r.tune.n], [1, 1, 0, 1]);
  assert.equal(r.scan.name, 'Round scan');
  // a feature wrong round after round loses its voice
  for (let i = 0; i < 25; i++) { now += 1000; c.observe('KXBTC15M', { ...snap, rows: [{ ...snap.rows[0], m: { ticker: `R${i}` } }] }); c.decide('KXBTC15M', [['tune', { [`R${i}`]: -0.02 }]]); c.settle('KXBTC15M', `R${i}`, 'yes'); }
  c.observe('KXBTC15M', { ...snap, rows: [{ ...snap.rows[0], m: { ticker: 'R99' } }] });
  assert.equal(c.decide('KXBTC15M', [['tune', { R99: -0.02 }]]), null, 'vetoed: wrong lately');
  assert.match(c.api('KXBTC15M').debate.rulings[0].why, /wrong lately/);
  await c.save(); c.stop();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.records.KXBTC15M.tune.length <= COUNCIL.keep);
  const again = createCouncil({ file, log: { error() {} } }); await again.load();
  assert.equal(again.api('KXBTC15M').records.tune.veto, true); again.stop();
});

test('arguments made in the final minute are not graded', async () => {
  const c = createCouncil({ file: join(mkdtempSync(join(tmpdir(), 'council-')), 'c.json'), log: { error() {} } });
  c.observe('S', { mSpot: 100, sigmaMin: 0.001, rows: [{ m: { ticker: 'L' }, ev: { minutesLeft: 0.5, pYes: 0.5 }, strike: 100 }] }, 'spot');
  c.decide('S', [['scan', { L: 0.02 }]]); c.settle('S', 'L', 'yes');
  assert.equal(c.api('S').records.scan, undefined); c.stop();
});
