// The hiring center on the server (v13.77; the candidates: public/hires.js). The Recruiter searches nonstop (every
// reading, v13.81) for gaps the hires fill and files an application for each candidate that fits; the admin approves
// or declines it in Settings → Admin. There's always at least one applicant: when nobody fits a gap, the next ready
// candidate stands by (said plainly on its application), until everyone in the catalog is hired. Kept in
// DATA_DIR/hiring.json: the applications, who's hired, and the server's start times (the Restart watcher). A declined
// candidate doesn't apply again for a week, unless it's the only one left to stand by.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CANDIDATES, TRIAL_H } from './public/hires.js';
import { writeAtomic } from './atomicfile.js';

const WEEK = 7 * 86400000;
const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < 172800000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} days`);
export function createHiring({ file, clock = () => Date.now(), log = console, everyMs = 0 } = {}) {
  let db = { apps: [], hired: [], starts: [], searchedAt: 0, trials: {} }, since = clock();
  async function load() {
    try { const j = JSON.parse(await readFile(file, 'utf8')); db = { apps: j.apps || [], hired: j.hired || [], starts: j.starts || [], searchedAt: j.searchedAt || 0, trials: j.trials || {} }; } catch { /* first start */ }
    since = clock(); db.starts = [...db.starts.filter((t) => t > since - 30 * 86400000), since];
    await save();
  }
  async function save() {
    try { await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify(db)); } catch (e) { log.error?.('saving the hiring center failed', e.message); }
  }
  // ctx: what the candidates read (public/hires.js). Files an application for each candidate that fits and isn't hired,
  // waiting, or declined in the last week; then, if nobody is waiting, one candidate stands by. Returns the new applications.
  function search(ctx, { force = false } = {}) {
    const now = clock();
    if (!force && now - db.searchedAt < everyMs) return [];
    db.searchedAt = now; db.searches = (db.searches || 0) + 1;
    const out = [], declinedAt = (k) => Math.max(0, ...db.apps.filter((a) => a.key === k && a.status === 'declined').map((a) => a.at));
    const file = (c, why, standby = false) => { const app = { id: `${c.key}-${now}`, key: c.key, name: c.name, icon: c.icon, dept: c.dept, job: c.job, does: c.does, cant: c.cant, why, at: now, status: 'pending', ...(standby ? { standby: true } : {}) }; db.apps.unshift(app); out.push(app); };
    let changed = false;
    for (const c of CANDIDATES) {
      if (db.hired.includes(c.key)) continue;
      let why = null;
      try { why = c.fit(ctx); } catch { /* doesn't fit */ }
      const waiting = db.apps.find((a) => a.key === c.key && a.status === 'pending');
      if (waiting) { if (waiting.standby && why) { waiting.why = why; delete waiting.standby; changed = true; } continue; } // standing by, and now the data calls for it
      if (why && !(declinedAt(c.key) > now - WEEK)) file(c, why);
    }
    // always one waiting: the first candidate not declined this week, or else the one declined longest ago
    if (!db.apps.some((a) => a.status === 'pending')) {
      const free = CANDIDATES.filter((c) => !db.hired.includes(c.key));
      const pick = free.find((c) => !(declinedAt(c.key) > now - WEEK)) ?? free.slice().sort((x, y) => declinedAt(x.key) - declinedAt(y.key))[0];
      if (pick) { const d = declinedAt(pick.key); file(pick, `No gap in the team's data calls for it yet${d > now - WEEK ? ` (you declined it ${ago(now - d)} ago, and nobody else is left)` : ''}: it's standing by so there's always someone for you to look at.`, true); }
    }
    db.apps = db.apps.slice(0, 50);
    if (out.length || changed || force) save();
    return out;
  }
  async function decide(id, decision) {
    const a = db.apps.find((x) => x.id === id);
    if (decision === 'fire') { const key = id; db.hired = db.hired.filter((k) => k !== key); delete db.trials[key]; db.apps.unshift({ id: `${key}-${clock()}-out`, key, name: CANDIDATES.find((c) => c.key === key)?.name ?? key, at: clock(), status: 'let go' }); await save(); return { ok: true }; }
    if (!a || a.status !== 'pending') return { error: 'no such application waiting' };
    if (decision === 'approve') { a.status = 'hired'; a.decidedAt = clock(); if (!db.hired.includes(a.key)) db.hired.push(a.key); db.trials[a.key] = clock(); } // on probation from now (hires.js TRIAL_H)
    else if (decision === 'decline') { a.status = 'declined'; a.decidedAt = clock(); a.at = clock(); }
    else return { error: 'decision must be approve, decline or fire' };
    await save();
    return { ok: true };
  }
  return {
    load, save, search, decide,
    hired: () => [...db.hired],
    trials: () => ({ ...db.trials }),
    // a hire flagged stuck or broken during its trial starts it again
    restartTrial(key) { const t = db.trials[key]; if (t && clock() - t < TRIAL_H * 3600000) { if (clock() - t > 60000) { db.trials[key] = clock(); save(); } return true; } return false; }, // (saved at most once a minute while it stays flagged)
    uptime: () => ({ since, starts: db.starts }),
    api: () => ({ searches: db.searches || 0, catalog: CANDIDATES.length, applications: db.apps.filter((a) => a.status === 'pending'), hired: db.hired.map((k) => { const c = CANDIDATES.find((x) => x.key === k); return { key: k, name: c?.name ?? k, icon: c?.icon ?? '•', job: c?.job ?? '' }; }), history: db.apps.filter((a) => a.status !== 'pending').slice(0, 10), searchedAt: db.searchedAt }),
  };
}
