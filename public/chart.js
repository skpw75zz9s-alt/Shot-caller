// The Chart tab's toggles and the live-order bubbles' timing. The chart itself is drawn by TradingView's
// Lightweight Charts (public/tvchart.js).
export const CHART_TOGGLES = [
  ['strike', 'Target (price to beat)', true], ['ema', 'EMA 9 / 21', true], ['rma', 'RMA 9 / 21', false], ['boll', 'Bollinger 20 ±2σ', true],
  ['vwap', 'VWAP (from round open)', true], ['floorCeil', 'Round floor / ceiling', true], ['cone', 'Forecast cone to the close', true],
  ['volume', 'Volume', true], ['rsi', 'RSI 14', true], ['macd', 'MACD 12/26/9', true], ['markers', 'Call markers', true], ['labels', 'Price labels', true],
  ['beasts', 'Bull / bear trend + EMA crosses', true],
  ['predict', 'Prediction lines in the cone (Bot, Kalshi, 5 exchanges)', true],
  ['orders', 'Live orders (only ones that move the price)', true], ['fills', 'My trades + Auto-trader buys/sells', true],
  ['why', 'Why it moved (explains each real move)', true],
];
export const chartDefaults = () => Object.fromEntries(CHART_TOGGLES.map(([k, , on]) => [k, on]));

// Only trades that MOVE the market become bubbles. Fills on one exchange, on the same side, less than a second apart
// are one order (a market order sweeping the book arrives as several fills); it bubbles when it pushes that exchange's
// price its way by a real amount: at least $5, and at least 30% of BTC's typical 10-second move right now. Trades the
// book soaks up without the price moving (even whales) don't bubble. Size = dollars, green = buyers pushed it up,
// red = sellers pushed it down, gold = a whale; the label is how far it moved the price. tvchart.js draws them.
export const BUBBLE_LIFE = 3000; // ms from appearing to gone
export const IMPACT = { minUsd: 2000, minMove: 5, volShare: 0.3, gapMs: 1000 };
export function createImpact(opts = {}) {
  const o = { ...IMPACT, ...opts };
  const ex = {}; // exchange -> { last (price before the current order), burst }
  return function push(x, { sigmaMin = 0.0008, now = Date.now() } = {}) {
    const e = (ex[x.ex] ||= { last: null, burst: null });
    let b = e.burst;
    if (!b || b.side !== x.side || x.t - b.lastT > o.gapMs || x.t < b.lastT - o.gapMs) {
      if (b) e.last = b.lastPrice;
      b = e.burst = { side: x.side, from: e.last, usd: 0, lastPrice: x.price, lastT: x.t, bubble: null, whale: false };
    }
    b.usd += x.price * x.size; b.lastPrice = x.price; b.lastT = x.t; b.whale ||= !!x.whale;
    if (b.from == null) return null; // the first trade seen on this exchange: nothing to measure against
    const move = (x.price - b.from) * (x.side === 'buy' ? 1 : -1);
    const need = Math.max(o.minMove, x.price * sigmaMin * Math.sqrt(10 / 60) * o.volShare);
    if (move < need || b.usd < o.minUsd) return null;
    if (b.bubble) { Object.assign(b.bubble, { price: x.price, usd: b.usd, move, whale: b.whale }); return null; } // the same order kept pushing: grow its bubble
    b.bubble = { t: x.t, at: now, price: x.price, usd: b.usd, side: x.side, whale: b.whale, ex: x.ex, move };
    return b.bubble;
  };
}
export function liveBubbles(orders, now = Date.now(), max = 40) {
  const out = [];
  for (let i = orders.length - 1; i >= 0 && out.length < max; i--) {
    const x = orders[i], age = now - (x.at ?? x.t);
    if (age > BUBBLE_LIFE) break; // oldest-first list: everything before this is gone too
    if (age >= 0) out.push(x);
  }
  return out;
}
