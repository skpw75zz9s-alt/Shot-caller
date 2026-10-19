// The council (v13.60): every feature that wants to move the bot's odds argues its case here, and the council rules on
// each argument before anything reaches a call. Pure; the server (council.js) feeds it, grades it and keeps the records.
//
// An argument: a proven feature's nudge to P(YES) for one round ({ key, name, family, pts }: pts > 0 argues YES/UP).
// Only proven features argue (everything else is still on probation and is heard, not admitted). The rules, in order:
//   1. facts beat opinions   when the lead is 2.5+ typical moves for the time left, or the 60-second settlement average is
//                            mostly in, an argument against the leader is vetoed: no nudge can argue with that
//   2. track record          the council grades every argument it heard against the round's result. A feature clearly
//                            wrong lately (20+ graded, z <= -1.5) is vetoed; a shaky one (below 50%) is discounted, down
//                            to half weight. A good record never adds weight: proof gets a feature in, results can only
//                            take it out
//   3. no echoes             features that read the same data (a family) count once: if they agree, the strongest speaks
//                            and the rest are echoes; if they contradict each other, the data is split and all are vetoed
//   4. the debate            the arguments left are weighed and netted: across families, opposite sides cancel out by
//                            weight. The total is capped at 10 points
// So the council can only shrink or remove nudges, never grow them.

export const COUNCIL = { factsZ: 2.5, lockMin: 0.25, minGraded: 20, vetoZ: -1.5, floorW: 0.5, cap: 0.1, keep: 60, prior: 5 };
// which features read the same data
export const FAMILIES = {
  flow: 'buyers and sellers', chart: 'the chart', cross: 'related markets', money: 'money flows',
};
export const MEMBERS = {
  scan: { name: 'Round scan', family: 'flow' }, micro: { name: 'Micro model', family: 'flow' }, flip: { name: 'Flip check', family: 'flow' },
  tune: { name: 'Tuned indicators', family: 'chart' }, playbook: { name: 'Reversal checklist', family: 'chart' },
  cross: { name: 'Related markets', family: 'cross' }, flows: { name: 'Money flows', family: 'money' },
};
const sideOf = (pts) => (pts > 0 ? 'YES' : 'NO');
const say = (s) => (s === 'YES' ? 'UP' : 'DOWN');

// a feature's record of graded arguments ([1, 0, …], newest last): hits, z against a coin flip, and its weight
export function credibility(hist = []) {
  const n = hist.length, hits = hist.reduce((a, x) => a + (x ? 1 : 0), 0), z = n ? (hits - n / 2) / Math.sqrt(n / 4) : 0;
  const cred = (hits + COUNCIL.prior) / (n + 2 * COUNCIL.prior); // shrunk toward 50% while the record is short
  const weight = cred >= 0.5 ? 1 : Math.max(COUNCIL.floorW, 1 - (0.5 - cred) * 4);
  return { n, hits, hit: n ? hits / n : null, z, cred, weight, veto: n >= COUNCIL.minGraded && z <= COUNCIL.vetoZ };
}

