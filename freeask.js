// Ask, free (v13.64): the market chatbot without an AI, so it costs nothing. It reads the question for the markets it
// names and what it asks, runs the same live lookups the AI would (asktools.js), and writes the answer from the numbers.
// It's on whenever there's no ANTHROPIC_API_KEY (or ASK_AI=off). It understands these kinds of question; anything else
// gets a list of what it can answer, never a guess.
//   buy        should I buy / enter / trade: the buy signal, the round call, the odds and Kalshi's price
//   lead       is the lead safe / will it flip: the lead in typical moves, the time left, volatility
//   compare    X vs Y, or several markets named: each one's lead, odds and signal side by side
//   best       which market is safest / best / strongest: every running market ranked by its lead
//   record     the record / win rate / how well has it done
//   strength   accuracy / stronger / against Kalshi or a coin flip: the strength meter
//   learning   what it has learned / what it uses / what's proven
//   breaks     breaks / anomalies / the X-ray: open breaks and which kinds are proven
//   why        why is it moving: the drivers (stock indexes, gold, oil), or the council and the recent path (crypto)
//   trend      the trend / history / last N minutes: the change, the high and low
//   now        anything else about a market: its live round in short
const NAMES = [['BTC', /\b(btc|bitcoin|xbt)\b/i], ['ETH', /\b(eth|ether|ethereum)\b/i], ['SOL', /\b(sol|solana)\b/i], ['XRP', /\b(xrp|ripple)\b/i], ['DOGE', /\b(doge|dogecoin)\b/i],
  ['SPX', /s&p|\bspx\b|\bsp500\b|s and p/i], ['NDX', /nasdaq|\bndx\b/i], ['DJI', /\bdow\b|\bdji\b/i], ['GOLD', /\bgold\b/i], ['SILVER', /\bsilver\b/i], ['OIL', /\boil\b|crude|\bwti\b/i]];
