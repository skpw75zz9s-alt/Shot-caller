// Ask the bot, the market chatbot (v13.63; v13.47's AI deep dive): any question about any market, at any time. The phone
// sends the question and what it shows for its own market (public/ask.js askFacts); Claude can look up every other market
// live with the server's read-only tools (asktools.js: the markets, a market's live round, its price history, record,
// strength, learning, X-ray and drivers), then answers in plain words. Off unless ANTHROPIC_API_KEY is set (Railway
// variables); the phone then answers from its own built-in deep dive. ASK_MODEL picks the model; without it, the newest
// Opus model the key can use (the Models API, newest first), so no model name is baked in here.
// Members and admins only (the paywall), and a few questions a minute each, since every answer costs API tokens.

// a key pasted into Railway with a space, line break or quotes around it still works
export const cleanKey = (k) => (typeof k === 'string' ? k.trim().replace(/^(['"])(.*)\1$/, '$2').trim() : k);

const SYSTEM = `You are "Ask", the market chatbot inside Shot Caller, a signal app for Kalshi's short-term price markets (crypto, stock indexes, gold, oil). Each round asks one yes/no question: will the asset be above (UP, the YES side) or below (DOWN, the NO side) a target price when the round closes. Contracts pay $1 for the right side; the price in cents is roughly the market's odds.

You can answer about any market the app runs, at any time, with your lookup tools: list_markets, market_now, market_history, market_record, market_strength, market_learning, market_xray and market_drivers. The user's message also carries a JSON snapshot of what their phone shows for the market they have open. For anything else (another market, a comparison, the record, how accurate the bot is, what it has learned), look it up: never guess. Call several tools at once when the question needs several markets.

What the data means: "in calls" factors are proven on unseen data; "probation" ones are not. The council vetoes nudges that aren't valid. The strength meter and break proofs are graded on real results; "testing" means not enough evidence yet. A locked round call never switches sides.

How to answer:
- Bottom line first, in one or two sentences, answering exactly what was asked.
- Then the evidence for and against, with the real numbers you looked up. Weigh it; don't just list it.
- Use only the snapshot and your lookups. Never invent a number, a news event or a result. If the data can't answer something, say so plainly. If a lookup says a market is starting or unknown, say that.
- Be honest about uncertainty: a 75% side still loses 1 time in 4. Unproven factors are context, not reasons to trade. Never promise a win.
- These are signals, not financial advice. For buy/sell questions, say what the bot's rules and numbers say; leave the decision to the user.
- Keep it under about 200 words, in short plain sentences: no tables, no headings, no markdown symbols (the app shows plain text). Say UP and DOWN rather than YES and NO.`;

// a lookup's input, checked before it runs (tool inputs stream as they're generated, so nothing is assumed valid)
export function validInput(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const keys = Object.keys(input), only = (ks) => keys.every((k) => ks.includes(k));
  if (name === 'list_markets') return keys.length === 0;
  const s = typeof input.series === 'string' && /^[A-Za-z0-9]{2,40}$/.test(input.series.trim());
  if (name === 'market_history' || name === 'market_drivers') return s && only(['series', 'minutes']) && (input.minutes == null || Number.isInteger(input.minutes));
  return s && only(['series']);
}
// the newest models take the server-side refusal fallback (a declined answer is retried on a fallback model)
const FALLBACK_MODELS = /claude-(opus-5|fable-5-1|sonnet-5-5)/;

export function createAskAI({ apiKey = cleanKey(process.env.ANTHROPIC_API_KEY), model = process.env.ASK_MODEL, client = null, tools = null, perMin = 4, perHour = 40, maxTurns = 6, now = () => Date.now() } = {}) {
  let sdk = client, chosen = model || null, chosenAt = 0, fallbacksOk = true;
  const hits = new Map(); // owner -> [times]
  const on = () => !!(client || apiKey);

  async function getClient() {
    if (sdk) return sdk;
    const { default: Anthropic } = await import('@anthropic-ai/sdk'); // loaded on the first question, so a server without a key never needs it
    sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: 90000 });
    return sdk;
  }
  // the newest Opus model this key can use (the list comes newest first), else the newest model; refreshed daily
  async function pickModel(c) {
    if (model) return model;
    if (chosen && now() - chosenAt < 86400000) return chosen;
    let first = null, opus = null;
    for await (const m of c.models.list()) {
      first ??= m.id;
      if (/opus/i.test(m.id)) { opus = m.id; break; }
    }
    chosen = opus ?? first; chosenAt = now();
    if (!chosen) throw Object.assign(new Error('no model available for this API key'), { status: 503 });
    return chosen;
  }
  function limited(owner) {
    const t = now(), list = (hits.get(owner) || []).filter((x) => t - x < 3600000);
    hits.set(owner, list);
    if (list.filter((x) => t - x < 60000).length >= perMin) return 'Too many questions in a minute. Give it a few seconds.';
    if (list.length >= perHour) return 'That\'s the hour\'s limit for AI deep dives. The built-in answer still works.';
    list.push(t);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k);
    return null;
  }
  // one turn, streamed (long answers never hit a timeout); with the refusal fallback where the model takes it
  async function turn(c, m, messages) {
    const params = {
      model: m, max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' }, system: SYSTEM, messages,
      ...(tools ? { tools: tools.defs.map((t) => ({ ...t, eager_input_streaming: true })) } : {}),
    };
    if (fallbacksOk && FALLBACK_MODELS.test(m) && c.beta?.messages?.stream) {
      try { return await c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage(); }
      catch (e) { if (e?.status !== 400) throw e; fallbacksOk = false; } // the fallback rejected here: ask without it from now on
    }
    return c.messages.stream(params).finalMessage();
  }

  async function ask({ owner, question, facts, history, series }) {
    if (!on()) return { status: 501, body: { error: 'AI answers are off on this server (no ANTHROPIC_API_KEY)', ai: false } };
    const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
    if (!q) return { status: 400, body: { error: 'ask a question' } };
    const why = limited(owner || 'anon');
    if (why) return { status: 429, body: { error: why } };
    const past = (Array.isArray(history) ? history : []).slice(-3)
      .filter((h) => h && typeof h.q === 'string' && typeof h.a === 'string')
      .flatMap((h) => [{ role: 'user', content: h.q.slice(0, 500) }, { role: 'assistant', content: h.a.slice(0, 1500) }]);
    const snapshot = JSON.stringify(facts ?? {}).slice(0, 16000), open = typeof series === 'string' && /^[A-Z0-9]{2,40}$/.test(series) ? series : null;
    const messages = [...past, { role: 'user', content: `Now: ${new Date(now()).toISOString()}. The phone has ${open ? `the ${open} market` : 'a market'} open; its snapshot (JSON):\n${snapshot}\n\nQuestion: ${q}` }];
    try {
      const c = await getClient(), m = await pickModel(c);
      let looked = 0, retried = false;
      for (let i = 0; i < maxTurns; i++) {
        let msg;
        // a streamed tool input that couldn't be parsed at all rejects without an API status: re-issue that turn once
        try { msg = await turn(c, m, messages); } catch (e) { if (e?.status != null || retried) throw e; retried = true; i--; continue; }
        if (msg.stop_reason === 'refusal') return { status: 422, body: { error: 'The AI declined that one. The built-in answer is below.' } };
        const uses = (msg.content || []).filter((b) => b.type === 'tool_use');
        if (msg.stop_reason === 'tool_use' && uses.length && tools) {
          if (i === maxTurns - 1) break; // out of turns: no tools on the last one
          messages.push({ role: 'assistant', content: msg.content });
          const results = await Promise.all(uses.map(async (u) => {
            if (!validInput(u.name, u.input)) return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(u.input) }) };
            const r = await tools.call(u.name, u.input); looked++;
            return { type: 'tool_result', tool_use_id: u.id, ...(r.error ? { is_error: true } : {}), content: r.text };
          }));
          messages.push({ role: 'user', content: results }); // every result in one message
          continue;
        }
        const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        if (!text) return { status: 502, body: { error: 'The AI sent back an empty answer.' } };
        return { status: 200, body: { answer: text, truncated: msg.stop_reason === 'max_tokens', lookups: looked } };
      }
      return { status: 502, body: { error: 'The AI kept looking things up without answering. Try a narrower question.' } };
    } catch (e) {
      const s = e?.status;
      // the key's own problems are the admin's to fix in Railway; the phone falls back to the built-in answer either way
      if (s === 401 || s === 403) return { status: 503, body: { error: 'The AI key was refused. Check ANTHROPIC_API_KEY in Railway.' } };
      if (s === 404) { chosen = null; return { status: 503, body: { error: 'That AI model isn\'t available to this key. Check ASK_MODEL in Railway.' } }; }
      if (s === 429) return { status: 429, body: { error: 'The AI is busy (rate limited). Try again in a minute.' } };
      if (s === 400) return { status: 502, body: { error: 'The AI rejected the request.' } };
      return { status: 502, body: { error: 'Couldn\'t reach the AI right now.' } };
    }
  }

  // the lookups are made once the markets exist (server.js), after this is created
  return { on, ask, setTools: (t) => { tools = t; }, status: () => ({ ai: on(), model: model ? 'set' : on() ? 'auto' : null, markets: !!tools }) };
}
