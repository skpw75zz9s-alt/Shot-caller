// The accuracy card (v13.4): every predictor's out-of-sample record in one place, each next to the baseline it has to
// beat, and the same numbers as a report to copy (to send to whoever tunes the bot). Pure: app.js gathers the records.
//   verdict  good  beats its baseline (or holds its promised rate)
//            bad   behind it
//            wait  not enough graded data to say (fewer than `min` samples)
export const ACC = { min: 30 };
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const usd = (x) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const dol = (x) => `$${Math.round(x).toLocaleString('en-US')}`;

export function accuracyRows({ bot = null, predictor = null, blend = null, path = null, cone = null, radar = null, flip = null, tune = null, guard = null, trades = null } = {}) {
  const rows = [], add = (key, name, n, verdict, metric, vs, data, sure = false) => rows.push({ key, name, n, verdict: n < ACC.min && verdict !== 'off' && !sure ? 'wait' : verdict, metric, vs, data }); // sure: already statistically clear
  // the official calls and Near-certain: their win rates mean little alone (a 90¢ call should win 90%), so the bar is
  // profit after fees at $10 a call
  if (bot) {
    const g = bot.graded || 0;
    // the bar is profit after fees: a high win rate on 90c+ calls can still lose money (v13.7)
    const gd = bot.guard, verdict = bot.usd == null ? 'wait' : bot.usd > 0 ? 'good' : 'bad';
    add('calls', `Official calls${bot.level ? ` (${bot.level})` : ''}`, g, verdict, g ? `won ${bot.wins} of ${g} (${pct(bot.wins / g)})` : 'no graded calls yet',
      !g ? (gd ? `aims for 90%+: calls only sides Kalshi prices at ${Math.round(gd.floor * 100)}¢+` : 'graded at each settlement')
        : gd ? `${bot.usd != null ? `${usd(bot.usd)} at $10 a call after fees · ` : ''}win-rate target 90%+, price floor now ${Math.round(gd.floor * 100)}¢`
        : bot.usd == null ? 'profit isn\'t tracked on this phone yet (the server\'s record has it)' : `${usd(bot.usd)} at $10 a call after fees: the bar a win rate has to clear is the price paid`,
      { graded: g, wins: bot.wins ?? 0, usd: bot.usd ?? null, ...(gd ? { floor: gd.floor, guardN: gd.n, guardWins: gd.wins } : {}) });
    const c = bot.certain;
    if (c) add('certain', 'Near-certain calls', c.graded || 0, (c.usd ?? 0) > 0 ? 'good' : 'bad', c.graded ? `won ${c.wins} of ${c.graded} (${pct(c.wins / c.graded)})` : 'none yet (rare by design)',
      c.graded ? `${usd(c.usd ?? 0)} at $10 a call: priced 90¢+, so one loss erases many wins` : 'kept on every round, never traded', { graded: c.graded || 0, wins: c.wins ?? 0, usd: c.usd ?? 0 });
  }
  // the late lane's calls (last 5 minutes, v13.15): judged on profit like the official calls; it switches itself off
  // while they lose money
  const lt = bot?.late;
  if (lt) add('late', 'Late calls (last 5 min)', lt.graded || 0, lt.profitGuard?.paused ? 'bad' : (lt.usd ?? 0) > 0 ? 'good' : 'bad',
    lt.graded ? `won ${lt.wins} of ${lt.graded} (${pct(lt.wins / lt.graded)})` : 'none yet: only stress-tested calls are made this late',
    lt.profitGuard?.paused ? 'OFF: its calls lost money after fees; back on when they recover' : lt.graded ? `${usd(lt.usd ?? 0)} at $10 a call after fees · half size` : 'switches itself off if its calls lose money after fees',
    { graded: lt.graded || 0, wins: lt.wins ?? 0, usd: lt.usd ?? 0, paused: !!lt.profitGuard?.paused });
  // the 10-minute picks (v13.23): every round's side by the math; good when they win at least as often as the math said
  // (calibrated) and the ones marked BUY make money after fees
  const pk = bot?.pick;
  if (pk) {
    const rate = pk.graded ? pk.wins / pk.graded : null, b = pk.buys, sc = pk.score, head = sc?.vs >= 30;
    // judged on money once 20+ BUY picks are graded, else on beating Kalshi's own odds (30+ head to head), else calibration
    add('pick10', '10-minute picks (every round)', pk.graded || 0, !pk.graded ? 'wait' : (b?.graded >= 20 ? b.usd > 0 : head ? sc.brierBot < sc.brierKalshi : rate >= (pk.avgP ?? 0.5) - 0.03) ? 'good' : 'bad',
      pk.graded ? `won ${pk.wins} of ${pk.graded} (${pct(rate)}) · the math said ${pct(pk.avgP)} on average${sc?.vs ? ` · Brier ${sc.brierBot.toFixed(3)} vs Kalshi's ${sc.brierKalshi.toFixed(3)} (lower is better, ${sc.vs} picks)` : ''}` : 'none graded yet: one locks every round at 10:00 left',
      b?.graded ? `BUY picks: ${b.wins} of ${b.graded} won, ${usd(b.usd)} at $10 each after fees` : 'picks marked BUY are judged on profit after fees',
      { graded: pk.graded || 0, wins: pk.wins ?? 0, avgP: pk.avgP ?? null, brier: sc?.vs ? { bot: sc.brierBot, kalshi: sc.brierKalshi, n: sc.vs } : null, buys: b ? { graded: b.graded, wins: b.wins, usd: b.usd } : null });
  }
  // flip calls (v13.19): the locked call switched sides on clear evidence; judged on profit, off while losing
  const fc = bot?.flip;
  if (fc) add('flipcalls', 'Flip calls (switched sides)', fc.graded || 0, fc.profitGuard?.paused ? 'bad' : (fc.usd ?? 0) > 0 ? 'good' : 'bad',
    fc.graded ? `won ${fc.wins} of ${fc.graded} (${pct(fc.wins / fc.graded)})` : 'none yet: only on clear evidence of a flip',
    fc.profitGuard?.paused ? 'OFF: flip calls lost money after fees; back on when they recover' : fc.graded ? `${usd(fc.usd ?? 0)} at $10 a call after fees · half size` : 'switch once a round, at half size, when the bot is 90%+ sure of the other side',
    { graded: fc.graded || 0, wins: fc.wins ?? 0, usd: fc.usd ?? 0, paused: !!fc.profitGuard?.paused });
  // the early lane (v13.16): live unless its recent calls lose money after fees (then test calls until they recover)
  const er = bot?.early;
  if (er) add('early', `Early calls (10–5 min left)${er.live ? '' : ', paused'}`, er.n || 0, er.paused ? 'bad' : (er.usd ?? 0) > 0 ? 'good' : 'bad',
    er.n ? `won ${er.wins} of ${er.n} (${pct(er.wins / er.n)}) · needs ${pct(er.need)} to break even` : 'none graded yet',
    er.paused ? 'PAUSED: its recent calls lost money after fees; test calls until they recover' : `${er.n ? `${usd(er.usd)} at $10 a call after fees · ` : ''}half size${er.n >= 50 ? (er.proven ? ' · clearly beating Kalshi\'s prices' : ' · not clearly beating Kalshi\'s prices yet') : ''}`,
    { n: er.n || 0, wins: er.wins ?? 0, usd: er.usd ?? 0, need: er.need ?? null, low: er.low ?? null, live: !!er.live });
  // the prediction engine, walk-forward on the server's history
  if (predictor?.n) {
    const t90 = predictor.thresholds?.find((t) => t.t === 0.9);
    add('engine', 'Prediction engine (walk-forward)', predictor.rounds, predictor.proven ? 'good' : predictor.brier > predictor.brierDistance ? 'bad' : 'wait',
      `Brier ${predictor.brier.toFixed(4)} vs ${predictor.brierDistance.toFixed(4)} for the distance odds alone (lower is better)`,
      t90?.model.n ? `90%+ calls right ${pct(t90.model.accuracy)} on ${pct(t90.model.share)} of checkpoints; the distance odds alone: ${pct(t90.distance.accuracy)} on ${pct(t90.distance.share)}` : 'no 90%+ calls in the history yet',
      { rounds: predictor.rounds, brier: predictor.brier, brierDistance: predictor.brierDistance, z: predictor.z, proven: !!predictor.proven, t90: t90 ? { model: t90.model, distance: t90.distance } : null });
  }
  // the prediction lines' blend (the cone's centre), graded every minute
  if (blend) {
    const b = blend.best;
    add('blend', 'Prediction lines, blended', blend.n || 0, blend.n && blend.blend < blend.still ? 'good' : 'bad',
      blend.n ? `average miss at the close ${dol(blend.blend)} vs ${dol(blend.still)} for "no change"` : 'graded every minute of every round',
      b ? `best single line ${b.key} ${dol(b.miss)} vs the blend's ${dol(b.blend)} on the same calls` : 'needs a few graded rounds', blend.n ? { calls: blend.n, rounds: blend.rounds, blend: blend.blend, still: blend.still, best: b } : null);
  }
  if (path) add('path', 'Expected path, minute by minute', path.n || 0, path.n && path.miss < path.still ? 'good' : 'bad',
    path.n ? `direction right ${path.called ? pct(path.right / path.called) : '—'} of ${path.called} minutes called` : 'graded at each minute\'s close',
    path.n ? `average miss ${dol(path.miss)} vs ${dol(path.still)} for "no change"` : '', path.n ? { minutes: path.n, called: path.called, right: path.right, miss: path.miss, still: path.still, beta: path.beta } : null);
  if (cone) {
    const ok = cone.n && Math.abs(cone.in90 - 0.9) <= 0.05 && Math.abs(cone.in50 - 0.5) <= 0.08;
    add('cone', 'Cone (50% and 90% bands)', cone.n || 0, ok ? 'good' : 'bad', cone.n ? `the 50% band held ${pct(cone.in50)}, the 90% band ${pct(cone.in90)}` : 'graded each round',
      cone.nKalshi >= 5 ? `above-the-target chance: Brier ${cone.brierSame.toFixed(3)} vs Kalshi's price ${cone.brierKalshi.toFixed(3)}` : 'it recalibrates its width from this record',
      cone.n ? { rounds: cone.n, in50: cone.in50, in90: cone.in90, brier: cone.brierSame ?? null, brierKalshi: cone.brierKalshi ?? null } : null);
  }
  if (radar) {
    const kinds = [['floor', 'floor'], ['ceil', 'ceiling'], ['range', 'range'], ['next', 'next minute']].filter(([k]) => radar[k]?.n);
    const n = Math.min(...kinds.map(([k]) => radar[k].n), Infinity), low = kinds.some(([k]) => radar[k].rate < 0.87);
    add('radar', 'Market radar (promises 90%+)', kinds.length ? n : 0, kinds.length && !low ? 'good' : 'bad',
      kinds.length ? kinds.map(([k, name]) => `${name} ${pct(radar[k].rate)}`).join(' · ') : 'every call graded at the close',
      radar.dir?.n ? `direction calls right ${radar.dir.hit} of ${radar.dir.n}` : 'no 90% direction calls graded yet', Object.fromEntries(Object.entries(radar).map(([k, x]) => [k, { n: x.n, hit: x.hit }])));
  }
  if (flip) add('flips', 'Turn predictions (↺)', flip.n || 0, flip.n && flip.base != null && flip.rate > flip.base ? 'good' : 'bad',
    flip.n ? `caught ${flip.hits} of ${flip.n} (${pct(flip.rate)})${flip.worse ? ` · clearly worse than chance, so the shape is cut to ×${flip.amp.toFixed(2)}` : ''}` : 'each predicted turn checked afterwards', flip.base != null ? `vs ${pct(flip.base)} for a random minute` : '', flip.n ? { n: flip.n, hits: flip.hits, base: flip.base, amp: flip.amp } : null, !!flip.worse);
  // the profit guard on your level, and your own trades against your daily limit
  if (guard) add('profit', `Profit guard (${guard.level})`, Math.max(guard.n, ACC.min), guard.paused ? 'bad' : guard.n >= 20 ? 'good' : 'off',
    guard.paused ? 'buy alerts PAUSED: this level is losing money' : guard.n >= 20 ? 'buy alerts on: this level is making money' : `watching (${guard.n} of 20 graded calls)`,
    guard.n ? `last ${guard.n} calls: ${usd(guard.usd)} after fees at $10 a call` : 'pauses alerts when a level loses money after fees', { n: guard.n, usd: guard.usd, paused: guard.paused });
  if (trades) add('trades', 'Your trades', trades.n, !trades.n ? 'wait' : trades.total > 0 ? 'good' : 'bad', trades.n ? `${usd(trades.total)} over ${trades.n} trades` : 'no tracked trades yet',
    trades.today.limit > 0 ? `today ${usd(trades.today.pnl)} of your ${'$'}${trades.today.limit} daily loss limit${trades.today.hit ? ': limit hit, buy alerts off until midnight' : ''}` : 'no daily loss limit set (Settings)',
    { n: trades.n, total: trades.total, today: trades.today.pnl, limit: trades.today.limit, hit: trades.today.hit });
  // the server's tuners: on only once proven
  add('tuning', 'Tuned volatility and momentum', ACC.min, tune?.use || tune?.drift ? 'good' : 'off',
    tune?.use ? `volatility: EWMA ${tune.lambda}, floor ${tune.floor}, ×${tune.scale}${tune.tails ? `, fat tails ${tune.tails}` : ''} (z ${tune.z.toFixed(1)})` : 'volatility: standard settings (nothing proven better yet)',
    tune?.drift ? `momentum: ${tune.drift.w > 0 ? 'carry' : 'fade'} the last ${tune.drift.n} minutes at ${Math.abs(tune.drift.w)} (z ${tune.drift.z.toFixed(1)})` : 'momentum: none (nothing proven better yet)', tune || null);
  return rows;
}

// The report to copy: the rows' numbers, sample sizes and verdicts, plus when and which version
export function accuracyReport(rows, { version = null, at = Date.now() } = {}) {
  return { app: 'Shot Caller', version, at: new Date(at).toISOString(), rows: rows.map((r) => ({ key: r.key, name: r.name, n: r.n, verdict: r.verdict, metric: r.metric, vs: r.vs, data: r.data })) };
}
