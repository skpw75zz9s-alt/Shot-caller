import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsFeed, parseCalendar, parseRss } from '../newsfeed.js';
import { newsRow, routeOf } from '../public/news.js';
import { teamRoster, teamTalk } from '../public/team.js';

const now = Date.parse('2026-10-20T14:00:00Z');
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map(([title, mins, source]) => `<item><title><![CDATA[${title}]]></title><link>https://example.com/${encodeURIComponent(title)}</link><pubDate>${new Date(now - mins * 60000).toUTCString()}</pubDate>${source ? `<source url="https://x">${source}</source>` : ''}</item>`).join('')}</channel></rss>`;

test('RSS: titles, sources (Google\'s " - Source" split off), dates, entities', () => {
  const out = parseRss(rss([['Bitcoin ETF inflows top $1B &amp; climbing - Reuters', 10, 'Reuters'], ['SEC sues an exchange over listings', 30]]), 'CoinDesk');
  assert.deepEqual(out.map((h) => [h.title, h.source]), [['Bitcoin ETF inflows top $1B & climbing', 'Reuters'], ['SEC sues an exchange over listings', 'CoinDesk']]);
  assert.equal(out[0].t, now - 600000); assert.match(out[0].link, /^https:\/\/example\.com\//);
  assert.deepEqual(parseRss('not xml at all'), []);
});

test('the calendar: releases with times and impact; junk dropped', () => {
  const ev = parseCalendar([{ title: 'CPI m/m', country: 'USD', date: '2026-10-20T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.4%' }, { title: '', date: 'x' }, null]);
  assert.equal(ev.length, 1); assert.equal(ev[0].t, Date.parse('2026-10-20T12:30:00Z')); assert.equal(ev[0].impact, 'High');
});

test('the feed: polls each running asset, dedupes, keeps 6 hours, and only calls it an error when it keeps failing', async () => {
  let t = now, fail = false; const asked = [];
  const fetchText = async (url) => {
    asked.push(url);
    if (fail) throw new Error('blocked');
    if (url.startsWith('cal:')) return JSON.stringify([{ title: 'Fed rate decision', country: 'USD', date: new Date(now + 30 * 60000).toISOString(), impact: 'High' }]);
    if (url.startsWith('cd:')) return rss([['Bitcoin miners sell as hashprice falls', 20]]);
    return rss([['Bitcoin surges past $100k - Bloomberg', 5, 'Bloomberg'], ['Bitcoin surges past $100k - Yahoo', 6, 'Yahoo'], ['Old story', 7 * 60]]);
  };
  const feed = createNewsFeed({ env: { NEWS_GOOGLE: 'g:', NEWS_COINDESK: 'cd:', NEWS_CALENDAR: 'cal:' }, assets: () => ['BTC', 'GOLD'], fetchText, clock: () => t });
  await feed.poll();
  assert.ok(asked.some((u) => u.startsWith('g:?q=bitcoin')) && asked.some((u) => u.startsWith('g:?q=gold%20price')) && asked.some((u) => u.startsWith('cd:')) && asked.some((u) => u.startsWith('cal:')));
  const btc = feed.api('BTC');
  assert.deepEqual(btc.headlines.map((h) => h.title), ['Bitcoin surges past $100k', 'Bitcoin miners sell as hashprice falls'], 'deduped, and the 7-hour-old story dropped');
  assert.equal(btc.events[0].title, 'Fed rate decision'); assert.equal(btc.err, null);
  assert.ok(feed.api('ETH').headlines.some((h) => h.source === 'CoinDesk'), 'every coin reads the crypto-wide feed');
  const n = asked.length; await feed.poll(); assert.equal(asked.length, n, 'not again within 5 minutes');
  fail = true; t += 6 * 60000; await feed.poll(); assert.equal(feed.api('BTC').err, null, 'one failed poll: not an error yet');
  t += 20 * 60000; await feed.poll(); assert.match(feed.api('BTC').err, /blocked/);
  assert.equal(createNewsFeed({ env: { NEWS: 'off' }, fetchText }).api('BTC').on, false);
});

test('the News scout tells whoever each headline concerns, and warns before a big release', () => {
  assert.equal(routeOf('Spot bitcoin ETF outflows hit a record'), 'flows');
  assert.equal(routeOf('Exchange hacked, $200M stolen'), 'risk');
  assert.equal(routeOf('$500M in longs liquidated'), 'liqs');
  assert.equal(routeOf('Powell signals a rate cut'), 'related');
  assert.equal(routeOf('Bitcoin plunges 8% overnight'), 'analyst');
  assert.equal(routeOf('A new wallet launches'), 'scout');
  const news = { on: true, err: null, headlines: [{ t: now - 10 * 60000, title: 'Spot bitcoin ETF outflows hit a record', source: 'Reuters' }, { t: now - 3 * 3600000, title: 'too old', source: 'x' }],
    events: [{ t: now + 25 * 60000, title: 'CPI m/m', country: 'USD', impact: 'High', forecast: '0.3%' }, { t: now - 5 * 60000, title: 'Jobless claims', country: 'USD', impact: 'High' }, { t: now + 10 * 60000, title: 'Speech', country: 'EUR', impact: 'High' }] };
  const r = newsRow(news, { now, name: 'Bitcoin' });
  assert.equal(r.state, 'busy');
  assert.match(r.status, /^1 headline on Bitcoin in the last hour: "Spot bitcoin ETF outflows hit a record" · Jobless claims just came out$/);
  assert.ok(r.talks.some((x) => x.to === 'flows' && /^News \(Reuters, 10 min ago\): Spot bitcoin ETF outflows/.test(x.text)));
  assert.ok(r.talks.some((x) => x.to === 'risk' && /^Heads-up: CPI m\/m \(USD, high impact\) in 25 min, forecast 0\.3%/.test(x.text)));
  assert.ok(r.talks.some((x) => x.to === 'analyst' && /^Just out: Jobless claims/.test(x.text)));
  assert.ok(!r.talks.some((x) => /too old|Speech/.test(x.text)), 'old news and other countries\' releases stay quiet');
  assert.match(newsRow({ on: true, err: 'HTTP 403', headlines: [], events: [] }, { now }).status, /Can't reach the news sources right now \(HTTP 403\)/);
  assert.equal(newsRow({ on: false }, { now }).state, 'off');
  // in the team: on the Market desk, and its words reach the teammates
  const roster = teamRoster({ now, snap: null, news, marketName: 'Bitcoin' }), talk = teamTalk(roster);
  assert.equal(roster.find((x) => x.role === 'newsscout').dept, 'desk');
  assert.ok(talk.some((m) => m.from === 'newsscout' && m.to === 'flows'));
});
