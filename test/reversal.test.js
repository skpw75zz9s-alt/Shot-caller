import test from 'node:test';
import assert from 'node:assert/strict';
import { bandProven, bandStudy, checklist, flipBacktest, prep, reversalNow, reversalShift, to15 } from '../public/reversal.js';
import { flipForecast } from '../public/flip.js';
import { createPlaybook } from '../playbookfeed.js';

function expand(c15, t0 = Date.UTC(2026, 0, 5)) {
  const bars = []; let prev = c15[0].o;
  c15.forEach((c, i) => {
    const bear = c.c < c.o, pts = [c.o, bear ? c.h : c.l, bear ? c.l : c.h, c.c];
    for (let m = 0; m < 15; m++) {
      const seg = Math.min(2, Math.floor(m / 5)), f = ((m % 5) + 1) / 5, p = pts[seg] + (pts[seg + 1] - pts[seg]) * f;
      const o = m ? prev : c.o; bars.push({ t: t0 + i * 900000 + m * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: c.v / 15 }); prev = p;
    }
  });
  return bars;
}
// a 15-minute uptrend with clear swings, then the guide's DOWN flip: sweep above the last high and close back below
// (RSI lower: the sweep candle is a weak one), a close below the higher low, a rejected retest, then a fall
function downFlip() {
  const c = []; let p = 80000;
  const push = (o, h, l, cl, v = 10) => { c.push({ o, h, l, c: cl, v }); p = cl; };
  for (let i = 0; i < 44; i++) { const up = i % 6 < 4, d = up ? 45 : -35; push(p, Math.max(p, p + d) + 8, Math.min(p, p + d) - 8, p + d); }
  for (let k = 0; k < 3; k++) push(p, p + 70 + 8, p - 8, p + 70); // a strong leg up to the high H (RSI high)
  const H = c.at(-1).h;
  push(p, p + 5, p - 60, p - 55); push(p, p + 5, p - 50, p - 45);  // pullback: the higher low L
  const L = c.at(-1).l;
  push(p, p + 40, p - 2, p + 35); push(p, p + 30, p - 2, p + 25);  // a weaker rally, under H
  push(p, H + 30, p - 10, H - 20, 40);                              // the sweep: above H, closed back below, 4x volume, small body
  push(p, p + 5, L - 40, L - 30);                                   // structure break: closed below L
  push(p, L + 10, p - 5, L - 15);                                   // retest of L, rejected
  for (let k = 0; k < 30; k++) push(p, p + 5, p - 45, p - 40);       // the fall
  return { c15: c, H, L };
}
// the mirror image: an UP flip after a fall
const mirror = (c15) => c15.map((c) => ({ o: 160000 - c.o, h: 160000 - c.l, l: 160000 - c.h, c: 160000 - c.c, v: c.v }));

test('15-minute candles from 1-minute ones, clock-aligned, with the day\'s VWAP at each close', () => {
  const bars = expand([{ o: 100, h: 110, l: 95, c: 105, v: 15 }, { o: 105, h: 108, l: 100, c: 101, v: 30 }]);
  const B = to15(bars);
  assert.equal(B.length, 2);
  assert.deepEqual([B[0].o, B[0].h, B[0].l, B[0].c], [100, 110, 95, 105]);
  assert.ok(Math.abs(B[0].v - 15) < 1e-9 && B[1].vwap > 95 && B[1].vwap < 110);
  assert.equal(to15(bars, bars[20].t).length, 1, 'the unfinished candle is left out');
});

test('the guide\'s DOWN flip scores strong: sweep + reclaim 3, structure break 3, RSI divergence 2, volume 1', () => {
  const { c15, H, L } = downFlip(), P = prep(to15(expand(c15)));
  const c = checklist(P, 52, -1);
  assert.equal(c.dir, 'down'); assert.equal(c.level, H); assert.equal(c.broken, L);
  const ok = Object.fromEntries(c.checks.map((x) => [x.key, x.ok]));
  assert.deepEqual([ok.sweep, ok.mss, ok.rsiDiv, ok.volume], [true, true, true, true]);
  assert.ok(c.score >= 9 && c.band === 'strong', `score ${c.score}`);
  assert.ok(checklist(P, 52, 1).score <= 4, 'and nothing for an UP flip');
  // before the sweep: nothing
  assert.ok(checklist(P, 49, -1).score < 5);
});

test('the open-interest point counts live only, for a flush into the move', () => {
  const { c15 } = downFlip(), bars = expand(c15), at = bars[52 * 15 + 14].t + 60000;
  const cut = bars.filter((b) => b.t < at);
  const a = reversalNow(cut, { now: at }), b = reversalNow(cut, { now: at, oi: { oiChange5: -0.008, priceChange5: 0.003 } });
  assert.equal(a.max, 10); assert.equal(b.max, 11);
  assert.equal(b.down.score, a.down.score + 1);
  assert.equal(reversalNow(cut, { now: at, oi: { oiChange5: 0.008, priceChange5: 0.003 } }).down.score, a.down.score, 'open interest rising is not a flush');
  assert.equal(a.best.dir, 'down');
});

