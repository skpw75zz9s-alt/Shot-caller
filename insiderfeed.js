// Insider traders on the server (v13.55; public/insiders.js parses and sums them up): the SEC's Form 4 filings for the
// companies tied to the markets, from EDGAR (free, no key). One shared reader for every market.
//
// It works only while someone looks: opening the Insiders tab (/api/insiders) starts a pass when the data is more than
// 30 minutes old, and nothing runs between looks. A pass reads each company's filing list and the Form 4s it hasn't
// read yet, at most 4 requests a second (the SEC allows 10), and keeps 180 days of buys and sales in DATA_DIR/insiders.json.
//
// The SEC asks every program that reads EDGAR to name a contact in its User-Agent and may refuse ones that don't: set
// SEC_USER_AGENT in Railway (for example "Shot Caller you@example.com"). INSIDERS=off turns it off.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CODES, INSIDER_GROUPS, cikMap, form4Path, groupFor, insiderSummary, insiderWords, parseForm4, recentForm4s } from './public/insiders.js';

const MIN = 60000, DAY = 86400000;
export const INSIDER_FEED = { staleMs: 30 * MIN, gapMs: 250, keepDays: 180, firstDays: 120, perCompany: 40, ciksMs: DAY };

export function createInsiderFeed({ file, fetchImpl = (...a) => fetch(...a), env = process.env, clock = () => Date.now(), log = console, groups = INSIDER_GROUPS }) {
  const on = env.INSIDERS !== 'off', ua = (env.SEC_USER_AGENT || '').trim();
  const www = (env.SEC_API || 'https://www.sec.gov').replace(/\/$/, ''), data = (env.SEC_DATA_API || 'https://data.sec.gov').replace(/\/$/, '');
  const tickers = [...new Set(Object.values(groups).flatMap((g) => g.tickers))];
  let s = { ciks: {}, ciksAt: 0, seen: {}, trades: [], companies: {}, lastRun: 0 }, running = null, err = null, progress = null, last = 0, loaded = false;

  async function get(url) {
    const wait = last + INSIDER_FEED.gapMs - clock();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = clock();
    const r = await fetchImpl(url, { headers: { 'user-agent': ua || 'ShotCaller insider-trades reader', accept: 'application/json, application/xml, text/xml' }, signal: AbortSignal.timeout?.(15000) });
    if (r.status === 403 || r.status === 429) throw new Error(`the SEC refused the request (${r.status})${ua ? '' : ': set SEC_USER_AGENT in Railway to a name and contact email, as the SEC asks'}`);
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r;
  }
  async function company(tk, now) {
    const cik = s.ciks[tk];
    if (!cik) throw new Error('not found in the SEC\'s ticker list');
    const sub = await (await get(`${data}/submissions/CIK${String(cik).padStart(10, '0')}.json`)).json();
    const since = new Date(now - INSIDER_FEED.firstDays * DAY).toISOString().slice(0, 10);
    const todo = recentForm4s(sub, { since }).filter((f) => !s.seen[f.acc]).slice(0, INSIDER_FEED.perCompany);
    let added = 0;
    for (const f of todo) {
      const doc = parseForm4(await (await get(`${www}${form4Path(cik, f.acc, f.doc)}`)).text(), { acc: f.acc });
      s.seen[f.acc] = f.filed;
      for (const t of doc?.trades || []) if (CODES[t.code]) { s.trades.push({ ...t, ticker: t.ticker || tk, filed: f.filed }); added++; }
    }
    return { name: sub?.name || null, read: todo.length, added };
  }
  async function pass() {
    const now = clock();
    let problem = null; // the last pass's problem stays on show while the next one runs
    if (now - s.ciksAt > INSIDER_FEED.ciksMs || tickers.some((t) => !s.ciks[t] && now - s.ciksAt > 6 * 3600000)) {
      try { const m = cikMap(await (await get(`${www}/files/company_tickers.json`)).json(), tickers); if (!Object.keys(m).length) throw new Error('the SEC\'s ticker list came back empty'); s.ciks = m; s.ciksAt = now; }
      catch (e) { problem = String(e?.message || e); if (!Object.keys(s.ciks).length) { err = problem; return; } }
    }
    // stalest first, so a pass cut short by a restart picks up where it left off
    const due = tickers.filter((t) => now - (s.companies[t]?.at || 0) >= INSIDER_FEED.staleMs).sort((a, b) => (s.companies[a]?.at || 0) - (s.companies[b]?.at || 0));
    progress = { done: 0, total: due.length };
    for (const tk of due) {
      try { const r = await company(tk, clock()); s.companies[tk] = { at: clock(), err: null, name: r.name, read: r.read }; }
      catch (e) { const m = String(e?.message || e); s.companies[tk] = { ...s.companies[tk], at: clock(), err: m }; if (/refused/.test(m)) { problem = m; break; } }
      progress.done++;
      if (progress.done % 5 === 0) await save();
    }
    const keep = new Date(clock() - INSIDER_FEED.keepDays * DAY).toISOString().slice(0, 10);
    s.trades = s.trades.filter((t) => (t.date || t.filed) >= keep);
    for (const [acc, d] of Object.entries(s.seen)) if (d < keep) delete s.seen[acc];
    s.lastRun = clock(); progress = null; err = problem;
    await save();
  }
  // start a pass when the data is stale (and none is running); returns it, for tests
  const stale = (now) => tickers.some((t) => now - (s.companies[t]?.at || 0) >= INSIDER_FEED.staleMs);
  function touch() {
    if (!on || running) return running;
    if (loaded && !stale(clock())) return null;
    running = (async () => { if (!loaded) await load(); if (stale(clock())) await pass(); })().catch((e) => { err = String(e?.message || e); log.error?.('insider trades failed', err); }).finally(() => { running = null; });
    return running;
  }
  async function load() {
    loaded = true;
    try { const j = JSON.parse(await readFile(file, 'utf8')); if (j && typeof j === 'object') s = { ...s, ...j, trades: Array.isArray(j.trades) ? j.trades : [] }; } catch { /* none yet */ }
  }
  async function save() {
    try { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(s)); await rename(`${file}.tmp`, file); }
    catch (e) { log.error?.('saving insider trades failed', e.message); }
  }
  // the tab: the market's group first, then the others
  function api(asset, now = clock()) {
    if (!on) return { on: false, why: 'INSIDERS=off' };
    touch();
    const mine = groups[groupFor(asset)] ? groupFor(asset) : Object.keys(groups)[0], order = [mine, ...Object.keys(groups).filter((k) => k !== mine)];
    return {
      on: true, ua: !!ua, err, running: !!running, progress, updated: s.lastRun || null,
      groups: order.map((k) => { const g = groups[k], sum = insiderSummary(s.trades, g.tickers, now); return { key: k, name: g.name, why: g.why, tickers: g.tickers, mine: k === mine, summary: sum, words: insiderWords(sum), errors: g.tickers.filter((t) => s.companies[t]?.err).map((t) => ({ ticker: t, err: s.companies[t].err })) }; }),
    };
  }
  return { load, touch, api, tickers: () => tickers };
}
