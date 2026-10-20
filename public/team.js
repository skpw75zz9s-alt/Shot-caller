// The bot team (v13.65; the whole staff v13.67): every action the bot takes has one teammate who owns it, with a live
// status line, and a feed of what each one did and when. Pure: the server (team.js) gathers what each part of the bot is
// doing; this turns it into the roster. Each role reports a state (ok, busy, warn, idle, off), a one-line status, and a
// key: the discrete situation it's in, so the feed logs a change of position (UP took the lead, a hold started), never
// every tick's numbers. The nine leads (ROLES) run the main line; the staff (STAFF) each own one more real part of the
// bot: a feed, a learner, a guard, a record. teamTalk() turns the roster into who tells whom what, along the real
// handoffs in the code (the price goes to the Analyst, the guards to the Risk officer, the call to the Trader).
// No teammate makes a decision of its own: each one reports a part that already exists.
import { kalshiFee } from './model.js';
import { CREW_ICON, crewRoster } from './improve.js';
import { MANAGER, managerReport } from './manager.js';
import { FIX_ICON } from './fixers.js';

export const ROLES = [
  ['scout', 'Scout', 'watches the market'],
  ['analyst', 'Analyst', 'prices the round'],
  ['inspector', 'Inspector', 'hunts for breaks'],
  ['judge', 'Judge', 'rules on every nudge'],
  ['caller', 'Caller', 'makes the calls'],
  ['risk', 'Risk officer', 'can stop any call'],
  ['trader', 'Trader', 'places the orders'],
  ['coach', 'Coach', 'grades and learns'],
  ['reporter', 'Reporter', 'posts and answers'],
];
// departments, in the order the live window lays out its rooms
export const DEPTS = [
  ['mgmt', 'Manager\'s office'], ['improve', 'Improvement crew'], ['desk', 'Market desk'], ['lab', 'Research lab'], ['xray', 'X-ray room'], ['council', 'Council chamber'], ['calls', 'Call desk'],
  ['risk', 'Risk office'], ['trade', 'Trading floor'], ['grade', 'Grading room'], ['news', 'Newsroom'], ['ops', 'Operations'],
];
export const LEAD_DEPT = { scout: 'desk', analyst: 'lab', inspector: 'xray', judge: 'council', caller: 'calls', risk: 'risk', trader: 'trade', coach: 'grade', reporter: 'news' };
// the learners (bot.js learnStatus().using), one researcher each: [learner key, name, what it does, icon, who it reports to]
export const LEARNERS = [
  ['voltune', 'Volatility tuner', 'tunes how jumpy the price is', '📈', 'analyst'],
  ['drifttune', 'Momentum tuner', 'tests carrying or fading drift', '🏃', 'analyst'],
  ['vol', 'Clock watcher', 'knows how busy each half hour is', '🕰️', 'analyst'],
  ['cal', 'Calibrator', 'checks its odds come true', '🎯', 'analyst'],
  ['basis', 'Settlement matcher', 'lines Coinbase up with Kalshi', '🔗', 'analyst'],
  ['fix', 'Pulse checker', 'checks volatility every second', '💓', 'analyst'],
  ['blend', 'Kalshi blender', 'weighs in Kalshi\'s own price', '🫗', 'analyst'],
  ['scan', 'Scan analyst', 'reads all the exchanges at once', '📡', 'judge'],
  ['micro', 'Micro modeler', 'reads the next 1-5 minutes', '🔬', 'judge'],
  ['tune', 'Indicator tuner', 'tunes the chart indicators', '🎛️', 'judge'],
  ['reversal', 'Reversal spotter', 'watches for turns', '↩️', 'judge'],
  ['guide', 'Forecaster', 'calls the next round', '🔮', 'analyst'],
  ['predictor', 'Predictor', 'trend, momentum, volume, sweeps', '🧠', 'analyst'],
  ['gate', 'Call filter', 'skips calls like the ones that lost', '🧹', 'caller'],
];
// the rest of the staff: [role, name, job, department, icon, who it reports to]
export const STAFF = [
  ['price', 'Price clerk', 'reads the live price', 'desk', '💲', 'analyst'],
  ['quotes', 'Quote clerk', 'reads Kalshi\'s book', 'desk', '🧾', 'analyst'],
  ['exchanges', 'Exchange runner', 'keeps the exchange feeds live', 'desk', '🔌', 'scout'],
  ['tape', 'Tape reader', 'who is buying and selling', 'desk', '📜', 'scout'],
  ['futures', 'Futures watcher', 'funding and open interest', 'desk', '⛽', 'scout'],
  ['liqs', 'Liquidation watcher', 'forced buying and selling', 'desk', '💥', 'inspector'],
  ['related', 'Related-markets desk', 'what other markets say', 'desk', '🌐', 'judge'],
  ['flows', 'Money-flows desk', 'ETF, stablecoin and whale money', 'desk', '🏦', 'judge'],
  ['markets', 'Market finder', 'finds the markets Kalshi lists', 'desk', '🗺️', 'scout'],
  ...LEARNERS.map(([k, name, job, icon, to]) => [`l_${k}`, name, job, 'lab', icon, to]),
  ['flipdesk', 'Flip checker', 'how often the leader loses it', 'lab', '🔁', 'judge'],
  ['proof', 'Proof clerk', 'proves or drops each kind of break', 'xray', '🧪', 'inspector'],
  ['records', 'Records keeper', 'keeps every voice\'s track record', 'council', '📚', 'judge'],
  ['early', 'Early-call desk', 'calls with time on the clock', 'calls', '🌅', 'caller'],
  ['late', 'Late-call desk', 'calls in the last 5 minutes', 'calls', '🌙', 'caller'],
  ['certain', 'Near-certain desk', 'the nearly sure calls', 'calls', '🔒', 'caller'],
  ['winguard', 'Win-rate guard', 'raises the bar after losses', 'risk', '🚧', 'risk'],
  ['profitguard', 'Profit guard', 'pauses calls that lose money', 'risk', '💰', 'risk'],
  ['fees', 'Fee checker', 'what Kalshi\'s fee takes', 'risk', '🧮', 'caller'],
  ['auditor', 'Auditor', 'checks the team never contradicts itself', 'risk', '🕵️', 'risk'],
  ['clerk', 'Settlement clerk', 'records every result', 'grade', '🗂️', 'coach'],
  ['mechanic', 'Tune-up mechanic', 'runs the accuracy tune-up', 'grade', '🔧', 'analyst'],
  ['push', 'Push notifier', 'alerts the phones', 'news', '📲', 'reporter'],
  ['askdesk', 'Ask desk', 'answers questions', 'news', '💬', 'reporter'],
  ['archivist', 'Archivist', 'saves everything', 'ops', '💾', 'clerk'],
  ['nightwatch', 'Night watch', 'keeps the bot ticking', 'ops', '🌃', 'scout'],
];
export const TEAM_ICON = { scout: '🔭', analyst: '🧮', inspector: '🩻', judge: '⚖️', caller: '📣', risk: '🛡️', trader: '💼', coach: '🎓', reporter: '📰', ...Object.fromEntries(STAFF.map((r) => [r[0], r[4]])), ...CREW_ICON, [MANAGER[0]]: MANAGER[3], ...Object.fromEntries(DEPTS.map(([d]) => [`fx_${d}`, FIX_ICON])) };
// who each lead tells (the staff each report to one: STAFF's last field)
const LEAD_TO = { scout: ['risk', 'analyst'], analyst: ['caller'], inspector: ['risk'], judge: ['caller'], caller: ['trader', 'reporter', 'push'], risk: ['caller'], trader: ['clerk'], coach: ['mechanic'], reporter: [] };
const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const sideOf = (s) => (s === 'YES' ? 'UP' : s === 'NO' ? 'DOWN' : s);

