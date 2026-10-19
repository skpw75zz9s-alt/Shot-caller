// What Ask's AI can look up (v13.63): every market the app knows, live, from the server's own readers. The tools are
// read-only and answer from memory (no outside calls), so a question about any market, at any time, gets real numbers.
//   list_markets      every market: its name, kind, whether its bot runs, the open round and the time left
//   market_now        one market's live round: price, target, time left, the bot's odds at each stage, Kalshi's price,
//                     the lead in typical moves, volatility, the buy signal, the round call, the council's debate, open breaks
//   market_history    its recent one-minute prices: the path, the change, the range
//   market_record     the official record: wins, losses, win rate, streaks, the round calls' record
//   market_strength   the strength meter: how accurate the bot's odds are against a coin flip and Kalshi, and the trend
//   market_learning   which learners have proven themselves and shape the calls, and which are still being tested
//   market_xray       each kind of break's proof (proven, noise, testing), forced closes and the cost of leverage
//   market_drivers    what's moving a stock index, gold or oil: the dollar and rates, its sector, its own buying
// The market book keeps each market bot's latest snapshot (observe, every tick).
import { distance, liqSummary, positioning } from './public/xray.js';

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const pct = (p) => (p == null ? null : Math.round(p * 1000) / 10);
const clip = (o, n = 7000) => { const s = JSON.stringify(o); return s.length <= n ? s : `${s.slice(0, n)}…(cut)`; };

export function createMarketBook({ clock = () => Date.now() } = {}) {
  const book = new Map();
  return {
    observe(series, { snap, sig } = {}) { if (snap) book.set(series, { snap, sig: sig ?? null, at: clock() }); },
    get: (series) => book.get(series) ?? null,
  };
}

const SERIES = { type: 'string', description: 'The market\'s Kalshi series ticker, from list_markets (for example KXBTC15M for Bitcoin\'s 15-minute market).' };
export const ASK_TOOLS = [
  { name: 'list_markets', description: 'List every market the app knows: series ticker, name, asset, kind (crypto, index, commodity), whether its bot is running, and its open round. Call this first when the question names a market by name or asks about several markets ("which market…", "how are the coins doing").',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'market_now', description: 'The live round of one market right now: price, target, minutes left, the bot\'s odds (its own price math, after Kalshi\'s blend, and final), Kalshi\'s bid and ask, the lead in typical moves for the time left, volatility against normal, the buy signal (if any), the locked round call, the council\'s debate, and any breaks open. Call this for any question about a market\'s current state, odds, lead or whether to buy.',
    input_schema: { type: 'object', properties: { series: SERIES }, required: ['series'], additionalProperties: false } },
  { name: 'market_history', description: 'One market\'s recent one-minute closing prices (up to 120 minutes): the path, the change, the high and low. Call this for questions about how the price has moved, trends or ranges.',
    input_schema: { type: 'object', properties: { series: SERIES, minutes: { type: 'integer', description: 'How many minutes back, 5 to 120 (default 30).' } }, required: ['series'], additionalProperties: false } },
  { name: 'market_record', description: 'One market\'s official track record: the bot\'s graded calls (wins, losses, win rate, streaks, results by lane) and the round calls\' record. Call this for questions about how well the bot has done.',
    input_schema: { type: 'object', properties: { series: SERIES }, required: ['series'], additionalProperties: false } },
  { name: 'market_strength', description: 'The strength meter for one market: the bot\'s odds scored every second against each round\'s result, compared with a coin flip and Kalshi\'s price, by day and by time left, and whether it is getting stronger. Call this for questions about accuracy, improvement, or the bot against Kalshi.',
    input_schema: { type: 'object', properties: { series: SERIES }, required: ['series'], additionalProperties: false } },
  { name: 'market_learning', description: 'What the bot for one market has learned: each learner, whether it has proven itself and shapes the calls, or is still being tested and why. Call this for questions about what the bot uses or learns.',
    input_schema: { type: 'object', properties: { series: SERIES }, required: ['series'], additionalProperties: false } },
  { name: 'market_xray', description: 'The X-ray for one market: each kind of break\'s proof (proven, proven wrong, noise, still testing), forced closes in futures and the cost of leverage (crypto). Call this for questions about breaks, anomalies, or whether a signal is real.',
    input_schema: { type: 'object', properties: { series: SERIES }, required: ['series'], additionalProperties: false } },
  { name: 'market_drivers', description: 'What is moving a stock index, gold or oil market: how much of the recent move came from the dollar and interest rates, from the rest of its market, and from its own buyers and sellers. Not for crypto. Call this for "why is it moving" questions about those markets.',
    input_schema: { type: 'object', properties: { series: SERIES, minutes: { type: 'integer', description: 'The window in minutes: 15, 60 or 240 (default 60).' } }, required: ['series'], additionalProperties: false } },
];

