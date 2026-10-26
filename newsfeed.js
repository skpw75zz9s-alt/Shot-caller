// The News scout's feed (v13.74, public/news.js reads it): market news for every running market, from free sources
// with no key:
//   headlines  Google News search (RSS) for each asset (Bitcoin, the S&P 500, gold…), and CoinDesk's feed for crypto,
//              every NEWS_EVERY_MIN minutes (5); the last 6 hours, deduplicated
//   calendar   the week's economic calendar (ForexFactory's public JSON), every hour: the scheduled releases that move
//              every market at once (CPI, jobs, the Fed), with their impact
// The sources are settable (NEWS_GOOGLE, NEWS_COINDESK, NEWS_CALENDAR; NEWS=off turns it all off), so tests and the
// mock harness serve their own. Nothing here changes a call: the News scout informs the team (public/news.js).
const GOOGLE = 'https://news.google.com/rss/search', COINDESK = 'https://www.coindesk.com/arc/outboundfeeds/rss/', CALENDAR = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const QUERY = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana crypto', XRP: 'XRP crypto', DOGE: 'dogecoin', SPX: 'S&P 500 stocks', NDX: 'Nasdaq stocks', DJI: 'Dow Jones stocks', GOLD: 'gold price', SILVER: 'silver price', OIL: 'oil price' };
const KEEP_MS = 6 * 3600000;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? decode(m[1]) : ''; };
// RSS -> [{ t, title, source, link }] (Google's titles end in " - Source": split off)
export function parseRss(xml, fallbackSource = '') {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const it = m[1], t = Date.parse(tag(it, 'pubDate')), link = tag(it, 'link');
    let title = tag(it, 'title'), source = tag(it, 'source');
    const cut = title.lastIndexOf(' - ');
    if (cut > 20 && (!source || title.slice(cut + 3) === source)) { source ||= title.slice(cut + 3); title = title.slice(0, cut); }
    source ||= fallbackSource;
    if (title && Number.isFinite(t)) out.push({ t, title, source, link: /^https?:\/\//.test(link) ? link : null });
  }
  return out;
}
// the calendar -> [{ t, title, country, impact, forecast, previous }]
export function parseCalendar(list) {
  return (Array.isArray(list) ? list : []).map((e) => ({ t: Date.parse(e?.date), title: String(e?.title || '').slice(0, 120), country: String(e?.country || ''), impact: String(e?.impact || ''), forecast: e?.forecast || null, previous: e?.previous || null }))
    .filter((e) => Number.isFinite(e.t) && e.title);
}

export function createNewsFeed({ env = process.env, assets = () => ['BTC'], fetchText = defaultFetch, clock = () => Date.now(), log = console } = {}) {
  const on = env.NEWS !== 'off', every = Math.max(1, Number(env.NEWS_EVERY_MIN) || 5) * 60000;
  const google = env.NEWS_GOOGLE || GOOGLE, coindesk = env.NEWS_COINDESK || COINDESK, calendar = env.NEWS_CALENDAR || CALENDAR;
  const heads = new Map(), fetched = new Map(); // asset -> [headline]; asset -> ms
  let events = [], calAt = 0, err = null, okAt = 0, timer = null, busy = false;
  const add = (key, list) => {
    const now = clock(), seen = new Set(), all = [...list, ...(heads.get(key) || [])].filter((h) => h.t > now - KEEP_MS && h.t <= now + 300000)
      .filter((h) => { const k = h.title.toLowerCase().replace(/\W+/g, ' ').trim(); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => b.t - a.t).slice(0, 40);
    heads.set(key, all);
  };
  async function poll() {
    if (!on || busy) return;
    busy = true;
    const now = clock(), problems = [];
    try {
      for (const key of [...new Set(assets())].slice(0, 12)) {
        if (now - (fetched.get(key) ?? 0) < every) continue;
        fetched.set(key, now);
        const q = QUERY[key] || key;
        try { add(key, parseRss(await fetchText(`${google}?q=${encodeURIComponent(`${q} when:1d`)}&hl=en-US&gl=US&ceid=US:en`))); okAt = clock(); } catch (e) { problems.push(`Google News: ${e.message}`); }
        if (key === 'BTC') { // CoinDesk once per round of polls, filed under Bitcoin (it's crypto-wide: every coin's api reads it)
          try { add('BTC', parseRss(await fetchText(coindesk), 'CoinDesk')); okAt = clock(); } catch (e) { problems.push(`CoinDesk: ${e.message}`); }
        }
      }
      if (now - calAt >= 3600000) {
        calAt = now;
        try { events = parseCalendar(JSON.parse(await fetchText(calendar))); okAt = clock(); } catch (e) { problems.push(`calendar: ${e.message}`); }
      }
      err = problems.length && clock() - okAt > every * 2 ? problems[0] : null;
    } finally { busy = false; }
  }
  return {
    on: () => on,
    start() { if (!on || timer) return; poll().catch(() => {}); timer = setInterval(() => poll().catch((e) => log.warn?.('news poll failed', e.message)), 60000); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    poll,
    // asset -> { headlines (newest first), events (the next 24 h and the last hour), at, err }
    api(key = 'BTC', now = clock()) {
      const crypto = ['ETH', 'SOL', 'XRP', 'DOGE'].includes(key);
      const list = [...(heads.get(key) || []), ...(crypto ? (heads.get('BTC') || []).filter((h) => h.source === 'CoinDesk') : [])].sort((a, b) => b.t - a.t).slice(0, 25);
      return { on, headlines: list, events: events.filter((e) => e.t > now - 3600000 && e.t < now + 86400000).sort((a, b) => a.t - b.t), at: okAt || null, err };
    },
  };
}
async function defaultFetch(url) {
  const r = await fetch(url, { headers: { accept: 'application/rss+xml, application/json, text/xml', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
