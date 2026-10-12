// Discord auto-posts (v13.11, branded v13.12): the server posts each official call to a Discord channel the moment it's made, and its
// result once Kalshi settles the round, through a channel webhook (Channel settings -> Integrations -> Webhooks).
// Set DISCORD_WEBHOOK_URL in Railway's Variables; without it nothing is sent. The URL is a password for that channel:
// it's never logged, and only Discord's own webhook addresses are accepted (so the server can't be pointed elsewhere).
//   call     side, price, confidence, the target, when the round closes, the guard's floor; marked as a PAPER call
//            while the profit guard has buy alerts paused
//   result   win or loss, the price it was bought at, and the record so far with profit after fees at $10 a call
// One message at a time, at least 1.2 s apart; on a 429 it waits Discord's retry_after and tries again (3 tries).
// Branding (v13.12): every post comes from "Shot Caller" with the app's bitcoin icon as its avatar and an "Official
// calls" header that links to the app. The address comes from APP_URL, or Railway's own RAILWAY_PUBLIC_DOMAIN; without
// either the posts still go out, just without the icon and link.
const HOOK = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,30}\/[\w-]{20,120}$/;
const DISCLAIMER = 'Signals only. Not financial advice. Every call can lose.';
const NAME = 'Shot Caller';
// The app's public address (https only), from APP_URL or Railway's domain
export function appUrl(env = process.env) {
  const raw = (env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).trim().replace(/\/+$/, '');
  return /^https:\/\/[\w.-]+(?::\d+)?$/.test(raw) ? raw : null;
}
// The sender's name and avatar, and the header on each embed
export function brand(base) {
  const icon = base ? `${base}/icon-512.png?v=3` : null;
  return { username: NAME, ...(icon ? { avatar_url: icon } : {}), author: { name: `${NAME} · Official calls`, ...(base ? { url: base, icon_url: icon } : {}) } };
}
// The address as pasted, tidied: surrounding spaces and quotes, and any ?query or trailing slash, are dropped
export const cleanWebhook = (url) => (typeof url === 'string' ? url.trim().replace(/^['"<]+|['">]+$/g, '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '') : '');
export const validWebhook = (url) => HOOK.test(cleanWebhook(url));

const sideName = (side) => (side === 'YES' ? 'UP' : 'DOWN');
const cents = (p) => `${Math.round(p * 100)}¢`;
const usd = (v) => `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`;
const ts = (ms, style = 't') => `<t:${Math.floor(ms / 1000)}:${style}>`; // Discord shows it in each reader's own time zone

// The embeds (pure, so they're testable)
export function callMessage(e, { strike = null, floor = null, paper = false, level = 'official', base = null } = {}) {
  const up = e.side === 'YES', { author, ...sender } = brand(base);
  return {
    ...sender,
    embeds: [{
      author,
      title: `${paper ? '📝 PAPER · ' : ''}${up ? '🐂' : '🐻'} ${sideName(e.side)} call`,
      description: paper ? 'The profit guard has buy alerts paused (this level is losing money after fees), so this is logged as a paper call, not a buy.' : `BTC ${up ? 'above' : 'below'} ${strike ? `$${Math.round(strike).toLocaleString('en-US')}` : 'the target'} when the round closes.`,
      color: paper ? 0x5d6880 : up ? 0x2ee6a6 : 0xff4d6d,
      fields: [
        { name: 'Price', value: cents(e.price), inline: true },
        { name: 'Confidence', value: e.conf != null ? `${Math.round(e.conf)}` : '—', inline: true },
        { name: 'Closes', value: ts(Date.parse(e.closeTime)), inline: true },
        ...(floor != null ? [{ name: 'Price floor', value: `${cents(floor)} (win-rate guard)`, inline: true }] : []),
        { name: 'Market', value: `\`${e.ticker}\``, inline: true },
      ],
      footer: { text: `${level} · ${DISCLAIMER}` },
      timestamp: new Date(e.at).toISOString(),
    }],
  };
}
export function resultMessage(e, stats = null, base = null) {
  const { author, ...sender } = brand(base), won = e.side.toLowerCase() === e.result;
  const rec = stats?.graded ? `${stats.wins}–${stats.graded - stats.wins} (${Math.round((stats.wins / stats.graded) * 100)}% won) · ${usd(stats.usd ?? 0)} at $10 a call after fees` : null;
  return {
    ...sender,
    embeds: [{
      author,
      title: `${won ? '✅ WIN' : '❌ LOSS'} · ${sideName(e.side)} at ${cents(e.price)}`,
      description: `BTC closed ${e.result === 'yes' ? 'above' : 'below'} the target.${rec ? `\n**Record:** ${rec}` : ''}`,
      color: won ? 0x2ee6a6 : 0xff4d6d,
      fields: [{ name: 'Market', value: `\`${e.ticker}\``, inline: true }, { name: 'Called', value: ts(e.at), inline: true }],
      footer: { text: DISCLAIMER },
    }],
  };
}

export function createDiscord({ url = process.env.DISCORD_WEBHOOK_URL, base = appUrl(), fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
  const hook = cleanWebhook(url), on = HOOK.test(hook);
  // why it's off, for /healthz (never the address itself)
  const why = on ? null : !url ? 'DISCORD_WEBHOOK_URL is not set' : 'DISCORD_WEBHOOK_URL is set but is not a Discord webhook address (https://discord.com/api/webhooks/...)';
  if (url && !on) log.warn?.(`${why}: Discord posts are off`);
  const queue = []; let busy = false, sent = 0, failed = 0;
  async function drain() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const body = queue.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetchImpl(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep(Math.min(30, Number(j.retry_after) || 2) * 1000); continue; }
          if (res.ok) sent++; else { failed++; log.warn?.(`Discord post refused (${res.status})`); }
          break;
        } catch (err) { if (attempt === 2) { failed++; log.warn?.('Discord post failed', err.message); } else await sleep(2000); }
      }
      await sleep(1200);
    }
    busy = false;
  }
  const post = (body) => { if (!on) return false; queue.push(body); if (queue.length > 50) queue.shift(); drain(); return true; };
  return {
    on,
    call: (e, opts) => post(callMessage(e, { ...opts, base })),
    result: (e, stats) => post(resultMessage(e, stats, base)),
    status: () => ({ on, why, sent, failed, queued: queue.length, branded: !!base }),
  };
}
