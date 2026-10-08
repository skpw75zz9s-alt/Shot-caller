// Full chart (Chart tab): candles with indicators, volume, the forecast cone to the close, call markers,
// plus RSI and MACD panes. Canvas only, no libraries. `o.show` holds the indicator toggles.
import { bollinger, ema, floorCeiling, macd, rma, rsiSeries, vwap } from './indicators.js';

export const CHART_TOGGLES = [
  ['strike', 'Target (price to beat)', true], ['ema', 'EMA 9 / 21', true], ['rma', 'RMA 9 / 21', false], ['boll', 'Bollinger 20 ±2σ', true],
  ['vwap', 'VWAP (from round open)', true], ['floorCeil', 'Round floor / ceiling', true], ['cone', 'Forecast cone to the close', true],
  ['volume', 'Volume', true], ['rsi', 'RSI 14', true], ['macd', 'MACD 12/26/9', true], ['markers', 'Call markers', true], ['labels', 'Price labels', true],
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

// bars: candles with volume; o: { strike, openTime, closeTime, spot, cone: [{ t, lo50, hi50, lo90, hi90 }], markers: [{ t, side, label }], show, barMs, round }
export function drawPro(main, rsiCv, macdCv, bars, o) {
  const show = o.show;
  const H = 300, axis = 60;
  const { ctx, w, h } = setup(main, H);
  if (bars.length < 2) { ctx.fillStyle = C.text; ctx.font = '12px system-ui'; ctx.fillText('Loading candles…', 12, 24); return; }
  const closes = bars.map((b) => b.c);
  const barMs = o.barMs || 60000;
  // Room on the right for the cone: the minutes left until the close (round view)
  const future = show.cone && o.cone?.length ? Math.max(0, Math.ceil((o.closeTime - bars[bars.length - 1].t) / barMs)) : 0;
  // Bars sit by their time (a missing minute leaves a gap), so the cone, markers and candles always line up
  const slots = Math.round((bars[bars.length - 1].t - bars[0].t) / barMs) + 1 + future;
  const plotW = w - axis, slot = plotW / slots, bw = Math.max(1.5, slot * 0.62);
  const Xt = (t) => ((t - bars[0].t) / barMs) * slot + slot / 2;
  const X = (i) => Xt(bars[i].t);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), r9 = rma(closes, 9), r21 = rma(closes, 21), bb = bollinger(closes, 20, 2);
  const vw = vwap(bars, o.round ? o.openTime : -Infinity);
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
  for (let k = 0; k <= 4; k++) {
    const v = lo - pad + ((hi - lo + 2 * pad) * k) / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillText(fmt(v), plotW + 6, y + 3);
  }
  // time labels
  const every = Math.max(1, Math.round(bars.length / 5));
  for (let i = 0; i < bars.length; i += every) ctx.fillText(new Date(bars[i].t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, ''), X(i) - 12, H - 4);
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
    ctx.fillText(up ? '▲' : '▼', X(i), y);
    if (show.labels && m.label) { ctx.font = '600 9px ui-monospace, monospace'; ctx.fillText(m.label, X(i), up ? y + 11 : y - 13); }
    ctx.textAlign = 'start';
  }
  if (show.labels) tag(ctx, plotW, Y(closes[closes.length - 1]), fmt(o.spot ?? closes[closes.length - 1]), closes[closes.length - 1] >= bars[bars.length - 1].o ? C.up : C.dn, true);
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
      const r = setup(rsiCv, 90), rs = rsiSeries(closes, 14), Yr = (v) => 6 + (1 - v / 100) * (r.h - 12);
      pane(r.ctx, r.w - axis, Yr, [30, 70], 'RSI 14', r.w);
      line(r.ctx, rs, X, Yr, '#a78bfa');
      const last = rs[rs.length - 1]; if (last != null) tag(r.ctx, r.w - axis, Yr(last), last.toFixed(0), '#a78bfa', true);
    }
  }
  // MACD pane
  if (macdCv) {
    macdCv.hidden = !show.macd;
    if (show.macd) {
      const r = setup(macdCv, 90), m = macd(closes);
      const vals = m.flatMap((x) => [x.macd, x.signal, x.hist]).filter((v) => v != null);
      const ext = Math.max(...vals.map(Math.abs), 1e-9), Ym = (v) => r.h / 2 - (v / ext) * (r.h / 2 - 6);
      pane(r.ctx, r.w - axis, Ym, [0], 'MACD', r.w);
      m.forEach((x, i) => { if (x.hist == null) return; r.ctx.fillStyle = x.hist >= 0 ? '#2ee6a688' : '#ff4d6d88'; r.ctx.fillRect(X(i) - bw / 2, Math.min(Ym(0), Ym(x.hist)), bw, Math.abs(Ym(x.hist) - Ym(0))); });
      line(r.ctx, m.map((x) => x.macd), X, Ym, '#22d3ee');
      line(r.ctx, m.map((x) => x.signal), X, Ym, '#fbbf24');
    }
  }
}

function line(ctx, ys, X, Y, col, dash = []) {
  ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash(dash); ctx.beginPath();
  let on = false;
  ys.forEach((v, i) => { if (v == null) { on = false; return; } on ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); on = true; });
  ctx.stroke(); ctx.setLineDash([]);
}
function tag(ctx, x, y, text, col, solid = false) {
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
