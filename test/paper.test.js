import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaper, dayStart } from '../public/paper.js';
import { TOPICS, createNewsFeed } from '../newsfeed.js';

const now = Date.parse('2026-10-26T15:00:00Z'), min = 60000; // 11 AM in New York
const h = (title, ago, source = 'Reuters') => ({ title, source, link: `https://example.com/${encodeURIComponent(title)}`, t: now - ago * min });
const coindesk = h('Crypto funds see record weekly inflows', 50, 'CoinDesk');
const day = {
  assets: {
    BTC: [h('Bitcoin climbs past $90,000 as ETF inflows surge', 30), h('Bitcoin ETF inflows surge for a fifth day as Bitcoin climbs', 40, 'Bloomberg'), h('Miners sell as hashprice slumps', 10), coindesk, h('Yesterday\'s bitcoin story', 20 * 60)],
    ETH: [h('Ether ETF inflows surge as Bitcoin climbs higher', 20, 'CNBC'), coindesk],
  },
  topics: {
    fed: [h('Fed officials signal patience on rate cuts', 90), h('Powell says Fed in no hurry on rate cuts', 100, 'WSJ'), h('Rate cuts: Fed officials in no hurry, patience urged', 110, 'AP')],
    stocks: [h('Stocks open higher led by tech', 15)],
    crypto: [h('Bitcoin climbs past $90,000 as ETF inflows surge', 30)], // the same story as under Bitcoin: printed once
    oil: [h('Oil steadies after OPEC+ comments', 60)],
    world: [h('New tariffs on imports announced', 45)],
  },
  events: [{ t: now + 60 * min, title: 'CPI m/m', country: 'USD', impact: 'High', forecast: '0.3%', previous: '0.4%' }, { t: now + 90 * min, title: 'Bank holiday', country: 'JPY', impact: 'Holiday' }, { t: now - 20 * 3600000, title: 'Old release', impact: 'High' }],
};

test('the day starts at midnight in New York (before 6 AM, at 6 PM the evening before)', () => {
  assert.equal(new Date(dayStart(now)).toISOString(), '2026-10-26T04:00:00.000Z');
  assert.equal(new Date(dayStart(Date.parse('2026-10-26T08:00:00Z'))).toISOString(), '2026-10-25T22:00:00.000Z', '4 AM: since 6 PM yesterday');
});

test('the whole day, every story once, in its most specific section; yesterday\'s left out', () => {
  const p = buildPaper({ day, now });
  assert.match(p.lead.title, /ETF inflows surge/); assert.ok(p.lead.covered >= 2);
  const titles = [p.lead, ...p.big, ...p.sections.flatMap((s) => s.items)].map((x) => x.title);
  assert.equal(new Set(titles).size, titles.length, 'nothing printed twice');
  assert.equal(titles.length, p.stories);
  assert.ok(!titles.includes('Yesterday\'s bitcoin story'));
  assert.deepEqual(p.sections.map((s) => s.title), ['The economy & the Fed', 'Stocks', 'Crypto', 'Commodities', 'World & policy']);
  const crypto = p.sections.find((s) => s.key === 'crypto');
  assert.deepEqual(crypto.items.find((x) => x.source === 'CoinDesk').tags, ['Bitcoin', 'Ethereum']);
  assert.equal(p.lead.section, 'crypto', 'found under Bitcoin and the crypto topic: crypto');
});

test('the day\'s other big stories: the most covered, one headline per story', () => {
  const p = buildPaper({ day, now });
  assert.equal(p.big.length, 1); assert.match(p.big[0].title, /rate cuts/i);
  assert.equal(p.sections.find((s) => s.key === 'economy').total, 2, 'the other two Fed headlines stay in their section');
});

test('the schedule: today\'s and the next 24 hours\' high and medium releases; the desk shows the record', () => {
  const p = buildPaper({ day, now, record: { graded: 40, wins: 30, usd: 12.5, streak: { kind: 'W', n: 3 } } });
  assert.deepEqual(p.events.map((e) => e.title), ['CPI m/m']);
  assert.equal(p.record.wins, 30);
  assert.equal(buildPaper({ day, now, record: { graded: 0 } }).record, null);
});

test('no news yet: an empty paper, not an error', () => {
  const p = buildPaper({ day: {}, now });
  assert.equal(p.lead, null); assert.equal(p.stories, 0); assert.deepEqual(p.sections, []);
});

test('the feed polls the market-moving topics too, and keeps the whole day for the Paper', async () => {
  let t = now; const asked = [];
  const rss = (title, ago) => `<rss><channel><item><title>${title} - Reuters</title><pubDate>${new Date(t - ago * min).toUTCString()}</pubDate><link>https://x.com/a</link></item></channel></rss>`;
  const feed = createNewsFeed({ env: { NEWS_GOOGLE: 'g:', NEWS_COINDESK: 'cd:', NEWS_CALENDAR: 'cal:' }, assets: () => ['BTC'], clock: () => t,
    fetchText: async (u) => { asked.push(u); return u.startsWith('cal:') ? '[]' : rss(`Story from ${decodeURIComponent(u).slice(0, 40)}`, 8 * 60); } });
  await feed.poll();
  assert.equal(asked.filter((u) => u.startsWith('g:')).length, 1 + TOPICS.length);
  const d = feed.day();
  assert.equal(d.topics.fed.length, 1, 'an 8-hour-old story stays for the Paper');
  assert.equal(feed.api('BTC').headlines.length, 0, 'but the News scout reads only the last 6 hours');
  const n = asked.length; t += 6 * min; await feed.poll();
  assert.deepEqual(asked.slice(n).map((u) => u.slice(0, 3)), ['g:?', 'cd:'], 'topics every 10 minutes; the running coin (and CoinDesk) every 5');
});
