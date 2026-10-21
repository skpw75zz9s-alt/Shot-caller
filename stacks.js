// Every market's own copy of the bot (v13.30). Bitcoin's 15-minute stack is built in server.js as before (its files and
// records unchanged); this keeps one more for each market Kalshi has open (discovery.js), built the same way:
//   per market (Kalshi series)   bot.js: its odds, calls, push alerts, learning, official record, guards, 10-minute
//                                pick, Discord posts (tagged with the market)
//   per asset (coin or index)    Round scan + liquidations (12 exchange feeds), futures (Hyperliquid), Market watch, the
//                                micro model, the forecasts and candle model (playbook), indicator and volatility tuning,
//                                Discord market alerts. Stock indexes, gold and oil have no exchange trade feeds or
//                                futures here, so their Round scan, futures and liquidations are empty (never made up);
//                                the rest runs on their candles and Kalshi's own book and trades
// New markets start one at a time (a minute apart), so a fresh server doesn't hit every exchange and Kalshi at once.
import { liqSummary } from './public/xray.js';
import { join } from 'node:path';
import { createBot } from './bot.js';
import { createScanFeed } from './scanfeed.js';
import { createWhaleFilter } from './whalefilter.js';
import { createFutures } from './futures.js';
import { createPlaybook } from './playbookfeed.js';
import { createMarketWatch } from './marketwatch.js';
import { createMicroFeed } from './microfeed.js';
import { createFlowsFeed } from './flowsfeed.js';
import { createTuneFeed } from './tunefeed.js';
import { createFlipFeed } from './flipfeed.js';
import { createVolTuneFeed } from './voltunefeed.js';
import { createAlertWatcher } from './discordalerts.js';
import { ASSETS, HOME, dataDir as marketDir, marketOf } from './public/markets.js';

// A Round scan with no feeds (stock indexes, gold, oil): every read is empty
export const nullScan = () => ({ load: async () => {}, start() {}, stop() {}, observe() {}, add() {}, api: () => null, spot: () => null, shifts: () => null, proven: () => false,
  venues: () => [], feedTimes: () => ({}), flowSince: () => null, spotAt: () => 0, imbalance: () => null, lastScan: () => null, data: () => null });

const mergeShifts = (...all) => { const out = {}; for (const m of all) for (const [k, v] of Object.entries(m || {})) out[k] = (out[k] || 0) + v; return Object.keys(out).length ? out : null; };

