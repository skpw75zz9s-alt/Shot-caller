// The micro model on the server (public/micro.js does the learning). Every 10 seconds it reads the market's small
// details from the live feeds (scanfeed.js trades and Round scan, futures.js, marketwatch.js Kalshi flow and jumps,
// the bot's snapshot), predicts BTC's move 1, 3 and 5 minutes out, and grades each prediction when its time comes
// (against BTC's actual price then) before learning from it. Kept in DATA_DIR/micro.json.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HORIZONS, microLearn, microPredict, microRead, microVector, newMicro } from './public/micro.js';
import { quote } from './public/model.js';

export function createMicroFeed({ file, scanFeed, futures = null, marketWatch = null, clock = () => Date.now(), log = console }) {
  let M = newMicro(), pending = [], lastAt = 0, read = null, savedAt = 0;
  async function load() { try { const d = JSON.parse(await readFile(file, 'utf8')); if (d?.v === 1 && d.models) M = d; } catch { /* first run */ } }
  async function save() {
    try { await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(M)); await rename(`${file}.tmp`, file); } catch (e) { log.error('saving the micro model failed', e.message); }
  }
  // The details right now (see public/micro.js MICRO_FEATURES), from everything the server sees
  function features(snap, now) {
    const sig = snap?.sigmaMin, price = scanFeed.spot(now);
    if (!(price > 0) || !(sig > 0)) return null;
    const p1 = scanFeed.spotAt(now - 60000), p5 = scanFeed.spotAt(now - 300000);
    const f = futures?.features({ now, spotAt: scanFeed.spotAt, sigmaMin: sig }) ?? {};
    const sc = scanFeed.lastScan()?.sc, live = snap.live;
    const dir = /^less/.test(live?.m?.strike_type || '') ? -1 : 1, q = live ? quote(live.m) : null;
    const mid = q?.yesBid != null && q?.yesAsk != null ? (q.yesBid + q.yesAsk) / 2 : null, pBot = live?.pPre ?? live?.ev?.pYes;
    return { price, sigmaMin: sig, x: microVector({
      flow30: scanFeed.imbalance(now - 30000) ?? 0, flow120: scanFeed.imbalance(now - 120000) ?? 0,
      ret1: p1 ? Math.log(price / p1) / sig : 0, ret5: p5 ? Math.log(price / p5) / (sig * Math.sqrt(5)) : 0,
      fLead: f.live ? f.lead : 0, fFlow: f.live ? f.flow : 0, fPremium: f.live ? f.premium : 0,
      leader: sc?.features?.leader ?? 0, absorb: sc?.features?.absorb ?? 0,
      cbPremium: sc?.cbPremium != null ? sc.cbPremium / (price * sig) : 0,
      kalshiTilt: mid != null && pBot != null ? (mid - pBot) * 3 * dir : 0, kFlow: (marketWatch?.kFlow(now) ?? 0) * dir,
      jump: marketWatch?.lastJump(now) ?? 0,
    }) };
  }
  function observe({ snap }, now = clock()) {
    // grade the predictions whose time has come (only right on time: the price a few seconds late is still fair)
    const price = scanFeed.spot(now);
    let learned = false;
    pending = pending.filter((s) => {
      const due = s.t + s.h * 60000;
      if (now < due) return true;
      if (price > 0 && now - due <= 5000) { microLearn(M, s.h, s.x, Math.log(price / s.p0) / (s.sigma * Math.sqrt(s.h)), s.yhat); learned = true; }
      return false;
    });
    if (now - lastAt < 10000) return;
    lastAt = now;
    const f = features(snap, now);
    if (!f) { read = null; return; }
    const yh = microPredict(M, f.x);
    for (const h of HORIZONS) pending.push({ t: now, h, x: f.x, p0: f.price, sigma: f.sigmaMin, yhat: yh[h] });
    if (pending.length > 2000) pending.splice(0, pending.length - 2000);
    read = { ...microRead(M, f.x, { price: f.price, sigmaMin: f.sigmaMin }), at: now, price: f.price };
    if (learned && now - savedAt > 300000) { savedAt = now; save(); }
  }
  return { load, observe, save, api: () => ({ read, models: Object.fromEntries(HORIZONS.map((h) => [h, { n: M.models[h].n, skill: M.models[h].e0 > 0 ? 1 - M.models[h].e1 / M.models[h].e0 : 0 }])) }), model: () => M };
}
