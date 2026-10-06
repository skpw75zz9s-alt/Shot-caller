// Live check: hits the real exchanges and Kalshi with the app's own parsers and reports what it sees.
//   npm run livecheck
// Checks: each exchange answers and parses; the index estimate forms from 2+ exchanges and they agree;
// Kalshi lists an open 15-minute BTC market; a settled one reports the settlement value the basis learner needs.
import { createIndex, defaultSources } from './index.js';

const KALSHI = process.env.KALSHI_API || 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = process.env.COINBASE_API || 'https://api.exchange.coinbase.com';
const getJSON = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'shot-caller/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
let fails = 0;
const ok = (good, text) => { if (!good) fails++; console.log(`${good ? '✓' : '✕'} ${text}`); };

const sources = defaultSources(COINBASE);
for (const s of sources) {
  try { const p = s.parse(await getJSON(s.url)); ok(p > 0, `${s.name}: ${p > 0 ? `$${p.toFixed(2)}` : 'answered but could not parse a price'}`); }
  catch (e) { ok(false, `${s.name}: ${e.cause?.code || e.message}`); }
}
const ix = await createIndex({ sources, fetchJSON: getJSON }).poll();
ok(ix.index > 0, ix.index ? `Index estimate $${ix.index.toFixed(2)} from ${ix.used.join(', ')}${ix.dropped.length ? ` (dropped ${ix.dropped.join(', ')})` : ''}` : 'Index estimate: fewer than 2 exchanges answered');
if (ix.index && ix.coinbase) console.log(`  Coinbase is ${ix.coinbase - ix.index >= 0 ? '+' : '-'}$${Math.abs(ix.coinbase - ix.index).toFixed(2)} vs the index; spread across exchanges $${(Math.max(...ix.sources.map((q) => q.price)) - Math.min(...ix.sources.map((q) => q.price))).toFixed(2)}`);

try {
  const open = (await getJSON(`${KALSHI}/markets?series_ticker=KXBTC15M&status=open&limit=5`)).markets || [];
  ok(open.length > 0, open.length ? `Kalshi open market ${open[0].ticker}: strike ${open[0].floor_strike ?? open[0].cap_strike}, closes ${open[0].close_time}` : 'Kalshi: no open KXBTC15M market');
  const settled = (await getJSON(`${KALSHI}/markets?series_ticker=KXBTC15M&status=settled&limit=10`)).markets || [];
  const withValue = settled.filter((m) => Number(m.expiration_value) > 0);
  ok(withValue.length > 0, withValue.length ? `Kalshi reports settlement values (e.g. ${withValue[0].ticker} settled ${withValue[0].result} at $${Number(withValue[0].expiration_value).toFixed(2)}): basis learning works` : `Kalshi settled markets have no expiration_value (${settled.length} checked): basis learning will stay off`);
} catch (e) { ok(false, `Kalshi: ${e.cause?.code || e.message}`); }

console.log(fails ? `\n${fails} check(s) failed` : '\nAll live checks passed');
process.exit(fails ? 1 : 0);
