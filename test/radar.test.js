import test from 'node:test';
import assert from 'node:assert/strict';
import { RADAR, closeScores, conformal, radarRead, radarRecord } from '../public/radar.js';

const rng = (seed) => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

test('the conformal threshold: the ceil((n+1) x 0.9)-th smallest score; too few scores, none', () => {
  assert.equal(conformal([5, 1, 4, 2, 3, 9, 8, 7, 6]), 9, 'n = 9: the 9th smallest (ceil(10 x 0.9) = 9)');
  assert.equal(conformal([1, 2, 3, 4, 5, 6, 7, 8]), null, 'n = 8: ceil(9 x 0.9) = 9 > 8, no guarantee possible');
  assert.equal(conformal(Array.from({ length: 99 }, (_, i) => i + 1)), 90, 'n = 99: the 90th');
  assert.equal(RADAR.level, 0.9);
});

test('coverage: on fresh rounds the floor, ceiling and range each hold at least 90% (heavy tails and skew included)', () => {
  const u = rng(42), g = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  const draw = () => { const z = g(); return u() < 0.1 ? 3 * z : z + 0.3 * (z * z - 1); }; // fat tails and skew: not normal
  let hits = { f: 0, c: 0, r: 0 }, n = 0;
  for (let trial = 0; trial < 400; trial++) {
    const log = Array.from({ length: 30 }, (_, i) => ({ closeTime: String(i), actual: 100 + 10 * draw(), cps: { 5: { sd: 10, blend: 100 } } }));
    const rd = radarRead({ log, expected: 100, sd: 10, mins: 5, target: 100 });
    for (let k = 0; k < 25; k++) { const a = 100 + 10 * draw(); n++; if (a >= rd.floor) hits.f++; if (a <= rd.ceil) hits.c++; if (a >= rd.lo && a <= rd.hi) hits.r++; }
  }
  for (const [k, h] of Object.entries(hits)) assert.ok(h / n >= 0.9, `${k}: ${(h / n).toFixed(4)}`);
});

test('a direction call only when the floor (ceiling) clears the target; otherwise how far short it is', () => {
  const log = Array.from({ length: 99 }, (_, i) => ({ closeTime: String(i), actual: 100 + (i - 49), cps: { 5: { sd: 1, blend: 100 } } })); // scores -49..49
  const up = radarRead({ log, expected: 200, sd: 1, mins: 5, target: 150 });
  assert.equal(up.dir, 'UP'); assert.equal(up.floor, 200 - conformal(closeScores(log).map((s) => -s.d)));
  const dn = radarRead({ log, expected: 50, sd: 1, mins: 5, target: 100 });
  assert.equal(dn.dir, 'DOWN');
  const none = radarRead({ log, expected: 110, sd: 1, mins: 5, target: 100 });
  assert.equal(none.dir, null); assert.equal(none.need, 100 - none.floor); assert.ok(none.need > 0);
  assert.ok(none.sure && none.n === 99);
});

test('before 9 graded minutes it falls back to the normal curve\'s 90% points and says it isn\'t guaranteed yet', () => {
  const rd = radarRead({ log: [], expected: 100, sd: 10, mins: 5, target: 90, next: { t: 1, c: 100, sd: 2 } });
  assert.equal(rd.sure, false);
  assert.ok(Math.abs(rd.floor - (100 - 12.815515655446004)) < 1e-9 && Math.abs(rd.hi - (100 + 16.448536269514722)) < 1e-9);
  assert.equal(rd.dir, null, 'a 90% floor of 87.2 doesn\'t clear 90');
  assert.ok(Math.abs(rd.next.hi - (100 + 2 * 1.6448536269514722)) < 1e-9 && rd.next.sure === false);
  assert.equal(radarRead({ log: [], expected: NaN, sd: 1, mins: 5 }), null);
});

test('scores come from this stretch of the round once it has 30, else every minute', () => {
  const mk = (n, m, d) => Array.from({ length: n }, (_, i) => ({ closeTime: `${m}-${i}`, actual: 100 + d * ((i % 10) - 4.5), cps: { [m]: { sd: 1, blend: 100 } } }));
  const late = mk(40, 2, 1), early = mk(40, 12, 10);
  const r2 = radarRead({ log: [...late, ...early], expected: 100, sd: 1, mins: 2 }), r12 = radarRead({ log: [...late, ...early], expected: 100, sd: 1, mins: 12 });
  assert.ok(r2.stretch && r12.stretch && r2.hi - r2.lo < r12.hi - r12.lo, 'late misses are smaller here, so the late range is narrower');
  const thin = radarRead({ log: [...mk(10, 2, 1), ...early], expected: 100, sd: 1, mins: 2 });
  assert.equal(thin.stretch, false); assert.equal(thin.n, 50);
});

