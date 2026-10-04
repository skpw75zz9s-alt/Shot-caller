// Candlestick reading for entry timing: is now a good moment to buy the low?
// Candles are { t, o, h, l, c }, oldest first, 1-minute bars.

// Wilder's RSI. Returns { value, prev } so callers can see the turn.
export function rsi(closes, n = 14) {
  if (closes.length < n + 2) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  let prev = val(), value = prev;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    prev = value; value = val();
  }
  return { value, prev };
}

// Bollinger Bands on the last `n` closes. pctB is 0 at the lower band, 1 at the upper.
export function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  const mid = w.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  const upper = mid + k * sd, lower = mid - k * sd;
  const last = closes[closes.length - 1];
  return { mid, upper, lower, pctB: upper === lower ? 0.5 : (last - lower) / (upper - lower) };
}

// Average true range: the typical 1-minute move in dollars.
export function atr(candles, n = 14) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i], pc = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const w = trs.slice(-n);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

// Recent support (lowest low) and resistance (highest high).
export function levels(candles, lookback = 30) {
  const w = candles.slice(-lookback);
  if (!w.length) return null;
  return { support: Math.min(...w.map((c) => c.l)), resistance: Math.max(...w.map((c) => c.h)) };
}

// Single and two-bar reversal patterns. dir +1 = bullish (a low is in), -1 = bearish (a high is in).
export function detectPattern(prev, cur) {
  const range = cur.h - cur.l;
  if (range <= 0) return null;
  const body = Math.abs(cur.c - cur.o);
  const upper = cur.h - Math.max(cur.o, cur.c);
  const lower = Math.min(cur.o, cur.c) - cur.l;
  if (prev) {
    const pBody = Math.abs(prev.c - prev.o);
    if (prev.c < prev.o && cur.c > cur.o && cur.c >= prev.o && cur.o <= prev.c && body > pBody) return { name: 'Bullish engulfing', dir: 1 };
    if (prev.c > prev.o && cur.c < cur.o && cur.c <= prev.c && cur.o >= prev.o && body > pBody) return { name: 'Bearish engulfing', dir: -1 };
  }
  if (body <= range * 0.35 && lower >= Math.max(body * 2, range * 0.55) && upper <= range * 0.2) return { name: 'Hammer', dir: 1 };
  if (body <= range * 0.35 && upper >= Math.max(body * 2, range * 0.55) && lower <= range * 0.2) return { name: 'Shooting star', dir: -1 };
  return null;
}

// Every pattern in the series, for chart markers.
export function patterns(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const p = detectPattern(candles[i - 1], candles[i]);
    if (p) out.push({ i, t: candles[i].t, ...p });
  }
  return out;
}

// Merge the live spot into the candle series as the in-progress bar.
export function withLiveBar(candles, spot, now = Date.now()) {
  if (!spot || !candles.length) return candles.slice();
  const t = Math.floor(now / 60000) * 60000;
  const last = candles[candles.length - 1];
  if (last.t === t) return [...candles.slice(0, -1), { ...last, c: spot, h: Math.max(last.h, spot), l: Math.min(last.l, spot) }];
  return [...candles, { t, o: last.c, h: Math.max(last.c, spot), l: Math.min(last.c, spot), c: spot }];
}

