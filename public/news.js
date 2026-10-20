// The News scout (v13.74; its feed: newsfeed.js): reads the market news and the economic calendar for the market open,
// and tells whoever it concerns. Each headline goes to the teammate whose part it bears on:
//   ETF and fund money        the Money-flows desk
//   hacks, bans, lawsuits     the Risk officer
//   liquidations              the Liquidation watcher
//   the Fed, rates, CPI, jobs the Related-markets desk
//   a big move (surge, crash) the Analyst
//   anything else             the Scout
// and a high-impact release on the calendar goes to the Risk officer and the Analyst before it lands (the next hour),
// and to the Analyst again once it's out. Pure. The News scout informs: no headline changes a call (news has no
// graded record here, so it gets no say in the odds).
export const NEWS_ROLE = ['newsscout', 'News scout', 'reads the market news and tells whoever it concerns', '🗞️'];
export const ROUTES = [
  [/\b(etfs?|inflows?|outflows?|blackrock|grayscale|fidelity|fund flows?)\b/i, 'flows'],
  [/\b(hack(ed|s)?|exploit(ed)?|stolen|breach|ban(s|ned)?|sec|lawsuits?|sued|charge[sd]?|indict(ed|ment)?|fraud|bankrupt(cy)?|insolven\w*)\b/i, 'risk'],
  [/liquidat\w*/i, 'liqs'],
  [/\b(fed|fomc|powell|rate (cut|hike)s?|interest rates?|cpi|inflation|jobs report|payrolls|treasur(y|ies)|yields?)\b/i, 'related'],
  [/\b(surge[sd]?|soar(s|ed)?|plunge[sd]?|crash(es|ed)?|tumble[sd]?|rall(y|ies|ied)|record high|all-time high|sell-?off)\b/i, 'analyst'],
];
export const routeOf = (title) => ROUTES.find(([re]) => re.test(title))?.[1] ?? 'scout';
const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min ago` : `${Math.round(ms / 3600000)} h ago`);
const inMin = (ms) => (ms < 3600000 ? `in ${Math.max(1, Math.round(ms / 60000))} min` : `in ${Math.round(ms / 3600000)} h`);

// news: newsfeed.js api() for the market's asset (null: no news feed). Returns the News scout's row
export function newsRow(news, { now = Date.now(), name = 'this market' } = {}) {
  const base = { role: NEWS_ROLE[0], name: NEWS_ROLE[1], job: NEWS_ROLE[2], dept: 'desk', talks: [] };
  if (!news) return { ...base, state: 'idle', status: 'Not reporting', key: 'none' };
  if (!news.on) return { ...base, state: 'off', status: 'The news feed is off (NEWS=off)', key: 'off' };
  const recent = (news.headlines || []).filter((h) => h.t > now - 2 * 3600000), hour = recent.filter((h) => h.t > now - 3600000);
  const big = (news.events || []).filter((e) => /high/i.test(e.impact) && (e.country === 'USD' || e.country === 'ALL'));
  const next = big.find((e) => e.t > now), justOut = big.filter((e) => e.t <= now && e.t > now - 15 * 60000);
  const soon = next && next.t - now <= 3600000;
  const talks = [];
  for (const h of recent.slice(0, 6)) talks.push({ to: routeOf(h.title), text: `News (${h.source || 'headline'}, ${ago(now - h.t)}): ${h.title}` });
  if (soon) for (const to of ['risk', 'analyst']) talks.push({ to, text: `Heads-up: ${next.title} (${next.country}, high impact) ${inMin(next.t - now)}${next.forecast ? `, forecast ${next.forecast}` : ''}. Releases like this move every market at once.` });
  for (const e of justOut) talks.push({ to: 'analyst', text: `Just out: ${e.title} (${e.country})${e.forecast ? `, forecast was ${e.forecast}` : ''}. Expect the price to jump around for a few minutes.` });
  const status = news.err && !recent.length && !big.length ? `Can't reach the news sources right now (${news.err})`
    : `${hour.length ? `${hour.length} headline${hour.length === 1 ? '' : 's'} on ${name} in the last hour${hour[0] ? `: "${hour[0].title}"` : ''}` : `No new headlines on ${name} in the last hour`} · ${justOut.length ? `${justOut[0].title} just came out` : next ? `next big release: ${next.title} ${inMin(next.t - now)}` : 'no big releases on the calendar'}`;
  return {
    ...base, talks, headlines: recent.slice(0, 10), events: big.filter((e) => e.t > now - 3600000).slice(0, 6),
    state: soon || justOut.length || hour.length ? 'busy' : news.err && !recent.length ? 'idle' : 'ok',
    status, key: `${recent[0]?.title ?? ''}|${soon ? next.title : ''}|${justOut.map((e) => e.title).join(',')}`,
    say: justOut.length ? `${justOut[0].title} is out` : soon ? `${next.title} ${inMin(next.t - now)}` : recent[0] ? `news: ${recent[0].title}` : null,
  };
}
