// The flag fixers (v13.72): one per team (department). Every flag on its team (stuck or slacking from the Manager,
// hurting or broken from the Improvement crew) gets one of three answers:
//   fix       a real fix the server can make (fixdesk.js runs it, at most MAX_TRIES times, a cooldown apart):
//               reconnect the exchange feeds, reconnect the futures feed, make sure the bot's loop is running, or run
//               the tune-up now (it reruns every learner, and still keeps a setting only if it proves better)
//   handled   the bot already has a rule for it (the council vetoes a voice with a bad record; the profit guard pauses
//             calls that lose money): nothing to do but say so
//   escalate  nothing in code can fix it, or the fix was tried MAX_TRIES times and the flag is still up: it goes to the
//             admin with what to do
// A fix counts as fixed only when the flag actually clears. Pure: the server runs the fixes and keeps the record.
export const MAX_TRIES = 3;
export const FIX_ICON = '🛠️';
const FLAGS = new Set(['stuck', 'slacking', 'hurting', 'broken']);
export const ACTIONS = {
  restartFeeds: 'reconnect the exchange feeds',
  restartFutures: 'reconnect the futures feed',
  kickBot: 'make sure the bot\'s loop is running',
  tuneUp: 'run the tune-up now to rerun the learners',
};
// what each flag gets: the first rule that matches (role pattern, the flag's verdict, who raised it)
const RULES = [
  { roles: /^(exchanges|tape|liqs)$/, verdicts: ['stuck', 'slacking', 'broken'], action: 'restartFeeds' },
  { roles: /^futures$/, verdicts: ['stuck', 'slacking', 'broken'], action: 'restartFutures' },
  { roles: /^(price|analyst|nightwatch|quotes|scout)$/, verdicts: ['stuck', 'slacking', 'broken'], action: 'kickBot' },
  { roles: /^(l_\w+|flipdesk|tuner|mechanic)$/, verdicts: ['stuck', 'slacking'], action: 'tuneUp' },
  { by: 'reviewer', verdicts: ['hurting'], handled: 'The council already vetoes it until its record turns around.' },
  { roles: /^caller$/, by: 'valuer', verdicts: ['hurting'], handled: 'The profit guard pauses calls that lose money to their prices.' },
  { roles: /^archivist$/, escalate: 'Add a volume in Railway (the service → Volumes), mount it, and set DATA_DIR to its path, so the records survive a deploy.' },
  { roles: /^caller$/, verdicts: ['slacking'], escalate: 'No round call in several rounds: check the Deck and the server log for what is holding the calls.' },
  { by: 'accuracy', verdicts: ['hurting'], escalate: 'A layer of the odds is making them less accurate on graded rounds: look at the Record tab\'s strength card before changing any setting.' },
];

// roster: everyone (with the reviews the Manager and the crew wrote). Returns [{ dept, role, name, verdict, by, note, how, action?, help? }]
export function planFixes(roster) {
  const out = [];
  for (const r of roster) {
    if (r.manager || r.fixer) continue;
    for (const v of r.reviews || []) {
      if (!FLAGS.has(v.verdict)) continue;
      const rule = RULES.find((x) => (!x.roles || x.roles.test(r.role)) && (!x.verdicts || x.verdicts.includes(v.verdict)) && (!x.by || x.by === v.by));
      const how = rule?.action ? 'fix' : rule?.handled ? 'handled' : 'escalate';
      out.push({ dept: r.dept, role: r.role, name: r.name, verdict: v.verdict, by: v.by, note: v.note, how, action: rule?.action ?? null, help: rule?.handled ?? rule?.escalate ?? v.note });
    }
  }
  return out;
}
export const fixKey = (p) => `${p.role}:${p.verdict}:${p.by}`;

// one fixer per team. depts: [[key, name]]; desk: the fix record (fixdesk.js state(series)): { open: { key: { tries, last,
// status } }, fixed: [{ t, role, name, action }] }
export function fixerRows(roster, plans, desk = {}, { now = Date.now(), depts = [] } = {}) {
  const open = desk.open || {}, fixed = desk.fixed || [], rows = [];
  for (const [d, dname] of depts) {
    if (d === 'mgmt' || !roster.some((r) => r.dept === d && !r.fixer)) continue;
    const mine = plans.filter((p) => p.dept === d), done = fixed.filter((f) => f.dept === d && f.t > now - 86400000);
    const fixing = mine.filter((p) => p.how === 'fix' && open[fixKey(p)]?.status !== 'escalated');
    const escalated = mine.filter((p) => p.how === 'escalate' || open[fixKey(p)]?.status === 'escalated'), handled = mine.filter((p) => p.how === 'handled');
    const tries = (p) => open[fixKey(p)]?.tries ?? 0;
    const parts = [
      fixing.length ? `Fixing: ${fixing.map((p) => `${p.name} (${ACTIONS[p.action]}, try ${Math.max(1, tries(p))} of ${MAX_TRIES})`).join('; ')}` : '',
      escalated.length ? `Escalated to the admin: ${escalated.map((p) => p.name).join(', ')}` : '',
      handled.length ? `Already handled: ${handled.map((p) => p.name).join(', ')}` : '',
    ].filter(Boolean);
    const talks = mine.map((p) => {
      const o = open[fixKey(p)];
      return { to: p.role, text: p.how === 'handled' ? `Handled: ${p.help}` : p.how === 'escalate' || o?.status === 'escalated' ? `Escalated to the admin${o?.tries ? ` after ${o.tries} tries` : ''}: ${p.help}` : `On it: I'll ${ACTIONS[p.action]} (try ${Math.max(1, tries(p))} of ${MAX_TRIES}).` };
    });
    if (mine.length) talks.push({ to: 'manager', text: `${dname}: ${fixing.length} fixing, ${escalated.length} escalated, ${handled.length} already handled` });
    rows.push({
      role: `fx_${d}`, name: `${dname} fixer`, job: `fixes the flags on the ${dname}`, dept: d, fixer: true,
      state: escalated.length ? 'warn' : fixing.length ? 'busy' : 'ok',
      status: parts.length ? parts.join(' · ') : `No flags to fix${done.length ? ` · fixed ${done.length} in the last day (last: ${done[0].name}, ${ACTIONS[done[0].action]})` : ''}`,
      key: `${fixing.map(fixKey).join(',')}|${escalated.map(fixKey).join(',')}|${done.length}`,
      say: escalated.length ? `escalated ${escalated[0].name} to the admin` : fixing.length ? `fixing ${fixing[0].name}` : done.length ? `fixed ${done[0].name}` : null,
      talks, escalations: escalated.map((p) => ({ role: p.role, name: p.name, help: p.help, tries: open[fixKey(p)]?.tries ?? 0 })),
    });
  }
  return rows;
}

