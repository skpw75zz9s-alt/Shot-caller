import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaper } from '../public/paper.js';

const now = Date.parse('2026-10-26T15:00:00Z'), min = 60000;
const h = (title, ago, source = 'Reuters') => ({ title, source, link: `https://example.com/${encodeURIComponent(title)}`, t: now - ago * min });
const markets = [{ asset: 'BTC', name: 'Bitcoin', kind: 'crypto' }, { asset: 'ETH', name: 'Ethereum', kind: 'crypto' }, { asset: 'GOLD', name: 'Gold', kind: 'commodity' }];
const coindesk = h('Crypto funds see record weekly inflows', 50, 'CoinDesk');
const news = {
  BTC: { headlines: [h('Bitcoin climbs past $90,000 as ETF inflows surge', 30), h('Bitcoin ETF inflows surge for a fifth day as Bitcoin climbs', 40, 'Bloomberg'), h('Miners sell as hashprice slumps', 10), coindesk],
    events: [{ t: now + 60 * min, title: 'CPI m/m', country: 'USD', impact: 'High', forecast: '0.3%', previous: '0.4%' }, { t: now + 90 * min, title: 'Bank holiday', country: 'JPY', impact: 'Holiday' }] },
  ETH: { headlines: [h('Ether ETF inflows surge as Bitcoin climbs higher', 20, 'CNBC'), coindesk], events: [] },
  GOLD: { headlines: [h('Gold slips as the dollar firms ahead of CPI', 5)], events: [] },
};

test('the lead is the story the most other headlines are on; one story filed by two markets prints once with both tags', () => {
  const p = buildPaper({ markets, newsOf: (a) => news[a], now });
  assert.match(p.lead.title, /ETF inflows surge/); assert.ok(p.lead.covered >= 2);
  assert.equal(p.stories, 7 - 1, 'CoinDesk\'s story under Bitcoin and Ethereum counts once');
  const crypto = p.sections.find((s) => s.key === 'crypto');
  assert.deepEqual(crypto.items.find((x) => x.source === 'CoinDesk').tags, ['Bitcoin', 'Ethereum']);
  assert.ok(!crypto.items.some((x) => x.title === p.lead.title), 'the lead isn\'t printed twice');
  assert.equal(crypto.items[0].title, 'Miners sell as hashprice slumps', 'newest first');
  assert.deepEqual(p.sections.map((s) => s.title), ['Crypto', 'Commodities'], 'only the kinds of markets running');
});

test('the schedule keeps high and medium impact releases; the desk shows the record', () => {
  const p = buildPaper({ markets, newsOf: (a) => news[a], now, record: { graded: 40, wins: 30, usd: 12.5, streak: { kind: 'W', n: 3 } } });
  assert.deepEqual(p.events.map((e) => e.title), ['CPI m/m']);
  assert.deepEqual(p.record, { graded: 40, wins: 30, usd: 12.5, streak: { kind: 'W', n: 3 } });
  assert.equal(buildPaper({ markets, newsOf: (a) => news[a], now, record: { graded: 0 } }).record, null);
});

test('no news yet: an empty paper, not an error; old news can still lead when nothing is fresh', () => {
  const p = buildPaper({ markets, newsOf: () => null, now });
  assert.equal(p.lead, null); assert.equal(p.stories, 0);
  const old = buildPaper({ markets: [markets[2]], newsOf: () => ({ headlines: [h('Gold steady overnight', 300)], events: [] }), now });
  assert.equal(old.lead.title, 'Gold steady overnight');
});
