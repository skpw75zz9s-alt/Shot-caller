// The Doctor (v13.80): makes the rounds of every teammate that needs attention (a warning, or a flag from the Manager or
// the Improvement crew) and writes each one a chart:
//   triage      critical (the calls depend on it), serious (broken, stuck, slacking or hurting), needs you (only the
//               admin can fix it), or watch (a warning that is the report itself: a guard doing its job, the market)
//   diagnosis   what's wrong, and the root cause: when one part fails, the parts that read it go quiet too (the bot's
//               loop stops: the price, the odds and Kalshi's quotes freeze; the price feed falls behind: the Scout holds
//               and the odds stall; the exchange feeds drop: the tape and the learners that read them starve). Each
//               symptom is charted under its cause, and the cause's fixer is told what fixing it clears
//   treatment   who's on it: its team's fixer (try n of 3), its floor's helper (try n of 6), a rule that already
//               handles it, or you, with what to do
//   second opinion  a Feed medic flag on a warning that is the market, not a fault (a wide or crossed Kalshi book, a
//               wave of liquidations, Market Watch holding calls on purpose) is cleared before the fixers plan: no feed
//               reconnects or kicked bot for it, nothing handed to you, no merit lost. The warning itself stays on show.
// Pure. The Doctor diagnoses and refers; the fixes are still the fixers' and the floor helpers' (fixers.js).
import { ACTIONS, HELP_ACTIONS, HELP_TRIES, MAX_TRIES, fixKey } from './fixers.js';

export const DOCTOR = ['doctor', 'Doctor', 'makes the rounds of everyone who needs attention: what is wrong, why, and who is treating it', '🧑‍⚕️'];
export const TRIAGE = { critical: ['🔴', 'critical'], you: ['🟣', 'needs you'], serious: ['🟠', 'serious'], watch: ['🟢', 'just watching'] };
const ORDER = { critical: 0, you: 1, serious: 2, watch: 3 };
const FLAGS = new Set(['stuck', 'slacking', 'hurting', 'broken']);
const flagsOf = (r) => (r.reviews || []).filter((v) => FLAGS.has(v.verdict) && !v.cleared);
const isStaff = (r) => !(r.manager || r.fixer || r.helper || r.trainer || r.crew || r.doctor);
// the parts the calls can't run without
const CRITICAL = new Set(['nightwatch', 'price', 'analyst']);

// a warning that is the market or a guard working, not a fault: why, or null
export function notAFault(r) {
  const k = String(r.key ?? '');
  if (r.role === 'quotes' && k === 'wide') return 'Kalshi\'s spread is wide: that\'s the market\'s own order book, not a broken feed, and it narrows when traders come back.';
  if (r.role === 'quotes' && k === 'crossed') return 'Kalshi\'s book is crossed for the moment: that\'s Kalshi\'s own data, and reconnecting our feeds can\'t change it.';
  if (r.role === 'liqs' && k === 'big') return 'A wave of forced trades is news for the X-ray, not a broken feed.';
  if (r.role === 'scout' && k.startsWith('hold:')) return 'Market Watch is holding new calls on purpose: a guard doing its job. It lifts on its own.';
  return null;
}
// a warning a guard raises by design: what it means
const GUARD = {
  risk: 'A guard is doing its job: new calls wait until what tripped it clears.',
  profitguard: 'The profit guard is doing its job: calls stay paused until recent ones are back in profit at their prices.',
  winguard: 'The win-rate guard raised the bar after losses: fewer calls until the record recovers. That\'s the rule working.',
  early: 'Its guard paused it: early calls lost money at their prices, so they wait until they\'re back in profit.',
  late: 'The profit guard paused it: late calls lost money at their prices, so they wait until they\'re back in profit.',
  certain: 'The profit guard paused it: nearly sure calls lost money at their prices, so they wait until they\'re back in profit.',
  inspector: 'Open breaks are the Inspector\'s findings, not a fault: the X-ray tests each kind before it counts.',
  fees: 'At this price the fee eats the whole win: a reason not to buy here, not a fault.',
  auditor: 'Usually one reading out of step with another, and gone on the next. If it stays for minutes, it\'s a real bug to report.',
};

// Before the fixers plan: clear the Feed medic's flags on warnings that aren't faults. Returns [{ role, name, why }]
export function secondOpinion(roster) {
  const cleared = [];
  for (const r of roster) {
    const why = notAFault(r);
    if (!why) continue;
    for (const v of r.reviews || []) if (v.by === 'medic' && v.verdict === 'broken' && !v.cleared) { v.cleared = why; cleared.push({ role: r.role, name: r.name, why }); }
  }
  const medic = roster.find((r) => r.role === 'medic');
  if (medic && cleared.length) {
    const left = roster.filter((r) => (r.reviews || []).some((v) => v.by === 'medic' && v.verdict === 'broken' && !v.cleared)).length;
    medic.status += ` · the Doctor cleared ${cleared.map((c) => c.name).join(', ')}: the market, not a fault`;
    if (!left) { medic.state = 'ok'; medic.say = 'every feed and system is healthy (the Doctor cleared the rest)'; }
  }
  return cleared;
}

