// Map to success (v13.24): the road from first look to a trading habit that holds up, built from live numbers.
// Success here is a process, not a promise: guardrails set, small steady stakes, calls bought where they pay, the
// daily stop respected, and a profit after fees over enough trades that it isn't luck. Every step's meter fills from
// what's on this phone (your tracked trades, settings, calls seen) and the server (the bot's record, the 10-minute
// pick). Each step carries a tip; the coach adds up to three tips read off your own recent trades.
import { RISK_LEVELS, feeEach } from './model.js';
import { dailyLoss } from './profitguard.js';

export const MAP = { watch: 10, small: 10, band: 20, stopDays: 5, solid: 25, pro: 100, stakeShare: 1 / 3, bandShare: 0.9 };

const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const usd = (v) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`;
const cents = (p) => `${Math.round(p * 100)}¢`;
const stakeOf = (t) => (t.contracts || 0) * (t.price || 0);

// Days (last 14 with trades) where a trade was opened after that day's closed trades had already hit the limit
export function stopDays(trades, limit, now = Date.now()) {
  const from = day(now) - 13 * 86400000, byDay = new Map();
  for (const t of trades || []) if ((t.closedAt ?? 0) >= from) { const k = day(t.closedAt); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
  let clean = 0, broke = 0;
  for (const list of byDay.values()) {
    if (!(limit > 0)) { clean++; continue; }
    const closes = [...list].sort((a, b) => a.closedAt - b.closedAt);
    let run = 0, hitAt = null;
    for (const t of closes) { run += t.pnl || 0; if (hitAt == null && run <= -limit + 1e-9) hitAt = t.closedAt; }
    if (hitAt != null && list.some((t) => (t.at ?? 0) > hitAt)) broke++; else clean++;
  }
  return { days: byDay.size, clean, broke };
}

// Your tracked trades: profit after fees, win rate, what those prices need to break even, the running P&L
export function youStats(trades = [], limit = 0, now = Date.now()) {
  const n = trades.length, wins = trades.filter((t) => (t.pnl || 0) > 0).length;
  const pnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const priced = trades.filter((t) => t.price > 0);
  const breakEven = priced.length ? priced.reduce((a, t) => a + t.price + feeEach(t.price, Math.max(1, Math.round(t.contracts || 1))), 0) / priced.length : null;
  const chrono = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)).slice(-60);
  let run = 0; const curve = chrono.map((t) => (run += t.pnl || 0));
  const start = trades.length > chrono.length ? pnl - run : 0;
  return { n, wins, pnl, rate: n ? wins / n : null, breakEven, curve: curve.map((v) => v + start), today: dailyLoss(trades, limit, now) };
}

export function successMap({ trades = [], positions = [], settings = {}, level = 'custom', pushOn = false, seen = null, record = null, pick = null, now = Date.now() } = {}) {
  const limit = settings.dailyLossLimit > 0 ? settings.dailyLossLimit : 0;
  const you = youStats(trades, limit, now), n = you.n;
  const band = RISK_LEVELS.profit, lo = band.minAsk, hi = band.maxAsk;
  const stop = stopDays(trades, limit, now);
  const recent = (k) => trades.slice(0, k); // newest first

  // 1 guardrails
  const guards = [['push alerts on', !!pushOn], ['a daily loss limit', limit > 0], ['the Profit level', level === 'profit']];
  const guardsOn = guards.filter((g) => g[1]).length, missing = guards.filter((g) => !g[1]).map((g) => g[0]);
  // 2 watch first
  const watched = Math.max(seen?.graded ?? 0, n);
  // 4 keep it small
  const small = recent(MAP.small), cap = limit * MAP.stakeShare, inCap = limit > 0 ? small.filter((t) => stakeOf(t) <= cap + 1e-9).length : 0;
  // 5 buy where it pays
  const lastBand = recent(MAP.band), inBand = lastBand.filter((t) => t.price >= lo - 1e-9 && t.price <= hi + 1e-9).length;
  const bandShare = lastBand.length ? inBand / lastBand.length : 0;
  const green = n >= MAP.solid && you.pnl > 0;

  const steps = [
    { id: 'guard', title: 'Set your guardrails', goal: 'Push alerts on, a daily loss limit, and the Profit level',
      progress: guardsOn / 3, done: guardsOn === 3, value: guardsOn === 3 ? 'All 3 set' : `${guardsOn} of 3 · still need ${missing.join(', ')}`,
      tip: 'Set the daily loss limit to an amount you could lose today without it stinging, often 2 to 5% of what you trade with. When it hits, buy alerts stop until midnight. Let them.' },
    { id: 'watch', title: 'Watch before you trade', goal: `See ${MAP.watch} calls settle before risking money`,
      progress: Math.min(1, watched / MAP.watch), done: watched >= MAP.watch, value: `${Math.min(watched, MAP.watch)} of ${MAP.watch} settled`,
      tip: 'Keep the app open through a few rounds and watch the call card, the 10-minute pick and the close. You\'ll see what a losing call looks like before one costs you.' },
    { id: 'first', title: 'Track your first trade', goal: 'Buy small on Kalshi, then tap "I bought it"',
      progress: n + positions.length > 0 ? 1 : 0, done: n + positions.length > 0, value: n + positions.length ? `${n + positions.length} tracked` : 'none yet',
      tip: 'Start with $1 to $5. Tap "I bought it" right away so the bot tracks your price and sends sell and bail signals for that trade.' },
    { id: 'small', title: 'Keep every stake small', goal: `Your last ${MAP.small} stakes each at most a third of your daily limit`,
      progress: limit > 0 ? inCap / MAP.small : 0, done: limit > 0 && small.length >= MAP.small && inCap === MAP.small,
      value: !(limit > 0) ? 'set a daily loss limit first' : `${inCap} of ${MAP.small} within $${cap.toFixed(2)}`,
      tip: 'A third of your daily limit per trade means it takes three straight losses to stop your day, and at 60 to 90¢ three in a row will happen. Same stake every time, win or lose.' },
    { id: 'band', title: 'Buy where calls pay', goal: `${Math.round(MAP.bandShare * 100)}% of your last ${MAP.band} buys at ${cents(lo)} to ${cents(hi)}`,
      progress: Math.min(1, lastBand.length / 10) * bandShare, done: lastBand.length >= 10 && bandShare >= MAP.bandShare - 1e-9,
      value: lastBand.length ? `${inBand} of ${lastBand.length} in the band` : 'no buys yet',
      tip: `Above ${cents(hi)} a win pays a few cents and a loss costs dollars; under ${cents(lo)} it's close to a coin flip. Buy the official calls and BUY ✓ picks, at the price on the card or better.` },
    { id: 'stop', title: 'Respect the daily stop', goal: `${MAP.stopDays} trading days with no trades after the limit hit`,
      progress: limit > 0 ? Math.min(1, stop.days / MAP.stopDays) * (stop.days ? stop.clean / stop.days : 0) : 0,
      done: limit > 0 && stop.days >= MAP.stopDays && stop.broke === 0,
      value: !(limit > 0) ? 'set a daily loss limit first' : stop.broke ? `${stop.broke} day${stop.broke > 1 ? 's' : ''} traded past the limit (14 days)` : `${Math.min(stop.days, MAP.stopDays)} of ${MAP.stopDays} clean days`,
      tip: 'When the limit hits, close the app. Trying to win it back is the fastest way to turn a bad day into a bad month.' },
    { id: 'solid', title: `${MAP.solid} tracked trades`, goal: 'Enough trades that luck starts to wash out',
      progress: Math.min(1, n / MAP.solid), done: n >= MAP.solid, value: `${Math.min(n, MAP.solid)} of ${MAP.solid}`,
      tip: 'Under 25 trades, results are mostly luck, good or bad. Don\'t change your stake or your rules on a hot or cold handful.' },
    { id: 'green', title: 'Profitable after fees', goal: `In profit after Kalshi's fees over ${MAP.solid}+ trades`,
      progress: green ? 1 : Math.min(0.9, n / MAP.solid) * (you.pnl > 0 ? 1 : 0.5), done: green,
      value: n ? `${usd(you.pnl)} over ${n} trade${n > 1 ? 's' : ''}${n < MAP.solid ? ` · need ${MAP.solid}` : ''}` : 'no trades yet',
      tip: 'Profit after fees is the score, not win rate. An 85% win rate at 90¢ still loses money; 70% at 65¢ makes it.' },
    { id: 'pro', title: `${MAP.pro} trades, still green`, goal: `${MAP.pro}+ trades in profit, the daily stop never broken`,
      progress: green && stop.broke === 0 ? Math.min(n >= MAP.pro ? 1 : 0.95, n / MAP.pro) : Math.min(0.5, n / MAP.pro), done: n >= MAP.pro && you.pnl > 0 && stop.broke === 0,
      value: `${Math.min(n, MAP.pro)} of ${MAP.pro}${n ? ` · ${usd(you.pnl)}` : ''}`,
      tip: 'Green after 100 steady-stake trades means your process works: keep it boring. Not green? Halve the stake and buy only the official calls until it is.' },
  ];
  const at = steps.findIndex((s) => !s.done);
  return { you, steps, at: at < 0 ? steps.length : at, done: steps.filter((s) => s.done).length, coach: coachTips({ trades, positions, limit, level, you, record, pick, lo, hi, now }), bot: botLine(record), pick: pickLine(pick, now) };
}

