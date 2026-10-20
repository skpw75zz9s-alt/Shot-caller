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
