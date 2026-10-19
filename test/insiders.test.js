import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSIDER_GROUPS, cikMap, form4Path, groupFor, insiderSummary, insiderWords, parseForm4, recentForm4s } from '../public/insiders.js';
import { INSIDER_FEED, createInsiderFeed } from '../insiderfeed.js';

// a Form 4 shaped like EDGAR's: one open-market buy, one 10b5-1 sale, an option exercise and a tax withholding
const form4 = ({ ticker = 'COIN', owner = 'Doe Jane &amp; Co', title = 'Chief Financial Officer', director = '0', planBox = '0', date = '2026-10-05', buyShares = '1,000', buyPrice = '250.5' } = {}) => `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion><documentType>4</documentType><periodOfReport>${date}</periodOfReport>
  <aff10b5One>${planBox}</aff10b5One>
  <issuer><issuerCik>0001679788</issuerCik><issuerName>Coinbase Global, Inc.</issuerName><issuerTradingSymbol>${ticker}</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001234567</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>${director}</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><isOther>0</isOther><officerTitle>${title}</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Class A Common Stock</value></securityTitle>
      <transactionDate><value>${date}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>${buyShares}</value></transactionShares><transactionPricePerShare><value>${buyPrice}</value><footnoteId id="F2"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>${date}</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode><footnoteId id="F1"/></transactionCoding>
      <transactionAmounts><transactionShares><value>400</value></transactionShares><transactionPricePerShare><value>260</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>4600</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>${date}</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>300</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>${date}</value></transactionDate>
      <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>260</value></transactionPricePerShare></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <footnotes>
    <footnote id="F1">The sale was effected pursuant to a Rule 10b5-1 trading plan adopted on March 1, 2026.</footnote>
    <footnote id="F2">Weighted average price.</footnote>
  </footnotes>
</ownershipDocument>`;

test('a Form 4: issuer, who filed (title, roles), and each stock transaction with its code, size, price and plan', () => {
  const d = parseForm4(form4({ director: '1' }), { acc: '0001-26-000001' });
  assert.deepEqual(d.issuer, { cik: '0001679788', name: 'Coinbase Global, Inc.', ticker: 'COIN' });
  assert.equal(d.owners[0].name, 'Doe Jane & Co'); assert.equal(d.owners[0].role, 'Chief Financial Officer · Director');
  assert.equal(d.trades.length, 4);
  const [p, s] = d.trades;
  assert.equal(p.code, 'P'); assert.equal(p.shares, 1000); assert.equal(p.price, 250.5); assert.equal(p.usd, 250500); assert.equal(p.after, 5000);
  assert.equal(p.plan, false); assert.equal(p.direct, true); assert.equal(p.acc, '0001-26-000001'); assert.equal(p.date, '2026-10-05');
  assert.equal(s.code, 'S'); assert.equal(s.usd, 104000); assert.equal(s.plan, true, 'the footnote on the sale names a 10b5-1 plan'); assert.equal(s.direct, false);
  assert.equal(parseForm4(form4({ planBox: '1' })).trades[0].plan, true, 'the form\'s own 10b5-1 box covers every trade on it');
  assert.equal(parseForm4('<html>not a form</html>'), null);
  assert.equal(parseForm4(form4({ buyPrice: '' })).trades[0].usd, null, 'no price, no dollar value');
});

