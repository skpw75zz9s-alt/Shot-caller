// The Whale filter (v13.82): tells the whales that move the market from the ones that don't. Every trade of WHALE.minUsd
// or more on a USD exchange is a case; a minute later it's graded on what the price did:
//   moved   the price went its way by at least one typical minute's move (z ≥ 1: the move over the minute, over the
//           typical size of any minute's move, measured from the same price stream)
//   faded   the price went the other way by as much (the whale was absorbed)
//   nothing anything in between
// The cases are grouped by what can be known the moment a whale prints: its size, its exchange, its side, and whether
// it came in a sweep (another whale the same way within 30 seconds). A group is proven to move the market once it has
// 30+ graded cases and its average move its way has a t of 2 or more; proven noise once it has 30+ and doesn't (a group
// whose moves go against it, t ≤ −2, is proven to fade). A new whale is then called a likely mover when a group it
// belongs to is proven to move, likely noise when its size group (or all whales) is proven noise.
// Moving its way afterwards is what's measured, not why: a whale can buy into a rise that was coming anyway. Like
// everyone on the team, the filter reports and informs: no call uses it.
export const WHALE = { minUsd: 100000, horizonMs: 60000, sweepMs: 30000, minCases: 30, t: 2, moveZ: 1 };
export const SIZE_BANDS = [[100000, 250000, '$100k-250k'], [250000, 1000000, '$250k-1M'], [1000000, Infinity, '$1M+']];
export const sizeBand = (usd) => SIZE_BANDS.find(([lo, hi]) => usd >= lo && usd < hi)?.[2] ?? (usd < SIZE_BANDS[0][0] ? `under ${SIZE_BANDS[0][2].split('-')[0]}` : null);
// the groups a whale belongs to: [key, label]
export function groupsOf(c) {
  return [['all', 'all whales'], [`size:${sizeBand(c.usd)}`, `${sizeBand(c.usd)} whales`], [`ex:${c.ex}`, `whales on ${String(c.ex).replace('.US', '')}`], [`side:${c.side}`, `whale ${c.side}s`], [`sweep:${c.sweep ? 'yes' : 'no'}`, c.sweep ? 'whales in a sweep' : 'lone whales']];
}
// the typical size of a horizon's move (log return), from price samples [{ t, p }] taken every few seconds
export function sigmaOf(ring, horizonMs = WHALE.horizonMs) {
  let s = 0, n = 0, j = 0;
  for (let i = 0; i < ring.length; i++) {
    while (j < ring.length && ring[j].t < ring[i].t + horizonMs) j++;
    if (j >= ring.length) break;
    const r = Math.log(ring[j].p / ring[i].p); s += r * r; n++;
  }
  return n >= 20 ? Math.sqrt(s / n) : null;
}
// a case graded: the price p1 a horizon after its price p0, in its direction, over the typical move
export function grade(c, p1, sigma) {
  const m = (c.side === 'buy' ? 1 : -1) * Math.log(p1 / c.p0), z = m / sigma;
  return { ...c, p1, m, z, out: z >= WHALE.moveZ ? 'moved' : z <= -WHALE.moveZ ? 'faded' : 'nothing' };
}
// every group's record: { key: { label, n, moved, faded, meanZ, t, verdict: grading | movers | noise | faders } }
export function groupStats(cases) {
  const g = {};
  for (const c of cases) for (const [k, label] of groupsOf(c)) {
    const x = (g[k] ||= { key: k, label, n: 0, moved: 0, faded: 0, s: 0, ss: 0 });
    x.n++; x.moved += c.out === 'moved' ? 1 : 0; x.faded += c.out === 'faded' ? 1 : 0; x.s += c.z; x.ss += c.z * c.z;
  }
  for (const x of Object.values(g)) {
    x.meanZ = x.s / x.n;
    const sd = x.n > 1 ? Math.sqrt(Math.max(0, (x.ss - x.n * x.meanZ ** 2) / (x.n - 1))) : 0;
    x.t = sd > 0 ? (x.meanZ * Math.sqrt(x.n)) / sd : 0;
    x.verdict = x.n < WHALE.minCases ? 'grading' : x.t >= WHALE.t ? 'movers' : x.t <= -WHALE.t ? 'faders' : 'noise';
    delete x.s; delete x.ss;
  }
  return g;
}
// what to expect of a whale that just printed, from the groups' records: { label: 'likely mover' | 'likely to fade' |
// 'likely noise' | 'not proven yet', why }
export function predict(c, groups = {}) {
  const mine = groupsOf(c).map(([k]) => groups[k]).filter(Boolean), best = (v) => mine.filter((x) => x.verdict === v && x.key !== 'all').sort((a, b) => Math.abs(b.t) - Math.abs(a.t))[0];
  const pc = (x) => `${Math.round((x.moved / x.n) * 100)}% of ${x.n}`;
  const mv = best('movers');
  if (mv) return { label: 'likely mover', why: `${mv.label} moved the price their way ${pc(mv)} times (t ${mv.t.toFixed(1)})` };
  const fd = best('faders');
  if (fd) return { label: 'likely to fade', why: `the price went against ${fd.label} more often than not (${fd.n} graded, t ${fd.t.toFixed(1)})` };
  const nz = [groups[`size:${sizeBand(c.usd)}`], groups.all].find((x) => x?.verdict === 'noise');
  if (nz) return { label: 'likely noise', why: `${nz.label} moved the price their way only ${pc(nz)} times: no more than any minute (t ${nz.t.toFixed(1)})` };
  return { label: 'not proven yet', why: `the filter needs ${WHALE.minCases} graded whales in a group before it says` };
}
const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);
// the filter's teammate row, from its api(): see whalefilter.js
export function whaleRow(w) {
  if (!w) return { state: 'off', status: 'No exchange trades for this market: no whales to filter', key: 'none' };
  const gs = Object.values(w.groups || {}), all = w.groups?.all, movers = gs.filter((x) => x.verdict === 'movers' && x.key !== 'all'), noise = gs.filter((x) => x.verdict === 'noise' && x.key !== 'all');
  const p = w.pressure || { buy: 0, sell: 0, n: 0 }, last = (w.recent || [])[0];
  const parts = [!all || all.n < WHALE.minCases ? `Grading whales: ${all?.n ?? 0} of ${WHALE.minCases} before it says anything` : `${all.n} whales graded: ${Math.round((all.moved / all.n) * 100)}% moved the price their way`];
  if (movers.length) parts.push(`movers: ${movers.slice(0, 3).map((x) => x.label).join(', ')}`);
  if (noise.length) parts.push(`noise: ${noise.slice(0, 3).map((x) => x.label).join(', ')}`);
  if (p.n) parts.push(`likely movers in the last 15 min: ${money(p.buy)} bought, ${money(p.sell)} sold`);
  const lean = p.n && Math.max(p.buy, p.sell) >= 2 * Math.min(p.buy, p.sell) ? (p.buy > p.sell ? 'buyers' : 'sellers') : null;
  return {
    state: p.n ? 'busy' : all?.n >= WHALE.minCases ? 'ok' : 'idle', status: parts.join(' · '),
    key: `${movers.map((x) => x.key).join(',')}|${lean || ''}`,
    say: lean ? `the whales that move the market are ${lean === 'buyers' ? 'buying' : 'selling'}` : movers.length ? `proved ${movers[0].label} move the market` : last ? `graded a ${money(last.usd)} ${last.side}: ${last.out ?? 'waiting a minute'}` : null,
    talks: lean ? [{ to: 'scout', text: `Likely movers in the last 15 min: ${money(p.buy)} bought, ${money(p.sell)} sold. The rest of the whales are noise.` }, { to: 'judge', text: `Filtered whale pressure leans to the ${lean} (context only: not a proven voice).` }] : undefined,
  };
}
