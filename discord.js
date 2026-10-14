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
export function callMessage(e, { strike = null, floor = null, paper = false, level = 'official', base = null, late = false, early = false, flip = null } = {}) {
  const up = e.side === 'YES', { author, ...sender } = brand(base);
  return {
    ...sender,
    embeds: [{
      author,
      title: `${paper ? '📝 PAPER · ' : ''}${flip ? '↺ FLIP · ' : ''}${up ? '🐂' : '🐻'} ${sideName(e.side)} call${late ? ' · ⏱ LATE' : early ? ' · ⚡ EARLY' : ''}`,
      description: paper ? 'The profit guard has buy alerts paused (this level is losing money after fees), so this is logged as a paper call, not a buy.' : `BTC ${up ? 'above' : 'below'} ${strike ? `$${Math.round(strike).toLocaleString('en-US')}` : 'the target'} when the round closes.`,
      color: paper ? 0x5d6880 : up ? 0x2ee6a6 : 0xff4d6d,
      fields: [
        { name: 'Price', value: cents(e.price), inline: true },
        ...(e.price > 0 && e.price < 1 ? [{ name: 'If it wins', value: `+${cents(1 - e.price)} a contract (+${Math.round(((1 - e.price) / e.price) * 100)}%)`, inline: true }] : []),
        { name: 'Confidence', value: e.conf != null ? `${Math.round(e.conf)}` : '—', inline: true },
        { name: 'Closes', value: ts(Date.parse(e.closeTime)), inline: true },
        ...(floor != null ? [{ name: 'Price floor', value: `${cents(floor)} (win-rate guard)`, inline: true }] : []),
        ...(flip ? [{ name: 'Flip', value: `The round flipped: switching from the earlier ${flip.from ? sideName(flip.from) : ''} call, on clear evidence (the bot 90%+ sure of ${sideName(e.side)} even in its worst case). Half size.`.replace('  ', ' '), inline: false }] : []),
        ...(early ? [{ name: 'Early lane', value: 'Called before Kalshi is sure: live after its test calls beat Kalshi\'s prices on real rounds. Half size.', inline: false }] : []),
        ...(late ? [{ name: 'Late lane', value: 'Last 5 minutes: passed a stress test (1.35× volatility, fat tails). Half size.', inline: false }] : []),
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

// The 10-minute pick (public/pick.js): every round's side, locked by the math at 10:00 left, with the last pick's result
// in the same post (one message a round, not two)
export function pickMessage(e, { prev = null, stats = null, base = null } = {}) {
  const { author, ...sender } = brand(base), up = e.side === 'YES';
  const pc = (x) => `${Math.round(x * 100)}%`, last = prev ? `${prev.side.toLowerCase() === prev.result ? '✅ won' : '❌ lost'} (${sideName(prev.side)} at ${cents(prev.price)})` : null;
  return {
    ...sender,
    embeds: [{
      author,
      title: `🔒 10-MIN PICK · ${up ? '🐂' : '🐻'} ${sideName(e.side)}${e.buy ? ' · ✅ BUY' : ''}`,
      description: `BTC ${up ? 'above' : 'below'} ${e.strike ? `$${Math.round(e.strike).toLocaleString('en-US')}` : 'the target'} at the close, by the math: **${pc(e.p)}**${e.worst != null ? ` (${pc(e.worst)} even if the volatility is off)` : ''}.\n${e.buy ? `Worth buying at up to ${cents(e.price)}.` : `${e.why ? e.why.charAt(0).toUpperCase() + e.why.slice(1) : 'A pick, not a buy'}.`}`,
      color: e.buy ? (up ? 0x2ee6a6 : 0xff4d6d) : 0x5d6880,
      fields: [
        { name: 'Kalshi', value: cents(e.price), inline: true },
        { name: 'Closes', value: ts(Date.parse(e.closeTime)), inline: true },
        ...(last ? [{ name: 'Last pick', value: last, inline: true }] : []),
        ...(stats?.graded ? [{ name: 'Picks so far', value: `${stats.wins}–${stats.graded - stats.wins} (${Math.round(stats.wins / stats.graded * 100)}%)`, inline: true }] : []),
      ],
      footer: { text: `Locked at 10:00 left · ${DISCLAIMER}` },
    }],
  };
}
// An alert (discordalerts.js): the embed gets the sender, the header and the disclaimer like the calls
export function alertMessage(embed, base = null) {
  const { author, ...sender } = brand(base);
  return { ...sender, embeds: [{ author, ...embed, footer: { text: embed.footer?.text ? `${embed.footer.text} · ${DISCLAIMER}` : DISCLAIMER } }] };
}

// One webhook's queue: one message at a time, 1.2 s apart, Discord's 429 waited out (3 tries). Calls and results go
// ahead of the market alerts and are never the ones dropped when the queue backs up (alerts are, oldest first)
function poster(hook, { fetchImpl, sleep, log }) {
  const hi = [], lo = []; let busy = false; const n = { sent: 0, failed: 0 };
  async function drain() {
    if (busy) return;
    busy = true;
    while (hi.length || lo.length) {
      const body = hi.length ? hi.shift() : lo.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetchImpl(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep(Math.min(30, Number(j.retry_after) || 2) * 1000); continue; }
          if (res.ok) n.sent++; else { n.failed++; log.warn?.(`Discord post refused (${res.status})`); }
          break;
        } catch (err) { if (attempt === 2) { n.failed++; log.warn?.('Discord post failed', err.message); } else await sleep(2000); }
      }
      await sleep(1200);
    }
    busy = false;
  }
  const post = (body, urgent = true) => {
    if (urgent) { hi.push(body); if (hi.length > 200) hi.shift(); } else { lo.push(body); if (lo.length > 30) lo.shift(); }
    drain(); return true;
  };
  return { post, n, queued: () => hi.length + lo.length };
}

// alertsUrl (DISCORD_ALERTS_WEBHOOK_URL, optional): a second channel's webhook for the market alerts, so the calls
// channel stays calls-only; without it the alerts go to the calls channel too
export function createDiscord({ url = process.env.DISCORD_WEBHOOK_URL, alertsUrl = process.env.DISCORD_ALERTS_WEBHOOK_URL, base = appUrl(), fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
  const hook = cleanWebhook(url), on = HOOK.test(hook);
  // why it's off, for /healthz (never the address itself)
  const why = on ? null : !url ? 'DISCORD_WEBHOOK_URL is not set' : 'DISCORD_WEBHOOK_URL is set but is not a Discord webhook address (https://discord.com/api/webhooks/...)';
  if (url && !on) log.warn?.(`${why}: Discord posts are off`);
  const aHook = cleanWebhook(alertsUrl), aOwn = HOOK.test(aHook) && aHook !== hook;
  if (alertsUrl && !HOOK.test(aHook)) log.warn?.('DISCORD_ALERTS_WEBHOOK_URL is not a Discord webhook address: alerts go to the calls channel');
  const main = poster(hook, { fetchImpl, sleep, log }), side = aOwn ? poster(aHook, { fetchImpl, sleep, log }) : main;
  const alertsOn = on || aOwn;
  return {
    on,
    call: (e, opts) => on && main.post(callMessage(e, { ...opts, base })),
    result: (e, stats) => on && main.post(resultMessage(e, stats, base)),
    alert: (embed) => alertsOn && side.post(alertMessage(embed, base), false),
    pick: (e, o = {}) => on && main.post(pickMessage(e, { ...o, base })),
    status: () => ({ on, why, sent: main.n.sent + (aOwn ? side.n.sent : 0), failed: main.n.failed + (aOwn ? side.n.failed : 0), queued: main.queued() + (aOwn ? side.queued() : 0), branded: !!base, alerts: !alertsOn ? 'off' : aOwn ? 'own channel' : 'calls channel' }),
  };
}