test('EDGAR\'s filing list and ticker list: Form 4s since a day, the raw XML path, and the CIKs wanted', () => {
  const sub = { name: 'Coinbase', filings: { recent: { form: ['4', '10-Q', '4', '4/A', '4'], filingDate: ['2026-10-07', '2026-10-01', '2026-09-01', '2026-10-06', '2026-01-01'], accessionNumber: ['a1', 'a2', 'a3', 'a4', 'a5'], primaryDocument: ['xslF345X05/f1.xml', 'q.htm', 'xslF345X05/f3.xml', 'x.xml', 'f5.xml'] } } };
  assert.deepEqual(recentForm4s(sub, { since: '2026-08-01' }).map((f) => f.acc), ['a1', 'a3']);
  assert.deepEqual(recentForm4s({}), []);
  assert.equal(form4Path('0001679788', '0001679788-26-000123', 'xslF345X05/wk-form4_1.xml'), '/Archives/edgar/data/1679788/000167978826000123/wk-form4_1.xml');
  assert.deepEqual(cikMap({ 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple' }, 1: { cik_str: 1, ticker: 'ZZZZ' }, 2: { cik_str: 1679788, ticker: 'coin' } }, ['AAPL', 'COIN']), { AAPL: 320193, COIN: 1679788 });
});

test('each market gets its companies: crypto, the biggest US companies for the indexes, miners for metals, oil for oil', () => {
  assert.equal(groupFor({ key: 'ETH', kind: 'crypto' }), 'crypto');
  assert.equal(groupFor({ key: 'NDX', kind: 'index' }), 'megacaps');
  assert.equal(groupFor({ key: 'SILVER', kind: 'commodity' }), 'metals');
  assert.equal(groupFor({ key: 'OIL', kind: 'commodity' }), 'oil');
  assert.ok(INSIDER_GROUPS.crypto.tickers.includes('MSTR'));
});

test('the summary: open-market buys vs sales over 90 days, the planned part, cluster buys and the newest trades', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const t = (o) => ({ ticker: 'COIN', issuer: 'Coinbase', owner: 'A', role: 'CEO', code: 'P', date: '2026-10-10', usd: 1000, plan: false, ...o });
  const trades = [t({}), t({ owner: 'B', usd: 3000 }), t({ code: 'S', owner: 'C', usd: 10000, plan: true }), t({ code: 'S', owner: 'C', usd: 5000 }),
    t({ ticker: 'MSTR', owner: 'D' }), t({ date: '2026-05-01', usd: 9e9 }), t({ code: 'M', usd: 9e9 }), t({ ticker: 'AAPL', usd: 9e9 })];
  const s = insiderSummary(trades, INSIDER_GROUPS.crypto.tickers, now);
  assert.equal(s.buys.n, 3); assert.equal(s.buys.usd, 5000); assert.equal(s.buys.people, 3);
  assert.equal(s.sales.n, 2); assert.equal(s.sales.usd, 15000); assert.equal(s.sales.people, 1); assert.equal(s.sales.plannedUsd, 10000);
  assert.deepEqual(s.clusters.map((c) => [c.ticker, c.people.length, c.usd]), [['COIN', 2, 4000]], 'two COIN insiders bought; one MSTR insider is no cluster');
  assert.equal(s.companies.find((c) => c.ticker === 'COIN').saleUsd, 15000);
  assert.equal(s.recent.length, 5);
  const w = insiderWords(s).join(' ');
  assert.match(w, /3 insiders bought \$5k/); assert.match(w, /\$10k of it under pre-set 10b5\u20111 plans \(\$5k by choice\)/); assert.match(w, /Cluster buy: 2 insiders of COIN/);
  assert.match(insiderWords(insiderSummary([], ['COIN'], now))[0], /No open-market buys or sales/);
});

// a stand-in EDGAR: the ticker list, each company's filing list and the filings
function edgar({ status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ua: opts.headers['user-agent'] });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body });
    if (status !== 200) return { ok: false, status, json: async () => ({}), text: async () => '' };
    if (url.endsWith('/files/company_tickers.json')) return ok({ 0: { cik_str: 1679788, ticker: 'COIN' }, 1: { cik_str: 1050446, ticker: 'MSTR' } });
    if (url.includes('/submissions/CIK0001679788.json')) return ok({ name: 'Coinbase', filings: { recent: { form: ['4', '4'], filingDate: ['2026-10-07', '2026-10-06'], accessionNumber: ['0001679788-26-000001', '0001679788-26-000002'], primaryDocument: ['xslF345X05/a.xml', 'xslF345X05/b.xml'] } } });
    if (url.includes('/submissions/')) return ok({ filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [] } } });
    if (url.includes('/000167978826000001/a.xml')) return ok(form4({ owner: 'Ann' }));
    if (url.includes('/000167978826000002/b.xml')) return ok(form4({ owner: 'Bob', date: '2026-10-04' }));
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { calls, fetchImpl };
}
const groups = { crypto: { name: 'Crypto companies', why: 'test', tickers: ['COIN', 'MSTR', 'NOPE'] } };