// the round closing soonest that's still open
export const liveRow = (snap) => (snap?.rows || []).filter((r) => r.ev?.minutesLeft > 0).sort((a, b) => a.ev.minutesLeft - b.ev.minutesLeft)[0] ?? null;
// the round's numbers for the live window's header: { ticker, spot, strike, pYes, minutesLeft } or null between rounds
export function teamPulse(snap) {
  const lv = liveRow(snap);
  return lv ? { ticker: lv.m.ticker, spot: snap.mSpot ?? snap.spot ?? null, strike: lv.strike ?? null, pYes: lv.ev.pYes ?? null, minutesLeft: lv.ev.minutesLeft } : null;
}

// x: { now, snap, sig, watch, breaks, proven, debate, pick, record, learners, strength, autotraders, discord, ask, parts,
//      council, kinds, calls }
// (learners: [{ key, name, on, detail }]; parts: what the staff read, see staffRoster; council, kinds, calls and
// parts.autoTune / learnerSince: the records the Improvement crew grades, see improve.js). Each teammate the crew
// coaches carries its reviews: [{ by, verdict, note }]
// everyone but the Manager: the leads, the staff and the Improvement crew
export function teamBase(x) {
  const now = x.now ?? Date.now(), snap = x.snap, lv = liveRow(snap);
  const spot = snap?.mSpot ?? snap?.spot, sig = lv ? (lv.sigma ?? snap.sigmaMin) : null;
  const z = lv && spot > 0 && lv.strike > 0 && sig > 0 ? Math.log(spot / lv.strike) / (sig * Math.sqrt(lv.ev.minutesLeft)) : null;
  const R = {};
  // Scout: the feeds and Market Watch
  const w = x.watch, hold = w?.hold && w.hold.until > now ? w.hold : null;
  R.scout = !snap ? { state: 'idle', status: 'Waiting for the first reading', key: 'wait' }
    : hold ? { state: 'warn', status: `Holding new calls: ${hold.why}`, key: `hold:${hold.kind || 'x'}` }
      : snap.delayed ? { state: 'warn', status: 'The price is delayed: no calls on a stale price', key: 'delayed' }
        : w?.events60 ? { state: 'busy', status: `${w.events60} market event${w.events60 === 1 ? '' : 's'} in the last minute${w.last?.text ? `: ${w.last.text}` : ''}`, key: 'busy' }
          : { state: 'ok', status: 'Calm: feeds live, nothing unusual', key: 'calm' };
  // Analyst: the round's odds
  R.analyst = !lv ? { state: 'idle', status: 'Between rounds', key: 'none' }
    : { state: 'ok', status: `UP ${pct(lv.ev.pYes)} · ${z == null ? 'no lead reading' : `${z >= 0 ? 'UP' : 'DOWN'} ahead by ${Math.abs(z).toFixed(2)} typical moves`} · ${lv.ev.minutesLeft.toFixed(1)} min left${snap.sigmaLong > 0 ? ` · volatility ${(sig / snap.sigmaLong).toFixed(2)}×` : ''}`,
      key: `${lv.m.ticker}:${z == null ? '?' : z >= 0 ? 'UP' : 'DOWN'}`, say: z == null ? null : `${z >= 0 ? 'UP' : 'DOWN'} took the lead` };
  // Inspector: the X-ray's open breaks
  const br = x.breaks || [];
  R.inspector = br.length ? { state: 'warn', status: `${br.length} break${br.length === 1 ? '' : 's'} open: ${br.slice(0, 3).map((b) => b.title).join('; ')}`, key: `br:${br.map((b) => b.title.split(':')[0]).sort().join('|')}`, say: `found: ${br.map((b) => b.title).slice(0, 2).join('; ')}` }
    : { state: 'ok', status: `No breaks${x.proven != null ? ` · ${x.proven} kind${x.proven === 1 ? '' : 's'} of break proven so far` : ''}`, key: 'clear', say: 'all clear' };
  // Judge: the council's ruling on the proven nudges
  const d = x.debate;
  R.judge = d?.rulings?.length ? { state: d.vetoed ? 'busy' : 'ok', status: d.verdict, key: `d:${Math.sign(Math.round(d.net * 1000))}:${d.vetoed}`, say: `${d.rulings.length - d.vetoed} counted, ${d.vetoed} vetoed` }
    : { state: 'idle', status: 'No proven nudge to rule on: the call is the bot\'s own price math', key: 'none' };
  // Caller: the buy signal and the round call
  const p = x.pick?.live;
  R.caller = x.sig?.callSide ? { state: 'busy', status: `BUY ${sideOf(x.sig.callSide)} at ${pct(x.sig.price)}${x.sig.winProb != null ? ` · ${pct(x.sig.winProb)} at its worst-case odds` : ''}`, key: `buy:${x.sig.callSide}`, say: `called BUY ${sideOf(x.sig.callSide)} at ${pct(x.sig.price)}` }
    : p ? { state: 'ok', status: `Round call locked ${sideOf(p.side)}${p.p != null ? ` at ${pct(p.p)}` : ''}: a lean, not a buy`, key: `pick:${p.side}`, say: `locked the round call ${sideOf(p.side)}` }
      : lv ? { state: 'idle', status: x.pick?.locksAt ? `The round call locks at 10:00 left` : 'Watching for an edge', key: 'wait' }
        : { state: 'idle', status: 'Between rounds', key: 'none' };
  // Risk officer: every guard that can stop a call
  const pg = x.record?.profitGuard, flip = br.find((b) => /flip risk/i.test(b.title));
  R.risk = pg?.paused ? { state: 'warn', status: `Calls paused by the profit guard: ${pg.why || 'recent calls lost money at their prices'}`, key: 'profit', say: 'paused calls (profit guard)' }
    : hold ? { state: 'warn', status: 'New calls on hold while Market Watch sees a problem', key: 'hold', say: 'held new calls (Market Watch)' }
      : flip ? { state: 'warn', status: `${flip.title}: the side ahead could easily lose it`, key: 'flip', say: 'flagged high flip risk' }
        : { state: 'ok', status: `All guards clear${x.record?.guard?.floor != null ? ` · win-rate floor ${pct(x.record.guard.floor)}` : ''}`, key: 'clear', say: 'all guards clear' };
  // Trader: the server's auto-traders (a count only, never anyone's account)
  R.trader = x.autotraders > 0 ? { state: 'busy', status: `${x.autotraders} auto-trader${x.autotraders === 1 ? '' : 's'} trading the official calls`, key: 'on', say: 'started trading the official calls' }
    : { state: 'off', status: 'No auto-trader on: the calls are signals only', key: 'off', say: 'stopped: signals only' };
  // Coach: the grading and the learners
  const on = (x.learners || []).filter((l) => l.on).length, all = (x.learners || []).length;
  R.coach = { state: 'ok', status: `${x.strength?.words?.[0] ?? 'Grading every second of every round'}${all ? ` · ${on} of ${all} learners proven` : ''}`, key: `${on}:${(x.strength?.words?.[0] || '').slice(0, 24)}`, say: `${on} of ${all} learners proven` };
  // Reporter: Discord and Ask
  const ds = x.discord;
  R.reporter = { state: ds?.on ? 'ok' : 'off', status: `${ds?.on ? `Discord on · ${ds.sent} post${ds.sent === 1 ? '' : 's'} sent` : 'Discord off'} · Ask: ${x.ask || 'free answers'}`, key: `${!!ds?.on}:${x.ask}` };
  const leads = ROLES.map(([role, name, job]) => ({ role, name, job, dept: LEAD_DEPT[role], lead: true, ...R[role] }));
  const team = [...leads, ...staffRoster(x, { lv, R, hold, br })], { crew, reviews } = crewRoster(x, team);
  for (const r of team) if (reviews[r.role]) r.reviews = reviews[r.role];
  return [...crew, ...team];
}
// the whole roster: everyone, then the Manager over them
export const teamRoster = (x) => withManager(teamBase(x), x);
// the Manager: everyone accounted for, anyone stuck or slacking flagged (parts.activity / roundsQuiet / workload: each
// teammate's time sheet, kept by the server, which records this reading's changes before the Manager judges)
export function withManager(everyone, x) {
  const lead = Object.fromEntries(Object.entries(LEAD_DEPT).map(([role, d]) => [d, role]));
  const m = managerReport(everyone, { now: x.now ?? Date.now(), live: !!liveRow(x.snap), activity: x.parts?.activity || {}, rounds: x.parts?.roundsQuiet || {}, autoTune: x.parts?.autoTune, depts: DEPTS, leads: lead });
  for (const r of everyone) {
    if (m.flags[r.role]) (r.reviews ||= []).push({ by: 'manager', ...m.flags[r.role] });
    // the time sheet: when it last did something, how often in the last hour, and how many rounds since
    const w = x.parts?.workload?.[r.role];
    if (w) r.timesheet = { last: x.parts.activity?.[r.role] ?? null, hour: w, rounds: x.parts.roundsQuiet?.[r.role] ?? 0 };
  }
  return [m.row, ...everyone];
}
const usd = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v) >= 1e6 ? `${(Math.abs(v) / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(Math.abs(v) / 1e3).toFixed(1)}k` : Math.abs(v).toFixed(2)}`;
const won = (r) => (r?.graded ? `${r.wins} of ${r.graded} won` : 'nothing graded yet');
// the staff. parts: { feeds: {live, total} | null, imbalance, futures: positioning | null, hasFutures, liqs: liqSummary | null,
//   cross: { proven }, flows: { live, total, err } | null, markets: { listed, running }, flip: { inCalls, live }, proof: { proven,
//   opposite, testing, graded }, records: { voices, graded }, tuneUp: { at, running }, devices, persistent, lastTick, lastError }
function staffRoster(x, { lv, R, hold, br }) {
  const p = x.parts || {}, now = x.now ?? Date.now(), snap = x.snap, rec = x.record || {}, S = {};
  const spot = snap?.mSpot ?? snap?.spot, q = lv?.ev?.quote;
  S.price = !snap ? { state: 'idle', status: 'No reading yet', key: 'wait' }
    : snap.delayed ? { state: 'warn', status: 'The price is delayed: the feed is behind', key: 'delayed', say: 'the price feed fell behind' }
      : { state: 'ok', status: `${spot > 0 ? `$${spot.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'No price'} · live`, key: 'live', say: 'the price is live again' };
  const sp = q?.yesBid != null && q?.yesAsk != null ? Math.round((q.yesAsk - q.yesBid) * 100) : null;
  S.quotes = !q ? { state: 'idle', status: 'No Kalshi round open', key: 'none' }
    : sp != null && sp < 0 ? { state: 'warn', status: `Kalshi's book is crossed: bid ${Math.round(q.yesBid * 100)}¢ above ask ${Math.round(q.yesAsk * 100)}¢`, key: 'crossed', say: 'Kalshi\'s book crossed' }
      : { state: sp != null && sp >= 10 ? 'warn' : 'ok', status: `UP ${q.yesBid != null ? Math.round(q.yesBid * 100) : '—'}¢ bid / ${q.yesAsk != null ? Math.round(q.yesAsk * 100) : '—'}¢ ask${sp != null ? ` · spread ${sp}¢` : ''}`, key: sp != null && sp >= 10 ? 'wide' : 'ok', say: sp != null && sp >= 10 ? `the spread widened to ${sp}¢` : 'the spread is normal' };
  S.exchanges = p.feeds == null ? { state: 'off', status: 'No exchange trade feeds for this market', key: 'none' }
    : { state: p.feeds.live ? 'ok' : 'warn', status: `${p.feeds.live} of ${p.feeds.total} exchange feeds live`, key: p.feeds.live ? (p.feeds.live < p.feeds.total / 2 ? 'few' : 'ok') : 'down', say: p.feeds.live ? `${p.feeds.live} of ${p.feeds.total} feeds live` : 'every exchange feed is down' };
  const im = p.imbalance;
  S.tape = im == null ? { state: p.feeds == null ? 'off' : 'idle', status: p.feeds == null ? 'No exchange trades for this market' : 'No trades in the last 15 minutes', key: 'none' }
    : { state: Math.abs(im) >= 0.3 ? 'busy' : 'ok', status: `Last 15 min: ${Math.round((im + 1) * 50)}% of the money bought${Math.abs(im) >= 0.3 ? ` · ${im > 0 ? 'buyers' : 'sellers'} in charge` : ' · balanced'}`, key: Math.abs(im) >= 0.3 ? (im > 0 ? 'buy' : 'sell') : 'even', say: Math.abs(im) >= 0.3 ? `${im > 0 ? 'buyers' : 'sellers'} took charge` : 'buying and selling evened out' };
  const f = p.futures;
  S.futures = !p.hasFutures ? { state: 'off', status: 'No futures market for this one', key: 'none' }
    : !f?.live ? { state: 'idle', status: 'Hyperliquid futures not live right now', key: 'down' }
      : { state: 'ok', status: `Funding ${f.funding != null ? `${(f.funding * 100).toFixed(4)}%/h` : '—'}${f.oiChange5 != null ? ` · open interest ${f.oiChange5 >= 0 ? '+' : ''}${(f.oiChange5 * 100).toFixed(2)}% in 5 min` : ''}`, key: 'live', say: 'futures data is live' };
  const lq = p.liqs, lqUsd = lq ? lq.long + lq.short : 0;
  S.liqs = !lq ? { state: 'off', status: 'No liquidation feeds for this market', key: 'none' }
    : { state: lqUsd >= 2e6 ? 'warn' : lq.n ? 'ok' : 'idle', status: lq.n ? `${usd(lqUsd)} forced out in ${lq.minutes} min (${usd(lq.long)} longs, ${usd(lq.short)} shorts)` : `No liquidations in ${lq.minutes} min`, key: lqUsd >= 2e6 ? 'big' : lq.n ? 'some' : 'none', say: lqUsd >= 2e6 ? `${usd(lqUsd)} of forced trades` : null };
  S.related = { state: p.cross?.proven ? 'busy' : 'idle', status: p.cross?.proven ? 'Its proven read of the related markets argues before the council' : 'Watching the related markets: no proven read yet', key: p.cross?.proven ? 'on' : 'off', say: p.cross?.proven ? 'has a proven read for the council' : 'no proven read right now' };
  S.flows = p.flows == null ? { state: 'off', status: 'No money-flow data for this market', key: 'none' }
    : { state: p.flows.live ? 'ok' : 'idle', status: `${p.flows.live} of ${p.flows.total} money-flow sources reporting${p.flows.err ? ` · ${p.flows.err}` : ''}`, key: `${p.flows.live}` };
  S.markets = p.markets ? { state: 'ok', status: `${p.markets.listed} markets listed by Kalshi · ${p.markets.running} running a bot`, key: `${p.markets.running}`, say: `${p.markets.running} markets running` } : { state: 'idle', status: 'Not reporting', key: 'none' };
  // the research lab: one researcher per learner, on probation until it proves itself
  const lmap = Object.fromEntries((x.learners || []).map((l) => [l.key, l]));
  for (const [k] of LEARNERS) {
    const l = lmap[k];
    S[`l_${k}`] = !l ? { state: 'idle', status: 'Not reporting for this market', key: 'none' }
      : { state: l.on ? 'busy' : 'idle', status: `${l.on ? 'In the calls' : 'On probation'}: ${l.detail || ''}`.replace(/: $/, ''), key: l.on ? 'on' : 'off', say: l.on ? 'proved itself: now shaping the calls' : 'on probation: not shaping the calls' };
  }
  S.flipdesk = { state: p.flip?.inCalls ? 'busy' : 'idle', status: p.flip?.inCalls ? 'Its proven flip read argues before the council' : `On probation: ${p.flip?.live ? 'reading this round, ' : ''}not proven yet`, key: p.flip?.inCalls ? 'on' : 'off', say: p.flip?.inCalls ? 'proved itself: argues before the council' : null };
  const pr = p.proof;
  S.proof = !pr ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : { state: pr.proven + pr.opposite ? 'ok' : 'idle', status: `${pr.proven} kind${pr.proven === 1 ? '' : 's'} of break proven${pr.opposite ? `, ${pr.opposite} proven backwards` : ''} · ${pr.testing} being tested · ${pr.graded} cases graded`, key: `${pr.proven}:${pr.opposite}`, say: `${pr.proven} kinds of break proven` };
  S.records = p.records ? { state: p.records.graded ? 'ok' : 'idle', status: `${p.records.voices} voices on the books · ${p.records.graded} of their nudges graded`, key: p.records.graded ? 'some' : 'none' } : { state: 'idle', status: 'Not reporting', key: 'none' };
  const e = rec.early, lt = rec.late, ce = rec.certain;
  S.early = !e ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : { state: e.paused ? 'warn' : e.live ? 'ok' : 'idle', status: `${e.paused ? 'Paused · ' : e.proven ? 'Proven · ' : ''}${won(e)}${e.usd ? ` · ${usd(e.usd)} per $10` : ''}`, key: `${!!e.paused}:${!!e.proven}`, say: e.paused ? 'early calls paused' : e.proven ? 'early calls proven' : null };
  S.late = !lt ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : { state: lt.profitGuard?.paused ? 'warn' : 'ok', status: `${lt.profitGuard?.paused ? 'Paused by the profit guard · ' : ''}${won(lt)}${lt.usd ? ` · ${usd(lt.usd)} per $10` : ''}`, key: `${!!lt.profitGuard?.paused}`, say: lt.profitGuard?.paused ? 'late calls paused' : null };
  S.certain = !ce ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : { state: ce.profitGuard?.paused ? 'warn' : 'ok', status: `${won(ce)}${ce.usd ? ` · ${usd(ce.usd)} per $10` : ''}${ce.streak?.n ? ` · streak ${ce.streak.n}` : ''}`, key: `${!!ce.profitGuard?.paused}` };
  const g = rec.guard;
  S.winguard = !g ? { state: 'off', status: 'No win-rate floor at this risk level', key: 'off' }
    : { state: g.floor > 0.9 ? 'warn' : 'ok', status: `Floor ${pct(g.floor)} · recent ${g.n ? `${g.wins} of ${g.n} won` : 'no graded calls yet'}`, key: g.floor > 0.9 ? 'raised' : 'base', say: g.floor > 0.9 ? `raised the bar to ${pct(g.floor)}` : 'the bar is back to normal' };
  const pg = rec.profitGuard;
  S.profitguard = !pg ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : { state: pg.paused ? 'warn' : 'ok', status: pg.paused ? `Calls paused: recent calls lost ${usd(-pg.usd)} per $10` : `Calls allowed · ${pg.n ? `recent calls ${usd(pg.usd)} per $10` : 'nothing graded yet'}`, key: pg.paused ? 'paused' : 'ok', say: pg.paused ? 'paused the calls: they were losing money' : 'calls allowed again' };
  const price = x.sig?.price ?? (q?.yesAsk != null && q?.noAsk != null ? Math.max(q.yesAsk, q.noAsk) : null);
  if (price > 0 && price < 1) {
    const n = Math.floor(10 / price), fee = kalshiFee(price, n), net = n * (1 - price) - fee;
    S.fees = { state: net <= 0 ? 'warn' : 'ok', status: `$10 at ${Math.round(price * 100)}¢: ${n} contracts, fee $${fee.toFixed(2)}, a win pays $${net.toFixed(2)} after it`, key: net <= 0 ? 'eats' : 'ok', say: net <= 0 ? 'the fee eats the whole win at this price' : null };
  } else S.fees = { state: 'idle', status: 'No price to check', key: 'none' };
  // the auditor: does any report contradict another?
  const issues = [];
  if (x.sig?.callSide && hold) issues.push('a buy is showing while Market Watch holds new calls');
  if (x.sig?.callSide && snap?.delayed) issues.push('a buy is showing on a delayed price');
  if (x.sig?.callSide && pg?.paused) issues.push('a buy is showing while the profit guard pauses calls');
  if (x.sig?.callSide && x.pick?.live?.side && x.sig.callSide !== x.pick.live.side) issues.push(`the buy (${sideOf(x.sig.callSide)}) and the round call (${sideOf(x.pick.live.side)}) disagree`);
  S.auditor = issues.length ? { state: 'warn', status: `Flagged: ${issues.join('; ')}`, key: `x:${issues.length}`, say: `flagged: ${issues[0]}` }
    : { state: 'ok', status: 'No contradictions between the team\'s reports', key: 'ok', say: 'no contradictions' };
  S.clerk = { state: rec.graded ? 'ok' : 'idle', status: `Official record: ${won(rec)}${rec.usd ? ` · ${usd(rec.usd)} per $10` : ''}`, key: `${rec.graded ?? 0}`, say: rec.graded ? `graded a call: ${won(rec)}` : null };
  const tu = p.tuneUp;
  S.mechanic = !tu ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : tu.running ? { state: 'busy', status: 'Running the tune-up now', key: 'run', say: 'started a tune-up' }
      : { state: tu.at ? 'ok' : 'idle', status: tu.at ? `Last tune-up ${Math.round((now - tu.at) / 3600000)} h ago` : 'No tune-up run yet (the admin runs it)', key: `${tu.at || 0}`, say: tu.at ? 'finished a tune-up' : null };
  S.push = { state: p.devices ? 'ok' : 'idle', status: p.devices ? `${p.devices} phone${p.devices === 1 ? '' : 's'} get push alerts` : 'No phones signed up for push alerts', key: p.devices ? 'on' : 'off' };
  S.askdesk = { state: 'ok', status: `Answering with ${x.ask || 'free answers'}`, key: `${x.ask}` };
  S.archivist = p.persistent == null ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : p.persistent ? { state: 'ok', status: 'Saving to a volume: everything survives a deploy', key: 'ok' } : { state: 'warn', status: 'Not on a volume: a deploy would wipe the records', key: 'temp', say: 'the data is not on a volume' };
  const ago = p.lastTick ? (now - p.lastTick) / 1000 : null;
  S.nightwatch = p.lastError ? { state: 'warn', status: `Last error: ${String(p.lastError).slice(0, 120)}`, key: 'err', say: 'saw an error' }
    : ago == null ? { state: 'idle', status: 'Waiting for the first tick', key: 'wait' }
      : { state: ago > 30 ? 'warn' : 'ok', status: `Last tick ${ago < 1 ? 'just now' : `${Math.round(ago)}s ago`}`, key: ago > 30 ? 'slow' : 'ok', say: ago > 30 ? 'the bot stopped ticking' : 'the bot is ticking' };
  return STAFF.map(([role, name, job, dept]) => ({ role, name, job, dept, ...S[role] }));
}
// who tells whom what, right now: [{ from, to, text }]. Every teammate reports to whoever uses its part; a teammate with
// nothing to say (off, or not reporting) stays quiet.
export function teamTalk(roster) {
  const by = Object.fromEntries(roster.map((r) => [r.role, r])), out = [];
  for (const r of roster) {
    if (r.state === 'off' || /^Not reporting/.test(r.status || '')) continue;
    if (r.crew || r.manager || r.fixer) { for (const t of r.talks || []) if (by[t.to]) out.push({ from: r.role, to: t.to, text: t.text }); continue; } // the crew coaches: each review, to its teammate
    const to = r.lead ? LEAD_TO[r.role] || [] : [STAFF.find((s) => s[0] === r.role)?.[5]];
    for (const t of to) if (by[t]) out.push({ from: r.role, to: t, text: r.status });
  }
  return out;
}
// the feed: a line whenever a role's situation changes (prev: { role: situation key }); the first reading logs nothing
export function teamChanges(prev, roster, now) {
  const events = [], keys = { ...prev };
  for (const r of roster) {
    if (keys[r.role] === r.key) continue;
    if (keys[r.role] !== undefined) events.push({ t: now, role: r.role, name: r.name, state: r.state, text: r.say || r.status });
    keys[r.role] = r.key;
  }
  return { events, keys };
}
