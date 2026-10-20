// The Improvement crew (v13.69): teammates whose job is the other teammates. Each one takes a part of the team, grades
// it on its graded track record, and tells each teammate it coaches what the record says: helping, hurting, noise,
// still gathering data, or broken. Pure: the server (team.js) passes the records; team.js adds the crew to the roster
// and the reviews to the teammates they're about.
//   Only one of them changes anything: the Tune-up runner, which runs the tune-up (tuneup.js) on a schedule. The
//   tune-up keeps a setting only when it beats what the bot does now on graded rounds it never saw, and drops one
//   that stops proving itself. The rest coach: what they say is the evidence, and the proof rules already in the bot
//   (the council's veto, the break lab, each learner's probation) are what act on it.
import { COUNCIL } from './council.js';

export const CREW = [
  ['tuner', 'Tune-up runner', 'reruns every learner on a schedule; keeps only what proves better', '⚙️'],
  ['reviewer', 'Track-record reviewer', 'grades every voice in the council', '📋'],
  ['breakcoach', 'Break coach', 'sorts real breaks from noise', '🧭'],
  ['valuer', 'Price checker', 'are the calls worth what they cost', '🏷️'],
  ['accuracy', 'Accuracy coach', 'is each layer of the odds helping', '📐'],
  ['medic', 'Feed medic', 'spots broken or stale parts', '🩺'],
  ['mentor', 'Probation mentor', 'follows each learner to its proof', '🧑‍🏫'],
];
export const CREW_ICON = Object.fromEntries(CREW.map((c) => [c[0], c[3]]));
// the council's voices, and the teammate who owns each
export const VOICE_ROLE = { scan: 'l_scan', micro: 'l_micro', flip: 'flipdesk', tune: 'l_tune', playbook: 'l_reversal', cross: 'related', flows: 'flows' };
const MIN = 30, Z = 2; // what any claim here needs: 30 graded cases and a z of 2
const pct = (p) => `${Math.round(p * 100)}%`, zs = (z) => `${z < 0 ? '−' : ''}${Math.abs(z).toFixed(1)}`;
const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < 172800000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} days`);

// are the official calls worth their price? Each graded call won or lost against the price paid for it (the odds it had
// to beat to break even): wins minus the sum of prices, over its standard deviation
export function priceCheck(calls) {
  const g = (calls || []).filter((e) => (e.result === 'yes' || e.result === 'no') && e.price > 0 && e.price < 1);
  if (!g.length) return { n: 0 };
  const wins = g.filter((e) => String(e.side).toLowerCase() === e.result).length, need = g.reduce((a, e) => a + e.price, 0), v = g.reduce((a, e) => a + e.price * (1 - e.price), 0);
  return { n: g.length, wins, rate: wins / g.length, price: need / g.length, edge: (wins - need) / g.length, z: v > 0 ? (wins - need) / Math.sqrt(v) : 0 };
}

// x: { now, council: { voice: credibility }, kinds: { break kind: verdict }, strength, calls, learners: [{ key, name, on }],
//      parts: { autoTune: { on, everyH, at, changed, of, running }, learnerSince: { key: ms } } }
// roster: everyone else (leads and staff). Returns { crew: [rows], reviews: { role: [{ by, verdict, note }] } }
export function crewRoster(x, roster) {
  const now = x.now ?? Date.now(), p = x.parts || {}, by = Object.fromEntries(roster.map((r) => [r.role, r])), C = {}, reviews = {};
  const review = (role, who, verdict, note) => { if (by[role]) (reviews[role] ||= []).push({ by: who, verdict, note }); };

  // Tune-up runner: the one that acts
  const at = p.autoTune;
  C.tuner = !at ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : at.running ? { state: 'busy', status: 'Running the tune-up now: rerunning every learner and testing the round call on rounds it never saw', key: 'run', say: 'started a tune-up' }
      : !at.on ? { state: 'off', status: 'Automatic tune-ups are off (TUNEUP_AUTO=off): the admin runs it by hand', key: 'off' }
        : { state: 'ok', status: `${at.at ? `Last tune-up ${ago(now - at.at)} ago${at.of ? `: proven settings in use on ${at.changed} of ${at.of} market${at.of === 1 ? '' : 's'}` : ''}` : 'No tune-up yet'} · runs every ${at.everyH} h${at.at ? ` · next in ${ago(Math.max(60000, at.at + at.everyH * 3600000 - now))}` : ' (the first one 30 min after a start)'}`, key: `${at.at || 0}`, say: at.at ? 'finished a tune-up' : null };
  if (at?.on) review('mechanic', 'tuner', 'ok', `Runs your tune-up every ${at.everyH} h; a setting stays only while it keeps beating the bot's own on unseen rounds.`);

  // Track-record reviewer: every council voice
  const recs = x.council || {}, tally = { helping: 0, hurting: 0, data: 0, ok: 0 };
  for (const [voice, r] of Object.entries(recs)) {
    const role = VOICE_ROLE[voice]; if (!role || !r) continue;
    const v = r.veto ? 'hurting' : !(r.n >= COUNCIL.minGraded) ? 'data' : r.z >= Z ? 'helping' : 'ok';
    tally[v]++;
    review(role, 'reviewer', v, v === 'hurting' ? `Your nudges were right ${pct(r.hit)} of ${r.n}: worse than a coin flip, so the council vetoes them until that turns around.`
      : v === 'data' ? `${r.n || 0} of your nudges graded; the council judges your record from ${COUNCIL.minGraded}.`
        : v === 'helping' ? `Right ${pct(r.hit)} of ${r.n} nudges (z ${zs(r.z)}): a real edge. Keep it up.`
          : `Right ${pct(r.hit)} of ${r.n} nudges: no clear edge yet (z ${zs(r.z)}).`);
  }
  const nv = Object.keys(recs).length;
  C.reviewer = nv ? { state: tally.hurting ? 'warn' : tally.helping ? 'busy' : 'ok', status: `${nv} voices reviewed: ${tally.helping} helping, ${tally.hurting} hurting (vetoed), ${tally.ok} no edge yet, ${tally.data} still gathering data`, key: `${tally.helping}:${tally.hurting}`, say: tally.hurting ? `${tally.hurting} voice${tally.hurting === 1 ? '' : 's'} hurting the calls: vetoed` : null }
    : { state: 'idle', status: 'No voice has a graded record yet', key: 'none' };

  // Break coach: which kinds of break are real
  const kinds = Object.entries(x.kinds || {}), kc = (s) => kinds.filter(([, k]) => k.status === s).map(([name]) => name);
  const proven = kc('proven'), backwards = kc('opposite'), noise = kc('noise'), testing = kc('testing');
  C.breakcoach = kinds.length ? { state: noise.length || backwards.length ? 'busy' : 'ok', status: `${proven.length} kinds of break proven, ${backwards.length} proven backwards, ${noise.length} shown to be noise, ${testing.length} still being tested`, key: `${proven.length}:${backwards.length}:${noise.length}`, say: proven.length ? `${proven.length} kinds of break proven` : null }
    : { state: 'idle', status: 'Not reporting', key: 'none' };
  if (kinds.length) {
    review('inspector', 'breakcoach', proven.length ? 'helping' : noise.length ? 'noise' : 'data', [proven.length ? `Trust: ${proven.join(', ')}.` : '', backwards.length ? `Read the other way: ${backwards.join(', ')}.` : '', noise.length ? `Noise, ignore: ${noise.join(', ')}.` : '', testing.length ? `Still being tested: ${testing.length}.` : ''].filter(Boolean).join(' ') || 'Nothing tested yet.');
    review('proof', 'breakcoach', 'ok', `${proven.length + backwards.length + noise.length} of ${kinds.length} kinds settled; ${testing.length} need more cases.`);
  }

  // Price checker: are the calls worth their price
  const pc = priceCheck(x.calls);
  const pv = pc.n < MIN ? 'data' : pc.z >= Z ? 'helping' : pc.z <= -Z ? 'hurting' : 'ok';
  C.valuer = !pc.n ? { state: 'idle', status: 'No graded official calls yet', key: 'none' }
    : { state: pv === 'hurting' ? 'warn' : pv === 'helping' ? 'busy' : 'ok', status: `Calls won ${pc.wins} of ${pc.n} (${pct(pc.rate)}) at an average ${Math.round(pc.price * 100)}¢: ${pc.edge >= 0 ? '+' : '−'}${Math.abs(pc.edge * 100).toFixed(1)} pts against breakeven${pc.n < MIN ? ` (${pc.n} of ${MIN} needed to judge)` : ` (z ${zs(pc.z)}${pv === 'ok' ? ', not clear yet' : ''})`}`, key: pv, say: pv === 'hurting' ? 'the calls are losing to their prices' : pv === 'helping' ? 'the calls beat their prices' : null };
  if (pc.n) review('caller', 'valuer', pv, pv === 'hurting' ? `Your calls win less often than their prices need (${pct(pc.rate)} vs ${Math.round(pc.price * 100)}¢): the profit guard is there for this.` : pv === 'helping' ? `Your calls beat their prices: ${pct(pc.rate)} won at ${Math.round(pc.price * 100)}¢ on average.` : pv === 'data' ? `${pc.n} of ${MIN} graded calls before your price record means anything.` : `Winning about what the prices need (${pct(pc.rate)} at ${Math.round(pc.price * 100)}¢): no clear edge either way yet.`);

  // Accuracy coach: does each layer of the odds help (the strength meter's paired Brier scores: negative = better)
  const s = x.strength, layer = (d, better, worse) => (!d || d.n < MIN ? ['data', `${d?.n ?? 0} of ${MIN} graded rounds before this can be judged.`] : d.z <= -Z ? ['helping', better] : d.z >= Z ? ['hurting', worse] : ['ok', 'No clear difference yet.']);
  const [bv, bn] = layer(s?.steps?.blend, 'Weighing in Kalshi\'s price made the odds more accurate.', 'Weighing in Kalshi\'s price made the odds less accurate.');
  const [cv, cn] = layer(s?.steps?.council, 'The council\'s nudges made the odds more accurate.', 'The council\'s nudges made the odds less accurate.');
  const [kv, kn] = layer(s?.vsKalshi, 'The bot\'s odds beat Kalshi\'s own price.', 'Kalshi\'s own price was more accurate than the bot\'s.');
  review('l_blend', 'accuracy', bv, bn); review('judge', 'accuracy', cv, cn); review('analyst', 'accuracy', kv, kn);
  const bad = [bv, cv, kv].filter((v) => v === 'hurting').length, good = [bv, cv, kv].filter((v) => v === 'helping').length;
  C.accuracy = !s ? { state: 'idle', status: 'Not reporting', key: 'none' }
    : { state: bad ? 'warn' : good ? 'busy' : 'ok', status: `${s.rounds ?? 0} rounds graded · ${good} layer${good === 1 ? '' : 's'} proven to help, ${bad} proven to hurt${s.words?.[0] ? ` · ${s.words[0]}` : ''}`, key: `${good}:${bad}`, say: bad ? `${bad} layer${bad === 1 ? '' : 's'} making the odds worse` : good ? `${good} layer${good === 1 ? '' : 's'} proven to help` : null };

  // Feed medic: anything broken or stale
  const sick = roster.filter((r) => r.state === 'warn' && ['desk', 'ops'].includes(r.dept));
  for (const r of sick) review(r.role, 'medic', 'broken', `Needs attention: ${r.status}`);
  C.medic = sick.length ? { state: 'warn', status: `${sick.length} part${sick.length === 1 ? ' needs' : 's need'} attention: ${sick.slice(0, 3).map((r) => r.name).join(', ')}`, key: `sick:${sick.map((r) => r.role).join(',')}`, say: `${sick[0].name} needs attention` }
    : { state: 'ok', status: 'Every feed and system is healthy', key: 'ok', say: 'everything is healthy again' };

  // Probation mentor: each learner, and how long it's been where it is
  const ls = x.learners || [], since = p.learnerSince || {};
  for (const l of ls) {
    const t = since[l.key], how = t ? ` for ${ago(now - t)}` : '';
    review(`l_${l.key}`, 'mentor', l.on ? 'helping' : 'data', l.on ? `Proven and shaping the calls${how}. It stays only while it keeps proving itself.` : `On probation${how}: it shapes nothing until it proves itself on rounds it never saw.`);
  }
  const on = ls.filter((l) => l.on).length;
  C.mentor = ls.length ? { state: on ? 'busy' : 'ok', status: `${on} of ${ls.length} learners proven and shaping the calls · ${ls.length - on} on probation`, key: `${on}`, say: `${on} of ${ls.length} learners proven` }
    : { state: 'idle', status: 'Not reporting', key: 'none' };

  // the crew talks to the teammates it coaches (each review is said to its teammate)
  const talks = {};
  for (const [role, list] of Object.entries(reviews)) for (const rv of list) (talks[rv.by] ||= []).push({ to: role, text: rv.note });
  if (at?.on) (talks.tuner ||= []).push({ to: 'analyst', text: C.tuner.status });
  const crew = CREW.map(([role, name, job]) => ({ role, name, job, dept: 'improve', crew: true, ...C[role], talks: talks[role] || [] }));
  return { crew, reviews };
}
