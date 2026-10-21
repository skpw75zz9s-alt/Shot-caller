// Discord market alerts (v13.18): everything market-wide the app alerts on, posted to the Discord webhook next to the
// official calls and results (discord.js). Personal alerts stay on phones only: your positions' sell alerts, adds,
// buy-light, and your phone's own feed health depend on what you hold or how your phone is set.
//   bail     the official call's odds fell under the bail line: sell it
//   flip     the bot now leans against the official call (its odds on it under 50%)
//   cross    BTC crossed the round's target (at most 3 a round, a minute apart)
//   trend    the 1-minute chart's trend turned (EMA 9 crossed EMA 21; 10 minutes apart)
//   whale    one trade of DISCORD_WHALE_MIN dollars or more on a USD exchange (default $250,000; 2 minutes apart)
//   liquidation  a liquidation cascade: DISCORD_LIQ_MIN dollars (default $2,000,000) of longs or of shorts force-closed
//            on the futures exchanges within a minute (public/liquidations.js; 10 minutes apart)
//   hold     Market watch put new calls on hold (bad data, an untradeable book or a violent jump)
//   early    the early lane's test read while it's paused (clearly labelled: a test, not a call)
//   sitout   a round closed with no official call, and how it closed
//   status   the profit guard paused or resumed, the early lane went live or back to testing, the guard's floor moved
// DISCORD_ALERTS picks which: unset = every kind but the sit-out notes (v13.20.1: so the channel is about the calls, not
// a 'no call' every round), 'all' (sit-outs too), 'none', or a comma list (e.g. bail,flip,whale). Besides each kind's
// spacing, at most 30 alerts an hour go out (status changes always do).
import { ema } from './public/indicators.js';

export const ALERT_KINDS = ['bail', 'flip', 'cross', 'trend', 'whale', 'liquidation', 'hold', 'early', 'sitout', 'status'];
export const ALERT_LIMITS = { perHour: 30, crossPerRound: 3, crossGapMs: 60000, trendGapMs: 10 * 60000, whaleGapMs: 2 * 60000, whaleMin: 250000, liqMin: 2000000, liqGapMs: 10 * 60000 };

export const DEFAULT_ALERTS = ALERT_KINDS.filter((k) => k !== 'sitout');
export function alertKinds(raw = process.env.DISCORD_ALERTS) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v || v === 'default') return new Set(DEFAULT_ALERTS);
  if (v === 'all') return new Set(ALERT_KINDS);
  if (v === 'none' || v === 'off') return new Set();
  return new Set(v.split(/[\s,]+/).filter((k) => ALERT_KINDS.includes(k)));
}

