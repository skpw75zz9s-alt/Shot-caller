// Indicator tuning on the server (public/tune.js does the testing). Every hour it reruns the test on the playbook's
// 1-minute candle history (playbookfeed.js, up to 21 days), and every tick it turns the proven indicators' read into
// a nudge for the live market's odds (bot.js shifts, with the Round scan's and the micro model's).
import { indicatorRead, indicatorShift, tuneIndicators } from './public/tune.js';
import { patternStats, rangeLadder } from './public/lessons.js';
import { cushionTable } from './public/settle.js';
import { flipStudy } from './public/flipstudy.js';

export function createTuneFeed({ playbook, settle = 'avg60', clock = () => Date.now(), log = console }) {
  let report = null, lastLive = null, read = { drift: 0, active: [] }, readAt = 0;
  function rerun() {
    try {
      const bars = playbook.bars();
      // the lessons' own claims (public/lessons.js): the ceiling / floor "areas" and the double bottom's take profit vs stop
      // the flip study: crypto settles on a 60-second average (w 1), indexes, gold and oil on the close (w 0)
      if (bars.length >= 2000) report = { ...tuneIndicators(bars), lessons: { ladder: rangeLadder(bars), patterns: patternStats(bars) }, cushion: cushionTable(bars), flipStudy: flipStudy(bars, { lastMin: 1, laneLastMin: 5, w: settle === 'avg60' ? 1 : 0 }), ranAt: clock(), bars: bars.length }; // flips learned from every minute to the last one (public/flipstudy.js)
    } catch (e) { log.error('indicator tuning failed', e.message); }
  }
  function observe({ snap }, now = clock()) {
    const lv = snap?.live;
    lastLive = lv ? { ticker: lv.m.ticker, strike: lv.strike, spot: snap.mSpot ?? snap.spot, sigmaMin: lv.sigma ?? snap.sigmaMin, minutesLeft: lv.ev.minutesLeft, strikeType: lv.m.strike_type } : null;
    if (!report || now - report.ranAt >= 3600000) rerun();
    if (now - readAt >= 10000) { readAt = now; read = indicatorRead(report, playbook.bars()); }
  }
  function shifts() {
    if (!lastLive || !read.drift) return null;
    const v = indicatorShift(read.drift, lastLive);
    return v ? { [lastLive.ticker]: v } : null;
  }
  return { observe, rerun, shifts, api: () => ({ report, read, inCalls: shifts() }) };
}
