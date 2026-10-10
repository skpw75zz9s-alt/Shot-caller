// The Chart tab, drawn with TradingView's Lightweight Charts (Apache-2.0, public/vendor; credit in the Learn tab and
// the TradingView link on the chart itself). The library does the candles, axes, crosshair, pinch / drag / zoom; this
// file adds Shot Caller's layers on top: EMAs, Bollinger, VWAP, the target and the round's floor / ceiling, the
// forecast cone with its prediction lines, call markers, your trades, the live-order bubbles, RSI and MACD.
import { createChart, CrosshairMode, LineStyle } from './vendor/lightweight-charts.js';
import { ema, rma, bollinger, vwap, rsiSeries, macd, floorCeiling } from './indicators.js';
import { liveBubbles } from './chart.js';

const C = { bg: '#0a0f1a', grid: '#ffffff0a', text: '#8b95a7', up: '#2ee6a6', dn: '#ff4d6d', ema9: '#22d3ee', ema21: '#a78bfa', boll: '#7dd3fc55', vwap: '#fbbf24', strike: '#e8ecf3', cone: '#22d3ee' };
const sec = (ms) => Math.floor(ms / 1000);
const TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function baseOptions(height, withTime = true) {
  return {
    height,
    layout: { background: { color: C.bg }, textColor: C.text, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 10, attributionLogo: true },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: '#16203a', scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#16203a', timeVisible: true, secondsVisible: false, visible: withTime, rightOffset: 2, fixLeftEdge: false,
      tickMarkFormatter: (t, type) => (type <= 2 ? DAY.format(t * 1000) : TIME.format(t * 1000)) },
    localization: { timeFormatter: (t) => `${DAY.format(t * 1000)} ${TIME.format(t * 1000)}`, priceFormatter: (p) => NUM.format(p) },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#e8ecf355', labelBackgroundColor: '#16203a' }, horzLine: { color: '#e8ecf355', labelBackgroundColor: '#16203a' } },
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
    handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
    kineticScroll: { touch: true, mouse: false },
  };
}

