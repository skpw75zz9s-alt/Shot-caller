// The bot team (v13.65): every action the bot takes has one teammate who owns it, with a live status line, and a feed
// of what each one did and when. Pure: the server (team.js) gathers what each part of the bot is doing; this turns it
// into the roster. Each role reports a state (ok, busy, warn, idle, off), a one-line status, and a key: the discrete
// situation it's in, so the feed logs a change of position (UP took the lead, a hold started), never every tick's numbers.
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
const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const sideOf = (s) => (s === 'YES' ? 'UP' : s === 'NO' ? 'DOWN' : s);

// x: { now, snap, sig, watch, breaks, proven, debate, pick, record, learners, strength, autotraders, discord, ask }
export function teamRoster(x) {
  const now = x.now ?? Date.now(), snap = x.snap, lv = (snap?.rows || []).filter((r) => r.ev?.minutesLeft > 0).sort((a, b) => a.ev.minutesLeft - b.ev.minutesLeft)[0] ?? null;
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
  return ROLES.map(([role, name, job]) => ({ role, name, job, ...R[role] }));
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
