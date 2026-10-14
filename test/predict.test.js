import test from 'node:test';
import assert from 'node:assert/strict';
import { normInv, kalshiImplied, exchangeTrend, predictionLines, predictionRecord } from '../public/predict.js';
import { normCdf } from '../public/model.js';

test('normInv undoes normCdf', () => {
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-3, String(p));
});

test('Kalshi-implied close: 50¢ YES = the target; dearer YES = above it; "below" markets flip', () => {
  const base = { strike: 100000, sigmaMin: 0.0008, minutesLeft: 9 };
  assert.ok(Math.abs(kalshiImplied({ ...base, yesMid: 0.5 }) - 100000) < 1);
  const up = kalshiImplied({ ...base, yesMid: 0.8 });
  assert.ok(up > 100000 && up < 100300, String(up));
  assert.ok(kalshiImplied({ ...base, yesMid: 0.8, strikeType: 'less' }) < 100000);
  assert.equal(kalshiImplied({ ...base, yesMid: null }), null);
});

test('exchange trend: a steady climb on all five projects higher (at half strength); too few trades, no line', () => {
  const now = 1_700_000_300_000, close = now + 6 * 60000, ts = [];
  for (let s = 0; s < 300; s += 2) for (const ex of ['Coinbase', 'Kraken', 'Bitstamp', 'Gemini', 'Binance.US']) ts.push({ t: now - 300000 + s * 1000, ex, price: 100000 + s * 0.2 });
  const tr = exchangeTrend(ts, now, close);
  assert.ok(tr.slopePerMin > 10 && tr.slopePerMin < 14, String(tr.slopePerMin)); // $12 a minute
  assert.ok(Math.abs(tr.end - (tr.start + 6 * 12 * 0.5)) < 4, `${tr.start} -> ${tr.end}`);
  assert.equal(exchangeTrend(ts.slice(0, 5), now, close), null);
});

test('prediction lines stay inside the 90% cone and end at the close', () => {
  const now = 1_700_000_000_000, close = now + 8 * 60000;
  const lines = predictionLines({ spot: 100000, sigmaMin: 0.0005, pBot: 0.999, now, close, strike: 100000, yesMid: 0.99, trades: [] });
  assert.deepEqual(lines.map((l) => l.key), ['bot', 'kalshi', 'still']);
  const sd = 100000 * 0.0005 * Math.sqrt(8);
  for (const l of lines) { assert.ok(Math.abs(l.end - 100000) <= 1.645 * sd + 1e-6); assert.equal(l.pts.at(-1).t, close); }
});

test('record: average miss per line vs no change', () => {
  const r = predictionRecord([{ actual: 100, bot: 90, kalshi: 104, spot: 80 }, { actual: 200, bot: 210, kalshi: 200, spot: 200 }, { actual: null, bot: 1 }]);
  assert.equal(r.rounds, 2); assert.equal(r.bot.miss, 10); assert.equal(r.kalshi.miss, 2); assert.equal(r.still.miss, 10); assert.equal(r.exch, undefined, 'no line logged, no record');
});

