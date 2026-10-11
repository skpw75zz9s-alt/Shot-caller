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
  const lines = predictionLines({ spot: 100000, sigmaMin: 0.0005, driftMin: 0.01, now, close, strike: 100000, yesMid: 0.99, trades: [] });
  assert.deepEqual(lines.map((l) => l.key), ['bot', 'kalshi']);
  const sd = 100000 * 0.0005 * Math.sqrt(8);
  for (const l of lines) { assert.ok(Math.abs(l.end - 100000) <= 1.645 * sd + 1e-6); assert.equal(l.pts.at(-1).t, close); }
});

test('record: average miss per line vs no change', () => {
  const r = predictionRecord([{ actual: 100, bot: 90, kalshi: 104, spot: 80 }, { actual: 200, bot: 210, kalshi: 200, spot: 200 }, { actual: null, bot: 1 }]);
  assert.equal(r.rounds, 2); assert.equal(r.bot.miss, 10); assert.equal(r.kalshi.miss, 2); assert.equal(r.still.miss, 10); assert.equal(r.exch, null);
});

// ---------- the expected path, minute by minute ----------
import { blendWeights, pathMinutes, pathRecord } from '../public/predict.js';
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
  const w = blendWeights({ bot: { miss: 60, n: 10 }, kalshi: { miss: 20, n: 10 }, exch: null });
  assert.ok(w.kalshi > w.bot * 8);
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
  const base = { spot: 100060, sigmaMin: 0.0008, now, close, strike: 100000, yesMid: 0.7, strikeType: 'greater', trades };
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
