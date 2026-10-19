// The X-ray tab (v13.56): the live market seen through, layer by layer, on one screen. Each layer reads one part of what
// is going on right now and says which way it leans (UP, DOWN or neither) and how hard, and whether the bot's calls use
// it. Pure: the tab (app.js renderXray) gathers what the phone and the server already collect and passes it here.
//   odds      the bot's odds and Kalshi's, and how far the price is from the target in typical moves for the time left
//   pulse     how wild the market is now against normal, and how big a move the minutes left usually bring
//   crowd     this round's money on Kalshi, UP vs DOWN, and its biggest orders
//   flow      buyers vs sellers on the exchanges over the last 1, 5 and 10 minutes (crypto), and the Round scan's read
//   whales    whale trades on the exchanges in the last 15 minutes (crypto)
//   leverage  futures: forced closes (liquidations), funding and open interest (crypto)
//   drivers   what's moving it: the dollar and rates, the rest of its market, and its own buying and selling (stock
//             indexes, gold, oil)
//   money     spot-ETF flows, the stablecoin supply and on-chain whale transfers (crypto, on probation until proven)
// It's a picture, not a call: layers that agree aren't proof, and only proven ones move the bot's odds.

export const XRAY = { flat: 0.15, flowWindows: [1, 5, 10], whaleMinutes: 15, liqMinutes: 30, calm: 0.75, wild: 1.4 };
const clamp = (x) => Math.max(-1, Math.min(1, x));
const money = (v) => { const a = Math.abs(v); return a >= 1e9 ? `$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `$${Math.round(a)}`; };
const pct = (p) => `${Math.round(p * 100)}%`;
const share = (a, b) => (a + b > 0 ? (a - b) / (a + b) : 0); // -1 all b … +1 all a

// ---------- readers ----------
// this round's Kalshi orders: UP vs DOWN totals and the biggest ones ([{ t, side: 'YES'|'NO', count, price, usd }])
export function kalshiBig(trades, { top = 6 } = {}) {
  const xs = Array.isArray(trades) ? trades.filter((x) => x && x.usd > 0) : [];
  const sum = (side) => xs.filter((x) => x.side === side).reduce((a, x) => ({ usd: a.usd + x.usd, n: a.n + 1 }), { usd: 0, n: 0 });
  const up = sum('YES'), down = sum('NO');
  return { up, down, total: up.usd + down.usd, upShare: up.usd + down.usd > 0 ? up.usd / (up.usd + down.usd) : null, top: [...xs].sort((a, b) => b.usd - a.usd).slice(0, top) };
}
// exchange buyers vs sellers over the last few minutes ([{ t, price, size, side: taker 'buy'|'sell' }])
export function flowWindows(trades, now, windows = XRAY.flowWindows) {
  const xs = Array.isArray(trades) ? trades : [];
  return windows.map((min) => {
    let buy = 0, sell = 0, n = 0;
    for (const x of xs) if (x && x.t >= now - min * 60000 && x.t <= now) { const u = x.price * x.size; if (!(u > 0)) continue; n++; if (x.side === 'buy') buy += u; else if (x.side === 'sell') sell += u; }
    return { min, buy, sell, n, lean: share(buy, sell) };
  });
}
// whale trades in a window ([{ t, ex, side, usd, price }])
export function whaleSummary(whales, now, windowMs = XRAY.whaleMinutes * 60000) {
  const xs = (Array.isArray(whales) ? whales : []).filter((x) => x && x.t >= now - windowMs).sort((a, b) => b.t - a.t);
  const buy = xs.filter((x) => x.side === 'buy').reduce((a, x) => a + x.usd, 0), sell = xs.filter((x) => x.side === 'sell').reduce((a, x) => a + x.usd, 0);
  return { n: xs.length, buy, sell, net: buy - sell, list: xs.slice(0, 6) };
}
// liquidations in a window ([{ t, ex, liq: 'long'|'short', usd, price }]): longs force-sold push down, shorts
// force-bought push up (a squeeze)
export function liqSummary(liqs, now, windowMs = XRAY.liqMinutes * 60000) {
  const xs = (Array.isArray(liqs) ? liqs : []).filter((x) => x && x.t >= now - windowMs);
  const long = xs.filter((x) => x.liq === 'long').reduce((a, x) => a + x.usd, 0), short = xs.filter((x) => x.liq === 'short').reduce((a, x) => a + x.usd, 0);
  return { n: xs.length, long, short, minutes: Math.round(windowMs / 60000), biggest: [...xs].sort((a, b) => b.usd - a.usd).slice(0, 5).map(({ t, ex, liq, usd, price }) => ({ t, ex, liq, usd, price })) };
}
// futures positioning, in plain words (Hyperliquid's context: funding is per hour; premium is perp vs index)
export function positioning(ctx) {
  if (!ctx) return null;
  const f = Number.isFinite(ctx.funding) ? ctx.funding : null, oi5 = Number.isFinite(ctx.oiChange5) ? ctx.oiChange5 : null, px5 = Number.isFinite(ctx.priceChange5) ? ctx.priceChange5 : null;
  const words = [];
  if (f != null) words.push(Math.abs(f) < 0.000005 ? 'funding near zero: neither side crowded' : f > 0 ? `longs paying shorts (${(f * 100).toFixed(4)}%/h): more traders betting up${f > 0.00005 ? ', crowded' : ''}` : `shorts paying longs (${(Math.abs(f) * 100).toFixed(4)}%/h): more traders betting down${f < -0.00005 ? ', crowded' : ''}`);
  if (oi5 != null && px5 != null && Math.abs(oi5) >= 0.001) words.push(oi5 > 0 ? `open interest up ${(oi5 * 100).toFixed(2)}% in 5 min: new money ${px5 >= 0 ? 'buying the rise' : 'selling the drop'}` : `open interest down ${(Math.abs(oi5) * 100).toFixed(2)}% in 5 min: positions closing${px5 >= 0 ? ' (shorts covering?)' : ' (longs giving up?)'}`);
  return { funding: f, oi: ctx.oi ?? null, oiChange5: oi5, priceChange5: px5, premium: Number.isFinite(ctx.premium) ? ctx.premium : null, live: !!ctx.live, words };
}
// where the price is against the target: how many typical moves away for the time left (sigmaMin: per-minute log volatility)
export function distance({ spot, strike, sigmaMin, minutesLeft }) {
  if (!(spot > 0) || !(strike > 0) || !(sigmaMin > 0) || !(minutesLeft > 0)) return null;
  const move = spot * sigmaMin * Math.sqrt(minutesLeft); // a typical (one standard deviation) move in the time left, in $
  return { gap: spot - strike, move, z: Math.log(spot / strike) / (sigmaMin * Math.sqrt(minutesLeft)) };
}
// how wild the market is now, against its longer-run normal
export function pulse(sigmaMin, sigmaLong) {
  if (!(sigmaMin > 0)) return null;
  const ratio = sigmaLong > 0 ? sigmaMin / sigmaLong : null;
  return { ratio, label: ratio == null ? 'unknown' : ratio < XRAY.calm ? 'calm' : ratio > XRAY.wild ? 'wild' : 'normal' };
}

// ---------- the layers ----------
// each: { key, name, lean (-1 DOWN … +1 UP, null = no direction to read), read (one line), facts [lines], use, inCalls, off }
export function xrayLayers(x) {
  const now = x.now ?? Date.now(), crypto = x.kind === 'crypto', L = [], lv = x.live, fmt = x.fmt || ((v) => `$${Number(v).toFixed(2)}`);
  // odds
  if (lv?.pYes != null) {
    const kMid = lv.yesBid != null && lv.yesAsk != null ? (lv.yesBid + lv.yesAsk) / 2 : null, d = distance(lv);
    const facts = [];
    if (d) facts.push(`${fmt(Math.abs(d.gap))} ${d.gap >= 0 ? 'above' : 'below'} the target: ${Math.abs(d.z).toFixed(2)} typical moves for the ${Math.round(lv.minutesLeft)} minute${Math.round(lv.minutesLeft) === 1 ? '' : 's'} left`
      + (Math.abs(d.z) < 0.5 ? ' (close enough to flip on an ordinary move)' : Math.abs(d.z) > 1.5 ? ' (a big move would be needed to flip it)' : ''));
    if (kMid != null) { const gap = Math.round((lv.pYes - kMid) * 100); facts.push(Math.abs(gap) <= 3 ? 'The bot and Kalshi\'s traders agree.' : `The bot is ${Math.abs(gap)} points ${gap > 0 ? 'more bullish' : 'more bearish'} than Kalshi's traders.`); }
    if (lv.pBot != null && Math.abs(lv.pBot - lv.pYes) >= 0.01) facts.push(`From the price alone ${pct(lv.pBot)} UP; the blend with Kalshi and the proven nudges make it ${pct(lv.pYes)}.`);
    L.push({ key: 'odds', name: 'The odds', lean: clamp((lv.pYes - 0.5) * 2), read: `Bot ${pct(lv.pYes)} UP${kMid != null ? ` · Kalshi ${pct(kMid)}` : ''}`, facts, use: 'The bot\'s call is made from these (Deck).', inCalls: true });
    // pulse (no direction)
    const p = pulse(lv.sigmaMin, lv.sigmaLong);
    if (p) L.push({ key: 'pulse', name: 'Pulse', lean: null, read: `${p.label[0].toUpperCase()}${p.label.slice(1)}${p.ratio != null ? ` · ${p.ratio.toFixed(2)}× normal volatility` : ''}`,
      facts: [d ? `A typical move in the time left: ±${fmt(d.move)}.` : null, p.label === 'wild' ? 'Wild markets flip more: the odds already widen for it.' : p.label === 'calm' ? 'Calm markets tend to stay where they are.' : null].filter(Boolean),
      use: 'Volatility is in every call: it sets how far the price can travel before the close.', inCalls: true });
  } else L.push({ key: 'odds', name: 'The odds', lean: null, read: 'No open round right now', facts: [], use: '', inCalls: true, off: true });
  // crowd
  const k = kalshiBig(x.kalshiTrades);
  const kw = Math.min(1, k.total / 2000); // a few dollars of orders is no crowd: the lean grows to full by $2k
  L.push({ key: 'crowd', name: 'Kalshi money', lean: k.total ? clamp(share(k.up.usd, k.down.usd) * kw) : null,
    read: k.total ? `UP ${money(k.up.usd)} vs DOWN ${money(k.down.usd)} this round` : 'No Kalshi orders seen this round yet',
    facts: k.top.map((t) => `${t.side === 'YES' ? 'UP' : 'DOWN'} ${money(t.usd)} (${Math.round(t.count)} @ ${Math.round(t.price * 100)}¢)`), top: k.top,
    use: 'The bot already prices the round from Kalshi\'s quotes.', inCalls: false });
  if (crypto) {
    // flow
    const fw = flowWindows(x.trades, now), f5 = fw.find((w) => w.min === 5) || fw[0], sc = x.scan;
    L.push({ key: 'flow', name: 'Order flow', lean: f5?.n ? clamp(f5.lean * 2) : null, windows: fw,
      read: f5?.n ? `${f5.lean >= 0 ? 'Buyers' : 'Sellers'} ahead: ${pct(Math.max(f5.buy, f5.sell) / (f5.buy + f5.sell || 1))} of ${money(f5.buy + f5.sell)} in 5 min` : 'Waiting for the exchange feeds',
      facts: [...fw.filter((w) => w.n).map((w) => `${w.min} min: bought ${money(w.buy)} · sold ${money(w.sell)}`), sc?.verdict ? `Round scan: ${sc.verdict} (${sc.score > 0 ? '+' : ''}${sc.score})` : null].filter(Boolean),
      use: sc?.inCalls ? 'The Round scan reads this flow and is proven: it nudges the calls.' : 'Feeds the Round scan; it moves the calls only once proven (Signal board).', inCalls: !!sc?.inCalls });
    // whales
    const w = whaleSummary(x.whales, now);
    L.push({ key: 'whales', name: 'Whales', lean: w.n ? clamp(share(w.buy, w.sell)) : null, list: w.list,
      read: w.n ? `${w.n} whale trade${w.n === 1 ? '' : 's'}: bought ${money(w.buy)} · sold ${money(w.sell)}` : `No whale trades in ${XRAY.whaleMinutes} min`,
      facts: w.list.map((t) => `${t.side === 'buy' ? 'Buy' : 'Sell'} ${money(t.usd)}${t.ex ? ` on ${t.ex}` : ''}`),
      use: 'Feeds the Round scan and whale alerts.', inCalls: false });
    // leverage
    const lq = x.srv?.liqs, fu = x.srv?.futures;
    if (lq || fu) {
      const lt = lq ? lq.long + lq.short : 0;
      L.push({ key: 'leverage', name: 'Leverage', lean: lt ? clamp(share(lq.short, lq.long) * Math.min(1, lt / 1e6)) : null,
        read: lt ? `Forced closes: longs ${money(lq.long)} · shorts ${money(lq.short)} (${lq.minutes} min)` : fu?.words?.[0] ? fu.words[0][0].toUpperCase() + fu.words[0].slice(1) : 'Quiet: no forced closes',
        facts: [...(fu?.words || []).map((s) => s[0].toUpperCase() + s.slice(1)), lt ? 'Longs liquidated is forced selling (down); shorts liquidated is forced buying (a squeeze up).' : null].filter(Boolean),
        use: 'Inputs to the Round scan and the micro model; they move the calls only once proven.', inCalls: false });
    } else L.push({ key: 'leverage', name: 'Leverage', lean: null, read: x.srv ? 'No futures data for this coin' : 'Loading…', facts: [], use: '', inCalls: false, off: true });
    // money
    const fl = x.srv?.flows;
    if (fl) {
      const rows = [['etf', 'Spot-ETF flow'], ['stables', 'Stablecoin supply'], ['whale', 'On-chain whales']].map(([kk, nm]) => ({ kk, nm, r: fl[kk]?.read, t: fl[kk]?.test, on: fl[kk]?.on, err: fl[kk]?.err }));
      const reads = rows.filter((r) => r.r && r.r.lean), proven = rows.some((r) => r.t?.proven && r.r?.lean);
      const say = (r) => (r.kk === 'etf' ? `${r.nm} ${r.r.value >= 0 ? '+' : '−'}$${Math.abs(r.r.value).toFixed(0)}M (${r.r.date})` : r.kk === 'stables' ? `${r.nm} ${r.r.value >= 0 ? '+' : '−'}${Math.abs(r.r.value).toFixed(2)}% in 7 days` : `${r.nm}: net ${money(Math.abs(r.r.value))} ${r.r.value >= 0 ? 'onto' : 'off'} exchanges in the last hour`);
      L.push({ key: 'money', name: 'Money flows', lean: reads.length ? clamp(reads.reduce((a, r) => a + r.r.lean, 0) / rows.length) : null,
        read: reads.length ? reads.map((r) => `${r.nm.split(' ')[0]} ${r.r.lean > 0 ? '↑' : '↓'}`).join(' · ') : 'No fresh reading',
        facts: rows.map((r) => (r.r ? `${say(r)}${r.t ? (r.t.proven ? ' · proven' : ' · on probation') : ''}` : !r.on ? `${r.nm}: off${r.kk === 'whale' ? ' (needs WHALE_ALERT_API_KEY)' : ''}` : r.err ? `${r.nm}: ${r.err}` : `${r.nm}: no fresh reading`)),
        use: proven ? 'A proven factor here nudges the calls a little.' : 'Daily numbers on probation (Signal board); a daily edge barely moves a 15-minute round.', inCalls: proven });
    }
  } else {
    // drivers
    const d = x.drivers;
    if (d?.supported && d.parts?.length) {
      const g = (k2) => d.parts.filter((p) => p.group === k2).reduce((a, p) => a + p.usd, 0), parts = [['macro', 'The dollar, rates and stocks'], ['sector', 'The rest of its market'], ['own', 'Its own buyers and sellers']];
      const scale = lv && distance(lv)?.move ? distance(lv).move : Math.abs(d.move) || 1;
      L.push({ key: 'drivers', name: 'What\'s moving it', lean: d.move ? clamp(d.move / scale) : 0,
        read: `${d.move >= 0 ? 'Up' : 'Down'} ${fmt(Math.abs(d.move))} in ${d.w} min`, facts: parts.map(([k2, nm]) => `${nm}: ${g(k2) >= 0 ? '+' : '−'}${fmt(Math.abs(g(k2)))}`),
        use: 'Why it moved, not where it goes next.', inCalls: false });
    } else L.push({ key: 'drivers', name: 'What\'s moving it', lean: null, read: d ? 'Learning its drivers' : 'Loading…', facts: [], use: '', inCalls: false, off: true });
  }
  return L;
}
// how the layers line up: how many lean each way (a lean under XRAY.flat counts as neither) and the strongest push
export function xraySummary(layers) {
  const dir = (layers || []).filter((l) => l.lean != null && !l.off);
  const up = dir.filter((l) => l.lean >= XRAY.flat), down = dir.filter((l) => l.lean <= -XRAY.flat), flat = dir.length - up.length - down.length;
  const strongest = dir.reduce((a, l) => (!a || Math.abs(l.lean) > Math.abs(a.lean) ? l : a), null);
  const tone = up.length && !down.length ? 'up' : down.length && !up.length ? 'down' : up.length || down.length ? 'mixed' : 'flat';
  const lone = up.length + down.length === 1 ? (up[0] || down[0]) : null;
  const headline = !dir.length ? 'Nothing to read yet'
    : lone ? `Only ${lone.name.toLowerCase()} ${lone.name.endsWith('s') ? 'lean' : 'leans'} ${lone.lean > 0 ? 'UP' : 'DOWN'} so far`
      : tone === 'up' ? `${up.length} layers lean UP, none DOWN` : tone === 'down' ? `${down.length} layers lean DOWN, none UP`
        : tone === 'mixed' ? `Mixed: ${up.length} UP, ${down.length} DOWN` : 'No layer leans either way';
  return { up: up.length, down: down.length, flat, tone, headline, strongest: strongest && Math.abs(strongest.lean) >= XRAY.flat ? { key: strongest.key, name: strongest.name, lean: strongest.lean } : null };
}
