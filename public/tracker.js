// Grades the bot on the whole 15-minute window instead of its first call.
// Every few seconds it samples the bot's odds and call, paper-trades "follow the bot"
// (buy on each call, cash out on a sell signal or when the call flips, else hold to settlement),
// and when Kalshi settles the window it turns that into a report card.
import { exitSignal, kalshiFee } from './model.js';
import { flipSigns } from './candles.js';

const SAMPLE_MS = 5000;
const STAKE = 10; // paper P&L is reported per $10 call
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

export const newTracker = () => ({ windows: {}, reports: [] });

function closePaper(w, price, how, now) {
  const p = w.paper;
  const proceeds = how === 'settled' ? price : price - kalshiFee(price);
  const pts = proceeds - (p.price + kalshiFee(p.price));
  w.trades.push({ side: p.side, entry: p.price, exit: price, how, at: p.at, exitAt: now, pts: r3(pts) });
  w.paper = null;
}

// Record one moment of the live window. `row` and `sig` come from snapshot() / buySignal().
export function trackWindow(tr, snap, row, sig, settings, now = snap.now) {
  if (!row || row.ev.pYes == null) return false;
  const { m, ev } = row;
  const closeTime = Date.parse(m.close_time);
  if (now >= closeTime) return false;
  const w = (tr.windows[m.ticker] ||= { ticker: m.ticker, title: m.title, strike: row.strike, openTime: Date.parse(m.open_time), closeTime, samples: [], paper: null, trades: [] });
  const last = w.samples[w.samples.length - 1];
  if (last && now - last.t < SAMPLE_MS) return false;

  const q = ev.quote;
  const call = ev.side && sig?.confident ? ev.side : null;
  if (row.strike) w.strike = row.strike;
  w.samples.push({ t: now, p: r3(ev.pYes), call, conf: sig?.deep?.score ?? null, ya: q.yesAsk, yb: q.yesBid, na: q.noAsk, nb: q.noBid });

  const bid = (side) => (side === 'YES' ? q.yesBid : q.noBid);
  const ask = (side) => (side === 'YES' ? q.yesAsk : q.noAsk);
  if (w.paper) {
    const pos = w.paper;
    const pSide = pos.side === 'YES' ? ev.pYes : 1 - ev.pYes;
    const b = bid(pos.side);
    const flipped = call && call !== pos.side;
    const ex = exitSignal({ pos, bid: b, pSide, flips: flipSigns(snap.bars, pos.side, now), minutesLeft: ev.minutesLeft, settings });
    if (b != null && (flipped || ex.action === 'SELL')) closePaper(w, b, flipped ? 'flipped' : ex.kind, now);
    else {
      if (b != null) pos.peakBid = Math.max(pos.peakBid ?? 0, b);
      pos.peakP = Math.max(pos.peakP ?? 0, pSide);
    }
  }
  // Enter on a call; after cashing out, wait a minute before re-entering the same side
  if (!w.paper && call && ask(call) != null && !w.trades.some((t) => t.side === call && now - t.exitAt < 60000)) {
    w.paper = { side: call, price: ask(call), contracts: 1, at: now, peakBid: null, peakP: null };
  }
  return true;
}

// Windows that have closed and are waiting for Kalshi's result.
export const pendingWindows = (tr, now = Date.now()) => Object.values(tr.windows).filter((w) => w.closeTime < now - 60000);

// Turn a settled window into a report card. result is 'yes' or 'no'.
export function gradeWindow(tr, ticker, result) {
  const w = tr.windows[ticker];
  if (!w) return null;
  delete tr.windows[ticker];
  if (!w.samples.length) return null;
  const yes = result === 'yes';
  if (w.paper) closePaper(w, w.paper.side === (yes ? 'YES' : 'NO') ? 1 : 0, 'settled', w.closeTime);

  const s = w.samples;
  const winnerP = s.map((x) => (yes ? x.p : 1 - x.p));
  const avgWinnerOdds = winnerP.reduce((a, b) => a + b, 0) / s.length;
  const timeRight = s.filter((x) => (x.p >= 0.5) === yes).length / s.length;
  let flips = 0;
  for (let i = 1; i < s.length; i++) if ((s[i].p >= 0.5) !== (s[i - 1].p >= 0.5)) flips++;
  const span = w.closeTime - w.openTime;
  const coverage = Math.min(1, (s[s.length - 1].t - s[0].t + SAMPLE_MS) / span);
  const callSamples = s.filter((x) => x.call);
  const callsRight = callSamples.length ? callSamples.filter((x) => x.call === (yes ? 'YES' : 'NO')).length / callSamples.length : null;
  const paperPts = w.trades.reduce((a, t) => a + t.pts, 0);
  const paperUsd = w.trades.reduce((a, t) => a + (t.pts * STAKE) / t.entry, 0);
  const grade = avgWinnerOdds >= 0.7 ? 'A' : avgWinnerOdds >= 0.6 ? 'B' : avgWinnerOdds >= 0.5 ? 'C' : 'D';

  // Downsample the odds to ~40 points for the sparkline: [minute into window, P(YES)]
  const step = Math.max(1, Math.ceil(s.length / 40));
  const spark = s.filter((_, i) => i % step === 0 || i === s.length - 1).map((x) => [r3((x.t - w.openTime) / 60000), x.p]);

  const report = {
    ticker, title: w.title, strike: w.strike, openTime: w.openTime, closeTime: w.closeTime, result, grade,
    avgWinnerOdds: r3(avgWinnerOdds), timeRight: r3(timeRight), callsRight: r3(callsRight), flips, coverage: r3(coverage),
    finalOdds: r3(winnerP[winnerP.length - 1]), calls: w.trades.length, trades: w.trades, paperPts: r3(paperPts), paperUsd: Math.round(paperUsd * 100) / 100, spark,
  };
  tr.reports = [report, ...tr.reports.filter((r) => r.ticker !== ticker)].slice(0, 200);
  return report;
}

// Drop windows that never got a result (e.g. Kalshi voided them) after two hours.
export function pruneWindows(tr, now = Date.now()) {
  for (const [k, w] of Object.entries(tr.windows)) if (w.closeTime < now - 2 * 3600000) delete tr.windows[k];
}

// Totals across report cards.
export function summarize(reports) {
  if (!reports.length) return null;
  const n = reports.length;
  const mean = (k) => reports.reduce((a, r) => a + (r[k] ?? 0), 0) / n;
  return {
    windows: n, avgWinnerOdds: mean('avgWinnerOdds'), timeRight: mean('timeRight'),
    calls: reports.reduce((a, r) => a + r.calls, 0), paperUsd: reports.reduce((a, r) => a + r.paperUsd, 0),
    grades: ['A', 'B', 'C', 'D'].map((g) => reports.filter((r) => r.grade === g).length),
  };
}

// Prefer whichever copy of a window's report watched more of it (server vs this phone).
export function mergeReports(a, b) {
  const by = new Map();
  for (const r of [...a, ...b]) {
    const cur = by.get(r.ticker);
    if (!cur || (r.coverage ?? 0) > (cur.coverage ?? 0)) by.set(r.ticker, r);
  }
  return [...by.values()].sort((x, y) => y.closeTime - x.closeTime);
}
