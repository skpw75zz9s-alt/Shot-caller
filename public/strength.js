// The strength meter (v13.62): is the bot actually getting stronger? Every second, the server keeps the bot's odds for the
// live round at each stage, and Kalshi's price, and when the round settles it scores every one of those seconds against
// the result (the Brier score: the squared miss, 0 = perfect, 0.25 = a coin flip). Pure; strength.js on the server feeds it.
//   math     the bot's own price math (distance to the target, volatility, time left) before anything else
//   blend    after mixing in Kalshi's price (only when that blend has proven it helps)
//   final    after the council's nudges: what the bot's calls actually use
//   kalshi   Kalshi's own price (the mid of its bid and ask): the bar to beat
// A round's seconds are tightly linked (a round that ends UP grades all its seconds the same way), so the honest unit for
// "is it better" is rounds, never seconds: every comparison here is per round, with its own spread.
export const LAYERS = ['math', 'blend', 'final', 'kalshi'];
export const STAGES = [['early', 'Minutes 15-10', 10, 15], ['mid', 'Minutes 10-5', 5, 10], ['late', 'Minutes 5-1', 1, 5], ['close', 'Last minute', 0, 1]];
export const STRENGTH = { coin: 0.25, keep: 3000, z: 2, minRounds: 30 };

const blank = () => Object.fromEntries(LAYERS.map((k) => [k, { n: 0, s: 0, s2: 0 }]));
export const newRound = () => ({ all: blank(), stages: Object.fromEntries(STAGES.map(([k]) => [k, blank()])) });
const stageOf = (m) => STAGES.find(([, , a, b]) => m > a && m <= b)?.[0] ?? (m <= 1 ? 'close' : null);
// one second: { math, blend, final, kalshi } (each a P(YES), or null) at minutesLeft
export function addSecond(acc, ps, minutesLeft) {
  const st = stageOf(minutesLeft);
  for (const k of LAYERS) {
    const p = ps[k]; if (p == null || !Number.isFinite(p)) continue;
    for (const L of [acc.all[k], st ? acc.stages[st][k] : null]) if (L) { L.n++; L.s += p; L.s2 += p * p; }
  }
  return acc;
}
// the mean squared miss over a layer's seconds, from its sums: mean(p²) − 2y·mean(p) + y
const brier = (L, y) => (L?.n ? (L.s2 - 2 * y * L.s + y * L.n) / L.n : null);
// a settled round's score: each layer's Brier, overall and by stage (only layers with seconds in it)
export function scoreRound(acc, y, meta = {}) {
  const pick = (g) => Object.fromEntries(LAYERS.map((k) => [k, brier(g[k], y)]).filter(([, v]) => v != null));
  return { ...meta, y, n: acc.all.final.n, b: pick(acc.all), st: Object.fromEntries(STAGES.map(([k]) => [k, pick(acc.stages[k])]).filter(([, v]) => Object.keys(v).length)) };
}

