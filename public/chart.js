// Full chart (Chart tab): candles with indicators, volume, the forecast cone to the close, call markers,
// plus RSI and MACD panes. Canvas only, no libraries. `o.show` holds the indicator toggles.
import { bollinger, ema, floorCeiling, macd, rma, rsiSeries, vwap } from './indicators.js';

// The bull and the bear (public/bull.svg, bear.svg): trend watermark, call markers and EMA crosses
const BEAST = typeof Image === 'undefined' ? {} : { bull: Object.assign(new Image(), { src: 'bull.svg' }), bear: Object.assign(new Image(), { src: 'bear.svg' }) };
const beastReady = (k) => BEAST[k]?.complete && BEAST[k].naturalWidth > 0;
function beast(ctx, k, x, y, size, alpha = 1) {
  if (!beastReady(k)) return false;
  ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(BEAST[k], x - size / 2, y - size / 2, size, size); ctx.restore();
  return true;
}

export const CHART_TOGGLES = [
  ['strike', 'Target (price to beat)', true], ['ema', 'EMA 9 / 21', true], ['rma', 'RMA 9 / 21', false], ['boll', 'Bollinger 20 ±2σ', true],
  ['vwap', 'VWAP (from round open)', true], ['floorCeil', 'Round floor / ceiling', true], ['cone', 'Forecast cone to the close', true],
  ['volume', 'Volume', true], ['rsi', 'RSI 14', true], ['macd', 'MACD 12/26/9', true], ['markers', 'Call markers', true], ['labels', 'Price labels', true],
  ['beasts', 'Bull / bear trend + EMA crosses', true],
  ['orders', 'Live orders (big trades, all exchanges)', true], ['fills', 'My trades + Auto-trader buys/sells', true],
];
export const chartDefaults = () => Object.fromEntries(CHART_TOGGLES.map(([k, , on]) => [k, on]));

const C = { up: '#2ee6a6', dn: '#ff4d6d', grid: '#ffffff0d', text: '#8b95a7', strike: '#e8ecf3', ema9: '#22d3ee', ema21: '#a78bfa', rma9: '#22d3ee88', rma21: '#a78bfa88',
  boll: '#7dd3fc', vwap: '#fbbf24', floor: '#2ee6a6', ceil: '#ff4d6d', cone50: '#22d3ee33', cone90: '#22d3ee14', vol: '#ffffff22' };

function setup(cv, h) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
const fmt = (v) => Math.round(v).toLocaleString('en-US');

