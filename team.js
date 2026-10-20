// The bot team on the server (v13.65; public/team.js builds the roster): every 5 seconds, per market, each teammate's
// status from the part of the bot it owns, and a feed of what changed (the last 60 lines per market, in memory).
//   observe(series)   reads every part (the market book's snapshot, Market Watch, the X-ray, the council, the round
//                     call, the guards, the auto-traders, the learners, the strength meter, Discord, Ask)
//   api(series)       the roster and the feed
//   live(series)      the same, read fresh (at most once a second): the admin's live window (v13.66, public/team-live.js)
import { teamChanges, teamPulse, teamRoster } from './public/team.js';

export function createTeam({ book, botOf, watchOf, council, breakLab, strength, autotraders = () => 0, discord, askMode = () => 'free answers', clock = () => Date.now(), everyMs = 5000 }) {
  const per = new Map(); // series -> { at, keys, roster, feed }
  function read(series, now) {
    const b = book.get(series), bot = botOf(series), deb = council?.api?.(series), proof = breakLab?.api?.(series);
    let record = null, learners = null;
    try { record = bot?.record?.() ?? null; } catch { /* not yet */ }
    try { learners = bot?.learnStatus?.()?.using ?? null; } catch { /* not yet */ }
    return teamRoster({
      now, snap: b?.snap ?? null, sig: b?.sig ?? null, watch: watchOf(series)?.status?.() ?? null,
      breaks: breakLab?.open?.(series) ?? [], proven: proof ? Object.values(proof.kinds).filter((v) => v.status === 'proven' || v.status === 'opposite').length : null,
      debate: deb?.debate ?? null, pick: bot?.pick?.() ?? null, record: record && { profitGuard: record.profitGuard, guard: record.guard },
      learners: learners && learners.map((u) => ({ on: !!u.on })), strength: strength?.api?.(series), autotraders: autotraders(series), discord: discord?.status?.(), ask: askMode(),
    });
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
    return { roster: s?.roster ?? read(series, now), feed: s?.feed ?? [], at: s?.at || now };
  }
  function live(series, liveMs = 1000) {
    observe(series, clock(), liveMs);
    return { ...api(series), pulse: teamPulse(book.get(series)?.snap ?? null) };
  }
  return { observe, api, live };
}