// ---------- the floor helpers (v13.73): one per floor, the second line when a teammate is still stuck ----------
// What a fixer escalated (no fix in code, or MAX_TRIES didn't clear it) goes to its floor's helper before the admin:
//   the feeds    a fixer reconnects 3 times, 10 minutes apart; exchanges come back after outages, so the helper keeps
//                reconnecting every 30 minutes, HELP_TRIES times (3 hours)
//   the bot      a fixer makes sure the loop is running; the helper also lets go of a tick that has hung (bot.js unstick)
//   the rest     no fix in code (or the helper's tries ran out too): handed to the admin, with what to do
export const HELP_TRIES = 6, HELP_ICON = '🦺';
const HELP_ACTION = { restartFeeds: 'restartFeeds', restartFutures: 'restartFutures', kickBot: 'unstickBot' };
export const HELP_ACTIONS = { restartFeeds: 'keep reconnecting the exchange feeds every 30 minutes', restartFutures: 'keep reconnecting the futures feed every 30 minutes', unstickBot: 'let go of a hung bot cycle and restart the loop' };
// plans: the fixers' plans; desk: the fixers' record. Returns the flags the helpers take: [{ ...plan, how: 'fix' | 'handoff', action }]
export function helpPlans(plans, desk = {}) {
  const open = desk.open || {};
  return plans.filter((p) => p.how === 'escalate' || (p.how === 'fix' && open[fixKey(p)]?.status === 'escalated'))
    .map((p) => { const action = p.how === 'fix' ? HELP_ACTION[p.action] ?? null : null; return { ...p, how: action ? 'fix' : 'handoff', action, fixerTries: open[fixKey(p)]?.tries ?? 0 }; });
}
// floors: [[key, name, [depts]]]; help: the helpers' record (a second fix desk)
export function helperRows(roster, hplans, help = {}, { now = Date.now(), floors = [], depts = [] } = {}) {
  const open = help.open || {}, fixed = help.fixed || [], dname = Object.fromEntries(depts);
  return floors.map(([f, fname, ds]) => {
    const mine = hplans.filter((p) => ds.includes(p.dept)), done = fixed.filter((x) => ds.includes(x.dept) && x.t > now - 86400000);
    const helping = mine.filter((p) => p.how === 'fix' && open[fixKey(p)]?.status !== 'escalated');
    const handoff = mine.filter((p) => p.how === 'handoff' || open[fixKey(p)]?.status === 'escalated');
    const tries = (p) => Math.max(1, open[fixKey(p)]?.tries ?? 0);
    const stuckHere = roster.filter((r) => ds.includes(r.dept) && (r.reviews || []).some((v) => v.verdict === 'stuck')).length;
    const parts = [
      helping.length ? `Helping: ${helping.map((p) => `${p.name} (${HELP_ACTIONS[p.action]}, try ${tries(p)} of ${HELP_TRIES})`).join('; ')}` : '',
      handoff.length ? `Handed to the admin: ${handoff.map((p) => p.name).join(', ')}` : '',
    ].filter(Boolean);
    const talks = mine.map((p) => ({ to: p.role, text: p.how === 'fix' && open[fixKey(p)]?.status !== 'escalated' ? `I've got you: the ${dname[p.dept] || 'team'} fixer tried ${p.fixerTries || 'its'} time${p.fixerTries === 1 ? '' : 's'}, so I'll ${HELP_ACTIONS[p.action]} (try ${tries(p)} of ${HELP_TRIES}).` : `Handed to the admin: ${p.help}` }));
    for (const d of ds) if (mine.some((p) => p.dept === d)) talks.push({ to: `fx_${d}`, text: `I'm taking the escalations from the ${dname[d]}.` });
    return {
      role: `fh_${f}`, name: `${fname} helper`, job: `helps anyone stuck on the ${fname.toLowerCase()}`, dept: ds[0], floor: f, helper: true,
      state: handoff.length ? 'warn' : helping.length ? 'busy' : 'ok',
      status: parts.length ? parts.join(' · ') : `Nobody stuck on this floor${stuckHere ? ` (${stuckHere} flagged, with its fixer)` : ''}${done.length ? ` · got ${done.length} back on track in the last day (last: ${done[0].name})` : ''}`,
      key: `${helping.map(fixKey).join(',')}|${handoff.map(fixKey).join(',')}|${done.length}`,
      say: handoff.length ? `handed ${handoff[0].name} to the admin` : helping.length ? `stepped in for ${helping[0].name}` : done.length ? `got ${done[0].name} back on track` : null,
      talks, handoffs: handoff.map((p) => ({ role: p.role, name: p.name, help: p.help, tries: (p.fixerTries || 0) + (open[fixKey(p)]?.tries ?? 0) })),
    };
  });
}