// all: candles with volume (more history than shown, so slow indicators are warmed up); o.viewFrom: first time shown.
// o: { strike, openTime, closeTime, spot, cone: [{ t, lo50, hi50, lo90, hi90 }], markers: [{ t, side, label }], show, barMs, round,
//      viewFrom, viewTo (the window shown, for zooming and scrolling back), height, liveLast (the live layer draws the
//      current candle and price, so they move with every trade) }
export function drawPro(main, rsiCv, macdCv, all, o) {
  const start = Math.max(0, o.viewFrom ? all.findIndex((b) => b.t >= o.viewFrom) : 0);
  let endIdx = all.length - 1;
  if (o.viewTo != null) while (endIdx > start && all[endIdx].t > o.viewTo) endIdx--;
  const bars = all.slice(start, endIdx + 1);
  const cut = (xs) => xs.slice(start, endIdx + 1);
  const show = o.show;
  const H = o.height || 300, axis = 60;
  const liveLast = !!o.liveLast && endIdx === all.length - 1;
  const { ctx, w, h } = setup(main, H);
  if (bars.length < 2) { ctx.fillStyle = C.text; ctx.font = '12px system-ui'; ctx.fillText('Loading candles…', 12, 24); return; }
  const allCloses = all.map((b) => b.c), closes = cut(allCloses);
  const barMs = o.barMs || 60000;
  // Room on the right for the cone: the minutes left until the close (round view)
  const future = show.cone && o.cone?.length ? Math.max(0, Math.ceil((o.closeTime - bars[bars.length - 1].t) / barMs)) : 0;
  // Bars sit by their time (a missing minute leaves a gap), so the cone, markers and candles always line up
  const slots = Math.round((bars[bars.length - 1].t - bars[0].t) / barMs) + 1 + future;
  const plotW = w - axis, slot = plotW / slots, bw = Math.max(1.5, slot * 0.62);
  const Xt = (t) => ((t - bars[0].t) / barMs) * slot + slot / 2;
  const X = (i) => Xt(bars[i].t);
  const e9 = cut(ema(allCloses, 9)), e21 = cut(ema(allCloses, 21)), r9 = cut(rma(allCloses, 9)), r21 = cut(rma(allCloses, 21)), bb = cut(bollinger(allCloses, 20, 2));
  const vw = cut(vwap(all, o.round ? o.openTime : bars[0].t));
  const fc = o.round ? floorCeiling(bars, o.openTime) : null;

  const ys = bars.flatMap((b) => [b.h, b.l]);
  if (show.strike && o.strike) ys.push(o.strike);
  if (show.boll) bb.forEach((b) => b && ys.push(b.up, b.lo));
  if (show.cone && o.cone?.length) o.cone.forEach((c) => ys.push(c.lo90, c.hi90));
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.06 || 1;
  const volH = show.volume ? 46 : 0, top = 12, bot = H - 18 - volH;
  const Y = (v) => bot - ((v - lo + pad) / (hi - lo + 2 * pad)) * (bot - top);

  // grid + axis
  ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = C.text; ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  const axisLabels = []; // printed last, skipping any a price tag covers
  tagYs.length = 0;
  for (let k = 0; k <= 4; k++) {
    const v = lo - pad + ((hi - lo + 2 * pad) * k) / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    axisLabels.push([fmt(v), y]);
  }
  // time labels
  const every = Math.max(1, Math.round(bars.length / 5));
  for (let i = 0, lastX = -99; i < bars.length; i += every) {
    const text = new Date(bars[i].t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, '');
    const x = Math.max(2, X(i) - 12), tw = ctx.measureText(text).width;
    if (x < lastX + 6) continue; // would print on top of the one before
    ctx.fillText(text, x, H - 4); lastX = x + tw;
  }
  // Bull or bear behind the candles: who has the trend (fast EMA above the slow one = bull)
  const l9 = e9[e9.length - 1], l21 = e21[e21.length - 1];
  const trend = l9 != null && l21 != null ? (l9 >= l21 ? 'bull' : 'bear') : null;
  if (show.beasts && trend) {
    const size = Math.min(plotW, bot - top) * 0.62;
    beast(ctx, trend, plotW / 2, top + (bot - top) / 2, size, 0.07);
  }
  // round shading + close line
  if (o.round && o.openTime) {
    const x0 = Xt(o.openTime) - slot / 2;
    ctx.fillStyle = '#22d3ee08'; ctx.fillRect(Math.max(0, x0), top - 12, plotW - Math.max(0, x0), bot - top + 12);
    if (o.closeTime) { const xc = Xt(o.closeTime); ctx.strokeStyle = '#fbbf2499'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(xc, 0); ctx.lineTo(xc, bot); ctx.stroke(); ctx.setLineDash([]); }
  }
  // Bollinger band
  if (show.boll) {
    ctx.fillStyle = '#7dd3fc0d'; ctx.beginPath();
    let started = false;
    bb.forEach((b, i) => { if (b) { started ? ctx.lineTo(X(i), Y(b.up)) : ctx.moveTo(X(i), Y(b.up)); started = true; } });
    for (let i = bb.length - 1; i >= 0; i--) if (bb[i]) ctx.lineTo(X(i), Y(bb[i].lo));
    ctx.fill();
    line(ctx, bb.map((b) => b?.up ?? null), X, Y, '#7dd3fc55', [2, 3]);
    line(ctx, bb.map((b) => b?.lo ?? null), X, Y, '#7dd3fc55', [2, 3]);
  }
  // Forecast cone from the last bar to the close
  if (show.cone && o.cone?.length > 1) {
    for (const [loK, hiK, col] of [['lo90', 'hi90', C.cone90], ['lo50', 'hi50', C.cone50]]) {
      ctx.fillStyle = col; ctx.beginPath();
      o.cone.forEach((c, i) => (i ? ctx.lineTo(Xt(c.t), Y(c[hiK])) : ctx.moveTo(Xt(c.t), Y(c[hiK]))));
      for (let i = o.cone.length - 1; i >= 0; i--) ctx.lineTo(Xt(o.cone[i].t), Y(o.cone[i][loK]));
      ctx.fill();
    }
  }
  // Volume
  if (show.volume) {
    const vmax = Math.max(...bars.map((b) => b.v || 0), 1e-9);
    bars.forEach((b, i) => { ctx.fillStyle = b.c >= b.o ? '#2ee6a640' : '#ff4d6d40'; const vh = ((b.v || 0) / vmax) * (volH - 6); ctx.fillRect(X(i) - bw / 2, H - 18 - vh, bw, vh); });
  }
  // Levels
  const hline = (v, col, dash, text) => {
    if (v == null) return;
    ctx.strokeStyle = col; ctx.setLineDash(dash); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(plotW, Y(v)); ctx.stroke(); ctx.setLineDash([]);
    if (show.labels && text) tag(ctx, plotW, Y(v), text, col);
  };
  if (show.floorCeil && fc) { hline(fc.floor, C.floor + 'aa', [1, 3], fmt(fc.floor)); hline(fc.ceiling, C.ceil + 'aa', [1, 3], fmt(fc.ceiling)); }
  if (show.strike && o.strike) hline(o.strike, C.strike, [6, 4], fmt(o.strike));
  // Moving averages + VWAP
  if (show.rma) { line(ctx, r9, X, Y, C.rma9, [4, 3]); line(ctx, r21, X, Y, C.rma21, [4, 3]); }
  if (show.ema) { line(ctx, e9, X, Y, C.ema9); line(ctx, e21, X, Y, C.ema21); }
  if (show.vwap) line(ctx, vw, X, Y, C.vwap, [5, 3]);
  // Candles
  bars.forEach((b, i) => {
    if (liveLast && i === bars.length - 1) return; // the live layer draws this one, moving with each trade
    const up = b.c >= b.o, x = X(i);
    ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.dn;
    ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
    ctx.fillRect(x - bw / 2, Y(Math.max(b.o, b.c)), bw, Math.max(1, Math.abs(Y(b.o) - Y(b.c))));
  });
  // Call markers
  if (show.markers) for (const m of o.markers || []) {
    if (m.t < bars[0].t || m.t > bars[bars.length - 1].t + barMs) continue;
    const i = Math.min(bars.length - 1, Math.max(0, Math.round((m.t - bars[0].t) / barMs))), b = bars[i], up = m.side === 'YES';
    const y = up ? Y(b.l) + 14 : Y(b.h) - 6;
    ctx.fillStyle = up ? C.up : C.dn; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
    if (!beast(ctx, up ? 'bull' : 'bear', X(i), up ? y + 2 : y - 6, 22)) ctx.fillText(up ? '▲' : '▼', X(i), y);
    if (show.labels && m.label) { ctx.font = '600 9px ui-monospace, monospace'; ctx.fillText(m.label, X(i), up ? y + 21 : y - 19); }
    ctx.textAlign = 'start';
  }
  // EMA 9 x 21 crosses: a little bull where the fast line crosses up, a bear where it crosses down
  if (show.beasts) for (let i = 1, lastX = -99; i < bars.length; i++) {
    if ([e9[i], e21[i], e9[i - 1], e21[i - 1]].some((v) => v == null)) continue;
    const was = e9[i - 1] >= e21[i - 1], is = e9[i] >= e21[i];
    if (was === is) continue;
    if (X(i) - lastX < 30) continue; // crosses packed together: one marker, not a pile of them
    lastX = X(i);
    if (is) beast(ctx, 'bull', X(i), Y(bars[i].l) + 16, 16, 0.9); else beast(ctx, 'bear', X(i), Y(bars[i].h) - 14, 16, 0.9);
  }
  if (show.beasts && trend) { ctx.font = '800 10px system-ui'; ctx.fillStyle = trend === 'bull' ? C.up : C.dn; ctx.fillText(trend === 'bull' ? 'BULL TREND' : 'BEAR TREND', 6, bot - 6); }
  if (show.labels) { const ly = Y(closes[closes.length - 1]); if (liveLast) tagYs.push(ly); else tag(ctx, plotW, ly, fmt(endIdx === all.length - 1 ? o.spot ?? closes[closes.length - 1] : closes[closes.length - 1]), closes[closes.length - 1] >= bars[bars.length - 1].o ? C.up : C.dn, true); }
  ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = C.text;
  for (const [text, y] of axisLabels) if (!tagYs.some((t) => Math.abs(t - y) < 14)) ctx.fillText(text, plotW + 6, y + 3);
  // legend
  ctx.font = '600 10px system-ui'; let lx = 6, ly = 10;
  for (const [on, col, text] of [[show.strike && o.strike, C.strike, 'target'], [show.floorCeil && fc, C.floor, 'floor'], [show.floorCeil && fc, C.ceil, 'ceiling'], [show.ema, C.ema9, 'EMA9'], [show.ema, C.ema21, 'EMA21'], [show.vwap, C.vwap, 'VWAP'], [show.cone && o.cone?.length, C.ema9, 'cone 50/90%']]) {
    if (!on) continue;
    const tw = ctx.measureText(text).width;
    if (lx + tw > plotW - 4) { lx = 6; ly += 12; } // wrap on narrow phones
    ctx.fillStyle = col; ctx.fillText(text, lx, ly); lx += tw + 10;
  }

  // RSI pane
  if (rsiCv) {
    rsiCv.hidden = !show.rsi;
    if (show.rsi) {
      const r = setup(rsiCv, 90), rs = cut(rsiSeries(allCloses, 14)), Yr = (v) => 6 + (1 - v / 100) * (r.h - 12);
      pane(r.ctx, r.w - axis, Yr, [30, 70], 'RSI 14', r.w);
      line(r.ctx, rs, X, Yr, '#a78bfa');
      const last = rs[rs.length - 1]; if (last != null) tag(r.ctx, r.w - axis, Yr(last), last.toFixed(0), '#a78bfa', true);
    }
  }
  // MACD pane
  if (macdCv) {
    macdCv.hidden = !show.macd;
    if (show.macd) {
      const r = setup(macdCv, 90), m = cut(macd(allCloses));
      const vals = m.flatMap((x) => [x.macd, x.signal, x.hist]).filter((v) => v != null);
      const ext = Math.max(...vals.map(Math.abs), 1e-9), Ym = (v) => r.h / 2 - (v / ext) * (r.h / 2 - 6);
      pane(r.ctx, r.w - axis, Ym, [0], 'MACD', r.w);
      m.forEach((x, i) => { if (x.hist == null) return; r.ctx.fillStyle = x.hist >= 0 ? '#2ee6a688' : '#ff4d6d88'; r.ctx.fillRect(X(i) - bw / 2, Math.min(Ym(0), Ym(x.hist)), bw, Math.abs(Ym(x.hist) - Ym(0))); });
      line(r.ctx, m.map((x) => x.macd), X, Ym, '#22d3ee');
      line(r.ctx, m.map((x) => x.signal), X, Ym, '#fbbf24');
    }
  }
  // Where everything sits, for the live-orders layer drawn on top (drawOrders)
  const last = bars[bars.length - 1];
  return { t0: bars[0].t, t1: last.t + barMs, barMs, slot, bw, plotW, top, bot, w, h: H, Xt, Y, vmin: lo - pad, vmax: hi + pad, bars, liveLast, last, labels: show.labels,
    closeAt: (t) => bars[Math.max(0, bars.findIndex((b) => b.t + barMs > t))].c };
}

