// Profit protection (v13.7): a high win rate isn't profit. Calls bought at 90c+ win small and lose big, so a level can
// win 92% of the time and still lose money after fees. Two guards, both pure; the phone and the server apply them.
//   Profit guard  a level's last 40 graded calls, each scored as $10 held to settlement after Kalshi's fee
//                 (public/model.js pnl10). Once there are 20+ and they add up to a loss, its buy alerts pause. The bot
//                 keeps logging what it would have called, so the record shows when the level makes money again and
//                 the alerts come back by themselves
//   Daily loss    your own tracked trades (what you actually bought and sold): once today's closed trades have lost
//                 your daily limit, buy alerts stop until midnight (your phone's time)
import { feeEach, pnl10 } from './model.js';
import { wilsonLow } from './winguard.js';

export const PG = { window: 40, min: 20 };

export function profitGuard(calls) {
  const graded = (calls || []).filter((e) => e.result === 'yes' || e.result === 'no').slice(-PG.window);
  const usd = graded.reduce((a, e) => a + pnl10(e.price, e.side.toLowerCase() === e.result), 0);
  return { n: graded.length, usd, paused: graded.length >= PG.min && usd < 0 };
}

// Today's closed trades against the limit; until = the next local midnight when it's hit
export function dailyLoss(trades, limit, now = Date.now()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = (trades || []).filter((t) => (t.closedAt ?? 0) >= start.getTime());
  const pnl = today.reduce((a, t) => a + (t.pnl || 0), 0), hit = limit > 0 && pnl <= -limit + 1e-9;
  const next = new Date(start); next.setDate(next.getDate() + 1);
  return { pnl, trades: today.length, limit, hit, until: hit ? next.getTime() : null };
}

// The early lane's proof (v13.16): early calls (10 to 5 minutes left, Kalshi at 80-89c) start as test calls, graded but
// never sent. They go live only once the test record shows they really beat Kalshi's price:
//   n      50+ graded test calls
//   low    the win rate's 90% lower bound (Wilson), at or above
//   need   what those prices need to break even: the average price paid plus its fee, at $10 a call
//   usd    and a profit after fees
// and they drop back to test calls whenever their last 40 lose money after fees (the profit guard). Simulation couldn't
// settle whether early calls beat Kalshi (it depends on how good Kalshi's early prices really are), so real rounds decide.
export const EARLY = { min: 50 };
export function earlyProof(calls) {
  const graded = (calls || []).filter((e) => e.result === 'yes' || e.result === 'no');
  const n = graded.length, wins = graded.filter((e) => e.side.toLowerCase() === e.result).length;
  const usd = graded.reduce((a, e) => a + pnl10(e.price, e.side.toLowerCase() === e.result), 0);
  const need = n ? graded.reduce((a, e) => a + e.price + feeEach(e.price, Math.floor(10 / e.price)), 0) / n : null;
  const low = wilsonLow(wins, n), pg = profitGuard(calls);
  return { n, wins, usd, need, low, live: n >= EARLY.min && usd > 0 && low >= need - 1e-9 && !pg.paused, paused: pg.paused };
}
