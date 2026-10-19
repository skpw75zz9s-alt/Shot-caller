// Ask the bot, the AI deep dive (v13.47): the phone sends a question and the facts it already shows (public/ask.js
// askFacts); Claude weighs them and answers in plain words. Off unless ANTHROPIC_API_KEY is set (Railway variables);
// the phone then answers from its own built-in deep dive. ASK_MODEL picks the model; without it, the newest Opus
// model the key can use (the Models API, newest first), so no model name is baked in here.
// Members and admins only (the paywall), and a few questions a minute each, since every answer costs API tokens.

const SYSTEM = `You are "Ask", the voice assistant inside Shot Caller, a signal app for Kalshi's 15-minute markets. Each round asks one yes/no question: will the asset be above (UP, the YES side) or below (DOWN, the NO side) a target price when the round closes. Contracts pay $1 for the right side; the price in cents is roughly the market's odds.

You get a JSON snapshot of everything the app knows about the live round: the call on screen, the bot's odds and Kalshi's, the locked round call (once locked at 10:00 left it never switches sides), the lead and how big it is against the move still possible, the flip check, recent moves and why, buyers and sellers across exchanges, chart patterns, the signal board (factors "in calls" are proven; "probation" ones have not shown an edge on unseen data), market stability, the track record, and the user's own positions.

How to answer:
- Bottom line first, in one or two sentences, answering exactly what was asked.
- Then the deep dive: the evidence for and against, with the real numbers from the snapshot. Weigh it; don't just list it. Say which facts matter most right now and why.
- Use only the snapshot. Never invent a number, a pattern, a news event or a result. If the snapshot can't answer something, say so plainly.
- Be honest about uncertainty: a 75% side still loses 1 time in 4. Unproven factors and chart patterns are context, not reasons to trade. Never promise a win.
- These are signals, not financial advice. For buy/sell questions, say what the bot's rules say and why; leave the decision to the user.
- Keep it under about 170 words, in short plain sentences that sound natural read aloud: no tables, no headings, no markdown symbols. Say UP and DOWN rather than YES and NO.`;

export function createAskAI({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ASK_MODEL, client = null, perMin = 4, perHour = 40, now = () => Date.now() } = {}) {
  let sdk = client, chosen = model || null, chosenAt = 0;
  const hits = new Map(); // owner -> [times]
  const on = () => !!(client || apiKey);

  async function getClient() {
    if (sdk) return sdk;
    const { default: Anthropic } = await import('@anthropic-ai/sdk'); // loaded on the first question, so a server without a key never needs it
    sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: 60000 });
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

  async function ask({ owner, question, facts, history }) {
    if (!on()) return { status: 501, body: { error: 'AI answers are off on this server (no ANTHROPIC_API_KEY)', ai: false } };
    const q = typeof question === 'string' ? question.trim().slice(0, 500) : '';
    if (!q) return { status: 400, body: { error: 'ask a question' } };
    const why = limited(owner || 'anon');
    if (why) return { status: 429, body: { error: why } };
    const past = (Array.isArray(history) ? history : []).slice(-3)
      .filter((h) => h && typeof h.q === 'string' && typeof h.a === 'string')
      .flatMap((h) => [{ role: 'user', content: h.q.slice(0, 500) }, { role: 'assistant', content: h.a.slice(0, 1500) }]);
    const snapshot = JSON.stringify(facts ?? {}).slice(0, 24000);
    try {
      const c = await getClient(), m = await pickModel(c);
      const stream = c.messages.stream({
        model: m,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: SYSTEM,
        messages: [...past, { role: 'user', content: `Live snapshot (JSON, taken ${new Date(now()).toISOString()}):\n${snapshot}\n\nQuestion: ${q}` }],
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') return { status: 422, body: { error: 'The AI declined that one. The built-in answer is below.' } };
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) return { status: 502, body: { error: 'The AI sent back an empty answer.' } };
      return { status: 200, body: { answer: text, truncated: msg.stop_reason === 'max_tokens' } };
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

  return { on, ask, status: () => ({ ai: on(), model: model ? 'set' : on() ? 'auto' : null }) };
}
