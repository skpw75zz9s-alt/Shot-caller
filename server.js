// Zero-dependency server: serves the PWA, proxies the public Kalshi and Coinbase market-data
// APIs so the phone browser never hits CORS limits, runs the push bot, and enforces the paywall.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createBot } from './bot.js';
import { createAccess } from './access.js';
import { createAskAI } from './askai.js';
import { createTuneUp } from './tuneup.js';
import { createCouncil } from './council.js';
import { createBreakLab } from './breaklab.js';
import { createStrength } from './strength.js';
import { createAutoTrade } from './autotrade.js';
import { createScanFeed } from './scanfeed.js';
import { createFeeBook } from './feebook.js';
import { createMarketWatch } from './marketwatch.js';
import { createFutures } from './futures.js';
import { createMicroFeed } from './microfeed.js';
import { createFlowsFeed } from './flowsfeed.js';
import { liqSummary, positioning } from './public/xray.js';
import { createPlaybook } from './playbookfeed.js';
import { createTuneFeed } from './tunefeed.js';
import { createFlipFeed } from './flipfeed.js';
import { createVolTuneFeed } from './voltunefeed.js';
import { appUrl, createDiscord } from './discord.js';
import { createAlertWatcher } from './discordalerts.js';
import { discordInvite, publicRecord } from './website.js';
import { ASSETS, HOME, isHome, marketOf } from './public/markets.js';
import { createDiscovery } from './discovery.js';
import { createPrices } from './prices.js';
import { createStacks } from './stacks.js';
import { createCrossFeed } from './crossfeed.js';
import { createDiscordRoles } from './discordroles.js';

const PORT = Number(process.env.PORT || 8080);
const KALSHI = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';
// Kalshi's demo exchange (fake money): the auto-trader's Demo mode sends real orders here to prove them end to end
const KALSHI_DEMO = process.env.KALSHI_DEMO_API || 'https://demo-api.kalshi.co/trade-api/v2';
const COINBASE = process.env.COINBASE_API || 'https://api.exchange.coinbase.com';
const PAYWALL = process.env.PAYWALL !== 'off';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
// Where the server keeps its data (members, push subscriptions, what it learned, the bot record). A Railway volume is
// picked up on its own (Railway sets RAILWAY_VOLUME_MOUNT_PATH when one is attached); DATA_DIR overrides it.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data');
// On Railway without a volume, every deploy starts from an empty disk
const STORAGE = { dir: DATA_DIR, persistent: !process.env.RAILWAY_PROJECT_ID || !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) };

