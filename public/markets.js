// Kalshi markets the bot can call (v13.29): the 15-minute crypto up/down rounds, each with the Coinbase product its odds
// are priced from. The bot's math (distance to the target in typical moves for the time left, Kalshi's 60-second
// settlement average, fat tails) works the same on any of them; what's tied to Bitcoin is everything the server has
// learned or streams (the official record, the 10-minute pick, learned volatility, the Round scan, Market watch, the
// forecasts, the multi-exchange index and feeds), so on another coin those are left out, never shown with BTC's data.
// Which ones Kalshi has open right now is checked live by the server (/api/markets), so a coin Kalshi hasn't listed or
// has paused shows as closed rather than guessed.
export const MARKETS = [
  { key: 'BTC', series: 'KXBTC15M', name: 'Bitcoin', product: 'BTC-USD', digits: 0 },
  { key: 'ETH', series: 'KXETH15M', name: 'Ethereum', product: 'ETH-USD', digits: 2 },
  { key: 'SOL', series: 'KXSOL15M', name: 'Solana', product: 'SOL-USD', digits: 2 },
  { key: 'XRP', series: 'KXXRP15M', name: 'XRP', product: 'XRP-USD', digits: 4 },
];
export const HOME = MARKETS[0]; // Bitcoin: the official bot's market

export const marketOf = (series) => MARKETS.find((m) => m.series === series) ?? HOME;
export const isHome = (series) => marketOf(series) === HOME;
// The round's short name for notes and tiles (KXETH15M-26OCT141215-15 -> 26OCT141215-15)
export const roundName = (ticker) => String(ticker || '').replace(/^[A-Z0-9]+-/, '');
// Where a market's own logs are kept on the phone: Bitcoin keeps the original keys; other coins get their own
export const storeKey = (key, series) => (isHome(series) ? key : `${key}:${marketOf(series).key}`);
