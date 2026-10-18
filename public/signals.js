// The signal board (v13.42): every factor the bot learns from, in one place, read from the APIs the phone already gets.
// Each row says where the factor stands with the calls and what it says right now:
//   in calls     proven on rounds it never trained on: its nudge goes into the bot's odds (or its rule into the calls)
//   probation    still being tested walk-forward: shown, never used, with how far it is from the bar
//   context      shown for reading the market, never touches a call by design
// and, when it has a read for this round, which side it pushes and whether that's with or against the side on the card.
// Pure: the Deck renders it (app.js renderBoard).
import { bandProven } from './reversal.js';
import { TUNE } from './tune.js';

export const STATUS = { in: 'in calls', probation: 'probation', context: 'context' };
const side = (v) => (v > 0 ? 'YES' : v < 0 ? 'NO' : null);
const ptsOf = (inCalls, ticker) => (inCalls && ticker && Number.isFinite(inCalls[ticker]) ? inCalls[ticker] : null);
const prog = (have, need) => (need > 0 ? Math.max(0, Math.min(1, (have || 0) / need)) : null);

// sources: { ticker, crypto, scan, micro, tune, playbook, cross, flip, volTune, lab } (each the /api/<name> body, or missing)
export function signalBoard(s = {}) {
  const rows = [], t = s.ticker;
  const add = (r) => rows.push({ lean: null, pts: null, progress: null, ...r });

  if (s.crypto !== false && s.scan) { // the Round scan (scanfeed.js): proven when it made the bot's odds better on 100+ graded samples
    const rec = Object.values(s.scan.record || {}), best = rec.reduce((a, r) => (r.activeN > (a?.activeN ?? -1) ? r : a), null);
    const on = rec.some((r) => r.activeN >= 100 && r.skill != null && r.skill > 0.01), pts = ptsOf(s.scan.inCalls, t);
    add({ key: 'scan', name: 'Round scan · buyers vs sellers', status: on ? 'in' : 'probation', pts, lean: side(pts) ?? (s.scan.live?.ticker === t ? s.scan.live?.lean ?? null : null),
      progress: on ? null : prog(best?.activeN, 100), note: on ? 'better odds on graded rounds' : `${best?.activeN ?? 0}/100 graded samples${best?.skill != null ? `, skill ${(best.skill * 100).toFixed(1)}%` : ''}` });
  }
  if (s.crypto !== false && s.micro) { // the micro model (microfeed.js): a horizon is in once its skill holds up
    const hs = Object.entries(s.micro.read?.horizons || {}), on = hs.some(([, h]) => h.active), pts = ptsOf(s.micro.inCalls, t);
    const best = Object.values(s.micro.models || {}).reduce((a, m) => Math.max(a, m.skill ?? 0), 0);
    add({ key: 'micro', name: 'Small details · order book', status: on ? 'in' : 'probation', pts, lean: side(pts), note: on ? `proven horizons: ${hs.filter(([, h]) => h.active).map(([k]) => `${k}m`).join(', ')}` : `best skill ${(best * 100).toFixed(1)}%` });
  }
  const tuneAct = new Map((s.tune?.read?.active || []).map((a) => [a.setting, a.push]));
  for (const f of s.tune?.report?.families || []) { // the tuned indicators (tunefeed.js): one row per family
    const push = f.proven ? tuneAct.get(f.setting) : null;
    add({ key: `tune:${f.name}`, name: f.name, status: f.proven ? 'in' : 'probation', lean: push ? side(push) : null,
      progress: f.proven ? null : prog(f.test?.z, TUNE.zTest), note: `${f.setting}${f.dir < 0 ? ' (faded)' : ''} · z ${(f.test?.z ?? 0).toFixed(1)} on ${f.test?.rounds ?? 0} unseen rounds` });
  }
  const pb = s.playbook, rep = pb?.report;
  if (rep?.reversal) { // the reversal checklist (playbookfeed.js): a band is in once it's proven
    const bands = Object.entries(rep.reversal.bands || {}).filter(([k]) => k !== 'insufficient'), on = bands.filter(([, b]) => bandProven(b)).map(([k]) => k);
    const best = pb.reversal?.best, live = best && on.includes(best.band) ? (best.dir === 'up' ? 'YES' : 'NO') : null;
    add({ key: 'reversal', name: 'Reversal checklist', status: on.length ? 'in' : 'probation', lean: live, note: on.length ? `proven bands: ${on.join(', ')}` : 'no band proven (100+ signals, z 2.5)' });
  }
  if (rep?.guide) {
    const g = pb.guide, on = !!rep.guide.proven;
    add({ key: 'guide', name: 'Guide forecast · VWAP, EMAs, RSI', status: on ? 'in' : 'probation', lean: g?.call === 'UP' ? 'YES' : g?.call === 'DOWN' ? 'NO' : null, note: on ? 'proven on history' : 'not proven on history' });
  }
  if (rep?.predictor) {
    const r = rep.predictor, on = !!r.proven;
    add({ key: 'predictor', name: 'Prediction engine', status: on ? 'in' : 'probation', progress: on ? null : prog(r.rounds, 1000), note: `z ${(r.z ?? 0).toFixed(1)} on ${r.rounds ?? 0} rounds${on ? '' : ' (needs 2.5 over 1,000)'}` });
  }
  if (pb?.inCalls && ptsOf(pb.inCalls, t) != null) { // the three above share one capped nudge
    const v = ptsOf(pb.inCalls, t);
    for (const r of rows) if (['reversal', 'guide', 'predictor'].includes(r.key) && r.status === 'in') r.pts = v;
  }
  if (s.cross?.model) { // related markets (crossfeed.js)
    const m = s.cross.model, pts = ptsOf(s.cross.inCalls, t), need = m.need?.minTest ?? 1500;
    add({ key: 'cross', name: 'Related markets', status: m.proven ? 'in' : 'probation', pts, lean: side(pts) ?? (m.proven ? side(m.expected5) : null),
      progress: m.proven ? null : prog(m.n, need), note: m.proven ? `${((m.gain ?? 0) * 100).toFixed(1)}% less error than "no change"` : `${m.n ?? 0}/${need} test minutes${m.z != null ? `, z ${m.z.toFixed(1)}` : ''}` });
  }
  if (s.flip) { // the flip check (flipfeed.js): chart history and buyers / sellers
    const part = (e, need) => (e?.proven ? 'proven' : `${e?.nTest ?? 0}/${need}`), on = !!(s.flip.chart?.proven || s.flip.flow?.proven), pts = ptsOf(s.flip.inCalls, t);
    const need = s.flip.need || {};
    add({ key: 'flip', name: 'Flip check', status: on ? 'in' : 'probation', pts, lean: side(pts),
      progress: on ? null : Math.max(prog(s.flip.chart?.nTest, need.chart) ?? 0, prog(s.flip.flow?.nTest, need.flow) ?? 0), note: `chart ${part(s.flip.chart, need.chart ?? 600)} · flow ${part(s.flip.flow, need.flow ?? 200)}` });
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
    add({ key: 'voltune', name: 'Volatility & momentum tuner', status: vol || dr ? 'in' : 'probation', note: `volatility ${vol ? 'proven' : `z ${(r.z ?? 0).toFixed(1)}`} · momentum ${dr ? 'proven' : 'not proven'}` });
  }
  if (s.lab) { // the loss lab (losslab.js): lessons from past losses
    const ls = [...(s.lab.official?.lessons || []), ...(s.lab.pick?.lessons || [])], on = ls.filter((x) => x.proven);
    const best = ls.filter((x) => !x.proven).reduce((a, x) => Math.max(a, x.n ?? 0), 0);
    add({ key: 'lessons', name: 'Lessons from losses', status: on.length ? 'in' : 'probation', note: on.length ? on.map((x) => x.label).join(', ') : `none proven yet (most data: ${best} calls)` });
  }
  if (s.crypto === false) add({ key: 'drivers', name: 'Why it\'s moving · drivers', status: 'context', note: 'explains the move, never a call' });

  const call = s.side === 'YES' || s.side === 'NO' ? s.side : null;
  for (const r of rows) r.vs = call && r.lean ? (r.lean === call ? 'with' : 'against') : null;
  const inCalls = rows.filter((r) => r.status === 'in');
  return {
    rows: rows.sort((a, b) => ['in', 'probation', 'context'].indexOf(a.status) - ['in', 'probation', 'context'].indexOf(b.status)),
    side: call,
    counts: { in: inCalls.length, probation: rows.filter((r) => r.status === 'probation').length, with: inCalls.filter((r) => r.vs === 'with').length, against: inCalls.filter((r) => r.vs === 'against').length },
  };
}
