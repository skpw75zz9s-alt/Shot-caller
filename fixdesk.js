// The flag fixers' desk on the server (v13.72; public/fixers.js plans): runs the fixes the fixers plan and keeps the record.
//   step(series, plans)  for each flag a fixer can fix: run its action, at most MAX_TRIES times, cooldownMs apart (the
//                        tune-up at most once an hour, across markets); a flag still up after MAX_TRIES is escalated. A
//                        flag that clears after a try is logged as fixed (the last 50 per market, in memory)
//   state(series)        { open: { flag: { tries, last, status } }, fixed: [{ t, dept, role, name, action }] }
// actions: { restartFeeds(series), restartFutures(series), kickBot(series), tuneUp() }: each returns true when it ran.
import { MAX_TRIES, fixKey } from './public/fixers.js';

// (the floor helpers use a second desk: a 30-minute cooldown and 6 tries, v13.73)
export function createFixDesk({ actions = {}, clock = () => Date.now(), cooldownMs = 10 * 60000, tuneEveryMs = 3600000, maxTries = MAX_TRIES, log = console } = {}) {
  const per = new Map(); // series -> { open, fixed }
  let lastTune = 0;
  const lastRun = new Map(); // `${series}:${action}` -> ms (one action fixes every flag it covers: run it once per cooldown)
  function step(series, plans) {
    const now = clock(), s = per.get(series) ?? { open: {}, fixed: [] }, seen = new Set();
    for (const p of plans) {
      if (p.how !== 'fix') continue;
      const k = fixKey(p), o = (s.open[k] ||= { tries: 0, last: 0, status: 'fixing', role: p.role, name: p.name, dept: p.dept, action: p.action });
      seen.add(k);
      if (o.status === 'escalated') continue;
      if (o.tries >= maxTries) { if (now - o.last >= cooldownMs) o.status = 'escalated'; continue; } // still up a cooldown after the last try: it needs the admin
      if (now - o.last < cooldownMs) continue;
      const runKey = `${series}:${p.action}`;
      const due = p.action === 'tuneUp' ? now - lastTune >= tuneEveryMs : now - (lastRun.get(runKey) ?? 0) >= cooldownMs;
      if (!due) { o.tries++; o.last = now; continue; } // the same fix just ran for another flag (one reconnect covers both): that's this one's try too
      let ran = false;
      try { ran = !!actions[p.action]?.(series); } catch (e) { log.error?.(`fix ${p.action} for ${series} failed`, e.message); }
      if (p.action === 'tuneUp') lastTune = now; else lastRun.set(runKey, now);
      o.tries++; o.last = now;
      if (!ran) o.status = 'escalated'; // there was nothing to run (no such feed here): straight to the admin
    }
    // a flag that's gone: fixed, if a fixer had tried; either way it leaves the open list
    for (const [k, o] of Object.entries(s.open)) {
      if (seen.has(k)) continue;
      if (o.tries > 0 && o.status !== 'escalated') s.fixed.unshift({ t: now, dept: o.dept, role: o.role, name: o.name, action: o.action });
      delete s.open[k];
    }
    if (s.fixed.length > 50) s.fixed.length = 50;
    per.set(series, s);
  }
  return { step, state: (series) => per.get(series) ?? { open: {}, fixed: [] } };
}
