// The signal board (v13.42): every factor the bot learns from, in one place, read from the APIs the phone already gets.
// Each row says where the factor stands with the calls and what it says right now:
//   in calls     proven on rounds it never trained on: its nudge goes into the bot's odds (or its rule into the calls)
//   probation    still being tested walk-forward: shown, never used, with how far it is from the bar
//   context      shown for reading the market, never touches a call by design
// and, when it has a read for this round, which side it pushes and whether that's with or against the side on the card.
// Pure: the Deck renders it (app.js renderBoard).
import { bandProven } from './reversal.js';
import { TUNE } from './tune.js';
import { normCdf } from './model.js';
import { GUIDE } from './guide.js';

export const STATUS = { in: 'in calls', probation: 'probation', context: 'context' };
const side = (v) => (v > 0 ? 'YES' : v < 0 ? 'NO' : null);
const ptsOf = (inCalls, ticker) => (inCalls && ticker && Number.isFinite(inCalls[ticker]) ? inCalls[ticker] : null);
const prog = (have, need) => (need > 0 ? Math.max(0, Math.min(1, (have || 0) / need)) : null);

// v13.46 why a factor on probation isn't used, in plain words, and how close it is:
//   close       a real edge so far (z 2+), not past the bar yet (luck still does as well about 1 time in N)
//   gathering   not enough graded data to say
//   noedge      about a coin flip on data it never trained on
//   reversed    what worked on older rounds went the other way on newer ones: noise
export const VERDICTS = { close: 'close', gathering: 'gathering data', noedge: 'no edge', reversed: 'reversed' };
const pct = (x) => `${Math.round(x * 100)}%`;
const luck = (z) => { const p = 2 * (1 - normCdf(Math.abs(z))); return p > 0 ? Math.max(2, Math.round(1 / p)) : Infinity; }; // two-sided: 1 in N
// a z-tested factor: { have, need } its sample, z its test score, zNeed the bar, what it measured in words
function zVerdict({ have, need, z, zNeed, unit = 'unseen rounds', measured = '' }) {
  if (!(have >= need)) return { verdict: 'gathering', why: `Gathering data: ${have ?? 0} of the ${need} ${unit} it needs before it can be judged.` };
  if (z == null || !Number.isFinite(z)) return { verdict: 'gathering', why: 'Not scored yet.' };
  if (z < 0) return { verdict: 'reversed', why: `What it learned went the other way on new data${measured ? ` (${measured})` : ''}: noise, not a pattern.` };
  if (z < 1) return { verdict: 'noedge', why: `No edge${measured ? `: ${measured}` : ''}, about what a coin flip does. Using it would add noise to the calls.` };
  if (z < 2) return { verdict: 'noedge', why: `Weak${measured ? `: ${measured}` : ''}. Luck alone does this well about 1 time in ${luck(z)}, too often to trust.` };
  return { verdict: 'close', why: `Close${measured ? `: ${measured}` : ''}. z ${z.toFixed(1)} of the ${zNeed} needed: luck alone does this about 1 time in ${luck(z)}; it goes in once that's 1 in ${luck(zNeed)}.` };
}

