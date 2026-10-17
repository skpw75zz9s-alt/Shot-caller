import test from 'node:test';
import assert from 'node:assert/strict';
import { cushionHistory, cushionRead, cushionTable, pressureAgreement, sessions, settlementWatch, span } from '../public/settle.js';
import { normCdf } from '../public/model.js';

const T0 = Date.UTC(2026, 9, 1), MIN = 60000;

test('the cushion: the lead next to the move left, and the words for it', () => {
  const c = cushionRead({ price: 81188.67, strike: 81209.08, sigmaMin: 0.0003, minutesLeft: 0.5 });
  assert.ok(c.lead < 0 && !c.up); assert.ok(Math.abs(c.move - 81188.67 * 0.0003 * Math.sqrt(0.5)) < 1e-9);
  assert.equal(c.word, c.ratio < 0.75 ? 'thin' : 'solid'); assert.ok(Math.abs(c.mathWin - normCdf(c.ratio)) < 1e-12);
  assert.equal(cushionRead({ price: 100001, strike: 100000, sigmaMin: 0.001, minutesLeft: 9 }).razor, true);
  assert.equal(cushionRead({ price: 101000, strike: 100000, sigmaMin: 0.0005, minutesLeft: 4 }).word, 'near-certain');
});

test('history at each cushion: on a fair walk the leader wins about as often as the math says, more with more cushion', () => {
  let s = 9; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32; let p = 100000; const bars = [];
  for (let i = 0; i < 40000; i++) { const o = p; p *= Math.exp(0.0008 * Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r())); bars.push({ t: T0 + i * MIN, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 }); }
  const t = cushionTable(bars);
  assert.ok(t.rounds > 2500);
  const thin = cushionHistory(t, 0.1, 5), solid = cushionHistory(t, 1.2, 5), strong = cushionHistory(t, 2.5, 5);
  assert.ok(thin && solid && strong);
  assert.ok(thin.rate > 0.45 && thin.rate < 0.62, JSON.stringify(thin)); assert.ok(solid.rate > thin.rate && strong.rate > solid.rate);
  assert.ok(strong.rate > 0.93);
  assert.equal(cushionHistory(t, 0.1, 5).n >= 30, true);
  assert.equal(cushionHistory(JSON.parse(JSON.stringify(t)), 10, 2).rate > 0.95, true, 'survives JSON (Infinity -> null)');
});

test('settlement watch: seconds banked in the 60-second average, what a flip needs, and the arithmetic lock', () => {
  const close = T0 + 15 * MIN, now = close - 22000; // 38 s banked
  const prints = Array.from({ length: 19 }, (_, i) => ({ t: close - 60000 + i * 2000, s: 81188 }));
  const w = settlementWatch({ prints, close, spot: 81188, strike: 81209, sigmaMin: 0.0003, now });
  assert.equal(w.banked, 38); assert.equal(w.left, 22);
  assert.ok(Math.abs(w.proj - 81188) < 1e-6 && w.lead < 0);
  assert.ok(Math.abs(w.need - (60 * 81209 - 81188 * 38) / 22) < 1e-6, 'the seconds left must average this');
  assert.ok(w.need > 81209 + 30 && w.locked, `${w.need} ${w.sigmas}`);
  const close2 = settlementWatch({ prints, close, spot: 81205, strike: 81209, sigmaMin: 0.0003, now: close - 55000 });
  assert.equal(close2.locked, false, 'with 55 s left and $4 to go, nothing is locked');
  assert.equal(settlementWatch({ prints, close, spot: 81188, strike: 81209, sigmaMin: 0.0003, now: close - 90000 }), null, 'only in the last minute');
});

test('pressure against the leader: how often the leader still won', () => {
  const ss = [{ y: 1, lean: 'NO', pModel: 0.8 }, { y: 1, lean: 'NO', pModel: 0.8 }, { y: 0, lean: 'NO', pModel: 0.8 }, { y: 1, lean: 'YES', pModel: 0.7 }, { y: null, lean: 'YES', pModel: 0.7 }, { y: 0, lean: null, pModel: 0.3 }];
  assert.deepEqual(pressureAgreement(ss), { agree: { n: 1, won: 1 }, disagree: { n: 3, won: 2 } });
});

test('sessions: London is open on a Wednesday at noon UTC, Tokyo is not; nothing opens on a Saturday', () => {
  const wed = sessions(Date.UTC(2026, 9, 14, 12, 0));
  const by = Object.fromEntries(wed.map((x) => [x.name, x]));
  assert.equal(by.London.open, true); assert.equal(by['New York'].open, true); assert.equal(by.Tokyo.open, false);
  assert.ok(by.London.closesIn > 0 && by.Tokyo.opensIn > 0);
  assert.ok(sessions(Date.UTC(2026, 9, 17, 15, 0)).every((x) => !x.open));
  assert.equal(span(125 * MIN), '2h 5m'); assert.equal(span(30 * 3600000), '1d 6h');
});
