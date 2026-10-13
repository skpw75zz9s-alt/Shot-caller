// The call filter: learns from the bot's own graded calls which KINDS of calls lose money, and skips them.
// Every official call is saved with what the bot saw when it made it: its confidence, the price, minutes left, how
// settled the market was (stability), how jumpy (volatility vs its 2-hour norm), Kalshi's spread, and how many
// notable things Market watch saw in the minute before (public/watch.js), and (v13.21, from a public Kalshi bot that
// blocks trading 6 PM-5 AM Eastern) whether it was overnight or a weekend in New York, when the market is thinner.
// Every call has its time, so the whole record teaches it. After each settle, a
// logistic regression (heavily regularised) learns each call's chance of winning from those.
// It only filters calls once it has PROVEN it would have helped: the past calls are replayed in order, each one
// judged by a model fitted only on the calls before it (so it never peeks at the answer); the filter switches on
// only if the calls it would have skipped LOST money overall and won clearly less often than the ones it kept (a
// significance test, so a lucky streak of losses can't switch it on). Until then
// it learns quietly and changes nothing. A skipped call needs: chance of winning < price + Kalshi's fee + margin.
import { kalshiFee } from './model.js';

export const GATE = { minCalls: 120, warmup: 60, minSkipped: 10, margin: 0.02, l2: 3, z: 2 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (p) => { const q = clamp(p, 0.01, 0.99); return Math.log(q / (1 - q)); };
const sigm = (z) => 1 / (1 + Math.exp(-z));

// New York time of a moment: { night: 6 PM to 5 AM, weekend: Saturday or Sunday }
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
export function nyClock(at) {
  if (!Number.isFinite(at)) return null;
  const parts = Object.fromEntries(NY.formatToParts(new Date(at)).map((p) => [p.type, p.value])), h = Number(parts.hour) % 24;
  return { hour: h, night: h >= 18 || h < 5, weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' };
}
// What the bot saw at the call, as numbers around typical values (so the weights start meaningful at 0)
// (spread: Kalshi's spread at the call; ev60: Market watch's notable events in the minute before it, public/watch.js;
// at: when, for the overnight and weekend flags)
export function callFeatures({ conf, price, mins, stab, vr, spread, ev60, at = null }) {
  if (conf == null || price == null) return null;
  const m = mins ?? 7, v = clamp((vr ?? 1) - 1, -1, 2);
  // plus the combinations that matter: late in the round AND jumpy, and late with low confidence
  return [conf / 100 - 0.85, price - 0.8, m / 15 - 0.5, (stab ?? 60) / 100 - 0.6, v, Math.max(0, 5 - m) / 5 * Math.max(0, v), Math.max(0, 5 - m) / 5 * (0.9 - conf / 100),
    clamp((spread ?? 0.02) - 0.02, -0.02, 0.2) * 10, Math.min(ev60 ?? 0, 5) / 5, ...((c) => [c?.night ? 1 : 0, c?.weekend ? 1 : 0])(nyClock(at))];
}
// Logistic regression with an intercept starting at the calls' overall win rate (Newton's method, L2 on the weights)
export function fitGate(rows, { l2 = GATE.l2 } = {}) {
  const xs = rows.filter((r) => r.x && (r.y === 0 || r.y === 1));
  if (!xs.length) return null;
  const k = xs[0].x.length + 1, rate = (xs.reduce((a, r) => a + r.y, 0) + 1) / (xs.length + 2);
  const w = [logit(rate), ...new Array(k - 1).fill(0)];
  for (let it = 0; it < 15; it++) {
    const g = w.map((wi, i) => (i ? l2 * wi : 0)), H = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j && i ? l2 : i === j ? 1e-6 : 0)));
    for (const r of xs) {
      const v = [1, ...r.x], p = sigm(v.reduce((a, x, i) => a + x * w[i], 0)), e = p - r.y, s = p * (1 - p);
      for (let i = 0; i < k; i++) { g[i] += e * v[i]; for (let j = 0; j < k; j++) H[i][j] += s * v[i] * v[j]; }
    }
    const step = solve(H, g);
    if (!step) break;
    let moved = 0;
    for (let i = 0; i < k; i++) { w[i] -= step[i]; moved += Math.abs(step[i]); }
    if (moved < 1e-7) break;
  }
  return w;
}
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
// (a filter learned before an input existed has no weight for it yet: that input counts 0 until the next relearn)
export const winChance = (w, x) => (w && x ? sigm([1, ...x].reduce((a, v, i) => a + v * (w[i] ?? 0), 0)) : null);
const breakeven = (price) => price + kalshiFee(price) + GATE.margin;
const pnl = (r) => (r.y ? 1 - r.price - kalshiFee(r.price) : -r.price - kalshiFee(r.price)); // per contract, held to the end

// The bot's graded calls -> the filter: weights, and whether it has earned the right to skip calls
export function learnGate(record) {
  const rows = record.filter((e) => e.feat && (e.result === 'yes' || e.result === 'no'))
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ x: callFeatures({ conf: e.conf, price: e.price, ...e.feat, at: e.at }), y: e.result === e.side.toLowerCase() ? 1 : 0, price: e.price }))
    .filter((r) => r.x)
    .slice(-600); // the latest 600 calls (markets change; and the replay stays quick)
  const out = { n: rows.length, active: false, w: null, replay: null };
  if (rows.length < GATE.warmup + 10) return out;
  // the honest replay: each call judged by a model fitted only on the calls before it
  const kept = [], skipped = [];
  for (let i = GATE.warmup; i < rows.length; i++) {
    const w = fitGate(rows.slice(0, i)), p = winChance(w, rows[i].x);
    (p != null && p < breakeven(rows[i].price) ? skipped : kept).push(rows[i]);
  }
  const sum = (a) => a.reduce((s, r) => s + pnl(r), 0), rate = (a) => (a.length ? a.reduce((s, r) => s + r.y, 0) / a.length : null);
  out.replay = { judged: kept.length + skipped.length, skipped: skipped.length, skippedPnl: sum(skipped), skippedWin: rate(skipped), keptWin: rate(kept), keptPnl: sum(kept) };
  out.w = fitGate(rows);
  // ...and the gap must be real, not luck: a two-proportion z-test, skipped calls' win rate clearly under the kept ones'
  const all = [...kept, ...skipped], p = rate(all) ?? 0, se = Math.sqrt(Math.max(1e-9, p * (1 - p) * (1 / Math.max(1, skipped.length) + 1 / Math.max(1, kept.length))));
  out.replay.z = skipped.length && kept.length ? (rate(kept) - rate(skipped)) / se : 0;
  out.active = rows.length >= GATE.minCalls && skipped.length >= GATE.minSkipped && out.replay.skippedPnl < 0 && out.replay.z >= GATE.z;
  return out;
}
// At a new call: skip it? (only when the filter is active)
export function gateCheck(gate, feat, price) {
  if (!gate?.active || !gate.w) return null;
  const p = winChance(gate.w, callFeatures({ ...feat, price }));
  return p == null ? null : { pWin: p, skip: p < breakeven(price), need: breakeven(price) };
}
