// The Training room (v13.76): a trainer for every learner (and the Flip checker). What gets a learner off probation is
// new graded rounds: it has to beat what the bot does now on data it never saw, and nothing can hurry that without
// cheating (rerunning the test until one run passes by luck). So a trainer does what's real:
//   pace      where its trainee is against the bar it has to reach (its own counter: 40 of 150 rounds, 3,200 of 10,080
//             minutes of history…) and, from how fast that counter has moved lately, about how long until it's judged
//             (judged, not passed: it can still fail)
//   the path  a trainee that can't gather data because something it reads is broken (the exchange feeds for the scan,
//             the micro model and the flip check; the futures for the micro model): it tells that team's fixer
//   the test  it never reruns a test to fish for a pass, and says so
// A trainee that proves itself earns its trainer +50 merit (incentives.js), and the trainer keeps watching: a proven
// learner stays only while it keeps proving itself.
import { LEARNERS } from './team.js';

// every trainee: the learners, the Flip checker, and every hire still on its trial (hires.js): picked up the moment it
// joins (the server adds the trainers, team.js; read lazily: team.js is still loading when this one is)
export const trainees = (roster = []) => [...LEARNERS.map(([k, name]) => [`l_${k}`, name]), ['flipdesk', 'Flip checker'], ...roster.filter((r) => r.hire).map((r) => [r.role, r.name])];
// what each trainee reads that can break: [teammate role, what it gives]
const NEEDS = { l_scan: [['exchanges', 'the exchange feeds']], l_micro: [['exchanges', 'the exchange feeds'], ['futures', 'the futures feed']], flipdesk: [['exchanges', 'the exchange feeds']] };
// a counter in a trainee's own status: "40/150 rounds", "3 of 10 settlements", "0/120 graded calls"
export function counterOf(status) {
  const m = String(status || '').match(/(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)\s*([a-z][a-z ]{2,30})?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')), need = Number(m[2].replace(/,/g, ''));
  return need > 0 && n <= need * 10 ? { n, need, what: (m[3] || '').trim().replace(/\s+(before|to|for|in)\b.*$/, '') } : null;
}
const hrs = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
const fmt = (n) => n.toLocaleString('en-US');

// roster: everyone; progress: { role: { n, need, what } } the server knows directly (minutes of history, graded
// predictions…), else the trainee's own counter; pace: { role: counter per hour, lately }
export function trainerRows(roster, { progress = {}, pace = {} } = {}) {
  const by = Object.fromEntries(roster.map((r) => [r.role, r]));
  return trainees(roster).filter(([role]) => by[role]).map(([role, name]) => {
    const t = by[role], proven = t.hire ? !t.trial : t.state === 'busy' && /^(In the calls|Its proven)/.test(t.status || '');
    const p = progress[role] ?? t.trialProgress ?? counterOf(t.status), rate = pace[role] ?? (t.trial ? 1 : undefined); // a trial moves an hour an hour
    const blocked = (NEEDS[role] || []).filter(([dep]) => by[dep] && (by[dep].state === 'warn' || by[dep].state === 'off'));
    const left = p ? Math.max(0, p.need - p.n) : null, eta = left && rate > 0 ? left / rate : null;
    const where = p ? `${fmt(p.n)} of ${fmt(p.need)}${p.what ? ` ${p.what}` : ''} (${Math.min(100, Math.round((p.n / p.need) * 100))}%)` : null;
    const row = { role: `tr_${role}`, name: `${name} trainer`, job: `trains the ${name} toward its proof`, dept: 'train', trainer: true, trainee: role, talks: [] };
    // the road to graduation (the live window's bar): stage, how far along, and the time to go when it's measurable
    const road = (stage, extra = {}) => ({ trainee: role, name, stage, pct: p ? Math.min(100, (p.n / p.need) * 100) : null, n: p?.n ?? null, need: p?.need ?? null, what: p?.what ?? '', eta, ...extra });
    if (/^Not reporting/.test(t.status || '')) return { ...row, state: 'idle', status: `${name} isn't reporting: nothing to train on`, key: 'none', road: road('silent') };
    if (proven) {
      row.talks.push({ to: role, text: 'You proved yourself. You stay in the calls only while you keep proving it, so keep at it.' });
      return { ...row, state: 'ok', status: t.hire ? `${name} graduated its trial: a full member of the team.` : `${name} graduated: proven and shaping the calls. Watching that it keeps proving itself.`, key: 'grad', say: `${name} graduated`, road: road('graduated', { pct: 100 }) };
    }
    if (blocked.length) {
      for (const [dep, what] of blocked) row.talks.push({ to: `fx_${by[dep].dept}`, text: `My trainee, the ${name}, can't gather data without ${what} (${by[dep].name}: ${by[dep].status}).` });
      row.talks.push({ to: role, text: `You can't train right now: ${blocked.map(([, what]) => what).join(' and ')} ${blocked.length === 1 ? 'is' : 'are'} down. I've told the fixer.` });
      return { ...row, state: 'warn', status: `Blocked: the ${name} can't gather data without ${blocked.map(([, what]) => what).join(' and ')}${where ? ` · at ${where}` : ''}`, key: `blocked:${blocked.map(([d]) => d).join(',')}`, say: `${name} is blocked`, road: road('blocked', { why: blocked.map(([, what]) => what).join(' and ') }) };
    }
    const status = where
      ? `On probation · ${where}${left === 0 ? ' · the bar is reached: it\'s judged on its next test' : eta != null ? ` · about ${hrs(eta)} to go at this pace` : ' · not moving yet: it needs new rounds'}`
      : 'On probation · its test reruns on new data on its own schedule; there\'s no counter to push, and rerunning it to fish for a pass would be cheating';
    row.talks.push({ to: role, text: where ? `You're at ${where}${eta != null ? `: about ${hrs(eta)} to go` : ''}. Every new graded round counts; there's no shortcut.` : 'Your test reruns on new data on its own. No shortcuts: you prove yourself on rounds you never saw.' });
    return { ...row, state: 'busy', status, key: `${p ? Math.floor((p.n / p.need) * 10) : 'x'}:${left === 0}`, road: road(!p ? 'scheduled' : left === 0 ? 'judging' : 'probation') };
  });
}
