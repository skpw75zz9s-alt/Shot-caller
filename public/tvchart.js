// The Chart tab, drawn with TradingView's Lightweight Charts (Apache-2.0, public/vendor; credit in the Learn tab and
// the TradingView link on the chart itself). The library does the candles, axes, crosshair, pinch / drag / zoom; this
// file adds Shot Caller's layers on top: EMAs, Bollinger, VWAP, the target and the round's floor / ceiling, the
// forecast cone with its prediction lines, call markers, your trades, the live-order bubbles, RSI and MACD.
import { createChart, CrosshairMode, LineStyle } from './vendor/lightweight-charts.js';
import { ema, rma, bollinger, vwap, rsiSeries, macd, floorCeiling } from './indicators.js';
import { liveBubbles } from './chart.js';

// v13.40 colors: the overlays are one validated categorical set for the dark chart surface (dataviz validate_palette:
// lightness band, chroma, colorblind separation and contrast all pass, in this order): EMA 9 blue, EMA 21 orange, RMA
// violet, VWAP amber. Candles keep up / down green and red; the forecast is one hue (the cone) plus a neutral path.
const C = { bg: '#0a0f1a', grid: '#ffffff07', text: '#8b95a7', ink: '#c9d1e0', up: '#2ee6a6', dn: '#ff4d6d', ema9: '#3987e5', ema21: '#d95926', rma: '#9085e9', vwap: '#c98500', boll: '#8b95a766', strike: '#e8ecf3', cone: '34,211,238', path: '#e8ecf3', pat: '#f472b6', patRgb: '244,114,182' }; // pat: chart patterns (v13.44)
// the forecast sources (only with "Every forecast source" on): the reference 8-slot order, each named in the legend
const SRC = { bot: ['Bot', '#3987e5'], kalshi: ['Kalshi', '#d95926'], exch: ['Exchanges', '#199e70'], engine: ['Engine', '#c98500'], guide: ['Guide', '#d55181'], micro: ['Micro', '#9085e9'], moves: ['Move model', '#e66767'] };
const sec = (ms) => Math.floor(ms / 1000);
// a chart pattern's short tag for its marker (public/chartpatterns.js)
const patTag = (e) => (e.key === 'hs' ? (e.dir > 0 ? 'iH&S' : 'H&S') : e.key === 'flag' ? 'Flag' : e.key === 'level' ? (e.dir > 0 ? 'Res' : 'Sup')
  : e.key === 'triangle' ? ({ rwedge: 'Wedge', fwedge: 'Wedge', chup: 'Chan', chdn: 'Chan' }[e.shape] ?? 'Tri') : e.name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 3));
const TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function baseOptions(height, withTime = true, num = NUM) {
  return {
    height,
    layout: { background: { color: C.bg }, textColor: C.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, attributionLogo: false }, // the TradingView credit is the link under the chart
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: '#16203a', scaleMargins: { top: 0.16, bottom: 0.06 } }, // room at the top for the legend
    timeScale: { borderColor: '#16203a', timeVisible: true, secondsVisible: false, visible: withTime, rightOffset: 2, fixLeftEdge: false,
      tickMarkFormatter: (t, type) => (type <= 2 ? DAY.format(t * 1000) : TIME.format(t * 1000)) },
    localization: { timeFormatter: (t) => `${DAY.format(t * 1000)} ${TIME.format(t * 1000)}`, priceFormatter: (p) => num.format(p) },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#e8ecf366', style: LineStyle.Dashed, labelBackgroundColor: '#1b2540' }, horzLine: { color: '#e8ecf366', style: LineStyle.Dashed, labelBackgroundColor: '#1b2540' } },
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
    handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
    kineticScroll: { touch: true, mouse: false },
  };
}

