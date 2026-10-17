// The flip study (v13.43): how flip calls would really have done, from the candle history, and what separates the flips
// that hold from the ones that flip straight back.
//   replay    every complete 15-minute round in the 1-minute candles (playbookfeed.js, up to 21 days): the side ahead at
//             10:00 left is the locked call (as the bot locks it); from there until the last minutes (noCallLastMin), the
//             first minute the other side's worst-case odds (the bot's own math, volatility 20% off either way) reach
//             the flip bar is a flip call. It won if the round closed on the new side.
//   features  what the chart looked like at that moment: minutes left, how far past the target in typical moves (z),
//             how many minutes price had held the new side (crossAge), whether one sudden minute did the crossing
//             (spike, in typical moves), the last 3 minutes' push toward the new side (mom3), how jumpy the market was
//             (volRatio: short vol over 2-hour vol) and the wick back toward the target on the last candle (rejWick)
//   filter    one-line rules ("only after 2+ minutes on the new side", "never on a spike past 2.5×", ...): the best one is
//             picked on the older two thirds of the flips, then checked on the newest third it never saw. It blocks flip
//             calls only once proven there: the flips it keeps won more often than the ones it blocks, z 2+, 30+ kept.
// Pure: tunefeed.js runs it hourly on the server; the bot (bot.js) and the phone (engine.js flipOk) apply a proven filter.
import { effectiveVol, probAbove, realizedVol } from './model.js';

export const FS = { lateTry: [4, 3, 2, 1], minLate: 30, minMinute: 20, lockLeft: 10, lastMin: 5, conf: 0.9, vols: [0.8, 1, 1.25], train: 2 / 3, minTrainKept: 20, minKept: 30, z: 2, minVol: 0.00008, history: 121 };
const ROUND = 900000, MIN = 60000;

function longVol(closes) { // plain 2-hour volatility (engine.js's)
  const r = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 10) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}
// the bot's volatility at a bar (effectiveVol of the EWMA and the 2-hour vol over the last 121 closes)
function volAt(bars, i) {
  const cs = bars.slice(Math.max(0, i - FS.history + 1), i + 1).map((b) => b.c), ew = realizedVol(cs), lg = longVol(cs);
  const sg = ew || lg ? effectiveVol(ew, lg, FS.minVol, 0.6) : null;
  // 3 significant digits (a 0.1% difference): the settlement-average math caches its shape per volatility, so the replay
  // reuses it instead of recomputing it for every minute (it took seconds otherwise)
  return sg ? { sigma: Number(sg.toPrecision(3)), ratio: lg ? (ew || sg) / lg : 1 } : null;
}
const pSide = (side, S, K, sigma, left, w) => { const p = probAbove(S, K, sigma, left, 0, w); return side === 'YES' ? p : 1 - p; };
// the worst of the three volatility guesses (engine.js assess)
const worst = (side, S, K, sigma, left, w) => Math.min(...FS.vols.map((k) => pSide(side, S, K, sigma * k, left, w)));

// What the chart looks like for a flip to `side` at bar i (closed): the features the filter reads. Live, the last
// closed bar stands in for the bar and the live price for its close (liveFlipFeatures).
export function flipFeatures({ closes, last, strike, side, sigma, ratio, left }) {
  const dir = side === 'YES' ? 1 : -1, c = closes.at(-1), on = (x) => (x - strike) * dir > 0;
  let crossAge = 0;
  for (let j = closes.length - 1; j >= 0 && on(closes[j]); j--) crossAge++;
  const prev = closes.at(-2), p3 = closes.at(-4);
  return {
    left,
    z: Math.abs(Math.log(c / strike)) / (sigma * Math.sqrt(Math.max(left, 1 / 60))),
    crossAge,
    spike: prev > 0 ? Math.abs(Math.log(c / prev)) / sigma : 0,
    mom3: p3 > 0 ? dir * Math.log(c / p3) / (sigma * Math.sqrt(3)) : 0,
    volRatio: ratio ?? 1,
    rejWick: last ? (dir > 0 ? last.h - Math.max(last.o, last.c) : Math.min(last.o, last.c) - last.l) / (c * sigma) : 0,
  };
}

