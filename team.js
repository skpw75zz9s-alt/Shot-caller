// The bot team on the server (v13.65; public/team.js builds the roster): every 5 seconds, per market, each teammate's
// status from the part of the bot it owns, and a feed of what changed (the last 60 lines per market, in memory).
//   observe(series)   reads every part (the market book's snapshot, Market Watch, the X-ray, the council, the round
//                     call, the guards, the auto-traders, the learners, the strength meter, Discord, Ask)
//   api(series)       the roster and the feed
//   live(series)      the same, read fresh (at most once a second): the admin's live window (v13.66, public/team-live.js)
//   (the staff, v13.67: each asset's readers from stackOf, the related markets, the tune-up, the market list, storage)
import { teamChanges, teamPulse, teamRoster, teamTalk } from './public/team.js';
import { liqSummary, positioning } from './public/xray.js';

const tryIt = (f) => { try { return f(); } catch { return null; } };
export function createTeam({ book, botOf, watchOf, council, breakLab, strength, autotraders = () => 0, discord, askMode = () => 'free answers',
  stackOf = () => null, crossFeed = null, tuneUp = null, autoTune = () => null, markets = () => null, persistent = null, clock = () => Date.now(), everyMs = 5000 }) {
  const per = new Map(); // series -> { at, keys, roster, feed }
  const since = new Map(); // series -> { learner key: { on, at } }: when each learner last proved itself or went on probation (the mentor)
  function read(series, now) {
    const b = book.get(series), bot = botOf(series), deb = council?.api?.(series), proof = breakLab?.api?.(series);
    const record = tryIt(() => bot?.record?.() ?? null), learners = tryIt(() => bot?.learnStatus?.()?.using ?? null);
    const kinds = proof ? Object.values(proof.kinds) : [], count = (st) => kinds.filter((v) => v.status === st).length;
    return teamRoster({
      now, snap: b?.snap ?? null, sig: b?.sig ?? null, watch: watchOf(series)?.status?.() ?? null,
      breaks: breakLab?.open?.(series) ?? [], proven: proof ? count('proven') + count('opposite') : null,
      debate: deb?.debate ?? null, pick: bot?.pick?.() ?? null,
      record: record && { profitGuard: record.profitGuard, guard: record.guard, graded: record.graded, wins: record.wins, usd: record.usd, early: record.early, late: record.late, certain: record.certain },
      learners: learners && learners.map((u) => ({ key: u.key, name: u.name, on: !!u.on, detail: u.detail })), strength: strength?.api?.(series), autotraders: autotraders(series), discord: discord?.status?.(), ask: askMode(),
      parts: { ...parts(series, now, { bot, deb, proof, kinds, count }), autoTune: tryIt(() => autoTune()), learnerSince: learnerSince(series, learners, now) },
      // what the Improvement crew grades (improve.js)
      council: deb?.records ?? null, kinds: proof?.kinds ?? null, calls: (record?.calls || []).map((e) => ({ side: e.side, price: e.price, result: e.result })),
    });
  }
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
  function observe(series, now = clock(), every = everyMs) {
    const s = per.get(series) ?? { at: 0, keys: {}, roster: null, feed: [] };
    if (now - s.at < every) return;
    s.at = now; s.roster = read(series, now);
    const { events, keys } = teamChanges(s.keys, s.roster, now);
    s.keys = keys; s.feed.unshift(...events.reverse()); if (s.feed.length > 60) s.feed.length = 60;
    per.set(series, s);
  }
  function api(series) {
    const now = clock(), s = per.get(series);
    const roster = s?.roster ?? read(series, now);
    return { roster, talk: teamTalk(roster), feed: s?.feed ?? [], at: s?.at || now };
  }
  function live(series, liveMs = 1000) {
    observe(series, clock(), liveMs);
    return { ...api(series), pulse: teamPulse(book.get(series)?.snap ?? null) };
  }
  return { observe, api, live };
}
