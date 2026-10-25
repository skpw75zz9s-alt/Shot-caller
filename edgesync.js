// Keeps the Cloudflare backup's copy of the members (cloudflare/worker.js) in step with this server (v13.86).
// Every few minutes, while the server is up:
//   1. GET  <APP_URL>/__edge/changes   what happened on the backup while the server was off: new purchases, "I've paid",
//                                      the admin's approvals. Merged into the member list (access.js mergeEdge: the
//                                      newer side wins), and the admin is told about payments it missed.
//   2. POST <APP_URL>/__edge/members   the whole list (without sessions) and the price, so members can sign in with
//                                      their code while the server is off; with what was merged, so the backup drops it.
// Both carry EDGE_SECRET (x-sc-edge); the backup answers them itself and never passes them on.
import { createHash } from 'node:crypto';

export function createEdgeSync({ access, base, secret, fetchImpl = (...a) => fetch(...a), clock = () => Date.now(), log = console, every = 180000 }) {
  let lastHash = null, lastPushAt = 0, timer = null, failing = false, lastOk = null;
  const url = (p) => `${String(base).replace(/\/+$/, '')}/__edge/${p}`;
  const headers = { 'x-sc-edge': secret, 'content-type': 'application/json', 'user-agent': 'shot-caller/1.0' };

  async function sync() {
    if (!base || !secret) return { off: true };
    try {
      const r = await fetchImpl(url('changes'), { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`changes: HTTP ${r.status}`);
      const { ack, merged } = access.mergeEdge((await r.json()).changes || {});
      const out = access.exportMembers(), hash = createHash('sha1').update(JSON.stringify(out)).digest('hex');
      // the list only when it changed (or hourly), so the backup's free storage isn't written for nothing
      if (hash !== lastHash || Object.keys(ack).length || clock() - lastPushAt > 3600000) {
        const p = await fetchImpl(url('members'), { method: 'POST', headers, body: JSON.stringify({ ...out, ack }), signal: AbortSignal.timeout(15000) });
        if (!p.ok) throw new Error(`members: HTTP ${p.status}`);
        lastHash = hash; lastPushAt = clock();
      }
      if (failing) log.log?.('the Cloudflare backup is in step again');
      failing = false; lastOk = clock();
      return { merged, pushed: lastPushAt === clock() };
    } catch (e) {
      if (!failing) log.warn?.(`keeping the Cloudflare backup's members in step failed: ${e.message}`);
      failing = true;
      return { error: e.message };
    }
  }
  function start() {
    if (timer || !base || !secret) return;
    setTimeout(sync, 10000).unref?.();
    timer = setInterval(sync, every); timer.unref?.();
  }
  return { sync, start, status: () => ({ on: !!(base && secret), lastOk, failing }) };
}
