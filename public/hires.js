// The hiring center (v13.77): agents the team doesn't have yet, each one built and ready, that the Recruiter puts
// forward when the team's own data shows the gap it would fill. Each application says why now (the evidence), what
// the hire would do and what it can't; the admin approves or declines it in Settings → Admin → Hiring center, and an
// approved hire joins the team (hiring.js keeps the applications and who's hired). Like everyone else, a hire reports
// and informs: none of them changes a call.
import { pnl10 } from './model.js';
import { RSI, rsiRead, rsiTestCached } from './rsiagent.js';

const ET = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: Number(p.hour) * 60 + Number(p.minute) };
};
const dur = (m) => (m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m / 1440)} days`);
const usd = (v) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`, zs = (z) => `${z < 0 ? '−' : ''}${Math.abs(z).toFixed(1)}`;
const graded = (calls) => (calls || []).filter((c) => (c.result === 'yes' || c.result === 'no') && c.price > 0 && c.price < 1);
const won = (c) => String(c.side).toLowerCase() === c.result;

// is a market's underlying open right now? kind: index (the stock market: 9:30-16:00 ET, Mon-Fri), commodity (CME futures:
// Sun 18:00 to Fri 17:00 ET, with a break 17:00-18:00 each weekday), crypto (always). Holidays aren't known.
export function session(kind, t) {
  if (kind === 'crypto') return { open: true, always: true };
  const { day, min } = ET(t);
  const isOpen = (d, m) => (kind === 'index' ? d >= 1 && d <= 5 && m >= 570 && m < 960 : (d === 0 ? m >= 1080 : d === 6 ? false : d === 5 ? m < 1020 : m < 1020 || m >= 1080));
  const open = isOpen(day, min);
  let k = 0; // minutes until it changes (a week at most)
  for (let d = day, m = min; k < 10080; k++) { m++; if (m >= 1440) { m = 0; d = (d + 1) % 7; } if (isOpen(d, m) !== open) break; }
  return { open, minutes: k + 1 };
}
// the official record as $10 calls: where it stands against its best, and its worst drop so far
export function drawdown(calls) {
  let eq = 0, peak = 0, worst = 0, n = 0;
  for (const c of graded(calls)) { eq += pnl10(c.price, won(c)); n++; peak = Math.max(peak, eq); worst = Math.min(worst, eq - peak); }
  return { n, now: eq - peak, worst, total: eq };
}
// the official record by 4-hour block of the day (ET): a block clearly losing (30+ calls, z ≤ −2 against its prices)
export function byHour(calls) {
  const blocks = Array.from({ length: 6 }, (_, i) => ({ from: i * 4, n: 0, wins: 0, need: 0, v: 0, usd: 0 }));
  for (const c of graded(calls)) { if (!c.at) continue; const b = blocks[Math.floor(ET(c.at).min / 240)]; b.n++; b.wins += won(c) ? 1 : 0; b.need += c.price; b.v += c.price * (1 - c.price); b.usd += pnl10(c.price, won(c)); }
  return blocks.map((b) => ({ ...b, z: b.v > 0 ? (b.wins - b.need) / Math.sqrt(b.v) : 0 }));
}
const hh = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
// the official record split by any key (a price band, a side, a weekday): each group's calls, wins, the wins its prices
// needed, and its z against them; a group clearly losing has 30+ calls and z ≤ −2
export function splitBy(calls, keyOf) {
  const out = {};
  for (const c of graded(calls)) {
    const k = keyOf(c); if (k == null) continue;
    const g = (out[k] ||= { n: 0, wins: 0, need: 0, v: 0, usd: 0 });
    g.n++; g.wins += won(c) ? 1 : 0; g.need += c.price; g.v += c.price * (1 - c.price); g.usd += pnl10(c.price, won(c));
  }
  for (const g of Object.values(out)) g.z = g.v > 0 ? (g.wins - g.need) / Math.sqrt(g.v) : 0;
  return out;
}
const losing = (g) => g.n >= 30 && g.z <= -2;
// the current run of wins or losses, and the longest losing run before it (graded calls, oldest first)
export function streaks(calls) {
  const runs = []; // [{ won, n }], oldest first
  for (const c of graded(calls).slice().sort((x, y) => (x.at ?? 0) - (y.at ?? 0))) { const w = won(c); if (runs.at(-1)?.won === w) runs.at(-1).n++; else runs.push({ won: w, n: 1 }); }
  return { n: runs.reduce((t, r) => t + r.n, 0), cur: runs.at(-1)?.n ?? 0, won: runs.at(-1)?.won ?? null, longestLossBefore: Math.max(0, ...runs.slice(0, -1).filter((r) => !r.won).map((r) => r.n)) };
}
// The Mathematician's numbers (v13.87): the official record as $10 calls held to settlement after Kalshi's fees, done
// exactly from each call's price and result. Each call's breakeven is the win rate at which its win and its loss cancel
// out (−loss ÷ (win − loss)); the record beats its prices only if the win rate's 95% range (Wilson) sits wholly above the
// average breakeven, and loses to them only if it sits wholly below. The Kelly stake is shown only once the edge is proven.
export function recordMath(calls) {
  const g = graded(calls), n = g.length;
  if (!n) return { n: 0 };
  let wins = 0, total = 0, sq = 0, be = 0, winSum = 0, lossSum = 0;
  for (const c of g) {
    const w = pnl10(c.price, true), l = pnl10(c.price, false), x = won(c) ? w : l;
    wins += won(c) ? 1 : 0; total += x; sq += x * x; be += -l / (w - l); winSum += w; lossSum += -l;
  }
  const p = wins / n, breakeven = be / n, mean = total / n, sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : 0;
  const z = 1.96, den = 1 + (z * z) / n, mid = (p + (z * z) / (2 * n)) / den, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const lo = mid - half, hi = mid + half;
  const verdict = n < 30 ? 'few' : lo > breakeven ? 'ahead' : hi < breakeven ? 'behind' : 'open';
  // calls still needed to tell the win rate from breakeven at this gap (95%), if the gap holds
  const gap = p - breakeven, more = Math.abs(gap) > 1e-9 ? Math.max(0, Math.ceil((z * z * p * (1 - p)) / (gap * gap)) - n) : null;
  const b = lossSum > 0 ? winSum / lossSum : 0, kelly = verdict === 'ahead' && b > 0 ? Math.max(0, (p * b - (1 - p)) / b) : 0; // avg win ÷ avg loss
  return { n, wins, p, lo, hi, breakeven, total, mean, se: n > 1 ? sd / Math.sqrt(n) : 0, verdict, more, kelly };
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;

// The Fact checker's tests (v13.91): claims people make about the bot, each put to a real test on the official record
// and given one of three verdicts. TRUE: the evidence is clearly for it (95%). FALSE: the evidence is clearly against it,
// or (for "no difference" claims) the difference is shown to be small, under 5 points either way, at 95%. UNPROVEN:
// neither yet, with how many more calls it would take if the gap held. Every test needs 30+ calls in each group.
// Win rates against prices are compared as the "edge" (wins minus the wins the prices needed, per call), so cheap and
// pricey calls are judged fairly.
const Z95 = 1.96, SMALL = 0.05;
const edgeOf = (g) => { const n = g.length, x = g.reduce((a, c) => a + (won(c) ? 1 : 0) - c.price, 0), v = g.reduce((a, c) => a + c.price * (1 - c.price), 0); return { n, e: n ? x / n : 0, v: n ? v / (n * n) : 0 }; };
// is group a's edge bigger than group b's? (two-sided: z > 0 for a, and the 95% range of the difference)
function compare(a, b) {
  const A = edgeOf(a), B = edgeOf(b), d = A.e - B.e, se = Math.sqrt(A.v + B.v);
  if (A.n < 30 || B.n < 30 || !se) return { few: true, na: A.n, nb: B.n, d };
  return { na: A.n, nb: B.n, d, z: d / se, lo: d - Z95 * se, hi: d + Z95 * se, more: Math.abs(d) > 1e-9 ? Math.max(0, Math.ceil((Z95 * se * Math.sqrt(A.n + B.n) / d) ** 2) - A.n - B.n) : null };
}
// wins and losses in streaks? the Wald-Wolfowitz runs test: fewer runs than chance = streaky, more = they alternate
export function runsTest(results) {
  const n = results.length, w = results.filter(Boolean).length, l = n - w;
  if (n < 30 || !w || !l) return { few: true, n };
  let runs = 1; for (let i = 1; i < n; i++) if (results[i] !== results[i - 1]) runs++;
  const mean = 1 + (2 * w * l) / n, v = (2 * w * l * (2 * w * l - n)) / (n * n * (n - 1));
  return { n, runs, mean, z: v > 0 ? (runs - mean) / Math.sqrt(v) : 0 };
}
const pts = (d) => `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} pts`;
// a claim that group a does better than group b
const better = (r, what) => (r.few ? { verdict: 'unproven', why: `needs 30+ calls each (${r.na} and ${r.nb} so far)` }
  : r.lo > 0 ? { verdict: 'true', why: `${what} by ${pts(r.d)} of edge (95% range ${pts(r.lo)} to ${pts(r.hi)})` }
    : r.hi < 0 ? { verdict: 'false', why: `the other way round, by ${pts(-r.d)} (95% range ${pts(-r.hi)} to ${pts(-r.lo)})` }
      : r.lo > -SMALL && r.hi < SMALL ? { verdict: 'false', why: `no real difference: within ${pts(SMALL).slice(1)} either way (95% range ${pts(r.lo)} to ${pts(r.hi)})` }
        : { verdict: 'unproven', why: `${pts(r.d)} so far, not clear yet (95% range ${pts(r.lo)} to ${pts(r.hi)})${r.more ? `; about ${r.more} more calls if the gap holds` : ''}` });
export function factCheck(calls) {
  const g = graded(calls).slice().sort((x, y) => (x.at ?? 0) - (y.at ?? 0)), n = g.length, out = [];
  // 1. more than half
  {
    const w = g.filter(won).length, p = n ? w / n : 0, den = 1 + (Z95 * Z95) / n, mid = (p + (Z95 * Z95) / (2 * n)) / den, half = n ? (Z95 * Math.sqrt((p * (1 - p)) / n + (Z95 * Z95) / (4 * n * n))) / den : 0;
    const lo = mid - half, hi = mid + half;
    out.push({ key: 'half', claim: 'The calls win more than half the time', ...(n < 30 ? { verdict: 'unproven', why: `needs 30+ graded calls (${n} so far)` }
      : lo > 0.5 ? { verdict: 'true', why: `won ${w} of ${n} (${pct(p)}, 95% range ${pct(lo)}-${pct(hi)})` } : hi < 0.5 ? { verdict: 'false', why: `won ${w} of ${n} (${pct(p)}, 95% range ${pct(lo)}-${pct(hi)})` }
        : { verdict: 'unproven', why: `won ${w} of ${n} (${pct(p)}): the 95% range ${pct(lo)}-${pct(hi)} still includes 50%` }),
      note: 'Winning more than half is not the same as making money: a 90¢ call has to win 90% to break even (the Mathematician checks that).' });
  }
  // 2. beating the prices
  {
    const e = edgeOf(g), se = Math.sqrt(e.v), lo = e.e - Z95 * se, hi = e.e + Z95 * se;
    out.push({ key: 'edge', claim: 'The calls win more often than their prices say they should', ...(n < 30 ? { verdict: 'unproven', why: `needs 30+ graded calls (${n} so far)` }
      : lo > 0 ? { verdict: 'true', why: `${pts(e.e)} more wins per call than the prices needed (95% range ${pts(lo)} to ${pts(hi)})` }
        : hi < 0 ? { verdict: 'false', why: `${pts(-e.e)} fewer wins per call than the prices needed (95% range ${pts(lo)} to ${pts(hi)})` }
          : { verdict: 'unproven', why: `${pts(e.e)} per call so far: the 95% range ${pts(lo)} to ${pts(hi)} still includes zero` }) });
  }
  // 3. streaks
  {
    const r = runsTest(g.map(won));
    out.push({ key: 'streaks', claim: 'Wins and losses come in streaks', ...(r.few ? { verdict: 'unproven', why: `needs 30+ graded calls with both wins and losses (${r.n} so far)` }
      : r.z <= -Z95 ? { verdict: 'true', why: `${r.runs} runs where chance gives about ${r.mean.toFixed(0)} (z ${zs(r.z)}): they clump` }
        : r.z >= Z95 ? { verdict: 'false', why: `${r.runs} runs where chance gives about ${r.mean.toFixed(0)} (z ${zs(r.z)}): they alternate more than chance` }
          : { verdict: 'unproven', why: `${r.runs} runs where chance gives about ${r.mean.toFixed(0)} (z ${zs(r.z)}): no sign of streaks beyond chance` }),
      note: 'Streaks that chance alone makes are normal: a 60% caller loses 4 in a row about once every 40 calls.' });
  }
  // 4. getting better: the newer half against the older half
  const h = Math.floor(n / 2);
  out.push({ key: 'better', claim: 'The calls are getting better (the newer half beats the older half)', ...better(compare(g.slice(h), g.slice(0, h)), 'the newer half is ahead') });
  // 5. UP vs DOWN
  const up = g.filter((c) => String(c.side).toLowerCase() === 'yes'), down = g.filter((c) => String(c.side).toLowerCase() !== 'yes');
  out.push({ key: 'updown', claim: 'UP calls do better than DOWN calls', ...better(compare(up, down), 'UP is ahead') });
  // 6. the surer calls
  out.push({ key: 'sure', claim: 'Pricier calls (85¢ and up) beat their prices more than cheaper ones', ...better(compare(g.filter((c) => c.price >= 0.85), g.filter((c) => c.price < 0.85)), 'the pricier calls are ahead') });
  return { n, claims: out };
}

const BANDS = [[0, 0.7, 'under 70¢'], [0.7, 0.85, '70-85¢'], [0.85, 0.95, '85-95¢'], [0.95, 1, '95¢ and up']];
const bandOf = (c) => BANDS.find(([lo, hi]) => c.price >= lo && c.price < hi)?.[2] ?? null;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// a split's row: the groups that clearly lose, told to whoever the hire tells
const splitRow = (groups, { what, few, to, label = (k) => k }) => {
  const n = Object.values(groups).reduce((a, g) => a + g.n, 0), bad = Object.entries(groups).filter(([, g]) => losing(g));
  if (n < 30) return { state: 'idle', status: `${n} graded calls: too few to split by ${what}`, key: 'few', talks: [] };
  return { state: bad.length ? 'warn' : 'ok', status: bad.length ? `Losing: ${bad.map(([k, g]) => `${label(k)} (${g.n} calls, ${usd(g.usd)}, z ${zs(g.z)})`).join('; ')}` : `No ${what} clearly loses yet (${n} calls${few ? `, ${few}` : ''})`, key: bad.map(([k]) => k).join(','),
    say: bad.length ? `found a losing ${what}: ${label(bad[0][0])}` : null, talks: bad.map(([k, g]) => ({ to, text: `Calls ${label(k)} have lost ${usd(g.usd)} over ${g.n} (z ${zs(g.z)}).` })) };
};

// the catalog. ctx: { now, markets: [{ series, name, kind }], calls (the official record: side, price, result, at),
// depth: { yes: { usd, at }, no: { usd, at } } near the price | null, uptime: { since, starts: [ms] } }
export const CANDIDATES = [
  { key: 'hours', role: 'h_hours', name: 'Market-hours keeper', icon: '⏰', dept: 'desk',
    job: 'knows when each market\'s underlying is open and closed',
    does: 'Tracks the stock market\'s hours (9:30-4:00 ET, weekdays) for the S&P, Nasdaq and Dow, and CME\'s for gold, silver and oil, and tells the Scout and the Caller when a session opens or closes.',
    cant: 'It doesn\'t know market holidays.',
    fit: (c) => { const m = c.markets.filter((x) => x.kind && x.kind !== 'crypto'); return m.length ? `${m.length} running market${m.length === 1 ? '' : 's'} (${m.map((x) => x.name).join(', ')}) trade on hours, and nobody tracks them.` : null; },
    row: (c) => {
      const m = c.markets.filter((x) => x.kind && x.kind !== 'crypto');
      if (!m.length) return { state: 'idle', status: 'Every running market trades around the clock: no hours to keep', key: 'none', talks: [] };
      const lines = m.map((x) => ({ x, s: session(x.kind, c.now) })), soon = lines.filter((l) => l.s.minutes <= 15);
      return { state: soon.length ? 'busy' : 'ok', status: lines.map(({ x, s }) => `${x.name}: ${s.open ? `open, closes in ${dur(s.minutes)}` : `closed, opens in ${dur(s.minutes)}`}`).join(' · '), key: lines.map((l) => `${l.x.series}:${l.s.open}`).join(','),
        say: soon.length ? `${soon[0].x.name} ${soon[0].s.open ? 'closes' : 'opens'} in ${dur(soon[0].s.minutes)}` : null,
        talks: soon.flatMap(({ x, s }) => ['scout', 'caller'].map((to) => ({ to, text: `${x.name} ${s.open ? 'closes' : 'opens'} in ${dur(s.minutes)}${s.open ? ': the price can jump at the close, and nothing moves after it' : ''}.` }))) };
    } },
  { key: 'drawdown', role: 'h_drawdown', name: 'Drawdown watcher', icon: '📉', dept: 'risk',
    job: 'watches how far the record is below its best',
    does: 'Follows the official record as $10 calls held to settlement after fees: how far it is below its best right now, and its worst drop so far, and warns the Risk officer when a drop is deeper than any before.',
    cant: 'A drop tells you a bad run is happening, not why: the profit guard and the loss lab handle the why.',
    fit: (c) => { const d = drawdown(c.calls); return d.n >= 30 ? `${d.n} graded official calls, and nobody follows how far the record falls from its best (its worst drop so far: ${usd(d.worst)}).` : null; },
    row: (c) => {
      const d = drawdown(c.calls);
      if (d.n < 10) return { state: 'idle', status: `${d.n} graded official calls: too few to follow yet`, key: 'few', talks: [] };
      const deepest = d.now < 0 && d.now <= d.worst + 1e-9, deep = d.now < 0 && d.now <= d.worst * 0.75;
      return { state: deepest ? 'warn' : deep ? 'busy' : 'ok', status: `${d.now < 0 ? `${usd(d.now)} below its best` : 'At its best'} · worst drop so far ${usd(d.worst)} · ${usd(d.total)} over ${d.n} calls at $10`, key: deepest ? 'deepest' : deep ? 'deep' : 'ok',
        say: deepest ? 'the record hit its deepest drop' : null, talks: deep ? [{ to: 'risk', text: `The official record is ${usd(d.now)} below its best${deepest ? ': its deepest drop yet' : `, close to its worst (${usd(d.worst)})`}.` }] : [] };
    } },
  { key: 'hourcoach', role: 'h_hourcoach', name: 'Hour-of-day coach', icon: '🕐', dept: 'grade',
    job: 'finds the hours when the calls lose',
    does: 'Splits the official record into six 4-hour blocks (Eastern time) and flags a block that clearly loses to its prices (30+ calls, z of −2 or worse), so you can see when the calls go wrong.',
    cant: 'It only flags: whether to avoid an hour is a decision for you (or for a learner that proves it).',
    fit: (c) => { const n = graded(c.calls).length; return n >= 120 ? `${n} graded official calls: enough to look for hours that lose, and nobody does.` : null; },
    row: (c) => {
      const b = byHour(c.calls), bad = b.filter((x) => x.n >= 30 && x.z <= -2), n = b.reduce((a, x) => a + x.n, 0);
      if (n < 30) return { state: 'idle', status: `${n} graded calls with times: too few to split by hour`, key: 'few', talks: [] };
      return { state: bad.length ? 'warn' : 'ok', status: bad.length ? `Losing hours: ${bad.map((x) => `${hh(x.from)}-${hh((x.from + 4) % 24)} ET (${x.n} calls, ${usd(x.usd)}, z ${zs(x.z)})`).join('; ')}` : `No block of hours clearly loses yet (${n} calls in six 4-hour blocks)`, key: bad.map((x) => x.from).join(','),
        say: bad.length ? `found losing hours: ${hh(bad[0].from)}-${hh((bad[0].from + 4) % 24)} ET` : null, talks: bad.map((x) => ({ to: 'caller', text: `Calls between ${hh(x.from)} and ${hh((x.from + 4) % 24)} ET have lost ${usd(x.usd)} over ${x.n} (z ${zs(x.z)}).` })) };
    } },
  { key: 'liquidity', role: 'h_liquidity', name: 'Liquidity scout', icon: '🌊', dept: 'trade',
    job: 'checks how much Kalshi has for sale near the price',
    does: 'Reads Kalshi\'s order book for the round open every 30 seconds and tells the Trader and the Caller how many dollars of each side are for sale within 2¢ of the best price, so a big order doesn\'t move the price on itself.',
    cant: 'The book changes by the second: it\'s a reading, not a promise.',
    fit: (c) => (graded(c.calls).length || c.traders > 0 ? 'Calls are being made and traded, and nobody checks how much is actually for sale at the price.' : null),
    row: (c) => {
      const d = c.depth;
      if (!d) return { state: 'idle', status: 'No order book read yet (between rounds, or Kalshi not reachable)', key: 'none', talks: [] };
      const thin = ['yes', 'no'].filter((k) => d[k] && d[k].usd < 50);
      return { state: thin.length ? 'busy' : 'ok', status: `For sale within 2¢: UP $${Math.round(d.yes?.usd ?? 0)} · DOWN $${Math.round(d.no?.usd ?? 0)}${thin.length ? ` · thin on ${thin.map((k) => (k === 'yes' ? 'UP' : 'DOWN')).join(' and ')}` : ''}`, key: thin.join(','),
        talks: thin.map((k) => ({ to: 'trader', text: `Only $${Math.round(d[k].usd)} of ${k === 'yes' ? 'UP' : 'DOWN'} is for sale within 2¢ of the best price: a bigger order would move it.` })) };
    } },
  { key: 'restarts', role: 'h_restarts', name: 'Restart watcher', icon: '🔄', dept: 'ops',
    job: 'counts the server\'s restarts',
    does: 'Records each time the server starts, so you can see how long it has been up and how often it restarts on its own (a crash, a reboot); updates and restarts on purpose are counted apart. Too many restarts means lost in-memory state: the team\'s feed, the fixers\' records, merit pay.',
    cant: 'It tells planned from unplanned, not a crash from a reboot: the server log can.',
    fit: () => 'Nobody keeps track of how often the server restarts, and every restart empties the team\'s memory.',
    row: (c) => {
      // v13.89: planned restarts (an update installing itself, a restart you asked for) are counted apart: only the
      // ones nobody meant (a crash, a reboot, a power cut) are trouble
      const u = c.uptime, wk = (u?.starts || []).filter((t) => t > c.now - 7 * 86400000 && t >= (u?.trackFrom ?? 0)), planned = new Set(u?.planned || []);
      if (!u?.since) return { state: 'idle', status: 'Not reporting', key: 'none', talks: [] };
      const meant = wk.filter((t) => planned.has(t)).length, week = wk.length - meant, many = week > 10;
      return { state: many ? 'warn' : 'ok', status: `Up ${dur((c.now - u.since) / 60000)} · ${week} unplanned start${week === 1 ? '' : 's'} in the last week${meant ? ` (plus ${meant} planned: updates and restarts on purpose)` : ''}`, key: many ? 'many' : 'ok', say: many ? 'the server keeps restarting on its own' : null,
        talks: many ? [{ to: 'nightwatch', text: `${week} unplanned restarts in a week (crashes or reboots): every one empties the team's memory.` }] : [] };
    } },
  // ---------- v13.81: five more, so the Recruiter always has someone to put forward ----------
  { key: 'streak', role: 'h_streak', name: 'Streak watcher', icon: '🔥', dept: 'risk',
    job: 'watches the runs of wins and losses',
    does: 'Follows the official record call by call: the run it\'s on now, and the longest losing run before it, and tells the Risk officer when a losing run is as long as the worst one yet.',
    cant: 'Runs happen by chance too: a long one is a reason to look, not proof something broke.',
    fit: (c) => { const s = streaks(c.calls); return s.n >= 20 ? `${s.n} graded official calls, and nobody watches for losing runs (the longest so far: ${s.longestLossBefore}).` : null; },
    row: (c) => {
      const s = streaks(c.calls);
      if (s.n < 10) return { state: 'idle', status: `${s.n} graded official calls: too few to follow runs yet`, key: 'few', talks: [] };
      const worst = s.won === false && s.cur >= 3 && s.cur >= s.longestLossBefore;
      return { state: worst ? 'warn' : s.won === false && s.cur >= 3 ? 'busy' : 'ok', status: `${s.cur} ${s.won ? 'win' : 'loss'}${s.cur === 1 ? '' : s.won ? 's' : 'es'} in a row · longest losing run before this: ${s.longestLossBefore}`, key: worst ? 'worst' : `${s.won}`,
        say: worst ? `${s.cur} losses in a row: as bad as it's been` : null, talks: worst ? [{ to: 'risk', text: `${s.cur} official calls lost in a row: as long as the worst run yet (${s.longestLossBefore}).` }] : [] };
    } },
  { key: 'pricecoach', role: 'h_pricecoach', name: 'Price-band coach', icon: '💵', dept: 'grade',
    job: 'finds the prices where the calls lose',
    does: 'Splits the official record by the price paid (under 70¢, 70-85¢, 85-95¢, 95¢ and up) and flags a band that clearly loses to its prices (30+ calls, z of −2 or worse).',
    cant: 'It only flags: whether to skip a band is a decision for you (or for the Call filter, if it proves it).',
    fit: (c) => { const n = graded(c.calls).length; return n >= 120 ? `${n} graded official calls: enough to look for prices that lose, and nobody does.` : null; },
    row: (c) => splitRow(splitBy(c.calls, bandOf), { what: 'price band', to: 'caller', label: (k) => `bought at ${k}` }) },
  { key: 'sidecoach', role: 'h_sidecoach', name: 'UP/DOWN checker', icon: '↕️', dept: 'grade',
    job: 'checks the UP calls and the DOWN calls apart',
    does: 'Splits the official record into UP calls and DOWN calls and flags a side that clearly loses to its prices (30+ calls, z of −2 or worse), so a lean toward one side shows.',
    cant: 'A side can lose for a stretch because the market trended the other way: it flags, it doesn\'t explain.',
    fit: (c) => { const n = graded(c.calls).length; return n >= 60 ? `${n} graded official calls, and nobody checks the UP calls against the DOWN calls.` : null; },
    row: (c) => splitRow(splitBy(c.calls, (x) => (String(x.side).toUpperCase() === 'YES' ? 'UP' : 'DOWN')), { what: 'side', to: 'caller', label: (k) => `on ${k}` }) },
  { key: 'weekday', role: 'h_weekday', name: 'Weekday coach', icon: '📅', dept: 'grade',
    job: 'finds the days when the calls lose',
    does: 'Splits the official record by day of the week (Eastern time) and flags a day that clearly loses to its prices (30+ calls, z of −2 or worse).',
    cant: 'It doesn\'t know holidays, and a day can lose for a stretch by chance: it flags, you decide.',
    fit: (c) => { const n = graded(c.calls).filter((x) => x.at).length; return n >= 140 ? `${n} graded official calls with times: enough to look for days that lose, and nobody does.` : null; },
    row: (c) => splitRow(splitBy(c.calls, (x) => (x.at ? ET(x.at).day : null)), { what: 'weekday', to: 'caller', label: (k) => `on ${DAYS[k]}s` }) },
  { key: 'quiet', role: 'h_quiet', name: 'Quiet-spell watcher', icon: '🤫', dept: 'calls',
    job: 'notices when the calls stop coming',
    does: 'Keeps the usual gap between official calls and tells the Caller when the gap since the last one is three times that and over two hours, so a quiet spell that isn\'t the market gets looked at.',
    cant: 'Quiet can be right (a calm market, a guard holding): it says how long, the Doctor and the guards say why.',
    fit: (c) => { const n = (c.calls || []).filter((x) => x.at).length; return n >= 10 ? `${n} official calls, and nobody notices when they stop coming.` : null; },
    row: (c) => {
      const t = (c.calls || []).map((x) => x.at).filter(Boolean).sort((a, b) => a - b);
      if (t.length < 5) return { state: 'idle', status: `${t.length} official calls with times: too few to know the usual gap`, key: 'few', talks: [] };
      const gaps = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b), usual = gaps[Math.floor(gaps.length / 2)], since = c.now - t.at(-1);
      const long = since > 3 * usual && since > 2 * 3600000;
      return { state: long ? 'warn' : 'ok', status: `Last official call ${dur(since / 60000)} ago · the usual gap: ${dur(usual / 60000)}`, key: long ? 'quiet' : 'ok',
        say: long ? `no call in ${dur(since / 60000)}` : null, talks: long ? [{ to: 'caller', text: `No official call in ${dur(since / 60000)}: three times the usual gap (${dur(usual / 60000)}).` }] : [] };
    } },
  // ---------- v13.87: the Mathematician ----------
  { key: 'math', role: 'h_math', name: 'Mathematician', icon: '🧮', dept: 'grade',
    job: 'does the record\'s money math exactly, and says how sure it can be',
    does: 'Works the official record out to the cent as $10 calls after Kalshi\'s fees: the win rate with its 95% range, the win rate the prices need to break even, the average profit per call with its error, and how many more calls it takes to know. It tells the Risk officer when the record is proven ahead of or behind its prices, and the Trader what the Kelly stake would be once an edge is proven (half of it is the usual safe choice).',
    cant: 'Exact math on the past is not a forecast: it says what the record shows and how sure that is, never what the next round does. A proven edge can still fade.',
    fit: (c) => { const n = graded(c.calls).length; return n >= 10 ? `${n} graded official calls, and nobody works out whether the record beats its prices and how sure that is.` : null; },
    row: (c) => {
      const m = recordMath(c.calls);
      if (m.n < 10) return { state: 'idle', status: `${m.n} graded official calls: too few to work out`, key: 'few', talks: [] };
      const line = `Won ${m.wins} of ${m.n} (${pct(m.p)}, 95% range ${pct(m.lo)}-${pct(m.hi)}) · needed ${pct(m.breakeven)} to break even · ${usd(m.mean)} per $10 call (±${usd(m.se).slice(1)}) · ${usd(m.total)} in all`;
      const sure = m.verdict === 'ahead' ? `proven ahead of its prices${m.kelly > 0 ? ` · Kelly stake ${pct(m.kelly)} of the bankroll (half: ${pct(m.kelly / 2)})` : ''}`
        : m.verdict === 'behind' ? 'proven behind its prices' : m.verdict === 'few' ? 'under 30 calls: nothing proven yet'
          : `not decided yet${m.more != null ? ` (about ${m.more} more calls at this gap)` : ''}`;
      return { state: m.verdict === 'behind' ? 'warn' : 'ok', status: `${line} · ${sure}`, key: m.verdict, say: m.verdict === 'ahead' ? 'the record is proven ahead of its prices' : m.verdict === 'behind' ? 'the record is proven behind its prices' : null,
        talks: [
          ...(m.verdict === 'ahead' || m.verdict === 'behind' ? [{ to: 'risk', text: `The official record is proven ${m.verdict} of its prices: ${pct(m.p)} won against ${pct(m.breakeven)} needed (95% range ${pct(m.lo)}-${pct(m.hi)}, ${m.n} calls).` }] : []),
          ...(m.kelly > 0 ? [{ to: 'trader', text: `With a proven edge, the Kelly stake is ${pct(m.kelly)} of the bankroll per call; half-Kelly (${pct(m.kelly / 2)}) is the safer size.` }] : []),
        ] };
    } },
  // ---------- v13.91: the Fact checker ----------
  { key: 'facts', role: 'h_facts', name: 'Fact checker', icon: '🔬', dept: 'grade',
    job: 'proves or disproves what people say about the bot',
    does: 'Puts six claims about the bot to a real test on the official record: that it wins more than half the time, that it beats its prices, that wins and losses come in streaks, that it is getting better, that UP calls beat DOWN calls, and that the pricier calls beat their prices more. Each gets TRUE (the evidence is clearly for it, 95%), FALSE (clearly against it, or the difference is shown to be tiny), or UNPROVEN (with how many more calls it would take). It tells the Caller and the Risk officer the moment a claim is settled.',
    cant: 'It tests the past, not the future, and only these claims; "unproven" means not enough evidence yet, not false. With six tests at 95%, about one in three such reports will show one verdict that is luck, so a claim that flips back and forth near the line deserves doubt.',
    fit: (c) => { const n = graded(c.calls).length; return n >= 60 ? `${n} graded official calls, and nobody tests what people claim about the bot.` : null; },
    row: (c) => {
      const f = factCheck(c.calls);
      if (f.n < 30) return { state: 'idle', status: `${f.n} graded official calls: needs 30 to test anything`, key: 'few', talks: [] };
      const mark = { true: '✔ TRUE', false: '✘ FALSE', unproven: '? UNPROVEN' }, settled = f.claims.filter((x) => x.verdict !== 'unproven');
      return { state: 'ok', status: f.claims.map((x) => `${mark[x.verdict]}: ${x.claim} (${x.why})`).join(' · '), key: f.claims.map((x) => x.verdict[0]).join(''),
        say: settled.length ? `${settled.length} of ${f.claims.length} claims settled` : null, claims: f.claims,
        talks: settled.flatMap((x) => (x.key === 'edge' || x.key === 'streaks' ? ['risk', 'caller'] : ['caller']).map((to) => ({ to, text: `Proven ${x.verdict === 'true' ? 'true' : 'false'}: "${x.claim}" (${x.why}).` }))) };
    } },
  // ---------- v13.85: the RSI agent ----------
  { key: 'rsi', role: 'h_rsi', name: 'RSI agent', icon: '📈', dept: 'desk',
    job: 'reads RSI on 1, 5 and 15 minutes, and tests whether it predicts the round',
    does: 'Reads RSI 14 on 1-, 5- and 15-minute candles (70+ overbought, 30 or under oversold) and spots fresh divergences. It tests every past round on the saved history that opened at an RSI extreme: did it reverse (overbought → down, oversold → up) more than chance? It tells the Scout and the Caller when RSI hits an extreme, and whether extremes have been proven to fade, to run, or neither.',
    cant: 'RSI is one reading of momentum: an extreme can stay extreme in a strong trend. Until its test proves an edge (30+ extreme rounds, z of 2 or more), what it says is context, not a signal.',
    fit: (c) => (c.bars?.length >= 300 ? `${Math.round(c.bars.length / 60)} hours of saved price history, and nobody watches RSI or tests whether its extremes predict the round.` : null),
    row: (c) => {
      const bars = c.bars || [];
      if (bars.length < 60) return { state: 'idle', status: `${bars.length} minutes of price history: RSI needs an hour`, key: 'few', talks: [] };
      const r = rsiRead(bars), t = rsiTestCached(c.series || 'home', bars), one = r.tfs[0];
      const tfs = r.tfs.map((x) => `${x.min}m ${x.v ?? '—'}${x.zone && x.zone !== 'neutral' ? ` (${x.zone})` : ''}`).join(' · ');
      const proof = t.verdict === 'few' ? `testing: ${t.extremes} of ${RSI.minExtremes} extreme rounds so far` : t.verdict === 'fade' ? `proven: extremes fade (${t.hits} of ${t.extremes} reversed, z ${zs(t.z)})` : t.verdict === 'run' ? `proven: extremes keep running (only ${t.hits} of ${t.extremes} reversed, z ${zs(t.z)})` : `no proven edge (${t.hits} of ${t.extremes} reversed, z ${zs(t.z)})`;
      const extreme = one.zone === 'overbought' || one.zone === 'oversold', say = extreme ? `1-minute RSI ${one.v}: ${one.zone}` : r.divergence ? `${r.divergence} RSI divergence` : null;
      const lean = !extreme ? '' : t.verdict === 'fade' ? `; extremes have faded here, so a turn ${one.zone === 'overbought' ? 'down' : 'up'} is likelier` : t.verdict === 'run' ? `; extremes have kept running here, so the move may go on` : '; not proven to predict the round';
      return { state: extreme ? 'busy' : 'ok', status: `RSI ${tfs}${r.divergence ? ` · ${r.divergence} divergence` : ''} · ${proof}`, key: `${one.zone}:${r.divergence}:${t.verdict}`,
        say, talks: extreme || r.divergence ? ['scout', 'caller'].map((to) => ({ to, text: extreme ? `1-minute RSI is ${one.v} (${one.zone})${lean}.` : `A ${r.divergence} RSI divergence on 1 minute: ${r.divergence === 'bearish' ? 'a new high on weaker momentum' : 'a new low on stronger momentum'}.` })) : [] };
    } },
];
export const HIRE_ICON = Object.fromEntries(CANDIDATES.map((c) => [c.role, c.icon]));
// a new hire starts on probation: a TRIAL_H-hour trial (restarted if it's flagged stuck or broken meanwhile, hiring.js),
// and the Training room picks it up the moment it joins (training.js)
export const TRIAL_H = 24;
// the hired agents' rows (hired: [key]; ctx.trials: { key: ms its trial started })
export function hireRows(hired, ctx) {
  return CANDIDATES.filter((c) => hired.includes(c.key)).map((c) => {
    const r = c.row(ctx), start = ctx.trials?.[c.key], served = start ? (ctx.now - start) / 3600000 : TRIAL_H, trial = served < TRIAL_H;
    return { role: c.role, name: c.name, job: c.job, dept: c.dept, hire: true, talks: [], ...r,
      ...(trial ? { trial: true, status: `On probation (new hire, ${Math.ceil(TRIAL_H - served)} h left of its trial): ${r.status}`, trialProgress: { n: Math.floor(served), need: TRIAL_H, what: 'hours of its trial' } } : {}) };
  });
}