export const access = createAccess({
  file: join(DATA_DIR, 'access.json'),
  // Ping admins' phones when a buyer says they've paid, so the payment can be checked in Cash App
  onPaid: (m, cfg) => bot.notifyWhere((d) => access.isAdminToken(d.token), {
    tag: `pay-${m.code}`, title: `💵 Payment to verify: ${m.code}`,
    body: `Someone says they sent $${cfg.price} to $${cfg.cashtag} with note ${m.code}. Check Cash App, then approve it in Settings → Admin.`,
  }),
});
// Paying members get their Discord role (discordroles.js; DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
// DISCORD_GUILD_ID and DISCORD_ROLE_ID in Railway's Variables turn it on)
export const askAI = createAskAI(); // Ask the bot's AI deep dive (askai.js): on once ANTHROPIC_API_KEY is set
// the tune-up (tuneup.js): an on-demand accuracy check; the round calls use the blend and calibration it has proven
export const tuneUp = createTuneUp({ file: join(DATA_DIR, 'tuneup.json') });
// the council (council.js, public/council.js): every proven nudge argues its case before it reaches a call
export const council = createCouncil({ file: join(DATA_DIR, 'council.json') });
// the break lab (breaklab.js, public/breakproof.js): every X-ray break, graded against what happened next
export const breakLab = createBreakLab({ file: join(DATA_DIR, 'breaks.json') });
// the strength meter (strength.js, public/strength.js): the bot's odds graded every second, round by round
export const strength = createStrength({ file: join(DATA_DIR, 'strength.json') });
export const discordRoles = createDiscordRoles({ file: join(DATA_DIR, 'discord-roles.json'), base: appUrl(), isActive: (code) => access.isActive(code) });
// The Auto-trader runs here, around the clock (autotrade.js). KEY_SECRET (a Railway variable, never stored) encrypts
// the Kalshi keys it holds.
export let autotrade = null; // made below, once validateOrder exists
export let crossFeed = null; // made below, with the price layer (the home bot's hooks read it once it exists)
// The Round scan runs here too, streaming the five exchanges and grading itself every round (scanfeed.js)
// BTC futures as a leading signal (futures.js): extra Round scan inputs and Market watch events
export const futures = createFutures();
// Discord auto-posts of the official calls and their results (discord.js; set DISCORD_WEBHOOK_URL to turn on), and the
// market alerts (discordalerts.js: DISCORD_ALERTS picks which, DISCORD_ALERTS_WEBHOOK_URL gives them their own channel)
export const discord = createDiscord();
export const discordAlerts = createAlertWatcher({ post: (embed) => discord.alert(embed) });
export const scanFeed = createScanFeed({ file: join(DATA_DIR, 'scan.json'), futures, onTrade: (x, now) => discordAlerts.whale(x, now), onLiq: (x, now) => discordAlerts.liquidation(x, now) });
// Real Kalshi fees measured from fills (feebook.js): the phones' account fills and the Auto-trader's orders
export const feeBook = createFeeBook({ file: join(DATA_DIR, 'fees.json') });
// Market watch: the bot's sharp eye on every detail, every second (marketwatch.js, public/watch.js)
// The playbook check: its 15-minute sweep strategy backtested and paper-traded, and the market-structure read (playbookfeed.js)
export const playbook = createPlaybook({ coinbase: COINBASE, file: join(DATA_DIR, 'bars.json') });
playbook.setOi(() => { const c = futures.context(); return c?.live ? c : null; }); // the reversal checklist's open-interest point
playbook.setFlow(() => scanFeed.imbalance(Date.now() - 900000)); // the guide's CVD: buyers vs sellers over 15 minutes
export const marketWatch = createMarketWatch({ kalshi: KALSHI, scanFeed, futures, playbook });
// The micro model: how the market's small details move BTC over the next 1-5 minutes (microfeed.js, public/micro.js)
// Indicator tuning: which indicator settings have actually predicted the rounds (tunefeed.js, public/tune.js)
export const tuneFeed = createTuneFeed({ playbook });
// Volatility tuning: which volatility settings (and how fat the tails) have described BTC's moves best, walk-forward
// (voltunefeed.js, public/voltune.js). Once proven, the bot's odds use them
export const volTuneFeed = createVolTuneFeed({ playbook });
// The flip check: how often the side that's ahead loses, from the chart's history and the buyers and sellers (flipfeed.js)
export const flipFeed = createFlipFeed({ playbook, scanFeed });
export const microFeed = createMicroFeed({ file: join(DATA_DIR, 'micro.json'), scanFeed, futures, marketWatch, playbook });
// money flows: spot-ETF flows, stablecoin supply and whale transfers, on probation until proven (flowsfeed.js)
export const flowsFeed = createFlowsFeed({ asset: ASSETS.find((a) => a.key === 'BTC'), file: join(DATA_DIR, 'flows.json'), prices: { candleRows: (...a) => prices.candleRows(...a) }, playbook }); // prices is made further down
export const bot = createBot({
  kalshi: KALSHI, coinbase: COINBASE, dataFile: join(DATA_DIR, 'shot-caller.json'), tuned: () => tuneUp.get(HOME.series),
  canNotify: (d) => !PAYWALL || access.hasAccess(d.token),
  onObserve: (o) => {
    try { scanFeed.observe(o); } catch (e) { console.error('round scan step failed', e.message); }
    try { marketWatch.observe(o); } catch (e) { console.error('market watch step failed', e.message); }
    try { microFeed.observe(o); } catch (e) { console.error('micro model step failed', e.message); }
    try { tuneFeed.observe(o); } catch (e) { console.error('indicator tuning step failed', e.message); }
    try { flipFeed.observe(o); } catch (e) { console.error('flip check step failed', e.message); }
    try { flowsFeed.observe(o); } catch (e) { console.error('money flows step failed', e.message); }
    try { council.observe(HOME.series, o.snap, HOME.settle); } catch (e) { console.error('council step failed', e.message); }
    try { strength.observe(HOME.series, o.snap); } catch (e) { console.error('strength meter step failed', e.message); }
    try { const now = Date.now(); breakLab.observe(HOME.series, o.snap, { kind: HOME.kind, tape: scanFeed.tape(now - 600000), liqs: liqSummary(scanFeed.liqs(), now) }); } catch (e) { console.error('break lab step failed', e.message); }
    try { volTuneFeed.observe(); } catch (e) { console.error('volatility tuning step failed', e.message); }
    try { playbook.observe(o); } catch (e) { console.error('reversal watch step failed', e.message); }
    try { crossFeed?.observe('BTC', o); } catch (e) { console.error('related markets step failed', e.message); }
    autotrade?.step(o);
  },
  keepAlive: () => (autotrade?.running() ?? 0) > 0,
  liveSpot: () => scanFeed.spot(),
  // every proven nudge argues its case to the council, which vetoes the invalid ones and nets the rest (council.js)
  shifts: () => council.decide(HOME.series, [['scan', scanFeed.shifts()], ['micro', microFeed?.shifts()], ['tune', tuneFeed.shifts()], ['playbook', playbook.shifts()], ['cross', crossFeed?.shifts('BTC')], ['flip', flipFeed.shifts()], ['flows', flowsFeed.shifts()]]),
  shiftInfo: () => ({ scan: !!scanFeed.shifts(), micro: !!microFeed?.shifts(), tune: (tuneFeed.api().report?.families || []).filter((f) => f.proven).map((f) => f.setting), reversal: Object.entries(playbook.api().report?.reversal?.bands || {}).filter(([k, s]) => k !== 'insufficient' && s.n >= 100 && s.z15 >= 2.5).map(([k]) => k), guide: !!playbook.api().report?.guide?.proven, predictor: !!playbook.api().report?.predictor?.proven, volTune: volTuneFeed.live(), cross: !!crossFeed?.shifts('BTC'), flip: !!flipFeed.shifts(), flows: !!flowsFeed.shifts() }),
  watch: () => marketWatch.status(),
  flipCheck: () => flipFeed.check(),
  flipGate: () => tuneFeed.api().report?.flipStudy ?? null, // the flip study's rule, applied once proven (public/flipstudy.js)
  lessonCtx: () => ({ scan: scanFeed.lastScan(), flip: flipFeed.api().live }), // the loss lab's context: buyers vs sellers, the flip check
  volTune: () => volTuneFeed.live(),
  onCall: (e, o) => discord.call(e, o),
  onSettle: (e, stats) => discord.result(e, stats),
  onTick: (o) => discordAlerts.tick(o),
  onRound: (r) => { discordAlerts.settled(r); council.settle(HOME.series, r.ticker, r.result); breakLab.settle(HOME.series, r.ticker, r.result); strength.settle(HOME.series, r.ticker, r.result); },
  onPick: (e, o) => discord.pick(e, o),
});
setInterval(() => access.prune(), 3600000).unref();
// Every other Kalshi market (v13.30): discovered live, each with its own copy of the bot and its asset's readers
// (discovery.js, stacks.js, prices.js). MARKETS=off: Bitcoin's 15-minute market only.
const fetchJSONs = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`${u.split('?')[0]}: HTTP ${r.status}`); return r.json(); };
export const prices = createPrices({ coinbase: COINBASE, yahoo: process.env.YAHOO_API || undefined, fetchJSON: fetchJSONs });
// Related markets (crossfeed.js): every asset's 1-minute closes, how each market moves with the others, and a model per
// market that nudges its calls once proven. CROSS=off turns it off.
crossFeed = createCrossFeed({ prices });
export const discovery = createDiscovery({ kalshi: KALSHI, fetchJSON: fetchJSONs });
export const stacks = createStacks({ home: { bot, scanFeed, futures, playbook, marketWatch, microFeed, tuneFeed, volTuneFeed, discordAlerts, flipFeed, flowsFeed }, dataDir: DATA_DIR, kalshi: KALSHI, coinbase: COINBASE, prices, discovery, discord, crossFeed, council, breakLab, strength, tuned: (s) => tuneUp.get(s),
  canNotify: (d) => !PAYWALL || access.hasAccess(d.token) });