// ---------- the expected path, minute by minute ----------
import { blendFit, correctLines, pathMinutes, pathRecord } from '../public/predict.js';
test('the expected path\'s minutes: what the bot expects, no random noise, landing on the blend', () => {
  const now = Date.UTC(2026, 0, 1, 12, 3, 30), close = Date.UTC(2026, 0, 1, 12, 15);
  const pts = (from, to) => [{ t: now, v: from }, { t: close, v: to }];
  const lines = [{ key: 'bot', pts: pts(100000, 100000) }, { key: 'kalshi', pts: pts(100000, 100140) }];
  const c = pathMinutes({ lines, spot: 100000, sigmaMin: 0.0008, now, close });
  assert.equal(c.length, 11, '12:04 … 12:14');
  assert.equal(c[0].t, Date.UTC(2026, 0, 1, 12, 4));
  for (let i = 1; i < c.length; i++) assert.equal(c[i].o, c[i - 1].c, 'each minute starts where the last ended');
  assert.ok(Math.abs(c.at(-1).c - 100070) < 1e-6, 'lands on the blend (equal weights: halfway) at the close');
  assert.ok(c.every((x) => x.c > x.o), 'the read says up, so every minute is up');
  assert.ok(pathMinutes({ lines: [{ key: 'bot', pts: pts(1e5, 1e5) }], spot: 1e5, sigmaMin: 0.0008, now, close }).every((y) => Math.abs(y.c - y.o) < 1e-9), 'a flat read stays flat');
  assert.deepEqual(pathMinutes({ lines, spot: 100000, sigmaMin: 0.0008, now: now + 2000, close }).map((y) => y.c), c.map((y) => y.c), 'the same moment gives the same path');
  // weighted toward the line that has missed less
  const log = Array.from({ length: 400 }, (_, i) => { const n = ((i * 7) % 11) - 5; return { closeTime: String(i), spot: 1e5, actual: 1e5, bot: 1e5 + 60 * n, kalshi: 1e5 + 20 * (((i * 3) % 7) - 3) }; });
  const w = blendFit(log).weights;
  assert.ok(w.kalshi > w.bot * 4, JSON.stringify(w));
  assert.ok(pathMinutes({ lines, spot: 100000, sigmaMin: 0.0008, now, close, weights: w }).at(-1).c > 100120);
  assert.deepEqual(pathMinutes({ lines: [], spot: 1, sigmaMin: 1, now, close }), []);
});
test('the prediction engine becomes a line: its P(UP) as the close it expects', async () => {
  const { predictionLines } = await import('../public/predict.js');
  const now = Date.UTC(2026, 0, 1, 12, 5), close = now + 10 * 60000;
  const base = { spot: 100000, sigmaMin: 0.0008, now, close, strike: 100000 };
  const up = predictionLines({ ...base, engine: { pUp: 0.7 } }).find((l) => l.key === 'engine'), dn = predictionLines({ ...base, engine: { pUp: 0.3 } }).find((l) => l.key === 'engine');
  assert.ok(up.end > 100000 && dn.end < 100000 && Math.abs(up.end - 100000 - (100000 - dn.end)) < 1);
  assert.equal(predictionLines(base).find((l) => l.key === 'engine'), undefined, 'no read, no line');
});
test('the expected path\'s record: direction and miss vs no change', () => {
  const r = pathRecord([
    { t: 1, o: 100, c: 110, open: 100, actual: 105 }, // right way, miss 5 (no change missed 5)
    { t: 2, o: 100, c: 90, open: 100, actual: 120 },  // wrong way
    { t: 3, o: 100, c: 101, open: null, actual: null }, // not graded yet
  ]);
  assert.deepEqual({ n: r.n, called: r.called, right: r.right }, { n: 2, called: 2, right: 1 });
  assert.equal(r.miss, (5 + 30) / 2); assert.equal(r.still, (5 + 20) / 2);
  assert.deepEqual(pathRecord([]), { n: 0, beta: 1 }, 'nothing graded yet: no scaling');
});

test('the lines run past the close on a rolling horizon; the close prediction is unchanged', () => {
  const now = Date.UTC(2026, 0, 1, 12, 13, 0), close = Date.UTC(2026, 0, 1, 12, 15), until = now + 15 * 60000;
  const trades = [];
  for (let s = 0; s < 300; s++) for (const ex of ['Coinbase', 'Kraken']) trades.push({ t: now - 300000 + s * 1000, ex, price: 100000 + s * 0.2, size: 1 });
  const base = { spot: 100060, sigmaMin: 0.0008, now, close, strike: 100000, yesMid: 0.7, strikeType: 'greater', trades, pBot: 0.75 };
  const short = predictionLines(base), long = predictionLines({ ...base, until });
  for (const k of ['bot', 'kalshi', 'exch']) {
    const a = short.find((l) => l.key === k), b = long.find((l) => l.key === k);
    assert.equal(a.end, b.end, `${k}: same close prediction`);
    assert.equal(a.pts.at(-1).t, close); assert.equal(b.pts.at(-1).t, until, `${k}: runs 15 minutes ahead`);
  }
  const k = long.find((l) => l.key === 'kalshi');
  assert.equal(k.pts.at(-1).v, k.end, 'Kalshi holds its close level after the close');
  const e = long.find((l) => l.key === 'exch');
  assert.ok(e.pts.at(-1).v > e.end, "the exchanges' trend keeps going");
});