// home: Bitcoin's stack from server.js { bot, scanFeed, futures, playbook, marketWatch, microFeed, tuneFeed, volTuneFeed, discordAlerts }
export function createStacks({ home, dataDir, kalshi, coinbase, prices, discovery, discord, canNotify, crossFeed = null, council = null, breakLab = null, strength = null, book = null, team = () => null, tuned = () => null, env = process.env, log = console, clock = () => Date.now() }) {
  const assets = new Map([['BTC', home]]), bots = new Map([[HOME.series, home.bot]]), starting = new Set();
  const alertsFor = new Set(String(env.DISCORD_ALERT_MARKETS || 'BTC').split(',').map((x) => x.trim().toUpperCase()));
  const say = (key) => alertsFor.has('ALL') || alertsFor.has(key);
  const on = (name) => env[name] !== 'off';

  function assetStack(key) {
    if (assets.has(key)) return assets.get(key);
    const a = ASSETS.find((x) => x.key === key);
    const dir = join(dataDir, 'assets', key), crypto = a.kind === 'crypto';
    const discordAlerts = createAlertWatcher({ market: { key: a.key, digits: a.digits }, post: (embed) => (say(key) ? discord.alert({ ...embed, title: `[${key}] ${embed.title || ''}` }) : null) });
    const futures = crypto && a.sym?.hyper ? createFutures({ coin: a.sym.hyper }) : null;
    const whaleFilter = crypto ? createWhaleFilter({ file: join(dir, 'whales.json'), clock }) : null; // which whales move this market (whalefilter.js)
    const scanFeed = crypto ? createScanFeed({ file: join(dir, 'scan.json'), futures, asset: a, onTrade: (x, now) => { whaleFilter.add(x, now); discordAlerts.whale(x, now, whaleFilter.verdict(x)); }, onLiq: (x, now) => discordAlerts.liquidation(x, now) }) : nullScan();
    const playbook = createPlaybook({ coinbase, file: join(dir, 'bars.json'), candleRows: (o = {}) => prices.candleRows(a, { gran: 60, ...o }) });
    if (futures) playbook.setOi(() => { const c = futures.context(); return c?.live ? c : null; });
    playbook.setFlow(() => scanFeed.imbalance(clock() - 900000));
    const marketWatch = createMarketWatch({ kalshi, asset: { key: a.key, digits: a.digits }, scanFeed, futures, playbook });
    const tuneFeed = createTuneFeed({ playbook, settle: a.settle }), volTuneFeed = createVolTuneFeed({ playbook }), flipFeed = createFlipFeed({ playbook, scanFeed });
    const microFeed = createMicroFeed({ file: join(dir, 'micro.json'), scanFeed, futures, marketWatch, playbook });
    const flowsFeed = crypto ? createFlowsFeed({ asset: a, file: join(dir, 'flows.json'), prices, playbook, env, log }) : null; // money flows (flowsfeed.js)
    const st = { asset: a, scanFeed, futures, playbook, marketWatch, tuneFeed, volTuneFeed, flipFeed, microFeed, flowsFeed, discordAlerts, whaleFilter, ready: null };
    st.ready = Promise.all([scanFeed.load(), microFeed.load(), playbook.load(), flowsFeed?.load(), whaleFilter?.load()]).then(() => {
      if (crypto && on('SCAN_FEEDS')) scanFeed.start();
      if (futures && on('FUTURES')) futures.start();
      if (on('PLAYBOOK')) playbook.start();
    }).catch((e) => log.warn?.(`${key} readers failed to start`, e.message));
    assets.set(key, st);
    return st;
  }

  async function start(series) {
    if (bots.has(series) || starting.has(series)) return;
    starting.add(series);
    try {
      const mk = marketOf(series, discovery.list()), st = assetStack(mk.asset);
      const b = createBot({
        kalshi, coinbase, prices, market: mk, dataFile: join(dataDir, marketDir(series), 'shot-caller.json'), canNotify,
        vapidFrom: () => home.bot.vapidKeys(), log, env, tuned: () => tuned(series), // the tune-up's proven settings (tuneup.js)
        onObserve: (o) => {
          for (const [name, f] of [['round scan', () => st.scanFeed.observe(o)], ['market watch', () => st.marketWatch.observe(o)], ['micro model', () => st.microFeed.observe(o)],
            ['indicator tuning', () => st.tuneFeed.observe(o)], ['flip check', () => st.flipFeed?.observe(o)], ['volatility tuning', () => st.volTuneFeed.observe()], ['money flows', () => st.flowsFeed?.observe(o)], ['council', () => council?.observe(series, o.snap, mk.settle)], ['strength meter', () => strength?.observe(series, o.snap)], ['market book', () => book?.observe(series, o)], ['bot team', () => team()?.observe(series)], ['break lab', () => { const now = clock(); breakLab?.observe(series, o.snap, { kind: mk.kind, tape: st.scanFeed.tape?.(now - 600000), liqs: st.scanFeed.liqs ? liqSummary(st.scanFeed.liqs(), now) : null }); }], ['reversal watch', () => st.playbook.observe(o)], ['related markets', () => crossFeed?.observe(mk.asset, o)]]) {
            try { f(); } catch (e) { log.error?.(`${series} ${name} step failed`, e.message); }
          }
        },
        liveSpot: () => st.scanFeed.spot(),
        // every proven nudge, related markets included, argues its case to the council (council.js) before it reaches a call
        shifts: () => { const v = [['scan', st.scanFeed.shifts()], ['micro', st.microFeed?.shifts()], ['tune', st.tuneFeed.shifts()], ['playbook', st.playbook.shifts()], ['cross', crossFeed?.shifts(mk.asset)], ['flip', st.flipFeed?.shifts()], ['flows', st.flowsFeed?.shifts()]];
          return council ? council.decide(series, v) : mergeShifts(...v.map((x) => x[1])); },
        shiftInfo: () => ({ scan: !!st.scanFeed.shifts(), micro: !!st.microFeed?.shifts(), tune: (st.tuneFeed.api().report?.families || []).filter((f) => f.proven).map((f) => f.setting), volTune: st.volTuneFeed.live(), cross: !!crossFeed?.shifts(mk.asset), flip: !!st.flipFeed?.shifts(), flows: !!st.flowsFeed?.shifts() }),
        watch: () => st.marketWatch.status(),
        flipCheck: () => st.flipFeed?.check() ?? null,
        flipGate: () => (mk.freq === '15m' ? st.tuneFeed.api().report?.flipStudy ?? null : null), // learned from 15-minute rounds: only for them
        lessonCtx: () => ({ scan: st.scanFeed.lastScan(), flip: st.flipFeed?.api().live ?? null }),
        volTune: () => st.volTuneFeed.live(),
        onCall: (e, o) => discord.call(e, o),
        onSettle: (e, stats) => discord.result(e, stats),
        onTick: (o) => st.discordAlerts.tick(o),
        onRound: (r) => { st.discordAlerts.settled(r); council?.settle(series, r.ticker, r.result); breakLab?.settle(series, r.ticker, r.result); strength?.settle(series, r.ticker, r.result); },
        onPick: (e, o) => discord.pick(e, o),
      });
      await b.load();
      await st.ready;
      bots.set(series, b);
      if (on('LEARN')) b.startLearning(); else b.start();
      log.log?.(`market ${series} (${mk.name}, ${mk.freq}) is running`);
    } catch (e) { log.warn?.(`market ${series} failed to start`, e.message); } finally { starting.delete(series); }
  }

  // every minute: refresh discovery, start the next market Kalshi has open that has no bot yet
  let timer = null;
  async function step() {
    try { await discovery.refresh(); } catch { /* next time */ }
    const next = discovery.running().find((s) => !bots.has(s) && !starting.has(s));
    if (next) await start(next);
  }
  return {
    begin() { if (!timer) { step(); timer = setInterval(step, 60000); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; for (const [s, b] of bots) if (s !== HOME.series) b.stop(); },
    start, step,
    // the bot for a market (Bitcoin's when it isn't running), and an asset's readers
    bot: (series) => bots.get(series) ?? home.bot,
    has: (series) => bots.has(series),
    stack: (series) => assets.get(marketOf(series, discovery.list()).asset) ?? home,
    bots: () => [...bots.entries()],
  };
}
