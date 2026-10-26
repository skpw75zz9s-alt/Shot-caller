// The Paper (v13.93): the day's market news laid out as a newspaper, from the News scout's feed (newsfeed.js: Google
// News for every running market, CoinDesk for crypto, and the week's economic calendar). The lead story is the one
// the most other headlines are also about (sharing 3+ key words), so the story everyone is covering leads; then a
// section per kind of market, the day's scheduled releases, and the bot's own record. Shared by the server and tests.
export const PAPER = { leadWithin: 3 * 3600000, perSection: 8, events: 10, sameWords: 3 };
const SECTIONS = [['crypto', 'Crypto'], ['index', 'Stocks'], ['commodity', 'Commodities']];
const STOP = new Set('the and for with from that this into over after says said will have been were what when than more less amid near just your about their price prices today week market markets stock stocks news live update updates could would new how why its are was has not but out off'.split(' '));
const words = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9$%. ]+/g, ' ').split(/\s+/).map((w) => w.replace(/\.$/, '')).filter((w) => w.length >= 4 && !STOP.has(w)));
const key = (t) => String(t).toLowerCase().replace(/\W+/g, ' ').trim();

// markets: [{ asset, name, kind }] (running), newsOf(asset) -> { headlines, events }, record: publicRecord() | null
export function buildPaper({ markets = [], newsOf = () => null, record = null, now = Date.now() } = {}) {
  const byKey = new Map(); // one story, however many markets filed it
  let events = [];
  for (const m of markets) {
    const n = newsOf(m.asset);
    if (!n) continue;
    if (!events.length) events = n.events || [];
    for (const h of n.headlines || []) {
      const k = key(h.title);
      const s = byKey.get(k) || { title: h.title, source: h.source, link: h.link, t: h.t, kinds: new Set(), tags: [] };
      s.kinds.add(m.kind); if (!s.tags.includes(m.name)) s.tags.push(m.name);
      byKey.set(k, s);
    }
  }
  const all = [...byKey.values()].sort((a, b) => b.t - a.t), w = all.map((s) => words(s.title));
  all.forEach((s, i) => { s.covered = all.filter((_, j) => j !== i && [...w[i]].filter((x) => w[j].has(x)).length >= PAPER.sameWords).length; });
  const fresh = all.filter((s) => now - s.t <= PAPER.leadWithin), pool = fresh.length ? fresh : all;
  const lead = pool.slice().sort((a, b) => b.covered - a.covered || b.t - a.t)[0] || null;
  const out = (s) => ({ title: s.title, source: s.source, link: s.link, t: s.t, tags: s.tags, covered: s.covered });
  const sections = SECTIONS.map(([k, title]) => ({ key: k, title, items: all.filter((s) => s !== lead && s.kinds.has(k)).slice(0, PAPER.perSection).map(out) }))
    .filter((s) => markets.some((m) => m.kind === s.key));
  const cal = events.filter((e) => e.impact === 'High' || e.impact === 'Medium').sort((a, b) => a.t - b.t).slice(0, PAPER.events);
  return { at: now, lead: lead && out(lead), sections, events: cal, record: record && record.graded ? { graded: record.graded, wins: record.wins, usd: record.usd, streak: record.streak } : null, stories: all.length };
}
