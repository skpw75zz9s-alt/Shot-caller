// The win-rate guard (v13.5): keeps the 90% target level's real record above 90%.
// The level (public/model.js RISK_LEVELS.target90) only calls a side Kalshi itself prices at the floor or more (90c to
// start) and the bot rates higher still, at that price, after the fee. Kalshi's price is a well-calibrated estimate of
// the win chance, so calls bought at 90c+ win about 90%+ of the time on their own; the bot's agreement on top lifts it
// (simulated: 92-97% depending on how noisy Kalshi's prices are). The guard watches the level's own graded calls and,
// if they slip, raises the floor:
//   rate   the last 100 graded calls' win rate, shrunk toward the aim (92%) by 40 calls' worth (a few losses early
//          can't swing it)
//   floor  90c + 1.5 x (92% - rate) when the rate is below the aim, never above 97c, rounded up to the cent
// So a record at 92%+ keeps the floor at 90c; one loss in the first 3 calls lifts it to 93c, 88% over 100 calls to 95c
// (fewer, surer calls) until the record recovers. The price: the dearer the call, the less a win pays, and fees can
// make it lose money even while it wins.
export const GUARD = { aim: 0.92, base: 0.9, max: 0.97, gain: 1.5, prior: 40, window: 100 };

const won = (e) => e.side.toLowerCase() === e.result;
// Wilson's lower 95% bound on a win rate (one-sided): how low the true rate could plausibly be
export function wilsonLow(wins, n, z = 1.6448536269514722) {
  if (!n) return null;
  const p = wins / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}
export function guardStats(calls) {
  const graded = (calls || []).filter((e) => e.result === 'yes' || e.result === 'no'), recent = graded.slice(-GUARD.window);
  const n = recent.length, wins = recent.filter(won).length, rate = (wins + GUARD.aim * GUARD.prior) / (n + GUARD.prior);
  const floor = Math.min(GUARD.max, Math.ceil((GUARD.base + GUARD.gain * Math.max(0, GUARD.aim - rate)) * 100 - 1e-6) / 100); // (0.9 x 100 is 90.00000000000001 in floating point)
  const all = graded.filter(won).length;
  return { n, wins, rate, floor, low: wilsonLow(wins, n), total: graded.length, totalWins: all };
}
// Settings with the guard's floor applied (only for a level that has one)
export const withGuard = (settings, floor) => (settings?.winFloor > 0 && floor > 0 ? { ...settings, winFloor: Math.max(settings.winFloor, floor) } : settings);
