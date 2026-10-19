// The Insiders tab (v13.55): insider traders. Company insiders (executives, directors and 10% owners) must report every
// trade in their own company's stock to the SEC on a Form 4, within two business days; EDGAR publishes the filings
// free. insiderfeed.js fetches them for the companies tied to each market; this file parses and sums them up (pure).
//   open-market buy (code P)   an insider paying cash for shares at the market price: the clearer signal
//   open-market sale (code S)  insiders sell for many reasons (taxes, diversifying, a house), so sales say less,
//                              and a sale made under a 10b5-1 plan (set up months before) says least
//   cluster buy                two or more insiders of one company buying within 30 days
// Grants, option exercises, tax withholding and gifts (codes A, M, F, G, …) aren't trades by choice and are left out.
// Context only: a filing comes up to two business days after the trade and plays out over weeks or months, not a
// 15-minute round, so none of it moves the calls.

export const INSIDER_GROUPS = {
  crypto: { name: 'Crypto companies', why: 'the biggest corporate bitcoin holder, the exchanges and the miners: companies that ride on crypto',
    tickers: ['MSTR', 'COIN', 'HOOD', 'MARA', 'RIOT', 'CLSK'] },
  megacaps: { name: 'The biggest US companies', why: 'the largest weights in the S&P 500, the Nasdaq-100 and the Dow',
    tickers: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM'] },
  metals: { name: 'Gold and silver miners', why: 'the biggest gold and silver miners and royalty companies',
    tickers: ['NEM', 'AEM', 'WPM', 'FNV', 'PAAS'] },
  oil: { name: 'Oil companies', why: 'the biggest US oil producers',
    tickers: ['XOM', 'CVX', 'COP', 'OXY', 'EOG'] },
};
export const INSIDER_TICKERS = [...new Set(Object.values(INSIDER_GROUPS).flatMap((g) => g.tickers))];
// the group that goes with a market's asset ({ key, kind } from public/markets.js)
export function groupFor(asset) {
  if (!asset) return 'crypto';
  if (asset.kind === 'crypto') return 'crypto';
  if (asset.kind === 'index') return 'megacaps';
  if (asset.key === 'GOLD' || asset.key === 'SILVER') return 'metals';
  if (asset.key === 'OIL') return 'oil';
  return 'megacaps';
}
export const CODES = { P: 'buy', S: 'sale' };

// ---------- parsing ----------
const decode = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const blocks = (xml, name) => String(xml || '').match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'g')) || [];
const inner = (xml, name) => { const m = String(xml || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1] : null; };
// a field's text: Form 4 wraps most values in <value>, and may hang footnote marks beside them
const field = (xml, name) => { const x = inner(xml, name); if (x == null) return null; const v = inner(x, 'value'); const t = decode((v ?? x).replace(/<[^>]*>/g, '')); return t === '' ? null : t; };
const yes = (v) => v === '1' || String(v).toLowerCase() === 'true';
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return v != null && Number.isFinite(n) ? n : null; };

// Who an insider is, in a few words: their title, director, 10% owner
function roleOf(rel) {
  const out = [], title = field(rel, 'officerTitle');
  if (yes(field(rel, 'isOfficer'))) out.push(title || 'Officer');
  if (yes(field(rel, 'isDirector'))) out.push('Director');
  if (yes(field(rel, 'isTenPercentOwner'))) out.push('10% owner');
  if (!out.length && yes(field(rel, 'isOther'))) out.push(field(rel, 'otherText') || 'Other');
  return [...new Set(out)].join(' · ') || 'Insider';
}

