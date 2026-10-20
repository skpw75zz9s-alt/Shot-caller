import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANDIDATES, byHour, drawdown, hireRows, session } from '../public/hires.js';
import { createHiring } from '../hiring.js';
import { teamRoster } from '../public/team.js';

const et = (iso) => Date.parse(iso); // times given with the ET offset
const call = (won, price = 0.8, at = 0) => ({ side: 'YES', price, result: won ? 'yes' : 'no', at });

test('market hours: the stock market (9:30-4:00 ET weekdays), CME (Sunday 6pm to Friday 5pm, a break each day), crypto always', () => {
  assert.deepEqual(session('index', et('2026-10-20T10:00:00-04:00')), { open: true, minutes: 360 }, 'a Tuesday at 10:00: closes at 4:00');
  assert.deepEqual(session('index', et('2026-10-20T16:30:00-04:00')), { open: false, minutes: 1020 }, 'opens 9:30 the next morning');
  assert.equal(session('index', et('2026-10-24T12:00:00-04:00')).open, false, 'a Saturday');
  assert.equal(session('commodity', et('2026-10-20T17:30:00-04:00')).open, false, 'the daily break');
  assert.equal(session('commodity', et('2026-10-20T18:30:00-04:00')).open, true);
  assert.equal(session('commodity', et('2026-10-25T19:00:00-04:00')).open, true, 'Sunday evening: open');
  assert.equal(session('crypto', Date.now()).always, true);
});

test('drawdown and the hours that lose', () => {
  const d = drawdown([call(true), call(true), call(false), call(false), call(true)]);
  assert.equal(d.n, 5); assert.ok(d.worst < -15 && d.now < 0, JSON.stringify(d));
  const night = et('2026-10-20T22:00:00-04:00'), noon = et('2026-10-20T12:00:00-04:00');
  const calls = [...Array.from({ length: 40 }, (_, i) => call(i < 24, 0.9, night)), ...Array.from({ length: 40 }, (_, i) => call(i < 37, 0.9, noon))];
  const b = byHour(calls), bad = b.filter((x) => x.n >= 30 && x.z <= -2);
  assert.deepEqual(bad.map((x) => x.from), [20], '8pm-midnight: 60% won at 90¢ over 40 calls');
  const row = hireRows(['hourcoach'], { now: noon, markets: [], calls })[0];
  assert.equal(row.state, 'warn'); assert.match(row.status, /^Losing hours: 8pm-12am ET \(40 calls, −\$\d+\.\d\d, z −\d\.\d\)$/);
  assert.ok(row.talks.some((t) => t.to === 'caller'));
});

test('the Recruiter files what fits, an hour apart; approve hires, decline waits a week, let go removes', async () => {
  let t = et('2026-10-20T12:00:00-04:00');
  const h = createHiring({ file: join(mkdtempSync(join(tmpdir(), 'hire-')), 'hiring.json'), clock: () => t });
  await h.load();
  const ctx = { now: t, markets: [{ series: 'KXBTC15M', name: 'Bitcoin', kind: 'crypto' }, { series: 'KXINX', name: 'S&P 500', kind: 'index' }], calls: Array.from({ length: 40 }, (_, i) => call(i % 5 !== 0)), traders: 0, uptime: h.uptime() };
  const apps = h.search(ctx);
  assert.deepEqual(apps.map((a) => a.key).sort(), ['drawdown', 'hours', 'liquidity', 'restarts'], 'the hour-of-day coach needs 120 graded calls');
  assert.match(apps.find((a) => a.key === 'hours').why, /S&P 500/);
  assert.deepEqual(h.search(ctx), [], 'not again within the hour');
  const id = (k) => h.api().applications.find((a) => a.key === k).id;
  await h.decide(id('hours'), 'approve'); await h.decide(id('liquidity'), 'decline');
  assert.deepEqual(h.hired(), ['hours']);
  t += 2 * 3600000;
  assert.deepEqual(h.search({ ...ctx, now: t }).map((a) => a.key), [], 'hired ones, waiting ones and the declined one (for a week): nobody new');
  t += 8 * 86400000;
  assert.deepEqual(h.search({ ...ctx, now: t }).map((a) => a.key), ['liquidity'], 'a week later it applies again');
  await h.decide('hours', 'fire'); assert.deepEqual(h.hired(), []);
  assert.deepEqual((await h.decide('nope', 'approve')).error, 'no such application waiting');
  const h2 = createHiring({ file: join(mkdtempSync(join(tmpdir(), 'hire-')), 'hiring.json'), clock: () => t }); await h2.load();
  assert.equal(h2.uptime().starts.length, 1, 'each start recorded (the Restart watcher)');
});

