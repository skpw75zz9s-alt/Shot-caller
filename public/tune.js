// Indicator tuning: which chart indicators, at which settings, have actually predicted BTC's 15-minute rounds.
// Pure; tunefeed.js on the server runs it every hour on the playbook's 1-minute candle history (playbookfeed.js).
//   The question   at 10, 6 and 3 minutes before a round's close, does the indicator's signal say which way BTC moves
//                  from here to the close? (the move in typical moves: log return / (1-minute volatility x sqrt(minutes)))
//   The candidates EMA and RMA crosses, RSI zones, MACD histogram, Bollinger breaks, VWAP from the round's open and plain
//                  momentum, each at several common settings (CANDIDATES). A signal may work either way (trend or fade):
//                  the direction is learned too.
//   No peeking     each signal is read off the candle BEFORE the latest one (the server's candles can be a minute old)
//   No fooling     the history is split by time: the first 2/3 picks each family's best setting and its direction, the
//                  last 1/3 (rounds it never saw) tests only that pick. Proven = the held-out test agrees with |z| >= 2.7
//                  (strict, because 8 families are tested at once) on 150+ rounds, and training agreed too.
// Only proven indicators reach the bot's calls (indicatorShift), capped at +-4 points.
import { bollinger, ema, macd, rma, rsiSeries } from './indicators.js';
import { oddsShift } from './model.js';

export const TUNE = { checkpoints: [10, 6, 3], train: 2 / 3, zTest: 2.7, zTrain: 2, minRounds: 150, minTrain: 100, shrink: 50, cap: 0.04 };
const ROUND = 900000, MIN = 60000;

const cross = (fast, slow, f) => ({ need: slow, series: (c) => { const a = f(c, fast), b = f(c, slow); return c.map((_, i) => (a[i] != null && b[i] != null ? Math.sign(a[i] - b[i]) : null)); } });
export const CANDIDATES = [
  ...[[5, 13], [9, 21], [12, 26], [20, 50]].map(([a, b]) => ({ id: `ema${a}_${b}`, family: 'ema', name: `EMA ${a} / ${b} cross`, ...cross(a, b, ema) })),
  ...[[5, 13], [9, 21], [12, 26], [20, 50]].map(([a, b]) => ({ id: `rma${a}_${b}`, family: 'rma', name: `RMA ${a} / ${b} cross`, ...cross(a, b, rma) })),
  ...[7, 14, 21].flatMap((n) => [[70, 30], [65, 35], [60, 40], [80, 20]].map(([hi, lo]) => ({ id: `rsi${n}_${hi}`, family: 'rsi', name: `RSI ${n} above ${hi} / below ${lo}`, need: n + 1,
    series: (c) => rsiSeries(c, n).map((r) => (r == null ? null : r > hi ? 1 : r < lo ? -1 : 0)) }))),
  ...[[12, 26, 9], [8, 17, 9], [5, 35, 5]].map(([a, b, s]) => ({ id: `macd${a}_${b}_${s}`, family: 'macd', name: `MACD ${a}/${b}/${s} histogram`, need: b + s,
    series: (c) => macd(c, a, b, s).map((m) => (m.hist == null ? null : Math.sign(m.hist))) })),
  ...[[20, 2], [20, 1.5], [10, 2], [30, 2.5]].map(([n, k]) => ({ id: `boll${n}_${k}`, family: 'boll', name: `Bollinger ${n} ±${k}σ break`, need: n,
    series: (c) => { const b = bollinger(c, n, k); return c.map((x, i) => (b[i] == null ? null : x > b[i].up ? 1 : x < b[i].lo ? -1 : 0)); } })),
  ...[3, 5, 15, 30].map((n) => ({ id: `mom${n}`, family: 'mom', name: `${n}-minute momentum`, need: n + 1, series: (c) => c.map((x, i) => (i < n ? null : Math.sign(x - c[i - n]))) })),
  { id: 'vwapRound', family: 'vwap', name: 'Price vs VWAP from the round\'s open', need: 1, bars: true },
];
export const FAMILY_NAMES = { ema: 'EMA cross', rma: 'RMA cross', rsi: 'RSI zones', macd: 'MACD', boll: 'Bollinger bands', mom: 'Momentum', vwap: 'VWAP' };

// The round VWAP signal needs the candles themselves (volume); everything else works on closes
function vwapSignals(bars) {
  const out = new Array(bars.length).fill(null);
  let start = -1, pv = 0, vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], rs = Math.floor(b.t / ROUND) * ROUND;
    if (start !== rs) { start = rs; pv = 0; vol = 0; }
    const v = b.v > 0 ? b.v : 0; pv += ((b.h + b.l + b.c) / 3) * v; vol += v;
    out[i] = vol > 0 ? Math.sign(b.c - pv / vol) : null;
  }
  return out;
}
export function signalSeries(cand, bars) { return cand.bars ? vwapSignals(bars) : cand.series(bars.map((b) => b.c)); }

