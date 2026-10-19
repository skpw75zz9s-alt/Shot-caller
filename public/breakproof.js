// Proof for the X-ray's breaks (v13.61). A break itself is a measurement (a $280 minute is arithmetic); what it is
// supposed to mean is a claim, and every claim is graded here against what actually happened next. The server
// (breaklab.js) detects breaks around the clock, records each one with the facts at that moment, and grades it when its
// horizon passes or its round settles. Where it makes sense, the same outcome is measured at ordinary moments (a control
// sample every minute) so a break is compared with "no break", not with a guess.
//   proven       the claim held clearly more often than its control (or than a coin flip): z >= 2 on 30+ graded cases
//   opposite     the reverse held clearly: the claim is wrong, and the X-ray says what really happens
//   noise        30+ cases and no clear difference: the break is shown, its claim is not
//   testing      fewer than 30 graded cases so far
//   fact         nothing to prove (the prices on the screen added up)
//   untested     the server can't grade it (it doesn't see the data needed)
export const PROOF = { minN: 30, z: 2, keep: 400 };
const MIN = 60000;
const pc = (x) => `${Math.round(x * 100)}%`;
// a bigger-than-usual 5-minute move: more than one typical 5-minute move (a normal market does that about a third of the time)
const big5 = (e, a) => e.spot > 0 && a?.spot > 0 && e.sigmaMin > 0 && Math.abs(Math.log(a.spot / e.spot)) > e.sigmaMin * Math.sqrt(5);
const leaderLost = (up, y) => (up ? 1 : 0) !== y;

// each claim: how it's graded (h: a horizon in ms, graded on the price, odds and Kalshi then; settle: on the result),
// what it's compared with (pool: a control measured at ordinary moments; or a coin flip), and how to say the result
export const CLAIMS = {
  jump: { h: 5 * MIN, pool: 'move5', claim: 'the next 5 minutes move more than usual', out: big5,
    say: (r, n, c) => `${pc(r)} of ${n} were followed by a bigger-than-usual 5-minute move, against ${pc(c)} of ordinary moments` },
  breakout: { h: 5 * MIN, claim: 'it holds: 5 minutes later the price is still past the level', out: (e, a) => (e.dir > 0 ? a.spot > e.level : a.spot < e.level),
    say: (r, n) => `held 5 minutes later in ${pc(r)} of ${n} breakouts (failed back into the range in ${pc(1 - r)})` },
  lag: { h: MIN, pool: 'kalshi', claim: 'Kalshi catches up within a minute', out: (e, a) => a.mid != null && e.mid != null && (a.mid - e.mid) * e.dir >= e.size / 2,
    say: (r, n, c) => `Kalshi caught up within a minute ${pc(r)} of ${n} times, against ${pc(c)} for an ordinary minute` },
  gap: { settle: true, two: true, claim: 'who is closer to the result when they disagree: the bot or Kalshi', out: (e, y) => e.mid != null && Math.abs(e.p - y) < Math.abs(e.mid - y),
    say: (r, n) => `the bot was closer to the result in ${pc(r)} of ${n} big disagreements, Kalshi in ${pc(1 - r)}`,
    pos: 'when they disagree this much, the bot has been right more often', neg: 'when they disagree this much, Kalshi has been right more often: trust Kalshi' },
  book: { fact: 'the prices on the screen added up: nothing to prove' },
  flip: { settle: true, pool: 'leader', claim: 'the side ahead loses more often than usual', out: (e, y) => leaderLost(e.p >= 0.5, y),
    say: (r, n, c) => `the side ahead lost ${pc(r)} of ${n} times, against ${pc(c)} at ordinary moments` },
  regime: { settle: true, pool: 'leader', claim: 'leads flip more often than usual', out: (e, y) => leaderLost(e.p >= 0.5, y),
    say: (r, n, c) => `the side ahead lost ${pc(r)} of ${n} wild rounds, against ${pc(c)} at ordinary moments` },
  lead: { settle: true, pool: 'leader', claim: 'the new leader loses more often than usual', out: (e, y) => leaderLost(e.dir > 0, y),
    say: (r, n, c) => `the new leader lost ${pc(r)} of ${n} lead changes, against ${pc(c)} for the side ahead at ordinary moments` },
  swing: { h: MIN, claim: 'the swing holds a minute later', out: (e, a) => a.p != null && (a.p - e.from) * e.dir >= e.size / 2,
    say: (r, n) => `the bot's odds held at least half the swing a minute later in ${pc(r)} of ${n} swings` },
  kswing: { h: MIN, claim: 'Kalshi\'s swing holds a minute later', out: (e, a) => a.mid != null && (a.mid - e.from) * e.dir >= e.size / 2,
    say: (r, n) => `Kalshi's price held at least half the swing a minute later in ${pc(r)} of ${n} swings` },
  diverge: { settle: true, two: true, claim: 'who is right when they move apart: the bot or Kalshi', out: (e, y) => (e.dir > 0 ? 1 : 0) === y,
    say: (r, n) => `the side the bot moved toward won ${pc(r)} of ${n} times, Kalshi's side ${pc(1 - r)}`,
    pos: 'when they pull apart, the bot\'s side has won more often', neg: 'when they pull apart, Kalshi\'s side has won more often: trust Kalshi' },
  flow: { h: 5 * MIN, two: true, claim: 'does the price keep going the flow\'s way for 5 minutes', out: (e, a) => (a.spot - e.spot) * e.dir > 0,
    say: (r, n) => `the price kept going the flow's way in ${pc(r)} of ${n} rushes (gave it back in ${pc(1 - r)})`,
    pos: 'a rush like this has kept going', neg: 'a rush like this has usually given the move back' },
  liqs: { h: 5 * MIN, two: true, claim: 'does the price keep going the forced way for 5 minutes', out: (e, a) => (a.spot - e.spot) * e.dir > 0,
    say: (r, n) => `the price kept going the forced way in ${pc(r)} of ${n} bursts (bounced in ${pc(1 - r)})`,
    pos: 'liquidation bursts like this have kept pushing', neg: 'liquidation bursts like this have usually bounced back' },
  split: { untested: 'it needs each exchange\'s price a minute later, which the server doesn\'t keep yet' },
  order: { untested: 'only the phone sees Kalshi\'s trades, so the server can\'t follow them up' },
};
// the control samples: the same outcomes at ordinary moments
export const POOLS = {
  move5: { h: 5 * MIN, out: big5 },
  kalshi: { h: MIN, out: CLAIMS.lag.out }, // a random minute's Kalshi move the bot's latest way, by half an 8-point lag
  leader: { settle: true, out: (e, y) => leaderLost(e.p >= 0.5, y) },
};