const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
function paired(rounds, a, b, get = (r) => r.b) { // per round: layer a's Brier minus layer b's (negative = a is better)
  const d = rounds.map((r) => { const g = get(r); return g?.[a] != null && g?.[b] != null ? g[a] - g[b] : null; }).filter((x) => x != null);
  const m = mean(d); if (m == null) return null;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1)), se = sd / Math.sqrt(d.length);
  return { n: d.length, diff: m, z: se > 0 ? m / se : 0 };
}
const skill = (b) => (b == null ? null : 1 - b / STRENGTH.coin); // how much better than a coin flip (1 = perfect, 0 = a coin flip)
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// the meter: rounds: [{ close, y, n, b: { math, blend, final, kalshi }, st: { stage: {...} } }]
export function strengthSummary(rounds, now = Date.now()) {
  const rs = (rounds || []).filter((r) => r && r.b?.final != null).sort((a, b) => a.close - b.close);
  const days = [], byDay = new Map();
  for (const r of rs) { const d = dayOf(r.close); if (!byDay.has(d)) { byDay.set(d, []); days.push(d); } byDay.get(d).push(r); }
  const layerSkill = (list, k, get = (r) => r.b) => skill(mean(list.map((r) => get(r)?.[k]).filter((x) => x != null)));
  const daily = days.map((d) => { const l = byDay.get(d); return { day: d, rounds: l.length, ...Object.fromEntries(LAYERS.map((k) => [k, layerSkill(l, k)])) }; });
  const week = rs.filter((r) => r.close > now - 7 * 86400000), prev = rs.filter((r) => r.close <= now - 7 * 86400000 && r.close > now - 14 * 86400000);
  const vsCoin = (list) => { const d = list.map((r) => r.b.final - STRENGTH.coin), m = mean(d); if (m == null) return null; const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1)); return { n: d.length, diff: m, z: sd > 0 ? m / (sd / Math.sqrt(d.length)) : 0 }; };
  // last 7 days against the 7 before: two independent sets of rounds
  let trend = null;
  if (week.length && prev.length) {
    const a = week.map((r) => r.b.final), b = prev.map((r) => r.b.final), ma = mean(a), mb = mean(b);
    const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / Math.max(1, a.length - 1), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / Math.max(1, b.length - 1);
    const se = Math.sqrt(va / a.length + vb / b.length);
    trend = { n: [a.length, b.length], now: skill(ma), before: skill(mb), z: se > 0 ? (mb - ma) / se : 0 }; // z > 0: the last week missed less
  }
  const base = week.length >= STRENGTH.minRounds ? week : rs; // judge on the last week once it has enough rounds
  const stages = STAGES.map(([k, name]) => { const l = base.filter((r) => r.st?.[k]); return { key: k, name, rounds: l.length, final: layerSkill(l, 'final', (r) => r.st[k]), kalshi: layerSkill(l, 'kalshi', (r) => r.st[k]), math: layerSkill(l, 'math', (r) => r.st[k]), vsKalshi: paired(l, 'final', 'kalshi', (r) => r.st[k]) }; });
  return {
    rounds: rs.length, week: week.length, daily, stages, trend,
    skill: Object.fromEntries(LAYERS.map((k) => [k, layerSkill(base, k)])),
    coin: vsCoin(base), // final vs a coin flip (negative diff = better)
    vsKalshi: paired(base, 'final', 'kalshi'),
    steps: { blend: paired(base, 'blend', 'math'), council: paired(base, 'final', 'blend') }, // what each stage added (negative = it helped)
    words: strengthWords({ rounds: rs.length, base: base.length, coin: vsCoin(base), vsKalshi: paired(base, 'final', 'kalshi'), trend, steps: { blend: paired(base, 'blend', 'math'), council: paired(base, 'final', 'blend') } }),
  };
}
// the meter in plain words, each claim only as strong as its evidence
export function strengthWords({ rounds, base, coin, vsKalshi, trend, steps }) {
  if (rounds < STRENGTH.minRounds) return [`Still measuring: ${rounds} of the ${STRENGTH.minRounds} settled rounds it needs before saying anything.`];
  const out = [], Z = STRENGTH.z, pts = (d) => `${Math.abs(d / STRENGTH.coin * 100).toFixed(1)}%`;
  out.push(coin.z <= -Z ? `Stronger than a coin flip: it misses ${pts(coin.diff)} less, clear over ${coin.n} rounds.` : coin.z >= Z ? `Weaker than a coin flip over ${coin.n} rounds: its odds are hurting, not helping.` : `Not clearly better than a coin flip yet (${coin.n} rounds).`);
  if (vsKalshi) out.push(vsKalshi.z <= -Z ? `Beats Kalshi's own price by ${pts(vsKalshi.diff)} (clear over ${vsKalshi.n} rounds): the bot knows something the market doesn't.` : vsKalshi.z >= Z ? `Kalshi's price is ${pts(vsKalshi.diff)} more accurate than the bot (clear over ${vsKalshi.n} rounds): the market knows more.` : `Level with Kalshi's own price: no clear difference over ${vsKalshi.n} rounds.`);
  if (trend && Math.min(...trend.n) >= 10) out.push(trend.z >= Z ? `Getting stronger: the last 7 days were clearly better than the 7 before.` : trend.z <= -Z ? `Getting weaker: the last 7 days were clearly worse than the 7 before.` : `No clear change between the last 7 days and the 7 before.`);
  for (const [k, name] of [['blend', 'Mixing in Kalshi\'s price'], ['council', 'The council\'s nudges']]) {
    const s = steps[k]; if (!s || Math.abs(s.diff) < 1e-6) continue;
    out.push(s.z <= -Z ? `${name} clearly helped (${pts(s.diff)} fewer misses).` : s.z >= Z ? `${name} clearly hurt (${pts(s.diff)} more misses): worth a look.` : `${name}: no clear effect yet.`);
  }
  if (base < rounds) out.push(`Judged on the last 7 days (${base} rounds).`);
  return out;
}
