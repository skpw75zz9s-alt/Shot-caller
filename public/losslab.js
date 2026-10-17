// Loss lab (v13.39): after every loss the bot looks back at what it saw and what happened, says why it lost, and keeps
// score of those reasons across every graded call. A reason that keeps costing calls, proven on the record, changes the
// calls from then on:
//   the round call   (every round's call, locked at 10:00 left: public/pick.js) takes the OTHER side when a proven
//                    lesson says calls like this lose more often than they win (sitting out isn't an option)
//   official calls   (the ones worth buying) skip it when a proven lesson says calls like this win less often than
//                    their price needs (public/engine.js, next to the learned call filter, public/callgate.js)
// What it saw (context, at the call):
//   z       how far price was past the target, toward the side, in typical moves for the time left
//   vr      how jumpy: 1-minute volatility against its 2-hour norm
//   kalshi  Kalshi's own odds for the side (its mid)
//   gap     the bot's odds minus Kalshi's (the bot much surer than the market)
//   mom     the last 3 minutes' move toward the side, in typical moves
//   flip    the flip check's chance the side loses (public/flipmodel.js)
//   flow    buyers vs sellers on the exchanges toward the side (the Round scan's verdict, -100..100)
// What happened (the deep dive, from the 1-minute candles after the call): how far ahead it got, how far behind, when
// price last crossed the target, and how fast it moved against the volatility the bot expected.
// Proven = 30+ matching graded calls, the gap clear by z 2.8 (strict: ten lessons are tested at once) and the same way in
// the older and the newer half of the record. Nothing makes 15-minute rounds certain: this fixes mistakes the record
// proves, it can't remove luck.
import { kalshiFee } from './model.js';

