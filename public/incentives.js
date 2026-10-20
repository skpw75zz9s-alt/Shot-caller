// Merit pay (v13.75): every teammate earns or loses points for what it verifiably did, never for looking busy. The one
// incentive that changes the bot was already there: proof earns influence (a learner or a council voice gets a say in
// the calls only by being right, and loses it by being wrong). This makes the rest visible: a score per teammate, an
// Employee of the hour, and a word from the Manager for whoever is in the red. Points don't change any call.
//   +20  a fix that cleared a flag (the fixer or floor helper who made it)
//   +50  a learner proving itself on rounds it never saw          −25  one dropped back to probation
//   +5   back on track: a flag of its own cleared                 −10  flagged stuck    −5 slacking    −3 hurting or broken
//   −5   a fixer or helper that had to hand a flag to the admin
//   +10 × (result − price)  each graded official call, to the Caller: a win at 90¢ is +1, a loss at 90¢ is −9
//   +1   each hour on the job (not stuck, slacking or off)        +1  each headline the News scout routes (10 an hour at most)
export const POINTS = { fixed: 20, proven: 50, dropped: -25, recovered: 5, stuck: -10, slacking: -5, hurting: -3, broken: -3, escalated: -5, hour: 1, headline: 1, callX: 10 };
const FLAG = ['stuck', 'slacking', 'hurting', 'broken'];

// what to compare from one reading to the next
export function snapshot(roster) {
  const flags = {}, on = {}, working = {};
  for (const r of roster) {
    flags[r.role] = FLAG.filter((v) => (r.reviews || []).some((x) => x.verdict === v));
    if (r.role.startsWith('l_')) on[r.role] = r.state === 'busy';
    working[r.role] = r.state !== 'off' && !flags[r.role].some((v) => v === 'stuck' || v === 'slacking');
  }
  return { flags, on, working };
}
// the points from one reading to the next: [{ role, d, why }]
export function scoreChanges(prev, cur, names = {}) {
  if (!prev) return [];
  const out = [], nm = (r) => names[r] || r;
  for (const [role, fl] of Object.entries(cur.flags)) {
    const was = prev.flags[role] || [];
    for (const v of fl) if (!was.includes(v)) out.push({ role, d: POINTS[v], why: `flagged ${v}` });
    if (was.length && !fl.length) out.push({ role, d: POINTS.recovered, why: 'back on track' });
  }
  for (const [role, on] of Object.entries(cur.on)) {
    if (prev.on[role] === false && on) out.push({ role, d: POINTS.proven, why: 'proved itself: now shaping the calls' });
    if (prev.on[role] === true && !on) out.push({ role, d: POINTS.dropped, why: 'dropped back to probation' });
  }
  return out.map((e) => ({ ...e, name: nm(e.role) }));
}
// a graded official call, to the Caller
export const callPoints = (c) => Math.round(POINTS.callX * ((String(c.side).toLowerCase() === c.result ? 1 : 0) - c.price) * 10) / 10;

// ledger: { role: [{ t, d, why }] } (the last 24 h). Returns { role: { day, hour, last } }, the Employee of the hour and who's in the red
export function standings(ledger, now = Date.now()) {
  const score = {};
  for (const [role, evs] of Object.entries(ledger)) {
    const day = evs.reduce((a, e) => a + e.d, 0), hour = evs.filter((e) => e.t > now - 3600000).reduce((a, e) => a + e.d, 0);
    score[role] = { day: Math.round(day * 10) / 10, hour: Math.round(hour * 10) / 10, last: evs[evs.length - 1] ?? null };
  }
  const ranked = Object.entries(score).sort((a, b) => b[1].hour - a[1].hour || b[1].day - a[1].day);
  const star = ranked.find(([, s]) => s.hour > 0)?.[0] ?? null, red = ranked.filter(([, s]) => s.hour < 0).map(([r]) => r).reverse();
  return { score, star, red, top: ranked.filter(([, s]) => s.day > 0).slice(0, 5).map(([r]) => r), bottom: ranked.filter(([, s]) => s.day < 0).slice(-3).reverse().map(([r]) => r) };
}
const pts = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
export { pts };