test('the cone and prediction lines sit on whole minutes, so redraws never reshuffle the chart (it used to jump back)', async () => {
  const { marketCone } = await import('../public/predict.js');
  const conePts = (spot, sigmaMin, now, close) => marketCone({ spot, sigmaMin, now, close }).pts;
  const close = Date.UTC(2026, 0, 1, 12, 15), until = Date.UTC(2026, 0, 1, 12, 23);
  for (const now of [Date.UTC(2026, 0, 1, 12, 7, 13, 250), Date.UTC(2026, 0, 1, 12, 7, 48, 900)]) {
    const cone = conePts(100000, 0.0008, now, until);
    assert.ok(cone.every((c) => c.t % 60000 === 0), 'cone on minutes');
    assert.equal(cone[0].t, Date.UTC(2026, 0, 1, 12, 7)); assert.equal(cone[0].hi90, 100000, 'starts on the live candle with no spread');
    for (const l of predictionLines({ spot: 100000, sigmaMin: 0.0008, now, close, until, strike: 99950, yesMid: 0.6 })) assert.ok(l.pts.every((p) => p.t % 60000 === 0), `${l.key} on minutes`);
  }
  // two redraws in the same minute use exactly the same times
  const times = (now) => conePts(100000, 0.0008, now, until).map((c) => c.t).join();
  assert.equal(times(Date.UTC(2026, 0, 1, 12, 7, 5)), times(Date.UTC(2026, 0, 1, 12, 7, 55)));
});

// ---------- v12.2 the market cone ----------
import { coneRecord, coneSkew, marketCone, splitAbove } from '../public/predict.js';
import { normCdf as ncdf } from '../public/model.js';
test('the cone centres on the market read, not the price, and keeps its points on whole minutes', () => {
  const now = Date.UTC(2026, 0, 1, 12, 3, 30), close = Date.UTC(2026, 0, 1, 12, 15);
  const path = (t) => 100000 + 10 * (t - now) / 60000; // the read: +$10 a minute
  const { pts, summary } = marketCone({ path, spot: 100000, sigmaMin: 0.0008, now, close, strike: 100000 });
  for (const p of pts.slice(0, -1)) assert.equal(p.t % 60000, 0);
  assert.equal(pts.at(-1).t, close);
  const end = pts.at(-1);
  assert.ok(Math.abs(end.mid - path(close)) < 1e-6 && end.hi90 > end.hi50 && end.hi50 > end.mid && end.mid > end.lo50 && end.lo50 > end.lo90);
  assert.ok(summary.pAbove > 0.5, 'leaning up: more likely above the target than not');
  assert.equal(marketCone({ path, spot: 100000, sigmaMin: 0.0008, now, close, strike: 100000, strikeType: 'less' }).summary.pYes, 1 - summary.pAbove);
  // the calibration factor widens it
  const wide = marketCone({ path, spot: 100000, sigmaMin: 0.0008, now, close, fix: 1.5 }).pts.at(-1);
  assert.ok(Math.abs((wide.hi90 - wide.mid) / (end.hi90 - end.mid) - 1.5) < 1e-9);
});
test('the cone leans the way the market has been moving: sharper drops widen the downside', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0), bars = [];
  let p = 1e5;
  for (let i = 60; i > 0; i--) { const r = i % 3 === 0 ? -0.0016 : 0.0008; const o = p; p *= Math.exp(r); bars.push({ t: now - i * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p }); }
  const sk = coneSkew(bars, now);
  assert.ok(sk.dn > sk.up, JSON.stringify(sk));
  const end = marketCone({ spot: p, sigmaMin: 0.0008, now, close: now + 600000, bars }).pts.at(-1);
  assert.ok(end.mid - end.lo90 > end.hi90 - end.mid);
});
test('split normal: symmetric is the normal; skew moves the odds', () => {
  assert.ok(Math.abs(splitAbove(100, 110, 10, 10) - (1 - ncdf(-1))) < 1e-9);
  assert.ok(Math.abs(splitAbove(120, 110, 10, 10) - (1 - ncdf(1))) < 1e-9);
  assert.ok(splitAbove(110, 110, 20, 10) > 0.5, 'more room above: above the centre is more likely');
});
test('the cone\'s record: band coverage, recalibration, and its odds vs Kalshi\'s', () => {
  // misses twice as wide as the cone said: it should widen
  const log = Array.from({ length: 60 }, (_, i) => { const z = ((i % 20) - 9.5) / 6; return { mid: 100, a: 10, b: 10, actual: 100 + 2 * 10 * z, strike: 100, pAbove: 0.5, kAbove: 0.5 }; });
  const r = coneRecord(log);
  assert.equal(r.n, 60); assert.ok(r.in90 < 0.9 && r.fix > 1.2, JSON.stringify(r));
  assert.equal(coneRecord(log.slice(0, 5)).fix, 1, 'too few rounds: no change');
  assert.ok(Math.abs(r.brierSame - 0.25) < 1e-9 && Math.abs(r.brierKalshi - 0.25) < 1e-9);
  assert.deepEqual(coneRecord([]), { n: 0, fix: 1 });
});