test('the flip strategy: waits for the break and a rejected retest, stops beyond the sweep, books 2R less costs', () => {
  const { c15, H, L } = downFlip(), tr = flipBacktest(expand(c15));
  assert.equal(tr.length, 1);
  const t = tr[0];
  assert.equal(t.dir, 'down'); assert.ok(t.entry < L && t.stop > H + 30, 'entry after the retest, stop beyond the sweep extreme');
  assert.ok(t.won && Math.abs(t.r - (2 - t.fees)) < 1e-9 && t.fees > 0);
  // the mirror image works the same way up
  const up = flipBacktest(expand(mirror(c15)));
  assert.equal(up.length, 1); assert.equal(up[0].dir, 'up'); assert.ok(up[0].won);
  // without the retest there's no trade (no chasing)
  const noRetest = c15.map((c) => ({ ...c })); noRetest[53] = { o: noRetest[52].c, h: noRetest[52].c + 5, l: noRetest[52].c - 60, c: noRetest[52].c - 55, v: 10 };
  for (let i = 54; i < noRetest.length; i++) { const p = noRetest[i - 1].c; noRetest[i] = { o: p, h: p + 5, l: p - 45, c: p - 40, v: 10 }; }
  assert.equal(flipBacktest(expand(noRetest)).length, 0);
});

test('pure noise: no score band calls the next round better than a coin flip', () => {
  let s = 5; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32), g = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const bars = []; let p = 80000;
  for (let i = 0; i < 14 * 1440; i++) { const o = p; p *= Math.exp(0.0008 * g()); bars.push({ t: Date.UTC(2026, 0, 1) + i * 60000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 + rnd() }); }
  const st = bandStudy(bars);
  assert.ok(st.insufficient.n > 500);
  for (const k of ['insufficient', 'developing', 'strong']) assert.equal(bandProven(st[k]), false, `${k} z ${st[k].z15}`);
});

test('the call nudge: only a proven band, only for the round right after its signal, capped at 4 points', () => {
  const now = { at: 1000, sd15: 0.003, best: { dir: 'down', band: 'strong' } };
  const study = { strong: { n: 300, z15: 3.1, mean15: 0.4 } }, m = { spot: 80000, strike: 80000, sigmaMin: 0.0008, minutesLeft: 12, openTime: 1000 };
  const v = reversalShift(now, study, m);
  assert.ok(v < 0 && v >= -0.04, String(v));
  assert.equal(reversalShift(now, study, { ...m, strikeType: 'less' }), -v);
  assert.equal(reversalShift(now, study, { ...m, openTime: 1000 + 900000 }), 0, 'a later round: no');
  assert.equal(reversalShift(now, { strong: { n: 300, z15: 1.5, mean15: 0.4 } }, m), 0, 'unproven: no');
});

test('the flip forecast counts a 5+ checklist for a flip its way', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: 1e12 + i * 60000, o: 80000 + i * 10, h: 80005 + i * 10, l: 79995 + i * 10, c: 80000 + i * 10 }));
  const base = { bars, spot: 80400, sigmaMin: 0.0008, now: 1e12 + 40 * 60000 };
  const a = flipForecast(base), b = flipForecast({ ...base, reversal: { max: 10, down: { score: 9 }, up: { score: 0 } } });
  assert.equal(a.dir, 'down');
  assert.ok(b.score > a.score && b.parts.some((x) => x.name === 'Checklist'));
  assert.equal(flipForecast({ ...base, reversal: { max: 10, down: { score: 4 }, up: { score: 9 } } }).score, a.score, 'a checklist for the other way, or under 5, adds nothing');
});

test('playbook feed: reports the reversal study and serves the live checklist', async () => {
  const { c15 } = downFlip(), bars = expand(c15), end = bars.at(-1).t + 60000;
  const pb = createPlaybook({ coinbase: 'x', file: '/nonexistent/dir/bars.json', fetchJSON: async () => [], clock: () => end, log: { error() {}, warn() {} } });
  pb.merge(bars); pb.rerun();
  const api = pb.api();
  assert.equal(api.report.reversal.full.n, 1);
  assert.ok(['strong', 'developing', 'insufficient'].every((k) => 'hit15' in api.report.reversal.bands[k]));
  assert.ok(api.reversal && api.reversal.max === 10);
  pb.observe({ snap: { spot: 80000, sigmaMin: 0.0008, live: { m: { ticker: 'T', strike_type: 'greater', open_time: new Date(end).toISOString() }, strike: 80000, ev: { minutesLeft: 10 } } } });
  assert.equal(pb.shifts(), null, 'no proven band: no nudge');
});