const COLORS = { up: 0x2ee6a6, down: 0xff4d6d, warn: 0xfbbf24, info: 0x22d3ee, grey: 0x5d6880, gold: 0xf7931a };
const side = (s) => (s === 'YES' ? 'UP' : 'DOWN');
const pc = (p) => `${Math.round(p * 100)}%`;
const cents = (p) => `${Math.round(p * 100)}¢`;
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
// a price at the coin's own precision (v13.42.3: DOGE's $0.078 used to read $0), a size in whole coins once it's big
const px = (v, mk) => (Math.abs(v) >= 1000 ? money(v) : `$${Number(v).toFixed(mk?.digits ?? 2)}`);
const qty = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
const BTC = { key: 'BTC', digits: 2 };
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:t>`;

// The embeds (pure)
export const alertEmbeds = {
  bail: ({ b, ticker }) => ({ title: `🚨 BAIL OUT · ${side(b.side)} call`, color: COLORS.down,
    description: `The bot's odds on its ${side(b.side)} call fell to ${pc(b.p)}. If you bought it, selling now keeps ${b.bid ? `about ${cents(b.bid)} of each $1` : 'part of it'} instead of risking all of it.`, fields: [{ name: 'Market', value: `\`${ticker}\``, inline: true }] }),
  flip: ({ called, p, ticker }) => ({ title: `↺ FLIP WARNING · the bot now leans against its ${side(called)} call`, color: COLORS.warn,
    description: `Its odds on ${side(called)} are down to ${pc(p)}. Not a bail yet: that comes if they keep falling.`, fields: [{ name: 'Market', value: `\`${ticker}\``, inline: true }] }),
  cross: ({ above, spot, strike, minsLeft, mk = BTC }) => ({ title: `${above ? '⬆️' : '⬇️'} ${mk.key} crossed ${above ? 'above' : 'below'} the target`, color: above ? COLORS.up : COLORS.down,
    description: `${mk.key} ${px(spot, mk)} vs the target ${px(strike, mk)}, ${minsLeft.toFixed(1)} minutes left in the round.` }),
  trend: ({ bull, price, mk = BTC }) => ({ title: bull ? '🐂 Chart turns bull' : '🐻 Chart turns bear', color: bull ? COLORS.up : COLORS.down,
    description: `EMA 9 crossed ${bull ? 'above' : 'below'} EMA 21 on the 1-minute chart (${mk.key} ${px(price, mk)}). A trend read, not a call.` }),
  whale: ({ x, mk = BTC, filter = null }) => ({ title: `🐋 Whale ${x.side === 'buy' ? 'buy' : 'sell'}: ${money(x.price * x.size)}`, color: x.side === 'buy' ? COLORS.up : COLORS.down,
    description: `${qty(x.size)} ${mk.key} at ${px(x.price, mk)} on ${x.ex}.${filter ? ` Whale filter: ${filter.label} (${filter.why}).` : ''}` }),
  liquidation: ({ side, usd, n, mk = BTC }) => ({ title: `💥 Liquidation cascade: ${money(usd)} of ${side === 'long' ? 'longs' : 'shorts'} force-closed`, color: side === 'long' ? COLORS.down : COLORS.up,
    description: `${n} liquidations in the last minute on the futures exchanges: forced ${side === 'long' ? 'selling' : 'buying'}, which often pushes ${mk.key} ${side === 'long' ? 'down' : 'up'} for a few minutes. A read, not a call.` }),
  hold: ({ h }) => ({ title: '⚠️ Market watch: new calls on hold', color: COLORS.warn, description: `${h.why}\nOn hold until ${ts(h.until)}.` }),
  early: ({ w, ticker, closeTime }) => ({ title: `🧪 Early read (TEST, not a call) · ${side(w.side)} at ${cents(w.price)}`, color: COLORS.grey,
    description: `The early lane would call ${side(w.side)} here (the bot's worst case ${pc(w.p)}), but it's paused after its recent calls lost money after fees: this is logged and graded, not a call to buy.`,
    fields: [{ name: 'Closes', value: ts(Date.parse(closeTime)), inline: true }, { name: 'Market', value: `\`${ticker}\``, inline: true }] }),
  sitout: ({ result, ticker, value, strike, mk = BTC }) => ({ title: `😴 No call · the round closed ${result === 'yes' ? 'UP' : 'DOWN'}`, color: COLORS.grey,
    description: `Nothing cleared the bar this round${value && strike ? `: ${mk.key} settled ${px(value, mk)} vs the target ${px(strike, mk)}` : ''}.`, fields: [{ name: 'Market', value: `\`${ticker}\``, inline: true }] }),
  status: ({ text, good }) => ({ title: good ? '✅ Bot status' : '⏸️ Bot status', color: good ? COLORS.up : COLORS.warn, description: text }),
};

