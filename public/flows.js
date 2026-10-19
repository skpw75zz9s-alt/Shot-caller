// Money flows (v13.53): three outside sources, each a factor on the signal board's probation list until it proves
// itself on data it never trained on (flowsfeed.js fetches them; this file parses and tests them; pure).
//   etf      Farside's daily spot-ETF net flows (US$ m, BTC / ETH / SOL): money into the funds, published after the US
//            close, so day D's flow is tested against day D+1's move
//   stables  DefiLlama's total stablecoin supply: its 7-day change (fresh dollars arriving to buy with, or leaving),
//            tested against the next day's move
//   whale    Whale Alert's large on-chain transfers ($500k+, needs WHALE_ALERT_API_KEY): coins moved onto exchanges
//            (to sell) minus coins moved off them, over the last hour, tested against the next 15 minutes' move
// A daily reading holds for a whole day of rounds, so it's judged on days (not rounds): 96 rounds sharing one reading
// are one sample, not 96. Proven = right more often than chance on the newest 30% of days with z ≥ 2.5 (60+ days);
// whales: 100+ unseen hours. A proven factor's nudge is its edge scaled to the minutes left, so a daily edge moves a
// 15-minute round's odds by a fraction of a point (flowShift).
import { normCdf } from './model.js';

export const FLOWS = { trainShare: 0.7, zNeed: 2.5, minTestDays: 60, minTestHours: 100, whaleMin: 500000, farside: { BTC: 'btc', ETH: 'eth', SOL: 'sol' } };

// ---------- parsing ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// "(56.2)" is -56.2, "-" or "" is 0 (no flow that day), commas are thousands
export function flowNumber(s) {
  const t = text(s).replace(/,/g, '');
  if (t === '' || t === '-' || t === '–' || t === '—') return 0;
  const m = t.match(/^\((\d+(?:\.\d+)?)\)$/);
  if (m) return -Number(m[1]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
// Farside's table: one row per day ("11 Jan 2024", one cell per fund, then the day's Total); summary rows (Total,
// Average, Maximum, Minimum) and the header are skipped. Returns [{ date: 'YYYY-MM-DD', total }] oldest first.
export function parseFarside(html) {
  const out = new Map();
  for (const row of String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => c.replace(/^<t[dh][^>]*>|<\/t[dh]>$/gi, ''));
    if (cells.length < 2) continue;
    const d = text(cells[0]).match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
    if (!d || MONTHS[d[2].toLowerCase()] == null) continue;
    const total = flowNumber(cells.at(-1));
    if (total == null) continue;
    out.set(new Date(Date.UTC(+d[3], MONTHS[d[2].toLowerCase()], +d[1])).toISOString().slice(0, 10), total);
  }
  return [...out].map(([date, total]) => ({ date, total })).sort((a, b) => (a.date < b.date ? -1 : 1));
}
// DefiLlama's stablecoincharts/all: [{ date: unix seconds, totalCirculatingUSD: { peggedUSD, peggedEUR, … } }]
export function parseStables(json) {
  return (Array.isArray(json) ? json : []).map((r) => {
    const v = r?.totalCirculatingUSD && typeof r.totalCirculatingUSD === 'object' ? Object.values(r.totalCirculatingUSD).reduce((a, x) => a + (Number(x) || 0), 0) : null;
    return { date: new Date(Number(r?.date) * 1000).toISOString().slice(0, 10), usd: v };
  }).filter((r) => r.usd > 0 && r.date >= '2018').sort((a, b) => (a.date < b.date ? -1 : 1));
}
// the 7-day change of the supply, in %: one reading per day
export function stablesChange(rows, days = 7) {
  const out = [];
  for (let i = days; i < rows.length; i++) if (rows[i - days].usd > 0) out.push({ date: rows[i].date, value: (rows[i].usd / rows[i - days].usd - 1) * 100 });
  return out;
}
// Coinbase daily candles ([[time, low, high, open, close, vol], …], newest first) -> { 'YYYY-MM-DD': close }
export function dailyCloses(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) if (Array.isArray(r) && r[4] > 0) out[new Date(r[0] * 1000).toISOString().slice(0, 10)] = Number(r[4]);
  return out;
}
// Whale Alert's transactions: coins onto exchanges (to sell) count +, off exchanges -, exchange-to-exchange ignored
export function whaleNet(txs, symbol, since = 0) {
  let net = 0, n = 0;
  for (const t of Array.isArray(txs) ? txs : []) {
    if (!t || String(t.symbol).toLowerCase() !== String(symbol).toLowerCase() || !(t.timestamp * 1000 >= since)) continue;
    const toEx = t.to?.owner_type === 'exchange', fromEx = t.from?.owner_type === 'exchange', usd = Number(t.amount_usd) || 0;
    if (toEx && !fromEx) { net += usd; n++; } else if (fromEx && !toEx) { net -= usd; n++; }
  }
  return { net, n };
}

