// The official website (v13.14): what anyone can see at the app's address without signing in (public/site.html).
//   /api/public/record  the official record, settled calls only: live (unsettled) calls stay for members, so the site
//                       shows the bot's honest history without giving away the current round
//   /api/public/info    the version and, when DISCORD_INVITE is set to a Discord invite link, the server's invite
const INVITE = /^https:\/\/(?:discord\.gg|(?:www\.)?discord\.com\/invite)\/[\w-]{2,32}$/;

export function discordInvite(env = process.env) {
  const raw = String(env.DISCORD_INVITE ?? '').trim().replace(/^['"<]+|['">]+$/g, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return INVITE.test(raw) ? raw : null;
}

// rec: bot.record() (the official record: totals, streaks and up to 400 calls, oldest first)
export function publicRecord(rec, { recent = 12 } = {}) {
  const settled = (rec?.calls || []).filter((e) => e.result === 'yes' || e.result === 'no');
  return {
    level: rec?.level ?? null, since: rec?.since ?? null,
    graded: rec?.graded ?? 0, wins: rec?.wins ?? 0, usd: rec?.usd ?? 0,
    streak: rec?.streak ?? null, bestWin: rec?.bestWin ?? 0,
    recent: settled.slice(-recent).reverse().map((e) => ({ side: e.side === 'YES' ? 'UP' : 'DOWN', price: e.price, won: e.side.toLowerCase() === e.result, at: e.at })),
  };
}