// ---------- the live-orders layer ----------
// Its own transparent canvas over the chart, so a trade (and its animation) redraws only this, not the candles,
// indicators, RSI and MACD underneath.
// Every big trade ($2k+, 5 exchange feeds) is a bubble that pops in at its price and moment, drifts up a little, then
// bursts and disappears (about 3s). Size = dollars, green = a buyer lifted the ask, red = a seller hit the bid,
// gold = a whale.
export const BUBBLE_LIFE = 3000; // ms from appearing to gone
const POP_AT = 2500;             // ...the last half second is the burst
export function liveBubbles(orders, now = Date.now(), max = 80) {
  const out = [];
  for (let i = orders.length - 1; i >= 0 && out.length < max; i--) {
    const x = orders[i], age = now - (x.at ?? x.t);
    if (age > BUBBLE_LIFE) break; // oldest-first list: everything before this is gone too
    if (age >= 0) out.push(x);
  }
  return out;
}
// Returns true while something on it is still animating, so the caller keeps asking for frames.
// live: { price } the current candle's price right now (eased by the caller); cross: { x, y } a crosshair to show.
export function drawOrders(cv, geo, { bubbles = [], fills = [], show, now = Date.now(), live = null, cross = null }) {
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(geo.w * dpr) || cv.height !== Math.round(geo.h * dpr)) { cv.width = Math.round(geo.w * dpr); cv.height = Math.round(geo.h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, geo.w, geo.h);
  const { Xt, Y, top, bot, plotW } = geo;
  let animating = false;
  // The live candle: its body and wick follow the price with every trade, with a price line and tag on the axis
  if (geo.liveLast && live?.price) {
    const b = geo.last, p = live.price, x = Xt(b.t), up = p >= b.o, col = up ? C.up : C.dn;
    const hi = Math.max(b.h, p), lo = Math.min(b.l, p);
    ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(hi)); ctx.lineTo(x, Y(lo)); ctx.stroke();
    ctx.fillRect(x - geo.bw / 2, Y(Math.max(b.o, p)), geo.bw, Math.max(1, Math.abs(Y(b.o) - Y(p))));
    const y = Y(p);
    ctx.globalAlpha = 0.6; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    const pulse = live.moving ? 0.5 + 0.5 * Math.sin(now / 90) : 0; // a glow while it's moving
    ctx.globalAlpha = 0.35 * pulse; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
    if (geo.labels) tag(ctx, plotW, y, fmt(p), col, true);
  }
  // Crosshair (press and hold, or a mouse): the candle under it and the price at the line
  if (cross) {
    const i = Math.max(0, Math.min(geo.bars.length - 1, geo.bars.findIndex((b) => Xt(b.t) + geo.slot / 2 >= cross.x)));
    const b = geo.bars[i] ?? geo.last, x = Xt(b.t), y = Math.min(bot, Math.max(top, cross.y));
    const price = geo.vmax - ((y - top) / (bot - top)) * (geo.vmax - geo.vmin);
    ctx.strokeStyle = '#e8ecf3aa'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]);
    tag(ctx, plotW, y, fmt(price), '#e8ecf3', true);
    const c = i === geo.bars.length - 1 && geo.liveLast && live?.price ? live.price : b.c;
    const lines = [new Date(b.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), `O ${fmt(b.o)}  H ${fmt(Math.max(b.h, c))}`, `L ${fmt(Math.min(b.l, c))}  C ${fmt(c)}`, `${c >= b.o ? '+' : '−'}$${Math.abs(c - b.o).toFixed(0)} this candle`];
    ctx.font = '600 10px ui-monospace, monospace';
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, bh = lines.length * 13 + 8;
    const bx = x + 10 + bw > plotW ? x - 10 - bw : x + 10, by = top + 4;
    ctx.fillStyle = '#05070de8'; ctx.strokeStyle = '#22d3ee66'; ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#e8ecf3';
    lines.forEach((l, k) => { ctx.fillStyle = k === 3 ? (c >= b.o ? C.up : C.dn) : '#e8ecf3'; ctx.fillText(l, bx + 7, by + 15 + k * 13); });
  }
  if (show.orders) for (const x of bubbles) {
    const age = now - (x.at ?? x.t);
    if (age < 0 || age > BUBBLE_LIFE) continue;
    animating = true;
    const col = x.whale ? '#fbbf24' : x.side === 'buy' ? C.up : C.dn;
    const r0 = Math.min(x.whale ? 22 : 15, 3 + Math.sqrt(x.usd / 2000) * 1.4);
    const cx = Math.min(plotW - 4, Math.max(4, Xt(x.t))), cy0 = Math.min(bot - 4, Math.max(top + 4, Y(x.price)));
    const cy = cy0 - (Math.min(age, POP_AT) / POP_AT) * 10; // drifts up as it lives
    if (age < POP_AT) {
      // pops in with a little overshoot, then floats
      const k = Math.min(1, age / 220), grow = k < 1 ? 1.18 * k - 0.18 * k * k * k : 1;
      const r = r0 * Math.max(0.05, grow) * (1 + 0.04 * Math.sin(age / 120));
      ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.95; ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.globalAlpha = 0.55; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, Math.max(1, r * 0.22), 0, 7); ctx.fill(); // shine
      if (x.whale && r > 8) { ctx.globalAlpha = 1; ctx.font = `${Math.round(r)}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('🐋', cx, cy + r * 0.35); ctx.textAlign = 'start'; }
    } else {
      // the pop: a ring bursts outward and a few droplets fly off, fading to nothing
      const k = (age - POP_AT) / (BUBBLE_LIFE - POP_AT), fade = 1 - k;
      ctx.globalAlpha = fade * 0.9; ctx.strokeStyle = col; ctx.lineWidth = 2 * fade + 0.5;
      ctx.beginPath(); ctx.arc(cx, cy, r0 * (1 + 0.9 * k), 0, 7); ctx.stroke();
      ctx.fillStyle = col;
      for (let j = 0; j < 6; j++) {
        const a = (j / 6) * Math.PI * 2 + (x.t % 7), d = r0 * (1 + 1.8 * k);
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(0.6, 2.2 * fade), 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  if (show.orders) {
    ctx.font = '600 9px ui-monospace, monospace'; ctx.textAlign = 'right';
    ctx.fillStyle = C.up; ctx.fillText('● buys', plotW - 46, top + 10); ctx.fillStyle = C.dn; ctx.fillText('● sells', plotW - 4, top + 10);
    ctx.textAlign = 'start';
  }
  // Your trades and the Auto-trader's: a flag at the moment, on the BTC price then. B = bought, S = sold, ✕ = bailed
  if (show.fills) for (const f of fills.filter((x) => x.t >= geo.t0 && x.t < geo.t1)) {
    const cx = Xt(f.t), cy = Y(geo.closeAt(f.t));
    const col = f.kind === 'buy' ? '#22d3ee' : f.kind === 'bail' ? C.dn : '#fbbf24';
    ctx.strokeStyle = col; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, bot); ctx.stroke(); ctx.setLineDash([]);
    const up = f.kind === 'buy', fy = up ? Math.min(bot - 10, cy + 16) : Math.max(top + 10, cy - 16);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, fy, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#05070d'; ctx.font = '800 9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(f.kind === 'buy' ? 'B' : f.kind === 'bail' ? '✕' : 'S', cx, fy + 3);
    if (show.labels && f.label) { ctx.fillStyle = col; ctx.font = '600 9px ui-monospace, monospace'; ctx.fillText(f.label, cx, up ? fy + 18 : fy - 12); }
    ctx.textAlign = 'start';
  }
  return animating;
}

function line(ctx, ys, X, Y, col, dash = []) {
  ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash(dash); ctx.beginPath();
  let on = false;
  ys.forEach((v, i) => { if (v == null) { on = false; return; } on ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); on = true; });
  ctx.stroke(); ctx.setLineDash([]);
}
const tagYs = []; // where the main chart's price tags went (axis labels keep clear of them)
function tag(ctx, x, y, text, col, solid = false) {
  tagYs.push(y);
  ctx.font = '600 10px ui-monospace, monospace';
  const tw = ctx.measureText(text).width + 8;
  ctx.fillStyle = solid ? col : '#0b0f17'; ctx.strokeStyle = col;
  ctx.fillRect(x + 2, y - 8, tw, 16); ctx.strokeRect(x + 2, y - 8, tw, 16);
  ctx.fillStyle = solid ? '#05070d' : col; ctx.fillText(text, x + 6, y + 4);
}
function pane(ctx, plotW, Y, levels, title, w) {
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.text; ctx.font = '10px ui-monospace, monospace';
  for (const l of levels) { ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, Y(l)); ctx.lineTo(plotW, Y(l)); ctx.stroke(); ctx.setLineDash([]); ctx.fillText(String(l), plotW + 6, Y(l) + 3); }
  ctx.fillText(title, 6, 12);
  ctx.strokeStyle = '#ffffff14'; ctx.strokeRect(0.5, 0.5, w - 1, ctx.canvas.height / (window.devicePixelRatio || 1) - 1);
}