// Only read-only market-data endpoints are reachable through the proxy.
const KALSHI_PUBLIC = /^(markets(\/[A-Za-z0-9._-]+(\/orderbook)?)?|events\/[A-Za-z0-9._-]+|series\/[A-Za-z0-9._-]+)$/;
const ROUTES = [
  { prefix: '/api/kalshi/', upstream: KALSHI, allow: KALSHI_PUBLIC },
  { prefix: '/api/kalshi-demo/', upstream: KALSHI_DEMO, allow: KALSHI_PUBLIC },
  { prefix: '/api/coinbase/', upstream: COINBASE, allow: new RegExp(`^products/(${ASSETS.filter((a) => a.product).map((a) => a.product).join('|')})/(ticker|candles)$`) }, // every coin (public/markets.js)
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
// Files anyone can load: the paywall page and what it (and "Add to Home Screen") needs.
const OPEN_FILES = new Set(['/site.html', '/site.js', '/robots.txt', '/paywall.html', '/paywall.js', '/styles.css', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/sw.js']);

const cache = new Map(); // tiny ~1s cache so several open phones don't multiply upstream calls
const lastGood = new Map(); // the last OK answer per upstream URL, for a brief upstream hiccup

// Compression: brotli or gzip when the phone accepts it (cuts the app's first download ~70%).
// Compressed copies are kept on the cached entry so each body is compressed once.
const encodingFor = (req) => { const a = req.headers['accept-encoding'] || ''; return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null; };
function compressed(entry, enc) {
  if (!enc || entry.raw.length < 1024) return null;
  return (entry[enc] ||= enc === 'br'
    ? brotliCompressSync(entry.raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } })
    : gzipSync(entry.raw, { level: 6 }));
}
function sendEntry(req, res, status, entry, type, extra = {}) {
  const enc = /^(text|application\/(json|manifest)|image\/svg)/.test(type) ? encodingFor(req) : null; // PNGs are already compressed
  const body = compressed(entry, enc);
  res.writeHead(status, { 'content-type': type, vary: 'accept-encoding', ...(body ? { 'content-encoding': enc } : {}), 'content-length': (body || entry.raw).length, ...extra });
  res.end(body || entry.raw);
}

async function proxy(route, url, req, res) {
  const path = url.pathname.slice(route.prefix.length);
  if (!route.allow.test(path)) return send(res, 404, { error: 'not allowed' });
  const target = `${route.upstream}/${path}${url.search}`;
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < 900) return sendEntry(req, res, hit.status, hit, 'application/json', { 'cache-control': 'no-store' });
  try {
    const r = await fetch(target, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
    const entry = { at: Date.now(), status: r.status, raw: Buffer.from(await r.text()) };
    // a rate limit or an upstream error for a moment: the last good answer from the last 8 seconds instead (v13.36),
    // so one hiccup at Kalshi or Coinbase doesn't reach every phone as lost data
    const good = lastGood.get(target);
    if ((r.status === 429 || r.status >= 500) && good && Date.now() - good.at < 8000) return sendEntry(req, res, 200, good, 'application/json', { 'cache-control': 'no-store' });
    cache.set(target, entry);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    if (r.ok) { lastGood.set(target, entry); if (lastGood.size > 200) lastGood.delete(lastGood.keys().next().value); }
    // Kalshi or Coinbase refusing us (401/403) is their problem, not the phone's sign-in: it goes out as a 502
    if (r.status === 401 || r.status === 403) return send(res, 502, { error: `upstream refused (${r.status})` });
    sendEntry(req, res, r.status, entry, 'application/json', { 'cache-control': 'no-store' });
  } catch (e) {
    const good = lastGood.get(target);
    if (good && Date.now() - good.at < 8000) return sendEntry(req, res, 200, good, 'application/json', { 'cache-control': 'no-store' });
    send(res, 502, { error: `upstream failed: ${e.message}` });
  }
}

// /api/kalshi-auth/* — a linked Kalshi account. The phone signs each request with its Kalshi API key (the key
// never reaches this server); we only forward the signature headers. GETs: portfolio reads only, never cached.
// POST orders: the auto-trader's orders, each checked by validateOrder first. `x-kalshi-env: demo` sends the request
// to Kalshi's demo exchange instead (fake money). Nothing can cancel orders or touch anything else.
const AUTH_READS = new Set(['fills', 'positions', 'balance', 'settlements']);
const AUTH_QUERY = new Set(['ticker', 'event_ticker', 'min_ts', 'max_ts', 'limit', 'cursor', 'status', 'count_filter', 'settlement_status']);
const ORDER_SERIES = (process.env.AUTO_SERIES || 'KXBTC15M').split(',').filter(Boolean);
const ORDER_MAX_USD = Number(process.env.AUTO_MAX_ORDER_USD || 100);
const ORDER_KEYS = new Set(['ticker', 'client_order_id', 'side', 'count', 'price', 'time_in_force', 'reduce_only', 'self_trade_prevention_type', 'post_only']);

// Every order is checked here before it reaches Kalshi (V2 shape: one YES book, bid/ask, dollar strings): only the
// BTC 15-minute series, only fill-now-or-cancel (nothing ever rests on Kalshi holding cash), whole contracts at
// whole cents, a hard dollar cap on anything that opens a position, no extra fields. Returns the problem, or null.
// allowMaker (the server's own Auto-trader only): also a resting buy, if it's post-only (it can only ever add to the book,
// never take) and opens a position (no resting sells); the Auto-trader cancels it within its maker window.
export function validateOrder(o, { series = ORDER_SERIES, maxUsd = ORDER_MAX_USD, allowMaker = false } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'order must be an object';
  for (const k of Object.keys(o)) if (!ORDER_KEYS.has(k)) return `field not allowed: ${k}`;
  if (typeof o.ticker !== 'string' || !/^[A-Z0-9]+-[A-Z0-9-]{1,60}$/.test(o.ticker) || !series.some((s) => o.ticker.startsWith(`${s}-`))) return 'only the BTC 15-minute markets can be traded';
  if (typeof o.client_order_id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(o.client_order_id)) return 'client_order_id required';
  if (!['bid', 'ask'].includes(o.side)) return 'side must be bid or ask';
  const maker = allowMaker && o.time_in_force === 'good_till_canceled' && o.post_only === true && o.reduce_only === false;
  if (o.time_in_force !== 'immediate_or_cancel' && !maker) return 'only fill-now-or-cancel orders (nothing left resting)';
  if (o.post_only !== undefined && !(o.post_only === true && maker)) return 'post_only only on a resting maker buy';
  if (typeof o.count !== 'string' || !/^\d{1,4}\.00$/.test(o.count) || Number(o.count) < 1 || Number(o.count) > 1000) return 'count must be "1.00"-"1000.00" contracts';
  if (typeof o.price !== 'string' || !/^0\.\d\d00$/.test(o.price) || Number(o.price) < 0.01 || Number(o.price) > 0.99) return 'price must be whole cents, "0.0100"-"0.9900"';
  if (typeof o.reduce_only !== 'boolean') return 'reduce_only must be true or false';
  if (o.self_trade_prevention_type !== undefined && o.self_trade_prevention_type !== 'taker_at_cross') return 'unsupported self_trade_prevention_type';
  // Opening a position costs price per contract on a bid (YES) and 1 - price on an ask (NO)
  const cost = Number(o.count) * (o.side === 'bid' ? Number(o.price) : 1 - Number(o.price));
  if (!o.reduce_only && cost > maxUsd + 1e-9) return `order over the $${maxUsd} cap`;
  return null;
}

const orderHits = new Map(); // per phone address: at most 30 orders a minute reach Kalshi
export const kalshiAuthFor = (base, demoBase = KALSHI_DEMO) => async function kalshiAuth(req, res, endpoint, url) {
  if (endpoint === 'info') return send(res, 200, { pathPrefix: `${new URL(base).pathname.replace(/\/$/, '')}/portfolio/`, orderPath: 'events/orders' });
  const isOrder = endpoint === 'orders' && req.method === 'POST';
  if (req.method !== 'GET' && !isOrder) return send(res, 405, { error: 'method not allowed' });
  if (!isOrder && !AUTH_READS.has(endpoint)) return send(res, 404, { error: 'not allowed' });
  const key = req.headers['x-kalshi-key'], ts = req.headers['x-kalshi-ts'], sig = req.headers['x-kalshi-sig'];
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key || '') || !/^\d{12,14}$/.test(ts || '') || !/^[A-Za-z0-9+/=]{40,1024}$/.test(sig || '')) {
    return send(res, 400, { error: 'missing or malformed Kalshi signature' });
  }
  const upstream = req.headers['x-kalshi-env'] === 'demo' ? demoBase : base;
  let body;
  if (isOrder) {
    const ip = clientIp(req), now = Date.now();
    const hits = (orderHits.get(ip) || []).filter((t) => t > now - 60000);
    if (hits.length >= 30) return send(res, 429, { error: 'too many orders: wait a minute' });
    hits.push(now); orderHits.set(ip, hits);
    if (orderHits.size > 5000) orderHits.delete(orderHits.keys().next().value);
    body = await readBody(req);
    const bad = validateOrder(body);
    if (bad) return send(res, 422, { error: { code: 'refused_by_shot_caller', message: `order refused: ${bad}` } });
  }
  const q = new URLSearchParams();
  if (!isOrder) for (const [k, v] of url.searchParams) if (AUTH_QUERY.has(k) && v.length <= 200) q.append(k, v);
  try {
    const r = await fetch(`${upstream}/portfolio/${isOrder ? 'events/orders' : endpoint}${q.size ? `?${q}` : ''}`, { // V2 order path
      method: isOrder ? 'POST' : 'GET',
      headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0', 'KALSHI-ACCESS-KEY': key, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig, ...(isOrder ? { 'content-type': 'application/json' } : {}) },
      body: isOrder ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    // Kalshi's 401 (bad key) goes out as 403 so the app doesn't mistake it for the paywall's 401
    sendEntry(req, res, r.status === 401 ? 403 : r.status, { raw: Buffer.from(await r.text()) }, 'application/json', { 'cache-control': 'no-store, private' });
  } catch (e) {
    // a timeout on an order: it may have gone through. The phone retries with the same client_order_id and checks
    send(res, 504, { error: `Kalshi didn't answer: ${e.message}` });
  }
};
const kalshiAuth = kalshiAuthFor(KALSHI);
autotrade = createAutoTrade({ file: join(DATA_DIR, 'autotrade.json'), secret: process.env.KEY_SECRET, kalshi: KALSHI, kalshiDemo: KALSHI_DEMO, validateOrder: (o) => validateOrder(o, { allowMaker: true }), onFee: (x) => feeBook.add([x]) });
const ready = Promise.all([tuneUp.load(), council.load(), breakLab.load(), strength.load(), flowsFeed.load(), bot.load(), access.load(), discordRoles.load(), autotrade.load(), scanFeed.load(), feeBook.load(), microFeed.load(), playbook.load()]);

// /api/auto/*: the phone's controls for its owner's server-side Auto-trader
const ownerOf = (token) => { const c = access.check(token); return c.role === 'admin' && c.access ? 'admin' : c.member?.code && c.access ? c.member.code : PAYWALL ? null : 'local'; };
async function autoApi(req, res, action, token) {
  const owner = ownerOf(token);
  if (!owner) return send(res, 401, { error: 'sign in first', paywall: true }, 'application/json', PAYWALL_HDR);
  if (action === 'state' && req.method === 'GET') return send(res, 200, autotrade.state(owner));
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const out = action === 'key' ? await autotrade.setKey(owner, body)
    : action === 'key-delete' ? await autotrade.deleteKey(owner, body)
    : action === 'config' ? await autotrade.configure(owner, body)
    : await autotrade.control(owner, action);
  if (action === 'config' || action === 'key') bot.start(); // make sure the loop is running
  send(res, out.status, out.body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

// the phone sends you to sign in only on a 401 that carries this (v13.42.1): an upstream's own 401 never does
const PAYWALL_HDR = { 'x-paywall': '1' };
// a market the server may start a bot for: one Kalshi lists (discovery.js), never any name a request makes up (v13.43.2)
const listedSeries = (s) => typeof s === 'string' && /^[A-Z0-9]+$/.test(s) && discovery.list().some((m) => m.series === s);
// the answers that belong to one market's own bot and readers (asked with ?m=SERIES)
const MARKET_OWN = /^\/api\/(record|pick|lessons|scan|watch|micro|playbook|tune|flip|voltune|flows|xray|learn|index)$/;
function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const cookieToken = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === 'sc_session')?.[1] || null;
// The platform proxy (Railway) appends the real client address as the LAST X-Forwarded-For entry;
// earlier entries are whatever the client sent, so trusting them would let anyone dodge rate limits.
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '?';
function sessionCookie(req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return { 'set-cookie': `sc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` };
}
function reply(req, res, out) {
  send(res, out.status, out.body, 'application/json', out.token ? sessionCookie(req, out.token) : {});
}

// /api/access/* — paywall actions anyone can call
async function accessApi(req, res, action, token) {
  if (action === 'status' && req.method === 'GET') return send(res, 200, { ...access.statusBody(token), open: !PAYWALL }); // open: no paywall on this server
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const ip = clientIp(req);
  const actions = {
    request: () => access.request(token, ip, body.code, body.device),
    paid: () => access.paid(token),
    redeem: () => access.redeem(body.code, ip, body.device),
    restore: () => access.restore(body.pass, ip, body.device),
    admin: () => access.admin(body.code, ip, body.device),
    logout: () => access.logout(token),
  };
  if (!actions[action]) return send(res, 404, { error: 'not found' });
  reply(req, res, actions[action]());
}

// /api/admin/* — admin only
async function adminApi(req, res, action, token) {
  if (!access.isAdminToken(token)) return send(res, 403, { error: 'admin only' });
  // the tune-up: GET its last report and the settings in use; POST runs it now on every running market (a few seconds)
  if (action === 'tuneup') {
    if (req.method === 'GET') return send(res, 200, tuneUp.status());
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const markets = stacks.bots().map(([series, b]) => ({ series, name: marketOf(series, discovery.list()).name, bot: b, stack: stacks.stack(series) }));
    return send(res, 200, { ...(await tuneUp.run(markets)), settings: tuneUp.status().settings });
  }
  if (action === 'members' && req.method === 'GET') { const out = access.listMembers(), dv = discordRoles.adminView(); out.body.members = out.body.members.map((m) => (dv[m.code] ? { ...m, discord: dv[m.code] } : m)); out.body.discord = discordRoles.config().on; return reply(req, res, out); }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const actions = { approve: access.approve, deny: access.deny, revoke: access.revoke, config: access.setConfig };
  if (!actions[action]) return send(res, 404, { error: 'not found' });
  const out = actions[action](body);
  if (out.status === 200 && body?.code) await discordRoles.syncOne(out.body?.member?.code ?? body.code).catch(() => {}); // the Discord role follows right away
  reply(req, res, out);
}

// /api/discord/* — link a member's Discord account so they get the members' role (discordroles.js). The callback is
// where Discord sends them back (its one-time state names the member); the rest need a member session.
async function discordApi(req, res, action, token, url) {
  if (action === 'callback' && req.method === 'GET') {
    const out = await discordRoles.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') }).catch(() => ({ error: 'Discord linking failed. Try again.' }));
    const q = out.ok ? `discord=linked${out.error ? `&msg=${encodeURIComponent(out.error)}` : ''}` : `discord=error&msg=${encodeURIComponent(url.searchParams.get('error') === 'access_denied' ? 'You cancelled on Discord.' : out.error)}`;
    return send(res, 302, '', 'text/plain', { location: `/?${q}` });
  }
  const code = access.check(token).member?.code ?? null;
  if (action === 'status' && req.method === 'GET') { const st = discordRoles.status(code); if (!access.isAdminToken(token)) delete st.missing; return send(res, 200, { ...st, member: !!code }); } // which variables are missing: admins only
  if (!code) return send(res, 400, { error: 'Discord roles are for members: sign in with your code first' });
  if (action === 'link' && req.method === 'POST') { const link = discordRoles.linkUrl(code); return link ? send(res, 200, { url: link }) : send(res, 503, { error: 'Discord linking isn\'t set up on this server yet' }); }
  if (action === 'unlink' && req.method === 'POST') return send(res, 200, await discordRoles.unlink(code));
  send(res, 404, { error: 'not found' });
}

// POST /api/push/{sync,test,unsubscribe,report}
async function pushApi(req, res, action, token) {
  if (!['sync', 'test', 'unsubscribe', 'report'].includes(action)) return send(res, 404, { error: 'not found' });
  const body = await readBody(req), endpoint = body?.subscription?.endpoint ?? body?.endpoint;
  // each phone lives in its market's bot (v13.30); a market that isn't running yet starts now, Bitcoin's covers it meanwhile
  if (action === 'sync') {
    const series = typeof body?.settings?.series === 'string' ? body.settings.series : HOME.series;
    if (!stacks.has(series) && listedSeries(series)) stacks.start(series); // only markets Kalshi lists (discovery), never a made-up name
    const target = stacks.bot(series);
    for (const [, b] of stacks.bots()) if (b !== target && endpoint && b.devices.has(endpoint)) b.unsubscribe({ endpoint });
    const out = await target.sync(body, { token });
    return send(res, out.status, out.body);
  }
  if (action === 'unsubscribe') { let out = null; for (const [, b] of stacks.bots()) { const r = await b.unsubscribe(body, { token }); if (!out || b.devices.has?.(endpoint)) out = r; } return send(res, out.status, out.body); }
  const owner = stacks.bots().map(([, b]) => b).find((b) => endpoint && b.devices.has(endpoint)) ?? bot;
  const out = await owner[action](body, { token });
  send(res, out.status, out.body);
}

const files = new Map(); // rel -> { mtime, raw, br?, gzip? }, refreshed when the file changes on disk
// The official website (public/site.html, website.js): %BASE% becomes the app's public address, so link previews
// (Discord, iMessage, X) get absolute links and the icon
async function serveSite(req, res) {
  try {
    const path = join(PUBLIC, '/site.html'), { mtimeMs } = await stat(path), key = '/site.html#base';
    let entry = files.get(key);
    if (!entry || entry.mtime !== mtimeMs) files.set(key, (entry = { mtime: mtimeMs, raw: Buffer.from((await readFile(path, 'utf8')).replaceAll('%BASE%', appUrl() ?? '')) }));
    sendEntry(req, res, 200, entry, TYPES['.html'], { 'cache-control': 'no-cache' });
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}
async function serveFile(req, res, rel) {
  try {
    const path = join(PUBLIC, rel), { mtimeMs } = await stat(path);
    let entry = files.get(rel);
    if (!entry || entry.mtime !== mtimeMs) files.set(rel, (entry = { mtime: mtimeMs, raw: await readFile(path) }));
    sendEntry(req, res, 200, entry, TYPES[extname(rel)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

export const server = http.createServer(async (req, res) => {
  try {
    await ready;
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const token = cookieToken(req);
    if (path === '/healthz') return send(res, 200, { ok: true, storage: { persistent: STORAGE.persistent }, discord: discord.status().on, ...(discord.status().on ? { discordBranded: discord.status().branded, discordAlerts: discord.status().alerts === 'off' ? [] : discordAlerts.kinds(), discordAlertsTo: discord.status().alerts } : {}), ...(discord.status().why ? { discordWhy: discord.status().why } : {}), bot: bot.status(), autotrade: { canHoldKeys: autotrade.canHoldKeys(), running: autotrade.running() }, futures: futures.status() });

    // the official website and its public numbers, for everyone
    if (req.method === 'GET' && (path === '/site' || path === '/site.html')) return serveSite(req, res);
    if (path === '/api/public/record' && req.method === 'GET') return send(res, 200, publicRecord(bot.record()));
    if (path === '/api/public/info' && req.method === 'GET') return send(res, 200, { app: 'Shot Caller', discord: discordInvite() });

    const acc = path.match(/^\/api\/access\/(\w+)$/);
    if (acc) return await accessApi(req, res, acc[1], token);
    const adm = path.match(/^\/api\/admin\/(\w+)$/);
    if (adm) return await adminApi(req, res, adm[1], token);
    const dsc = path.match(/^\/api\/discord\/(\w+)$/);
    if (dsc) return await discordApi(req, res, dsc[1], token, url);

    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const allowed = !PAYWALL || access.hasAccess(token);
    if (!allowed) {
      if (OPEN_FILES.has(rel) && req.method === 'GET') return serveFile(req, res, rel);
      if (rel === '/index.html') return serveSite(req, res); // the app's address shows the official website; it links to sign in
      return send(res, 401, { error: 'payment required', paywall: true }, 'application/json', PAYWALL_HDR);
    }

    const push = path.match(/^\/api\/push\/(\w+)$/);
    if (push && req.method === 'POST') return await pushApi(req, res, push[1], token);
    const auto = path.match(/^\/api\/auto\/([\w-]+)$/);
    if (auto) return await autoApi(req, res, auto[1], token);
    const ka = path.match(/^\/api\/kalshi-auth\/(\w+)$/);
    if (ka) return await kalshiAuth(req, res, ka[1], url);
    // Ask the bot (askai.js): the phone's question and the facts it shows, answered by the AI; 501 when it's off
    if (path === '/api/ask') {
      if (req.method === 'GET') return send(res, 200, askAI.status());
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const b = await readBody(req);
      const out = await askAI.ask({ owner: ownerOf(token) ?? clientIp(req), question: b?.q, facts: b?.facts, history: b?.history });
      return send(res, out.status, out.body);
    }
    // the phone reports real fees from your Kalshi fills (numbers only: count, price, fee, taker)
    if (path === '/api/fees' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, { added: feeBook.add(b?.samples) }); }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (path === '/api/push/key') return send(res, 200, { publicKey: bot.publicKey() });
    // What the server has learned about the market (the phone prices with it too)
    // The official bot record (every call the server's bot made, graded against Kalshi's result)
    // ?m=SERIES picks the market (v13.30); without it, Bitcoin's 15-minute one
    const mq = url.searchParams.get('m');
    // a market opened on a phone before its bot is running starts now (Bitcoin's answers meanwhile)
    if (mq && !stacks.has(mq) && !isHome(mq) && listedSeries(mq)) stacks.start(mq);
    // until it is, its own answers wait: Bitcoin's record, pick and learning must never show up as another market's (v13.42.2)
    if (mq && !isHome(mq) && !stacks.has(mq) && MARKET_OWN.test(path)) return send(res, 503, { error: 'this market is starting', starting: true });
    const mb = mq ? stacks.bot(mq) : bot, ms = mq ? stacks.stack(mq) : null;
    const mScan = ms?.scanFeed ?? scanFeed, mWatch = ms?.marketWatch ?? marketWatch, mMicro = ms?.microFeed ?? microFeed, mPlay = ms?.playbook ?? playbook, mTune = ms?.tuneFeed ?? tuneFeed, mFlip = ms?.flipFeed ?? flipFeed, mVol = ms?.volTuneFeed ?? volTuneFeed;
    if (path === '/api/record') return send(res, 200, mb.record());
    // the 10-minute pick: this round's (once locked), when it locks, the last graded one and the picks' record
    if (path === '/api/pick') return send(res, 200, mb.pick());
    if (path === '/api/lessons') return send(res, 200, mb.lessons()); // the loss lab: why each loss happened and the lessons proven (public/losslab.js)
    if (path === '/api/cross') return send(res, 200, crossFeed.api(mq ? marketOf(mq, discovery.list()).asset : 'BTC'));
    if (path === '/api/drivers') return send(res, 200, crossFeed.why(mq ? marketOf(mq, discovery.list()).asset : 'BTC', Number(url.searchParams.get('w')) || 60)); // why it's moving (public/drivers.js)
    if (path === '/api/markets') return send(res, 200, { markets: discovery.list().map((m) => ({ ...m, name: marketOf(m.series, discovery.list()).name, kind: marketOf(m.series, discovery.list()).kind, running: stacks.has(m.series) })), at: discovery.at() });
    // the price of an asset without a Coinbase product (stock indexes, gold, oil: prices.js), in Coinbase's shapes
    const pr = path.match(/^\/api\/price\/([A-Z]+)\/(ticker|candles)$/), pa = pr && ASSETS.find((a) => a.key === pr[1]);
    if (pa) {
      try { return send(res, 200, pr[2] === 'ticker' ? await prices.ticker(pa) : await prices.candleRows(pa, { gran: Number(url.searchParams.get('granularity')) || 60 })); }
      catch (e) { return send(res, 502, { error: `${pa.name} price: ${e.message}` }); }
    }
    // The Round scan: live read, learned weights and the graded record
    if (path === '/api/scan') return send(res, 200, mScan.api());
    if (path === '/api/watch') return send(res, 200, mWatch.api());
    if (path === '/api/micro') return send(res, 200, mMicro.api());
    if (path === '/api/playbook') return send(res, 200, mPlay.api());
    if (path === '/api/tune') return send(res, 200, mTune.api());
    if (path === '/api/flip') return send(res, 200, mFlip.api()); // the flip check (flipfeed.js)
    if (path === '/api/voltune') return send(res, 200, mVol.api());
    if (path === '/api/xray') { // the X-ray tab's server side: forced closes, the cost of leverage, and the proof for each kind of break
      const sc = ms ? ms.scanFeed : scanFeed, fu = ms ? ms.futures : futures, now = Date.now();
      return send(res, 200, { liqs: sc?.liqs ? liqSummary(sc.liqs(), now) : null, futures: fu ? positioning(fu.context(now)) : null, proof: breakLab.api(mq || HOME.series), at: now }); // proof: each break's claim, graded (breaklab.js)
    }
    if (path === '/api/strength') return send(res, 200, strength.api(mq || HOME.series)); // is the bot getting stronger (strength.js)
    if (path === '/api/council') return send(res, 200, council.api(mq || HOME.series)); // the debate behind the calls (council.js)
    if (path === '/api/flows') { const f = ms ? ms.flowsFeed : flowsFeed; return send(res, 200, f ? f.api() : { off: 'money flows are for crypto markets' }); } // money flows (flowsfeed.js)
    if (path === '/api/learn') return send(res, 200, { learned: { ...mb.learned(), fees: feeBook.rates(), volTune: mVol.live() }, status: { ...mb.learnStatus(), fees: { ...feeBook.rates(), samples: feeBook.count() } }, market: mb.market() });
    // BTC index estimate (several exchanges, see index.js): the phone shifts its live Coinbase price by the offset
    if (path === '/api/index') { const ix = mb.index(); return send(res, 200, { ...ix, offset: ix.index && ix.coinbase ? ix.index - ix.coinbase : 0 }); }
    const route = ROUTES.find((r) => path.startsWith(r.prefix));
    if (route) return proxy(route, url, req, res);
    if (rel === '/paywall.html') return serveFile(req, res, '/index.html'); // already paid: go straight to the app
    return serveFile(req, res, rel);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Shot Caller on http://localhost:${PORT}${PAYWALL ? ' (paywall on)' : ''}`));
  // Learn the market around the clock (LEARN=off: only run while phones are subscribed)
  // SCAN_FEEDS=off: don't stream the exchanges from the server
  if (process.env.SCAN_FEEDS !== 'off') scanFeed.start();
  if (process.env.FUTURES !== 'off') futures.start(); // FUTURES=off: no futures feed
  if (process.env.PLAYBOOK !== 'off') ready.then(() => playbook.start()); // PLAYBOOK=off: no candle history or strategy check
  ready.then(() => { if (process.env.LEARN !== 'off') bot.startLearning(); else if (bot.status().devices || autotrade.running()) bot.start(); });
  if (process.env.MARKETS !== 'off') ready.then(() => stacks.begin()); // every other Kalshi market (stacks.js)
  if (process.env.CROSS !== 'off') crossFeed.start(); // related markets (crossfeed.js)
  ready.then(() => discordRoles.start()); // members' Discord role, every 10 minutes (only when it's set up)
}