// who's treating each teammate, from the fixers' plans and both fix desks (fixdesk.js state): { role: { how, who?, text } }
// how: fixing (its team's fixer), helping (its floor's helper), handled (a rule already does it), you (the admin)
export function careOf(plans = [], desk = {}, hplans = [], help = {}, { depts = [], floors = [] } = {}) {
  const dn = Object.fromEntries(depts), open = desk.open || {}, hopen = help.open || {}, hp = Object.fromEntries(hplans.map((p) => [fixKey(p), p]));
  const rank = { handled: 1, fixing: 2, helping: 3, you: 4 }, out = {};
  for (const p of plans) {
    const k = fixKey(p), o = open[k], h = hp[k], ho = hopen[k];
    let c;
    if (p.how === 'handled') c = { how: 'handled', text: p.help };
    else if (p.how === 'fix' && o?.status !== 'escalated') c = { how: 'fixing', who: `${dn[p.dept] || 'Its team\'s'} fixer`, text: `${ACTIONS[p.action]} (try ${Math.max(1, o?.tries ?? 0)} of ${MAX_TRIES})` };
    else if (h?.how === 'fix' && ho?.status !== 'escalated') c = { how: 'helping', who: `${floors.find(([, , ds]) => ds.includes(p.dept))?.[1] ?? 'Its floor\'s'} helper`, text: `${HELP_ACTIONS[h.action]} (try ${Math.max(1, ho?.tries ?? 0)} of ${HELP_TRIES})` };
    else c = { how: 'you', text: p.help };
    if (!out[p.role] || rank[c.how] > rank[out[p.role].how]) out[p.role] = c;
  }
  return out;
}

const down = (r) => !!r && (r.state === 'warn' || flagsOf(r).some((v) => v.verdict === 'stuck' || v.verdict === 'broken'));
// the part a symptom reads from, when that part is down: its role, or null
function causeOf(r, by) {
  const night = by.nightwatch, price = by.price, feeds = by.exchanges;
  if (['price', 'analyst', 'quotes', 'caller', 'scout'].includes(r.role) && night && (night.key === 'slow' || night.key === 'err' || flagsOf(night).some((v) => v.verdict === 'stuck'))) return 'nightwatch';
  if (['scout', 'analyst', 'caller'].includes(r.role) && price && (price.key === 'delayed' || flagsOf(price).some((v) => v.verdict === 'stuck'))) return 'price';
  if (['tape', 'liqs', 'l_scan', 'l_micro', 'flipdesk'].includes(r.role) && feeds && (feeds.key === 'down' || down(feeds))) return 'exchanges';
  return null;
}
const rxOf = (c) => (!c ? 'No fix in code for this one: the Doctor keeps watching it.'
  : c.how === 'handled' ? `Already handled: ${c.text}`
    : c.how === 'you' ? `Needs you: ${c.text}`
      : `${c.who} is on it: ${c.text}.`);