export const LAB = { minN: 30, minSkip: 20, z: 2.8 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pc = (x) => `${Math.round(x * 100)}%`;

// The context at a call, every input optional (null when unknown)
export function contextOf({ side, kalshi = null, pBot = null, spot, strike, sigma, minutesLeft, strikeType = 'greater', bars = null, now = Date.now(), sigmaMin = null, sigmaLong = null, flip = null, flow = null }) {
  const up = (side === 'YES') !== /^less/.test(strikeType || ''); // the side wins above the target
  const dir = up ? 1 : -1, ok = spot > 0 && strike > 0 && sigma > 0 && minutesLeft > 0;
  const z = ok ? (Math.log(spot / strike) * dir) / (sigma * Math.sqrt(minutesLeft)) : null;
  let mom = null;
  const done = (bars || []).filter((b) => b.t + 60000 <= now);
  if (done.length >= 4 && spot > 0 && sigma > 0) mom = (Math.log(done.at(-1).c / done.at(-4).c) * dir) / (sigma * Math.sqrt(3));
  const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
  return { z: r3(z), vr: sigmaMin > 0 && sigmaLong > 0 ? r3(sigmaMin / sigmaLong) : null, kalshi: r3(kalshi), gap: pBot != null && kalshi != null ? r3(pBot - kalshi) : null, mom: r3(mom), flip: r3(flip), flow: flow == null ? null : Math.round(flow) };
}

// The lessons it can learn: kinds of calls, each a test on the context
export const LESSONS = [
  { id: 'coinflip', label: 'Too close to call', why: 'price within a quarter of a typical move of the target', when: (c) => c.z != null && Math.abs(c.z) < 0.25 },
  { id: 'marketAgainst', label: 'Kalshi disagreed', why: 'Kalshi priced the side under 45%', when: (c) => c.kalshi != null && c.kalshi < 0.45 },
  { id: 'botOverMarket', label: 'Bot much surer than Kalshi', why: 'the bot\'s odds 15+ points over Kalshi\'s', when: (c) => c.gap != null && c.gap > 0.15 },
  { id: 'jumpy', label: 'Jumpy market', why: 'volatility 40%+ over its 2-hour norm', when: (c) => c.vr != null && c.vr > 1.4 },
  { id: 'calm', label: 'Dead-calm market', why: 'volatility under 70% of its 2-hour norm', when: (c) => c.vr != null && c.vr < 0.7 },
  { id: 'momAgainst', label: 'Momentum against it', why: 'the last 3 minutes moved a typical move or more the other way', when: (c) => c.mom != null && c.mom < -1 },
  { id: 'chasing', label: 'Chasing a run', why: 'the last 3 minutes ran 1.5+ typical moves its way', when: (c) => c.mom != null && c.mom > 1.5 },
  { id: 'flipWarn', label: 'Flip check warned', why: 'the flip check gave it a 35%+ chance of losing', when: (c) => c.flip != null && c.flip > 0.35 },
  { id: 'flowAgainst', label: 'Sellers against it', why: 'the exchanges\' buyers and sellers leaned 25+ the other way', when: (c) => c.flow != null && c.flow < -25 },
  { id: 'flowWith', label: 'Crowd with it', why: 'buyers and sellers leaned 25+ its way (a crowded side)', when: (c) => c.flow != null && c.flow > 25 },
];
const byId = Object.fromEntries(LESSONS.map((l) => [l.id, l]));

const won = (e) => e.side.toLowerCase() === e.result;
const graded = (es) => (es || []).filter((e) => (e.result === 'yes' || e.result === 'no') && e.ctx);
// One-sided test that a rate is under a baseline: z = (base - rate) / sd
const zUnder = (wins, n, base) => (n ? (base - wins / n) / Math.sqrt(Math.max(1e-9, base * (1 - base) / n)) : 0);

// Every lesson on a record. mode 'flip' (round calls): proven when calls like this lose more than they win, so the other
// side would have won more. mode 'skip' (official calls): proven when they win less often than their price + fee needs.
export function lessonStudy(entries, mode = 'flip') {
  // a round call a lesson already flipped is judged as the call it would have been (its original side and context)
  const xs = graded(entries).map((e) => (e.orig ? { ...e, side: e.orig.side, ctx: e.orig.ctx, p: e.p != null ? 1 - e.p : null } : e)).sort((a, b) => a.at - b.at), half = Math.floor(xs.length / 2);
  const rows = LESSONS.map((l) => {
    const hit = xs.map((e, i) => ({ e, i })).filter(({ e }) => l.when(e.ctx));
    const n = hit.length, wins = hit.filter(({ e }) => won(e)).length;
    const need = mode === 'skip' ? (n ? hit.reduce((a, { e }) => a + (e.price ?? 0.5) + kalshiFee(e.price ?? 0.5), 0) / n : null) : 0.5;
    const part = (f) => { const h = hit.filter(f); return h.length ? h.filter(({ e }) => won(e)).length / h.length : null; };
    const older = part(({ i }) => i < half), newer = part(({ i }) => i >= half);
    const z = need == null ? 0 : zUnder(wins, n, need), minN = mode === 'skip' ? LAB.minSkip : LAB.minN;
    const proven = n >= minN && z >= LAB.z && older != null && newer != null && older < need && newer < need;
    const expected = n ? hit.reduce((a, { e }) => a + (e.p ?? (e.conf != null ? e.conf / 100 : 0.5)), 0) / n : null;
    return { id: l.id, label: l.label, why: l.why, n, wins, rate: n ? wins / n : null, need, expected, z, older, newer, proven };
  });
  return { mode, n: xs.length, lessons: rows.sort((a, b) => b.z - a.z), active: rows.filter((r) => r.proven).map((r) => r.id) };
}
// The proven lessons a call's context matches
export const lessonsFor = (study, ctx) => (study?.active || []).filter((id) => ctx && byId[id]?.when(ctx)).map((id) => ({ id, label: byId[id].label, why: byId[id].why }));

// The deep dive on a lost call: what happened after it, from the 1-minute candles, and why it most likely lost.
// entry: { side, strike, at, closeTime, ctx, p?, conf?, sigma?, strikeType? }
export function deepDive(entry, bars) {
  const at = entry.at, close = Date.parse(entry.closeTime), sigma = entry.sigma ?? null, c = entry.ctx || {};
  const up = (entry.side === 'YES') !== /^less/.test(entry.strikeType || ''), dir = up ? 1 : -1;
  const path = (bars || []).filter((b) => b.t >= Math.floor(at / 60000) * 60000 && b.t < close).sort((a, b) => a.t - b.t);
  const out = { causes: [], maxFav: null, maxAdv: null, lastCross: null, speed: null, summary: '' };
  if (path.length >= 2 && entry.strike > 0 && sigma > 0) {
    const x = path.map((b) => (Math.log(b.c / entry.strike) * dir) / sigma); // toward the side, in typical 1-minute moves
    out.maxFav = Math.round(Math.max(...x) * 10) / 10; out.maxAdv = Math.round(Math.min(...x) * 10) / 10;
    for (let i = x.length - 1; i > 0; i--) if (Math.sign(x[i]) !== Math.sign(x[i - 1])) { out.lastCross = Math.round((close - path[i].t) / 60000); break; }
    const rs = path.slice(1).map((b, i) => Math.log(b.c / path[i].c)), m = rs.reduce((a, v) => a + v, 0) / rs.length;
    out.speed = Math.round((Math.sqrt(rs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, rs.length - 1)) / sigma) * 10) / 10;
  }
  const add = (key, label, detail) => out.causes.push({ key, label, detail });
  if (c.z != null && Math.abs(c.z) < 0.3) add('tooClose', 'Too close to call', `price was only ${Math.abs(c.z).toFixed(2)} typical moves from the target when it was called`);
  if (out.speed != null && out.speed >= 1.8) add('spike', 'Volatility spike', `price moved ${out.speed}× faster than the bot expected`);
  if (out.maxFav != null && out.maxFav >= 1 && out.lastCross != null && out.lastCross <= 3) add('lateTurn', 'Late turn', `it was winning by ${out.maxFav} typical moves and turned in the last ${Math.max(1, out.lastCross)} minute${out.lastCross === 1 ? '' : 's'}`);
  if (out.maxFav != null && out.maxFav <= 0) add('neverAhead', 'Never ahead', 'price went the other way from the call and never got back');
  if (c.kalshi != null && c.kalshi < 0.5) add('market', 'Kalshi disagreed', `Kalshi priced the side at ${pc(c.kalshi)}`);
  if (c.flow != null && c.flow <= -20) add('flow', 'Sellers against it', `buyers and sellers leaned ${Math.abs(c.flow)} the other way`);
  if (c.flip != null && c.flip >= 0.35) add('flip', 'Flip check warned', `the flip check gave it a ${pc(c.flip)} chance of losing`);
  if (c.mom != null && c.mom <= -1) add('mom', 'Momentum against it', 'the last 3 minutes were already moving the other way');
  const p = entry.p ?? (entry.conf != null ? entry.conf / 100 : null);
  if (!out.causes.length) add('luck', 'The odds', p != null ? `nothing stood out: ${/^(8|11|18)/.test(String(Math.round(p * 100))) ? 'an' : 'a'} ${pc(p)} call loses about ${Math.max(1, Math.round((1 - p) * 10))} in 10, and this was one` : 'nothing stood out: an ordinary losing round');
  out.summary = out.causes.slice(0, 2).map((x) => `${x.label}: ${x.detail}`).join('; ');
  return out;
}

// Why the record's losses happened, counted
export function causeTally(entries) {
  const t = {};
  for (const e of entries || []) for (const c of e.review?.causes || []) t[c.key] = { key: c.key, label: c.label, n: (t[c.key]?.n || 0) + 1 };
  return Object.values(t).sort((a, b) => b.n - a.n);
}