test('the new lines: the bot\'s own odds, the guide, the micro model and the move model each become a close; "no change" rides along hidden', () => {
  const now = Date.UTC(2026, 0, 1, 12, 5), close = now + 10 * 60000;
  const base = { spot: 100000, sigmaMin: 0.0008, now, close, strike: 100000 };
  const key = (ls, k) => ls.find((l) => l.key === k);
  const bot = key(predictionLines({ ...base, pBot: 0.7 }), 'bot'), lessBot = key(predictionLines({ ...base, pBot: 0.7, strikeType: 'less' }), 'bot');
  assert.ok(bot.end > 100000 && Math.abs(Math.log(bot.end / 100000) + Math.log(lessBot.end / 100000)) < 1e-12, 'a "below" market\'s YES odds flip');
  assert.ok(key(predictionLines({ ...base, guide: { pUp: 0.3 } }), 'guide').end < 100000);
  const micro = { at: now, horizons: { 1: { move: 10 }, 3: { move: 20 }, 5: { move: 25 } } };
  assert.ok(Math.abs(key(predictionLines({ ...base, micro }), 'micro').end - 100025) < 1e-6, 'the micro model\'s push over the next 5 minutes');
  assert.equal(key(predictionLines({ ...base, micro: { at: now, horizons: {} } }), 'micro'), undefined, 'nothing proven, no line');
  const cm = { at: now, moves: [[0, 0], [5, 40], [15, 40]] };
  assert.ok(Math.abs(key(predictionLines({ ...base, cm }), 'moves').end - 100040) < 1e-6, 'the move model\'s proven move to the close');
  assert.equal(key(predictionLines({ ...base, cm: { at: now, moves: [[0, 0], [15, 0]] } }), 'moves'), undefined, 'no proven move, no line');
  const still = key(predictionLines(base), 'still');
  assert.ok(still.hidden && still.end === 100000 && still.pts.every((p) => p.v === 100000));
});

