// The flip check on the server (public/flipmodel.js): every hour it relearns how often the side that's ahead loses,
// from the chart's history (the playbook's 1-minute candles, playbookfeed.js) and from the buyers and sellers on the
// tape (the Round scan's graded samples, scanfeed.js), each scored against the bot's math on data it didn't fit. Every
// tick it checks the live round: the leader's flip chance, what's pushing it, and (once proven) the nudge to the odds
// and the flip-back test the bot's flip calls must pass (public/engine.js).
import { FLIP, chartFeatures, chartSamples, evaluate, flipCheck, flowSamples, volSeries } from './public/flipmodel.js';

const slim = (e) => (e ? { n: e.n, nTest: e.nTest, gain: e.gain, z: e.z, proven: e.proven, w: e.w, lossBase: e.lossBase, lossModel: e.lossModel, flipRate: e.flipRate, mathRate: e.mathRate } : null);

export function createFlipFeed({ playbook, scanFeed = null, clock = () => Date.now(), log = console, refitMs = 3600000 }) {
  let chart = null, flow = null, at = 0, live = null;
  function refit(now = clock()) {
    at = now;
    try { const bars = playbook.bars(); chart = bars.length >= 2000 ? evaluate(chartSamples(bars), FLIP.minChart) : null; } catch (e) { log.warn?.('flip check (chart) failed', e.message); }
    try { const ss = flowSamples(scanFeed?.data?.()?.samples); flow = ss.length >= 100 ? evaluate(ss, FLIP.minFlow) : null; } catch (e) { log.warn?.('flip check (tape) failed', e.message); }
  }
  function observe({ snap } = {}, now = clock()) {
    if (now - at >= refitMs) refit(now);
    const lv = snap?.live;
    if (!lv || !(lv.ev?.minutesLeft > 0.5) || lv.ev.minutesLeft > 14) { live = null; return; }
    const pYes = lv.pPre ?? lv.ev.pYes; // the odds before every nudge (this one's own included)
    if (pYes == null || pYes === 0.5) { live = null; return; }
    const lead = pYes > 0.5 ? 'YES' : 'NO', pLead = Math.max(pYes, 1 - pYes);
    const below = /^less/.test(lv.m.strike_type || ''), leadUp = (lead === 'YES') !== below; // the leader in price terms: above the target or below
    let chartX = null;
    const bars = playbook.bars();
    if (chart?.proven && bars.length > 70 && now - bars.at(-1).t < 3 * 60000) {
      const tail = bars.slice(-120), sig = volSeries(tail).at(-1) ?? lv.sigma ?? snap.sigmaMin;
      chartX = chartFeatures(tail, tail.length - 1, { lead: leadUp ? 1 : -1, sigma: sig, roundStart: Date.parse(lv.m.open_time) });
    }
    const sc = scanFeed?.lastScan?.(), flowX = sc && sc.ticker === lv.m.ticker && now - sc.at < 20000 && sc.x ? sc.x.map((v) => -(v || 0) * (lead === 'YES' ? 1 : -1)) : null;
    const fc = flipCheck({ pLead, chart, chartX, flow, flowX });
    live = fc && { ticker: lv.m.ticker, at: now, lead, minutesLeft: lv.ev.minutesLeft, base: fc.base, p: fc.p, parts: fc.parts.slice(0, 5), used: fc.used,
      pLose: lead === 'YES' ? { YES: fc.p, NO: 1 - fc.p } : { YES: 1 - fc.p, NO: fc.p } };
  }
  const fresh = (now) => live && now - live.at < 20000;
  // the proven flip chance as a nudge to P(YES): a likelier flip takes points off the leader (capped at 5)
  function shifts(now = clock()) {
    if (!fresh(now) || !live.used) return null;
    const d = Math.max(-FLIP.cap, Math.min(FLIP.cap, live.p - live.base));
    if (Math.abs(d) < 0.002) return null;
    return { [live.ticker]: live.lead === 'YES' ? -d : d };
  }
  // what the bot's flip calls read (snap.flipCheck): only once a part is proven
  const check = (now = clock()) => (fresh(now) && live.used ? live : null);
  return { refit, observe, shifts, check, api: (now = clock()) => ({ chart: slim(chart), flow: slim(flow), live: fresh(now) ? live : null, inCalls: shifts(now), need: { chart: FLIP.minChart, flow: FLIP.minFlow, z: FLIP.z } }) };
}
