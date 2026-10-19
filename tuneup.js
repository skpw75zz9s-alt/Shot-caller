// The tune-up (v13.52), on the server: run on demand (Settings → Admin → Run tune-up, POST /api/admin/tuneup, or
// `npm run tuneup` on the server's data). For every running market it
//   1. reruns each learner now instead of on its hourly timer: the indicator test, the cushion table and flip study
//      (tunefeed.js), the volatility tuner (voltunefeed.js) and the flip check (flipfeed.js), each on the latest candles;
//   2. tests the round call's blend and calibration on graded rounds they never saw (public/tuneup.js), and keeps a
//      setting only when it beats what the bot does now by a clear margin;
//   3. writes what it found to DATA_DIR/tuneup.json (the settings the bot uses, and the report).
// Nothing runs between tune-ups: it costs a few seconds of work when you run it, and no memory otherwise.
import { readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pickMix, pickScore } from './public/pick.js';
import { tuneUpPicks } from './public/tuneup.js';

// what each learner says right now, for the before / after in the report
export function learnerSummary(st) {
  if (!st) return null;
  const t = st.tuneFeed?.api?.().report, v = st.volTuneFeed?.live?.(), f = st.flipFeed?.api?.();
  return {
    history: t?.bars ?? null, // one-minute candles the learners read
    indicators: (t?.families || []).filter((x) => x.proven).map((x) => x.setting),
    indicatorsTested: (t?.families || []).length,
    flipStudy: t?.flipStudy ? { flips: t.flipStudy.flips ?? null, proven: !!t.flipStudy.proven } : null,
    volatility: v ? (v.use ? { lambda: v.lambda, floor: v.floor, scale: v.scale, tails: v.tails, z: v.z } : 'default (no setting has beaten it yet)') : null,
    drift: v?.drift ? { lookback: v.drift.lookback, weight: v.drift.weight, z: v.drift.z } : null,
    flipCheck: f ? { chart: !!f.chart?.proven, flow: !!f.flow?.proven } : null,
  };
}

export function createTuneUp({ file, clock = () => Date.now(), log = console }) {
  let state = { settings: {}, last: null, history: [] }, mtime = 0, running = null;
  async function load() {
    try { const s = await stat(file); if (s.mtimeMs === mtime) return; mtime = s.mtimeMs; const j = JSON.parse(await readFile(file, 'utf8')); if (j && typeof j === 'object') state = { settings: j.settings || {}, last: j.last || null, history: j.history || [] }; }
    catch { /* none yet */ }
  }
  async function save() {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(state));
    await rename(`${file}.tmp`, file);
    try { mtime = (await stat(file)).mtimeMs; } catch { /* next load rereads it */ }
  }
  // `npm run tuneup` writes the file while the server runs: pick its settings up within a minute
  const watch = setInterval(() => { load().catch(() => {}); }, 60000);
  watch.unref?.();

  // markets: [{ series, name, bot, stack }] (a stack holds an asset's learners; markets on one asset share it)
  async function run(markets, { refresh = true } = {}) {
    if (running) return running;
    running = (async () => {
      const t0 = clock(), seen = new Set(), out = [];
      for (const m of markets) {
        const st = m.stack, row = { series: m.series, name: m.name || m.series };
        try {
          if (refresh && st && !seen.has(st)) {
            seen.add(st);
            const before = learnerSummary(st);
            try { st.tuneFeed?.rerun?.(); } catch (e) { log.error?.('tune-up: indicator test failed', e.message); }
            try { await st.volTuneFeed?.rerun?.(); } catch (e) { log.error?.('tune-up: volatility tuner failed', e.message); }
            try { st.flipFeed?.refit?.(clock()); } catch (e) { log.error?.('tune-up: flip check failed', e.message); }
            row.learners = { before, after: learnerSummary(st) };
          } else if (st) row.learners = { shared: true, after: learnerSummary(st) };
          const picks = m.bot?.picks?.() || [], auto = pickMix(picks);
          const r = tuneUpPicks(picks, auto.mix);
          row.blend = r.blend; row.calibration = r.calibration;
          const sc = pickScore(picks);
          row.record = { graded: sc.n, brier: sc.brier, vs: sc.vs, brierPick: sc.brierPick, brierBot: sc.brierBot, brierKalshi: sc.brierKalshi };
          // a setting stays only while it keeps proving itself: one that no longer does goes back to the bot's own
          const keep = Object.fromEntries(Object.entries(r.settings).filter(([, v]) => v != null));
          if (Object.keys(keep).length) state.settings[m.series] = { ...keep, at: clock() };
          else delete state.settings[m.series];
          row.uses = state.settings[m.series] || null;
        } catch (e) { row.error = String(e?.message || e); log.error?.(`tune-up: ${m.series} failed`, row.error); }
        out.push(row);
      }
      state.last = { at: t0, ms: clock() - t0, markets: out };
      state.history = [{ at: t0, applied: out.filter((x) => x.uses).map((x) => ({ series: x.series, ...x.uses })) }, ...state.history].slice(0, 20);
      await save().catch((e) => log.error?.('tune-up: saving failed', e.message));
      return state.last;
    })().finally(() => { running = null; });
    return running;
  }

  return {
    load, run,
    get: (series) => state.settings[series] || null,
    status: () => ({ running: !!running, settings: state.settings, last: state.last, history: state.history }),
    stop: () => clearInterval(watch),
  };
}
