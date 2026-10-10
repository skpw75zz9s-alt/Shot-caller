// Learning every second. Once a second the server grades the bot against the market and learns from it
// (pure functions, shared by the server and the phone, kept in learned.json with the rest of the bot's memory):
//   1) volatility check: every second, the price move over the last 60 seconds is compared with the volatility the
//      bot expected 60 seconds ago. Recent misses (30-minute half-life) give a live correction: if BTC has been moving
//      1.2x what the bot expected, its odds widen to match. The correction is only used while it's proving itself:
//      each second it's scored, out of sample, on how well it would have predicted the move (log-likelihood vs no
//      correction), and it switches itself off if it stops helping.
//   2) Kalshi blend: every second of a round, the bot's own odds and Kalshi's price are saved. When the round settles,
//      every blend (0% Kalshi … 100% Kalshi) is scored on those seconds, so it learns how much Kalshi's price is worth
//      next to the bot's. Shown, not applied: blending in Kalshi changes which calls the bot makes, so that's your call
//      (Settings → Respect the market).
const VOL_HALF_LIFE = 1800; // seconds
const VOL_DECAY = 0.5 ** (1 / VOL_HALF_LIFE);
const GAIN_DECAY = 0.5 ** (1 / (6 * 3600)); // 6-hour memory for "is the correction helping?"
const MIN_SECONDS = 3600; // an hour of graded seconds before the correction can be used
export const FIX_RANGE = [0.8, 1.25];
export const BLEND_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const newPulse = () => ({
  v: 1, seconds: 0, firstT: null, lastT: 0,
  z2: 1, n: 0, gain: 0, gainN: 0, // volatility check
  ring: [], // [{ t, p, s, fix }] the last ~70 seconds (price, the bot's per-minute volatility, the correction then)
  blend: { rounds: 0, loss: BLEND_WEIGHTS.map(() => 0) }, live: {}, // ticker -> { s: [[pBot, mid]], closeTime }
});

// The live volatility correction (1 = none): only while it's been helping and has an hour of evidence
export function pulseFix(P) {
  if (!P || P.n < MIN_SECONDS || !(P.gain > 0)) return 1;
  return clamp(Math.sqrt(P.z2), ...FIX_RANGE);
}
const rawFix = (P) => clamp(Math.sqrt(P.z2), ...FIX_RANGE);

// One second: price (BTC), sigmaMin (the bot's volatility per minute, log). Seconds that repeat or jump are skipped.
export function pulseSecond(P, { t, price, sigmaMin }) {
  const sec = Math.floor(t / 1000) * 1000;
  if (!(price > 0) || !(sigmaMin > 0) || sec <= P.lastT) return false;
  if (P.lastT && sec - P.lastT > 10000) P.ring = []; // an outage: start the 60-second clock again
  P.lastT = sec;
  P.ring.push({ t: sec, p: price, s: sigmaMin, fix: rawFix(P) });
  while (P.ring.length && P.ring[0].t < sec - 70000) P.ring.shift();
  const then = P.ring.find((x) => x.t >= sec - 60000 && x.t <= sec - 58000); // the forecast made a minute ago
  P.seconds++; P.firstT ??= sec;
  if (!then) return true;
  const r = Math.log(price / then.p), z = r / then.s;
  const z2 = Math.min(z * z, 25); // one crash second can't own the estimate
  // score the correction the bot had a minute ago against none, on this move (Gaussian log-likelihood difference)
  const f = then.fix, ll = (k) => -Math.log(k) - (z * z) / (2 * k * k);
  P.gain = P.gain * GAIN_DECAY + (ll(f) - ll(1)); P.gainN = P.gainN * GAIN_DECAY + 1;
  P.z2 = P.z2 * VOL_DECAY + z2 * (1 - VOL_DECAY); P.n++;
  return true;
}

// Kalshi blend: a second of a live round (pBot = the bot's own P(YES) before any Kalshi blend, mid = Kalshi's mid)
export function pulseRound(P, { ticker, closeTime, pBot, mid }) {
  if (!ticker || pBot == null || mid == null || !(mid > 0 && mid < 1)) return;
  const r = (P.live[ticker] ||= { s: [], closeTime });
  if (r.s.length < 1000) r.s.push([Math.round(pBot * 1000) / 1000, Math.round(mid * 1000) / 1000]);
}
// The round settled (result 'yes' | 'no'): score every blend on its seconds; each round counts once
export function pulseSettle(P, ticker, result) {
  const r = P.live[ticker];
  if (!r) return false;
  delete P.live[ticker];
  if ((result !== 'yes' && result !== 'no') || r.s.length < 60) return false;
  const y = result === 'yes' ? 1 : 0;
  BLEND_WEIGHTS.forEach((w, i) => {
    let l = 0;
    for (const [pb, m] of r.s) { const p = clamp((1 - w) * pb + w * m, 0.01, 0.99); l -= y ? Math.log(p) : Math.log(1 - p); }
    P.blend.loss[i] += l / r.s.length;
  });
  P.blend.rounds++;
  return true;
}
export function prunePulse(P, now) { for (const [k, r] of Object.entries(P.live)) if (r.closeTime < now - 6 * 3600000) delete P.live[k]; }

// What the phone shows
export function pulseStatus(P) {
  if (!P) return null;
  const b = P.blend, best = b.rounds ? b.loss.indexOf(Math.min(...b.loss)) : null;
  return {
    seconds: P.seconds, since: P.firstT, graded: P.n,
    expected: Math.sqrt(P.z2), // how BTC has been moving vs what the bot expected (1 = spot on)
    fix: pulseFix(P), helping: P.n >= MIN_SECONDS ? P.gain > 0 : null, needed: Math.max(0, MIN_SECONDS - P.n),
    blendRounds: b.rounds, blendBest: best == null ? null : BLEND_WEIGHTS[best],
    blendLoss: b.rounds ? b.loss.map((l) => l / b.rounds) : null,
  };
}
// The part the phone prices with (no per-second ring, no round buffers)
export const publicPulse = (P) => (P ? { v: P.v, n: P.n, z2: P.z2, gain: P.gain } : null);
