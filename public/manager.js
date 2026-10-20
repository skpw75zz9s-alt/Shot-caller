// The Manager (v13.70): watches every teammate on every reading and makes sure each one is doing something, or has a
// stated reason not to. Each teammate lands in one of four:
//   working   on it, acting or warning, and (for the ones that read the live market) its reading is still moving
//   waiting   idle with its reason on show: between rounds, on probation, not enough data yet
//   off       off by design for this market or this server (no futures for gold, Discord not set up)
//   stuck     what nobody should be: silent (not reporting), or frozen: a live reading that hasn't changed in
//             STALE_MS while a round is open, or a bot that has stopped ticking
// Pure: the server (team.js) keeps when each teammate's status last changed (activity) and passes it in. The Manager
// reports; it doesn't fix. Anyone stuck is flagged to the admin in the live window, and the Manager tells them and
// each department where it stands.
export const MANAGER = ['manager', 'Manager', 'makes sure everyone is doing something', '👔'];
export const STALE_MS = 120000;
// the teammates whose status is a live reading that must keep moving during an open round: the price (to the cent) and
// the Analyst's odds and minutes left. (Kalshi's quotes can rightly sit still for minutes, so they aren't on this list.)
export const LIVE_READERS = ['price', 'analyst'];
const ago = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)} min`);

// roster: everyone else. x: { now, live (a round is open), activity: { role: ms its status last changed }, depts: [[key, name]],
// leads: { dept: role } }. Returns { row, flags: { role: note }, groups: { working, waiting, off, stuck } }
export function managerReport(roster, { now = Date.now(), live = false, activity = {}, depts = [], leads = {} } = {}) {
  const groups = { working: [], waiting: [], off: [], stuck: [] }, flags = {};
  for (const r of roster) {
    const quiet = activity[r.role] ? now - activity[r.role] : 0;
    let why = null;
    if (/^Not reporting/.test(r.status || '')) why = 'not reporting at all';
    else if (live && LIVE_READERS.includes(r.role) && r.state !== 'off' && quiet > STALE_MS) why = `its reading hasn't changed in ${ago(quiet)} while a round is open`;
    else if (r.role === 'nightwatch' && r.state === 'warn' && /stopped ticking|Last tick/.test(r.status || '')) why = 'the bot has stopped ticking';
    if (why) { groups.stuck.push(r); flags[r.role] = `Stuck: ${why}. Flagged to the admin.`; continue; }
    groups[r.state === 'off' ? 'off' : r.state === 'idle' ? 'waiting' : 'working'].push(r);
  }
  const n = roster.length, w = groups.working.length, st = groups.stuck;
  const row = {
    role: MANAGER[0], name: MANAGER[1], job: MANAGER[2], dept: 'mgmt', manager: true,
    state: st.length ? 'warn' : 'busy',
    status: `${w} of ${n} working · ${groups.waiting.length} waiting for a reason · ${groups.off.length} off by design · ${st.length ? `${st.length} stuck: ${st.slice(0, 3).map((r) => r.name).join(', ')}` : 'nobody stuck'}`,
    key: `stuck:${st.map((r) => r.role).join(',')}`,
    say: st.length ? `flagged ${st[0].name}: stuck` : 'nobody is stuck',
    talks: [],
  };
  // it tells each stuck teammate, then each department (through its lead, or its first member) where it stands
  for (const r of st) row.talks.push({ to: r.role, text: flags[r.role] });
  for (const [d, name] of depts) {
    const team = roster.filter((r) => r.dept === d);
    if (!team.length) continue;
    const c = (g) => team.filter((r) => groups[g].includes(r)).length;
    row.talks.push({ to: leads[d] && team.some((r) => r.role === leads[d]) ? leads[d] : team[0].role, text: `${name}: ${c('working')} of ${team.length} working${c('waiting') ? `, ${c('waiting')} waiting` : ''}${c('off') ? `, ${c('off')} off` : ''}${c('stuck') ? `, ${c('stuck')} STUCK` : ''}` });
  }
  return { row, flags, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((r) => r.role)])) };
}
