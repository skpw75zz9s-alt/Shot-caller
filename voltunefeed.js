// Volatility tuning on the server (public/voltune.js does the testing). Every hour it reruns the walk-forward test on the
// playbook's 1-minute candle history (playbookfeed.js, up to 21 days). Once a setting has proven itself out of sample,
// the bot's odds use it (bot.js passes it in with what the server has learned; the phone gets it from /api/learn).
import { tuneVolAsync, vtLive } from './public/voltune.js';

export function createVolTuneFeed({ playbook, clock = () => Date.now(), log = console }) {
  let report = null, running = false, triedAt = 0;
  async function rerun() { // a slice at a time (public/voltune.js tuneVolAsync): ~2 s of work, spread out
    if (running) return;
    running = true; triedAt = clock();
    try { const bars = playbook.bars(); if (bars.length >= 2000) report = { ...(await tuneVolAsync(bars)), ranAt: clock(), bars: bars.length }; } catch (e) { log.error('volatility tuning failed', e.message); } finally { running = false; }
  }
  function observe(now = clock()) { if (now - triedAt >= 3600000 && (!report || now - report.ranAt >= 3600000)) rerun(); }
  return { observe, rerun, live: () => vtLive(report), api: () => ({ report, live: vtLive(report) }) };
}
