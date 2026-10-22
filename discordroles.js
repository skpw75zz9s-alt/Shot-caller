// Discord role sync (v13.42): a paying member links their Discord account once from Settings, and the server gives them
// the members' role in your Discord server while their access is active and takes it away when it ends (expired,
// revoked). Checked right after any admin change and every 10 minutes.
//   link       Settings -> "Link Discord" sends the member to Discord's own sign-in page (OAuth2, scopes identify and
//              guilds.join); Discord sends them back to /api/discord/callback with a one-time code. The server swaps it
//              for the member's Discord ID, adds them to the server if they aren't in it yet, and gives the role.
//   sync       PUT / DELETE the role through your bot, only when it needs to change; Discord's 429s are waited out.
// Set in Railway's Variables (never in the repo or a chat):
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET   the Discord application (Developer Portal -> OAuth2)
//   DISCORD_BOT_TOKEN                          that application's bot (Bot -> Reset Token), invited with Manage Roles
//                                              and Create Invite, its role above the members' role
//   DISCORD_GUILD_ID, DISCORD_ROLE_ID          your server and the role to give
//   DISCORD_REDIRECT_URI (optional)            defaults to APP_URL (or the Railway domain) + /api/discord/callback; it
//                                              must be listed under OAuth2 -> Redirects exactly
// Without them the feature is off and Settings says so. The secret and the bot token are never logged or sent to a phone;
// the only thing kept per member is their Discord ID and name.
import crypto from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeAtomic } from './atomicfile.js';

const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{5,30}$/;
const STATE_TTL = 600000;

