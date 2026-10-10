// The Chart tab's toggles and the live-order bubbles' timing. The chart itself is drawn by TradingView's
// Lightweight Charts (public/tvchart.js).
export const CHART_TOGGLES = [
  ['strike', 'Target (price to beat)', true], ['ema', 'EMA 9 / 21', true], ['rma', 'RMA 9 / 21', false], ['boll', 'Bollinger 20 ±2σ', true],
  ['vwap', 'VWAP (from round open)', true], ['floorCeil', 'Round floor / ceiling', true], ['cone', 'Forecast cone to the close', true],
  ['volume', 'Volume', true], ['rsi', 'RSI 14', true], ['macd', 'MACD 12/26/9', true], ['markers', 'Call markers', true], ['labels', 'Price labels', true],
  ['beasts', 'Bull / bear trend + EMA crosses', true],
  ['predict', 'Prediction lines in the cone (Bot, Kalshi, 5 exchanges)', true],
  ['orders', 'Live orders (big trades, all exchanges)', true], ['fills', 'My trades + Auto-trader buys/sells', true],
];
export const chartDefaults = () => Object.fromEntries(CHART_TOGGLES.map(([k, , on]) => [k, on]));

// Every big trade ($2k+, 5 exchange feeds) is a bubble that pops in at its price and moment, drifts up a little, then
// bursts and disappears (about 3s). Size = dollars, green = a buyer lifted the ask, red = a seller hit the bid,
// gold = a whale. tvchart.js draws them.
export const BUBBLE_LIFE = 3000; // ms from appearing to gone
export function liveBubbles(orders, now = Date.now(), max = 40) {
  const out = [];
  for (let i = orders.length - 1; i >= 0 && out.length < max; i--) {
    const x = orders[i], age = now - (x.at ?? x.t);
    if (age > BUBBLE_LIFE) break; // oldest-first list: everything before this is gone too
    if (age >= 0) out.push(x);
  }
  return out;
}
