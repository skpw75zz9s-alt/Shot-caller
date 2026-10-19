// Ask the bot (v13.47): a question, typed or spoken, answered from everything the app knows about the live round.
// app.js gathers the facts (askFacts: plain numbers, nothing fetched here); this file picks what the question is about
// and writes the answer: the bottom line first, then each part with its real numbers. Pure, so it is tested.
// The server's AI deep dive (askai.js) reads the same facts; this is the answer when it's off or unreachable.

const COINS = { BTC: /\b(btc|bitcoin)\b/i, ETH: /\b(eth|ether|ethereum)\b/i, SOL: /\b(sol|solana)\b/i, XRP: /\b(xrp|ripple)\b/i, DOGE: /\b(doge|dogecoin)\b/i };

// what a question can be about, in the order the parts are written when several match
export const TOPICS = [
  { key: 'buy', re: /\b(buy|buying|enter|get in|jump in|bet|trade it|worth it|should i|take it|play it|go in|ape)\b/i },
  { key: 'call', re: /\b(call|pick|side|up or down|which way|direction|lean|predict|prediction|forecast|winning|gonna|going to|will it (go|end|close|finish))\b/i },
  { key: 'line', re: /\b(lead|safe|safety|cushion|line|strike|target|margin|ahead|behind|hold|holding|close call|how far)\b/i },
  { key: 'flip', re: /\b(flip|flips|reverse|reversal|turn around|switch|lose|losing|comeback|come back)\b/i },
  { key: 'move', re: /\b(why|moving|moved|dump|dumping|pump|pumping|drop|dropping|crash|spike|rally|news|falling|rising)\b/i },
  { key: 'flow', re: /\b(buyers|sellers|flow|volume|whale|whales|pressure|exchange|exchanges|orders?|scan|futures|funding)\b/i },
  { key: 'patterns', re: /\b(patterns?|chart|candles?|triangle|wedge|flag|channel|head and shoulders|shoulders|breakout|breakdown|technical|ta)\b/i },
  { key: 'signals', re: /\b(signals?|indicators?|factors?|probation|board|rsi|macd|ema|bollinger)\b/i },
  { key: 'risk', re: /\b(risk|risky|volatil\w*|stable|stability|calm|choppy|chop|jumpy|danger|dangerous|swings?)\b/i },
  { key: 'record', re: /\b(record|accura\w*|track record|win rate|how good|stats|performance|history|trust|reliable|been doing)\b/i },
  { key: 'price', re: /\b(price|where is it|trading at|current price|how much is)\b/i },
  { key: 'time', re: /\b(time left|how long|when does|closes?|minutes left|ends?)\b/i },
  { key: 'sessions', re: /\b(sessions?|asia|london|new york|ny open|market hours|stock market)\b/i },
  { key: 'mine', re: /\b(my (position|trade|bet|contracts?)|i (hold|own|have|bought)|sell|cash out|exit|get out)\b/i },
];
const DEEP = /\b(deep ?dive|everything|full (read|breakdown|picture)|overview|break ?it down|break ?down|what'?s (going on|happening|up)|tell me about|explain|analy[sz]e|analysis|thoughts|rundown|summary|sum it up)\b/i;
// a deep dive with nothing narrower asked: every part, most decisive first
const ALL = ['call', 'line', 'flip', 'move', 'flow', 'patterns', 'signals', 'risk', 'record'];
// what each narrow question also needs, so a one-word topic still gets a real answer
const WITH = { buy: ['call', 'line', 'flip', 'risk', 'record'], call: ['line', 'flip'], line: ['flip', 'risk'], flip: ['line', 'risk'], move: ['flow', 'patterns'],
  flow: ['move'], patterns: ['signals'], signals: [], risk: ['line'], record: [], price: ['line'], time: ['call'], sessions: [], mine: ['line', 'flip'] };

export function route(q) {
  const s = String(q || '');
  const hit = TOPICS.filter((t) => t.re.test(s)).map((t) => t.key);
  const deep = DEEP.test(s) || !hit.length;
  const keys = [];
  const add = (k) => { if (!keys.includes(k)) keys.push(k); };
  for (const k of hit) add(k);
  for (const k of hit) for (const w of WITH[k] || []) add(w);
  if (deep) for (const k of ALL) add(k);
  return { keys, deep, asked: hit };
}

const nm = (side) => (side === 'YES' ? 'UP' : side === 'NO' ? 'DOWN' : '—');
const pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const cents = (x) => (x == null ? '—' : `${Math.round(x * 100)}¢`);
const mmss = (min) => { const s = Math.max(0, Math.round(min * 60)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function money(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), d = a < 1 ? Math.max(digits, 4) : a < 100 ? Math.max(digits, 2) : digits;
  return `$${a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- the parts ----------
const PARTS = {
  call(f) {
    const r = f.round, c = f.call, rc = f.roundCall;
    if (!r) return null;
    const out = [];
    if (c?.bail) out.push(`The bot's ${nm(c.bail.side)} call went bad: its odds fell to ${pc(c.bail.p)}, so it says bail${c.bail.bid ? ` (about ${cents(c.bail.bid)} back per contract)` : ''}.`);
    else if (c?.side) out.push(`The bot is calling ${nm(c.side)} as a buy at up to ${cents(c.limit ?? c.price)}${c.conf != null ? `, confidence ${c.conf}` : ''}${c.hold != null ? `, and it stays on that side to the end in ${pc(c.hold)} of simulated paths` : ''}.${c.lane && c.lane !== 'main' ? ` It's a ${c.lane}-lane call, so half size.` : ''}`);
    if (rc?.side) out.push(`This round's call is locked ${nm(rc.side)} at ${pc(rc.p)}${rc.buy ? `, worth buying at up to ${cents(rc.price)}` : ', a lean, not a buy at this price'}${rc.fallback ? ` (${rc.why})` : ''}. It never switches sides for the rest of the round.`);
    else if (r.minutesLeft > 10) out.push(`The round call locks at 10:00 left, in ${mmss(r.minutesLeft - 10)}.`);
    if (f.lockedOut) out.push(`The bot's own lean has moved to the other side, but the round call is locked, so it stays.`);
    if (f.odds?.botUp != null) out.push(`The bot's math gives UP ${pc(f.odds.botUp)}${f.odds.kalshiUp != null ? `; Kalshi's prices say ${pc(f.odds.kalshiUp)}` : ''}.`);
    if (f.card?.reason && !c?.side && !rc?.side) out.push(f.card.reason);
    return out.length ? out.join(' ') : null;
  },
  line(f) {
    const l = f.line, r = f.round;
    if (!l || !r) return null;
    let s = `${l.leadSide} is winning by ${money(l.lead, f.digits)} with ${mmss(r.minutesLeft)} left. ${f.coin} usually still moves about ${money(l.move, f.digits)} in that time, so the lead is ${l.ratio.toFixed(2)} times the move left: a ${l.word} cushion.`;
    if (l.razor) s += ' That is razor close: a coin flip zone.';
    if (l.hist) s += ` At this cushion and time left, rounds finished ${l.leadSide} ${pc(l.hist.rate)} of the time over the last 3 weeks (${l.hist.n} rounds).`;
    if (l.settle) s += ` Settlement watch: ${l.settle.banked} of the last 60 seconds are banked${l.settle.locked ? ' and the result is locked by arithmetic' : ''}.`;
    return s;
  },
  flip(f) {
    const x = f.flip, l = f.line;
    if (!x && !l) return null;
    if (x) {
      const why = (x.parts || []).slice(0, 3).map((p) => `${p.name.toLowerCase()} ${p.push > 0 ? 'raising' : 'lowering'} it`).join(', ');
      return x.used ? `Flip check: ${nm(x.lead)} leads, with a ${pc(x.p)} chance it loses by the close (the price math alone says ${pc(x.base)})${why ? `; ${why}` : ''}.`
        : `Flip check: ${nm(x.lead)} leads, and the price math gives it a ${pc(x.base)} chance to lose. The extra flip reads are still being tested, so they don't change that.`;
    }
    // history at this cushion beats the rule of thumb (a thin cushion with seconds left still holds most of the time)
    if (l.hist) return `No live flip check yet. At this cushion and time left, the side ahead held ${pc(l.hist.rate)} of the time, so it flips about ${pc(1 - l.hist.rate)}: the other side needs ${money(l.lead, f.digits)} in ${mmss(f.round.minutesLeft)}.`;
    const lose = l.ratio >= 2 ? 'rarely' : l.ratio >= 1 ? 'sometimes' : 'often';
    return `No live flip check yet. From the cushion alone, a lead like this ${lose} flips: the other side needs ${money(l.lead, f.digits)} in ${mmss(f.round.minutesLeft)}.`;
  },
  move(f) {
    const mv = (f.moves || []).filter((m) => m.ago <= 15);
    const out = [];
    if (mv.length) {
      const [a, ...rest] = mv;
      out.push(`${a.ago < 1 ? 'Just now' : `${Math.round(a.ago)} min ago`}: ${a.headline}${a.reasons?.length ? `. ${a.reasons.slice(0, 3).join('; ')}` : ''}.`);
      if (rest.length) out.push(`Before that: ${rest.slice(0, 2).map((m) => `${m.headline} (${Math.round(m.ago)} min ago)`).join('; ')}.`);
    }
    if (f.drivers) out.push(f.drivers);
    if (f.round?.change != null) out.push(`Since this round opened, ${f.coin} is ${f.round.change >= 0 ? 'up' : 'down'} ${money(Math.abs(f.round.change), f.digits)}.`);
    if (!out.length) return `No real move to explain in the last 15 minutes: ${f.coin} has been drifting, not jumping.`;
    return out.join(' ');
  },
  flow(f) {
    const s = f.scan, out = [];
    if (s) {
      out.push(`Across the exchanges this round: ${s.verdict} (score ${s.score > 0 ? '+' : ''}${s.score} on a scale of minus 100 to plus 100).`);
      if (s.leader) out.push(`${s.leader} is moving first.`);
      if (s.bigBuy || s.bigSell) out.push(`Big trades: ${money(s.bigBuy)} bought against ${money(s.bigSell)} sold.`);
      if (s.chance) out.push(s.chance.active ? `With what the scan has learned, it puts ${s.chance.side} at ${pc(s.chance.p)}.` : `The scan hasn't proven it adds anything yet, so it leaves the bot's odds alone.`);
    }
    if (f.pressure) out.push(`The last 2 minutes' trades lean ${f.pressure.side} (${pc(f.pressure.share)})${f.line && f.pressure.side !== f.line.leadSide ? ', against the side that is ahead' : ''}${f.pressure.note ? `. ${f.pressure.note}` : ''}.`);
    if (f.watch?.hold) out.push(`Market watch has new calls on hold: ${f.watch.hold}.`);
    else if (f.watch?.events?.length) out.push(`Market watch flagged: ${f.watch.events.slice(0, 2).join('; ')}.`);
    return out.length ? out.join(' ') : null;
  },
  patterns(f) {
    const p = f.patterns;
    if (!p) return null;
    const out = [];
    if (p.forming) out.push(`A ${p.forming.name.toLowerCase()} is forming: a close above ${money(p.forming.up, f.digits)} or below ${money(p.forming.dn, f.digits)} confirms it.`);
    if (p.recent?.length) {
      out.push(`On the chart: ${p.recent.slice(0, 3).map((e) => `${e.name} ${e.ago < 1 ? 'just now' : `${Math.round(e.ago)} min ago`}, says ${nm(e.dir > 0 ? 'YES' : 'NO')}${e.target != null ? ` with a target of ${money(e.target, f.digits)}` : ''}`).join('; ')}.`);
      const graded = p.recent.filter((e) => e.hit != null);
      if (graded.some((e) => e.proven)) out.push(`${graded.filter((e) => e.proven).map((e) => e.name).join(', ')} ${graded.filter((e) => e.proven).length === 1 ? 'has' : 'have'} proven itself on rounds it never saw, so it feeds the calls.`);
      else out.push(`None of these has proven itself on unseen rounds${graded.length ? ` (best: ${graded.sort((a, b) => b.hit - a.hit)[0].name} right ${pc(graded[0].hit)})` : ''}, so treat them as context, not a reason to trade.`);
    }
    if (!out.length) out.push('No pattern confirmed on the chart in the last 30 minutes, and nothing is forming.');
    return out.join(' ');
  },
  signals(f) {
    const b = f.board;
    if (!b) return null;
    const out = [`${plural(b.inCalls, 'factor')} ${b.inCalls === 1 ? 'has' : 'have'} proven ${b.inCalls === 1 ? 'itself' : 'themselves'} and ${b.inCalls === 1 ? 'feeds' : 'feed'} the calls; ${b.probation} ${b.probation === 1 ? 'is' : 'are'} on probation.`];
    if (b.side && b.with + b.against) out.push(`On ${nm(b.side)}: ${b.with} with it, ${b.against} against.${(b.rows || []).length ? ` ${b.rows.slice(0, 4).map((r) => `${r.name} ${r.vs === 'with' ? 'agrees' : 'disagrees'}`).join(', ')}.` : ''}`);
    if (b.close?.length) out.push(`Closest to being proven: ${b.close.slice(0, 3).join(', ')}.`);
    out.push('Factors on probation stay out of the calls until they win on data they never trained on.');
    return out.join(' ');
  },
  risk(f) {
    const s = f.stability, out = [];
    if (s && s.level !== 'unknown') out.push(`The market is ${s.level}${s.score != null ? ` (${s.score} out of 100)` : ''}${s.parts?.length ? `: ${s.parts.slice(0, 3).join('; ')}` : ''}.`);
    if (f.vol != null) out.push(`${f.coin} moves about ${(f.vol * 100).toFixed(3)}% a minute right now.`);
    if (f.block) out.push(f.block);
    return out.length ? out.join(' ') : null;
  },
  record(f) {
    const r = f.record, out = [];
    if (!r) return null;
    if (r.picks?.graded) out.push(`Round calls: ${r.picks.wins} won of ${r.picks.graded} (${pc(r.picks.wins / r.picks.graded)})${r.picks.avgP != null ? `, when the math said ${pc(r.picks.avgP)} on average` : ''}.${r.picks.buys?.graded ? ` The ones marked BUY: ${r.picks.buys.wins} of ${r.picks.buys.graded}, ${r.picks.buys.usd >= 0 ? 'up' : 'down'} ${money(Math.abs(r.picks.buys.usd), 2)} at $10 each.` : ''}`);
    if (r.official?.graded) out.push(`Official buy calls: ${r.official.wins} won of ${r.official.graded}${r.official.usd != null ? `, ${r.official.usd >= 0 ? 'up' : 'down'} ${money(Math.abs(r.official.usd), 2)} after fees` : ''}.`);
    const acc = (r.accuracy || []).filter((a) => a.verdict === 'good' || a.verdict === 'bad').slice(0, 3);
    if (acc.length) out.push(`${acc.map((a) => `${a.name}: ${a.metric}`).join('. ')}.`);
    if (r.trades?.n) out.push(`Your own tracked trades: ${r.trades.n}, ${r.trades.total >= 0 ? 'up' : 'down'} ${money(Math.abs(r.trades.total), 2)}.`);
    return out.length ? out.join(' ') : 'Not enough graded rounds yet to judge the record.';
  },
  price(f) {
    const r = f.round;
    if (!r?.spot) return null;
    return `${f.coin} is at ${money(r.spot, f.digits)}${r.strike != null ? `, ${money(Math.abs(r.spot - r.strike), f.digits)} ${r.spot >= r.strike ? 'above' : 'below'} the target of ${money(r.strike, f.digits)}` : ''}.`;
  },
  time(f) {
    const r = f.round;
    return r ? `This round closes in ${mmss(r.minutesLeft)}.` : null;
  },
  sessions(f) {
    const s = f.sessions;
    if (!s?.length) return null;
    const open = s.filter((x) => x.open).map((x) => x.name);
    return open.length ? `Open now: ${open.join(', ')}.` : 'The big stock markets are all closed right now, which usually means thinner, calmer trading.';
  },
  mine(f) {
    const ps = (f.positions || []).filter((p) => !f.round || p.ticker === f.round.ticker);
    if (!ps.length) return 'You have no tracked position on this round. Tap "I bought it" on a call (or link Kalshi) and I can talk about yours.';
    return ps.map((p) => {
      const winning = f.line ? p.side === (f.line.leadSide === 'UP' ? 'YES' : 'NO') : null;
      return `You hold ${p.contracts} ${nm(p.side)} at ${cents(p.price)}${winning == null ? '' : winning ? ', and that side is ahead' : ', and that side is behind'}${p.bid != null ? `; it would sell for about ${cents(p.bid)} now` : ''}.`;
    }).join(' ') + (f.call?.bail ? ' The bot says bail on its call.' : '');
  },
};
export const TITLES = { call: 'The call', line: 'The lead', flip: 'Flip risk', move: 'Why it moved', flow: 'Buyers and sellers', patterns: 'Chart patterns',
  signals: 'Signal board', risk: 'Market mood', record: 'Track record', price: 'Price', time: 'Time', sessions: 'Sessions', mine: 'Your position' };

// the first sentence: what the question most needs to hear
function bottomLine(f, asked) {
  const r = f.round, c = f.call, rc = f.roundCall;
  if (!r) return `There's no open ${f.coin} round right now, so there's nothing live to read.`;
  const buyQ = asked.includes('buy') || asked.includes('mine');
  if (c?.bail) return `Bail: the bot's ${nm(c.bail.side)} call went bad, its odds are down to ${pc(c.bail.p)}.`;
  // "is the lead safe?" / "will it flip?": answered first, the call after it in the parts
  const l = f.line, x = f.flip;
  if (!buyQ && l && (asked.includes('line') || asked.includes('flip'))) {
    const lose = x?.lead && nm(x.lead) === l.leadSide ? (x.used ? x.p : x.base) : l.hist ? 1 - l.hist.rate : null;
    const verdict = l.razor || l.ratio < 0.5 ? 'Not safe' : l.ratio < 1 ? 'Not very safe' : l.ratio < 2 ? 'Fairly safe, not locked' : 'Safe by the numbers';
    return `${verdict}: ${l.leadSide} leads by ${money(l.lead, f.digits)}, ${l.ratio.toFixed(2)} times the move still likely, a ${l.word} cushion${lose != null ? `, with a ${pc(lose)} chance it flips by the close` : ''}${l.hist ? `. Rounds like this finished ${l.leadSide} ${pc(l.hist.rate)} of the time` : ''}.`;
  }
  if (f.block && (c?.side || rc?.buy)) return `Buys are paused right now (${f.block.split(':')[0].toLowerCase()}), so no buy, even though the bot leans ${nm(c?.side ?? rc.side)}.`;
  if (c?.side) return `${buyQ ? 'Yes, by the bot\'s rules: ' : ''}it's calling ${nm(c.side)}, a buy at up to ${cents(c.limit ?? c.price)}${c.conf != null ? ` with confidence ${c.conf}` : ''}.`;
  if (rc?.side) {
    const lean = `${nm(rc.side)} at ${pc(rc.p)}`;
    if (rc.buy) return `${buyQ ? 'Yes: ' : ''}the round call is ${lean}, and it's worth buying at up to ${cents(rc.price)}.`;
    return `${buyQ ? 'Not a buy at this price. ' : ''}The round call is ${lean}, a lean, not a buy: ${rc.price != null ? `at Kalshi's ${cents(rc.price)} a win pays too little for the risk` : 'the price leaves no edge'}.`;
  }
  if (r.minutesLeft > 10) {
    const lean = f.odds?.botUp != null ? ` Right now the math leans ${f.odds.botUp >= 0.5 ? 'UP' : 'DOWN'} ${pc(Math.max(f.odds.botUp, 1 - f.odds.botUp))}.` : '';
    return `${buyQ ? 'Not yet. ' : ''}No call yet: the bot watches the start of the round and locks its call at 10:00 left, in ${mmss(r.minutesLeft - 10)}.${lean}`;
  }
  return `${buyQ ? 'Not right now. ' : ''}${f.card?.label ? `${cap(f.card.label.toLowerCase())}.` : 'No call right now.'}`;
}

// the whole answer: { title, bottom, parts: [{ key, title, text }], speak, keys }
export function answer(question, facts) {
  const f = facts || {};
  const { keys, deep, asked } = route(question);
  const coin = Object.entries(COINS).find(([, re]) => re.test(question || ''))?.[0];
  const note = coin && f.coin && coin !== f.coin ? `You're looking at ${f.coin}. Switch the market up top to ask about ${coin}.` : null;
  const bottom = bottomLine(f, asked);
  const parts = [];
  for (const k of keys) {
    let text = null;
    try { text = PARTS[k]?.(f); } catch { text = null; } // one part with a missing number never sinks the answer
    if (text) parts.push({ key: k, title: TITLES[k], text });
  }
  const tail = asked.includes('buy') || asked.includes('mine') ? 'These are the bot\'s reads, not financial advice: a likely side still loses sometimes.' : null;
  // read aloud: the bottom line and the parts the question asked for (a deep dive: the first three)
  const said = parts.filter((p) => asked.includes(p.key)).slice(0, 2);
  const speak = [note, bottom, ...(said.length ? said : parts.slice(0, deep ? 3 : 1)).map((p) => p.text), tail].filter(Boolean).join(' ');
  return { title: deep && !asked.length ? 'Deep dive' : asked.map((k) => TITLES[k]).slice(0, 2).join(' · ') || 'Deep dive', note, bottom, parts, tail, speak, keys };
}

// trim the facts the server's AI reads to what fits a short prompt (and never anything private: no keys, no codes)
export function factsForAI(f) {
  const x = JSON.parse(JSON.stringify(f || {}));
  if (x.moves) x.moves = x.moves.slice(0, 5);
  if (x.record?.accuracy) x.record.accuracy = x.record.accuracy.slice(0, 12);
  if (x.board?.rows) x.board.rows = x.board.rows.slice(0, 12);
  if (x.patterns?.recent) x.patterns.recent = x.patterns.recent.slice(0, 6);
  if (x.positions) x.positions = x.positions.slice(0, 6).map(({ ticker, side, price, contracts, bid }) => ({ ticker, side, price, contracts, bid }));
  return x;
}

// The phone's own voice, free and offline (v13.48.3): the best English voice it has, British and male first (the closest
// to the bot's Adam Stone), high-quality downloads ahead of the compact ones, joke voices never. pref: a voice's name.
const NAMED = [/google uk english male/i, /\barthur\b/i, /\bdaniel\b/i, /\boliver\b/i, /\bjamie\b/i, /\bmalcolm\b/i, /\bgeorge\b/i, /\bharry\b/i, /\bryan\b/i, /\bthomas\b/i];
const NOVELTY = /\b(bad news|good news|bells|bubbles|cellos|organ|jester|superstar|wobble|boing|bahh|whisper|zarvox|trinoids|albert|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|hysterical|deranged|pipe organ)\b/i;
const FEMALE = /\b(female|samantha|serena|kate|stephanie|martha|karen|moira|tessa|fiona|victoria|allison|ava|susan|zoe|catherine|siri female|google uk english female|libby|sonia|maisie|hazel)\b/i;
const usable = (v) => !!v && /^en/i.test(v.lang || '') && !NOVELTY.test(v.name || '');
export function voiceScore(v) {
  if (!usable(v)) return -Infinity;
  const named = NAMED.findIndex((r) => r.test(v.name));
  return (/premium/i.test(v.name) ? 40 : /enhanced|neural|natural|online/i.test(v.name) ? 25 : 0) + (/^en[-_]gb/i.test(v.lang) ? 15 : 0)
    + (named >= 0 ? 20 - named : 0) + (FEMALE.test(v.name) ? -12 : 0) + (v.localService === false ? 2 : 0);
}
export function pickVoice(voices, pref = '') {
  const list = (voices || []).filter(usable);
  return (pref && list.find((v) => v.name === pref)) || list.sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}
export const englishVoices = (voices) => (voices || []).filter(usable).sort((a, b) => voiceScore(b) - voiceScore(a));

// an answer in pieces for the server's free voice (v13.49): the first sentence alone so speech starts sooner, then
// sentences packed up to max characters (the server reads each piece in a second or two); never split at a decimal
export function speechChunks(text, max = 220) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean), out = [];
  for (const x of s) {
    for (let i = 0; i < x.length; i += max) {
      const piece = x.slice(i, i + max), last = out[out.length - 1];
      if (last && out.length > 1 && last.length + piece.length + 1 <= max) out[out.length - 1] = `${last} ${piece}`;
      else out.push(piece);
    }
  }
  return out;
}
