// Why it's moving (v13.34): for the markets without exchange trade feeds (gold, silver, oil, the stock indexes), how
// much of a move came from the markets that drive it and how much is its own. Gold and oil are traded as futures, so
// their price is set by buying and selling, but most of that trading reacts to a few things: the dollar, interest
// rates, stocks, and the rest of its own market (silver for gold, Brent and fuels for US crude). Each market lists its
// drivers in public/markets.js. Fitted on the last 3 days, step by step between this market's 1-minute prints:
//   macro    this market's move on the macro drivers' moves (ridge regression)
//   sector   what's left, on the rest of its market's moves minus their own macro part (so nothing is counted twice):
//            a move the sector shares is sector-wide buying or selling
//   own      the rest: this market's own buyers, sellers and news
// Over any window the parts add up to the actual move exactly (own is what the drivers don't explain). It explains, it
// doesn't predict: a driver moving with this market isn't proof it caused it, and the fit says how much it covers.
import { ridgeFit } from './cross.js';
import { seriesOf } from './markets.js';

export const DRV = { fitMinutes: 3 * 1440, ridge: 1, minRows: 240, fitGap: 30, gap: 20, maxPoints: 240, windows: [15, 60, 240, 1440] };
const MIN = 60000;

// The last close at or before minute t, within `gap` minutes (Yahoo leaves out minutes without a trade)
export function ffill(map, t, gap = DRV.gap) {
  if (!map) return null;
  for (let k = 0; k <= gap; k++) { const v = map.get(t - k * MIN); if (v > 0) return v; }
  return null;
}
const move = (map, a, b) => { const x = ffill(map, a), y = ffill(map, b); return x && y ? Math.log(y / x) : 0; };
// a fitted model on raw moves (no intercept: zero moves explain zero)
const lin = (m, x) => (m ? x.reduce((s, v, j) => s + m.w[j] * v / m.sd[j], 0) : 0);
const fit = (X, y, k) => (k && X.length ? ridgeFit(X, y, DRV.ridge) : null);

// The steps between this market's prints from `from` to `to`: each { t, tp, y (its log move), m (macro moves), s (sector) }
function steps(maps, key, macro, sector, from, to, maxGap) {
  const A = maps[key], ts = [...A.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b), out = [];
  for (let i = 1; i < ts.length; i++) {
    const tp = ts[i - 1], t = ts[i];
    if (t - tp > maxGap * MIN) continue;
    out.push({ t, tp, y: Math.log(A.get(t) / A.get(tp)), m: macro.map((k) => move(maps[k], tp, t)), s: sector.map((k) => move(maps[k], tp, t)) });
  }
  return out;
}

// Fit a market's drivers on the last 3 days: { ready, n, macro, sector, wm, ws (each sector market on macro), wsec, r2Macro, r2All }
export function fitDrivers(maps, asset, now, minutes = DRV.fitMinutes) {
  const d = asset?.drivers;
  if (!d || !maps[asset.key]) return null;
  const macro = d.macro.filter((k) => maps[k]?.size), sector = d.sector.filter((k) => maps[k]?.size), end = Math.floor(now / MIN) * MIN;
  const rows = steps(maps, asset.key, macro, sector, end - minutes * MIN, end, DRV.fitGap);
  if (rows.length < DRV.minRows) return { ready: false, n: rows.length, macro, sector };
  const wm = fit(rows.map((r) => r.m), rows.map((r) => r.y), macro.length);
  const ws = sector.map((_, j) => fit(rows.map((r) => r.m), rows.map((r) => r.s[j]), macro.length));
  const E = rows.map((r) => r.s.map((v, j) => v - lin(ws[j], r.m))), res = rows.map((r) => r.y - lin(wm, r.m));
  const wsec = fit(E, res, sector.length);
  let sst = 0, sm = 0, sa = 0;
  rows.forEach((r, i) => { const pm = lin(wm, r.m), ps = lin(wsec, E[i]); sst += r.y ** 2; sm += (r.y - pm) ** 2; sa += (r.y - pm - ps) ** 2; });
  return { ready: true, n: rows.length, macro, sector, wm, ws, wsec, r2Macro: sst > 0 ? Math.max(0, 1 - sm / sst) : 0, r2All: sst > 0 ? Math.max(0, 1 - sa / sst) : 0 };
}

// A driver's own move over the window: percent, or basis points for a yield (Yahoo quotes ^TNX in percent; once x10)
export function driverMove(map, unit, from, to) {
  const a = ffill(map, from, 240), b = ffill(map, to, 240);
  if (!(a > 0 && b > 0)) return null;
  return unit === 'yield' ? (b - a) * (a > 20 ? 10 : 100) : b / a - 1;
}