// Every flip call the history would have made: [{ t, side, won, f: features }], oldest first
export function flipSamples(bars, { lockLeft = FS.lockLeft, lastMin = FS.lastMin, conf = FS.conf, w = 1 } = {}) {
  const at = new Map(bars.map((b, i) => [b.t, i])), out = [];
  if (bars.length < FS.history) return out;
  for (let rs = Math.ceil(bars[0].t / ROUND) * ROUND; rs + ROUND <= bars.at(-1).t + MIN; rs += ROUND) {
    const first = at.get(rs), last = at.get(rs + ROUND - MIN);
    if (first == null || last == null || last - first !== 14 || first < 30) continue;
    const K = bars[first].o, close = bars[last].c;
    if (close === K) continue;
    const kLock = 14 - lockLeft, iLock = first + kLock, vl = volAt(bars, iLock);
    if (!vl || bars[iLock].c === K) continue;
    const locked = pSide('YES', bars[iLock].c, K, vl.sigma, lockLeft, w) >= 0.5 ? 'YES' : 'NO', other = locked === 'YES' ? 'NO' : 'YES';
    for (let k = kLock + 1; 14 - k > lastMin; k++) {
      const i = first + k, left = 14 - k, v = volAt(bars, i), S = bars[i].c;
      if (!v) continue;
      if (worst(other, S, K, v.sigma, left, w) < conf - 1e-9) continue;
      const closes = bars.slice(first, i + 1).map((b) => b.c);
      const f = flipFeatures({ closes: [bars[first - 1]?.c ?? K, ...closes], last: bars[i], strike: K, side: other, sigma: v.sigma, ratio: v.ratio, left });
      out.push({ t: bars[i].t, side: other, won: (close > K) === (other === 'YES'), f });
      break; // one flip a round (flipMax)
    }
  }
  return out;
}

// The one-line rules tried (each keeps the flips it passes)
export const FLIP_GATES = [
  ['crossAge', '>=', 2, 'only after 2+ minutes on the new side'], ['crossAge', '>=', 3, 'only after 3+ minutes on the new side'],
  ['spike', '<=', 1.5, 'never when one minute did the crossing (a move over 1.5 typical)'], ['spike', '<=', 2.5, 'never on a spike over 2.5 typical moves'],
  ['mom3', '>=', 0, 'only while the last 3 minutes still push toward the new side'], ['mom3', '>=', 0.5, 'only on a firm 3-minute push toward the new side'],
  ['z', '>=', 1.8, 'only when price is 1.8+ typical moves past the target'], ['z', '>=', 2.2, 'only when price is 2.2+ typical moves past the target'],
  ['volRatio', '<=', 1.3, 'not while the market is jumpier than usual (1.3×)'], ['volRatio', '<=', 1.8, 'not while the market is far jumpier than usual (1.8×)'],
  ['rejWick', '<=', 0.5, 'not right after a wick back toward the target'], ['rejWick', '<=', 1, 'not right after a long wick back toward the target'],
  ['left', '<=', 7, 'only with 7 minutes or less left'], ['left', '>=', 8, 'only with 8+ minutes left'],
].map(([key, op, v, label]) => ({ key, op, v, label }));
export const flipGateOk = (g, f) => !g || !f || f[g.key] == null || (g.op === '>=' ? f[g.key] >= g.v - 1e-12 : f[g.key] <= g.v + 1e-12);

const tally = (xs) => ({ n: xs.length, wins: xs.filter((x) => x.won).length });
const rate = (t) => (t.n ? t.wins / t.n : null);
const wilsonLow = (t, z = 1.64) => { if (!t.n) return 0; const p = t.wins / t.n, d = 1 + z * z / t.n; return (p + z * z / (2 * t.n) - z * Math.sqrt(p * (1 - p) / t.n + z * z / (4 * t.n * t.n))) / d; };
// two-proportion z: kept flips' win rate over the blocked ones'
function twoProp(a, b) {
  if (!a.n || !b.n) return 0;
  const p = (a.wins + b.wins) / (a.n + b.n), se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se > 0 ? (rate(a) - rate(b)) / se : 0;
}

