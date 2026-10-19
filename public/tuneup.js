// The tune-up (v13.52): an on-demand accuracy check you run when you want (Settings → Admin, or `npm run tuneup`).
// Everything here is tested the honest way: tuned on the older 70% of graded round calls, then checked on the newest
// 30% they never saw. A change is used only when it beats what the bot does now on those unseen rounds by a clear
// margin (z ≥ 2 on the paired per-round difference, 30+ rounds); otherwise the bot keeps learning on its own.
//
// Two settings are tuned here, both from the raw odds each round call stored (the bot's own and Kalshi's), so the
// tune-up never learns from its own output:
//   blend        how much of the round call is the bot's odds and how much Kalshi's (public/pick.js mixOdds). The bot
//                already picks a blend from all its graded rounds; the tune-up checks that choice on unseen ones.
//   calibration  whether its odds are over- or under-confident: a "temperature" T that pulls odds toward 50% (T > 1) or
//                pushes them out (T < 1), so a call that says 80% wins about 80% of the time. It never changes the
//                side, only the odds, which decide which round calls are worth buying.
import { calibrate, mixOdds } from './pick.js';

export { calibrate };

export const TUNE_UP = {
  trainShare: 0.7, minTrain: 50, minTest: 30, z: 2,
  mixes: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  temps: [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2],
};
const clampP = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));

// the round calls that can be tested: graded, with both odds stored, not a fallback (those are Kalshi's own side), oldest first
export function gradedPicks(picks) {
  return (picks || []).filter((e) => (e.result === 'yes' || e.result === 'no') && e.kalshi != null && !e.fallback && (e.pb ?? e.p) != null && e.side)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
const won = (e) => (e.side.toLowerCase() === e.result ? 1 : 0);
const logLoss = (q, y) => -Math.log(y ? clampP(q) : 1 - clampP(q));
const sqErr = (q, y) => (q - y) ** 2;
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
// how clearly `better` beats `base` on the same rounds: z of the mean per-round improvement
function pairedZ(base, better) {
  const d = base.map((x, i) => x - better[i]), m = mean(d);
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
  return { gain: m, z: sd > 0 ? m / (sd / Math.sqrt(d.length)) : m > 0 ? Infinity : 0 };
}
export function split(xs, share = TUNE_UP.trainShare) {
  const k = Math.round(xs.length * share);
  return { train: xs.slice(0, k), test: xs.slice(k) };
}
const enough = (train, test) => train.length >= TUNE_UP.minTrain && test.length >= TUNE_UP.minTest;

// the blend: the best one on the older rounds, against the one the bot uses now, on the newer rounds
export function blendTest(picks, current) {
  const xs = gradedPicks(picks), { train, test } = split(xs);
  const out = { n: xs.length, train: train.length, test: test.length, current, chosen: current, apply: false };
  if (!enough(train, test)) return { ...out, why: `needs ${TUNE_UP.minTrain + TUNE_UP.minTest}+ graded round calls with both odds (has ${xs.length})` };
  const lossOn = (set, w) => set.map((e) => logLoss(mixOdds(e.pb ?? e.p, e.kalshi, w), won(e)));
  const scores = TUNE_UP.mixes.map((w) => ({ w, train: mean(lossOn(train, w)) }));
  const best = scores.reduce((a, b) => (b.train < a.train - 1e-12 ? b : a)).w;
  const base = lossOn(test, current), mine = lossOn(test, best), { gain, z } = pairedZ(base, mine);
  const apply = best !== current && z >= TUNE_UP.z;
  return { ...out, chosen: apply ? best : current, best, testLoss: { current: mean(base), best: mean(mine) }, gain, z,
    apply, why: best === current ? 'the blend the bot uses is already the best on the older rounds' : apply ? `beats the current blend on ${test.length} unseen rounds (z ${z.toFixed(1)})` : `not clearly better on unseen rounds (z ${z.toFixed(1)}, needs ${TUNE_UP.z})` };
}

// calibration: the temperature that fits the older rounds best, checked on the newer ones (Brier score: lower is better)
export function calibrationTest(picks, mix) {
  const xs = gradedPicks(picks), { train, test } = split(xs);
  const out = { n: xs.length, train: train.length, test: test.length, temp: 1, apply: false };
  if (!enough(train, test)) return { ...out, why: `needs ${TUNE_UP.minTrain + TUNE_UP.minTest}+ graded round calls with both odds (has ${xs.length})` };
  const errOn = (set, t) => set.map((e) => sqErr(calibrate(mixOdds(e.pb ?? e.p, e.kalshi, mix), t), won(e)));
  const best = TUNE_UP.temps.map((t) => ({ t, train: mean(errOn(train, t)) })).reduce((a, b) => (b.train < a.train - 1e-12 ? b : a)).t;
  const base = errOn(test, 1), mine = errOn(test, best), { gain, z } = pairedZ(base, mine);
  const apply = best !== 1 && z >= TUNE_UP.z;
  // how far off its odds were on the unseen rounds: what it said on average vs how often it won
  const said = mean(test.map((e) => mixOdds(e.pb ?? e.p, e.kalshi, mix))), hit = mean(test.map(won));
  return { ...out, temp: apply ? best : 1, best, brier: { now: mean(base), tuned: mean(mine) }, said, won: hit, gain, z, apply,
    why: best === 1 ? 'its odds are already well calibrated' : apply ? `${best > 1 ? 'over' : 'under'}-confident: fixed on ${test.length} unseen rounds (z ${z.toFixed(1)})` : `a ${best > 1 ? 'small over' : 'small under'}-confidence, not clear enough on unseen rounds to fix (z ${z.toFixed(1)}, needs ${TUNE_UP.z})` };
}

// both, in order (calibration is tested on the blend the round calls will use)
export function tuneUpPicks(picks, currentMix) {
  const blend = blendTest(picks, currentMix);
  const calibration = calibrationTest(picks, blend.chosen);
  return { blend, calibration, settings: { mix: blend.apply ? blend.chosen : null, temp: calibration.apply ? calibration.temp : null } };
}