// Split this market's move from `from` to `to` into its drivers' parts, in dollars (they add up to the move exactly)
export function attribute(maps, model, asset, from, to) {
  const A = maps[asset.key];
  if (!model?.ready || !A?.size) return null;
  const base = [...A.keys()].filter((t) => t <= from).reduce((p, t) => (t > p ? t : p), -Infinity);
  const start = Number.isFinite(base) && from - base <= 4 * 60 * MIN ? base : from;
  const rows = steps(maps, asset.key, model.macro, model.sector, start, to, 24 * 60);
  if (!rows.length) return null;
  const t0 = rows[0].tp, p0 = A.get(t0), p1 = A.get(rows.at(-1).t);
  const cm = model.macro.map(() => 0), cs = model.sector.map(() => 0), series = [{ t: t0, actual: 0, drivers: 0 }];
  let cum = 0, cumD = 0;
  for (const r of rows) {
    let d = 0;
    r.m.forEach((v, j) => { const c = model.wm ? model.wm.w[j] * v / model.wm.sd[j] : 0; cm[j] += c; d += c; });
    r.s.forEach((v, j) => { const c = model.wsec ? model.wsec.w[j] * (v - lin(model.ws[j], r.m)) / model.wsec.sd[j] : 0; cs[j] += c; d += c; });
    cum += r.y; cumD += d;
    series.push({ t: r.t, actual: p0 * (Math.exp(cum) - 1), drivers: p0 * cumD });
  }
  const part = (key, group, c) => {
    const s = seriesOf(key), j = (group === 'macro' ? model.macro : model.sector).indexOf(key), m = group === 'macro' ? model.wm : model.wsec;
    return { key, group, name: s?.name ?? key, short: s?.short ?? s?.name ?? key, unit: s?.unit ?? 'pct', why: s?.why ?? null,
      move: driverMove(maps[key], s?.unit ?? 'pct', t0, rows.at(-1).t), usd: p0 * c, per1: m && j >= 0 ? m.w[j] / m.sd[j] : null };
  };
  const parts = [...model.macro.map((k, j) => part(k, 'macro', cm[j])), ...model.sector.map((k, j) => part(k, 'sector', cs[j]))];
  const explained = parts.reduce((s, p) => s + p.usd, 0);
  parts.push({ key: 'OWN', group: 'own', name: asset.drivers.own, short: `${asset.name} itself`, usd: p1 - p0 - explained });
  return { from: t0, to: rows.at(-1).t, p0, p1, move: p1 - p0, movePct: p1 / p0 - 1, parts, series: thin(series, DRV.maxPoints) };
}
// At most n points, the first and last kept
export function thin(xs, n) {
  if (xs.length <= n) return xs;
  const k = (xs.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => xs[Math.round(i * k)]);
}
// Per-minute volume over the window in at most n bars (summed), and the market's usual minute
export function volumeBars(vols, from, to, n = 60) {
  if (!vols?.size) return { bars: [], typical: null };
  const all = [...vols.entries()].filter(([, v]) => v > 0), vs = all.map(([, v]) => v).sort((a, b) => a - b);
  const span = Math.max(MIN, to - from), w = Math.max(MIN, Math.ceil(span / n / MIN) * MIN), bars = [];
  for (let t = from; t < to; t += w) {
    let v = 0, mins = 0;
    for (let u = t; u < t + w && u <= to; u += MIN) { const x = vols.get(u); if (x > 0) { v += x; mins++; } }
    bars.push({ t, v: mins ? v / mins : 0 });
  }
  return { bars, typical: vs.length ? vs[Math.floor(vs.length / 2)] : null, per: w / MIN };
}

// Scheduled reports that move a market inside the window: the EIA's weekly US oil inventories (Wednesdays 10:30 New
// York time; a holiday week moves it a day, not shown)
export function events(asset, from, to) {
  if (asset?.key !== 'OIL') return [];
  const out = [], fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  for (let d = Math.floor(from / 86400000) * 86400000; d <= to; d += 86400000) {
    for (const h of [14, 15]) {
      const t = d + h * 3600000 + 30 * MIN, p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      if (t >= from && t <= to && p.weekday === 'Wed' && +p.hour === 10 && +p.minute === 30) out.push({ t, label: 'EIA oil inventories' });
    }
  }
  return out;
}

