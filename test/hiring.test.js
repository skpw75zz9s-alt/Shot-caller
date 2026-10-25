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

test('the Recruiter searches nonstop and files what fits; approve hires, decline waits a week, let go removes', async () => {
  let t = et('2026-10-20T12:00:00-04:00');
  const h = createHiring({ file: join(mkdtempSync(join(tmpdir(), 'hire-')), 'hiring.json'), clock: () => t });
  await h.load();
  const ctx = { now: t, markets: [{ series: 'KXBTC15M', name: 'Bitcoin', kind: 'crypto' }, { series: 'KXINX', name: 'S&P 500', kind: 'index' }], calls: Array.from({ length: 40 }, (_, i) => call(i % 5 !== 0)), traders: 0, uptime: h.uptime() };
  const apps = h.search(ctx);
  assert.deepEqual(apps.map((a) => a.key).sort(), ['drawdown', 'hours', 'liquidity', 'math', 'restarts', 'streak'], 'the coaches need more graded calls; the Quiet-spell watcher needs times');
  assert.match(apps.find((a) => a.key === 'hours').why, /S&P 500/); assert.ok(apps.every((a) => !a.standby));
  t += 5000;
  assert.deepEqual(h.search(ctx), [], 'it looks again on the next reading: nobody new, nobody filed twice');
  assert.equal(h.api().searches, 2);
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

test('always at least one applicant: when no gap calls for anyone, the next ready agent stands by', async () => {
  let t = et('2026-10-20T12:00:00-04:00');
  const h = createHiring({ file: join(mkdtempSync(join(tmpdir(), 'hire-')), 'hiring.json'), clock: () => t });
  await h.load();
  const ctx = { now: t, markets: [{ series: 'KXBTC15M', name: 'Bitcoin', kind: 'crypto' }], calls: [], traders: 0, uptime: h.uptime() };
  const pending = () => h.api().applications;
  assert.deepEqual(h.search(ctx).map((a) => a.key), ['restarts'], 'with no record yet, only the Restart watcher fits');
  await h.decide(pending()[0].id, 'approve');
  const s1 = h.search(ctx);
  assert.deepEqual(s1.map((a) => [a.key, !!a.standby]), [['hours', true]], 'nobody fits: the first ready agent stands by');
  assert.match(s1[0].why, /^No gap in the team's data calls for it yet: it's standing by/);
  await h.decide(pending()[0].id, 'decline'); t += 1000;
  assert.deepEqual(h.search(ctx).map((a) => a.key), ['drawdown'], 'decline it and the next one steps up');
  // the data now calls for the one standing by: its application says why
  const calls = Array.from({ length: 40 }, (_, i) => call(i % 5 !== 0));
  h.search({ ...ctx, calls });
  const dd = pending().find((a) => a.key === 'drawdown');
  assert.ok(!dd.standby); assert.match(dd.why, /^40 graded official calls/);
  // everyone declined: the one declined longest ago comes back, and says so
  for (let i = 0; i < 12 && !/nobody else is left/.test(pending()[0]?.why); i++) { for (const a of pending()) await h.decide(a.id, 'decline'); t += 60000; h.search(ctx); }
  const back = pending();
  assert.equal(back.length, 1); assert.equal(back[0].key, 'hours', 'declined first, so it comes back first');
  assert.match(back[0].why, /you declined it \d+ min ago, and nobody else is left/);
  // everyone hired: nobody left to put forward
  for (const c of CANDIDATES) if (!h.hired().includes(c.key)) { const a = pending().find((x) => x.key === c.key) ?? (h.search(ctx, { force: true }), pending().find((x) => x.key === c.key)); if (a) await h.decide(a.id, 'approve'); }
  for (let i = 0; i < 12 && h.hired().length < CANDIDATES.length; i++) { h.search(ctx, { force: true }); for (const a of pending()) await h.decide(a.id, 'approve'); }
  assert.equal(h.hired().length, CANDIDATES.length); h.search(ctx);
  assert.deepEqual(pending(), [], 'the whole catalog is hired'); assert.equal(h.api().catalog, CANDIDATES.length);
});

test('the five newer hires: runs of losses, prices, sides and weekdays that lose, and quiet spells', () => {
  const now = et('2026-10-21T12:00:00-04:00'), mon = et('2026-10-19T12:00:00-04:00'), tue = et('2026-10-20T12:00:00-04:00');
  const run = [call(true, 0.8, 1), call(false, 0.8, 2), call(false, 0.8, 3), call(false, 0.8, 4), call(true, 0.8, 5), ...Array.from({ length: 6 }, (_, i) => call(true, 0.8, 6 + i)), call(false, 0.8, 20), call(false, 0.8, 21), call(false, 0.8, 22)];
  const st = hireRows(['streak'], { now, markets: [], calls: run })[0];
  assert.equal(st.state, 'warn'); assert.match(st.status, /^3 losses in a row · longest losing run before this: 3$/); assert.ok(st.talks.some((x) => x.to === 'risk'));
  // 40 calls at 90¢ that won 60%: a losing band, a losing side, a losing weekday
  const bad = Array.from({ length: 40 }, (_, i) => ({ side: 'NO', price: 0.9, result: i < 24 ? 'no' : 'yes', at: mon })), good = Array.from({ length: 40 }, () => ({ side: 'YES', price: 0.75, result: 'yes', at: tue }));
  const [pc, sc, wd] = hireRows(['pricecoach', 'sidecoach', 'weekday'], { now, markets: [], calls: [...bad, ...good] });
  assert.match(pc.status, /^Losing: bought at 85-95¢ \(40 calls, −\$\d+\.\d\d, z −\d\.\d\)$/);
  assert.match(sc.status, /^Losing: on DOWN \(40 calls/); assert.match(wd.status, /^Losing: on Mondays \(40 calls/);
  assert.equal(hireRows(['pricecoach'], { now, markets: [], calls: good.slice(0, 10) })[0].state, 'idle', 'too few to split');
  // calls an hour apart, then nothing for 6 hours
  const q = hireRows(['quiet'], { now, markets: [], calls: Array.from({ length: 10 }, (_, i) => ({ side: 'YES', price: 0.8, at: now - 6 * 3600000 - i * 3600000 })) })[0];
  assert.equal(q.state, 'warn'); assert.match(q.status, /^Last official call 6 h 0 min ago · the usual gap: 1 h 0 min$/); assert.ok(q.talks.some((x) => x.to === 'caller'));
});

test('in the team: the Recruiter with what\'s waiting, and a hire at work', () => {
  const now = et('2026-10-20T15:50:00-04:00');
  const r = Object.fromEntries(teamRoster({ now, snap: null, hires: { hired: ['hours', 'restarts'], pending: 2, ctx: { now, markets: [{ series: 'KXINX', name: 'S&P 500', kind: 'index' }], calls: [], uptime: { since: now - 3 * 3600000, starts: [now - 3 * 3600000] } } } }).map((x) => [x.role, x]));
  assert.match(r.recruiter.status, /^2 applications waiting for your approval \(Settings → Admin → Hiring center\) · 2 hired · searching nonstop$/);
  assert.match(r.h_hours.status, /^S&P 500: open, closes in 10 min$/); assert.equal(r.h_hours.state, 'busy');
  assert.ok(r.h_hours.talks.some((t) => t.to === 'caller' && /closes in 10 min/.test(t.text)));
  assert.match(r.h_restarts.status, /^Up 3 h 0 min · 1 unplanned start in the last week$/);
  assert.equal(CANDIDATES.length, 12);
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

test('planned restarts (an update, a restart on purpose) are counted apart: only unplanned ones are trouble', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'hire-')), file = join(dir, 'hiring.json');
  let t = et('2026-10-20T12:00:00-04:00');
  for (let i = 0; i < 14; i++) { // 14 starts in a week: 12 after an update's planned stop, 2 on their own
    if (i % 7 !== 0) writeFileSync(join(dir, 'planned-restart.json'), JSON.stringify({ at: t - 30000, why: 'update' }));
    const h = createHiring({ file, clock: () => t }); await h.load(); t += 3600000;
  }
  const h = createHiring({ file, clock: () => t }); await h.load(); // and one more on its own
  const u = h.uptime();
  assert.equal(u.starts.length, 15); assert.equal(u.planned.length, 12);
  const row = CANDIDATES.find((c) => c.key === 'restarts').row({ now: t, uptime: u });
  assert.equal(row.state, 'ok', '3 unplanned starts is fine; the 12 updates don\'t count');
  assert.match(row.status, /3 unplanned starts in the last week \(plus 12 planned/);
  writeFileSync(join(dir, 'planned-restart.json'), JSON.stringify({ at: t - 3600000, why: 'update' }));
  const late = createHiring({ file, clock: () => t }); await late.load();
  assert.equal(late.uptime().planned.length, 12, 'a stale note (an hour old) is not taken for this start');
});
