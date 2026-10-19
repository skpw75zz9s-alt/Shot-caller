// The X-ray tab (v13.58): a scanner sweeps the live round like an x-ray film, hunts for breaks in the market (places
// where it is out of line with itself: a jump, a breakout, Kalshi lagging or far from fair, a broken book, one exchange
// splitting from the rest, one-sided flow, a volatility shift, a liquidation burst) and shows the stats under the surface:
// numbers that help but nobody looks at (how often the price crosses the target on the way, how much the clock is worth,
// what a contract really costs to get in and out of, how much of the settlement is already locked in…). Pure: the tab
// (app.js renderXray) passes what the phone and the server already collect. Context only; none of it is a call.
import { kalshiFee, normCdf } from './model.js';

const pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const money = (v) => { const a = Math.abs(v); return a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `$${Math.round(a)}`; };
const cents = (p) => `${Math.round(p * 100)}¢`;

// ---------- readers (also used by /api/xray) ----------
// this round's Kalshi orders ([{ t, side: 'YES'|'NO', count, price, usd }])
export function kalshiBig(trades) {
  const xs = Array.isArray(trades) ? trades.filter((x) => x && x.usd > 0) : [];
  const sum = (side) => xs.filter((x) => x.side === side).reduce((a, x) => ({ usd: a.usd + x.usd, n: a.n + 1 }), { usd: 0, n: 0 });
  const up = sum('YES'), down = sum('NO');
  return { up, down, n: xs.length, total: up.usd + down.usd, biggest: xs.reduce((a, x) => Math.max(a, x.usd), 0) };
}
// liquidations in a window ([{ t, ex, liq: 'long'|'short', usd, price }])
export function liqSummary(liqs, now, windowMs = 1800000) {
  const xs = (Array.isArray(liqs) ? liqs : []).filter((x) => x && x.t >= now - windowMs);
  const long = xs.filter((x) => x.liq === 'long').reduce((a, x) => a + x.usd, 0), short = xs.filter((x) => x.liq === 'short').reduce((a, x) => a + x.usd, 0);
  return { n: xs.length, long, short, minutes: Math.round(windowMs / 60000) };
}
// futures positioning (Hyperliquid's context: funding is per hour)
export function positioning(ctx) {
  if (!ctx) return null;
  const f = Number.isFinite(ctx.funding) ? ctx.funding : null;
  return { funding: f, fundingYear: f != null ? f * 24 * 365 : null, oiChange5: Number.isFinite(ctx.oiChange5) ? ctx.oiChange5 : null, live: !!ctx.live };
}
// where the price is against the target for the time left (sigmaMin: per-minute log volatility)
export function distance({ spot, strike, sigmaMin, minutesLeft }) {
  if (!(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0)) return null;
  const sd = sigmaMin * Math.sqrt(minutesLeft);
  return { gap: spot - strike, move: spot * sd, sd, z: Math.log(spot / strike) / sd };
}
// a round step for "per $X" (1, 2 or 5 x a power of ten), near the value given
export function niceStep(v) {
  if (!(v > 0)) return null;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
// how many times the price crossed the target, from the round's one-minute closes and the live price
export function crossings(closes, strike) {
  let n = 0, prev = 0;
  for (const c of closes || []) { if (!(c > 0)) continue; const s = Math.sign(c - strike); if (s && prev && s !== prev) n++; if (s) prev = s; }
  return n;
}

// ---------- the hidden stats ----------
// each: { key, label, value, note (why it helps), tone: 'pos' | 'neg' | '' }
export function hiddenStats(x) {
  const out = [], lv = x.live, fmt = x.fmt || ((v) => `$${Number(v).toFixed(2)}`), crypto = x.kind === 'crypto';
  const d = lv ? distance(lv) : null, ahead = d ? (d.gap >= 0 ? 'above' : 'below') : null, az = d ? Math.abs(d.z) : null;
  if (d) {
    // reflection principle: a driftless price that ends beyond the target touched it on the way as often again
    const touch = Math.min(1, 2 * normCdf(-az));
    out.push({ key: 'cross', label: 'Cross chance', value: `${Math.round(touch * 100)}%`, tone: touch > 0.5 ? 'neg' : '',
      note: `How often the price touches the target before the close from ${az.toFixed(2)} typical moves away. A touch isn't a loss: it has to finish ${ahead === 'above' ? 'below' : 'above'} it.` });
    if (lv.minutesLeft > 1) {
      const gain = (normCdf(az * Math.sqrt(lv.minutesLeft / (lv.minutesLeft - 1))) - normCdf(az)) * 100;
      out.push({ key: 'theta', label: 'Clock value', value: `+${gain.toFixed(1)} pts/min`, tone: gain >= 1 ? 'pos' : '',
        note: `What one more minute with the price standing still adds to the side ${ahead} the target. The leader gains just by waiting.` });
    }
    const step = niceStep(d.move / 10), per = (pdf(d.z) / d.sd) * (step / lv.spot) * 100;
    out.push({ key: 'delta', label: 'Odds per move', value: `${per.toFixed(1)} pts per ${fmt(step)}`, tone: '',
      note: `How far the odds swing for each ${fmt(step)} the price moves now. It grows as the close nears with the price near the target.` });
  }
  // the costs nobody adds up: break-even and the round trip
  if (lv?.yesAsk != null && lv?.yesBid != null && lv.pYes != null) {
    const up = lv.pYes >= 0.5, ask = up ? lv.yesAsk : 1 - lv.yesBid, bid = up ? lv.yesBid : 1 - lv.yesAsk, fee = kalshiFee(ask);
    if (ask > 0 && ask < 1) {
      const be = ask + fee, p = up ? lv.pYes : 1 - lv.pYes, edge = (p - be) * 100;
      out.push({ key: 'breakeven', label: 'Break-even', value: `${(be * 100).toFixed(1)}% wins`, tone: edge > 0 ? 'pos' : 'neg',
        note: `${up ? 'UP' : 'DOWN'} at ${cents(ask)} plus a ${cents(fee)} fee has to win this often just to break even. The bot gives it ${(p * 100).toFixed(1)}%: ${edge >= 0 ? `${edge.toFixed(1)} points to spare` : `${(-edge).toFixed(1)} points short`}.` });
      const trip = ask - bid + fee + kalshiFee(bid);
      out.push({ key: 'toll', label: 'Round-trip toll', value: `${cents(trip)} · ${Math.round(trip / ask * 100)}%`, tone: trip / ask > 0.1 ? 'neg' : '',
        note: `Buying ${up ? 'UP' : 'DOWN'} and selling it straight back costs ${cents(trip)} a contract (the spread and both fees): ${Math.round(trip / ask * 100)}% of the stake gone before the price moves.` });
    }
  }
  // the round so far
  if (lv && Array.isArray(x.closes) && x.closes.length) {
    const cs = [...x.closes, lv.spot].filter((c) => c > 0), n = crossings(cs, lv.strike), hi = Math.max(...cs), lo = Math.min(...cs);
    out.push({ key: 'crossings', label: 'Target crossings', value: `${n}×`, tone: n >= 3 ? 'neg' : '',
      note: `Times the price has crossed the target this round (one-minute closes), in a ${fmt(hi - lo)} range. Many crossings mean a choppy round where the lead keeps changing.` });
  }
  if (d && lv.sigmaLong > 0) {
    const r = lv.sigmaMin / lv.sigmaLong;
    out.push({ key: 'regime', label: 'Volatility vs normal', value: `${r.toFixed(2)}×`, tone: r > 1.4 ? 'neg' : r < 0.75 ? 'pos' : '',
      note: `${r > 1.4 ? 'Wild' : r < 0.75 ? 'Calm' : 'Normal'}: a typical move in the time left is ±${fmt(d.move)}. Wild rounds flip more; calm ones tend to stay put.` });
  }
  if (lv && crypto && x.settle === 'avg60') {
    const s = lv.minutesLeft * 60, locked = s < 60 ? Math.min(1, (60 - s) / 60) : 0;
    out.push({ key: 'lockin', label: 'Settlement locked in', value: s < 60 ? `${Math.round(locked * 100)}%` : '1/60 per sec', tone: locked >= 0.5 ? 'pos' : '',
      note: 'Kalshi settles on the average of the last 60 seconds, so each second counts 1/60: a last-second spike barely moves it, and in the final minute the part already averaged can\'t change.' });
  }
  // the exchanges' pace (crypto): trades in the last minute against the last 10 minutes' average
  if (crypto && Array.isArray(x.trades) && x.now) {
    const last = x.trades.filter((t) => t.t >= x.now - 60000).length, ten = x.trades.filter((t) => t.t >= x.now - 600000).length;
    if (ten >= 20) {
      const r = last / (ten / 10);
      out.push({ key: 'pace', label: 'Trade pace', value: `${r.toFixed(1)}× · ${last}/min`, tone: r > 2 ? 'neg' : '',
        note: 'Exchange trades in the last minute against the last 10 minutes\' average. A sudden burst often comes right before (or during) a real move.' });
    }
  }
  // the Kalshi crowd: order sizes say who's trading
  const k = kalshiBig(x.kalshiTrades);
  if (k.n) out.push({ key: 'crowd', label: 'Average Kalshi order', value: `${money(k.total / k.n)} · ${k.n} orders`, tone: '',
    note: `This round's Kalshi orders average ${money(k.total / k.n)} (the biggest ${money(k.biggest)}). Small averages are many small traders; a few big orders can push the price on their own.` });
  // what leverage costs (crypto): funding per year
  const fy = x.srv?.futures?.fundingYear;
  if (crypto && fy != null && Number.isFinite(fy)) out.push({ key: 'funding', label: 'Cost to hold leverage', value: `${fy >= 0 ? 'longs' : 'shorts'} pay ${Math.abs(fy * 100).toFixed(1)}%/yr`, tone: Math.abs(fy) > 0.3 ? 'neg' : '',
    note: `Futures funding, per year. ${Math.abs(fy) > 0.3 ? 'That expensive means one side is crowded, and crowded trades tend to unwind against the crowd.' : 'Cheap: neither side is crowded.'}` });
  const lq = x.srv?.liqs;
  if (crypto && lq?.n) out.push({ key: 'liqs', label: 'Forced closes', value: `${money(lq.long + lq.short)} · ${lq.minutes} min`, tone: '',
    note: `Futures traders force-closed in the last ${lq.minutes} minutes: longs ${money(lq.long)} (forced selling), shorts ${money(lq.short)} (forced buying). Big bursts move the price for a few minutes.` });
  return out;
}

// ---------- the film ----------
// The round as an x-ray: the price path is the spine, each minute a rib, the target a dashed line, the typical move to
// the close a soft-tissue cone, and the bones (crossings, high, low, now) glow. bars: [{ t, c }] one-minute closes.
export function xraySvg({ bars = [], spot, strike, open, close, now, sigmaMin, breaks = [], W = 320, H = 170 }) {
  if (!(close > open) || !(strike > 0)) return { svg: '', ok: false };
  const pts = [...bars.filter((b) => b && b.t >= open && b.t <= now && b.c > 0).map((b) => ({ t: b.t, c: b.c })), ...(spot > 0 ? [{ t: Math.min(now, close), c: spot }] : [])];
  const left = Math.max(0, close - now) / 60000, cone = spot > 0 && sigmaMin > 0 && left > 0 ? spot * sigmaMin * Math.sqrt(left) : 0;
  const vals = [strike, ...pts.map((p) => p.c), ...(cone ? [spot + cone, spot - cone] : [])];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || strike * 0.001) * 0.18; lo -= pad; hi += pad;
  const X = (t) => ((t - open) / (close - open)) * W, Y = (v) => H - ((v - lo) / (hi - lo)) * H, f = (n) => n.toFixed(1);
  const ribs = []; for (let t = open; t <= close; t += 60000) ribs.push(`<line class="rib" x1="${f(X(t))}" x2="${f(X(t))}" y1="0" y2="${H}"/>`);
  const line = pts.map((p) => `${f(X(p.t))},${f(Y(p.c))}`).join('L');
  const path = pts.length > 1 ? `<path class="spine-glow" d="M${line}"/><path class="spine" d="M${line}"/>` : '';
  const bones = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.c - strike) * (b.c - strike) < 0) { const k = (strike - a.c) / (b.c - a.c); bones.push(`<circle class="bone cross" cx="${f(X(a.t + k * (b.t - a.t)))}" cy="${f(Y(strike))}" r="3"/>`); }
  }
  if (pts.length > 1) {
    const h = pts.reduce((a, p) => (p.c > a.c ? p : a)), l = pts.reduce((a, p) => (p.c < a.c ? p : a));
    bones.push(`<circle class="bone hi" cx="${f(X(h.t))}" cy="${f(Y(h.c))}" r="2.5"/>`, `<circle class="bone lo" cx="${f(X(l.t))}" cy="${f(Y(l.c))}" r="2.5"/>`);
  }
  const last = pts.at(-1);
  const tissue = cone && last ? `<path class="tissue" d="M${f(X(last.t))},${f(Y(spot))}L${f(W)},${f(Y(spot + cone))}L${f(W)},${f(Y(spot - cone))}Z"/>` : '';
  // a fracture where each break was found: a jagged crack across the spine, open ones red, healed ones faint
  const cracks = breaks.filter((b) => b.at >= open && b.at <= close).map((b) => {
    const near = pts.reduce((a, p) => (!a || Math.abs(p.t - b.at) < Math.abs(a.t - b.at) ? p : a), null);
    const cx = X(b.at), cy = Y(b.price > 0 ? b.price : near?.c ?? strike), h = 7 + b.sev * 3;
    return `<path class="crack s${b.sev}${b.open ? ' open' : ''}" d="M${f(cx - 2)},${f(cy - h)}L${f(cx + 2)},${f(cy - h / 3)}L${f(cx - 2)},${f(cy + h / 3)}L${f(cx + 2)},${f(cy + h)}"/>`;
  });
  const svg = `${ribs.join('')}${tissue}<line class="target" x1="0" x2="${W}" y1="${f(Y(strike))}" y2="${f(Y(strike))}"/>${path}${bones.join('')}`
    + cracks.join('') + (last ? `<circle class="bone now" cx="${f(X(last.t))}" cy="${f(Y(last.c))}" r="4"/>` : '');
  return { svg, ok: pts.length > 0 };
}

