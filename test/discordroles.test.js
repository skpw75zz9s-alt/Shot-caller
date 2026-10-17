import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscordRoles, discordConfig } from '../discordroles.js';

const ENV = { DISCORD_CLIENT_ID: '111111111111', DISCORD_CLIENT_SECRET: 'shh', DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: '222222222222', DISCORD_ROLE_ID: '333333333333' };
const quiet = { log() {}, error() {} };
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (body == null ? '' : JSON.stringify(body)) });

// a fake Discord: records every call, answers like the real API
function fakeDiscord({ inGuild = false, roleStatus = 204 } = {}) {
  const calls = [];
  const fetch = async (url, o) => {
    const path = url.replace('https://discord.com/api/v10', ''), auth = o.headers.authorization;
    calls.push({ method: o.method, path, auth, body: o.body });
    if (path === '/oauth2/token') return auth.startsWith('Basic ') && /code=grant/.test(o.body) ? res(200, { access_token: 'user-at' }) : res(401, { error: 'invalid_client' });
    if (path === '/users/@me') return auth === 'Bearer user-at' ? res(200, { id: '444444444444', username: 'trader', global_name: 'Trader Joe' }) : res(401, {});
    if (/^\/guilds\/\d+\/members\/\d+$/.test(path)) { const was = inGuild; inGuild = true; return res(was ? 204 : 201, was ? null : { user: {} }); }
    if (/\/roles\/\d+$/.test(path)) return roleStatus === 404 ? res(404, { code: 10007, message: 'Unknown Member' }) : res(roleStatus, roleStatus === 204 ? null : { message: 'Missing Permissions' });
    return res(404, {});
  };
  return { fetch, calls };
}
const make = (opts = {}) => {
  const d = fakeDiscord(opts), active = new Set(opts.active ?? ['SC-AAAAAA']);
  const r = createDiscordRoles({ file: join(mkdtempSync(join(tmpdir(), 'dr-')), 'd.json'), env: ENV, base: 'https://app.example', isActive: (c) => active.has(c), fetch: d.fetch, log: quiet, sleep: async () => {} });
  return { r, d, active };
};
const stateOf = (url) => new URL(url).searchParams.get('state');

test('discord config: off until every variable is set, and says which are missing', () => {
  const off = discordConfig({}, null);
  assert.equal(off.on, false);
  assert.ok(off.missing.includes('DISCORD_BOT_TOKEN') && off.missing.includes('DISCORD_REDIRECT_URI or APP_URL'));
  const on = discordConfig(ENV, 'https://app.example');
  assert.equal(on.on, true); assert.equal(on.redirect, 'https://app.example/api/discord/callback');
  assert.equal(discordConfig({ ...ENV, DISCORD_GUILD_ID: 'abc' }, 'https://x.y').on, false, 'ids must be Discord snowflakes');
});

test('link: Discord sign-in, then joined to the server with the role; the secrets never reach the phone', async () => {
  const { r, d } = make();
  const url = r.linkUrl('SC-AAAAAA');
  assert.match(url, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  const q = new URL(url).searchParams;
  assert.equal(q.get('scope'), 'identify guilds.join'); assert.equal(q.get('redirect_uri'), 'https://app.example/api/discord/callback');
  assert.ok(!url.includes('shh') && !url.includes('bot-token'));
  const out = await r.callback({ code: 'grant', state: stateOf(url) });
  assert.deepEqual(out, { ok: true, name: 'Trader Joe', error: null });
  const join = d.calls.find((c) => c.method === 'PUT' && /members\/444444444444$/.test(c.path));
  assert.deepEqual(JSON.parse(join.body), { access_token: 'user-at', roles: ['333333333333'] });
  assert.equal(join.auth, 'Bot bot-token');
  const st = r.status('SC-AAAAAA');
  assert.equal(st.linked.role, true); assert.equal(st.linked.name, 'Trader Joe');
  assert.ok(!JSON.stringify(st).includes('bot-token') && !JSON.stringify(st).includes('shh'));
  assert.equal((await r.callback({ code: 'grant', state: stateOf(url) })).error.includes('expired'), true, 'a state works once');
});

test('sync: the role follows access, and only changes when it needs to', async () => {
  const { r, d, active } = make();
  await r.callback({ code: 'grant', state: stateOf(r.linkUrl('SC-AAAAAA')) });
  const n = d.calls.length;
  assert.equal(await r.syncAll(), 0); assert.equal(d.calls.length, n, 'already right: no calls');
  active.delete('SC-AAAAAA'); // expired or revoked
  assert.equal(await r.syncAll(), 1);
  assert.equal(d.calls.at(-1).method, 'DELETE'); assert.equal(r.status('SC-AAAAAA').linked.role, false);
  active.add('SC-AAAAAA'); // renewed
  await r.syncOne('SC-AAAAAA');
  assert.equal(d.calls.at(-1).method, 'PUT'); assert.equal(r.status('SC-AAAAAA').linked.role, true);
  await r.unlink('SC-AAAAAA');
  assert.equal(d.calls.at(-1).method, 'DELETE'); assert.equal(r.status('SC-AAAAAA').linked, null);
});

test('sync: Discord errors are explained, a member who left counts as removed', async () => {
  const bad = make({ roleStatus: 403 });
  await bad.r.callback({ code: 'grant', state: stateOf(bad.r.linkUrl('SC-AAAAAA')) });
  assert.match(bad.r.status('SC-AAAAAA').linked.error, /Manage Roles/);
  const left = make({ roleStatus: 404, active: [] });
  await left.r.callback({ code: 'grant', state: stateOf(left.r.linkUrl('SC-AAAAAA')) });
  assert.equal(left.r.status('SC-AAAAAA').linked.role, false); assert.equal(left.r.status('SC-AAAAAA').linked.error, null);
});

test('link: bad state, bad grant, and off without config', async () => {
  const { r } = make();
  assert.match((await r.callback({ code: 'grant', state: 'made-up' })).error, /expired/);
  assert.match((await r.callback({ code: 'nope', state: stateOf(r.linkUrl('SC-AAAAAA')) })).error, /DISCORD_CLIENT_SECRET/);
  const off = createDiscordRoles({ file: join(mkdtempSync(join(tmpdir(), 'dr-')), 'd.json'), env: {}, log: quiet });
  assert.equal(off.linkUrl('SC-AAAAAA'), null); assert.equal(off.status('SC-AAAAAA').on, false);
  assert.equal(await off.syncAll(), 0);
});

test('one Discord account per member: relinking it to another code moves it', async () => {
  const { r } = make({ active: ['SC-AAAAAA', 'SC-BBBBBB'] });
  await r.callback({ code: 'grant', state: stateOf(r.linkUrl('SC-AAAAAA')) });
  await r.callback({ code: 'grant', state: stateOf(r.linkUrl('SC-BBBBBB')) });
  assert.equal(r.status('SC-AAAAAA').linked, null); assert.equal(r.status('SC-BBBBBB').linked.name, 'Trader Joe');
  assert.deepEqual(Object.keys(r.adminView()), ['SC-BBBBBB']);
});
