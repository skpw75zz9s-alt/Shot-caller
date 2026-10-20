// The Manager (v13.70; slacking v13.71): watches every teammate on every reading and makes sure each one is doing
// something, or has a stated reason not to, and isn't slacking. Each teammate lands in one of five:
//   working   on it, acting or warning, and (for the ones that read the live market) its reading is still moving
//   waiting   idle with its reason on show: between rounds, on probation, not enough data yet
//   off       off by design for this market or this server (no futures for gold, Discord not set up)
//   slacking  not stuck, but not producing: its work should move every round (SLACK) and that many rounds have gone
//             by with nothing new from it, or (the Tune-up runner) its tune-up is overdue
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
// what has to move every round, and how many rounds without anything new is slacking:
//   quotes    Kalshi's bid and ask: an hour without one cent of change while rounds run
//   caller    a round call (or a buy) each round
//   accuracy  the strength meter grades every settled round: its count goes up each one
//   proof     the break lab grades ordinary moments every minute: its count goes up all the time
//   l_blend, l_basis  while on probation, each counts settled rounds toward its proof
export const SLACK = { quotes: 4, caller: 3, accuracy: 3, proof: 3, l_blend: 3, l_basis: 3 };
const PROBATION_ONLY = new Set(['l_blend', 'l_basis']);
const ago = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)} min`);

// roster: everyone else. x: { now, live (a round is open), activity: { role: ms its status last changed }, rounds: { role:
// rounds ended since its status last changed }, autoTune (the tune-up schedule), depts: [[key, name]], leads: { dept: role } }.
// Returns { row, flags: { role: { verdict, note } }, groups: { working, waiting, off, slacking, stuck } }
export function managerReport(roster, { now = Date.now(), live = false, activity = {}, rounds = {}, autoTune = null, depts = [], leads = {} } = {}) {
  const groups = { working: [], waiting: [], off: [], slacking: [], stuck: [] }, flags = {};
  for (const r of roster) {
    const quiet = activity[r.role] ? now - activity[r.role] : 0;
    let why = null;
    if (/^Not reporting/.test(r.status || '')) why = 'not reporting at all';
    else if (live && LIVE_READERS.includes(r.role) && r.state !== 'off' && quiet > STALE_MS) why = `its reading hasn't changed in ${ago(quiet)} while a round is open`;
    else if (r.role === 'nightwatch' && r.state === 'warn' && /stopped ticking|Last tick/.test(r.status || '')) why = 'the bot has stopped ticking';
    if (why) { groups.stuck.push(r); flags[r.role] = { verdict: 'stuck', note: `Stuck: ${why}. Flagged to the admin.` }; continue; }
    // slacking: the work that should move every round hasn't
    const limit = r.state === 'off' || (PROBATION_ONLY.has(r.role) && !/^On probation/.test(r.status || '')) ? null : SLACK[r.role];
    let slack = limit && (rounds[r.role] ?? 0) >= limit ? `nothing new in ${rounds[r.role]} rounds, and its work should move every round` : null;
    if (r.role === 'tuner' && autoTune?.on && !autoTune.running && autoTune.at && now - autoTune.at > (autoTune.everyH + 1) * 3600000) slack = `its tune-up is ${Math.round((now - autoTune.at) / 3600000 - autoTune.everyH)} h overdue`;
    if (slack) { groups.slacking.push(r); flags[r.role] = { verdict: 'slacking', note: `Slacking: ${slack}. Get back to it.` }; continue; }
    groups[r.state === 'off' ? 'off' : r.state === 'idle' ? 'waiting' : 'working'].push(r);
  }
  const n = roster.length, w = groups.working.length, st = groups.stuck, sl = groups.slacking;
  const row = {
    role: MANAGER[0], name: MANAGER[1], job: MANAGER[2], dept: 'mgmt', manager: true,
    state: st.length || sl.length ? 'warn' : 'busy',
    status: `${w} of ${n} working · ${groups.waiting.length} waiting for a reason · ${groups.off.length} off by design · ${sl.length ? `${sl.length} slacking: ${sl.slice(0, 3).map((r) => r.name).join(', ')}` : 'nobody slacking'} · ${st.length ? `${st.length} stuck: ${st.slice(0, 3).map((r) => r.name).join(', ')}` : 'nobody stuck'}`,
    key: `stuck:${st.map((r) => r.role).join(',')}|slack:${sl.map((r) => r.role).join(',')}`,
    say: st.length ? `flagged ${st[0].name}: stuck` : sl.length ? `caught ${sl[0].name} slacking` : 'everyone is pulling their weight',
    talks: [],
  };
  // it tells each stuck or slacking teammate, then each department (through its lead, or its first member) where it stands
  for (const r of [...st, ...sl]) row.talks.push({ to: r.role, text: flags[r.role].note });
  for (const [d, name] of depts) {
    const team = roster.filter((r) => r.dept === d);
    if (!team.length) continue;
    const c = (g) => team.filter((r) => groups[g].includes(r)).length;
    row.talks.push({ to: leads[d] && team.some((r) => r.role === leads[d]) ? leads[d] : team[0].role, text: `${name}: ${c('working')} of ${team.length} working${c('waiting') ? `, ${c('waiting')} waiting` : ''}${c('off') ? `, ${c('off')} off` : ''}${c('slacking') ? `, ${c('slacking')} slacking` : ''}${c('stuck') ? `, ${c('stuck')} STUCK` : ''}` });
  }
  return { row, flags, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((r) => r.role)])) };
}