test('the blend: minimum-variance weights from the error covariance, biases removed, "no change" only once it has a record', () => {
  // hand-made errors: a and b share a common miss (they miss together), c is independent
  const errs = Array.from({ length: 400 }, (_, i) => { const r = (k) => Math.sin(i * k) * 100; return { a: r(1.3) + r(2.9), b: r(1.3) + 0.5 * r(4.1), c: r(5.3) }; });
  const mv = (i) => Math.sin(i * 0.7) * 150; // where BTC really went from the price at the call
  const log = errs.map((e, i) => ({ closeTime: String(i), spot: 1e5, actual: 1e5 + mv(i), a: 1e5 + mv(i) + e.a + 30, b: 1e5 + mv(i) + e.b, c: 1e5 + mv(i) + e.c }));
  const fit = blendFit(log);
  // by hand: each line's move scaled (its least-squares slope on the real move, shrunk toward 1 by 20 rounds' worth),
  // then M (bias removed, shrunk off the diagonal), then w = M^-1 1 / (1' M^-1 1) on the lines kept (non-negative)
  const keys = ['a', 'b', 'c', 'still'], n = log.length, bias = {}, scale = {}, val = {};
  for (const k of keys) {
    const x = log.map((e) => (k === 'still' ? e.spot : e[k]) - e.spot), y = log.map((e) => e.actual - e.spot), mx = x.reduce((t, v) => t + v, 0) / n, my = y.reduce((t, v) => t + v, 0) / n;
    const sxx = x.reduce((t, v) => t + (v - mx) ** 2, 0), sxy = x.reduce((t, v, i) => t + (v - mx) * (y[i] - my), 0), c = 20 * sxx / n;
    scale[k] = k === 'still' ? 1 : (sxy + c) / (sxx + c);
    val[k] = log.map((e, i) => e.spot + scale[k] * x[i]);
  }
  for (const k of ['a', 'b', 'c']) assert.ok(Math.abs(fit.scale[k] - scale[k]) < 1e-9 && scale[k] > 0.5 && scale[k] < 1, `scale ${k}: ${fit.scale[k]}`);
  for (const k of keys) { const xs = log.map((e, i) => val[k][i] - e.actual); bias[k] = xs.reduce((t, x) => t + x, 0) / n * (n / (n + 60)); }
  const s0 = Math.sqrt(log.reduce((t, e) => t + (e.spot - e.actual) ** 2, 0) / n); // older rounds have no logged typical move: "no change"'s spread stands in; biases come back in those units
  for (const k of keys) assert.ok(Math.abs(fit.bias[k] * s0 - bias[k]) < 1e-9, `bias ${k}`);
  assert.ok(bias.a > scale.a * 30 * 0.8 && bias.a < scale.a * 30 * 1.2, 'a\'s +$30 bias is measured (on its scaled move)');
  const lam = 20 / (n + 20), E = log.map((e, i) => keys.map((k) => val[k][i] - e.actual - bias[k]));
  const M = keys.map((_, i) => keys.map((_, j) => E.reduce((s, r) => s + r[i] * r[j], 0) / n * (i === j ? 1 : 1 - lam)));
  const solve = (A, y) => { const m = A.map((r, i) => [...r, y[i]]), N = y.length; for (let c = 0; c < N; c++) { for (let r = 0; r < N; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k <= N; k++) m[r][k] -= f * m[c][k]; } } return m.map((r, i) => r[N] / r[i]); };
  let act = [0, 1, 2, 3], w;
  for (;;) { const x = solve(act.map((i) => act.map((j) => M[i][j])), act.map(() => 1)), t = x.reduce((s, v) => s + v, 0), ws = x.map((v) => v / t), lo = ws.indexOf(Math.min(...ws)); if (ws[lo] >= 0) { w = Object.fromEntries(act.map((i, k) => [keys[i], ws[k]])); break; } act = act.filter((_, k) => k !== lo); }
  const wOpt = { ...w }, pull = 20 / (n + 20); for (const k of keys) w[k] = (1 - pull) * (w[k] ?? 0) + pull * (k === 'still' ? 0 : 1 / 3); // then pulled toward equal weights while the record is short
  const tot = keys.reduce((s, k) => s + fit.weights[k], 0);
  for (const k of keys) assert.ok(Math.abs(fit.weights[k] / tot - (w[k] ?? 0)) < 1e-9, `weight ${k}: ${fit.weights[k] / tot} vs ${w[k] ?? 0}`);
  assert.ok(Object.values(fit.weights).every((v) => v >= 0), 'never negative');
  // the optimum (before the pull) beats every single line and the equal-weight average on these errors (it minimises their variance)
  const mse = (ws) => E.reduce((s, r) => s + keys.reduce((a, k, i) => a + (ws[k] || 0) * r[i], 0) ** 2, 0) / n;
  const best = mse(wOpt);
  for (const k of keys) assert.ok(best <= mse({ [k]: 1 }) + 1e-9, `beats ${k} alone`);
  assert.ok(best <= mse({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }));
  // lines that miss together share weight: copying a line can't double its say
  const twin = blendFit(log.map((e) => ({ ...e, a2: e.a }))), t2 = Object.values(twin.weights).reduce((s, v) => s + v, 0);
  const pair = (twin.weights.a + twin.weights.a2) / t2 - pull * 2 / 4, alone = fit.weights.a / tot - pull / 3;
  assert.ok(Math.abs(pair / alone - 1) < 0.1, `a and its copy share a's optimal share (the pull toward equal weights aside): ${pair} vs ${alone}`);
  // too few rounds: everything an average line, and "no change" left out until it has a record
  const short = blendFit(log.slice(0, 4));
  assert.deepEqual(short.known, []); assert.equal(short.weights.a, 1); assert.equal(short.weights.still, 0);
  assert.deepEqual(blendFit([]).weights, { still: 0 });
  // the bias correction: full at the close, none now
  const now = 0, close = 600000, line = { key: 'a', end: 100030, pts: [{ t: 0, v: 1e5 }, { t: 300000, v: 100015 }, { t: 600000, v: 100030 }, { t: 900000, v: 100030 }] };
  const [c] = correctLines([line], { a: 30 }, now, close);
  assert.deepEqual(c.pts.map((p) => p.v), [1e5, 1e5, 1e5, 1e5]); assert.equal(c.end, 1e5);
});