// Entry timing for the side the model likes.
//   NOW   – price has dipped against you and shows signs of turning: buying the low
//   WAIT  – no dip yet: rest a limit order lower
//   CHASE – price just ran in your favor: you'd be buying the high
// For YES the "low" is a BTC dip; for NO it's a BTC spike (that's when NO is cheap).
export function entrySignal(candles, side, now = Date.now()) {
  const closed = candles.filter((c) => c.t + 60000 <= now);
  const closes = candles.map((c) => c.c);
  const spot = closes[closes.length - 1];
  const r = rsi(closes), bb = bollinger(closes), a = atr(closed), lv = levels(closed);
  if (!side || !r || !bb || !a || !lv) return { state: 'WAIT', score: 0, reasons: ['Need more candles'], rsi: r?.value ?? null, bb, atr: a, ...lv };

  const s = side === 'YES' ? 1 : -1;
  const lastTwo = closed.slice(-3);
  const pats = [detectPattern(lastTwo[0], lastTwo[1]), detectPattern(lastTwo[1], lastTwo[2])].filter(Boolean);
  const reasons = [];
  let score = 0;

  // Oversold (YES) / overbought (NO)
  const stretched = s === 1 ? r.value < 35 : r.value > 65;
  const turning = s === 1 ? r.value > r.prev : r.value < r.prev;
  if (stretched) { score++; reasons.push(`RSI ${r.value.toFixed(0)} ${s === 1 ? 'oversold' : 'overbought'}`); }
  if (stretched && turning) { score++; reasons.push('RSI turning'); }

  // Outside the band
  if (s === 1 ? bb.pctB < 0.1 : bb.pctB > 0.9) { score++; reasons.push(s === 1 ? 'At lower band' : 'At upper band'); }

  // Testing support / resistance
  const level = s === 1 ? lv.support : lv.resistance;
  if (Math.abs(spot - level) <= a * 0.6) { score++; reasons.push(s === 1 ? `Testing support $${level.toFixed(0)}` : `Testing resistance $${level.toFixed(0)}`); }

  // Reversal candle in our direction
  const rev = pats.find((p) => p.dir === s);
  if (rev) { score++; reasons.push(rev.name); }
  const against = pats.find((p) => p.dir === -s);
  if (against) { score--; reasons.push(`${against.name} (against)`); }

  const chasing = s === 1 ? r.value > 68 || bb.pctB > 0.95 : r.value < 32 || bb.pctB < 0.05;
  let state = 'WAIT';
  if (score >= 2) state = 'NOW';
  else if (chasing) { state = 'CHASE'; reasons.unshift(s === 1 ? 'Price just ran up' : 'Price just dumped'); }
  if (!reasons.length) reasons.push('No dip yet');

  // Where the "low" is: support/resistance if it's close, otherwise one typical move away.
  const dipLevel = s === 1
    ? (spot - lv.support < a * 2 ? lv.support : spot - a)
    : (lv.resistance - spot < a * 2 ? lv.resistance : spot + a);

  return { state, score, reasons, rsi: r.value, bb, atr: a, support: lv.support, resistance: lv.resistance, dipLevel, pattern: pats[pats.length - 1] ?? null };
}

// Signs the move is flipping against an open position (YES wants BTC up, NO wants it down).
export function flipSigns(candles, side, now = Date.now()) {
  const closed = candles.filter((c) => c.t + 60000 <= now);
  const closes = candles.map((c) => c.c);
  const r = rsi(closes), bb = bollinger(closes), a = atr(closed), lv = levels(closed);
  if (!side || !r || !bb || !a || !lv || closed.length < 3) return [];
  const s = side === 'YES' ? 1 : -1;
  const against = (c) => (s === 1 ? c.c < c.o : c.c > c.o);
  const live = candles[candles.length - 1], last = closed[closed.length - 1], prev = closed[closed.length - 2];
  const out = [];

  const pats = [detectPattern(closed[closed.length - 3], prev), detectPattern(prev, last)].filter(Boolean);
  const rev = pats.find((p) => p.dir === -s);
  if (rev) out.push(rev.name);
  if (s === 1 ? r.value > 65 && r.value < r.prev : r.value < 35 && r.value > r.prev) out.push(`RSI ${r.value.toFixed(0)} rolling over`);
  if ((s === 1 ? bb.pctB > 0.9 : bb.pctB < 0.1) && against(last)) out.push(s === 1 ? 'Rejected at upper band' : 'Bounced off lower band');
  const level = s === 1 ? lv.resistance : lv.support;
  if (Math.abs(live.c - level) <= a * 0.6 && against(live)) out.push(s === 1 ? `Stalling at resistance $${level.toFixed(0)}` : `Bouncing at support $${level.toFixed(0)}`);
  if (against(last) && against(prev) && Math.abs(last.c - prev.o) > a) out.push('Two strong candles against you');
  return out;
}
