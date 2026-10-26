// The Paper (v13.93; the whole day's market news since v13.94): the day's market-moving headlines laid out as a
// newspaper, from the News scout's feed (newsfeed.js day(): Google News for every running market and for the topics that
// move every market, the Fed, the economy, yields, stocks, earnings, crypto, oil, metals, world policy; CoinDesk for
// crypto; the week's economic calendar). "The day" is since midnight Eastern (before 6 AM, since 6 PM the evening
// before). The lead is the story the most other headlines are also about (sharing 3+ key words) in the last 3 hours;
// then the day's other big stories; then every other headline once, in its section. Shared by the server and tests.
import { ASSETS } from './markets.js';

export const PAPER = { leadWithin: 3 * 3600000, perSection: 30, big: 5, events: 12, sameWords: 3 };
export const SECTIONS = [
  { key: 'economy', title: 'The economy & the Fed', topics: ['fed', 'economy', 'bonds'] },
  { key: 'stocks', title: 'Stocks', topics: ['stocks', 'earnings'], kinds: ['index'] },
  { key: 'crypto', title: 'Crypto', topics: ['crypto'], kinds: ['crypto'] },
  { key: 'commodities', title: 'Commodities', topics: ['oil', 'metals'], kinds: ['commodity'] },
  { key: 'world', title: 'World & policy', topics: ['world'] },
];
const CLAIM = ['crypto', 'commodities', 'economy', 'stocks', 'world']; // a story in several sections prints in the most specific
const STOP = new Set('the and for with from that this into over after says said will have been were what when than more less amid near just your about their price prices today week market markets stock stocks news live update updates could would new how why its are was has not but out off'.split(' '));
const words = (t) => [...new Set(String(t).toLowerCase().replace(/[^a-z0-9$%. ]+/g, ' ').split(/\s+/).map((w) => w.replace(/\.$/, '')).filter((w) => w.length >= 4 && !STOP.has(w)))];
const key = (t) => String(t).toLowerCase().replace(/\W+/g, ' ').trim();

// the start of "today" in New York
export function dayStart(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]));
  const midnight = now - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (now % 1000);
  return p.hour < 6 ? midnight - 6 * 3600000 : midnight;
}

// day: newsfeed.js day() ({ assets: { BTC: [headline] }, topics: { fed: [headline] }, events }), record: publicRecord() | null
export function buildPaper({ day = {}, record = null, now = Date.now() } = {}) {
  const since = dayStart(now), byKey = new Map();
  const file = (h, section, tag) => {
    if (!(h.t >= since && h.t <= now + 300000) || !h.title) return;
    const k = key(h.title), s = byKey.get(k) || { title: h.title, source: h.source, link: h.link, t: h.t, in: new Set(), tags: [] };
    s.in.add(section); if (tag && !s.tags.includes(tag)) s.tags.push(tag);
    byKey.set(k, s);
  };
  for (const [asset, list] of Object.entries(day.assets || {})) {
    const a = ASSETS.find((x) => x.key === asset), sec = SECTIONS.find((x) => x.kinds?.includes(a?.kind));
    if (sec) for (const h of list) file(h, sec.key, a.name);
  }
  for (const [topic, list] of Object.entries(day.topics || {})) {
    const sec = SECTIONS.find((x) => x.topics.includes(topic));
    if (sec) for (const h of list) file(h, sec.key, null);
  }
  const all = [...byKey.values()].sort((a, b) => b.t - a.t), w = all.map((s) => words(s.title)), sets = w.map((x) => new Set(x));
  all.forEach((s, i) => { let c = 0; for (let j = 0; j < all.length; j++) if (j !== i) { let n = 0; for (const x of w[i]) if (sets[j].has(x) && ++n >= PAPER.sameWords) { c++; break; } } s.covered = c; });
  const out = (s) => ({ title: s.title, source: s.source, link: s.link, t: s.t, tags: s.tags, covered: s.covered, section: CLAIM.find((c) => s.in.has(c)) });
  const fresh = all.filter((s) => now - s.t <= PAPER.leadWithin), pool = fresh.length ? fresh : all;
  const lead = pool.slice().sort((a, b) => b.covered - a.covered || b.t - a.t)[0] || null;
  // the day's other big stories: the most covered, one per thread (not two headlines on the same story)
  const big = [];
  for (const s of all.slice().sort((a, b) => b.covered - a.covered || b.t - a.t)) {
    if (big.length >= PAPER.big || s.covered < 2) break;
    const ws = words(s.title), same = (o) => ws.filter((x) => words(o.title).includes(x)).length >= PAPER.sameWords;
    if (s !== lead && !(lead && same(lead)) && !big.some(same)) big.push(s);
  }
  const shown = new Set([lead, ...big]);
  const sections = SECTIONS.map((sec) => {
    const items = all.filter((s) => !shown.has(s) && CLAIM.find((c) => s.in.has(c)) === sec.key);
    return { key: sec.key, title: sec.title, total: items.length, items: items.slice(0, PAPER.perSection).map(out) };
  }).filter((s) => s.total);
  const cal = (day.events || []).filter((e) => (e.impact === 'High' || e.impact === 'Medium') && e.t >= since && e.t < now + 86400000).sort((a, b) => a.t - b.t).slice(0, PAPER.events);
  return { at: now, since, lead: lead && out(lead), big: big.map(out), sections, events: cal,
    record: record && record.graded ? { graded: record.graded, wins: record.wins, usd: record.usd, streak: record.streak } : null, stories: all.length };
}