// Up to three tips read off your own trades and the bot right now, most urgent first; an evergreen tip fills in
export function coachTips({ trades = [], positions = [], limit = 0, level, you, record, pick, lo = 0.6, hi = 0.9, now = Date.now() }) {
  const out = [], add = (kind, title, text) => out.push({ kind, title, text });
  const today = you.today;
  if (today.hit) add('warn', 'Done for today', `You hit today's ${usd(-limit).slice(1)} limit. Buy alerts are paused until midnight. Tomorrow starts fresh, so leave it here.`);
  else if (limit > 0 && today.pnl <= -0.6 * limit) add('warn', 'Close to your limit', `You're down ${usd(today.pnl).slice(1)} of your $${limit.toFixed(2)} limit today. Halve your next stake or call it a day.`);
  if (!(limit > 0)) add('warn', 'No daily loss limit', 'Set one in Settings. It is the one setting that protects you from a bad streak.');
  let streak = 0; const kind = trades[0] ? (trades[0].pnl > 0 ? 'W' : 'L') : null;
  for (const t of trades) { if ((t.pnl > 0 ? 'W' : 'L') !== kind) break; streak++; }
  if (kind === 'L' && streak >= 3) add('warn', `${streak} losses in a row`, 'That happens at these prices, even when the bot is right on average. Keep the same stake; raising it to win it back is how small losses get big.');
  const last = trades.slice(0, 20), stakes = trades.slice(0, 20).map(stakeOf);
  if (stakes.length >= 8) {
    const newer = stakes.slice(0, 4), older = stakes.slice(4), avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    if (avg(newer) > 2 * avg(older)) add('warn', 'Your stakes are climbing', `Your last 4 averaged $${avg(newer).toFixed(2)}, over twice the $${avg(older).toFixed(2)} before. Steady stakes keep your results meaning something.`);
  }
  const high = last.filter((t) => t.price > hi + 1e-9).length, cheap = last.filter((t) => t.price < lo - 1e-9).length;
  if (last.length >= 5 && high / last.length >= 0.3) add('info', `${high} of your last ${last.length} cost over ${cents(hi)}`, `One loss at those prices wipes out about ${Math.round(hi / (1 - hi))} wins. The Profit level only calls ${cents(lo)} to ${cents(hi)} for that reason.`);
  else if (last.length >= 5 && cheap / last.length >= 0.3) add('info', `${cheap} of your last ${last.length} cost under ${cents(lo)}`, 'Cheap sides are cheap because they usually lose. Wait for an official call or a BUY ✓ pick.');
  if (you.n >= 15 && you.rate != null && you.breakEven != null) {
    if (you.rate < you.breakEven - 0.02) add('warn', 'Under break-even', `You win ${Math.round(you.rate * 100)}%, and the prices you pay need ${Math.round(you.breakEven * 100)}% to break even after fees. Buy lower, or only the official calls.`);
    else if (you.rate > you.breakEven + 0.03 && you.pnl > 0) add('good', 'Beating break-even', `You win ${Math.round(you.rate * 100)}% against the ${Math.round(you.breakEven * 100)}% your prices need. Keep doing exactly this; don't size up.`);
  }
  if (kind === 'W' && streak >= 5) add('good', `${streak} wins in a row`, 'Nice. Keep the same stake. Streaks end, and sizing up after one is how gains get handed back.');
  if (positions.length) add('info', `${positions.length} open trade${positions.length > 1 ? 's' : ''}`, 'Keep alerts on: a bail or sell signal can save most of your stake if the round turns.');
  if (record?.profitGuard?.paused) add('info', 'The bot is sitting out', 'Its last 40 calls are down after fees, so its buy alerts are paused until they recover. Sitting out is part of the plan.');
  const p = pick?.live;
  if (p && Date.parse(p.closeTime) > now) {
    if (p.buy) add('info', 'This round\'s pick says BUY ✓', `${p.side === 'YES' ? 'UP' : 'DOWN'} at ${cents(p.price)}. Only if it fits your stake rule and today's limit. A pick wins about as often as its odds, not always.`);
    else add('info', 'This round\'s pick is PICK ONLY', 'Kalshi\'s price doesn\'t pay for it, so skipping this round is the disciplined move.');
  }
  if (level !== 'profit' && level) add('info', 'Not on the Profit level', 'The official record is graded on the Profit level. Switch in Settings to trade the calls the record shows.');
  const urgent = out.filter((t) => t.kind === 'warn'), rest = out.filter((t) => t.kind !== 'warn');
  const picked = [...urgent, ...rest].slice(0, 3);
  if (picked.length < 3) picked.push({ kind: 'tip', title: 'Tip of the day', text: EVERGREEN[Math.floor(day(now) / 86400000) % EVERGREEN.length] });
  return picked;
}

