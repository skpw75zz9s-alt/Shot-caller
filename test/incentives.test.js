import test from 'node:test';
import assert from 'node:assert/strict';
import { POINTS, callPoints, scoreChanges, snapshot, standings } from '../public/incentives.js';
import { createTeam } from '../team.js';

const now = 1e12;
const r = (role, state, verdicts = []) => ({ role, name: role, state, reviews: verdicts.map((verdict) => ({ by: 'manager', verdict, note: '' })) });

test('points move on verified changes only, and nothing on the first reading', () => {
  const a = snapshot([r('price', 'ok'), r('l_cal', 'idle'), r('l_vol', 'busy'), r('caller', 'ok', ['slacking'])]);
  assert.deepEqual(scoreChanges(null, a), [], 'no back-pay for what was already true');
  const b = snapshot([r('price', 'ok', ['stuck']), r('l_cal', 'busy'), r('l_vol', 'idle'), r('caller', 'ok')]);
  const evs = Object.fromEntries(scoreChanges(a, b).map((e) => [e.role, [e.d, e.why]]));
  assert.deepEqual(evs, { price: [POINTS.stuck, 'flagged stuck'], caller: [POINTS.recovered, 'back on track'], l_cal: [POINTS.proven, 'proved itself: now shaping the calls'], l_vol: [POINTS.dropped, 'dropped back to probation'] });
  assert.deepEqual(scoreChanges(b, b), [], 'nothing changed, nothing earned');
});

test('the Caller is paid by result against price: a sure thing that wins earns little, one that loses costs a lot', () => {
  assert.equal(callPoints({ side: 'YES', result: 'yes', price: 0.9 }), 1);
  assert.equal(callPoints({ side: 'YES', result: 'no', price: 0.9 }), -9);
  assert.equal(callPoints({ side: 'NO', result: 'no', price: 0.6 }), 4);
});

test('standings: the Employee of the hour, who is in the red, the leaderboard', () => {
  const st = standings({ fx_desk: [{ t: now - 1000, d: 20, why: 'fixed Exchange runner' }], caller: [{ t: now - 2000, d: -9, why: 'a call lost at 90¢' }], price: [{ t: now - 7200000, d: 5, why: 'back on track' }] }, now);
  assert.equal(st.star, 'fx_desk'); assert.deepEqual(st.red, ['caller']);
  assert.deepEqual(st.top, ['fx_desk', 'price']); assert.deepEqual(st.bottom, ['caller']);
  assert.deepEqual(st.score.price, { day: 5, hour: 0, last: { t: now - 7200000, d: 5, why: 'back on track' } });
  assert.equal(standings({}, now).star, null);
});

test('in the team: a fixer that clears a flag earns +20 and is Employee of the hour; a graded call pays the Caller; no back-pay', () => {
  let t = now, live = 0, calls = [{ ticker: 'OLD', side: 'YES', price: 0.9, result: 'no' }];
  const team = createTeam({ book: { get: () => ({ snap: { spot: 1, mSpot: 1, rows: [] }, sig: null }) }, clock: () => t, watchOf: () => null,
    botOf: () => ({ record: () => ({ calls, profitGuard: { paused: false } }) }), markets: () => ({ listed: 1, running: 1 }), news: () => ({ on: true, headlines: [], events: [] }),
    stackOf: () => ({ scanFeed: { api: () => ({ feeds: { a: live ? 'live' : 'off' } }) }, asset: { kind: 'crypto' } }), fixes: { restartFeeds: () => true } });
  team.observe('S');
  const by = () => Object.fromEntries(team.api('S').roster.map((x) => [x.role, x]));
  assert.equal(by().caller.score.day, 0, 'the old graded call isn\'t back-paid');
  live = 1; calls = [...calls, { ticker: 'NEW', side: 'YES', price: 0.8, result: 'yes' }]; t += 5000; team.observe('S');
  const b = by();
  assert.equal(b.fx_desk.score.hour, POINTS.fixed); assert.equal(b.fx_desk.score.last.why, 'fixed Exchange runner'); assert.ok(b.fx_desk.star);
  assert.equal(b.exchanges.score.hour, POINTS.recovered, 'back on track (its flag was already up on the first reading: no charge for it)');
  assert.equal(b.caller.score.day, 2, 'a win at 80¢: +10 × 0.2');
  assert.match(b.manager.status, /Employee of the hour: Market desk fixer \(\+20\)/);
  assert.ok(b.manager.talks.some((m) => m.to === 'fx_desk' && /^Employee of the hour: \+20 this hour \(last: fixed Exchange runner\)\. Keep it up\.$/.test(m.text)));
  assert.deepEqual(b.manager.leaderboard.top.map((x) => x.role).slice(0, 1), ['fx_desk']);
});