test('in the team: the Recruiter with what\'s waiting, and a hire at work', () => {
  const now = et('2026-10-20T15:50:00-04:00');
  const r = Object.fromEntries(teamRoster({ now, snap: null, hires: { hired: ['hours', 'restarts'], pending: 2, ctx: { now, markets: [{ series: 'KXINX', name: 'S&P 500', kind: 'index' }], calls: [], uptime: { since: now - 3 * 3600000, starts: [now - 3 * 3600000] } } } }).map((x) => [x.role, x]));
  assert.match(r.recruiter.status, /^2 applications waiting for your approval \(Settings → Admin → Hiring center\) · 2 hired$/);
  assert.match(r.h_hours.status, /^S&P 500: open, closes in 10 min$/); assert.equal(r.h_hours.state, 'busy');
  assert.ok(r.h_hours.talks.some((t) => t.to === 'caller' && /closes in 10 min/.test(t.text)));
  assert.match(r.h_restarts.status, /^Up 3 h 0 min · 1 start in the last week$/);
  assert.equal(CANDIDATES.length, 5);
});

// ---------- a new hire starts on probation, and the Training room picks it up the moment it joins ----------
import { trainerRows } from '../public/training.js';
import { createTeam } from '../team.js';

test('a new hire is on a 24-hour trial, and its trainer is there from its first reading', () => {
  const now = et('2026-10-20T12:00:00-04:00'), ctx = (h) => ({ now: now + h * 3600000, markets: [], calls: [], uptime: { since: now - 3600000, starts: [now] }, trials: { restarts: now } });
  const at = (h) => teamRoster({ now: now + h * 3600000, snap: null, hires: { hired: ['restarts'], pending: 0, ctx: ctx(h) } });
  const r0 = at(0), hire0 = r0.find((x) => x.role === 'h_restarts');
  assert.ok(hire0.trial); assert.match(hire0.status, /^On probation \(new hire, 24 h left of its trial\): Up /);
  const t0 = trainerRows(r0).find((x) => x.role === 'tr_h_restarts');
  assert.ok(t0, 'picked up at once'); assert.match(t0.status, /^On probation · 0 of 24 hours of its trial \(0%\) · about 24 h to go at this pace$/);
  const t6 = trainerRows(at(6)).find((x) => x.role === 'tr_h_restarts'); assert.match(t6.status, /6 of 24 hours of its trial \(25%\) · about 18 h to go/);
  const r24 = at(24), t24 = trainerRows(r24).find((x) => x.role === 'tr_h_restarts');
  assert.ok(!r24.find((x) => x.role === 'h_restarts').trial); assert.match(t24.status, /graduated its trial: a full member of the team/);
});

test('in the team: approve a hire and, on the very next reading, it is on probation with a trainer; graduation pays both', async () => {
  let t = et('2026-10-20T12:00:00-04:00');
  const hiring = createHiring({ file: join(mkdtempSync(join(tmpdir(), 'hire-')), 'hiring.json'), clock: () => t }); await hiring.load();
  const team = createTeam({ book: { get: () => ({ snap: null, sig: null }) }, botOf: () => null, watchOf: () => null, clock: () => t, hiring, markets: () => ({ listed: 1, running: 1 }), news: () => ({ on: true, headlines: [], events: [] }) });
  team.observe('S');
  hiring.search(team.hireCtx('S'), { force: true });
  await hiring.decide(hiring.api().applications.find((a) => a.key === 'restarts').id, 'approve');
  t += 5000; team.observe('S');
  const by = () => Object.fromEntries(team.api('S').roster.map((x) => [x.role, x]));
  const b = by();
  assert.ok(b.h_restarts?.trial, 'on probation from the reading it joins'); assert.ok(b.tr_h_restarts, 'and the Training room has it');
  assert.match(b.tr_h_restarts.status, /hours of its trial/);
  for (let i = 0; i < 25; i++) { t += 3600000; team.observe('S'); }
  const c = by();
  assert.match(c.tr_h_restarts.status, /graduated its trial/);
  assert.ok(c.h_restarts.score.day >= 50 && c.tr_h_restarts.score.day >= 50, 'the hire and its trainer each +50');
});
