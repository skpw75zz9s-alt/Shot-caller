#!/usr/bin/env node
// `npm run tuneup`: the tune-up from a terminal (tuneup.js, public/tuneup.js). It reads the round calls the bot has
// graded (record-pick.json in DATA_DIR, one per market), tests the blend and calibration on rounds they never saw, and
// saves the settings that proved themselves to DATA_DIR/tuneup.json; a running server picks them up within a minute.
// Rerunning the learners on fresh candles needs the running server: use Settings → Admin → Run tune-up for that.
//   npm run tuneup                 the report, and save what proved itself
//   npm run tuneup -- --dry-run    the report only
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTuneUp } from '../tuneup.js';
import { HOME } from '../public/markets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data');
const dry = process.argv.includes('--dry-run');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const f3 = (x) => (x == null ? '—' : x.toFixed(3));

async function picksAt(file) { try { const j = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(j) ? j : null; } catch { return null; } }
const markets = [];
const home = await picksAt(join(DATA_DIR, 'record-pick.json'));
if (home) markets.push({ series: HOME.series, picks: home });
for (const d of await readdir(join(DATA_DIR, 'markets')).catch(() => [])) {
  const p = await picksAt(join(DATA_DIR, 'markets', d, 'record-pick.json'));
  if (p) markets.push({ series: d, picks: p });
}
if (!markets.length) { console.log(`No graded round calls found in ${DATA_DIR} (record-pick.json). Run this where the server keeps its data, or set DATA_DIR.`); process.exit(0); }

const tu = createTuneUp({ file: join(DATA_DIR, dry ? 'tuneup.dry-run.json' : 'tuneup.json'), log: { error: () => {} } });
await tu.load();
const report = await tu.run(markets.map((m) => ({ series: m.series, bot: { picks: () => m.picks } })), { refresh: false });
tu.stop();

console.log(`Tune-up · ${new Date(report.at).toLocaleString()} · ${DATA_DIR}${dry ? ' · dry run (nothing saved)' : ''}\n`);
for (const m of report.markets) {
  console.log(`${m.series}`);
  if (m.error) { console.log(`  failed: ${m.error}\n`); continue; }
  const r = m.record, b = m.blend, c = m.calibration;
  console.log(`  graded round calls: ${r.graded}${r.vs ? ` · Brier (lower is better): round call ${f3(r.brierPick)}, bot alone ${f3(r.brierBot)}, Kalshi ${f3(r.brierKalshi)}` : ''}`);
  console.log(`  blend: ${b.apply ? `now ${Math.round(b.chosen * 100)}% bot (was ${Math.round(b.current * 100)}%)` : `stays ${Math.round(b.current * 100)}% bot`} · ${b.why}`);
  console.log(`  calibration: ${c.apply ? `odds scaled by ${c.temp} (on unseen rounds it said ${pct(c.said)}, won ${pct(c.won)})` : 'unchanged'} · ${c.why}`);
  console.log(`  uses: ${m.uses ? JSON.stringify(m.uses) : 'the bot\'s own settings'}\n`);
}
console.log(dry ? 'Dry run: nothing was saved.' : `Saved to ${join(DATA_DIR, 'tuneup.json')}. A running server picks it up within a minute.`);
console.log('To also rerun the learners on fresh candles, use Settings → Admin → Run tune-up in the app.');