// ---------- testing ----------
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
// a reading's lean: +1 says up, -1 says down, 0 no read (dir: +1 with it, -1 fade it)
const leanOf = (v, dir) => (v > 0 ? dir : v < 0 ? -dir : 0);
function score(samples, dir) { // hits of lean vs outcome on samples with a read
  let n = 0, hits = 0;
  for (const s of samples) { const l = leanOf(s.value, dir); if (!l || !s.y) continue; n++; if (l === s.y) hits++; }
  return { n, hits, hit: n ? hits / n : null, z: n ? (hits - n / 2) / Math.sqrt(n / 4) : 0 };
}
// walk-forward: the direction (with the reading, or faded) picked on the older 70%, scored on the newest 30%
export function walkForward(samples, { minTest, zNeed = FLOWS.zNeed } = {}) {
  const k = Math.round(samples.length * FLOWS.trainShare), train = samples.slice(0, k), test = samples.slice(k);
  const dir = score(train, 1).hits >= score(train, -1).hits ? 1 : -1, tr = score(train, dir), te = score(test, dir);
  return { n: samples.length, dir, train: tr, test: te, proven: te.n >= minTest && te.z >= zNeed, need: minTest, zNeed };
}
// daily readings ([{ date, value }]) against the next day's move, from daily closes
export function dailySamples(readings, closes) {
  const out = [];
  for (const r of readings || []) {
    const a = closes[nextDay(r.date)], prev = closes[r.date];
    // day D's reading (published after D's close) vs D+1's move: close(D+1) against close(D)
    if (a > 0 && prev > 0 && a !== prev) out.push({ date: r.date, value: r.value, y: a > prev ? 1 : -1 });
  }
  return out;
}
export const dailyTest = (readings, closes) => ({ ...walkForward(dailySamples(readings, closes), { minTest: FLOWS.minTestDays }), unit: 'days',
  avgMove: (() => { const ds = Object.keys(closes).sort(), m = []; for (let i = 1; i < ds.length; i++) m.push(Math.abs(Math.log(closes[ds[i]] / closes[ds[i - 1]]))); return m.length ? m.reduce((a, x) => a + x, 0) / m.length : null; })() });
// whale samples: [{ at, value: net USD onto exchanges, y }] graded against the next 15 minutes' move
export const whaleTest = (samples) => ({ ...walkForward((samples || []).filter((s) => s.y), { minTest: FLOWS.minTestHours }), unit: 'hours' });

// ---------- in the calls ----------
// A proven factor's edge, as a nudge to the live round's P(YES): its hit rate h says the move over its horizon goes
// its way with probability h; the expected drift that implies (about (2h - 1) x the typical move) is scaled to the
// minutes left in the round, then turned into odds through the same normal model as the bot (distance and volatility).
// Capped at 2 points either way.
export function flowShift({ lean, hit, horizonMin, avgMove, minutesLeft, sigmaMin, spot, strike }) {
  if (!lean || !(hit > 0.5) || !(avgMove > 0) || !(minutesLeft > 0) || !(sigmaMin > 0) || !(spot > 0) || !(strike > 0)) return null;
  const drift = lean * (2 * hit - 1) * avgMove * Math.min(1, minutesLeft / horizonMin);
  const sd = sigmaMin * Math.sqrt(minutesLeft), d = Math.log(spot / strike);
  const shift = normCdf((d + drift) / sd) - normCdf(d / sd);
  return Math.max(-0.02, Math.min(0.02, shift));
}
