// Liquidations (v13.21, taken from public Kalshi/Polymarket bots that read futures liquidations): when leveraged
// futures positions are force-closed, the exchange's own market orders push the price the same way, often for a few
// minutes. Longs liquidated = forced selling (down); shorts liquidated = forced buying (up, a squeeze).
// Feeds whose format says plainly which side was liquidated (whatever connects from the server is used: Binance and
// OKX block some regions):
//   Binance  btcusdt@forceOrder: o.S is the forced order's side, so SELL = a long liquidated; size o.q (BTC) at o.ap
//   OKX      liquidation-orders (SWAP): details[].posSide is the liquidated position (long/short); sz in contracts of
//            0.01 BTC for BTC-USDT-SWAP, at bkPx
// The Round scan reads them as one input (public/roundscan.js 'liq'), learned and used only once proven like the rest.
// A coin's liquidation feeds (public/markets.js sym): Binance's USDT perp and OKX's swap, where listed
import { HOME_ASSET } from './markets.js';

export const liqFeedsFor = (y) => (!y ? [] : [
  y.binance && {
    name: 'Binance', url: `wss://fstream.binance.com/ws/${y.binance}@forceOrder`, subscribe: [],
    parse: (m) => {
      const o = m?.e === 'forceOrder' ? m.o : null;
      if (!o || o.s !== y.binance.toUpperCase()) return [];
      const px = Number(o.ap) || Number(o.p), q = Number(o.z) || Number(o.q);
      return px > 0 && q > 0 ? [{ t: Number(o.T) || Number(m.E) || Date.now(), ex: 'Binance', liq: o.S === 'SELL' ? 'long' : 'short', usd: px * q, price: px }] : [];
    },
  },
  y.okx && {
    name: 'OKX', url: 'wss://ws.okx.com:8443/ws/v5/public', subscribe: [{ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }], ping: [25000, 'ping'],
    parse: (m) => {
      if (m?.arg?.channel !== 'liquidation-orders' || !Array.isArray(m.data)) return [];
      const out = [];
      for (const d of m.data) {
        if (d.instId !== y.okx) continue;
        for (const x of d.details || []) {
          const px = Number(x.bkPx), qty = Number(x.sz) * y.okxCt;
          if (px > 0 && qty > 0 && (x.posSide === 'long' || x.posSide === 'short')) out.push({ t: Number(x.ts) || Date.now(), ex: 'OKX', liq: x.posSide, usd: px * qty, price: px });
        }
      }
      return out;
    },
  },
].filter(Boolean));
export const LIQ_FEEDS = liqFeedsFor(HOME_ASSET.sym); // Bitcoin's

// The last `windowMs` of liquidations: dollars of longs and shorts force-closed, and the net push toward UP as -1..+1
// (shorts minus longs over their total plus $250k, so a few small ones read near 0)
export function liqRead(liqs, now = Date.now(), windowMs = 120000) {
  let long = 0, short = 0, n = 0;
  for (let i = (liqs?.length ?? 0) - 1; i >= 0; i--) {
    const x = liqs[i];
    if (x.t < now - windowMs) break;
    if (x.t > now) continue;
    n++; if (x.liq === 'long') long += x.usd; else short += x.usd;
  }
  const net = (short - long) / (long + short + 250000);
  return { long, short, n, push: Math.max(-1, Math.min(1, net)) };
}