test('the server reader: reads only while someone looks, skips filings it has read, keeps buys and sales, names who it is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ins-')), e = edgar(), now = Date.parse('2026-10-19T12:00:00Z');
  const gap = INSIDER_FEED.gapMs; INSIDER_FEED.gapMs = 0;
  try {
    const feed = createInsiderFeed({ file: join(dir, 'insiders.json'), fetchImpl: e.fetchImpl, env: { SEC_USER_AGENT: 'Test Reader test@example.com', SEC_API: 'https://sec.test', SEC_DATA_API: 'https://data.sec.test' }, clock: () => now, groups, log: { error() {} } });
    assert.equal(e.calls.length, 0, 'nothing is fetched until the tab asks');
    const first = feed.api({ key: 'BTC', kind: 'crypto' });
    assert.equal(first.running, true);
    await feed.touch() ?? null; await new Promise((r) => setTimeout(r, 20));
    const a = feed.api({ key: 'BTC', kind: 'crypto' });
    assert.equal(a.running, false); assert.equal(a.err, null); assert.equal(a.ua, true);
    const g = a.groups[0];
    assert.equal(g.mine, true); assert.equal(g.summary.buys.n, 2); assert.equal(g.summary.sales.n, 2, 'the option exercises and tax withholding are left out');
    assert.deepEqual(g.summary.clusters.map((c) => c.people.length), [2]);
    assert.deepEqual(g.errors.map((x) => x.ticker), ['NOPE']);
    assert.ok(e.calls.every((c) => c.ua === 'Test Reader test@example.com'));
    assert.ok(e.calls.some((c) => c.url === 'https://sec.test/Archives/edgar/data/1679788/000167978826000001/a.xml'));
    // a minute later nothing is stale: no new requests; a new reader picks up the saved file and doesn't re-read filings
    const n = e.calls.length;
    feed.api({ key: 'BTC', kind: 'crypto' }); assert.equal(e.calls.length, n);
    const later = now + INSIDER_FEED.staleMs + 1, e2 = edgar();
    const feed2 = createInsiderFeed({ file: join(dir, 'insiders.json'), fetchImpl: e2.fetchImpl, env: {}, clock: () => later, groups, log: { error() {} } });
    await feed2.touch();
    assert.equal(e2.calls.filter((c) => c.url.endsWith('.xml')).length, 0, 'filings already read are skipped');
    assert.equal(feed2.api({ key: 'BTC', kind: 'crypto' }).groups[0].summary.buys.n, 2);
  } finally { INSIDER_FEED.gapMs = gap; }
});

test('the server reader says when the SEC refuses it, and how to fix it; INSIDERS=off turns it off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ins-')), e = edgar({ status: 403 });
  const gap = INSIDER_FEED.gapMs; INSIDER_FEED.gapMs = 0;
  try {
    const feed = createInsiderFeed({ file: join(dir, 'insiders.json'), fetchImpl: e.fetchImpl, env: {}, groups, log: { error() {} } });
    await feed.touch();
    const a = feed.api({ key: 'GOLD', kind: 'commodity' });
    assert.match(a.err, /refused the request \(403\): set SEC_USER_AGENT/); assert.equal(a.ua, false);
    assert.equal(createInsiderFeed({ file: join(dir, 'x.json'), env: { INSIDERS: 'off' } }).api({}).on, false);
  } finally { INSIDER_FEED.gapMs = gap; }
});
