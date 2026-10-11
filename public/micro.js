// The micro model: learns how the market's small details move BTC over the next 1, 3 and 5 minutes, so the prediction
// candles can bend with them. Pure; microfeed.js on the server feeds it every 10 seconds.
// Each sample is the details at that moment (MICRO_FEATURES); its targets are BTC's actual move 1, 3 and 5 minutes
// later, in typical moves (so calm and wild hours count alike). One recursive least-squares model per horizon learns
// the weights, recent data counting more (forgetting ~a day back), starting at zero (no opinion) and pulled toward zero
// (a strong prior), so nothing sways the lines on a hunch. Every prediction is graded once its horizon passes, against
// "no change" (out of sample: it's made before the outcome is known), and a horizon is only used once it has beaten
// no change by 0.5%+ over 500+ graded samples.
export const MICRO_FEATURES = ['flow30', 'flow120', 'ret1', 'ret5', 'fLead', 'fFlow', 'fPremium', 'leader', 'absorb', 'cbPremium', 'kalshiTilt', 'kFlow', 'jump',
  // the playbook's market structure (public/structure.js) and futures funding
  'sweep', 'shift', 'fvgPull', 'obZone', 'volDiv', 'vwapDev', 'fFunding'];
export const MICRO_NAMES = {
  flow30: 'buyers vs sellers (30 s)', flow120: 'buyers vs sellers (2 min)', ret1: 'the last minute\'s move', ret5: 'the last 5 minutes\' move',
  fLead: 'futures moving ahead', fFlow: 'futures buyers vs sellers', fPremium: 'futures premium', leader: 'the leading exchange pulling away',
  absorb: 'big orders soaked up', cbPremium: 'Coinbase premium', kalshiTilt: 'Kalshi\'s price vs the bot', kFlow: 'Kalshi trade flow', jump: 'the latest jump',
  sweep: 'a liquidity sweep', shift: 'a market structure shift', fvgPull: 'an unfilled fair value gap', obZone: 'an order block', volDiv: 'volume divergence', vwapDev: 'distance from VWAP', fFunding: 'futures funding',
};
export const HORIZONS = [1, 3, 5]; // minutes
export const MICRO_GATE = { minN: 500, minSkill: 0.005 };
const K = MICRO_FEATURES.length + 1; // + intercept
const LAMBDA = 0.99985, PRIOR = 0.05, SKILL_DECAY = 0.9995;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const newMicro = () => ({ v: 1, models: Object.fromEntries(HORIZONS.map((h) => [h, newRls()])) });
function newRls() { return { w: new Array(K).fill(0), P: Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? PRIOR : 0))), n: 0, e0: 0, e1: 0 }; }

// the details, as numbers around 0 (missing = 0), with the intercept first
export function microVector(f) { return [1, ...MICRO_FEATURES.map((k) => clamp(Number.isFinite(f?.[k]) ? f[k] : 0, -3, 3))]; }
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export function microPredict(M, x) { return Object.fromEntries(HORIZONS.map((h) => [h, dot(M.models[h].w, x)])); }

// A graded sample: x (microVector), y (the move h minutes later in typical moves), yhat (the prediction made back then)
export function microLearn(M, h, x, y, yhat) {
  const m = M.models[h];
  const yc = clamp(y, -4, 4);
  m.e0 = m.e0 * SKILL_DECAY + yc * yc * (1 - SKILL_DECAY);           // no change's error
  m.e1 = m.e1 * SKILL_DECAY + (yc - yhat) ** 2 * (1 - SKILL_DECAY);  // the model's (made before it knew)
  m.n++;
  // recursive least squares with forgetting: w += k (y - w.x), P = (P - k x'P) / lambda
  const Px = m.P.map((row) => dot(row, x)), denom = LAMBDA + dot(x, Px), k = Px.map((v) => v / denom), err = yc - dot(m.w, x);
  for (let i = 0; i < K; i++) m.w[i] += k[i] * err;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) m.P[i][j] = (m.P[i][j] - k[i] * Px[j]) / LAMBDA;
  // keep it from drifting off: cap the uncertainty at the prior's (so a long quiet stretch can't blow it up)
  for (let i = 0; i < K; i++) if (m.P[i][i] > PRIOR) { const s = Math.sqrt(PRIOR / m.P[i][i]); for (let j = 0; j < K; j++) { m.P[i][j] *= s; m.P[j][i] *= s; } }
}
export const microSkill = (m) => (m.e0 > 0 ? 1 - m.e1 / m.e0 : 0);
export const microActive = (m) => m.n >= MICRO_GATE.minN && microSkill(m) >= MICRO_GATE.minSkill;

// What the phone gets: per horizon the prediction in dollars (0 unless proven), the skill, and what's swaying it now
export function microRead(M, x, { price, sigmaMin }) {
  const out = { at: null, horizons: {}, sway: [] };
  const yh = microPredict(M, x);
  for (const h of HORIZONS) {
    const m = M.models[h], active = microActive(m);
    out.horizons[h] = { active, n: m.n, skill: microSkill(m), move: active && price > 0 && sigmaMin > 0 ? yh[h] * price * sigmaMin * Math.sqrt(h) : 0 };
  }
  // the details pushing the 5-minute read hardest right now (weight x value)
  const m5 = M.models[5];
  out.sway = MICRO_FEATURES.map((k, i) => ({ key: k, name: MICRO_NAMES[k], push: m5.w[i + 1] * x[i + 1] })).filter((s) => Math.abs(s.push) >= 0.03).sort((a, b) => Math.abs(b.push) - Math.abs(a.push)).slice(0, 4);
  return out;
}
// The prediction candles' extra bend t minutes from when the read was made: through the 1-, 3- and 5-minute moves, then
// held (the small details' push fades into the longer-term lines after that)
export function microOffset(read, t) {
  if (!read?.horizons || !(t > 0)) return 0;
  const pts = [[0, 0], ...HORIZONS.map((h) => [h, read.horizons[h]?.move || 0])];
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return va + (vb - va) * ((t - a) / (b - a)); }
  return pts[pts.length - 1][1];
}

// For the bot's calls: how the proven small details change the chance of finishing above the target. The predicted
// move over the minutes left (up to 5) shifts where BTC is expected to be at the close; with the distance to the target,
// the volatility and the time left, that's a shift in P(YES). Unproven horizons predict 0, so they add nothing.
// Capped at +-6 points.
export const MICRO_CALL_CAP = 0.06;
export function microShift(read, { spot, strike, sigmaMin, minutesLeft, strikeType = 'greater', now = Date.now() }) {
  if (!read?.horizons || !(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0)) return 0;
  const since = Math.max(0, (now - (read.at ?? now)) / 60000);
  const move = microOffset(read, since + Math.min(5, minutesLeft)) - microOffset(read, since);
  if (!move) return 0;
  const sd = spot * sigmaMin * Math.sqrt(minutesLeft), ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const shift = ncdf((spot + move - strike) / sd) - ncdf((spot - strike) / sd);
  return clamp(/^less/.test(strikeType || '') ? -shift : shift, -MICRO_CALL_CAP, MICRO_CALL_CAP);
}
function erf(x) { // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