// ---------- v13: every minute, per stretch of the round ----------
import { blendSamples, blendScore, blendBand, BLEND } from '../public/predict.js';
test('every logged minute is a graded sample, its misses in typical moves; older rounds use "no change"\'s spread', () => {
  const log = [
    { closeTime: 'r1', actual: 100, cps: { 10: { sd: 20, still: 110, kalshi: 90, blend: 95 }, 2: { sd: 5, still: 102, kalshi: 101, blend: 101 } } },
    { closeTime: 'r0', at: 1, spot: 104, actual: 100, kalshi: 98 },
    { closeTime: 'r2', at: 1, spot: 96, actual: 100, kalshi: 101 },
    { closeTime: 'r3', actual: null, cps: { 5: { sd: 9, still: 1 } } },
  ];
  const ss = blendSamples(log), by = (r, m) => ss.find((x) => x.r === r && x.m === m).z;
  assert.equal(ss.length, 4, 'two minutes of r1 + one each for the two older rounds; ungraded skipped');
  assert.deepEqual(by('r1', 10), { still: 0.5, kalshi: -0.5 }); assert.deepEqual(by('r1', 2), { still: 0.4, kalshi: 0.2 });
  assert.deepEqual(by('r0', 5), { kalshi: -0.5, still: 1 }, 'older: miss / 4 (no change missed by $4 both times)');
  assert.deepEqual([1, 3, 4, 7, 8, 14, 0.2, 30].map(blendBand), [0, 0, 1, 1, 2, 2, 0, 2]);
  assert.equal(predictionRecord(log).rounds, 2, 'the card\'s 5-minute record skips rounds with no 5-minute call');
});
test('the blend is fitted per stretch of the round: the line that\'s best late leads late, the one best early leads early', () => {
  let x = 7; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; };
  const log = Array.from({ length: 200 }, (_, i) => {
    const cps = {};
    for (let m = 1; m <= 14; m++) { const late = m <= 3; cps[m] = { sd: 10, still: 100 + 20 * rnd(), early: 100 + (late ? 30 : 3) * rnd(), late: 100 + (late ? 3 : 30) * rnd() }; }
    return { closeTime: String(i), actual: 100, cps };
  });
  const share = (f, k) => f.weights[k] / Object.values(f.weights).reduce((a, b) => a + b, 0);
  const lateFit = blendFit(log, 2), earlyFit = blendFit(log, 12), all = blendFit(log);
  assert.ok(share(lateFit, 'late') > 0.85 && share(earlyFit, 'early') > 0.85, `${share(lateFit, 'late')} ${share(earlyFit, 'early')}`);
  assert.ok(share(all, 'early') > share(lateFit, 'early') && share(all, 'late') > share(earlyFit, 'late'), 'the all-minutes fit sits between');
  // a stretch with few rounds of its own stays close to the all-minutes fit
  const thin = log.map((e, i) => ({ ...e, cps: Object.fromEntries(Object.entries(e.cps).filter(([m]) => i < 3 || +m >= 4)) }));
  const t = blendFit(thin, 2), a = blendFit(thin);
  assert.ok(Math.abs(share(t, 'late') - share(a, 'late')) < Math.abs(share(blendFit(log, 2), 'late') - share(a, 'late')), 'pulled toward the pooled fit');
  assert.equal(BLEND.pool, 30);
});
test('the blend scoreboard: its own logged close vs "no change" and the best single line on the same calls', () => {
  const log = [
    { closeTime: 'a', actual: 100, cps: { 3: { sd: 5, still: 110, kalshi: 104, exch: 120, blend: 103 }, 2: { sd: 4, still: 106, kalshi: 98, blend: 101 } } },
    { closeTime: 'b', actual: 200, cps: { 9: { sd: 9, still: 190, kalshi: 210, blend: 196 } } },
    { closeTime: 'c', actual: null, cps: { 4: { sd: 5, still: 1, blend: 1 } } },
  ];
  const sc = blendScore(log);
  assert.deepEqual({ n: sc.n, rounds: sc.rounds }, { n: 3, rounds: 2 });
  assert.equal(sc.blend, (3 + 1 + 4) / 3); assert.equal(sc.still, (10 + 6 + 10) / 3);
  assert.deepEqual(sc.best, { key: 'kalshi', miss: (4 + 2 + 10) / 3, blend: 8 / 3, n: 3 }, 'exch (drawn once in three) isn\'t compared');
  assert.deepEqual(blendScore([]), { n: 0 });
});

