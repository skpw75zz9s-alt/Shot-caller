// Copy the sharps: the traders who keep winning the same 15-minute BTC Up/Down rounds on Polymarket, where every
// trade is public and tied to a wallet (Kalshi's trades are anonymous, and true insiders are barred from trading).
// Pure functions; smartmoney.js on the server feeds them Polymarket's public trades and results.
//   1) every wallet's position in each round (shares of Up/Down bought minus sold, dollars in and out)
//   2) after each round settles: each wallet's profit/loss on it (rounds where it put in $20+ count)
//   3) sharps: 15+ graded rounds, winning more often than not by a margin (shrunk toward 50%) and up money overall
//   4) the live read: which way the sharps' money leans in the current round
//   5) the honest record: the sharps' lean at 5 minutes left (sharps picked from PAST rounds only), graded against
//      the result, so luck can't pass for skill
export const SHARP = { minRounds: 15, minWin: 0.58, minStake: 20 };

// One Polymarket trade (old camelCase or v2 snake_case shape) -> { id, wallet, name, side, outcome, price, size, t }
export function parseTrade(x) {
  const wallet = String(x.proxyWallet ?? x.proxy_wallet ?? '').toLowerCase();
  const side = String(x.side || '').toUpperCase(), outcome = String(x.outcome || '');
  const price = Number(x.price), size = Number(x.size), t = Number(x.timestamp) * (Number(x.timestamp) < 1e12 ? 1000 : 1);
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !(side === 'BUY' || side === 'SELL') || !/^(up|down)$/i.test(outcome) || !(price > 0 && price < 1) || !(size > 0)) return null;
  const hash = x.transactionHash ?? x.transaction_hash ?? '';
  return { id: `${hash}:${wallet}:${side}:${outcome}:${size}:${price}`, wallet, name: String(x.name || x.pseudonym || '').slice(0, 40), side, outcome: /^up$/i.test(outcome) ? 'Up' : 'Down', price, size, t };
}
// Fold trades into positions: { wallet: { Up, Down (shares), cash (dollars: - in, + out), bought ($), name } }
export function foldRound(pos, trades) {
  for (const x of trades) {
    const p = (pos[x.wallet] ||= { Up: 0, Down: 0, cash: 0, bought: 0, name: x.name });
    if (x.name) p.name = x.name;
    if (x.side === 'BUY') { p[x.outcome] += x.size; p.cash -= x.price * x.size; p.bought += x.price * x.size; }
    else { p[x.outcome] -= x.size; p.cash += x.price * x.size; }
  }
  return pos;
}
// A settled round (winner 'Up' | 'Down') -> each wallet's result, into the wallet book { wallet: { rounds, wins, pnl, staked, name, last } }
export function gradeRound(book, pos, winner, at = Date.now()) {
  for (const [w, p] of Object.entries(pos)) {
    if (!(p.bought >= SHARP.minStake)) continue;
    const pnl = p.cash + Math.max(0, p[winner]);
    const b = (book[w] ||= { rounds: 0, wins: 0, pnl: 0, staked: 0, name: '', last: 0 });
    b.rounds++; b.wins += pnl > 0 ? 1 : 0; b.pnl += pnl; b.staked += p.bought; b.last = at; if (p.name) b.name = p.name;
  }
  return book;
}
const shrunk = (b) => (b.wins + 2) / (b.rounds + 4); // win rate pulled toward 50% (few rounds can't look great)
export const isSharp = (b) => !!b && b.rounds >= SHARP.minRounds && shrunk(b) >= SHARP.minWin && b.pnl > 0;
export function sharpList(book, n = 15) {
  return Object.entries(book).filter(([, b]) => isSharp(b)).map(([wallet, b]) => ({ wallet, ...b, win: b.wins / b.rounds, roi: b.staked > 0 ? b.pnl / b.staked : 0 }))
    .sort((a, b) => b.pnl - a.pnl).slice(0, n);
}
// The sharps' live lean in a round: dollars they have net in Up vs Down (current positions valued at cost)
export function sharpLean(book, pos) {
  let up = 0, down = 0, n = 0;
  const who = [];
  for (const [w, p] of Object.entries(pos)) {
    if (!isSharp(book[w])) continue;
    const netUp = p.Up - p.Down;
    if (Math.abs(netUp) < 1) continue;
    const usd = Math.abs(p.cash) || Math.abs(netUp) * 0.5;
    if (netUp > 0) up += usd; else down += usd;
    n++; who.push({ wallet: w, name: book[w].name || p.name, side: netUp > 0 ? 'Up' : 'Down', shares: Math.abs(netUp), usd });
  }
  const tot = up + down;
  return { n, up, down, upShare: tot > 0 ? up / tot : null, lean: tot > 0 && n >= 2 ? (up >= down ? 'Up' : 'Down') : null, who: who.sort((a, b) => b.usd - a.usd).slice(0, 10) };
}
// The record of copying: entries { window, lean, upShare, n, result } -> how often the lean was right
export function copyRecord(log) {
  const graded = log.filter((e) => e.lean && (e.result === 'Up' || e.result === 'Down'));
  const right = graded.filter((e) => e.lean === e.result).length;
  const strong = graded.filter((e) => Math.max(e.upShare, 1 - e.upShare) >= 0.75), strongRight = strong.filter((e) => e.lean === e.result).length;
  return { graded: graded.length, right, strong: strong.length, strongRight, rate: graded.length ? right / graded.length : null };
}