const INTENTS = [
  ['best', /\b(safest|best|strongest|most likely|biggest edge|which (market|one|coin)s? (is|has|looks)|top)\b/i],
  ['compare', /\b(compare|versus|vs\.?)\b/i],
  ['strength', /\b(accura\w*|strength|stronger|weaker|improv\w*|coin ?flip|beat(s|ing)? kalshi|better than kalshi)\b/i],
  ['record', /\b(record|win ?rate|wins|losses|track|how (well|good|has it done|is it doing overall))\b/i],
  ['learning', /\b(learn\w*|proven|what does it use|using|council)\b/i],
  ['breaks', /\b(breaks?|anomal\w*|x-?ray|weird|glitch\w*|fracture\w*)\b/i],
  ['why', /\b(why|moving|drivers?|what'?s pushing)\b/i],
  ['trend', /\b(trend|history|last \d+ ?(min|minute|hour)s?|past (hour|\d+)|range|been doing|moved)\b/i],
  ['buy', /\b(buy|should i|enter|bet|trade|get in|worth it)\b/i],
  ['lead', /\b(lead|safe|flip|hold|win this|going to win|ahead)\b/i],
];
import { normCdf } from './public/model.js';

const n1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
const side = (z) => (z >= 0 ? 'UP' : 'DOWN');

export function readQuestion(q, { markets = [], open = null } = {}) {
  const text = String(q || '');
  const all = /\b(all|every|each|any)\b.*\bmarkets?\b|\bmarkets?\b.*\b(all|every)\b|\b(the )?(coins|crypto)\b/i.test(text);
  const coins = /\b(coins|crypto)\b/i.test(text);
  const named = NAMES.filter(([, re]) => re.test(text)).map(([k]) => k);
  const pick = (keys) => markets.filter((m) => keys.includes(m.asset));
  let targets = named.length ? pick(named) : all ? markets.filter((m) => !coins || m.kind === 'crypto') : markets.filter((m) => m.series === open);
  if (!targets.length && open) targets = markets.filter((m) => m.series === open);
  const intent = INTENTS.find(([, re]) => re.test(text))?.[0] ?? (targets.length > 1 ? 'compare' : 'now');
  if (intent === 'best' && !named.length) targets = coins ? markets.filter((m) => m.kind === 'crypto') : markets; // "which market…": every market, not just the open one
  const mins = Number((text.match(/last (\d+) ?(min|minute)/i) || [])[1]) || (/(last|past) hour/i.test(text) ? 60 : null);
  return { intent: intent === 'now' && targets.length > 1 ? 'compare' : intent, targets, all: all || intent === 'best', minutes: mins, named };
}

export function createFreeAsk({ tools }) {
  const look = async (name, input = {}) => { const r = await tools.call(name, input); try { return JSON.parse(r.text); } catch { return { error: 'that lookup came back cut short' }; } };
  // one market's live round in a sentence or two
  function nowLine(n) {
    if (n.error) return `${n.market ?? 'That market'}: ${n.error}.`;
    if (!n.round) return `${n.market}: no round open right now${n.note ? ` (${n.note})` : ''}.`;
    const l = n.lead, o = n.odds, k = o.kalshiUpBid != null && o.kalshiUpAsk != null ? Math.round((o.kalshiUpBid + o.kalshiUpAsk) / 2) : null;
    return `${n.market}: ${l ? `${l.side === 'above the target' ? 'UP' : 'DOWN'} leads by ${Math.abs(l.typicalMovesAway).toFixed(2)} typical moves` : 'no lead reading'} with ${n1(n.round.minutesLeft)} minutes left. The bot gives UP ${n1(o.botUpFinal)}%${k != null ? `, Kalshi ${k}%` : ''}.`;
  }
  // how safe a lead is, in words, with the chance the price math gives it to hold (no drift: Φ of the distance)
  const leadWords = (z, m) => { const a = Math.abs(z), hold = Math.round(normCdf(a) * 100);
    const w = a >= 2.5 ? 'very safe: an ordinary move won\'t flip it' : a >= 1.5 ? 'fairly safe: it would take a big move to flip it' : a >= 0.8 ? 'decent, not safe: a bigger-than-usual move could flip it' : a >= 0.3 ? `shaky: an ordinary move in the ${n1(m)} minutes left could flip it` : 'a coin flip: it sits right at the target';
    return `${w} (the price math gives the leader about ${hold}% to stay ahead)`; };
  async function answer(question, { series } = {}) {
    const list = await look('list_markets'), markets = list.markets || [];
    const r = readQuestion(question, { markets, open: series }), names = r.targets.map((m) => m.name).join(' and ');
    const disclaimer = 'Signals, not financial advice: any call can lose.';
    if (r.intent === 'best' || (r.all && r.intent === 'lead')) {
      const pool = (r.targets.length ? r.targets : markets).filter((m) => m.running);
      const nows = (await Promise.all(pool.slice(0, 12).map((m) => look('market_now', { series: m.series })))).filter((n) => n.round && n.lead);
      if (!nows.length) return { answer: 'No market has an open round with a live reading right now. Ask again when a round is running.', intent: r.intent };
      nows.sort((a, b) => Math.abs(b.lead.typicalMovesAway) - Math.abs(a.lead.typicalMovesAway));
      const top = nows[0];
      return { intent: r.intent, answer: [`${top.market} has the safest lead right now: ${side(top.lead.typicalMovesAway)} by ${Math.abs(top.lead.typicalMovesAway).toFixed(2)} typical moves with ${n1(top.round.minutesLeft)} minutes left (the bot gives UP ${n1(top.odds.botUpFinal)}%).`,
        ...nows.slice(1, 5).map((n) => `${n.market}: ${side(n.lead.typicalMovesAway)} by ${Math.abs(n.lead.typicalMovesAway).toFixed(2)}, ${n1(n.round.minutesLeft)} min left.`),
        'The safest lead isn\'t the best buy: a safe side usually costs close to $1, so there\'s little left to win.', disclaimer].join('\n') };
    }
    if (!r.targets.length) return { intent: r.intent, answer: `I couldn't tell which market you mean. I know ${markets.map((m) => m.name).join(', ')}. Try naming one, like "Is the Bitcoin lead safe?"` };
    const t = r.targets.slice(0, 6);
    if (r.intent === 'compare') {
      const nows = await Promise.all(t.map((m) => look('market_now', { series: m.series })));
      return { intent: r.intent, answer: [...nows.map(nowLine), ...nows.filter((n) => n.buySignal?.side).map((n) => `${n.market} has a buy signal: ${n.buySignal.side} at ${n1(n.buySignal.price)}¢.`), disclaimer].join('\n') };
    }
    const lines = [];
    for (const m of t) {
      const s = { series: m.series };
      if (r.intent === 'buy') {
        const n = await look('market_now', s); if (n.error || !n.round) { lines.push(nowLine(n)); continue; }
        lines.push(n.buySignal?.side
          ? `${n.market}: the bot's buy signal is on: ${n.buySignal.side} at ${n1(n.buySignal.price)}¢, ${n1(n.buySignal.worstCaseWinChance)}% to win at its worst-case odds${n.buySignal.confidence != null ? `, confidence ${n.buySignal.confidence}` : ''}.`
          : `${n.market}: no buy signal right now: the bot's rules don't see an edge after fees at these prices.`);
        if (n.roundCall?.side) lines.push(`The round call is locked ${n.roundCall.side}${n.roundCall.odds != null ? ` at ${n1(n.roundCall.odds)}%` : ''}, which is a lean, not a buy.`);
        lines.push(nowLine(n));
      } else if (r.intent === 'lead') {
        const n = await look('market_now', s); if (n.error || !n.round || !n.lead) { lines.push(nowLine(n)); continue; }
        lines.push(`${n.market}: ${side(n.lead.typicalMovesAway)} leads by ${Math.abs(n.lead.typicalMovesAway).toFixed(2)} typical moves (${n1(Math.abs(n.lead.gap))} on the price, against a typical move of ${n1(n.lead.typicalMoveLeft)} in the time left). That's ${leadWords(n.lead.typicalMovesAway, n.round.minutesLeft)}.`);
        if (n.volatility?.vsNormal != null && n.volatility.vsNormal > 1.4) lines.push(`Volatility is ${n.volatility.vsNormal}× normal, so leads flip more easily right now.`);
        const flip = n.breaksOpen?.find((b) => /flip risk/i.test(b.break)); if (flip) lines.push(`The X-ray flags it: ${flip.break}.`);
      } else if (r.intent === 'record') {
        const x = await look('market_record', s); if (x.error) { lines.push(`${m.name}: ${x.error}.`); continue; }
        const o = x.official || {}, n = o.graded ?? 0, rc = x.roundCalls;
        lines.push(n ? `${x.market}: the official bot has won ${o.wins} of ${n} graded calls (${n1(o.wins / n * 100)}%) since ${o.since ? new Date(o.since).toISOString().slice(0, 10) : 'it started'}${o.usd != null ? `, ${o.usd >= 0 ? '+' : '−'}$${Math.abs(o.usd).toFixed(2)} on $10 a call after fees` : ''}.` : `${x.market}: no graded official calls yet.`);
        if (rc?.graded) lines.push(`Its round calls (one every round): ${rc.wins} right of ${rc.graded} (${n1(rc.wins / rc.graded * 100)}%).`);
      } else if (r.intent === 'strength') {
        const x = await look('market_strength', s);
        lines.push(`${m.name}: ${(x.words || [x.error || 'no reading yet']).join(' ')}`);
      } else if (r.intent === 'learning') {
        const x = await look('market_learning', s), on = (x.learners || []).filter((l) => l.shapesCalls), off = (x.learners || []).filter((l) => !l.shapesCalls);
        lines.push(`${m.name}: ${on.length ? `proven and shaping the calls: ${on.map((l) => l.learner).join(', ')}.` : 'nothing beyond its price math has proven itself yet.'} ${off.length ? `Still being tested: ${off.slice(0, 6).map((l) => l.learner).join(', ')}${off.length > 6 ? ' and more' : ''}.` : ''}`);
      } else if (r.intent === 'breaks') {
        const x = await look('market_xray', s), p = Object.entries(x.breakProof || {}), proven = p.filter(([, v]) => v.status === 'proven' || v.status === 'opposite');
        lines.push(`${m.name}: ${x.breaksOpen?.length ? `open breaks: ${x.breaksOpen.join('; ')}.` : 'no breaks open right now.'} ${proven.length ? `Proven so far: ${proven.map(([, v]) => v.text).join(' ')}` : 'No kind of break has proven what it claims yet; they\'re all still being tested or are plain facts.'}`);
      } else if (r.intent === 'why') {
        if (m.kind !== 'crypto') {
          const x = await look('market_drivers', s);
          if (x.parts?.length) { const g = (k) => x.parts.filter((p) => p.group === k).reduce((a, p) => a + p.usd, 0); lines.push(`${x.market} moved ${x.move >= 0 ? 'up' : 'down'} ${n1(Math.abs(x.move))} over ${x.windowMinutes} minutes: the dollar and rates ${g('macro') >= 0 ? '+' : '−'}${n1(Math.abs(g('macro')))}, the rest of its market ${g('sector') >= 0 ? '+' : '−'}${n1(Math.abs(g('sector')))}, its own buying and selling ${g('own') >= 0 ? '+' : '−'}${n1(Math.abs(g('own')))}.`); }
          else lines.push(`${m.name}: ${x.note || x.error || 'no driver reading yet'}.`);
        } else {
          const [n, h] = await Promise.all([look('market_now', s), look('market_history', { ...s, minutes: 15 })]);
          lines.push(h.error ? `${m.name}: ${h.error}.` : `${m.name} is ${h.change >= 0 ? 'up' : 'down'} ${n1(Math.abs(h.changePct))}% over the last ${h.minutes} minutes (range ${n1(h.low)} to ${n1(h.high)}).`);
          if (n.council?.arguments?.length) lines.push(`What the proven features argue: ${n.council.verdict}`);
          if (n.breaksOpen?.length) lines.push(`Open breaks: ${n.breaksOpen.map((b) => b.break).join('; ')}.`);
        }
      } else if (r.intent === 'trend') {
        const h = await look('market_history', { ...s, minutes: r.minutes || 60 });
        lines.push(h.error ? `${m.name}: ${h.error}.` : `${h.market}: ${h.change >= 0 ? 'up' : 'down'} ${n1(Math.abs(h.change))} (${n1(Math.abs(h.changePct))}%) over the last ${h.minutes} minutes, from ${n1(h.first)} to ${n1(h.last)}, with a high of ${n1(h.high)} and a low of ${n1(h.low)}.`);
      } else lines.push(nowLine(await look('market_now', s)));
    }
    if (r.intent === 'buy') lines.push(disclaimer);
    return { intent: r.intent, answer: lines.join('\n') || `I can answer about ${names}: try "should I buy", "is the lead safe", "record", "accuracy", "what has it learned", "breaks", "why is it moving" or "last hour".` };
  }
  return { answer };
}