// ---------- v13.1: each line's moves scaled to how far they really carry ----------
import { scaleLines, expectedPath, SCALE } from '../public/predict.js';
test('each line\'s move scale: an overshooting line is pulled in, a timid one stretched (to at most 2x), pure noise collapses onto "no change"', () => {
  let x = 3; const g = () => { let t = 0; for (let k = 0; k < 12; k++) { x = (x * 1103515245 + 12345) % 2147483648; t += x / 2147483648; } return t - 6; };
  const n = 400, log = Array.from({ length: n }, (_, i) => {
    const y = g(); // the real move to the close, in typical moves (sd 10)
    return { closeTime: String(i), actual: 100 + 10 * y, cps: { 5: { sd: 10, still: 100, over: 100 + 20 * y, timid: 100 + 2.5 * y, noise: 100 + 10 * g() } } };
  });
  const sc = blendFit(log).scale, shrink = (b) => (b + SCALE.prior / n) / (1 + SCALE.prior / n); // exact slope b, shrunk toward 1 by 20 rounds' worth
  assert.ok(Math.abs(sc.over - shrink(0.5)) < 1e-9, `over ${sc.over}`);
  assert.equal(sc.timid, SCALE.hi, 'a 4x-too-timid line is stretched to the cap');
  assert.ok(sc.noise < 0.15, `noise ${sc.noise}`);
  assert.equal(blendFit(log.slice(0, 1)).scale.over > 0.9, true, 'one round: barely moved from 1');
  // the chart's lines: moves from the price scaled, the whole line
  const [l] = scaleLines([{ key: 'over', end: 100040, pts: [{ t: 0, v: 100000 }, { t: 1, v: 100040 }, { t: 2, v: 100060 }] }], { over: 0.5 }, 100000);
  assert.deepEqual([l.end, ...l.pts.map((p) => p.v)], [100020, 100000, 100020, 100030]);
  assert.deepEqual(scaleLines([{ key: 'k', end: 5, pts: [] }], {}, 1)[0].end, 5, 'no scale yet: unchanged');
});
test('the blend\'s own scale: averaging lines each shrunk on their own is too timid, so the blended move is stretched', () => {
  let x = 9; const g = () => { let t = 0; for (let k = 0; k < 12; k++) { x = (x * 1103515245 + 12345) % 2147483648; t += x / 2147483648; } return t - 6; };
  // two lines, each the real move plus its own independent noise of the same size: alone each is worth half its move;
  // their average cancels half the noise, so it's worth 2/3 of its move: 4/3 of the two halves averaged
  const log = Array.from({ length: 2000 }, (_, i) => { const y = g(); return { closeTime: String(i), actual: 100 + 10 * y, cps: { 5: { sd: 10, still: 100, p: 100 + 10 * (y + g()), q: 100 + 10 * (y + g()) } } }; });
  const f = blendFit(log);
  assert.ok(Math.abs(f.scale.p - 0.5) < 0.05 && Math.abs(f.scale.q - 0.5) < 0.05, `${f.scale.p} ${f.scale.q}`);
  assert.ok(Math.abs(f.final - 4 / 3) < 0.1, `final ${f.final}`);
  // the expected path multiplies the blended move (not the flip forecast) by it
  const lines = [{ key: 'p', pts: [{ t: 0, v: 100 }, { t: 60000, v: 110 }] }];
  assert.equal(expectedPath({ lines, spot: 100, now: 0, final: 1.5 })(60000), 115);
  assert.equal(expectedPath({ lines, spot: 100, now: 0, final: 1.5, beta: 0.5 })(60000), 107.5);
});

test('the path is judged on the move it predicted from the real open, next to "no change" from that open (v13.27)', async () => {
  const { pathRecord } = await import('../public/predict.js');
  // the path was priced $30 above where the minute really opened (set 15 s early): the level gap isn't its move's error
  const log = [{ o: 100030, c: 100040, open: 100000, actual: 100010, beta: 1 }, { o: 99970, c: 99960, open: 100000, actual: 99990, beta: 1 }];
  const r = pathRecord(log);
  assert.equal(r.miss, 0, 'both moves were exactly right'); assert.equal(r.still, 10); assert.equal(r.right, 2);
});