// the ruling for one round. args: [{ key, name?, family?, pts }]; ctx: { pYes (the bot's odds before any nudge), z (the
// distance to the target in typical moves for the time left), minutesLeft, settle }; records: { key: [1, 0, …] } (or each
// already summed up by credibility(), as the server sends them to the phone)
export function debate(args, ctx = {}, records = {}) {
  const rulings = (args || []).filter((a) => a && Number.isFinite(a.pts) && a.pts !== 0).map((a) => {
    const m = MEMBERS[a.key] || {};
    return { key: a.key, name: a.name || m.name || a.key, family: a.family || m.family || a.key, pts: a.pts, side: sideOf(a.pts), weight: 1, counted: 0, status: 'counted', why: '' };
  });
  const leader = ctx.pYes == null ? null : ctx.pYes >= 0.5 ? 'YES' : 'NO';
  const settled = Math.abs(ctx.z ?? 0) >= COUNCIL.factsZ || (ctx.settle === 'avg60' && ctx.minutesLeft != null && ctx.minutesLeft <= COUNCIL.lockMin);
  const veto = (r, why) => { r.status = 'vetoed'; r.why = why; };
  for (const r of rulings) {
    // 1. facts
    if (settled && leader && r.side !== leader) { veto(r, Math.abs(ctx.z ?? 0) >= COUNCIL.factsZ ? `the facts settle it: ${say(leader)} leads by ${Math.abs(ctx.z).toFixed(1)} typical moves` : 'the facts settle it: the settlement average is mostly in'); continue; }
    // 2. record
    const rec = records[r.key], c = Array.isArray(rec) || !rec ? credibility(rec) : rec;
    r.record = { n: c.n, hits: c.hits, hit: c.hit };
    if (c.veto) { veto(r, `wrong lately: right ${c.hits} of its last ${c.n} arguments`); continue; }
    r.weight = c.weight;
  }
  // 3. families
  const live = rulings.filter((r) => r.status === 'counted'), fams = {};
  for (const r of live) (fams[r.family] ||= []).push(r);
  for (const [fam, rs] of Object.entries(fams)) {
    if (rs.length < 2) continue;
    if (rs.some((r) => r.side !== rs[0].side)) { for (const r of rs) veto(r, `its own data is split: ${FAMILIES[fam] || fam} argue both ways`); continue; }
    const top = rs.reduce((a, r) => (Math.abs(r.pts * r.weight) > Math.abs(a.pts * a.weight) ? r : a));
    for (const r of rs) if (r !== top) veto(r, `an echo of ${top.name}: the same ${FAMILIES[fam] || fam}, already counted`);
  }
  // 4. the debate
  const counted = rulings.filter((r) => r.status === 'counted');
  for (const r of counted) { r.counted = r.pts * r.weight; r.why = r.weight < 1 ? `counted at ${Math.round(r.weight * 100)}%: a shaky record (right ${r.record.hits} of ${r.record.n})` : 'counted in full'; }
  const raw = counted.reduce((a, r) => a + r.counted, 0), net = Math.max(-COUNCIL.cap, Math.min(COUNCIL.cap, raw));
  const sides = new Set(counted.map((r) => r.side)), argued = sides.size > 1;
  const pts = (v) => `${Math.abs(v * 100).toFixed(1)} pts`;
  const verdict = !rulings.length ? 'No proven feature is arguing: the call is the bot\'s own price math.'
    : !counted.length ? `Every argument was vetoed (${rulings.length}): the call is the bot's own price math.`
      : argued ? `A real debate: ${counted.filter((r) => r.side === 'YES').map((r) => r.name).join(', ')} for UP against ${counted.filter((r) => r.side === 'NO').map((r) => r.name).join(', ')} for DOWN. ${Math.abs(net) < 0.002 ? 'They cancel out.' : `${say(sideOf(net))} carries it by ${pts(net)}.`}`
        : `${counted.length === 1 ? `${counted[0].name} argues` : `${counted.length} features agree`} for ${say(sideOf(net))}: ${pts(net)}${raw !== net ? ' (capped)' : ''}.`;
  return { net, raw, rulings, argued, settled, verdict, vetoed: rulings.filter((r) => r.status === 'vetoed').length };
}
// a round's facts for the council, from the bot's snapshot row (engine.js)
export function councilFacts(row, snap, settle) {
  if (!row?.ev) return {};
  const m = row.ev.minutesLeft, spot = snap?.mSpot ?? snap?.spot, sig = row.sigma ?? snap?.sigmaMin;
  return { pYes: row.pPre ?? row.ev.pYes, minutesLeft: m, settle, z: spot > 0 && row.strike > 0 && sig > 0 && m > 0 ? Math.log(spot / row.strike) / (sig * Math.sqrt(m)) : null };
}