// The study: the replay's record (train / test), the best rule on train and how it held on test
// laneLastMin: the real flip lane stops this many minutes before the close (noCallLastMin); the study learns from every
// minute down to opts.lastMin, and reports the lane's own flips (the first qualifying minute still inside its window)
export const flipStudy = (bars, opts = {}) => studyFlips(flipSamples(bars, opts), opts);
// the rule selection and its test, from the replay's samples (oldest first)
export function studyFlips(s, opts = {}) {
  const laneLastMin = opts.laneLastMin ?? FS.lastMin;
  const cut = Math.floor(s.length * FS.train), train = s.slice(0, cut), test = s.slice(cut);
  const tr = tally(train), te = tally(test);
  let best = null;
  for (const g of FLIP_GATES) {
    const kept = tally(train.filter((x) => flipGateOk(g, x.f)));
    if (kept.n < Math.max(FS.minTrainKept, 0.4 * tr.n) || kept.n === tr.n) continue;
    const lb = wilsonLow(kept);
    if (lb > wilsonLow(tr) && (!best || lb > best.lb)) best = { ...g, lb, train: { kept, blocked: tally(train.filter((x) => !flipGateOk(g, x.f))) } };
  }
  let gate = null, proven = false;
  if (best) {
    const kept = tally(test.filter((x) => flipGateOk(best, x.f))), blocked = tally(test.filter((x) => !flipGateOk(best, x.f))), z = twoProp(kept, blocked);
    proven = kept.n >= FS.minKept && blocked.n >= 5 && rate(kept) > rate(te) && z >= FS.z;
    gate = { key: best.key, op: best.op, v: best.v, label: best.label, train: best.train, test: { kept, blocked }, z };
  }
  const byLeft = {};
  for (const x of s) { const b = (byLeft[x.f.left] ||= { n: 0, wins: 0 }); b.n++; if (x.won) b.wins++; }
  // v13.43.1 flips later than the lane's last minutes: allowed down to the latest minute where history's flips (the ones the
  // rule keeps, once it's proven) won at least the flip bar overall and in both the older and newer half, 30+ flips
  const conf = opts.conf ?? FS.conf, kept = s.filter((x) => !proven || !gate || flipGateOk(gate, x.f)), bands = [];
  let lateMin = null;
  for (const L of FS.lateTry.filter((x) => x < laneLastMin)) {
    const band = kept.filter((x) => x.f.left >= L && x.f.left < laneLastMin), h = Math.floor(band.length / 2);
    const b = { lastMin: L, ...tally(band), older: tally(band.slice(0, h)), newer: tally(band.slice(h)) };
    // and the minute being added has to hold on its own (a weak last minute can't hide behind strong earlier ones)
    b.minute = tally(band.filter((x) => x.f.left < L + 1));
    b.ok = b.n >= FS.minLate && rate(b) >= conf - 1e-9 && rate(b.older) >= conf - 1e-9 && rate(b.newer) >= conf - 1e-9 && b.minute.n >= FS.minMinute && rate(b.minute) >= conf - 1e-9;
    bands.push(b);
    if (!b.ok) break; // later minutes only while every earlier one holds too
    lateMin = L;
  }
  return { flips: s.length, all: tally(s), lane: tally(s.filter((x) => x.f.left >= laneLastMin)), laneLastMin, late: { lastMin: lateMin, bands, need: conf }, train: tr, test: te, gate, proven, byLeft, recent: s.slice(-8).reverse().map((x) => ({ t: x.t, side: x.side, won: x.won, left: x.f.left, z: +x.f.z.toFixed(2), crossAge: x.f.crossAge, spike: +x.f.spike.toFixed(2) })), opts: { lockLeft: opts.lockLeft ?? FS.lockLeft, lastMin: opts.lastMin ?? FS.lastMin, conf: opts.conf ?? FS.conf } };
}

// The live features for a flip to `side` (engine.js flipOk): closed 1-minute bars, the live price for the forming minute
// (like the replay: the round's own minutes, plus the one before it opened)
export function liveFlipFeatures({ bars, spot, strike, side, sigmaMin, sigmaLong, minutesLeft, openTime = null }) {
  if (!(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !bars?.length) return null;
  const ot = Number.isFinite(openTime) ? openTime : null, closed = bars.slice(0, -1).filter((b) => ot == null || b.t >= ot - MIN), last = closed.at(-1);
  const closes = [...closed.slice(-20).map((b) => b.c), spot];
  return flipFeatures({ closes, last, strike, side, sigma: sigmaMin, ratio: sigmaLong ? sigmaMin / sigmaLong : 1, left: minutesLeft });
}