const zFlip = (hits, n) => (n ? (hits - n / 2) / Math.sqrt(n / 4) : 0);
function zTwo(h1, n1, h2, n2) { const p = (h1 + h2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)); return se > 0 ? (h1 / n1 - h2 / n2) / se : 0; }
const sum = (xs) => (xs || []).reduce((a, x) => a + (x ? 1 : 0), 0);

// the verdict on one claim: its graded cases (1 = the claim held) and, when it has one, its control's
export function verdict(key, cases = [], control = []) {
  const c = CLAIMS[key];
  if (!c) return { status: 'untested', text: 'not tested yet' };
  if (c.fact) return { status: 'fact', text: c.fact };
  if (c.untested) return { status: 'untested', text: `not tested yet: ${c.untested}` };
  const n = cases.length, hits = sum(cases), r = n ? hits / n : null, out = { claim: c.claim, n, need: PROOF.minN };
  if (n < PROOF.minN || (c.pool && control.length < PROOF.minN)) return { ...out, status: 'testing', text: `claim being tested: ${c.claim} (${n} of ${PROOF.minN} graded${c.pool && control.length < PROOF.minN ? `, ${control.length} of ${PROOF.minN} ordinary moments` : ''})` };
  const base = c.pool ? sum(control) / control.length : 0.5, z = c.pool ? zTwo(hits, n, sum(control), control.length) : zFlip(hits, n), m = c.say(r, n, base);
  const res = { ...out, rate: r, base, z, measured: m };
  if (c.two) {
    if (z >= PROOF.z) return { ...res, status: 'proven', side: 'pos', text: `Proven: ${c.pos} (${m}).` };
    if (z <= -PROOF.z) return { ...res, status: 'proven', side: 'neg', text: `Proven: ${c.neg} (${m}).` };
    return { ...res, status: 'noise', text: `Tested: no clear answer yet (${m}). Treat it as noise.` };
  }
  if (z >= PROOF.z) return { ...res, status: 'proven', text: `Proven: ${c.claim} (${m}).` };
  if (z <= -PROOF.z) return { ...res, status: 'opposite', text: `Proven wrong: the opposite holds (${m}).` };
  return { ...res, status: 'noise', text: `Tested: no better than ${c.pool ? 'ordinary moments' : 'a coin flip'} (${m}). Treat it as noise.` };
}