const money = (v, digits = 2) => `${v < 0 ? '−' : '+'}\u2060$${Math.abs(v).toFixed(digits)}`; // (a word joiner: the sign never wraps away from the number)
export const moveText = (p) => (p.move == null ? '—' : p.unit === 'yield' ? `${p.move < 0 ? '−' : '+'}${Math.abs(p.move).toFixed(1)} bp` : `${p.move < 0 ? '−' : '+'}${Math.abs(p.move * 100).toFixed(2)}%`);
const windowName = (w) => (w >= 1440 ? 'day' : w === 60 ? 'hour' : w > 60 ? `${w / 60} hours` : `${w} minutes`);
// The move in plain words: how much, the biggest pushes, and how much of this market the drivers usually cover
export function explain(r, { name = 'it', w = 60, digits = 2, r2 = null } = {}) {
  if (!r) return '';
  const total = Math.abs(r.move) || 1, d = Math.max(2, digits);
  const head = `Over the last ${windowName(w)} ${name} is ${r.move > 0 ? 'up' : r.move < 0 ? 'down' : 'flat at'} ${money(r.move, d).replace(/^[+−]\u2060/, '')} (${r.movePct >= 0 ? '+' : '−'}${Math.abs(r.movePct * 100).toFixed(2)}%).`;
  const big = r.parts.filter((p) => Math.abs(p.usd) >= total * 0.15).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 3);
  const say = (p) => (p.group === 'own' ? `${money(p.usd, d)} is ${name}'s own buying and selling`
    : `${p.short} ${moveText(p)} → ${money(p.usd, d)}${p.group === 'sector' ? ' (beyond what the macro explains)' : ''}`);
  const body = big.length ? `Biggest pushes: ${big.map(say).join('; ')}.` : 'No single driver stands out.';
  const cover = r2 == null ? '' : ` Over the last 3 days these markets explained ${Math.round(r2 * 100)}% of ${name}'s minute-to-minute moves${r2 < 0.25 ? ', so most of its moves are its own' : ''}.`;
  return `${head} ${body}${cover}`;
}

// The chart: the actual move and the drivers' share of it since the window opened (one dollar axis), the gap between
// them shaded (its own part), scheduled reports marked, and the volume underneath. Returns SVG markup and the
// x-positions for the hover layer.
export function chartSvg(r, { vol = null, evs = [], digits = 2, W = 320, H = 150, VH = 34 } = {}) {
  if (!r?.series?.length) return { svg: '', xs: [] };
  const s = r.series, t0 = s[0].t, t1 = s.at(-1).t || t0 + MIN, padL = 44, padR = 6, top = 8, bot = 18;
  const vals = s.flatMap((p) => [p.actual, p.drivers]).concat(0), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const X = (t) => padL + (W - padL - padR) * (t1 > t0 ? (t - t0) / (t1 - t0) : 1), Y = (v) => top + (H - top - bot) * (1 - (v - lo) / span);
  const pts = (k) => s.map((p) => `${X(p.t).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
  const gap = `${pts('actual')} ${s.slice().reverse().map((p) => `${X(p.t).toFixed(1)},${Y(p.drivers).toFixed(1)}`).join(' ')}`;
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => `<line class="dv-grid" x1="${padL}" x2="${W - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="dv-ax" x="${padL - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${money(v, Math.abs(span) < 1 ? Math.max(2, digits) : 2)}</text>`).join('');
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const xl = `<text class="dv-ax" x="${padL}" y="${H - 4}">${clock(t0)}</text><text class="dv-ax" x="${W - padR}" y="${H - 4}" text-anchor="end">${clock(t1)}</text>`;
  const ev = evs.filter((e) => e.t >= t0 && e.t <= t1).map((e) => `<line class="dv-ev" x1="${X(e.t).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y1="${top}" y2="${H - bot}"/><text class="dv-evl" x="${(X(e.t) + 3).toFixed(1)}" y="${top + 8}">${e.label}</text>`).join('');
  let vb = '';
  if (vol?.bars?.length) {
    const vmax = Math.max(...vol.bars.map((b) => b.v), vol.typical || 0) || 1, bw = Math.max(1, (W - padL - padR) / vol.bars.length - 2);
    vb = `<g transform="translate(0,${H + 4})">${vol.bars.map((b) => { const h = (VH - 4) * b.v / vmax, x = X(Math.min(t1, b.t)); return `<rect class="dv-vol${vol.typical && b.v > 3 * vol.typical ? ' hot' : ''}" x="${Math.min(W - padR - bw, x).toFixed(1)}" y="${(VH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" rx="1"/>`; }).join('')}<text class="dv-ax" x="${padL - 4}" y="${VH - 2}" text-anchor="end">vol</text></g>`;
  }
  const svg = `<svg viewBox="0 0 ${W} ${H + (vb ? VH + 4 : 0)}" class="dv-svg" role="img" aria-label="${r.move >= 0 ? 'Up' : 'Down'} ${money(r.move, digits)}: drivers ${money(r.parts.filter((p) => p.group !== 'own').reduce((a, p) => a + p.usd, 0), digits)}, own ${money(r.parts.at(-1).usd, digits)}">`
    + `${ticks}<line class="dv-zero" x1="${padL}" x2="${W - padR}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>${ev}`
    + `<polygon class="dv-own" points="${gap}"/><polyline class="dv-drv" points="${pts('drivers')}"/><polyline class="dv-act" points="${pts('actual')}"/>`
    + `<circle class="dv-actd" r="3" cx="${X(s.at(-1).t).toFixed(1)}" cy="${Y(s.at(-1).actual).toFixed(1)}"/>${xl}${vb}`
    + `<line class="dv-cross" x1="0" x2="0" y1="${top}" y2="${H - bot}" visibility="hidden"/></svg>`;
  return { svg, xs: s.map((p) => X(p.t) / W) };
}