// digits: the market's price precision (public/markets.js: BTC 0, ETH and SOL 2, XRP 4, DOGE 5). Bitcoin's chart is as it
// was; smaller-priced markets get their decimals on the axis and candles (whole cents flattened XRP's candles to lines)
export function createTvChart({ main, rsiEl, macdEl, layer, liveBtn, digits = 0, name = 'BTC' }) {
  const fine = digits >= 2, PF = fine ? { priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } } : {};
  const MF = fine ? { priceFormat: { type: 'price', precision: digits + 2, minMove: 10 ** -(digits + 2) } } : {}; // MACD, a fraction of the price
  const NUMF = fine ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : NUM;
  const MACDF = fine ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits + 2, maximumFractionDigits: digits + 2 }) : NUM;
  const chart = createChart(main, baseOptions(300, true, NUMF));
  const rsiChart = createChart(rsiEl, { ...baseOptions(96, false), rightPriceScale: { borderColor: '#16203a', scaleMargins: { top: 0.22, bottom: 0.08 } }, handleScroll: false, handleScale: false });
  const macdChart = createChart(macdEl, { ...baseOptions(96, false, MACDF), rightPriceScale: { borderColor: '#16203a', scaleMargins: { top: 0.22, bottom: 0.08 } }, handleScroll: false, handleScale: false });
  for (const c of [rsiChart, macdChart]) c.applyOptions({ crosshair: { horzLine: { visible: false }, vertLine: { visible: true, labelVisible: false } } }); // their crosshair follows the main chart's

  // A steady price axis (v13.22): the candles' visible range plus the target and the cone, widened at once when they
  // need more room but narrowed gently (over a few seconds), so the forecast lines shifting every few seconds don't
  // jerk the whole chart up and down. A jump to somewhere else entirely (a pan back in time) snaps straight there.
  const extra = { lo: null, hi: null };
  let axis = null, axisAt = 0;
  const steadyAxis = (original) => {
    const r = original();
    if (!r?.priceRange) return r;
    let lo = r.priceRange.minValue, hi = r.priceRange.maxValue;
    if (liveOnScreen() && extra.lo != null) { lo = Math.min(lo, extra.lo); hi = Math.max(hi, extra.hi); }
    const now = performance.now(), dt = now - axisAt; axisAt = now;
    const overlap = axis ? Math.min(hi, axis.hi) - Math.max(lo, axis.lo) : -1;
    if (!axis || overlap < 0.5 * Math.min(hi - lo, axis.hi - axis.lo)) axis = { lo, hi };
    else {
      const k = 1 - Math.exp(-Math.max(0, dt) / 2500); // narrowing: about 63% of the way in 2.5 s
      axis = { lo: lo < axis.lo ? lo : axis.lo + (lo - axis.lo) * k, hi: hi > axis.hi ? hi : axis.hi + (hi - axis.hi) * k };
    }
    return { priceRange: { minValue: axis.lo, maxValue: axis.hi }, margins: r.margins };
  };
  const candles = chart.addCandlestickSeries({ ...PF, upColor: C.up, downColor: C.dn, wickUpColor: C.up, wickDownColor: C.dn, borderVisible: false, priceLineColor: '#e8ecf3aa', priceLineStyle: LineStyle.Dotted, autoscaleInfoProvider: steadyAxis });
  // the expected path (public/predict.js pathMinutes: the cone's centre, minute by minute), and the flip (↺) markers on it
  const pathLine = chart.addLineSeries({ ...PF, color: C.path, lineWidth: 2, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.9, bottom: 0 }, visible: false }); // a quiet strip at the bottom
  const line = (color, opts = {}) => chart.addLineSeries({ ...PF, color, lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, ...opts });
  const fwd = { autoscaleInfoProvider: () => null }; // the cone and the prediction lines reach the axis through steadyAxis
  const s = {
    ema9: line(C.ema9, { lineWidth: 2 }), ema21: line(C.ema21, { lineWidth: 2 }), rma9: line(C.rma, { lineStyle: LineStyle.Dashed }), rma21: line(C.rma + '99', { lineStyle: LineStyle.Dotted }),
    bbUp: line(C.boll, { lineWidth: 1 }), bbLo: line(C.boll, { lineWidth: 1 }), bbMid: line('#8b95a733', { lineWidth: 1, lineStyle: LineStyle.Dotted }),
    vwap: line(C.vwap, { lineWidth: 2, lineStyle: LineStyle.Dashed }),
    // the cone's edges, faint: the band itself is filled on the overlay (paintLayer)
    hi90: line(`rgba(${C.cone},0.22)`, { lineWidth: 1, ...fwd }), lo90: line(`rgba(${C.cone},0.22)`, { lineWidth: 1, ...fwd }),
    hi50: line(`rgba(${C.cone},0.38)`, { lineWidth: 1, ...fwd }), lo50: line(`rgba(${C.cone},0.38)`, { lineWidth: 1, ...fwd }),
    ...Object.fromEntries(Object.entries(SRC).map(([k, [, col]]) => [k, line(col, { lineWidth: 1.5, ...fwd })])), // named in the legend, not on the axis
  };
  const rsi = rsiChart.addLineSeries({ color: C.rma, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 3 });
  rsi.createPriceLine({ price: 70, color: '#ff4d6d66', lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
  rsi.createPriceLine({ price: 50, color: '#8b95a733', lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
  rsi.createPriceLine({ price: 30, color: '#2ee6a666', lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
  const mHist = macdChart.addHistogramSeries({ ...MF, priceLineVisible: false, lastValueVisible: false });
  const mLine = macdChart.addLineSeries({ ...MF, color: C.ema9, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 3 });
  const mSig = macdChart.addLineSeries({ ...MF, color: C.ema21, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  // RSI and MACD scroll and zoom with the main chart
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (r) for (const c of [rsiChart, macdChart]) c.timeScale().setVisibleLogicalRange(r);
    paintLayer();
    if (liveBtn) liveBtn.hidden = liveOnScreen(r); // the live candle scrolled out of view: show LIVE
  });
  // the live candle is the candle series' last bar (the predictions after it don't count)
  const liveIndex = () => (candles.data?.().length ?? 0) - 1;
  function liveOnScreen(r = chart.timeScale().getVisibleLogicalRange()) { const i = liveIndex(); return !r || i < 0 || (i >= r.from - 0.5 && i <= r.to - 1); }
  liveBtn?.addEventListener('click', () => { // back to now, keeping the zoom: the live candle plus the minutes to the close
    const r = chart.timeScale().getVisibleLogicalRange(), i = liveIndex();
    if (!r || i < 0) return chart.timeScale().scrollToRealTime();
    const width = r.to - r.from, ahead = Math.min(16, width * 0.4);
    chart.timeScale().setVisibleLogicalRange({ from: i + ahead - width, to: i + ahead });
  });
  new ResizeObserver(() => { const w = main.clientWidth; if (w) for (const c of [chart, rsiChart, macdChart]) c.applyOptions({ width: w }); paintLayer(); }).observe(main);

  // ---------- the legend (TradingView style): O/H/L/C and each overlay's value at the crosshair, else the live candle;
  // over the forecast it reads the cone at that minute. Text in text colors; a swatch carries each series' identity ----------
  const leg = document.createElement('div'); leg.className = 'tv-legend'; main.parentElement.appendChild(leg);
  const subLeg = (el) => { el.style.position = 'relative'; const x = document.createElement('div'); x.className = 'tv-legend sub'; el.appendChild(x); return x; };
  const rsiLeg = subLeg(rsiEl), macdLeg = subLeg(macdEl);
  let rows = [], idxOf = new Map(), coneAt = new Map(), hover = null, hoverFc = null, tfLabel = '';
  const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : NUMF.format(v)), fmtM = (v) => (v == null || !Number.isFinite(v) ? '—' : MACDF.format(v));
  const sw = (col, dash = false) => `<i class="sw${dash ? ' d' : ''}" style="--c:${col}"></i>`;
  const item = (h) => `<span class="li">${h}</span>`; // a swatch never wraps away from its label
  const html = (el, h) => { if (el.__h !== h) { el.innerHTML = h; el.__h = h; } };
  function paintLegend() {
    if (!rows.length) return;
    if (hoverFc) {
      const f = hoverFc;
      html(leg, `<div class="hd"><b>${name}</b><span class="tf">forecast · ${TIME.format(f.t * 1000)}</span></div><div class="it">${f.mid != null ? item(`${sw(C.path, true)}expected <em>${fmt(f.mid)}</em>`) : ''}${item(`50% <em>${fmt(f.lo50)}</em>–<em>${fmt(f.hi50)}</em>`)}${item(`90% <em>${fmt(f.lo90)}</em>–<em>${fmt(f.hi90)}</em>`)}${f.src.length ? `</div><div class="it">${f.src.map(([n, col, v]) => item(`${sw(col)}${n} <em>${fmt(v)}</em>`)).join('')}` : ''}</div>`);
      return;
    }
    const i = hover ?? rows.length - 1, r = rows[i], p = rows[i - 1];
    const ch = p ? r.c - p.c : null, cls = ch > 0 ? 'pos' : ch < 0 ? 'neg' : '';
    // compact on a phone: the close and its change; open / high / low / close while you drag
    const head = `<b>${name}</b><span class="tf">${tfLabel}</span>` + (hover != null ? `<span>O <em>${fmt(r.o)}</em></span><span>H <em>${fmt(r.h)}</em></span><span>L <em>${fmt(r.l)}</em></span>` : '') + `<span>C <em>${fmt(r.c)}</em></span>`
      + (ch != null ? `<span class="${cls}">${ch > 0 ? '+' : ch < 0 ? '−' : ''}${fmt(Math.abs(ch))} (${(Math.abs(ch / p.c) * 100).toFixed(2)}%)</span>` : '')
      + (show.beasts && trend && hover == null ? `<span class="trend ${trend}">${trend === 'bull' ? '▲ bull' : '▼ bear'}</span>` : '');
    const items = [];
    if (show.ema) items.push(`${sw(C.ema9)}EMA 9 <em>${fmt(r.ema9)}</em>`, `${sw(C.ema21)}EMA 21 <em>${fmt(r.ema21)}</em>`);
    if (show.rma) items.push(`${sw(C.rma, true)}RMA 9/21 <em>${fmt(r.rma9)}</em>/<em>${fmt(r.rma21)}</em>`);
    if (show.vwap) items.push(`${sw(C.vwap, true)}VWAP <em>${fmt(r.vwap)}</em>`);
    if (show.boll && hover != null) items.push(`${sw('#8b95a7')}BB <em>${fmt(r.bbLo)}</em>–<em>${fmt(r.bbUp)}</em>`);
    if (show.volume && r.v && hover != null) items.push(`Vol <em>${r.v >= 1000 ? `${(r.v / 1000).toFixed(1)}k` : r.v.toFixed(r.v < 10 ? 2 : 0)}</em>`);
    html(leg, `<div class="hd">${head}</div>${items.length ? `<div class="it">${items.map(item).join('')}</div>` : ''}`);
    html(rsiLeg, r.rsi == null ? '' : `${sw(C.rma)}RSI 14 <em>${r.rsi.toFixed(1)}</em>${r.rsi > 70 ? ' <span class="neg">overbought</span>' : r.rsi < 30 ? ' <span class="pos">oversold</span>' : ''}`);
    html(macdLeg, r.macd == null ? '' : `MACD 12/26/9 ${sw(C.ema9)}<em>${fmtM(r.macd)}</em> ${sw(C.ema21)}signal <em>${fmtM(r.sig)}</em> hist <em class="${r.hist >= 0 ? 'pos' : 'neg'}">${fmtM(r.hist)}</em>`);
  }
  chart.subscribeCrosshairMove((pt) => {
    const tt = pt?.time ?? null;
    hover = tt != null && idxOf.has(tt) ? idxOf.get(tt) : null;
    hoverFc = tt != null && hover == null ? coneAt.get(tt) ?? null : null;
    paintLegend();
    const r = hover != null ? rows[hover] : null;
    try { if (r?.rsi != null && !rsiEl.hidden) rsiChart.setCrosshairPosition(r.rsi, tt, rsi); else rsiChart.clearCrosshairPosition(); } catch { /* not drawn yet */ }
    try { if (r?.macd != null && !macdEl.hidden) macdChart.setCrosshairPosition(r.macd, tt, mLine); else macdChart.clearCrosshairPosition(); } catch { /* not drawn yet */ }
  });

  let lines = {}, last = null, key = null, barMs = 60000, show = {}, bubbles = [], orders = [], trend = null, levels = [], coneData = [], closeAt = null, liveT = null, pats = null;
  let barsKey = null, liveAt = 0, marksKey = null, gmKey = null, wmKey = null; // what's on screen, to change only what changed

  // ---------- data ----------
  function render(d) {
    show = d.show; barMs = d.barMs; orders = d.orders || []; closeAt = d.round ? d.closeTime : null; pats = show.patterns !== false ? d.patterns ?? null : null;
    tfLabel = d.tf === 'round' ? '1m' : d.tf;
    const bars = d.bars;
    if (!bars.length) return;
    const viewKey = `${d.tf}|${d.height}`;
    if (viewKey !== key) { // a new timeframe or size: fresh data and the default view
      key = viewKey;
      chart.applyOptions({ height: d.height });
      for (const l of Object.values(lines)) candles.removePriceLine(l);
      lines = {}; barsKey = null; axis = null; marksKey = null; gmKey = null;
    }
    const t = (b) => sec(b.t);
    const closes = bars.map((b) => b.c);
    // the candles: the whole set only when the bars themselves changed (a new bar, a new timeframe); otherwise just the
    // live one, keeping what the trades since did to it (its close and wicks), so it never jumps back to a staler price
    const nb = bars[bars.length - 1], prevLast = last;
    last = { ...nb };
    if (prevLast && prevLast.t === nb.t) { last.h = Math.max(last.h, prevLast.h); last.l = Math.min(last.l, prevLast.l); if (Date.now() - liveAt < 5000) last.c = prevLast.c; }
    const bk = `${bars.length}|${bars[0].t}|${bars.length > 1 ? `${bars[bars.length - 2].t}|${bars[bars.length - 2].c}` : ''}`;
    if (bk !== barsKey) { barsKey = bk; candles.setData(bars.map((b, i) => (i === bars.length - 1 ? { time: t(b), open: last.o, high: last.h, low: last.l, close: last.c } : { time: t(b), open: b.o, high: b.h, low: b.l, close: b.c }))); }
    else candles.update({ time: t(last), open: last.o, high: last.h, low: last.l, close: last.c });
    volume.applyOptions({ visible: !!show.volume });
    if (show.volume) volume.setData(bars.map((b) => ({ time: t(b), value: b.v || 0, color: b.c >= b.o ? '#2ee6a62a' : '#ff4d6d2a' })));
    const series = (arr) => arr.map((v, i) => (v == null ? { time: t(bars[i]) } : { time: t(bars[i]), value: v }));
    const put = (k, on, arr) => { s[k].applyOptions({ visible: !!on }); if (on) s[k].setData(arr); };
    const E9 = ema(closes, 9), E21 = ema(closes, 21), R9 = rma(closes, 9), R21 = rma(closes, 21), bb = bollinger(closes, 20, 2), VW = vwap(bars, d.round ? d.openTime : bars[0].t);
    put('ema9', show.ema, series(E9)); put('ema21', show.ema, series(E21));
    put('rma9', show.rma, series(R9)); put('rma21', show.rma, series(R21));
    put('bbUp', show.boll, series(bb.map((x) => x?.up))); put('bbLo', show.boll, series(bb.map((x) => x?.lo))); put('bbMid', show.boll, series(bb.map((x) => x?.mid ?? (x ? (x.up + x.lo) / 2 : null))));
    put('vwap', show.vwap, series(VW));
    const RS = rsiSeries(closes, 14), MD = macd(closes);
    rows = bars.map((b, i) => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, ema9: E9[i], ema21: E21[i], rma9: R9[i], rma21: R21[i], vwap: VW[i], bbUp: bb[i]?.up, bbLo: bb[i]?.lo, rsi: RS[i], macd: MD[i]?.macd, sig: MD[i]?.signal, hist: MD[i]?.hist }));
    Object.assign(rows[rows.length - 1], { o: last.o, h: last.h, l: last.l, c: last.c }); liveT = last.t;
    idxOf = new Map(bars.map((b, i) => [t(b), i]));
    // the cone and the prediction lines run from now to the close
    const cone = show.cone && d.cone?.length ? d.cone : [];
    for (const [k, f] of [['hi90', 'hi90'], ['lo90', 'lo90'], ['hi50', 'hi50'], ['lo50', 'lo50']]) put(k, cone.length, dedupe(cone.map((c) => ({ time: sec(c.t), value: c[f] }))));
    // what the steady axis keeps in view beyond the candles: the target and the cone's 90% band
    const ex = [show.strike && d.strike ? d.strike : null, ...cone.flatMap((c) => [c.hi90, c.lo90])].filter(Number.isFinite);
    extra.lo = ex.length ? Math.min(...ex) : null; extra.hi = ex.length ? Math.max(...ex) : null;
    const srcPts = {};
    for (const k of Object.keys(SRC)) {
      const p = show.predict && cone.length ? (d.predictions || []).find((x) => x.key === k) : null;
      const pts = p ? dedupe(p.pts.map((q) => ({ time: sec(q.t), value: q.v }))) : [];
      put(k, !!p, pts); if (p) srcPts[k] = new Map(pts.map((q) => [q.time, q.value]));
    }
    // the expected path's minutes (1-minute bars only: Round and 1m views), from the live candle's close to the horizon
    const pc = barMs === 60000 && d.path?.length ? d.path.filter((c) => c.t > last.t) : [];
    pathLine.setData(cone.length && pc.length ? [{ time: t(last), value: last.c }, ...pc.map((c) => ({ time: sec(c.t), value: c.c }))] : []);
    // the cone for the overlay's filled bands and the legend's forecast read
    const pathAt = new Map(pc.map((c) => [sec(c.t), c.c]));
    coneData = dedupe(cone.map((c) => ({ time: sec(c.t), value: 0, ...c }))).map((c) => ({ time: c.time, hi90: c.hi90, lo90: c.lo90, hi50: c.hi50, lo50: c.lo50 }));
    coneAt = new Map(coneData.map((c) => [c.time, { t: c.time, ...c, mid: pathAt.get(c.time) ?? (c.hi50 + c.lo50) / 2, src: Object.entries(srcPts).filter(([, m]) => m.has(c.time)).map(([k, m]) => [SRC[k][0], SRC[k][1], m.get(c.time)]) }]));
    // predicted flips on it: ↺ where the expected path turns (public/flip.js)
    const gm = pc.length && show.flips !== false ? (d.turns || []).filter((x) => pc.some((c) => c.t === x.t)).map((x) => ({ time: sec(x.t), position: x.dir === 'up' ? 'belowBar' : 'aboveBar',
      color: x.dir === 'up' ? '#2ee6a6' : '#ff4d6d', shape: x.dir === 'up' ? 'arrowUp' : 'arrowDown', text: `↺ flip ${x.dir}` })) : [];
    // where this round closes, when the predictions run past it into the next one
    const gk = JSON.stringify(gm);
    if (gk !== gmKey) { gmKey = gk; pathLine.setMarkers(gm.sort((a, b) => a.time - b.time)); }
    // levels: the target and the round's floor / ceiling, moved in place (deleting and redrawing them made the labels flash)
    const want = {};
    if (show.strike && d.strike) want.strike = { price: d.strike, color: C.strike, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '', tag: 'target' };
    // the prediction engine's call: its entry level (the target above is its invalidation)
    if (d.round && d.forecast?.entry && d.forecast.call !== 'NO CALL') want.entry = { price: d.forecast.entry, color: d.forecast.call === 'UP' ? '#2ee6a6' : '#ff4d6d', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: '', tag: `entry ${d.forecast.call}` };
    const fc = d.round && show.floorCeil ? floorCeiling(bars, d.openTime) : null;
    if (fc) {
      want.floor = { price: fc.floor, color: '#2ee6a699', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '', tag: 'floor' };
      want.ceil = { price: fc.ceiling, color: '#ff4d6d99', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '', tag: 'ceiling' };
    }
    candles.applyOptions({ lastValueVisible: !!show.labels });
    // market structure (public/structure.js): the nearest unfilled fair value gap above and below the last finished
    // candle's close (measured from the live price they hopped about every tick)
    if (show.structure && d.structure?.fvg?.length && barMs === 60000) {
      const px = bars.length > 1 ? bars[bars.length - 2].c : last.c, above = d.structure.fvg.filter((g) => g.lo > px).sort((a, b) => a.lo - b.lo)[0], below = d.structure.fvg.filter((g) => g.hi < px).sort((a, b) => b.hi - a.hi)[0];
      for (const [k, g] of [['fvgUp', above], ['fvgDn', below]]) if (g) want[k] = { price: (g.lo + g.hi) / 2, color: '#e879f999', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '', tag: 'FVG' };
    }
    for (const [k, l] of Object.entries(lines)) if (!want[k]) { candles.removePriceLine(l); delete lines[k]; }
    for (const [k, { tag, ...o }] of Object.entries(want)) { if (lines[k]) lines[k].applyOptions(o); else lines[k] = candles.createPriceLine(o); }
    levels = Object.values(want).map((o) => ({ price: o.price, color: o.color, tag: o.tag }));
    // markers: the bot's calls, your trades and the Auto-trader's, EMA 9/21 crosses
    const marks = [];
    const inView = (ms) => ms >= bars[0].t && ms < last.t + barMs;
    const barOf = (ms) => sec(bars[Math.max(0, bars.findIndex((b) => b.t + barMs > ms))].t);
    // a flip predicted right now sits on the live candle (later ones go on the prediction candles)
    if (show.flips !== false && barMs === 60000) for (const x of d.turns || []) if (x.now && x.t === last.t) marks.push({ time: sec(x.t), position: x.dir === 'up' ? 'belowBar' : 'aboveBar', color: x.dir === 'up' ? '#2ee6a6' : '#ff4d6d', shape: x.dir === 'up' ? 'arrowUp' : 'arrowDown', text: `↺ flip ${x.dir} now` });
    // liquidity sweeps and structure shifts
    if (show.structure && barMs === 60000) for (const [e, label] of [[d.structure?.sweep, 'sweep'], [d.structure?.shift, 'MSS']]) if (e && inView(e.t)) marks.push({ time: barOf(e.t), position: e.dir > 0 ? 'belowBar' : 'aboveBar', color: '#e879f9', shape: e.dir > 0 ? 'arrowUp' : 'arrowDown', text: `${label} ${e.dir > 0 ? '↑' : '↓'}` });
    if (show.markers) for (const m of d.markers || []) if (inView(m.t)) marks.push({ time: barOf(m.t), position: m.side === 'YES' ? 'belowBar' : 'aboveBar', color: m.side === 'YES' ? C.up : C.dn, shape: m.side === 'YES' ? 'arrowUp' : 'arrowDown', text: m.label });
    if (show.fills) for (const f of d.fills || []) if (inView(f.t)) marks.push({ time: barOf(f.t), position: f.kind === 'buy' ? 'belowBar' : 'aboveBar', color: f.kind === 'buy' ? '#22d3ee' : f.kind === 'bail' ? C.dn : '#fbbf24', shape: 'circle', text: `${f.kind === 'buy' ? 'B' : f.kind === 'bail' ? '✕' : 'S'} ${f.label || ''}`.trim() });
    // chart patterns (public/chartpatterns.js): a marker naming each one where it confirmed; its lines go on the overlay
    // (short tags, the 3 newest: the full names are in the Chart patterns card under the chart)
    for (const e of (pats?.recent || []).slice(0, 3)) if (inView(e.t)) marks.push({ time: barOf(e.t), position: e.dir > 0 ? 'belowBar' : 'aboveBar', color: C.pat, shape: e.dir > 0 ? 'arrowUp' : 'arrowDown', text: `${patTag(e)} ${e.dir > 0 ? '↑' : '↓'}` });
    // why it moved: a marker naming the cause on each candle that made a real move (public/why.js)
    if (show.why !== false) for (const n of d.notes || []) if (inView(n.t)) marks.push({ time: barOf(n.t), position: n.dir === 'up' ? 'aboveBar' : 'belowBar', color: '#c4b5fd', shape: 'circle', size: 0.6, text: n.tag });
    const e9 = ema(closes, 9), e21 = ema(closes, 21);
    trend = e9.at(-1) != null && e21.at(-1) != null ? (e9.at(-1) >= e21.at(-1) ? 'bull' : 'bear') : null;
    if (show.beasts) for (let i = 1, lastI = -9; i < bars.length; i++) {
      if ([e9[i], e21[i], e9[i - 1], e21[i - 1]].some((v) => v == null) || (e9[i] >= e21[i]) === (e9[i - 1] >= e21[i - 1]) || i - lastI < 4) continue;
      lastI = i;
      const up = e9[i] >= e21[i];
      marks.push({ time: t(bars[i]), position: up ? 'belowBar' : 'aboveBar', color: up ? C.up : C.dn, shape: up ? 'arrowUp' : 'arrowDown', size: 0.4, text: up ? '🐂' : '🐻' }); // a small arrow and the animal (the old squares cluttered longer timeframes) (the colored squares under them cluttered longer timeframes)
    }
    const mk = JSON.stringify(marks);
    if (mk !== marksKey) { marksKey = mk; candles.setMarkers(marks.sort((a, b) => a.time - b.time)); }
    // the trend as a quiet watermark (set only when it changes)
    // (the trend reads in the legend now: the old watermark sat right over the candles)
    if (wmKey !== 'off') { wmKey = 'off'; chart.applyOptions({ watermark: { visible: false } }); }
    // RSI / MACD
    rsiEl.hidden = !show.rsi; macdEl.hidden = !show.macd;
    if (show.rsi) rsi.setData(series(RS));
    if (show.macd) {
      mHist.setData(MD.map((x, i) => (x.hist == null ? { time: t(bars[i]) } : { time: t(bars[i]), value: x.hist, color: x.hist >= 0 ? '#2ee6a677' : '#ff4d6d77' })));
      mLine.setData(series(MD.map((x) => x.macd))); mSig.setData(series(MD.map((x) => x.signal)));
    }
    if (d.resetView) fitDefault(d.viewFrom);
    paintLegend();
    paintLayer();
  }
  function fitDefault(fromMs) {
    const data = candles.data?.() ?? null;
    const n = data ? data.length : 0;
    if (fromMs && n) {
      const i = data.findIndex((b) => b.time >= sec(fromMs));
      const ahead = key?.startsWith('round') ? (closeAt && last ? Math.min(18, Math.max(3, Math.ceil((closeAt - last.t) / barMs) + 2)) : 12) : 3; // the round: up to its close, not a fixed 16 (bigger candles)
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i) - 0.5, to: n + ahead });
    } else chart.timeScale().scrollToRealTime();
  }
  // Each trade moves the live candle (the library redraws only what changed)
  function live(price) {
    if (!last || !price) return;
    if (Date.now() >= last.t + barMs) return; // the next bar arrives with the next refresh
    last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; liveAt = Date.now();
    candles.update({ time: sec(last.t), open: last.o, high: last.h, low: last.l, close: price });
    const r = rows[rows.length - 1]; if (r && liveT === last.t) { Object.assign(r, { h: last.h, l: last.l, c: price }); if (hover == null && !hoverFc) paintLegend(); }
    paintLayer();
  }

  // ---------- the live-order bubbles, on a transparent canvas over the chart ----------
  let raf = 0;
  function paintLayer() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (drawBubbles()) paintLayer(); });
  }
  function drawBubbles() {
    const w = main.clientWidth, h = main.clientHeight;
    if (!w || !h) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (layer.width !== Math.round(w * dpr) || layer.height !== Math.round(h * dpr)) { layer.width = Math.round(w * dpr); layer.height = Math.round(h * dpr); layer.style.height = `${h}px`; }
    const ctx = layer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!last) return false;
    try { drawOverlay(ctx, w, h); } catch { /* a frame before the chart has laid out */ }
    if (!show.orders) return false;
    const now = Date.now();
    bubbles = liveBubbles(orders, now);
    const ts = chart.timeScale(), spacing = ts.options().barSpacing;
    const plotW = w - (chart.priceScale('right').width() || 60);
    let alive = false;
    for (const x of bubbles) {
      const age = now - (x.at ?? x.t);
      if (age < 0 || age > 3000) continue;
      alive = true;
      const barT = x.t - ((x.t - last.t) % barMs + barMs) % barMs;
      const bx = ts.timeToCoordinate(sec(barT));
      const cy0 = candles.priceToCoordinate(x.price);
      if (bx == null || cy0 == null) continue;
      const cx = Math.min(plotW - 4, bx + ((x.t - barT) / barMs - 0.5) * spacing);
      const col = x.whale ? '#fbbf24' : x.side === 'buy' ? C.up : C.dn;
      const r0 = Math.min(x.whale ? 20 : 13, 3 + Math.sqrt(x.usd / 2000) * 1.3);
      const cy = cy0 - (Math.min(age, 2500) / 2500) * 10;
      if (age < 2500) {
        const k = Math.min(1, age / 220), r = r0 * Math.max(0.05, k < 1 ? 1.18 * k - 0.18 * k * k * k : 1);
        ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
        ctx.globalAlpha = 0.95; ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.stroke();
        ctx.globalAlpha = 0.5; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, Math.max(1, r * 0.22), 0, 7); ctx.fill();
        if (x.move != null && k >= 1) { // how far this order moved the price
          ctx.globalAlpha = 0.95; ctx.fillStyle = col; ctx.font = "600 9px 'JetBrains Mono', ui-monospace, monospace"; ctx.textAlign = 'center';
          const label = `${x.side === 'buy' ? '+' : '−'}$${Math.round(x.move)}`;
          ctx.lineWidth = 3; ctx.strokeStyle = C.bg; ctx.strokeText(label, cx, cy - r - 3); // readable over the lines behind it
          ctx.fillText(label, cx, cy - r - 3);
        }
      } else {
        const k = (age - 2500) / 500, fade = 1 - k;
        ctx.globalAlpha = fade * 0.9; ctx.strokeStyle = col; ctx.lineWidth = 2 * fade + 0.5; ctx.beginPath(); ctx.arc(cx, cy, r0 * (1 + 0.9 * k), 0, 7); ctx.stroke();
        ctx.fillStyle = col;
        for (let j = 0; j < 6; j++) { const a = (j / 6) * Math.PI * 2 + (x.t % 7), dd = r0 * (1 + 1.8 * k); ctx.beginPath(); ctx.arc(cx + Math.cos(a) * dd, cy + Math.sin(a) * dd, Math.max(0.6, 2.2 * fade), 0, 7); ctx.fill(); }
      }
      ctx.globalAlpha = 1;
    }
    return alive;
  }

  // ---------- the overlay under the bubbles: the forecast zone, the cone as filled bands, the round's close, level tags ----------
  function drawOverlay(ctx, w, h) {
    const ts = chart.timeScale(), plotW = w - (chart.priceScale('right').width() || 60), plotH = h - (ts.height() || 26);
    const y = (p) => candles.priceToCoordinate(p), spacing = ts.options().barSpacing;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();
    // the forecast zone: everything right of the live candle, faintly shaded, with a "now" line
    const lx = ts.logicalToCoordinate(liveIndex());
    if (coneData.length && lx != null && lx < plotW) {
      const x0 = lx + spacing / 2;
      ctx.fillStyle = `rgba(${C.cone},0.035)`; ctx.fillRect(x0, 0, plotW - x0, plotH);
      ctx.setLineDash([3, 4]); ctx.strokeStyle = '#8b95a755'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, plotH); ctx.stroke(); ctx.setLineDash([]);
      // the cone: the 90% band, then the 50% band over it, filled (one hue: how likely, not which source)
      const pts = coneData.map((c) => ({ x: ts.timeToCoordinate(c.time), c })).filter((q) => q.x != null);
      const start = { x: x0, c: { hi90: last.c, lo90: last.c, hi50: last.c, lo50: last.c } };
      const band = (hi, lo, a) => {
        const ps = [start, ...pts.filter((q) => q.x >= x0)]; if (ps.length < 2) return;
        ctx.beginPath(); ps.forEach((q, i) => { const yy = y(q.c[hi]); if (yy == null) return; i ? ctx.lineTo(q.x, yy) : ctx.moveTo(q.x, yy); });
        for (let i = ps.length - 1; i >= 0; i--) { const yy = y(ps[i].c[lo]); if (yy != null) ctx.lineTo(ps[i].x, yy); }
        ctx.closePath(); ctx.fillStyle = `rgba(${C.cone},${a})`; ctx.fill();
      };
      if (show.cone) { band('hi90', 'lo90', 0.08); band('hi50', 'lo50', 0.14); }
      ctx.font = "600 9px 'JetBrains Mono', ui-monospace, monospace"; ctx.fillStyle = '#8b95a7'; ctx.textAlign = 'left';
      const cx = closeAt ? ts.timeToCoordinate(sec(closeAt)) : null;
      if (!(cx != null && cx - x0 < 90)) ctx.fillText('FORECAST ›', x0 + 6, plotH - 8);
      // the round's close: a line and its time
      if (cx != null && cx > x0 && cx < plotW) {
        ctx.setLineDash([2, 3]); ctx.strokeStyle = '#e8ecf377'; ctx.beginPath(); ctx.moveTo(cx + 0.5, 0); ctx.lineTo(cx + 0.5, plotH); ctx.stroke(); ctx.setLineDash([]);
        const lbl = `close ${TIME.format(closeAt)}`, tw = ctx.measureText(lbl).width + 10, bx = Math.min(plotW - tw - 2, cx + 4);
        ctx.fillStyle = '#0a0f1ae6'; ctx.fillRect(bx, plotH - 20, tw, 15); ctx.fillStyle = '#e8ecf3'; ctx.fillText(lbl, bx + 5, plotH - 9);
      }
    }
    // chart patterns: the confirmed shapes' lines solid, the one still forming dashed (its breakout lines)
    if (pats) {
      const xy = (t, p) => ({ x: ts.timeToCoordinate(sec(t)), y: y(p) });
      const draw = (ln, dash, alpha) => {
        const a = xy(ln.t1, ln.p1), b = xy(ln.t2, ln.p2);
        if (a.x == null || b.x == null || a.y == null || b.y == null) return;
        ctx.setLineDash(dash); ctx.strokeStyle = `rgba(${C.patRgb},${alpha})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      };
      for (const e of (pats.recent || []).filter((x) => x.lines?.length).slice(0, 2)) for (const ln of e.lines) draw(ln, [], 0.85); // the 2 newest shapes
      if (pats.forming) {
        for (const ln of pats.forming.lines) draw(ln, [4, 3], 0.7);
        const ln = pats.forming.lines[0], a = xy(ln.t2, ln.p2);
        if (a.x != null && a.y != null) { ctx.font = "600 9px 'JetBrains Mono', ui-monospace, monospace"; ctx.textAlign = 'right'; ctx.fillStyle = C.pat; ctx.fillText(`${pats.forming.name} forming`, Math.min(plotW - 4, a.x), a.y - 6); }
      }
      ctx.setLineDash([]);
    }
    // level tags on the left edge (the past, never over the forecast), spread so they never overlap, kept under the
    // legend; the axis keeps only the price and the target
    if (show.labels && levels.length) {
      ctx.font = "600 9px 'JetBrains Mono', ui-monospace, monospace"; ctx.textAlign = 'left';
      const top = (leg.offsetHeight || 0) + 14;
      const tags = levels.map((l) => ({ ...l, y: y(l.price), text: `${l.tag} ${NUMF.format(l.price)}` })).filter((l) => l.y != null && l.y > -8 && l.y < plotH + 8).sort((a, b) => a.y - b.y);
      if (tags.length && tags[0].y < top) tags[0].y = top;
      for (let i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < 14) tags[i].y = tags[i - 1].y + 14;
      const over = tags.length ? tags[tags.length - 1].y - (plotH - 8) : 0; if (over > 0) for (const tg of tags) tg.y -= over;
      for (const tg of tags) {
        const tw = ctx.measureText(tg.text).width + 12, bx = 4;
        ctx.fillStyle = '#0a0f1acc'; ctx.fillRect(bx, tg.y - 6, tw, 12);
        ctx.fillStyle = tg.color; ctx.fillRect(bx, tg.y - 6, 3, 12);
        ctx.fillStyle = C.ink; ctx.fillText(tg.text, bx + 7, tg.y + 3);
      }
    }
    ctx.restore();
  }

  return { render, live, paint: paintLayer, resetView: () => chart.timeScale().scrollToRealTime(), chart };
}
// Line data must have strictly increasing times (the cone's last step can land on the same second as the close)
function dedupe(pts) { const out = []; for (const p of pts) { if (out.length && out[out.length - 1].time >= p.time) out[out.length - 1] = p; else out.push(p); } return out; }