export function discordConfig(env = process.env, base = null) {
  const c = {
    clientId: (env.DISCORD_CLIENT_ID || '').trim(), secret: (env.DISCORD_CLIENT_SECRET || '').trim(), bot: (env.DISCORD_BOT_TOKEN || '').trim(),
    guild: (env.DISCORD_GUILD_ID || '').trim(), role: (env.DISCORD_ROLE_ID || '').trim(),
    redirect: (env.DISCORD_REDIRECT_URI || (base ? `${base}/api/discord/callback` : '')).trim(),
  };
  const missing = [['DISCORD_CLIENT_ID', SNOWFLAKE.test(c.clientId)], ['DISCORD_CLIENT_SECRET', !!c.secret], ['DISCORD_BOT_TOKEN', !!c.bot],
    ['DISCORD_GUILD_ID', SNOWFLAKE.test(c.guild)], ['DISCORD_ROLE_ID', SNOWFLAKE.test(c.role)], ['DISCORD_REDIRECT_URI or APP_URL', /^https?:\/\//.test(c.redirect)]].filter(([, ok]) => !ok).map(([k]) => k);
  return { ...c, on: !missing.length, missing };
}

// isActive(code) -> is that member's access active right now; codes() -> every member code the paywall knows
export function createDiscordRoles({ file, env = process.env, base = null, isActive = () => false, fetch: http = globalThis.fetch, clock = () => Date.now(), log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cfg = discordConfig(env, base);
  let links = {}; // member code -> { id, name, linkedAt, role: true|false|null, syncedAt, error }
  const states = new Map(); // one-time OAuth state -> { code, at }
  let saveTimer = null, timer = null, syncing = null;

  async function load() { try { links = JSON.parse(await readFile(file, 'utf8')).links || {}; } catch { /* first run */ } }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); saveTimer.unref?.(); }
  async function save() {
    try { await mkdir(dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify({ links })); }
    catch (e) { log.error('discord roles save failed', e.message); }
  }

  // Discord's REST API through the bot; waits out a 429 (up to 3 tries). Returns { ok, status, body }
  async function call(method, path, { body, auth = `Bot ${cfg.bot}`, form = false } = {}) {
    for (let i = 0; i < 3; i++) {
      const res = await http(`${API}${path}`, { method, headers: { authorization: auth, ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) }, body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(10000) });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (res.status === 429 && i < 2) { await sleep(Math.min(10000, 1000 * (Number(json?.retry_after) || 1))); continue; }
      return { ok: res.ok, status: res.status, body: json };
    }
    return { ok: false, status: 429, body: null };
  }
  const explain = (r) => (r.status === 403 ? 'the bot can\'t manage that role (it needs Manage Roles, and its own role above the members\' role)'
    : r.status === 404 ? 'not found (check DISCORD_GUILD_ID and DISCORD_ROLE_ID, and that the bot is in your server)'
    : r.status === 401 ? 'Discord rejected the bot token' : r.body?.message ? String(r.body.message).slice(0, 120) : `Discord said ${r.status}`);

  // Settings -> "Link Discord": Discord's sign-in page for this member
  function linkUrl(code) {
    if (!cfg.on || !code) return null;
    const now = clock();
    for (const [k, v] of states) if (now - v.at > STATE_TTL) states.delete(k);
    if (states.size > 5000) states.delete(states.keys().next().value);
    const state = crypto.randomBytes(18).toString('base64url');
    states.set(state, { code, at: now });
    return `https://discord.com/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, scope: 'identify guilds.join', redirect_uri: cfg.redirect, state, prompt: 'consent' })}`;
  }

  // Discord sent the member back: { ok, name } or { error }
  async function callback({ code: grant, state }) {
    const st = typeof state === 'string' && states.get(state);
    if (st) states.delete(state);
    if (!cfg.on) return { error: 'Discord linking is off on this server' };
    if (!st || clock() - st.at > STATE_TTL) return { error: 'That link expired. Tap "Link Discord" again.' };
    if (typeof grant !== 'string' || !grant || grant.length > 200) return { error: 'Discord didn\'t send a sign-in code' };
    const tok = await call('POST', '/oauth2/token', { auth: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString('base64')}`, form: true, body: { grant_type: 'authorization_code', code: grant, redirect_uri: cfg.redirect } });
    if (!tok.ok || !tok.body?.access_token) return { error: `Discord sign-in failed: ${tok.status === 401 ? 'check DISCORD_CLIENT_SECRET' : tok.body?.error_description || `status ${tok.status}`}` };
    const me = await call('GET', '/users/@me', { auth: `Bearer ${tok.body.access_token}` });
    if (!me.ok || !SNOWFLAKE.test(String(me.body?.id))) return { error: 'Couldn\'t read your Discord account' };
    const id = String(me.body.id), name = String(me.body.global_name || me.body.username || 'Discord user').slice(0, 64);
    // one Discord account per member code: linking it to a new code moves it (and takes the role off if that code isn't active)
    for (const [c, l] of Object.entries(links)) if (l.id === id && c !== st.code) delete links[c];
    const prev = links[st.code];
    if (prev && prev.id !== id && prev.role) await call('DELETE', `/guilds/${cfg.guild}/members/${prev.id}/roles/${cfg.role}`).catch(() => {});
    links[st.code] = { id, name, linkedAt: clock(), role: null, syncedAt: 0, error: null };
    // add them to the server if they aren't in it (with the role when they're active), then make the role right
    const join = await call('PUT', `/guilds/${cfg.guild}/members/${id}`, { body: { access_token: tok.body.access_token, ...(isActive(st.code) ? { roles: [cfg.role] } : {}) } }).catch((e) => ({ ok: false, status: 0, body: { message: e.message } }));
    if (!join.ok && join.status !== 204) links[st.code].error = `couldn't add you to the server: ${explain(join)}`;
    scheduleSave();
    await syncOne(st.code, true);
    return { ok: true, name, error: links[st.code]?.error ?? null };
  }

  // give or take the role for one member when it needs to change (force: check even if it looks right)
  async function syncOne(code, force = false) {
    const l = links[code];
    if (!cfg.on || !l) return null;
    const want = !!isActive(code);
    if (!force && l.role === want && !l.error) return l.role;
    const r = await call(want ? 'PUT' : 'DELETE', `/guilds/${cfg.guild}/members/${l.id}/roles/${cfg.role}`).catch((e) => ({ ok: false, status: 0, body: { message: e.message } }));
    // a member who left the server can't hold the role: that's in sync for a removal, and an error to show for a grant
    const gone = r.status === 404 && r.body?.code === 10007;
    if (r.ok || (gone && !want)) { l.role = want; l.error = null; }
    else l.error = gone ? 'you\'re not in the Discord server (tap Link Discord again to join)' : explain(r);
    l.syncedAt = clock();
    scheduleSave();
    return l.role;
  }
  // every linked member, one at a time (Discord's rate limits), at most one pass at once
  function syncAll(force = false) {
    if (!cfg.on) return Promise.resolve(0);
    if (syncing) return syncing;
    syncing = (async () => {
      let changed = 0;
      for (const code of Object.keys(links)) {
        const before = links[code]?.role;
        try { if ((await syncOne(code, force)) !== before) changed++; } catch (e) { log.error('discord role sync failed', e.message); }
      }
      return changed;
    })().finally(() => { syncing = null; });
    return syncing;
  }
  function start(everyMs = 600000) { if (!cfg.on || timer) return; timer = setInterval(() => syncAll(), everyMs); timer.unref?.(); setTimeout(() => syncAll(true), 5000).unref?.(); }
  function stop() { clearInterval(timer); timer = null; }

  async function unlink(code) {
    const l = links[code];
    if (!l) return { ok: true };
    if (cfg.on && l.role) await call('DELETE', `/guilds/${cfg.guild}/members/${l.id}/roles/${cfg.role}`).catch(() => {});
    delete links[code];
    scheduleSave();
    return { ok: true };
  }

  // what the member's phone sees (never the secrets)
  const status = (code) => {
    const l = code ? links[code] : null;
    return { on: cfg.on, ...(cfg.on ? {} : { missing: cfg.missing }), linked: l ? { name: l.name, role: l.role, error: l.error, syncedAt: l.syncedAt } : null };
  };
  // what an admin sees per member code: the Discord name and whether the role is on
  const adminView = () => Object.fromEntries(Object.entries(links).map(([c, l]) => [c, { name: l.name, role: l.role, error: l.error }]));
  return { load, save, linkUrl, callback, syncOne, syncAll, start, stop, unlink, status, adminView, config: () => ({ on: cfg.on, missing: cfg.missing }) };
}
