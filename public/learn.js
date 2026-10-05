// Learns from real trades: small, bounded adjustments to the live bot from how its own REAL trades went.
// Every 10 new closed bot trades it looks at the last 30 and may:
//   - raise the live confidence bar 2 points when the trades just over the bar are losing money,
//     or lower it 2 points when the last 30 made money with 60%+ wins (never under the risk level's bar, never over 95)
//   - bet 20% smaller after the last 30 lost money (down to half size), or 10% bigger after they made money (up to 1.5x)
// 30 trades is a small sample, so steps are small and every change is logged with its reason.
export const LEARN = { window: 30, every: 10, step: 2, maxBar: 95, near: 5, minNear: 8, sizeMin: 0.5, sizeMax: 1.5 };
export const newLearned = () => ({ seen: 0, sizeMult: 1, log: [] });

const r2 = (v) => Math.round(v * 100) / 100;
const money = (v) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`;

// botTrades: the bot's closed real trades, any order ({ closedAt, pnl, conf }). Returns { learned, liveBar, changes }.
export function learnStep({ botTrades, learned = newLearned(), liveBar, stratBar, now = Date.now() }) {
  const L = LEARN, out = { ...learned, log: [...(learned.log || [])] };
  const changes = [];
  if (botTrades.length < L.window || botTrades.length - (learned.seen || 0) < L.every) return { learned: out, liveBar, changes };
  out.seen = botTrades.length;
  const last = [...botTrades].sort((a, b) => b.closedAt - a.closedAt).slice(0, L.window);
  const pnl = r2(last.reduce((a, t) => a + t.pnl, 0));
  const winRate = last.filter((t) => t.pnl > 0).length / last.length;
  const near = last.filter((t) => t.conf != null && t.conf < liveBar + L.near);
  const nearPnl = r2(near.reduce((a, t) => a + t.pnl, 0));
  let bar = liveBar;
  if (near.length >= L.minNear && nearPnl < 0 && liveBar < L.maxBar) {
    bar = Math.min(L.maxBar, liveBar + L.step);
    changes.push({ what: 'Min confidence', from: liveBar, to: bar, why: `its ${near.length} trades just over the bar (confidence under ${liveBar + L.near}) made ${money(nearPnl)}` });
  } else if (pnl > 0 && winRate >= 0.6 && liveBar > stratBar) {
    bar = Math.max(stratBar, liveBar - L.step);
    changes.push({ what: 'Min confidence', from: liveBar, to: bar, why: `the last ${L.window} trades made ${money(pnl)} with ${Math.round(winRate * 100)}% wins` });
  }
  const size = learned.sizeMult ?? 1;
  let next = size;
  if (pnl < 0) next = Math.max(L.sizeMin, Math.round(size * 0.8 * 100) / 100);
  else if (pnl > 0) next = Math.min(L.sizeMax, Math.round(size * 1.1 * 100) / 100);
  if (next !== size) changes.push({ what: 'Trade size', from: size, to: next, why: `the last ${L.window} trades ${pnl < 0 ? 'lost' : 'made'} $${Math.abs(pnl).toFixed(2)}` });
  out.sizeMult = next;
  for (const c of changes) out.log.unshift({ at: now, ...c });
  out.log = out.log.slice(0, 50);
  return { learned: out, liveBar: bar, changes };
}