// A Form 4's XML (EDGAR's ownershipDocument) -> its issuer, the insiders filing it and its stock transactions
export function parseForm4(xml, { acc = null } = {}) {
  const doc = String(xml || '');
  if (!/<ownershipDocument\b/.test(doc)) return null;
  const iss = inner(doc, 'issuer') || '';
  const issuer = { cik: field(iss, 'issuerCik'), name: field(iss, 'issuerName'), ticker: (field(iss, 'issuerTradingSymbol') || '').toUpperCase() || null };
  const owners = blocks(doc, 'reportingOwner').map((o) => ({ cik: field(o, 'rptOwnerCik'), name: field(o, 'rptOwnerName'), role: roleOf(inner(o, 'reportingOwnerRelationship') || '') })).filter((o) => o.name);
  const notes = Object.fromEntries(blocks(inner(doc, 'footnotes') || '', 'footnote').map((f) => [(f.match(/id="([^"]+)"/) || [])[1], decode(f.replace(/<[^>]*>/g, ' '))]));
  // the filing's own 10b5-1 box (checked for the whole form, since 2023), or a footnote on the trade that says so
  const planBox = yes(field(doc, 'aff10b5One'));
  const owner = owners[0] || { name: null, role: 'Insider' };
  const trades = blocks(inner(doc, 'nonDerivativeTable') || '', 'nonDerivativeTransaction').map((t) => {
    const code = field(inner(t, 'transactionCoding') || '', 'transactionCode'), shares = num(field(t, 'transactionShares')), price = num(field(t, 'transactionPricePerShare'));
    const marks = [...t.matchAll(/<footnoteId\b[^>]*id="([^"]+)"/g)].map((m) => notes[m[1]] || '');
    return {
      acc, ticker: issuer.ticker, issuer: issuer.name, owner: owner.name, role: owner.role, others: Math.max(0, owners.length - 1),
      date: field(t, 'transactionDate'), code, shares, price, usd: shares > 0 && price > 0 ? shares * price : null,
      side: field(t, 'transactionAcquiredDisposedCode'), after: num(field(t, 'sharesOwnedFollowingTransaction')),
      direct: field(t, 'directOrIndirectOwnership') !== 'I', plan: planBox || marks.some((m) => /10b5-?1/i.test(m)),
    };
  });
  return { acc, issuer, owners, plan: planBox, trades };
}
// EDGAR's submissions JSON for a company -> its Form 4s filed since a day (newest first)
export function recentForm4s(json, { since = '0000-00-00' } = {}) {
  const r = json?.filings?.recent, out = [];
  if (!r || !Array.isArray(r.form)) return out;
  for (let i = 0; i < r.form.length; i++) if (r.form[i] === '4' && (r.filingDate?.[i] || '') >= since && r.accessionNumber?.[i] && r.primaryDocument?.[i]) out.push({ acc: r.accessionNumber[i], filed: r.filingDate[i], doc: r.primaryDocument[i] });
  return out.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
}
// where a filing's raw XML lives (the primary document's "xslF345X05/" prefix is EDGAR's styled view of it)
export const form4Path = (cik, acc, doc) => `/Archives/edgar/data/${Number(cik)}/${String(acc).replace(/-/g, '')}/${String(doc).replace(/^xslF345X\d+\//, '')}`;
// EDGAR's company_tickers.json -> { TICKER: cik } for the tickers wanted
export function cikMap(json, tickers = INSIDER_TICKERS) {
  const want = new Set(tickers), out = {};
  for (const x of Object.values(json || {})) { const t = String(x?.ticker || '').toUpperCase(); if (want.has(t) && x.cik_str != null) out[t] = Number(x.cik_str); }
  return out;
}

// ---------- summing up ----------
const DAY = 86400000;
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
// a group's open-market trades over the last `days`: buys vs sales (in $, trades and people), cluster buys, the
// totals per company and the newest trades
export function insiderSummary(trades, tickers, now, { days = 90, clusterDays = 30, recent = 20 } = {}) {
  const set = new Set(tickers), since = dayStr(now - days * DAY), cSince = dayStr(now - clusterDays * DAY);
  const xs = (Array.isArray(trades) ? trades : []).filter((t) => t && set.has(t.ticker) && CODES[t.code] && t.date && t.date >= since)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.usd || 0) - (a.usd || 0)));
  const side = (code) => {
    const ys = xs.filter((t) => t.code === code), usd = ys.reduce((a, t) => a + (t.usd || 0), 0), planned = ys.filter((t) => t.plan);
    return { n: ys.length, usd, people: new Set(ys.map((t) => `${t.ticker}|${t.owner}`)).size, planned: planned.length, plannedUsd: planned.reduce((a, t) => a + (t.usd || 0), 0) };
  };
  const by = {};
  for (const t of xs) if (t.code === 'P' && t.date >= cSince) {
    const c = (by[t.ticker] ||= { ticker: t.ticker, issuer: t.issuer, people: new Set(), usd: 0, last: t.date });
    c.people.add(t.owner); c.usd += t.usd || 0; if (t.date > c.last) c.last = t.date;
  }
  const clusters = Object.values(by).filter((c) => c.people.size >= 2).map((c) => ({ ...c, people: [...c.people] })).sort((a, b) => b.people.length - a.people.length || b.usd - a.usd);
  const companies = tickers.map((tk) => {
    const ys = xs.filter((t) => t.ticker === tk), sum = (c) => ys.filter((t) => t.code === c).reduce((a, t) => a + (t.usd || 0), 0);
    return { ticker: tk, issuer: ys[0]?.issuer || null, buys: ys.filter((t) => t.code === 'P').length, buyUsd: sum('P'), sales: ys.filter((t) => t.code === 'S').length, saleUsd: sum('S') };
  });
  return { days, buys: side('P'), sales: side('S'), clusters, companies, recent: xs.slice(0, recent) };
}
// the summary in plain words
export function insiderWords(s) {
  if (!s) return [];
  const out = [], m = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
  if (!s.buys.n && !s.sales.n) return [`No open-market buys or sales by insiders in the last ${s.days} days.`];
  out.push(s.buys.n ? `${s.buys.people} insider${s.buys.people === 1 ? '' : 's'} bought ${m(s.buys.usd)} of their own stock on the open market.` : 'No insider bought on the open market.');
  if (s.sales.n) {
    const own = s.sales.usd - s.sales.plannedUsd;
    out.push(`${s.sales.people} sold ${m(s.sales.usd)}${s.sales.plannedUsd > 0 ? `, ${m(s.sales.plannedUsd)} of it under pre-set 10b5\u20111 plans (${m(own)} by choice)` : ''}.`);
  }
  for (const c of s.clusters.slice(0, 3)) out.push(`Cluster buy: ${c.people.length} insiders of ${c.ticker} bought ${m(c.usd)} in the last 30 days.`);
  return out;
}
