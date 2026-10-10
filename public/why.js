// Why it moved: whenever BTC makes a real move (well beyond its usual 30-second wiggle), the chart explains it from
// the five exchanges' trades:
//   flow        who drove it: aggressive buyers or sellers, and by how much
//   thin book   the price moved AGAINST the heavier side: nobody was there to meet it (offers or bids pulled)
//   sweep       one big market order pushed through the book (the chart's bubbles, public/chart.js createImpact)
//   leader      the exchange that moved first, and how far ahead of the others
//   volume      a surge (several times the usual pace) or a move on light trading
//   target      it crossed the round's target, so the side that's winning flipped
// Pure functions (tested in test/why.test.js); app.js runs it every couple of seconds and tvchart.js draws it.
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const k$ = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
const d$ = (v) => `$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export const WHY = { windowMs: 30000, sigmas: 1.3, minMove: 15, gapMs: 30000 };

// The median of each exchange's latest price at time t (trades oldest first; only the last 30s before t count)
function midAt(trades, t) {
  const last = {};
  for (let i = trades.length - 1; i >= 0; i--) { const x = trades[i]; if (x.t > t) continue; if (x.t < t - 30000) break; if (!(x.ex in last)) last[x.ex] = x.price; }
  return median(Object.values(last));
}

// trades: [{ t, ex, side, price, size }] oldest first, ideally the last 10 minutes. impacts: the chart's market-moving
// orders. Returns a note, or null if nothing worth explaining happened (or it was just explained).
export function explainMove({ trades, impacts = [], now = Date.now(), sigmaMin = 0.0008, strike = null, strikeType = 'greater', last = null, opts = {} }) {
  const o = { ...WHY, ...opts };
  const from = now - o.windowMs;
  const p0 = midAt(trades, from), p1 = midAt(trades, now);
  if (!p0 || !p1) return null;
  const move = p1 - p0, dir = move > 0 ? 1 : -1;
  const need = Math.max(o.minMove, p1 * sigmaMin * Math.sqrt(o.windowMs / 60000) * o.sigmas);
  if (Math.abs(move) < need) return null;
  // don't repeat: a new note only after the gap, or when the move has gone a whole threshold further the same way
  if (last && now - last.t < o.gapMs && !(last.dir === dir && (p1 - last.price) * dir >= need)) return null;
  const up = dir > 0, win = trades.filter((x) => x.t > from && x.t <= now);
  const reasons = [];
  let tag = null;

  // a big order that swept the book the same way
  const sweep = impacts.filter((b) => b.t > from && b.t <= now && (b.side === 'buy') === up).sort((a, b) => b.move - a.move)[0];
  if (sweep) { reasons.push(`${sweep.whale ? '🐋 ' : ''}A ${k$(sweep.usd)} market ${sweep.side} on ${sweep.ex} swept the book ${up ? '+' : '−'}${d$(sweep.move)}`); tag = sweep.whale ? 'whale' : 'sweep'; }

  // flow: who was aggressive
  let buy = 0, sell = 0;
  for (const x of win) { const u = x.price * x.size; if (x.side === 'buy') buy += u; else sell += u; }
  const tot = buy + sell, withMove = up ? buy : sell, against = up ? sell : buy, share = tot > 0 ? withMove / tot : null;
  if (share != null && share >= 0.58) { reasons.push(`${up ? 'Buyers' : 'Sellers'} drove it: ${k$(withMove)} ${up ? 'bought' : 'sold'} vs ${k$(against)} ${up ? 'sold' : 'bought'} (${Math.round(share * 100)}%)`); tag ??= up ? 'buyers' : 'sellers'; }
  else if (share != null && share <= 0.45 && tot > 0) { reasons.push(`Not from ${up ? 'buying' : 'selling'}: ${up ? 'sellers' : 'buyers'} were heavier (${k$(against)} vs ${k$(withMove)}), so ${up ? 'sellers pulled their offers: a thin book above' : 'buyers pulled their bids: a thin book below'}`); tag ??= 'thin book'; }

  // the exchange that moved first: earliest to cover half the move from its own starting price
  const firsts = [];
  for (const ex of new Set(win.map((x) => x.ex))) {
    const own = win.filter((x) => x.ex === ex);
    const start = trades.filter((x) => x.ex === ex && x.t <= from).at(-1)?.price ?? own[0].price;
    const hit = own.find((x) => (x.price - start) * dir >= Math.abs(move) / 2);
    if (hit) firsts.push({ ex, t: hit.t });
  }
  firsts.sort((a, b) => a.t - b.t);
  if (firsts.length >= 3) {
    const lead = (median(firsts.slice(1).map((f) => f.t)) - firsts[0].t) / 1000;
    if (lead >= 2) { reasons.push(`${firsts[0].ex} moved first, ${Math.round(lead)}s ahead of the others`); tag ??= `${firsts[0].ex.replace('.US', '')} led`; }
  }

  // volume vs the usual pace (the rest of the trades given, up to 10 minutes)
  const older = trades.filter((x) => x.t <= from && x.t > now - 10 * 60000);
  const span = older.length ? Math.max(o.windowMs, from - older[0].t) : 0;
  if (span >= 3 * o.windowMs && tot > 0) {
    const usual = older.reduce((a, x) => a + x.price * x.size, 0) / span * o.windowMs, ratio = usual > 0 ? tot / usual : null;
    if (ratio >= 2) { reasons.push(`Volume surge: ${k$(tot)} in ${o.windowMs / 1000}s, ${ratio.toFixed(1)}× the usual pace`); tag ??= 'volume surge'; }
    else if (ratio != null && ratio <= 0.6) { reasons.push(`On light volume (${k$(tot)}, ${ratio.toFixed(1)}× the usual pace): it didn't take much to move it`); tag ??= 'light volume'; }
  }

  // crossing the target flips which side is winning
  if (strike && (p0 - strike) * (p1 - strike) < 0) {
    const yesNow = /^less/.test(strikeType || '') ? p1 < strike : p1 > strike;
    reasons.push(`Crossed the target ${d$(strike)}: now ${p1 > strike ? 'above' : 'below'} it, so ${yesNow ? 'UP' : 'DOWN'} is winning`);
    tag ??= 'crossed target';
  }
  if (!reasons.length) { reasons.push('No single cause: a steady drift on every exchange, neither side in a hurry'); tag = 'drift'; }
  return { t: now, dir: up ? 'up' : 'down', move, price: p1, secs: o.windowMs / 1000, tag, reasons, headline: `${up ? '▲' : '▼'} ${up ? '+' : '−'}${d$(move)} in ${o.windowMs / 1000}s` };
}