// After the fixers and helpers: the Doctor's row, and a chart on every patient (r.chart). care: careOf(...); cleared:
// secondOpinion(...). Returns the row; its charts: [{ role, name, triage, dx, rx, cause?, symptoms? }], worst first
export function doctorRound(roster, { care = {}, cleared = [] } = {}) {
  const by = Object.fromEntries(roster.map((r) => [r.role, r]));
  const patients = roster.filter((r) => isStaff(r) && (r.state === 'warn' || flagsOf(r).length));
  const isPatient = new Set(patients.map((r) => r.role));
  const charts = patients.map((r) => {
    const f = flagsOf(r), c = care[r.role], cause = causeOf(r, by), calm = notAFault(r) || (!f.length ? GUARD[r.role] : null);
    const dx = f.length ? [...new Set(f.map((v) => v.note))].join(' ') : r.status;
    if (cause && cause !== r.role && isPatient.has(cause)) return { role: r.role, name: r.name, triage: null, cause, dx, rx: `Treat the cause: the ${by[cause].name} is down and this reads from it. It clears when that does.` };
    if (calm && !f.length) return { role: r.role, name: r.name, triage: 'watch', dx: r.status, rx: `No treatment needed: ${calm}` };
    if (c?.how === 'you') return { role: r.role, name: r.name, triage: 'you', dx, rx: rxOf(c) };
    if (CRITICAL.has(r.role)) return { role: r.role, name: r.name, triage: 'critical', dx, rx: rxOf(c) };
    if (f.length) return { role: r.role, name: r.name, triage: c?.how === 'handled' && f.every((v) => v.verdict === 'hurting') ? 'watch' : 'serious', dx, rx: rxOf(c) };
    return { role: r.role, name: r.name, triage: 'watch', dx: r.status, rx: c ? rxOf(c) : 'No flag on it: the Doctor keeps watching it.' };
  });
  // symptoms take their cause's triage, and the cause lists them
  const byRole = Object.fromEntries(charts.map((c) => [c.role, c]));
  for (const c of charts) if (c.cause) { const k = byRole[c.cause]; c.triage = k?.triage ?? 'serious'; if (k) (k.symptoms ||= []).push(c.name); }
  charts.sort((a, b) => ORDER[a.triage] - ORDER[b.triage] || !!a.cause - !!b.cause);
  for (const c of charts) by[c.role].chart = { triage: c.triage, dx: c.dx, rx: c.rx, ...(c.cause ? { cause: by[c.cause].name } : {}), ...(c.symptoms ? { symptoms: c.symptoms } : {}) };
  const of = (t) => charts.filter((c) => c.triage === t), crit = of('critical'), you = of('you'), ser = of('serious'), watch = of('watch');
  const roots = charts.filter((c) => c.symptoms?.length);
  const parts = patients.length ? [
    `${patients.length} patient${patients.length === 1 ? '' : 's'}: ${[crit.length && `${crit.length} critical`, you.length && `${you.length} need${you.length === 1 ? 's' : ''} you`, ser.length && `${ser.length} serious`, watch.length && `${watch.length} just watching`].filter(Boolean).join(', ')}`,
    ...roots.map((c) => `root cause: the ${c.name} (behind ${c.symptoms.length} more)`),
  ] : ['Everyone is healthy'];
  if (cleared.length) parts.push(`cleared ${cleared.length} false alarm${cleared.length === 1 ? '' : 's'} (${cleared.map((c) => c.name).join(', ')})`);
  const talks = charts.map((c) => ({ to: c.role, text: `${TRIAGE[c.triage][1][0].toUpperCase()}${TRIAGE[c.triage][1].slice(1)}: ${c.rx}` }));
  for (const c of roots) talks.push({ to: `fx_${by[c.role].dept}`, text: `Root cause: the ${c.name}. Fixing it clears ${c.symptoms.length} more (${c.symptoms.join(', ')}).` });
  for (const c of cleared) talks.push({ to: 'medic', text: `Second opinion on the ${c.name}: ${c.why}` });
  if (patients.length) talks.push({ to: 'manager', text: parts.join(' · ') });
  return {
    role: DOCTOR[0], name: DOCTOR[1], job: DOCTOR[2], dept: 'mgmt', doctor: true,
    state: crit.length || you.length ? 'warn' : ser.length ? 'busy' : 'ok',
    status: parts.join(' · '),
    key: `${charts.map((c) => `${c.role}:${c.triage}`).join(',')}|${cleared.map((c) => c.role).join(',')}`,
    say: crit.length ? `${crit[0].name}: critical` : you.length ? `${you[0].name} needs the admin` : ser.length ? `treating the ${ser[0].name}` : cleared.length ? `cleared a false alarm on the ${cleared[0].name}` : 'everyone is healthy',
    talks, charts, cleared,
  };
}

// the Doctor's rounds as list items (the Deck's Bot team card and the live window): worst first, then the false alarms
export function clinicHtml(roster, { icon = {}, esc = (x) => String(x ?? '') } = {}) {
  const d = roster.find((r) => r.doctor);
  if (!d) return '';
  const li = (d.charts || []).map((c) => `<li class="dx ${c.triage}"><div class="dx-h"><span>${TRIAGE[c.triage][0]} ${icon[c.role] || ''} <b>${esc(c.name)}</b></span><em>${TRIAGE[c.triage][1]}</em></div><p>${esc(c.dx)}</p>${c.symptoms?.length ? `<p class="dx-root">Root cause of: ${esc(c.symptoms.join(', '))}</p>` : ''}<p class="dx-rx">${esc(c.rx)}</p></li>`);
  const ok = (d.cleared || []).map((c) => `<li class="dx cleared"><div class="dx-h"><span>✅ ${icon[c.role] || ''} <b>${esc(c.name)}</b></span><em>false alarm</em></div><p class="dx-rx">${esc(c.why)}</p></li>`);
  return [...li, ...ok].join('') || '<li class="dx empty">Everyone is healthy: nobody needs the Doctor right now.</li>';
}