// ---------- breaks ----------
// Each detector looks for one way the market can be out of line with itself, right now or earlier in the round: a
// jump, a breakout, Kalshi lagging or disagreeing with the bot, UP and DOWN prices that don't add up, high flip risk, a
// market shift (odds swings, a lead change, the price and Kalshi pulling apart), an exchange split, one-sided flow…
// A break: { key (one per kind and time, so a log can follow it), kind, at, price, sev 1-3, title, detail, means }.
// None of them is graded yet: they're places to look, not trades.
export const BREAKS = {
  jump: 3,          // a one-minute move of 3+ typical one-minute moves (5+ is severe)
  spike: 2.5,       // the last 15 seconds moved 2.5+ typical 15-second moves
  lagMove: 0.08,    // the bot's odds moved 8+ points in 30 seconds…
  lagStill: 0.02,   // …while Kalshi's quote moved 2 or less
  gap: 0.15,        // Kalshi 15+ points from the bot's odds (25+ severe)
  disagree: 0.08,   // UP + DOWN prices adding to 108¢ or more (115+ severe): the two sides disagree
  flip: 0.4,        // flip risk 40+ (60+ severe): the hold odds, or a late toss-up (leader at 65% or less, 5 minutes or less left)
  swing: 0.2,       // the bot's odds, or Kalshi's, moved 20+ points in a minute (35+ severe)
  diverge: 0.05,    // the bot's odds and Kalshi's moved 5+ points in opposite directions in a minute
  split: 1.5,       // one exchange 1.5+ typical one-minute moves away from the others' median
  flowShare: 0.8,   // 80%+ of the last minute's dollars on one side…
  flowBurst: 2,     // …with 2x the usual dollars a minute
  regime: 2,        // volatility at 2x normal
  bigOrder: 0.35,   // one Kalshi order 35%+ of the round's dollars ($500+)
  liqs: 2e6,        // $2M+ of forced closes in 30 minutes
};
const median = (xs) => { const a = [...xs].sort((p, q) => p - q), m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : null; };
const minuteKey = (t) => Math.floor(t / 60000);
export function findBreaks(x) {
  const out = [], lv = x.live, now = x.now, fmt = x.fmt || ((v) => `$${Number(v).toFixed(2)}`), crypto = x.kind === 'crypto';
  const spot = lv?.spot, typ = spot > 0 && lv?.sigmaMin > 0 ? spot * lv.sigmaMin : null; // a typical one-minute move, in $
  const bars = (x.bars || []).filter((b) => b && b.c > 0);
  // jumps: one-minute closes that moved far more than a typical minute
  if (typ) for (let i = 1; i < bars.length; i++) {
    const mv = bars[i].c - bars[i - 1].c, k = Math.abs(mv) / typ;
    if (k >= BREAKS.jump) out.push({ key: `jump:${minuteKey(bars[i].t)}`, kind: 'jump', at: bars[i].t, price: bars[i].c, sev: k >= 5 ? 3 : 2,
      title: `${mv > 0 ? 'Jump up' : 'Drop'} of ${fmt(Math.abs(mv))} in a minute`, detail: `${k.toFixed(1)}× a typical minute's move.`,
      means: 'A jump this size usually comes from news, a big order or a burst of liquidations; the next minutes often stay jumpy.' });
  }
  // a spike right now, from the exchange trades (crypto)
  if (typ && crypto && Array.isArray(x.trades)) {
    const at = (t0) => median(x.trades.filter((t) => t.t >= t0 - 5000 && t.t <= t0).map((t) => t.price));
    const a = at(now - 15000), b = at(now), lim = BREAKS.spike * typ * Math.sqrt(0.25);
    if (a && b && Math.abs(b - a) >= lim) out.push({ key: `spike:${minuteKey(now)}`, kind: 'spike', at: now, price: b, sev: Math.abs(b - a) >= 2 * lim ? 3 : 2,
      title: `${b > a ? 'Spiking up' : 'Plunging'}: ${fmt(Math.abs(b - a))} in 15 seconds`, detail: `${(Math.abs(b - a) / (typ * 0.5)).toFixed(1)}× a typical 15 seconds.`,
      means: 'A move this fast is often an order sweeping the book. Kalshi\'s prices can lag it for a few seconds.' });
  }
  // a breakout: the round's price beyond the 15 minutes before it
  const pre = (x.preBars || []).filter((b) => b && b.c > 0);
  if (pre.length >= 5 && bars.length) {
    const hi = Math.max(...pre.map((b) => b.h ?? b.c)), lo = Math.min(...pre.map((b) => b.l ?? b.c));
    const up = bars.find((b) => b.c > hi), dn = bars.find((b) => b.c < lo);
    if (up) out.push({ key: `breakout:up`, kind: 'breakout', at: up.t, price: up.c, sev: 1, title: `Broke above the last 15 minutes' high (${fmt(hi)})`, detail: `Closed at ${fmt(up.c)}.`,
      means: 'A breakout either runs (new buyers) or fails back into the range (a trap). Watch whether it holds.' });
    if (dn) out.push({ key: `breakout:down`, kind: 'breakout', at: dn.t, price: dn.c, sev: 1, title: `Broke below the last 15 minutes' low (${fmt(lo)})`, detail: `Closed at ${fmt(dn.c)}.`,
      means: 'A breakdown either runs (new sellers) or snaps back into the range (a trap). Watch whether it holds.' });
  }
  // Kalshi: lagging, far from fair, or a broken book
  const q = lv && lv.yesAsk != null && lv.yesBid != null ? lv : null, mid = q ? (q.yesAsk + q.yesBid) / 2 : null;
  const log = (x.quoteLog || []).filter((e) => e && e.t >= now - 32000 && e.p != null && e.yesAsk != null && e.noAsk != null);
  if (log.length >= 2) {
    const a = log[0], b = log.at(-1), mA = (a.yesAsk + 1 - a.noAsk) / 2, mB = (b.yesAsk + 1 - b.noAsk) / 2, dp = b.p - a.p, dm = mB - mA;
    if (Math.abs(dp) >= BREAKS.lagMove && Math.abs(dm) <= BREAKS.lagStill) out.push({ key: 'lag', kind: 'lag', at: now, price: null, sev: 2,
      title: 'Kalshi is lagging the price', detail: `The price moved the odds ${Math.round(Math.abs(dp) * 100)} points ${dp > 0 ? 'toward UP' : 'toward DOWN'} in ${Math.round((b.t - a.t) / 1000)} seconds; Kalshi's quote moved ${Math.round(Math.abs(dm) * 100)}.`,
      means: 'Kalshi usually catches up within seconds to a minute. Until it does, its price is stale.' });
  }
  if (q && lv.pYes != null) {
    const g = lv.pYes - mid;
    if (Math.abs(g) >= BREAKS.gap) out.push({ key: 'gap', kind: 'gap', at: now, price: null, sev: Math.abs(g) >= 0.25 ? 3 : 2,
      title: `Bot and Kalshi disagree by ${Math.round(Math.abs(g) * 100)} points`, detail: `The bot says ${Math.round(lv.pYes * 100)}% UP; Kalshi's traders ${Math.round(mid * 100)}%.`,
      means: 'Either Kalshi is slow or it knows something the price doesn\'t show yet. A gap this wide is a place to be careful, not a sure thing.' });
  }
  // the UP and DOWN prices against each other: together they should cost about $1
  if (q) {
    const noAsk = lv.noAsk ?? 1 - q.yesBid, sum = q.yesAsk + noAsk, both = `UP ${cents(q.yesAsk)} + DOWN ${cents(noAsk)} = ${Math.round(sum * 100)}¢`;
    if (sum < 0.995 || q.yesBid >= q.yesAsk) out.push({ key: 'crossed', kind: 'book', at: now, price: null, sev: 3, title: 'UP and DOWN cost less than $1 together', detail: `${both}.`,
      means: 'A crossed book: a glitch or a quote in flight. It rarely lasts more than a moment.' });
    else if (sum - 1 >= BREAKS.disagree) out.push({ key: 'disagree', kind: 'book', at: now, price: null, sev: sum - 1 >= 0.15 ? 2 : 1,
      title: `UP and DOWN prices disagree by ${Math.round((sum - 1) * 100)}¢`, detail: `${both}: a fair pair adds to about 100¢.`,
      means: 'The two sides can\'t agree on the price: few orders resting, so getting in and out costs more and one order can move it.' });
  }
  // high flip risk: the hold odds (the chance the call's side stays ahead to the close), else a late toss-up
  if (lv?.pYes != null) {
    const lead = Math.max(lv.pYes, 1 - lv.pYes), side = lv.pYes >= 0.5 ? 'UP' : 'DOWN';
    const risk = lv.hold != null ? 1 - lv.hold : lv.minutesLeft <= 5 && lead <= 0.65 ? 1 - lead : null;
    if (risk != null && risk >= BREAKS.flip) out.push({ key: 'flip', kind: 'flip', at: now, price: null, sev: risk >= 0.6 ? 3 : 2,
      title: `High flip risk: ${Math.round(risk * 100)}/100`, detail: lv.hold != null ? `Hold odds ${Math.round(lv.hold * 100)}% on ${lv.holdSide === 'NO' ? 'DOWN' : lv.holdSide === 'YES' ? 'UP' : side} (300 simulated paths).` : `${side} leads at only ${Math.round(lead * 100)}% with ${Math.max(0, lv.minutesLeft).toFixed(1)} minutes left.`,
      means: 'The side ahead can easily lose its lead before the close. A late toss-up is where rounds flip.' });
  }
  // market shifts over the last minute: the odds swinging, the lead changing hands, the price and Kalshi pulling apart
  const min = (x.quoteLog || []).filter((e) => e && e.t >= now - 62000 && e.p != null);
  if (min.length >= 2) {
    const a = min[0], b = min.at(-1), secs = Math.round((b.t - a.t) / 1000), dp = b.p - a.p;
    const km = (e) => (e.yesAsk != null && e.noAsk != null ? (e.yesAsk + 1 - e.noAsk) / 2 : null), dk = km(a) != null && km(b) != null ? km(b) - km(a) : null;
    if (Math.abs(dp) >= BREAKS.swing) out.push({ key: 'swing:bot', kind: 'shift', at: now, price: null, sev: Math.abs(dp) >= 0.35 ? 3 : 2,
      title: `Odds swing: ${Math.round(Math.abs(dp) * 100)} points ${dp > 0 ? 'toward UP' : 'toward DOWN'}`, detail: `The bot's UP odds went ${Math.round(a.p * 100)}% → ${Math.round(b.p * 100)}% in ${secs} seconds.`,
      means: 'The market shifted fast. Calls made before the swing were made on a different market.' });
    if (dk != null && Math.abs(dk) >= BREAKS.swing) out.push({ key: 'swing:kalshi', kind: 'shift', at: now, price: null, sev: Math.abs(dk) >= 0.35 ? 3 : 2,
      title: `Kalshi swing: ${Math.round(Math.abs(dk) * 100)} points ${dk > 0 ? 'toward UP' : 'toward DOWN'}`, detail: `Kalshi's UP price went ${Math.round(km(a) * 100)}¢ → ${Math.round(km(b) * 100)}¢ in ${secs} seconds.`,
      means: 'Kalshi\'s traders changed their minds fast: news, a big order, or a move they saw first.' });
    if (dk != null && Math.abs(dp) >= BREAKS.diverge && Math.abs(dk) >= BREAKS.diverge && Math.sign(dp) !== Math.sign(dk)) out.push({ key: 'diverge', kind: 'shift', at: now, price: null, sev: 2,
      title: 'The price and Kalshi are moving opposite ways', detail: `In ${secs} seconds the bot's odds moved ${Math.round(Math.abs(dp) * 100)} points ${dp > 0 ? 'UP' : 'DOWN'}, Kalshi's ${Math.round(Math.abs(dk) * 100)} ${dk > 0 ? 'UP' : 'DOWN'}.`,
      means: 'One of them is wrong. Kalshi may know something the price doesn\'t show, or be about to snap back.' });
    if (lv?.strike > 0 && a.s > 0 && b.s > 0) {
      const cross = min.findIndex((e, i) => i > 0 && e.s > 0 && min[i - 1].s > 0 && (e.s - lv.strike) * (min[i - 1].s - lv.strike) < 0);
      if (cross > 0) out.push({ key: `lead:${minuteKey(min[cross].t)}`, kind: 'shift', at: min[cross].t, price: lv.strike, sev: 2,
        title: `Lead change: now ${min[cross].s > lv.strike ? 'UP' : 'DOWN'}`, detail: `The price crossed the target (${fmt(lv.strike)}) ${Math.round((now - min[cross].t) / 1000)} seconds ago.`,
        means: 'The side ahead just changed. Rounds where the lead changes hands are the hardest to call.' });
    }
  }
  // one exchange splitting from the rest (crypto)
  if (typ && crypto && Array.isArray(x.trades)) {
    const lastBy = {};
    for (const t of x.trades) if (t.t >= now - 20000 && t.ex && t.price > 0 && (!lastBy[t.ex] || t.t > lastBy[t.ex].t)) lastBy[t.ex] = t;
    const exs = Object.values(lastBy);
    if (exs.length >= 3) for (const e of exs) {
      const others = median(exs.filter((o) => o !== e).map((o) => o.price)), off = e.price - others;
      if (Math.abs(off) >= BREAKS.split * typ && Math.abs(off) / others >= 0.0005) out.push({ key: `split:${e.ex}`, kind: 'split', at: now, price: null, sev: 2,
        title: `${e.ex.replace('.US', '')} split from the other exchanges`, detail: `${fmt(Math.abs(off))} ${off > 0 ? 'above' : 'below'} the others' median.`,
        means: 'One venue out of line: a big order there, a stuck feed, or traders about to close the gap. Kalshi settles on an average across venues.' });
    }
  }
  // one-sided flow in the last minute (crypto)
  if (crypto && Array.isArray(x.trades)) {
    let b = 0, sl = 0, ten = 0;
    for (const t of x.trades) { const u = t.price * t.size; if (!(u > 0)) continue; if (t.t >= now - 600000) ten += u; if (t.t >= now - 60000) { if (t.side === 'buy') b += u; else if (t.side === 'sell') sl += u; } }
    const tot = b + sl, sh = tot ? b / tot : 0.5;
    if (ten > 0 && tot >= BREAKS.flowBurst * (ten / 10) && (sh >= BREAKS.flowShare || sh <= 1 - BREAKS.flowShare)) out.push({ key: `flow:${sh >= 0.5 ? 'buy' : 'sell'}`, kind: 'flow', at: now, price: null, sev: 2,
      title: `One-sided ${sh >= 0.5 ? 'buying' : 'selling'}: ${Math.round(Math.max(sh, 1 - sh) * 100)}% of ${money(tot)}`, detail: `In the last minute, at ${(tot / (ten / 10)).toFixed(1)}× the usual dollars a minute.`,
      means: 'A rush to one side. It moves the price while it lasts; when it stops, the price often gives some back.' });
  }
  // volatility shift
  if (lv?.sigmaMin > 0 && lv.sigmaLong > 0 && lv.sigmaMin / lv.sigmaLong >= BREAKS.regime) out.push({ key: 'regime', kind: 'regime', at: now, price: null, sev: 1,
    title: `Volatility at ${(lv.sigmaMin / lv.sigmaLong).toFixed(1)}× normal`, detail: 'The market switched into a faster gear.',
    means: 'Leads flip more easily now: the odds already widen for it, but a lead is worth less than usual.' });
  // one Kalshi order that is a big share of the round
  const k = kalshiBig(x.kalshiTrades), top = (x.kalshiTrades || []).reduce((a, t) => (t && t.usd > (a?.usd || 0) ? t : a), null);
  if (top && top.usd >= 500 && k.total > 0 && top.usd / k.total >= BREAKS.bigOrder) out.push({ key: `kbig:${top.t || 0}`, kind: 'order', at: top.t || now, price: null, sev: 1,
    title: `One Kalshi order is ${Math.round(top.usd / k.total * 100)}% of the round`, detail: `${top.side === 'YES' ? 'UP' : 'DOWN'} ${money(top.usd)} at ${cents(top.price)}.`,
    means: 'A single big trader can move Kalshi\'s price without the market moving. Their conviction isn\'t proof.' });
  // a liquidation burst (crypto)
  const lq = x.srv?.liqs;
  if (crypto && lq && lq.long + lq.short >= BREAKS.liqs) out.push({ key: `liqs:${Math.floor(now / 600000)}`, kind: 'liqs', at: now, price: null, sev: lq.long + lq.short >= 3 * BREAKS.liqs ? 2 : 1,
    title: `Liquidation burst: ${money(lq.long + lq.short)}`, detail: `In ${lq.minutes} minutes: longs ${money(lq.long)}, shorts ${money(lq.short)}.`,
    means: `Forced ${lq.long > lq.short ? 'selling' : 'buying'} cascades: it pushes the price ${lq.long > lq.short ? 'down' : 'up'} until it runs out.` });
  return out;
}
// The round's break log: a break found again stays open; one not found for 20 seconds has healed (its last state kept).
// A new round starts a new log. log: { ticker, items: [{ ...break, first, last, open }] }
export function trackBreaks(log, found, now, ticker, healMs = 20000) {
  const items = log?.ticker === ticker ? log.items.map((b) => ({ ...b })) : [];
  for (const b of found) {
    const old = items.find((x) => x.key === b.key);
    if (old) Object.assign(old, b, { first: old.first, at: old.at, price: old.price ?? b.price, last: now }); // the crack stays where it opened
    else items.push({ ...b, first: now, last: now });
  }
  for (const b of items) b.open = now - b.last <= healMs;
  items.sort((a, b) => (b.open - a.open) || b.sev - a.sev || b.last - a.last);
  return { ticker, items: items.slice(0, 30) };
}