export function createTvChart({ main, rsiEl, macdEl, layer, liveBtn }) {
  const chart = createChart(main, baseOptions(300));
  const rsiChart = createChart(rsiEl, { ...baseOptions(90, false), rightPriceScale: { borderColor: '#16203a', scaleMargins: { top: 0.1, bottom: 0.1 } }, handleScroll: false, handleScale: false });
  const macdChart = createChart(macdEl, { ...baseOptions(90, false), handleScroll: false, handleScale: false });
  for (const c of [rsiChart, macdChart]) c.applyOptions({ layout: { attributionLogo: false }, crosshair: { horzLine: { visible: false }, vertLine: { visible: false } } }); // one TradingView link (on the main chart) is the credit

  const candles = chart.addCandlestickSeries({ upColor: C.up, downColor: C.dn, wickUpColor: C.up, wickDownColor: C.dn, borderVisible: false, priceLineColor: '#e8ecf3', priceLineStyle: LineStyle.Dashed });
  // prediction candles: ghost minutes from now to the close (public/predict.js predictionCandles)
  const ghosts = chart.addCandlestickSeries({ upColor: '#2ee6a659', downColor: '#ff4d6d59', borderVisible: true, borderUpColor: '#2ee6a6', borderDownColor: '#ff4d6d',
    wickUpColor: '#2ee6a6b3', wickDownColor: '#ff4d6db3', lastValueVisible: false, priceLineVisible: false });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
  const line = (color, opts = {}) => chart.addLineSeries({ color, lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, ...opts });
  const s = {
    ema9: line(C.ema9), ema21: line(C.ema21), rma9: line('#22d3ee88', { lineStyle: LineStyle.Dashed }), rma21: line('#a78bfa88', { lineStyle: LineStyle.Dashed }),
    bbUp: line(C.boll, { lineWidth: 1 }), bbLo: line(C.boll, { lineWidth: 1 }), bbMid: line('#7dd3fc33', { lineWidth: 1, lineStyle: LineStyle.Dotted }),
    vwap: line(C.vwap, { lineStyle: LineStyle.Dashed }),
    hi90: line('#22d3ee40', { lineWidth: 1, lineStyle: LineStyle.Dotted }), lo90: line('#22d3ee40', { lineWidth: 1, lineStyle: LineStyle.Dotted }),
    hi50: line('#22d3ee80', { lineWidth: 1, lineStyle: LineStyle.Dashed }), lo50: line('#22d3ee80', { lineWidth: 1, lineStyle: LineStyle.Dashed }),
    bot: line('#22d3ee', { lineWidth: 2, lastValueVisible: true, title: 'Bot' }),
    kalshi: line('#a78bfa', { lineWidth: 2, lineStyle: LineStyle.Dashed, lastValueVisible: true, title: 'Kalshi' }),
    exch: line('#fbbf24', { lineWidth: 2, lineStyle: LineStyle.Dashed, lastValueVisible: true, title: '5 exch' }),
  };
  const rsi = rsiChart.addLineSeries({ color: '#a78bfa', lineWidth: 1.5, priceLineVisible: false });
  rsi.createPriceLine({ price: 70, color: '#ff4d6d55', lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '' });
  rsi.createPriceLine({ price: 30, color: '#2ee6a655', lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '' });
  const mHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  const mLine = macdChart.addLineSeries({ color: '#22d3ee', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
  const mSig = macdChart.addLineSeries({ color: '#fbbf24', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });

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

  let lines = {}, last = null, key = null, barMs = 60000, show = {}, bubbles = [], orders = [], trend = null;

  // ---------- data ----------
  function render(d) {
    show = d.show; barMs = d.barMs; orders = d.orders || [];
    const bars = d.bars;
    if (!bars.length) return;
    const viewKey = `${d.tf}|${d.height}`;
    if (viewKey !== key) { // a new timeframe or size: fresh data and the default view
      key = viewKey;
      chart.applyOptions({ height: d.height });
      lines = {};
    }
    const t = (b) => sec(b.t);
    const closes = bars.map((b) => b.c);
    candles.setData(bars.map((b) => ({ time: t(b), open: b.o, high: b.h, low: b.l, close: b.c })));
    last = { ...bars[bars.length - 1] };
    volume.applyOptions({ visible: !!show.volume });
    if (show.volume) volume.setData(bars.map((b) => ({ time: t(b), value: b.v || 0, color: b.c >= b.o ? '#2ee6a633' : '#ff4d6d33' })));
    const series = (arr) => arr.map((v, i) => (v == null ? { time: t(bars[i]) } : { time: t(bars[i]), value: v }));
    const put = (k, on, arr) => { s[k].applyOptions({ visible: !!on }); if (on) s[k].setData(arr); };
    put('ema9', show.ema, series(ema(closes, 9))); put('ema21', show.ema, series(ema(closes, 21)));
    put('rma9', show.rma, series(rma(closes, 9))); put('rma21', show.rma, series(rma(closes, 21)));
    const bb = bollinger(closes, 20, 2);
    put('bbUp', show.boll, series(bb.map((x) => x?.up))); put('bbLo', show.boll, series(bb.map((x) => x?.lo))); put('bbMid', show.boll, series(bb.map((x) => x?.mid ?? (x ? (x.up + x.lo) / 2 : null))));
    put('vwap', show.vwap, series(vwap(bars, d.round ? d.openTime : bars[0].t)));
    // the cone and the prediction lines run from now to the close
    const cone = show.cone && d.cone?.length ? d.cone : [];
    for (const [k, f] of [['hi90', 'hi90'], ['lo90', 'lo90'], ['hi50', 'hi50'], ['lo50', 'lo50']]) put(k, cone.length, dedupe(cone.map((c) => ({ time: sec(c.t), value: c[f] }))));
    for (const k of ['bot', 'kalshi', 'exch']) {
      const p = show.predict && cone.length ? (d.predictions || []).find((x) => x.key === k) : null;
      put(k, !!p, p ? dedupe(p.pts.map((q) => ({ time: sec(q.t), value: q.v }))) : []);
      s[k].applyOptions({ lastValueVisible: !!show.labels });
    }
    // prediction candles: only on 1-minute bars (Round and 1m views)
    const pc = show.pcandles && barMs === 60000 && d.predCandles?.length ? d.predCandles.filter((c) => c.t > last.t) : [];
    ghosts.applyOptions({ visible: pc.length > 0 });
    ghosts.setData(pc.map((c) => ({ time: sec(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    // predicted flips on them: ↺ where the expected path turns (public/flip.js)
    ghosts.setMarkers(pc.length && show.flips !== false ? (d.turns || []).filter((x) => pc.some((c) => c.t === x.t)).map((x) => ({ time: sec(x.t), position: x.dir === 'up' ? 'belowBar' : 'aboveBar',
      color: x.dir === 'up' ? '#2ee6a6' : '#ff4d6d', shape: x.dir === 'up' ? 'arrowUp' : 'arrowDown', text: `↺ flip ${x.dir}` })) : []);
    // levels: the target and the round's floor / ceiling
    for (const l of Object.values(lines)) candles.removePriceLine(l);
    lines = {};
    if (show.strike && d.strike) lines.strike = candles.createPriceLine({ price: d.strike, color: C.strike, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'target' });
    const fc = d.round && show.floorCeil ? floorCeiling(bars, d.openTime) : null;
    if (fc) {
      lines.floor = candles.createPriceLine({ price: fc.floor, color: '#2ee6a699', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: !!show.labels, title: 'floor' });
      lines.ceil = candles.createPriceLine({ price: fc.ceiling, color: '#ff4d6d99', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: !!show.labels, title: 'ceiling' });
    }
    candles.applyOptions({ lastValueVisible: !!show.labels });
    // markers: the bot's calls, your trades and the Auto-trader's, EMA 9/21 crosses
    const marks = [];
    const inView = (ms) => ms >= bars[0].t && ms < last.t + barMs;
    const barOf = (ms) => sec(bars[Math.max(0, bars.findIndex((b) => b.t + barMs > ms))].t);
    // a flip predicted right now sits on the live candle (later ones go on the prediction candles)
    if (show.pcandles && show.flips !== false && barMs === 60000) for (const x of d.turns || []) if (x.now && x.t === last.t) marks.push({ time: sec(x.t), position: x.dir === 'up' ? 'belowBar' : 'aboveBar', color: x.dir === 'up' ? '#2ee6a6' : '#ff4d6d', shape: x.dir === 'up' ? 'arrowUp' : 'arrowDown', text: `↺ flip ${x.dir} now` });
    if (show.markers) for (const m of d.markers || []) if (inView(m.t)) marks.push({ time: barOf(m.t), position: m.side === 'YES' ? 'belowBar' : 'aboveBar', color: m.side === 'YES' ? C.up : C.dn, shape: m.side === 'YES' ? 'arrowUp' : 'arrowDown', text: m.label });
    if (show.fills) for (const f of d.fills || []) if (inView(f.t)) marks.push({ time: barOf(f.t), position: f.kind === 'buy' ? 'belowBar' : 'aboveBar', color: f.kind === 'buy' ? '#22d3ee' : f.kind === 'bail' ? C.dn : '#fbbf24', shape: 'circle', text: `${f.kind === 'buy' ? 'B' : f.kind === 'bail' ? '✕' : 'S'} ${f.label || ''}`.trim() });
    // why it moved: a marker naming the cause on each candle that made a real move (public/why.js)
    if (show.why !== false) for (const n of d.notes || []) if (inView(n.t)) marks.push({ time: barOf(n.t), position: n.dir === 'up' ? 'aboveBar' : 'belowBar', color: '#c4b5fd', shape: 'circle', size: 0.6, text: n.tag });
    const e9 = ema(closes, 9), e21 = ema(closes, 21);
    trend = e9.at(-1) != null && e21.at(-1) != null ? (e9.at(-1) >= e21.at(-1) ? 'bull' : 'bear') : null;
    if (show.beasts) for (let i = 1, lastI = -9; i < bars.length; i++) {
      if ([e9[i], e21[i], e9[i - 1], e21[i - 1]].some((v) => v == null) || (e9[i] >= e21[i]) === (e9[i - 1] >= e21[i - 1]) || i - lastI < 4) continue;
      lastI = i;
      const up = e9[i] >= e21[i];
      marks.push({ time: t(bars[i]), position: up ? 'belowBar' : 'aboveBar', color: up ? '#2ee6a699' : '#ff4d6d99', shape: 'square', size: 0.5, text: up ? '🐂' : '🐻' });
    }
    candles.setMarkers(marks.sort((a, b) => a.time - b.time));
    // the trend as a quiet watermark
    chart.applyOptions({ watermark: { visible: !!(show.beasts && trend), text: trend === 'bull' ? 'BULL TREND' : 'BEAR TREND', color: trend === 'bull' ? '#2ee6a614' : '#ff4d6d14', fontSize: 34, horzAlign: 'center', vertAlign: 'center' } });
    // RSI / MACD
    rsiEl.hidden = !show.rsi; macdEl.hidden = !show.macd;
    if (show.rsi) rsi.setData(series(rsiSeries(closes, 14)));
    if (show.macd) {
      const m = macd(closes);
      mHist.setData(m.map((x, i) => (x.hist == null ? { time: t(bars[i]) } : { time: t(bars[i]), value: x.hist, color: x.hist >= 0 ? '#2ee6a688' : '#ff4d6d88' })));
      mLine.setData(series(m.map((x) => x.macd))); mSig.setData(series(m.map((x) => x.signal)));
    }
    if (d.resetView) fitDefault(d.viewFrom);
    paintLayer();
  }
  function fitDefault(fromMs) {
    const data = candles.data?.() ?? null;
    const n = data ? data.length : 0;
    if (fromMs && n) {
      const i = data.findIndex((b) => b.time >= sec(fromMs));
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i) - 0.5, to: n + Math.max(2, (key?.startsWith('round') ? 16 : 3)) });
    } else chart.timeScale().scrollToRealTime();
  }
  // Each trade moves the live candle (the library redraws only what changed)
  function live(price) {
    if (!last || !price) return;
    if (Date.now() >= last.t + barMs) return; // the next bar arrives with the next refresh
    last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price;
    candles.update({ time: sec(last.t), open: last.o, high: last.h, low: last.l, close: price });
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
    if (!show.orders || !last) return false;
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

  return { render, live, paint: paintLayer, resetView: () => chart.timeScale().scrollToRealTime(), chart };
}
// Line data must have strictly increasing times (the cone's last step can land on the same second as the close)
function dedupe(pts) { const out = []; for (const p of pts) { if (out.length && out[out.length - 1].time >= p.time) out[out.length - 1] = p; else out.push(p); } return out; }
