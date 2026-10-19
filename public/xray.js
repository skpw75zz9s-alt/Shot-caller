// The X-ray tab (v13.57): a scanner sweeps the live round like an x-ray film and shows the stats under the surface:
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
export function xraySvg({ bars = [], spot, strike, open, close, now, sigmaMin, W = 320, H = 170 }) {
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
  const svg = `${ribs.join('')}${tissue}<line class="target" x1="0" x2="${W}" y1="${f(Y(strike))}" y2="${f(Y(strike))}"/>${path}${bones.join('')}`
    + (last ? `<circle class="bone now" cx="${f(X(last.t))}" cy="${f(Y(last.c))}" r="4"/>` : '');
  return { svg, ok: pts.length > 0 };
}