// sources: { ticker, crypto, scan, micro, tune, playbook, cross, flip, volTune, lab } (each the /api/<name> body, or missing)
export function signalBoard(s = {}) {
  const rows = [], t = s.ticker;
  const add = (r) => rows.push({ lean: null, pts: null, progress: null, ...r });

  if (s.crypto !== false && s.scan) { // the Round scan (scanfeed.js): proven when it made the bot's odds better on 100+ graded samples
    const rec = Object.values(s.scan.record || {}), best = rec.reduce((a, r) => (r.activeN > (a?.activeN ?? -1) ? r : a), null);
    const on = rec.some((r) => r.activeN >= 100 && r.skill != null && r.skill > 0.01), pts = ptsOf(s.scan.inCalls, t);
    add({ key: 'scan', name: 'Round scan · buyers vs sellers', status: on ? 'in' : 'probation', pts, lean: side(pts) ?? (s.scan.live?.ticker === t ? s.scan.live?.lean ?? null : null),
      progress: on ? null : prog(best?.activeN, 100), note: on ? 'better odds on graded rounds' : `${best?.activeN ?? 0}/100 graded samples${best?.skill != null ? `, skill ${(best.skill * 100).toFixed(1)}%` : ''}`,
      ...(on ? {} : !(best?.activeN >= 100) ? { verdict: 'gathering', why: `Gathering data: ${best?.activeN ?? 0} of the 100 graded rounds it needs.` }
        : best.skill > 0 ? { verdict: 'close', why: `Close: it made the bot's odds ${(best.skill * 100).toFixed(1)}% more accurate on ${best.activeN} graded rounds; it goes in at 1%.` }
        : { verdict: 'noedge', why: `No edge: on ${best.activeN} graded rounds it made the bot's odds ${best.skill == null ? 'no better' : `${Math.abs(best.skill * 100).toFixed(1)}% less accurate`}. Buyers vs sellers alone don't predict the close here (yet).` }) });
  }
  if (s.crypto !== false && s.micro) { // the micro model (microfeed.js): a horizon is in once its skill holds up
    const hs = Object.entries(s.micro.read?.horizons || {}), on = hs.some(([, h]) => h.active), pts = ptsOf(s.micro.inCalls, t);
    const best = Object.values(s.micro.models || {}).reduce((a, m) => Math.max(a, m.skill ?? 0), 0);
    const nMicro = Object.values(s.micro.models || {}).reduce((a, m) => Math.max(a, m.n ?? 0), 0);
    add({ key: 'micro', name: 'Small details · order book', status: on ? 'in' : 'probation', pts, lean: side(pts), note: on ? `proven horizons: ${hs.filter(([, h]) => h.active).map(([k]) => `${k}m`).join(', ')}` : `best skill ${(best * 100).toFixed(1)}%`,
      ...(on ? {} : best > 0.005 ? { verdict: 'close', why: `Close: its best horizon predicts ${(best * 100).toFixed(1)}% better than "no change" (${nMicro} samples), not steady enough yet.` }
        : nMicro < 500 ? { verdict: 'gathering', why: `Gathering data: ${nMicro} samples so far.` } : { verdict: 'noedge', why: `No edge: on ${nMicro} samples the order book's small details predict no better than "no change".` }) });
  }
  const tuneAct = new Map((s.tune?.read?.active || []).map((a) => [a.setting, a.push]));
  for (const f of s.tune?.report?.families || []) { // the tuned indicators (tunefeed.js): one row per family
    const push = f.proven ? tuneAct.get(f.setting) : null;
    add({ key: `tune:${f.name}`, name: f.name, status: f.proven ? 'in' : 'probation', lean: push ? side(push) : null,
      progress: f.proven ? null : prog(f.test?.z, TUNE.zTest), note: `${f.setting}${f.dir < 0 ? ' (faded)' : ''} · z ${(f.test?.z ?? 0).toFixed(1)} on ${f.test?.rounds ?? 0} unseen rounds`,
      ...(f.proven ? {} : (() => {
        const v = zVerdict({ have: f.test?.rounds, need: TUNE.minRounds, z: f.test?.z, zNeed: TUNE.zTest, measured: f.test?.hit != null ? `right ${pct(f.test.hit)} of ${f.test.rounds} rounds it never trained on` : '' });
        // the test passed but training didn't agree: a lucky stretch, not a pattern
        return v.verdict === 'close' && f.test.z >= TUNE.zTest && !(f.train?.z >= TUNE.zTrain) ? { verdict: 'noedge', why: `It scored on the new rounds, but training didn't agree (z ${(f.train?.z ?? 0).toFixed(1)}, needs ${TUNE.zTrain}): likely a lucky stretch.` } : v;
      })()) });
  }
  const pb = s.playbook, rep = pb?.report;
  if (rep?.reversal) { // the reversal checklist (playbookfeed.js): a band is in once it's proven
    const bands = Object.entries(rep.reversal.bands || {}).filter(([k]) => k !== 'insufficient'), on = bands.filter(([, b]) => bandProven(b)).map(([k]) => k);
    const best = pb.reversal?.best, live = best && on.includes(best.band) ? (best.dir === 'up' ? 'YES' : 'NO') : null;
    const top = bands.map(([k, b]) => ({ k, ...b })).sort((a, b) => (b.z15 ?? -9) - (a.z15 ?? -9))[0];
    add({ key: 'reversal', name: 'Reversal checklist', status: on.length ? 'in' : 'probation', lean: live, note: on.length ? `proven bands: ${on.join(', ')}` : 'no band proven (100+ signals, z 2.5)',
      ...(on.length || !top ? {} : zVerdict({ have: top.n, need: 100, z: top.z15, zNeed: 2.5, unit: 'signals', measured: `its best band ("${top.k}") on ${top.n ?? 0} signals` })) });
  }
  if (rep?.guide) {
    const g = pb.guide, on = !!rep.guide.proven;
    const gr = rep.guide;
    add({ key: 'guide', name: 'Guide forecast · VWAP, EMAs, RSI', status: on ? 'in' : 'probation', lean: g?.call === 'UP' ? 'YES' : g?.call === 'DOWN' ? 'NO' : null, note: on ? 'proven on history' : 'not proven on history',
      ...(on ? {} : zVerdict({ have: gr.calls, need: GUIDE.provenCalls, z: gr.z, zNeed: GUIDE.provenZ, unit: 'calls', measured: gr.accuracy != null ? `right ${pct(gr.accuracy)} of ${gr.calls} calls on history` : '' })) });
  }
  if (rep?.predictor) {
    const r = rep.predictor, on = !!r.proven;
    add({ key: 'predictor', name: 'Prediction engine', status: on ? 'in' : 'probation', progress: on ? null : prog(r.rounds, 1000), note: `z ${(r.z ?? 0).toFixed(1)} on ${r.rounds ?? 0} rounds${on ? '' : ' (needs 2.5 over 1,000)'}`,
      ...(on ? {} : zVerdict({ have: r.rounds, need: 1000, z: r.z, zNeed: 2.5, measured: r.brier != null && r.brierDistance != null ? `its odds score ${r.brier.toFixed(4)} vs ${r.brierDistance.toFixed(4)} for the plain distance-to-target odds (lower is better)` : '' })) });
  }
  if (pb?.inCalls && ptsOf(pb.inCalls, t) != null) { // the three above share one capped nudge
    const v = ptsOf(pb.inCalls, t);
    for (const r of rows) if (['reversal', 'guide', 'predictor'].includes(r.key) && r.status === 'in') r.pts = v;
  }
  if (s.cross?.model) { // related markets (crossfeed.js)
    const m = s.cross.model, pts = ptsOf(s.cross.inCalls, t), need = m.need?.minTest ?? 1500;
    add({ key: 'cross', name: 'Related markets', status: m.proven ? 'in' : 'probation', pts, lean: side(pts) ?? (m.proven ? side(m.expected5) : null),
      progress: m.proven ? null : prog(m.n, need), note: m.proven ? `${((m.gain ?? 0) * 100).toFixed(1)}% less error than "no change"` : `${m.n ?? 0}/${need} test minutes${m.z != null ? `, z ${m.z.toFixed(1)}` : ''}`,
      ...(m.proven ? {} : zVerdict({ have: m.n, need, z: m.z, zNeed: m.need?.z ?? 2.5, unit: 'test minutes', measured: m.gain != null ? `${(m.gain * 100).toFixed(1)}% ${m.gain >= 0 ? 'less' : 'more'} error than "no change" on minutes it never trained on` : '' })) });
  }
  if (s.flip) { // the flip check (flipfeed.js): chart history and buyers / sellers
    const part = (e, need) => (e?.proven ? 'proven' : `${e?.nTest ?? 0}/${need}`), on = !!(s.flip.chart?.proven || s.flip.flow?.proven), pts = ptsOf(s.flip.inCalls, t);
    const need = s.flip.need || {};
    add({ key: 'flip', name: 'Flip check', status: on ? 'in' : 'probation', pts, lean: side(pts),
      progress: on ? null : Math.max(prog(s.flip.chart?.nTest, need.chart) ?? 0, prog(s.flip.flow?.nTest, need.flow) ?? 0), note: `chart ${part(s.flip.chart, need.chart ?? 600)} · flow ${part(s.flip.flow, need.flow ?? 200)}`,
      ...(on ? {} : zVerdict({ have: s.flip.chart?.nTest, need: need.chart ?? 600, z: s.flip.chart?.z, zNeed: need.z ?? 2.5, unit: 'test samples', measured: s.flip.chart?.gain != null ? `chart history cuts the flip-chance error by ${(s.flip.chart.gain * 100).toFixed(1)}%` : '' })) });
  }
  const fst = s.tune?.report?.flipStudy;
  if (fst?.all?.n) { // the flip study (public/flipstudy.js): history's rule for flip calls
    // v13.45 a locked call never switches, so flip calls are off: what the study learns is shown for reading only
    add({ key: 'flipstudy', name: 'Flip rule from history', status: 'context', note: 'flip calls are off: a locked call never switches · ' + (fst.gate ? `${fst.gate.label} · test: kept won ${fst.gate.test.kept.wins}/${fst.gate.test.kept.n}, blocked ${fst.gate.test.blocked.wins}/${fst.gate.test.blocked.n} (z ${fst.gate.z.toFixed(1)})` : `history's flips won ${fst.all.wins} of ${fst.all.n}; no rule beats taking them all yet`) });
  }
  if (fst?.late?.bands?.length) { // flips later than the last-minutes rule, once history proves they hold
    const b = fst.late.bands.at(-1), on = fst.late.lastMin != null;
    add({ key: 'flipwindow', name: 'Late flips (past the last-minutes rule)', status: 'context', note: on ? `flips allowed to ${fst.late.lastMin} min left · history won ${fst.late.bands.find((x) => x.lastMin === fst.late.lastMin).wins}/${fst.late.bands.find((x) => x.lastMin === fst.late.lastMin).n}` : `at ${b.lastMin}+ min left history won ${b.wins}/${b.n} (needs ${Math.round(fst.late.need * 100)}%+ in both halves, 30+)` });
  }
  if (s.volTune?.report) { // the volatility tuner (voltunefeed.js)
    const r = s.volTune.report, vol = !!r.proven, dr = !!r.drift?.proven;
    add({ key: 'voltune', name: 'Volatility & momentum tuner', status: vol || dr ? 'in' : 'probation', note: `volatility ${vol ? 'proven' : `z ${(r.z ?? 0).toFixed(1)}`} · momentum ${dr ? 'proven' : 'not proven'}`,
      ...(vol || dr ? {} : (() => { const v = zVerdict({ have: r.test ?? r.days, need: 1, z: r.z, zNeed: 2.5, measured: 'no tuned volatility setting beat the standard one on days it never trained on' }); return v.verdict === 'gathering' ? v : { ...v, why: `${v.why} The standard settings are already the best it's found.` }; })()) });
  }
  if (s.lab) { // the loss lab (losslab.js): lessons from past losses
    const ls = [...(s.lab.official?.lessons || []), ...(s.lab.pick?.lessons || [])], on = ls.filter((x) => x.proven);
    const best = ls.filter((x) => !x.proven).reduce((a, x) => Math.max(a, x.n ?? 0), 0);
    const bestZ = ls.filter((x) => !x.proven).reduce((a, x) => (x.z != null && Math.abs(x.z) > Math.abs(a?.z ?? 0) ? x : a), null);
    add({ key: 'lessons', name: 'Lessons from losses', status: on.length ? 'in' : 'probation', note: on.length ? on.map((x) => x.label).join(', ') : `none proven yet (most data: ${best} calls)`,
      ...(on.length ? {} : best < 30 ? { verdict: 'gathering', why: `Gathering data: the most-seen situation has ${best} graded calls; a lesson needs 30.` }
        : { verdict: Math.abs(bestZ?.z ?? 0) >= 2 ? 'close' : 'noedge', why: bestZ ? `The strongest one ("${bestZ.label}") has z ${bestZ.z.toFixed(1)} on ${bestZ.n} calls; a lesson needs 2.8 and to hold in both halves of its record.` : 'No situation stands out in the losses yet.' }) });
  }
  if (s.crypto === false) add({ key: 'drivers', name: 'Why it\'s moving · drivers', status: 'context', note: 'explains the move, never a call' });

  const call = s.side === 'YES' || s.side === 'NO' ? s.side : null;
  for (const r of rows) r.vs = call && r.lean ? (r.lean === call ? 'with' : 'against') : null;
  const inCalls = rows.filter((r) => r.status === 'in'), order = ['close', 'gathering', 'noedge', 'reversed'];
  for (const r of rows) if (r.status === 'probation' && !r.verdict) { r.verdict = 'gathering'; r.why = r.why ?? 'Still being tested.'; }
  const byVerdict = Object.fromEntries(order.map((v) => [v, rows.filter((r) => r.status === 'probation' && r.verdict === v).length]));
  return {
    rows: rows.sort((a, b) => ['in', 'probation', 'context'].indexOf(a.status) - ['in', 'probation', 'context'].indexOf(b.status) || order.indexOf(a.verdict) - order.indexOf(b.verdict)),
    byVerdict,
    side: call,
    counts: { in: inCalls.length, probation: rows.filter((r) => r.status === 'probation').length, with: inCalls.filter((r) => r.vs === 'with').length, against: inCalls.filter((r) => r.vs === 'against').length },
  };
}
