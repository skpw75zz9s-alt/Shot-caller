// Chart indicators and timeframes. Pure functions over candles { t, o, h, l, c, v } (oldest first).
// Every series returns one value per candle (null until it has enough data), so it lines up with the bars.

export function ema(xs, n) {
  const k = 2 / (n + 1), out = [];
  let e = null;
  xs.forEach((x, i) => {
    if (i < n - 1) { out.push(null); return; }
    e = e == null ? xs.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : x * k + e * (1 - k);
    out.push(e);
  });
  return out;
}

// Wilder's moving average (RMA): the smoothing RSI uses; slower than an EMA of the same length
export function rma(xs, n) {
  const out = [];
  let r = null;
  xs.forEach((x, i) => {
    if (i < n - 1) { out.push(null); return; }
    r = r == null ? xs.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : (r * (n - 1) + x) / n;
    out.push(r);
  });
  return out;
}

export function bollinger(xs, n = 20, k = 2) {
  return xs.map((_, i) => {
    if (i < n - 1) return null;
    const w = xs.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    return { mid: m, up: m + k * sd, lo: m - k * sd };
  });
}

// Volume-weighted average price from `from` (e.g. the round's open) onward; typical price (h+l+c)/3
export function vwap(candles, from = -Infinity) {
  let pv = 0, vol = 0;
  return candles.map((c) => {
    if (c.t < from) return null;
    const v = c.v > 0 ? c.v : 0;
    pv += ((c.h + c.l + c.c) / 3) * v; vol += v;
    return vol > 0 ? pv / vol : null;
  });
}

export function rsiSeries(xs, n = 14) {
  const out = [null];
  let up = null, dn = null;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i < n) { out.push(null); continue; }
    if (up == null) {
      let su = 0, sw = 0;
      for (let j = i - n + 1; j <= i; j++) { const dd = xs[j] - xs[j - 1]; su += Math.max(dd, 0); sw += Math.max(-dd, 0); }
      up = su / n; dn = sw / n;
    } else { up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + w) / n; }
    out.push(dn === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / dn));
  }
  return out;
}

export function macd(xs, fast = 12, slow = 26, signal = 9) {
  const f = ema(xs, fast), s = ema(xs, slow);
  const line = xs.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const start = line.findIndex((x) => x != null);
  const sig = start < 0 ? line.map(() => null) : [...line.slice(0, start).map(() => null), ...ema(line.slice(start), signal)];
  return line.map((m, i) => (m == null || sig[i] == null ? { macd: m, signal: null, hist: null } : { macd: m, signal: sig[i], hist: m - sig[i] }));
}

// Combine 1-minute (or any) candles into `minutes`-long bars aligned to the clock
export function aggregate(candles, minutes) {
  const ms = minutes * 60000, out = [];
  for (const c of candles) {
    const t = Math.floor(c.t / ms) * ms, last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v || 0; }
    else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
  }
  return out;
}

// The round's floor and ceiling so far: its lowest low and highest high since the open
export function floorCeiling(candles, openTime) {
  const w = candles.filter((c) => c.t >= openTime);
  if (!w.length) return null;
  return { floor: Math.min(...w.map((c) => c.l)), ceiling: Math.max(...w.map((c) => c.h)) };
}

// Where BTC is likely to be at each minute until the close, by the bot's own volatility: the middle 50% and 90%
// of outcomes (z = 0.674 and 1.645). The cone narrows to nothing at "now" and widens toward the close.
export function forecastCone(spot, sigmaMin, now, close, step = 60000) {
  if (!spot || !sigmaMin || !(close > now)) return [];
  const out = [];
  for (let t = now; t <= close + 1; t += step) {
    const sd = spot * sigmaMin * Math.sqrt((t - now) / 60000);
    out.push({ t, lo50: spot - 0.674 * sd, hi50: spot + 0.674 * sd, lo90: spot - 1.645 * sd, hi90: spot + 1.645 * sd });
  }
  if (out[out.length - 1].t < close) { const sd = spot * sigmaMin * Math.sqrt((close - now) / 60000); out.push({ t: close, lo50: spot - 0.674 * sd, hi50: spot + 0.674 * sd, lo90: spot - 1.645 * sd, hi90: spot + 1.645 * sd }); }
  return out;
}

// Chart timeframes: what to fetch from Coinbase (granularity in seconds) and how many to combine
export const TIMEFRAMES = {
  round: { label: 'Round', gran: 60, combine: 1 },
  '1m': { label: '1m', gran: 60, combine: 1 },
  '5m': { label: '5m', gran: 300, combine: 1 },
  '15m': { label: '15m', gran: 900, combine: 1 },
  '1h': { label: '1h', gran: 3600, combine: 1 },
  '4h': { label: '4h', gran: 3600, combine: 4 },
  '1d': { label: '1D', gran: 86400, combine: 1 },
};