export function createAskTools({ book, discovery, stacks, marketOf, listed, isHome, home, council, breakLab, strength, crossFeed, clock = () => Date.now() }) {
  const known = () => discovery.list().filter((m) => listed(m)); // discovery already lists only the timeframes the server runs
  // a series the app knows (case-insensitive), or an error the AI can act on
  function resolve(series) {
    const s = String(series || '').trim().toUpperCase(), all = known();
    const m = all.find((x) => x.series === s) ?? (isHome(s) ? { series: s } : null);
    if (!m) return { error: `unknown market "${series}". Call list_markets for the series tickers.`, markets: all.slice(0, 40).map((x) => x.series) };
    if (!isHome(m.series) && !stacks.has(m.series)) { stacks.start(m.series); return { error: `the ${marketOf(m.series, all).name} market's bot is starting: ask again in a minute or two` }; }
    return { series: m.series, mk: marketOf(m.series, all) };
  }
  const botOf = (s) => (isHome(s) ? home.bot : stacks.bot(s)), stackOf = (s) => (isHome(s) ? home : stacks.stack(s));
  function liveRow(snap) { return (snap?.rows || []).filter((r) => r.ev?.minutesLeft > 0).sort((a, b) => a.ev.minutesLeft - b.ev.minutesLeft)[0] ?? null; }

  const run = {
    list_markets() {
      const now = clock();
      return { now: new Date(now).toISOString(), markets: known().map((m) => {
        const mk = marketOf(m.series, discovery.list()), b = book.get(m.series), lv = liveRow(b?.snap);
        return { series: m.series, name: mk.name, asset: mk.key, kind: mk.kind, freq: m.freq, running: isHome(m.series) || stacks.has(m.series),
          round: lv ? { ticker: lv.m.ticker, minutesLeft: round(lv.ev.minutesLeft, 1), botUp: pct(lv.ev.pYes) } : null };
      }) };
    },
    market_now({ series }) {
      const r = resolve(series); if (r.error) return r;
      const b = book.get(r.series), snap = b?.snap, lv = liveRow(snap), now = clock();
      if (!snap) return { market: r.mk.name, error: 'no live reading yet: its bot hasn\'t taken a reading (it has just started, or the server runs it only while phones are subscribed)' };
      if (!lv) return { market: r.mk.name, series: r.series, openRound: null, note: 'no round open right now (between rounds, or the market is closed)', price: snap.mSpot ?? snap.spot ?? null };
      const q = lv.ev.quote || {}, spot = snap.mSpot ?? snap.spot, sig = b.sig, d = distance({ spot, strike: lv.strike, sigmaMin: lv.sigma ?? snap.sigmaMin, minutesLeft: lv.ev.minutesLeft });
      const pick = botOf(r.series).pick?.(), deb = council?.api?.(r.series), open = breakLab?.open?.(r.series) || [];
      return {
        market: r.mk.name, series: r.series, asOf: new Date(b.at).toISOString(), ageSec: Math.round((now - b.at) / 1000),
        round: { ticker: lv.m.ticker, title: lv.m.title ?? null, closes: lv.m.close_time, minutesLeft: round(lv.ev.minutesLeft, 2), strikeType: lv.m.strike_type ?? null, target: lv.strike, price: round(spot, 6), delayed: !!snap.delayed },
        lead: d ? { gap: round(d.gap, 6), typicalMoveLeft: round(d.move, 6), typicalMovesAway: round(d.z, 2), side: d.gap >= 0 ? 'above the target' : 'below the target' } : null,
        volatility: { perMinute: round(lv.sigma ?? snap.sigmaMin, 6), vsNormal: snap.sigmaLong > 0 ? round((lv.sigma ?? snap.sigmaMin) / snap.sigmaLong, 2) : null },
        odds: { botUpFinal: pct(lv.ev.pYes), botUpPriceMathOnly: pct(lv.pBot), botUpAfterKalshiBlend: pct(lv.pPre), kalshiUpBid: pct(q.yesBid), kalshiUpAsk: pct(q.yesAsk), kalshiDownAsk: pct(q.noAsk) },
        buySignal: sig?.callSide ? { side: sig.callSide === 'YES' ? 'UP' : 'DOWN', price: pct(sig.price), worstCaseWinChance: pct(sig.winProb), confidence: sig.deep?.score ?? null, holdOdds: pct(sig.hold) } : { none: true, why: sig?.reason ?? sig?.why ?? null },
        roundCall: pick?.live ? { side: pick.live.side === 'YES' ? 'UP' : pick.live.side === 'NO' ? 'DOWN' : pick.live.side, lockedAt: pick.live.at ? new Date(pick.live.at).toISOString() : null, odds: pct(pick.live.p) } : { notLockedYet: true, locksAt: pick?.locksAt ? new Date(pick.locksAt).toISOString() : null },
        council: deb?.ticker === lv.m.ticker && deb.debate ? { verdict: deb.debate.verdict, netPointsOnUp: round(deb.debate.net * 100, 1), arguments: deb.debate.rulings.map((x) => ({ feature: x.name, side: x.side === 'YES' ? 'UP' : 'DOWN', points: round(x.pts * 100, 1), ruling: x.status, why: x.why })) } : null,
        breaksOpen: open.map((x) => ({ break: x.title, detail: x.detail, proof: x.proofText ?? null })),
        otherStrikes: (snap.rows || []).filter((x) => x !== lv && x.ev?.minutesLeft > 0).length,
      };
    },
    market_history({ series, minutes = 30 }) {
      const r = resolve(series); if (r.error) return r;
      const snap = book.get(r.series)?.snap; if (!snap?.bars?.length) return { market: r.mk.name, error: 'no price history yet' };
      const n = Math.max(5, Math.min(120, Math.round(Number(minutes) || 30))), bars = snap.bars.slice(-n), c = bars.map((x) => x.c);
      return { market: r.mk.name, minutes: bars.length, from: new Date(bars[0].t).toISOString(), first: c[0], last: c.at(-1), change: round(c.at(-1) - c[0], 6), changePct: round((c.at(-1) / c[0] - 1) * 100, 3),
        high: Math.max(...bars.map((x) => x.h ?? x.c)), low: Math.min(...bars.map((x) => x.l ?? x.c)), closes: c.map((v) => round(v, 6)) };
    },
    market_record({ series }) {
      const r = resolve(series); if (r.error) return r;
      const rec = botOf(r.series).record?.(); if (!rec) return { market: r.mk.name, error: 'no record yet' };
      const slim = ({ calls, ...x }) => x;
      return { market: r.mk.name, level: rec.level, since: rec.since, official: slim(rec), late: rec.late, flip: rec.flip, roundCalls: rec.pick ? slim(rec.pick) : null, nearCertain: rec.certain ? slim(rec.certain) : null,
        lastCalls: (rec.calls || []).slice(-10).map((e) => ({ ticker: e.ticker, side: e.side === 'YES' ? 'UP' : 'DOWN', price: pct(e.price), result: e.result ?? 'open' })) };
    },
    market_strength({ series }) { const r = resolve(series); if (r.error) return r; const s = strength?.api?.(r.series); return s ? { market: r.mk.name, ...s, daily: s.daily.slice(-14) } : { market: r.mk.name, error: 'the strength meter is off' }; },
    market_learning({ series }) {
      const r = resolve(series); if (r.error) return r;
      const st = botOf(r.series).learnStatus?.();
      return { market: r.mk.name, learners: (st?.using || []).map((u) => ({ learner: u.name, shapesCalls: !!u.on, detail: u.detail })), council: council?.api?.(r.series)?.records ?? null };
    },
    market_xray({ series }) {
      const r = resolve(series); if (r.error) return r;
      const st = stackOf(r.series), now = clock(), p = breakLab?.api?.(r.series);
      return { market: r.mk.name, breakProof: p ? Object.fromEntries(Object.entries(p.kinds).map(([k, v]) => [k, { status: v.status, text: v.text }])) : null,
        breaksOpen: (breakLab?.open?.(r.series) || []).map((x) => x.title),
        forcedCloses30m: st?.scanFeed?.liqs ? liqSummary(st.scanFeed.liqs(), now) : null, futures: st?.futures ? positioning(st.futures.context(now)) : null };
    },
    market_drivers({ series, minutes = 60 }) {
      const r = resolve(series); if (r.error) return r;
      if (r.mk.kind === 'crypto') return { market: r.mk.name, error: 'drivers are for stock indexes, gold and oil; for crypto use market_now and market_xray' };
      const w = [15, 60, 240].includes(Number(minutes)) ? Number(minutes) : 60, d = crossFeed?.why?.(r.mk.key, w);
      if (!d?.supported || !d.parts) return { market: r.mk.name, note: 'not enough driver history yet' };
      return { market: r.mk.name, windowMinutes: w, move: round(d.move, 4), parts: d.parts.map((x) => ({ group: x.group, driver: x.name, usd: round(x.usd, 4) })), fitR2: d.fit?.r2All ?? null };
    },
  };
  // run one tool call: never throws, always returns text for a tool_result
  async function call(name, input) {
    const f = run[name];
    if (!f) return { error: true, text: JSON.stringify({ error: `no tool called ${name}` }) };
    try { return { error: false, text: clip(await f(input && typeof input === 'object' ? input : {})) }; }
    catch (e) { return { error: true, text: JSON.stringify({ error: `the ${name} lookup failed: ${String(e?.message || e).slice(0, 200)}` }) }; }
  }
  return { defs: ASK_TOOLS, call };
}
