// Every Kalshi price market the bot can call (v13.30). A market is a Kalshi series ("will X be above / below / between
// these prices at a set time"); its asset is what the bot prices it from. The math (distance to the target in typical
// moves for the time left, the settlement rule, fat tails) is the same for all; the server runs a full copy of the bot
// for each market (bot.js: learning, official record, guards, 10-minute pick, Discord) and of the readers for each asset
// (Round scan, Market watch, forecasts, micro model, tuners, futures, liquidations, the exchange index) where the data
// exists: crypto has public exchange trade feeds; stock indexes, gold and oil don't, so those readers are crypto-only.
//
// Assets
//   kind      crypto (Coinbase price, 12 exchange feeds) | index | commodity (price from Yahoo's public charts; a price
//             more than a minute old is marked delayed and the bot makes no calls on it)
//   settle    avg60: Kalshi settles on the average of the last 60 seconds (CF Benchmarks' crypto indexes) | spot: on
//             the value at the time (an index's or a future's print)
//   sym       the coin's symbol on each exchange (null where it isn't listed): trades (public/feeds.js), the exchange
//             index (index.js), liquidations (public/liquidations.js), futures (Hyperliquid)
//   match     the words in a Kalshi series' ticker or title that mean this asset
export const ASSETS = [
  { key: 'BTC', name: 'Bitcoin', kind: 'crypto', settle: 'avg60', digits: 0, product: 'BTC-USD', match: /^KXBTC|bitcoin|\bbtc\b/i,
    sym: { kraken: 'BTC/USD', krakenRest: 'XBTUSD', bitstamp: 'btcusd', gemini: 'BTCUSD', binanceUs: 'btcusd', binance: 'btcusdt', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP', okxCt: 0.01, deribit: 'BTC-PERPETUAL', bitfinex: 'tBTCUSD', cryptocom: 'BTC_USD', paxos: 'BTCUSD', hyper: 'BTC' } },
  { key: 'ETH', name: 'Ethereum', kind: 'crypto', settle: 'avg60', digits: 2, product: 'ETH-USD', match: /^KXETH|ethereum|\beth\b|\bether\b/i,
    sym: { kraken: 'ETH/USD', krakenRest: 'ETHUSD', bitstamp: 'ethusd', gemini: 'ETHUSD', binanceUs: 'ethusd', binance: 'ethusdt', bybit: 'ETHUSDT', okx: 'ETH-USDT-SWAP', okxCt: 0.1, deribit: 'ETH-PERPETUAL', bitfinex: 'tETHUSD', cryptocom: 'ETH_USD', paxos: 'ETHUSD', hyper: 'ETH' } },
  { key: 'SOL', name: 'Solana', kind: 'crypto', settle: 'avg60', digits: 2, product: 'SOL-USD', match: /^KXSOL|solana|\bsol\b/i,
    sym: { kraken: 'SOL/USD', krakenRest: 'SOLUSD', bitstamp: 'solusd', gemini: 'SOLUSD', binanceUs: 'solusd', binance: 'solusdt', bybit: 'SOLUSDT', okx: 'SOL-USDT-SWAP', okxCt: 1, deribit: null, bitfinex: 'tSOLUSD', cryptocom: 'SOL_USD', paxos: null, hyper: 'SOL' } },
  { key: 'XRP', name: 'XRP', kind: 'crypto', settle: 'avg60', digits: 4, product: 'XRP-USD', match: /^KXXRP|\bxrp\b|ripple/i,
    sym: { kraken: 'XRP/USD', krakenRest: 'XRPUSD', bitstamp: 'xrpusd', gemini: 'XRPUSD', binanceUs: 'xrpusd', binance: 'xrpusdt', bybit: 'XRPUSDT', okx: 'XRP-USDT-SWAP', okxCt: 100, deribit: null, bitfinex: 'tXRPUSD', cryptocom: 'XRP_USD', paxos: null, hyper: 'XRP' } },
  { key: 'DOGE', name: 'Dogecoin', kind: 'crypto', settle: 'avg60', digits: 5, product: 'DOGE-USD', match: /^KXDOGE|dogecoin|\bdoge\b/i,
    sym: { kraken: 'DOGE/USD', krakenRest: 'XDGUSD', bitstamp: 'dogeusd', gemini: 'DOGEUSD', binanceUs: 'dogeusd', binance: 'dogeusdt', bybit: 'DOGEUSDT', okx: 'DOGE-USDT-SWAP', okxCt: 1000, deribit: null, bitfinex: 'tDOGE:USD', cryptocom: 'DOGE_USD', paxos: null, hyper: 'DOGE' } },
  { key: 'SPX', name: 'S&P 500', kind: 'index', settle: 'spot', digits: 2, yahoo: '^GSPC', match: /^KXINX|s&p ?500|\bspx\b/i,
    drivers: { macro: ['US10Y', 'DXY', 'OIL'], sector: ['NDX', 'DJI'], own: 'S&P-only moves (its own news and big orders)' } },
  { key: 'NDX', name: 'Nasdaq-100', kind: 'index', settle: 'spot', digits: 2, yahoo: '^NDX', match: /^KXNASDAQ|nasdaq/i,
    drivers: { macro: ['US10Y', 'DXY', 'OIL'], sector: ['SPX', 'DJI'], own: 'Nasdaq-only moves (tech news and big orders)' } },
  { key: 'DJI', name: 'Dow Jones', kind: 'index', settle: 'spot', digits: 2, yahoo: '^DJI', match: /^KXDOW|\bdow\b/i,
    drivers: { macro: ['US10Y', 'DXY', 'OIL'], sector: ['SPX', 'NDX'], own: 'Dow-only moves (its own news and big orders)' } },
  { key: 'GOLD', name: 'Gold', kind: 'commodity', settle: 'spot', digits: 2, yahoo: 'GC=F', match: /^KXGOLD|\bgold\b/i,
    drivers: { macro: ['DXY', 'US10Y', 'SPX', 'OIL'], sector: ['SILVER', 'PLAT', 'COPPER'], own: 'Gold-only moves (gold buying and selling, its own news)' } },
  { key: 'SILVER', name: 'Silver', kind: 'commodity', settle: 'spot', digits: 3, yahoo: 'SI=F', match: /^KXSILVER|\bsilver\b/i,
    drivers: { macro: ['DXY', 'US10Y', 'SPX', 'OIL'], sector: ['GOLD', 'PLAT', 'COPPER'], own: 'Silver-only moves (silver buying and selling, its own news)' } },
  { key: 'OIL', name: 'WTI crude oil', kind: 'commodity', settle: 'spot', digits: 2, yahoo: 'CL=F', match: /^KX(WTI|OIL)|\bwti\b|crude|\boil\b/i,
    drivers: { macro: ['DXY', 'US10Y', 'SPX'], sector: ['BRENT', 'GASOLINE', 'HEATOIL', 'NATGAS'], own: 'US-crude-only moves (US supply, inventories, big orders)' } },
];

// What moves the markets without exchange trade feeds (v13.34, public/drivers.js): Yahoo's public 1-minute charts of
// the dollar, Treasury yields, other metals and energy. Each market above lists its drivers in two groups:
//   macro   the big forces on everything priced in dollars: the dollar, rates, stocks (and oil for the metals)
//   sector  the rest of its own market (other metals for gold, Brent and fuels for US crude), minus the macro part:
//           a move they share is sector-wide buying or selling, not news about this one
// and what's left is its own: this market's own buyers and sellers and news.
export const DRIVERS = [
  { key: 'DXY', name: 'US dollar', short: 'Dollar', yahoo: 'DX-Y.NYB', unit: 'pct', why: 'gold and oil are priced in dollars: a stronger dollar usually pushes them down' },
  { key: 'US10Y', name: '10-year Treasury yield', short: 'Yields', yahoo: '^TNX', unit: 'yield', why: 'higher yields make gold (which pays nothing) less attractive and tighten money for everything' },
  { key: 'PLAT', name: 'Platinum', short: 'Platinum', yahoo: 'PL=F', unit: 'pct', why: 'the other precious metals: a move they share is metals-wide buying' },
  { key: 'COPPER', name: 'Copper', short: 'Copper', yahoo: 'HG=F', unit: 'pct', why: 'the industrial metal: a read on factory demand and China' },
  { key: 'BRENT', name: 'Brent crude', short: 'Brent', yahoo: 'BZ=F', unit: 'pct', why: 'the world oil price: a move it shares is global supply and demand, not US-only' },
  { key: 'GASOLINE', name: 'Gasoline futures', short: 'Gasoline', yahoo: 'RB=F', unit: 'pct', why: 'what refiners sell: strong gasoline prices pull crude up' },
  { key: 'HEATOIL', name: 'Heating oil / diesel', short: 'Diesel', yahoo: 'HO=F', unit: 'pct', why: 'diesel demand from trucking, farming and heating' },
  { key: 'NATGAS', name: 'Natural gas', short: 'Nat gas', yahoo: 'NG=F', unit: 'pct', why: 'the other big energy market: weather and power demand' },
];
// A market or driver by key (an asset's fields, or a driver's)
export const seriesOf = (key) => ASSETS.find((a) => a.key === key) ?? DRIVERS.find((d) => d.key === key) ?? null;
export const HOME_ASSET = ASSETS[0];

// The 15-minute up/down series known before discovery (Bitcoin's is the official bot's). Discovery adds every other
// series Kalshi lists for these assets; one Kalshi hasn't opened shows as closed rather than guessed.
export const SEEDS = [
  { series: 'KXBTC15M', asset: 'BTC', freq: '15m' }, { series: 'KXETH15M', asset: 'ETH', freq: '15m' },
  { series: 'KXSOL15M', asset: 'SOL', freq: '15m' }, { series: 'KXXRP15M', asset: 'XRP', freq: '15m' },
];
export const HOME = { ...HOME_ASSET, ...SEEDS[0] };
// (v13.29's list, still used where only the 15-minute coins matter)
export const MARKETS = SEEDS.map((s) => ({ ...ASSETS.find((a) => a.key === s.asset), ...s }));

const FREQ = { fifteen_min: '15m', '15min': '15m', fifteen_minute: '15m', quarter_hourly: '15m', hourly: 'hourly', daily: 'daily', weekly: 'weekly', monthly: 'monthly', annual: 'yearly', yearly: 'yearly', one_off: 'one-off', custom: 'custom' };
// The asset a Kalshi series is priced from (by its ticker first, then its title), or null when the bot has no price for it
export function assetFor({ series, title = '' }) {
  return ASSETS.find((a) => a.match.test(series || '')) ?? ASSETS.find((a) => a.match.test(title || '')) ?? null;
}
// A Kalshi series (from /series or /events) as one of the bot's markets, or null if the bot can't price it
export function classifySeries(x) {
  const series = x.ticker ?? x.series_ticker ?? x.series;
  if (!series || !/^[A-Z0-9]+$/.test(series)) return null;
  const a = assetFor({ series, title: x.title });
  if (!a) return null;
  const freq = /15M$/.test(series) || /15[- ]?min/i.test(x.title || '') ? '15m' : FREQ[String(x.frequency || '').toLowerCase()] ?? (x.freq || 'other');
  return { series, asset: a.key, freq, title: x.title || null };
}

// Everything about a series: its asset's fields plus the series' own. Known series come from the registry (the server's
// discovery, /api/markets); anything else is inferred from its ticker, and an unknown ticker is Bitcoin's.
export function marketOf(series, registry = null) {
  const r = registry?.find((x) => x.series === series) ?? SEEDS.find((x) => x.series === series);
  const a = ASSETS.find((x) => x.key === r?.asset) ?? assetFor({ series }) ?? null;
  if (!a) return HOME;
  return { ...a, asset: a.key, series: r?.series ?? series, freq: r?.freq ?? (/15M$/.test(series) ? '15m' : 'other'), title: r?.title ?? null };
}
export const isHome = (series) => series === HOME.series;
// The timeframes listed and run (v13.31: 15-minute rounds only; MARKETS_FREQ=all on the server lists every timeframe)
export const listed = (m, freq = '15m') => freq === 'all' || m.freq === freq;
export const label = (m) => `${m.key} · ${m.freq}`;
// The round's short name for notes and tiles (KXETH15M-26OCT141215-15 -> 26OCT141215-15)
export const roundName = (ticker) => String(ticker || '').replace(/^[A-Z0-9]+-/, '');
// Where a market's own logs are kept on the phone: Bitcoin's 15-minute market keeps the original keys
export const storeKey = (key, series) => (isHome(series) ? key : `${key}:${series}`);
// Each market's server files: Bitcoin's 15-minute bot keeps the data folder itself; every other market gets a folder
export const dataDir = (series) => (isHome(series) ? '' : `markets/${series}`);