export const EVERGREEN = [
  'Write down why you bought before the round closes. After 20 trades, read them back: the reasons that lost money are the ones to drop.',
  'Fees add up on small edges. A call needs to beat Kalshi\'s price by more than the fee to be worth it, which is why the card shows the gap after fees.',
  'The bot\'s odds are a lean, not a lock. A 75% call loses one round in four, so plan for the loss before you buy.',
  'Skip rounds when you\'re tired, rushed or upset. The bot trades around the clock; you don\'t have to.',
  'Check the Record tab weekly. If the official record is down after fees over 40 calls, the bot pauses itself, and that\'s a cue to pause too.',
  'Buy at the price on the card or better. Chasing a side a few cents higher can turn a paying call into one that doesn\'t.',
  'Never add money to cover losses. Your bankroll is what you decided you could lose, and that number doesn\'t grow after a bad day.',
  'Bail alerts exist for a reason. Selling a turning trade at 40¢ beats watching it settle at zero.',
];

function botLine(r) {
  if (!r) return null;
  return { level: r.level, graded: r.graded || 0, wins: r.wins || 0, usd: r.usd || 0, paused: !!r.profitGuard?.paused };
}
function pickLine(k, now) {
  if (!k?.closeTime) return null;
  const e = k.live && Date.parse(k.live.closeTime) > now ? k.live : null, st = k.stats;
  return { locked: !!e, side: e?.side ?? null, buy: !!e?.buy, price: e?.price ?? null, locksAt: k.locksAt ?? null,
    last: k.last ? (k.last.side.toLowerCase() === k.last.result ? 'won' : 'lost') : null, graded: st?.graded || 0, wins: st?.wins || 0 };
}
