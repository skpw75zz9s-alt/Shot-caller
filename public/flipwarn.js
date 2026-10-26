// Flip warnings (v13.88): "the bot now leans against its call". They used to go out the moment the call's odds dipped
// under 50%, for a single tick: a price wobbling around the target set them off over and over, and the call often won
// anyway. Now a warning needs the call's odds clearly against it (40% or under) for 20 seconds straight, with a minute
// or more left to act; a wobble back over 45% starts the count again. Every warning is graded when its round settles
// (right = the called side lost), and if the record shows they're no better than a coin flip (20+ graded, the 95% low
// end of their hit rate under 50%) the bar goes up to 30% held for 45 seconds. Shared by the server (discordalerts.js)
// and the phone (app.js).
import { wilsonLow } from './winguard.js';

// The chart's turn marks (↺, public/flip.js and predict.js pathTurns): only when the move is ripe to turn (the flip
// score 50%+) and the turn is a real one (at least 0.6 of a typical minute either side), and never while their own
// record proves them no better than a random minute.
export const FLIP_MARK = { score: 0.5, depth: 0.6 };
export const FLIP_WARN = { normal: { p: 0.4, holdMs: 20000 }, strict: { p: 0.3, holdMs: 45000 }, reset: 0.45, minLeft: 1, minGraded: 20, keep: 200 };

// log: [{ right: boolean }] (graded warnings, oldest first)
export function flipRecord(log = []) {
  const n = log.length, right = log.filter((x) => x.right).length;
  const lo = n ? wilsonLow(right, n) : 0;
  return { n, right, rate: n ? right / n : null, lo, mode: n >= FLIP_WARN.minGraded && lo < 0.5 ? 'strict' : 'normal' };
}

// One watch per round: feed it the called side's odds each tick. Returns true the tick a warning is due (once a round).
// w: { lowSince, sent } (kept by the caller), p: the called side's odds now
export function flipDue(w, { p, minutesLeft, now, mode = 'normal' }) {
  if (w.sent || p == null) return false;
  const rule = FLIP_WARN[mode] || FLIP_WARN.normal;
  if (p <= rule.p && minutesLeft >= FLIP_WARN.minLeft) {
    w.lowSince ??= now;
    if (now - w.lowSince >= rule.holdMs) { w.sent = true; return true; }
  } else if (p >= FLIP_WARN.reset || minutesLeft < FLIP_WARN.minLeft) w.lowSince = null;
  return false;
}