// The watcher: fed the official bot's every tick (bot.js onTick), each settled round (onRound) and big trades (whale)
export function createAlertWatcher({ post, market = BTC, kinds = alertKinds(), whaleMin = Number(process.env.DISCORD_WHALE_MIN) || ALERT_LIMITS.whaleMin, liqMin = Number(process.env.DISCORD_LIQ_MIN) || ALERT_LIMITS.liqMin, limits = ALERT_LIMITS, moversOnly = process.env.DISCORD_WHALES === 'movers' } = {}) {
  const rounds = new Map(); // ticker -> what's been posted this round
  const sent = []; // times of the last hour's alerts
  let trendBull = null, trendAt = 0, whaleAt = 0, prev = null, liqAt = 0;
  const liqs = []; // the last minute's liquidations
  const send = (kind, args, now, always = false) => {
    if (!kinds.has(kind)) return false;
    while (sent.length && sent[0] < now - 3600000) sent.shift();
    if (!always && sent.length >= limits.perHour) return false;
    sent.push(now);
    return post(alertEmbeds[kind]({ mk: market, ...args })) !== false;
  };
  const round = (t) => { let r = rounds.get(t); if (!r) { rounds.set(t, (r = { crosses: 0 })); if (rounds.size > 20) rounds.delete(rounds.keys().next().value); } return r; };

  function tick({ snap, sig, status = {}, now }) {
    const live = snap?.live;
    if (live && sig) {
      const t = live.m.ticker, r = round(t), ev = live.ev;
      // a flip call starts a fresh watch on the new side
      if (sig.flip?.from && !r.flipped) { r.flipped = true; r.bail = false; r.flip = false; }
      // the official call going bad
      if (sig.called && ev.pYes != null) {
        const p = sig.called === 'YES' ? ev.pYes : 1 - ev.pYes;
        if (sig.bail && !r.bail) r.bail = send('bail', { b: sig.bail, ticker: t }, now) || true;
        else if (!sig.bail && p < 0.5 && !r.flip && !r.bail) r.flip = send('flip', { called: sig.called, p, ticker: t }, now) || true;
      }
      // BTC crossing the target
      const spot = snap.mSpot ?? snap.spot;
      if (spot && live.strike && ev.minutesLeft > 0) {
        const above = spot > live.strike;
        if (r.above != null && above !== r.above && r.crosses < limits.crossPerRound && now - (r.crossAt || 0) >= limits.crossGapMs) {
          r.crosses++; r.crossAt = now; send('cross', { above, spot, strike: live.strike, minsLeft: ev.minutesLeft }, now);
        }
        r.above = above;
      }
      // the early lane's test read, once a round
      if (sig.early?.would && !sig.early.live && !r.early) r.early = send('early', { w: sig.early.would, ticker: t, closeTime: live.m.close_time }, now) || true;
      if (sig.callSide) r.called = true;
    }
    // the 1-minute trend (finished candles only)
    const closes = (snap?.bars || []).slice(0, -1).map((b) => b.c);
    if (closes.length >= 22) {
      const e9 = ema(closes, 9).at(-1), e21 = ema(closes, 21).at(-1), bull = e9 > e21;
      if (trendBull != null && bull !== trendBull && now - trendAt >= limits.trendGapMs) { trendAt = now; send('trend', { bull, price: closes.at(-1) }, now); }
      trendBull = bull;
    }
    // Market watch holds: once per hold
    const h = snap?.watchHold;
    if (h && h.until > now && !(prev?.holdUntil > now)) send('hold', { h }, now);
    // status changes (never on the first look)
    const cur = { paused: !!status.profitPaused, earlyLive: !!status.earlyLive, floor: status.floor ?? null, holdUntil: h?.until ?? 0 };
    if (prev) {
      if (cur.paused !== prev.paused) send('status', { good: !cur.paused, text: cur.paused ? 'The profit guard paused buy alerts: the official level\'s recent calls lost money after fees. Calls keep being logged as paper calls until it\'s making money again.' : 'The profit guard resumed buy alerts: the official level is making money after fees again.' }, now, true);
      if (cur.earlyLive !== prev.earlyLive) send('status', { good: cur.earlyLive, text: cur.earlyLive ? 'Early calls are back on: their test calls are profitable again, so early calls (10 to 5 minutes left) go out again, at half size.' : 'Early calls are paused: their recent calls lost money after fees. Test calls until they recover.' }, now, true);
      if (cur.floor != null && prev.floor != null && Math.abs(cur.floor - prev.floor) > 1e-9) send('status', { good: cur.floor < prev.floor, text: `The win-rate guard moved the price floor from ${cents(prev.floor)} to ${cents(cur.floor)}${cur.floor > prev.floor ? ': the record slipped, so calls need Kalshi surer first' : ': the record recovered'}.` }, now, true);
    }
    prev = cur;
  }
  // a settled round: a no-call round gets its sit-out note (rounds with a call get the result post instead)
  function settled({ ticker, result, called, value = null, strike = null, now = Date.now() }) {
    if (called || rounds.get(ticker)?.called) return false;
    return send('sitout', { ticker, result, value, strike }, now);
  }
  // filter: the Whale filter's word on it (public/whales.js predict); DISCORD_WHALES=movers skips the whales it has
  // proven are noise (or that fade), and still posts the ones it can't say yet
  function whale(x, now = Date.now(), filter = null) {
    if (!(x?.price * x?.size >= whaleMin) || now - whaleAt < limits.whaleGapMs) return false;
    if (moversOnly && filter && (filter.label === 'likely noise' || filter.label === 'likely to fade')) return false;
    whaleAt = now;
    return send('whale', { x, filter }, now);
  }
  // a liquidation (public/liquidations.js): one side's last minute adding up to a cascade
  function liquidation(x, now = Date.now()) {
    if (!(x?.usd > 0)) return false;
    liqs.push(x);
    while (liqs.length && liqs[0].t < now - 60000) liqs.shift();
    const side = x.liq, mine = liqs.filter((l) => l.liq === side), usd = mine.reduce((a, l) => a + l.usd, 0);
    if (usd < liqMin || now - liqAt < limits.liqGapMs) return false;
    liqAt = now;
    return send('liquidation', { side, usd, n: mine.length }, now);
  }
  return { tick, settled, whale, liquidation, kinds: () => [...kinds] };
}
