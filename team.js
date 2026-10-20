// The bot team on the server (v13.65; public/team.js builds the roster): every 5 seconds, per market, each teammate's
// status from the part of the bot it owns, and a feed of what changed (the last 60 lines per market, in memory).
//   observe(series)   reads every part (the market book's snapshot, Market Watch, the X-ray, the council, the round
//                     call, the guards, the auto-traders, the learners, the strength meter, Discord, Ask)
//   api(series)       the roster and the feed
//   live(series)      the same, read fresh (at most once a second): the admin's live window (v13.66, public/team-live.js)
//   (the staff, v13.67: each asset's readers from stackOf, the related markets, the tune-up, the market list, storage)
import { DEPTS, FLOORS, liveRow, teamBase, teamChanges, teamPulse, teamTalk, withManager } from './public/team.js';
import { liqSummary, positioning } from './public/xray.js';
import { HELP_TRIES, fixerRows, helpPlans, helperRows, planFixes } from './public/fixers.js';
import { createFixDesk } from './fixdesk.js';
import { POINTS, callPoints, pts, scoreChanges, snapshot, standings } from './public/incentives.js';

const tryIt = (f) => { try { return f(); } catch { return null; } };
export function createTeam({ book, botOf, watchOf, council, breakLab, strength, autotraders = () => 0, discord, askMode = () => 'free answers',
  stackOf = () => null, crossFeed = null, tuneUp = null, autoTune = () => null, markets = () => null, persistent = null, fixes = {}, news = () => null, nameOf = () => null, clock = () => Date.now(), everyMs = 5000 }) {
  const desk = createFixDesk({ actions: fixes, clock }); // the flag fixers' fixes (fixdesk.js)
  const helpDesk = createFixDesk({ actions: fixes, clock, cooldownMs: 30 * 60000, maxTries: HELP_TRIES }); // the floor helpers': slower, longer
  const per = new Map(); // series -> { at, keys, roster, feed }
  const act = new Map(); // series -> { text, at, rounds, hits, round }: each teammate's last status, when it changed, rounds since, changes this hour (the Manager)
  const since = new Map(); // series -> { learner key: { on, at } }: when each learner last proved itself or went on probation (the mentor)
  // everything the roster is built from (the Manager's time sheet is added last, see read and observe)
  function inputs(series, now) {
    const b = book.get(series), bot = botOf(series), deb = council?.api?.(series), proof = breakLab?.api?.(series);
    const record = tryIt(() => bot?.record?.() ?? null), learners = tryIt(() => bot?.learnStatus?.()?.using ?? null);
    const kinds = proof ? Object.values(proof.kinds) : [], count = (st) => kinds.filter((v) => v.status === st).length;
    return {
      now, snap: b?.snap ?? null, sig: b?.sig ?? null, watch: watchOf(series)?.status?.() ?? null,
      breaks: breakLab?.open?.(series) ?? [], proven: proof ? count('proven') + count('opposite') : null,
      debate: deb?.debate ?? null, pick: bot?.pick?.() ?? null,
      record: record && { profitGuard: record.profitGuard, guard: record.guard, graded: record.graded, wins: record.wins, usd: record.usd, early: record.early, late: record.late, certain: record.certain },
      learners: learners && learners.map((u) => ({ key: u.key, name: u.name, on: !!u.on, detail: u.detail })), strength: strength?.api?.(series), autotraders: autotraders(series), discord: discord?.status?.(), ask: askMode(),
      parts: { ...parts(series, now, { bot, deb, proof, kinds, count }), autoTune: tryIt(() => autoTune()), learnerSince: learnerSince(series, learners, now) },
      // what the Improvement crew grades (improve.js)
      news: tryIt(() => news(series)), marketName: tryIt(() => nameOf(series)), // the News scout (news.js)
      council: deb?.records ?? null, kinds: proof?.kinds ?? null, calls: (record?.calls || []).map((e) => ({ ticker: e.ticker, side: e.side, price: e.price, result: e.result })),
    };
  }
  const managed = (base, x, series, now) => withManager(base, { ...x, parts: { ...x.parts, ...timesheet(series, now) } });
  // a team's flag fixers join last: they act on the Manager's and the crew's flags (the fixes run in observe)
  const fixersFor = (series, roster, now, run) => {
    const plans = planFixes(roster);
    if (run) desk.step(series, plans);
    const fx = fixerRows(roster, plans, desk.state(series), { now, depts: DEPTS }), m = roster.find((r) => r.manager);
    // what the fixers escalated goes to the floor helpers first
    const hp = helpPlans(plans, desk.state(series));
    if (run) helpDesk.step(series, hp);
    const fh = helperRows(roster, hp, helpDesk.state(series), { now, floors: FLOORS, depts: DEPTS });
    if (m && fx.length) { // the Manager accounts for the fixers and the floor helpers too
      const fixing = fx.filter((r) => r.state === 'busy').length, helping = fh.filter((r) => r.state === 'busy').length, up = fh.filter((r) => r.state === 'warn').length;
      m.status += ` · ${fx.length} fixers: ${fixing} fixing · ${fh.length} floor helpers: ${helping} helping, ${up} with something handed to you`;
      if (up) m.state = 'warn';
    }
    return [...roster, ...fx, ...fh];
  };
  const read = (series, now) => { const x = inputs(series, now); return fixersFor(series, managed(teamBase(x), x, series, now), now, false); };
  // what the staff read: each one defensive, so a reader that isn't there (or throws) leaves its teammate quiet, never the team
  function parts(series, now, { bot, deb, proof, kinds, count }) {
    const st = tryIt(() => stackOf(series)), sc = st?.scanFeed, crypto = st?.asset ? st.asset.kind === 'crypto' : true;
    const feeds = crypto ? tryIt(() => Object.values(sc?.api?.()?.feeds || {})) : null, fl = crypto ? tryIt(() => st?.flowsFeed?.api?.()) : null;
    const flowSrc = fl ? ['etf', 'stables', 'whale'].filter((k) => fl[k]?.on) : [];
    const status = tryIt(() => bot?.status?.()), tu = tryIt(() => tuneUp?.status?.()), flip = tryIt(() => st?.flipFeed?.api?.());
    const recs = deb?.records ? Object.values(deb.records) : [];
    return {
      feeds: feeds && feeds.length ? { live: feeds.filter((v) => v === 'live').length, total: feeds.length } : null,
      imbalance: crypto ? tryIt(() => sc?.imbalance?.(now - 900000)) : null,
      hasFutures: !!st?.futures, futures: tryIt(() => positioning(st?.futures?.context?.())),
      liqs: crypto && sc?.liqs ? tryIt(() => liqSummary(sc.liqs(), now)) : null,
      cross: { proven: !!tryIt(() => crossFeed?.shifts?.(st?.asset?.key ?? 'BTC')) },
      flows: fl ? { live: flowSrc.filter((k) => fl[k].read != null).length, total: flowSrc.length, err: flowSrc.map((k) => fl[k].err).find(Boolean) ?? null } : null,
      markets: tryIt(() => markets()), flip: flip ? { inCalls: !!flip.inCalls, live: !!flip.live } : null,
      proof: proof ? { proven: count('proven'), opposite: count('opposite'), testing: count('testing'), graded: kinds.reduce((a, v) => a + (v.n || 0), 0) } : null,
      records: deb ? { voices: Object.keys(deb.members || {}).length, graded: recs.reduce((a, r) => a + (Array.isArray(r) ? r.length : r?.n || 0), 0) } : null,
      tuneUp: tu ? { at: tu.last?.at ?? null, running: !!tu.running } : null,
      devices: status?.devices ?? 0, persistent, lastTick: status?.lastTick ?? null, lastError: status?.lastError ?? null,
    };
  }
  function learnerSince(series, learners, now) {
    const m = since.get(series) ?? {}, out = {};
    // a time only once it's seen the change happen: what it found at the start has no known "since"
    for (const l of learners || []) { if (!m[l.key]) m[l.key] = { on: !!l.on, at: null }; else if (m[l.key].on !== !!l.on) m[l.key] = { on: !!l.on, at: now }; if (m[l.key].at) out[l.key] = m[l.key].at; }
    since.set(series, m);
    return out;
  }
  function timesheet(series, now) {
    const a = act.get(series);
    if (!a) return { activity: {}, roundsQuiet: {}, workload: {} };
    return { activity: a.at, roundsQuiet: a.rounds, workload: Object.fromEntries(Object.entries(a.hits).map(([r, h]) => [r, h.filter((t) => t >= now - 3600000).length])) };
  }
  // ---------- merit pay (public/incentives.js): points for what each teammate verifiably did, the last 24 hours ----------
  const pay = new Map(); // series -> { ledger, prev, seenCalls, fixedT, helpT, esc, onJob, lastObs, headlines }
  function score(series, roster, x, now) {
    const p = pay.get(series) ?? { ledger: {}, prev: null, seenCalls: null, fixedT: null, helpT: null, esc: new Set(), onJob: {}, lastObs: now, headlines: null, newsHour: [] };
    const names = Object.fromEntries(roster.map((r) => [r.role, r.name])), cur = snapshot(roster), evs = scoreChanges(p.prev, cur, names);
    const earn = (role, d, why) => evs.push({ role, d, why });
    // fixes that cleared a flag: to the fixer, or the floor helper, who made them (none back-paid from before a restart)
    const fixed = desk.state(series).fixed, helped = helpDesk.state(series).fixed;
    if (p.fixedT != null) for (const f of fixed.filter((f) => f.t > p.fixedT)) earn(`fx_${f.dept}`, POINTS.fixed, `fixed ${f.name}`);
    if (p.helpT != null) for (const f of helped.filter((f) => f.t > p.helpT)) { const fl = FLOORS.find(([, , ds]) => ds.includes(f.dept)); if (fl) earn(`fh_${fl[0]}`, POINTS.fixed, `got ${f.name} back on track`); }
    p.fixedT = now; p.helpT = now; // paid up to this reading
    // a flag handed to the admin: the fixer or helper who had to
    const esc = new Set(roster.flatMap((r) => (r.escalations || r.handoffs || []).map((e) => `${r.role}>${e.role}`)));
    for (const k of esc) if (p.prev && !p.esc.has(k)) earn(k.split('>')[0], POINTS.escalated, `handed ${names[k.split('>')[1]] || k.split('>')[1]} to the admin`);
    p.esc = esc;
    // each graded official call, to the Caller, by how it did against its price
    const graded = (x.calls || []).filter((c) => (c.result === 'yes' || c.result === 'no') && c.ticker);
    if (p.seenCalls) for (const c of graded) if (!p.seenCalls.has(c.ticker)) earn('caller', callPoints(c), `a call ${String(c.side).toLowerCase() === c.result ? 'won' : 'lost'} at ${Math.round(c.price * 100)}¢`);
    p.seenCalls = new Set(graded.map((c) => c.ticker));
    // an hour on the job
    for (const [role, ok] of Object.entries(cur.working)) {
      if (!ok || !p.prev?.working[role]) { p.onJob[role] = 0; continue; }
      p.onJob[role] = (p.onJob[role] ?? 0) + (now - p.lastObs);
      if (p.onJob[role] >= 3600000) { p.onJob[role] -= 3600000; earn(role, POINTS.hour, 'an hour on the job'); }
    }
    // headlines the News scout routed (10 an hour at most)
    const heads = (roster.find((r) => r.role === 'newsscout')?.headlines || []).map((h) => h.title);
    p.newsHour = p.newsHour.filter((t) => t > now - 3600000);
    if (p.headlines) for (const h of heads) if (!p.headlines.has(h) && p.newsHour.length < 10) { p.newsHour.push(now); earn('newsscout', POINTS.headline, 'routed a headline'); }
    p.headlines = new Set(heads);
    for (const e of evs) if (e.d) (p.ledger[e.role] ||= []).push({ t: now, d: e.d, why: e.why });
    for (const [role, l] of Object.entries(p.ledger)) { const keep = l.filter((e) => e.t > now - 86400000); if (keep.length) p.ledger[role] = keep; else delete p.ledger[role]; }
    p.prev = cur; p.lastObs = now;
    pay.set(series, p);
    paySlips(series, roster, now);
  }
  // each teammate's score on its row; the Employee of the hour; the Manager's word for the best and for anyone in the red
  function paySlips(series, roster, now) {
    const st = standings(pay.get(series)?.ledger ?? {}, now), name = (r) => roster.find((x) => x.role === r)?.name ?? r;
    for (const r of roster) { r.score = st.score[r.role] ?? { day: 0, hour: 0, last: null }; r.star = r.role === st.star; }
    const m = roster.find((r) => r.manager);
    if (!m) return;
    if (st.star) {
      const s0 = st.score[st.star];
      m.status += ` · Employee of the hour: ${name(st.star)} (${pts(s0.hour)})`;
      m.talks.push({ to: st.star, text: `Employee of the hour: ${pts(s0.hour)} this hour${s0.last ? ` (last: ${s0.last.why})` : ''}. Keep it up.` });
    }
    for (const r of st.red.slice(0, 2)) { const s1 = st.score[r]; m.talks.push({ to: r, text: `Your score is ${pts(s1.hour)} this hour${s1.last ? ` (last: ${s1.last.why})` : ''}. Turn it around.` }); }
    m.leaderboard = { top: st.top.map((r) => ({ role: r, name: name(r), ...st.score[r] })), bottom: st.bottom.map((r) => ({ role: r, name: name(r), ...st.score[r] })) };
  }
  function observe(series, now = clock(), every = everyMs) {
    const s = per.get(series) ?? { at: 0, keys: {}, roster: null, feed: [] };
    if (now - s.at < every) return;
    // a round ended when the soonest-closing open round's close time moves on: everyone's count of quiet rounds goes up
    // (counted before the reading, so the Manager and the time sheet see it now)
    const a = act.get(series) ?? { text: {}, at: {}, rounds: {}, hits: {}, round: null };
    const round = liveRow(book.get(series)?.snap ?? null)?.m?.close_time ?? null;
    if (round && a.round && round !== a.round) for (const role of Object.keys(a.text)) a.rounds[role] = (a.rounds[role] ?? 0) + 1;
    if (round) a.round = round;
    act.set(series, a);
    s.at = now;
    const x = inputs(series, now), base = teamBase(x);
    for (const r of base) {
      if (a.text[r.role] === r.status) continue;
      a.text[r.role] = r.status; a.at[r.role] = now; a.rounds[r.role] = 0;
      const h = (a.hits[r.role] ||= []); h.push(now); while (h.length && h[0] < now - 3600000) h.shift();
    }
    s.roster = fixersFor(series, managed(base, x, series, now), now, true); // judged on this reading's time sheet, then the fixers act
    score(series, s.roster, x, now); // merit pay (public/incentives.js)
    for (const r of s.roster) if (a.text[r.role] === undefined) { a.text[r.role] = r.status; a.at[r.role] = now; a.rounds[r.role] = 0; } // the Manager's own row
    const { events, keys } = teamChanges(s.keys, s.roster, now);
    s.keys = keys; s.feed.unshift(...events.reverse()); if (s.feed.length > 60) s.feed.length = 60;
    per.set(series, s);
  }
  function api(series) {
    const now = clock(), s = per.get(series);
    const roster = s?.roster ?? read(series, now);
    if (!s) paySlips(series, roster, now);
    return { roster, talk: teamTalk(roster), feed: s?.feed ?? [], at: s?.at || now };
  }
  function live(series, liveMs = 1000) {
    observe(series, clock(), liveMs);
    return { ...api(series), pulse: teamPulse(book.get(series)?.snap ?? null) };
  }
  return { observe, api, live };
}