// 1-minute volatility (log returns) over the last hour, at each bar
function volSeries(bars) {
  const out = new Array(bars.length).fill(null);
  let s = 0, s2 = 0;
  const r = bars.map((b, i) => (i && bars[i - 1].c > 0 ? Math.log(b.c / bars[i - 1].c) : 0));
  for (let i = 1; i < bars.length; i++) {
    s += r[i]; s2 += r[i] * r[i];
    if (i > 60) { s -= r[i - 60]; s2 -= r[i - 60] ** 2; }
    if (i >= 60) out[i] = Math.max(1e-5, Math.sqrt(Math.max(0, s2 / 60 - (s / 60) ** 2)));
  }
  return out;
}

// The samples: each round x checkpoint with complete candles -> { round, i (the bar closing at the checkpoint), y }
export function samples(bars) {
  const at = new Map(bars.map((b, i) => [b.t, i])), vol = volSeries(bars), out = [];
  if (bars.length < 120) return out;
  for (let end = Math.ceil(bars[0].t / ROUND) * ROUND + ROUND; end <= bars.at(-1).t + MIN; end += ROUND) {
    const ie = at.get(end - MIN);
    if (ie == null) continue;
    for (const m of TUNE.checkpoints) {
      const i = at.get(end - m * MIN - MIN);
      if (i == null || i < 61 || vol[i] == null) continue;
      out.push({ round: end, m, i, y: Math.log(bars[ie].c / bars[i].c) / (vol[i] * Math.sqrt(m)) });
    }
  }
  return out;
}

// How one signal did on some samples, with the direction `dir` (+1 trend, -1 fade). Each round's evidence is the SUM
// over its checkpoints (a quiet checkpoint adds 0), never the average over just the active ones: averaging lets a
// signal that stays on while it's wrong dilute its own losses, which made pure noise look like a working "fade"
function grade(sig, ss, dir) {
  const byRound = new Map();
  let hits = 0, active = 0, total = 0;
  for (const s of ss) {
    const v = sig[s.i - 1]; // the candle before: never the newest one
    if (!v) continue;
    const yo = v * dir * s.y;
    active++; total += yo; if (yo > 0) hits++;
    byRound.set(s.round, (byRound.get(s.round) || 0) + yo);
  }
  const xs = [...byRound.values()], n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0, sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { rounds: n, samples: active, hit: active ? hits / active : null, mean: active ? total / active : 0, z: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0 };
}

// The whole check: every candidate on training data, each family's best (and its direction) on the held-out test
export function tuneIndicators(bars) {
  const ss = samples(bars);
  const rounds = [...new Set(ss.map((s) => s.round))], cut = rounds[Math.floor(rounds.length * TUNE.train)] ?? Infinity;
  const train = ss.filter((s) => s.round < cut), test = ss.filter((s) => s.round >= cut);
  const families = {};
  for (const c of CANDIDATES) {
    const sig = signalSeries(c, bars), g = grade(sig, train, 1), dir = g.mean >= 0 ? 1 : -1;
    const tr = { ...grade(sig, train, dir) };
    const f = families[c.family];
    if (tr.rounds < TUNE.minTrain) continue; // too rare to judge
    if (!f || tr.z > f.train.z) families[c.family] = { family: c.family, name: FAMILY_NAMES[c.family], id: c.id, setting: c.name, dir, train: tr, sig };
  }
  const out = [];
  for (const f of Object.values(families)) {
    const te = grade(f.sig, test, f.dir);
    const proven = te.rounds >= TUNE.minRounds && te.z >= TUNE.zTest && f.train.z >= TUNE.zTrain;
    out.push({ family: f.family, name: f.name, id: f.id, setting: f.setting, dir: f.dir, train: f.train, test: te, proven,
      strength: proven ? te.mean * (te.rounds / (te.rounds + TUNE.shrink)) : 0 });
  }
  out.sort((a, b) => b.test.z - a.test.z);
  return { at: bars.at(-1)?.t ?? null, rounds: rounds.length, trainRounds: rounds.filter((r) => r < cut).length, testRounds: rounds.filter((r) => r >= cut).length, families: out };
}

// The proven indicators' read right now: the expected move to the close, in typical moves (averaged, not added:
// trend indicators overlap). Reads the candle before the newest, as in the test.
export function indicatorRead(report, bars) {
  const live = (report?.families || []).filter((f) => f.proven);
  if (!live.length || bars.length < 3) return { drift: 0, active: [] };
  const active = [];
  for (const f of live) {
    const c = CANDIDATES.find((x) => x.id === f.id), v = c ? signalSeries(c, bars.slice(-400)).at(-2) : null;
    if (v) active.push({ id: f.id, setting: f.setting, push: v * f.dir * f.strength });
  }
  return { drift: active.length ? active.reduce((a, b) => a + b.push, 0) / live.length : 0, active };
}
// That expected move as a change in P(YES) for a market: capped at +-4 points
export function indicatorShift(drift, { spot, strike, sigmaMin, minutesLeft, strikeType = 'greater' }) {
  if (!drift || !(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft >= 1) || minutesLeft > 14) return 0;
  return oddsShift(drift * spot * sigmaMin * Math.sqrt(minutesLeft), { spot, strike, sigmaMin, minutesLeft, strikeType }, TUNE.cap);
}