test('the radar record grades every logged call at the close', () => {
  const log = [
    { closeTime: 'a', actual: 105, cps: { 5: { sd: 1, blend: 100, r: { f: 95, c: 104, l: 96, h: 106, d: 'UP', tg: 90 } }, 3: { sd: 1, blend: 100, r: { f: 106, c: 110, l: 99, h: 101, d: null, tg: 90 } } } },
    { closeTime: 'b', actual: null, cps: { 5: { r: { f: 0, c: 0, l: 0, h: 0, d: 'UP', tg: 1 } } } },
  ];
  const pc = [{ actual: 10, lo: 9, hi: 11 }, { actual: 12, lo: 9, hi: 11 }, { actual: null, lo: 1, hi: 2 }, { actual: 5 }];
  const r = radarRecord(log, pc);
  assert.deepEqual(r.floor, { n: 2, hit: 1, rate: 0.5 }); assert.deepEqual(r.ceil, { n: 2, hit: 1, rate: 0.5 });
  assert.deepEqual(r.range, { n: 2, hit: 1, rate: 0.5 }); assert.deepEqual(r.dir, { n: 1, hit: 1, rate: 1 });
  assert.deepEqual(r.next, { n: 2, hit: 1, rate: 0.5 });
});

test('the radar screen: prices run up the screen around the expected close, every exchange is a blip that flares with the beam', async () => {
  const { scopeLayout, scopeSvg, scopeIdle, blipTag, SCOPE } = await import('../public/radar.js');
  const rd = { expected: 100035, lo: 99955, hi: 100115, floor: 99980, ceil: 100090, target: 99990, dir: null, next: { lo: 100012, hi: 100058 } };
  const ven = [{ ex: 'Binance', price: 100031, net: 5 }, { ex: 'Kraken', price: 100029, net: -1 }, { ex: 'OKX perp', price: 100120, net: 0 }];
  const L = scopeLayout(rd, 100060, ven), c = SCOPE.size / 2;
  assert.equal(L.Y(rd.expected), c, 'the expected close is the centre');
  assert.ok(L.Y(rd.ceil) < c && L.Y(rd.floor) > c && L.Y(rd.target) > c, 'higher prices higher on the screen');
  assert.ok(Math.abs(L.rr - (L.Y(rd.lo) - c)) < 1e-9, 'the 90% range is a circle around the centre');
  for (const b of L.blips) assert.ok(Math.hypot(b.x - c, b.y - c) <= SCOPE.r + 1e-9, `${b.ex} stays on the screen`);
  for (const p of [rd.target, rd.lo, rd.hi, 100060]) assert.ok(Math.abs(L.Y(p) - c) <= SCOPE.r, 'everything fits inside the rings');
  const svg = scopeSvg(rd, 100060, ven, { phase: 1000 });
  assert.match(svg, /TARGET \$99,990/); assert.match(svg, /FLOOR \$99,980/); assert.match(svg, /CEILING \$100,090/); assert.match(svg, /NOW \$100,060/); assert.match(svg, /NO CALL/);
  assert.equal((svg.match(/animation-delay:-\d+ms/g) || []).length, 4, 'each blip and the price now are synced to the beam');
  for (const d of svg.match(/animation-delay:(-\d+)ms/g).map((x) => +x.match(/-\d+/)[0])) assert.ok(d <= 0 && d > -SCOPE.period);
  assert.ok(!scopeSvg(rd, 100060, ven).includes('animation-delay'), 'no beam phase, no sync');
  assert.match(scopeSvg({ ...rd, floor: 100000, dir: 'UP' }, 100060, ven), /UP · 90%\+/);
  assert.ok(!scopeSvg({ ...rd, target: 0 }, 100060, []).includes('TARGET'), 'no target, no line or zones');
  assert.equal(blipTag('Bybit perp'), 'BYB·P'); assert.equal(blipTag('Newex'), 'NEW');
  assert.match(scopeSvg(rd, 100060, [{ ex: '<x>', price: 100000, net: 0 }]), /&#60;x&#62;/, 'names are escaped');
  assert.match(scopeIdle(), /WAITING FOR A LIVE ROUND/);
});

test('the radar widens its bands until a walk-forward replay of its own rounds holds 90% (v13.27)', async () => {
  const { radarLevels, conformal, RADAR } = await import('../public/radar.js');
  let seed = 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  // BTC getting steadily wilder than the bot's volatility says: each round's misses share one shock
  const T0 = Date.UTC(2026, 9, 1), log = [];
  for (let i = 0; i < 300; i++) {
    const v = 1 + i / 150, z = gauss(), cps = {};
    for (let m = 1; m <= 14; m++) cps[m] = { sd: 1, blend: -v * (z + 0.3 * gauss()) };
    log.unshift({ closeTime: new Date(T0 + i * 900000).toISOString(), actual: 0, cps });
  }
  const held = { plain: [0, 0], leveled: [0, 0] };
  for (let i = 150; i < 300; i++) {
    const past = log.slice(300 - i), round = log[299 - i];
    const scores = past.flatMap((e) => Object.values(e.cps).map((c) => (e.actual - c.blend) / c.sd)), L = radarLevels(past).floor.level;
    const qp = conformal(scores.map((d) => -d)), ql = conformal(scores.map((d) => -d), L);
    for (const c of Object.values(round.cps)) { const d = (round.actual - c.blend) / c.sd; held.plain[1]++; held.leveled[1]++; if (-d <= qp) held.plain[0]++; if (-d <= ql) held.leveled[0]++; }
  }
  const plain = held.plain[0] / held.plain[1], leveled = held.leveled[0] / held.leveled[1];
  assert.ok(plain < 0.88, `a plain 90% threshold falls short here (${plain.toFixed(3)})`);
  assert.ok(leveled > plain + 0.02 && leveled >= 0.88, `the replayed level holds far better (${leveled.toFixed(3)} vs ${plain.toFixed(3)})`);
  // a calm, steady market keeps the plain 90%
  const calm = [];
  for (let i = 0; i < 120; i++) { const z = gauss(), cps = {}; for (let m = 1; m <= 14; m++) cps[m] = { sd: 1, blend: -(z + 0.3 * gauss()) }; calm.unshift({ closeTime: new Date(T0 + i * 900000).toISOString(), actual: 0, cps }); }
  assert.ok(radarLevels(calm).range.level <= 0.92, 'no widening where 90% already holds');
  assert.equal(radarLevels(calm.slice(0, 15)).floor.level, RADAR.level, 'too few rounds to replay: plain 90%');
});

test('the radar fits every market: an XRP-sized read fills the screen like a Bitcoin one, with labels at its precision (v13.32)', async () => {
  const { scopeLayout, scopeSvg, SCOPE } = await import('../public/radar.js');
  const read = (E, sd) => ({ expected: E, floor: E - 1.28 * sd, ceil: E + 1.28 * sd, lo: E - 1.64 * sd, hi: E + 1.64 * sd, target: E - 0.5 * sd, dir: null, next: { lo: E - 0.3 * sd, hi: E + 0.3 * sd } });
  const btc = scopeLayout(read(100250, 60), 100240), xrp = scopeLayout(read(2.5123, 0.0021), 2.5119), doge = scopeLayout(read(0.18234, 0.00031), 0.18229);
  for (const L of [xrp, doge]) assert.ok(Math.abs(L.rr - btc.rr) < 0.5, `the 90% ring is the same size on screen (${L.rr.toFixed(1)} vs ${btc.rr.toFixed(1)} of ${SCOPE.r})`);
  assert.ok(xrp.rr > SCOPE.r * 0.5, 'not squashed to the centre');
  const svg = scopeSvg(read(2.5123, 0.0021), 2.5119);
  assert.match(svg, /CEILING \$2\.5150/); assert.match(svg, /TARGET \$2\.5113/); assert.match(svg, /NOW \$2\.5119/);
  assert.match(svg, /±\$0\.00\d+/, 'ring distances in fractions of a cent');
  assert.ok(!/CEILING \$3</.test(svg), 'no whole-dollar labels on a $2.51 market');
  assert.match(scopeSvg(read(100250, 60), 100240), /CEILING \$100,327/, "Bitcoin's labels as before");
});
