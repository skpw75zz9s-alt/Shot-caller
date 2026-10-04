// Cash App paywall. Cash App has no API for personal $cashtags, so payments are verified by an
// admin: each buyer gets a code to put in the payment note, taps "I've paid", and an admin
// approves the code. Access is a server-side session cookie, so nothing is unlocked client-side.
import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const DAY = 86400000;
const MAX_DEVICES = 3; // devices that can share one paid code
const newCode = () => `SC-${Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
const newToken = () => crypto.randomBytes(24).toString('base64url');
// Admin bypass code. Only a slow scrypt hash is stored here (the repo is public), never the code
// itself. The ADMIN_CODE environment variable overrides it.
const DEFAULT_ADMIN = { salt: '8476f77c1ce5b79880664029ca7417ab', hash: '19f904f31dafbea22a54a1b5eaedbb4c17214282544fa1b295146c57e5fc5555' };
const kdf = (code, salt) => crypto.scryptSync(String(code || '').trim().toUpperCase(), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
const CODE_RE = /^SC-[A-HJ-NP-Z2-9]{6}$/;
const cleanDevice = (d) => (typeof d === 'string' && d ? d.slice(0, 64) : null);
export const normalizeCode = (c) => {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s ? `SC-${s.replace(/^SC/, '')}` : '';
};

export function createAccess({ file, env = process.env, log = console, clock = () => Date.now(), onPaid = () => {} }) {
  const adminSalt = env.ADMIN_CODE ? crypto.randomBytes(16).toString('hex') : DEFAULT_ADMIN.salt;
  const adminHash = env.ADMIN_CODE ? kdf(env.ADMIN_CODE, adminSalt) : Buffer.from(DEFAULT_ADMIN.hash, 'hex');
  const isAdminCode = (code) => !!String(code || '').trim() && crypto.timingSafeEqual(kdf(code, adminSalt), adminHash);
  const db = {
    config: { price: Number(env.PAYWALL_PRICE || 20), days: Number(env.ACCESS_DAYS || 30), cashtag: (env.CASHTAG || 'Akizzle55').replace(/^\$/, '') },
    members: {}, // code -> { code, status: pending|active|denied|revoked, createdAt, paidAt, approvedAt, expires, tokens: [] }
    sessions: {}, // token -> { code, role: member|admin, device, at }
    secret: null, // only used when no ACCESS_SECRET / Railway IDs are available
  };
  // Signed access passes let a phone get back in after the server forgets it (redeploy without a
  // volume) or the phone loses its cookie. The signing secret must survive redeploys, so it comes
  // from ACCESS_SECRET, else Railway's stable project/service IDs (not in the public repo), else
  // a random secret saved with the data.
  let passKey = null;
  const adminFp = crypto.createHash('sha256').update(adminHash).digest('hex').slice(0, 12); // changes if the admin code changes
  const attempts = new Map(); // `${kind}:${ip}` -> timestamps
  let saveTimer = null;

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(db.config, saved.config || {});
      db.members = saved.members || {};
      db.sessions = saved.sessions || {};
      db.secret = saved.secret || null;
    } catch { /* first run */ }
    const envSecret = env.ACCESS_SECRET || (env.RAILWAY_PROJECT_ID && env.RAILWAY_SERVICE_ID ? `${env.RAILWAY_PROJECT_ID}:${env.RAILWAY_SERVICE_ID}` : null);
    if (!envSecret && !db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); scheduleSave(); }
    passKey = crypto.createHash('sha256').update(`shot-caller-pass:${envSecret || db.secret}`).digest();
    if (!env.ADMIN_CODE) log.log?.('Admin bypass: using the built-in admin code (set ADMIN_CODE to change it).');
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); }
  async function save() {
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(db));
      await rename(`${file}.tmp`, file);
    } catch (e) { log.error('access save failed', e.message); }
  }

  // Simple per-IP rate limit for code guessing and request spam. `blocked` only looks;
  // `strike` records an attempt (for guessing, only wrong codes are recorded).
  function blocked(kind, ip, max, windowMs) {
    const t = clock();
    const list = (attempts.get(`${kind}:${ip}`) || []).filter((x) => t - x < windowMs);
    attempts.set(`${kind}:${ip}`, list);
    return list.length >= max;
  }
  function strike(kind, ip) {
    const key = `${kind}:${ip}`;
    attempts.set(key, [...(attempts.get(key) || []), clock()]);
    if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
  }
  function limited(kind, ip, max, windowMs) {
    if (blocked(kind, ip, max, windowMs)) return true;
    strike(kind, ip);
    return false;
  }

  // New session for a phone. Signing in again on the same device replaces its old session
  // instead of using up another of the code's device slots.
  function bind(code, role, device) {
    const token = newToken();
    const dev = cleanDevice(device);
    const m = code && db.members[code];
    if (m && dev) {
      for (const t of m.tokens.filter((x) => db.sessions[x]?.device === dev)) delete db.sessions[t];
      m.tokens = m.tokens.filter((x) => db.sessions[x]);
    }
    if (!m && dev && role === 'admin') {
      for (const [t, s] of Object.entries(db.sessions)) if (s.role === 'admin' && s.device === dev) delete db.sessions[t];
    }
    db.sessions[token] = { code, role, device: dev, at: clock() };
    if (m) {
      m.tokens.push(token);
      while (m.tokens.length > MAX_DEVICES) delete db.sessions[m.tokens.shift()];
    }
    scheduleSave();
    return token;
  }

  // ---------- signed passes ----------
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', passKey).update(body).digest('base64url').slice(0, 32)}`;
  }
  function verify(pass) {
    if (typeof pass !== 'string' || pass.length > 600) return null;
    const [body, mac] = pass.split('.');
    if (!body || !mac) return null;
    const good = crypto.createHmac('sha256', passKey).update(body).digest('base64url').slice(0, 32);
    if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  }
  const passFor = ({ access, role, member }) => (!access ? null
    : role === 'admin' ? sign({ t: 'a', f: adminFp, e: clock() + 365 * DAY })
    : sign({ t: 'm', c: member.code, e: member.expires }));

  function check(token) {
    const s = token && db.sessions[token];
    if (!s) return { access: false, role: null, member: null };
    if (s.role === 'admin') return { access: true, role: 'admin', member: null };
    const m = db.members[s.code];
    return { access: !!m && m.status === 'active' && m.expires > clock(), role: 'member', member: m || null };
  }

  function statusBody(token) {
    const cur = check(token);
    const { access, role, member } = cur;
    return {
      pass: passFor(cur),
      access, role, ...db.config,
      code: member?.code ?? null, state: member ? (member.status === 'active' && member.expires <= clock() ? 'expired' : member.status) : null,
      expires: member?.expires ?? null, paidAt: member?.paidAt ?? null, approvedAt: member?.approvedAt ?? null,
    };
  }

  // ---------- public actions ----------
  // Start (or resume) a purchase: returns a code to put in the Cash App note.
  // `wanted` lets a phone that remembers its code (from before the server forgot it) get the same one back.
  function request(token, ip, wanted, device) {
    const cur = check(token);
    if (cur.role === 'admin' || (cur.member && cur.member.status !== 'denied' && cur.member.status !== 'revoked')) return { status: 200, body: statusBody(token) };
    if (limited('request', ip, 5, 3600000)) return { status: 429, body: { error: 'Too many requests. Try again later.' } };
    if (Object.values(db.members).filter((m) => m.status === 'pending').length >= 1000) return { status: 503, body: { error: 'Too many pending payments. Try again later.' } };
    let code = normalizeCode(wanted);
    if (!CODE_RE.test(code) || db.members[code]) do code = newCode(); while (db.members[code]);
    db.members[code] = { code, status: 'pending', createdAt: clock(), paidAt: null, approvedAt: null, expires: 0, tokens: [] };
    const t = bind(code, 'member', device);
    return { status: 200, token: t, body: statusBody(t) };
  }

  // Buyer says they've sent the Cash App payment: flag it for an admin.
  function paid(token) {
    const { member } = check(token);
    if (!member) return { status: 400, body: { error: 'No purchase started' } };
    // Notify admins on the first claim, and again on a renewal after the last approval
    const first = !member.paidAt || (member.approvedAt && member.paidAt <= member.approvedAt);
    member.paidAt = clock();
    scheduleSave();
    if (first) onPaid(member, db.config);
    return { status: 200, body: statusBody(token) };
  }

  // Use a paid code on another device (or the Home Screen app, which has its own cookies on iPhone).
  // The admin code works here too, so admins can't type it in the "wrong" box.
  function redeem(code, ip, device) {
    if (blocked('redeem', ip, 10, 900000)) return { status: 429, body: { error: 'Too many tries. Wait 15 minutes.' } };
    if (!blocked('admin', ip, 8, 900000) && isAdminCode(code)) return adminSession(device);
    const m = db.members[normalizeCode(code)];
    if (!m || m.status === 'denied' || m.status === 'revoked') { strike('redeem', ip); return { status: 404, body: { error: 'Code not found' } }; }
    const t = bind(m.code, 'member', device);
    return { status: 200, token: t, body: statusBody(t) };
  }

  // Get back in with a saved pass (phone lost its cookie, or the server lost its data).
  function restore(pass, ip, device) {
    if (blocked('redeem', ip, 10, 900000)) return { status: 429, body: { error: 'Too many tries. Wait 15 minutes.' } };
    const p = verify(pass);
    if (!p || !(p.e > clock())) { strike('redeem', ip); return { status: 401, body: { error: 'Saved access is no longer valid' } }; }
    if (p.t === 'a') return p.f === adminFp ? adminSession(device) : { status: 401, body: { error: 'Admin code changed: enter it again' } };
    if (p.t !== 'm' || !CODE_RE.test(p.c)) return { status: 401, body: { error: 'Saved access is no longer valid' } };
    let m = db.members[p.c];
    if (m && (m.status === 'revoked' || m.status === 'denied')) return { status: 403, body: { error: 'Access was revoked' } };
    if (!m) m = db.members[p.c] = { code: p.c, status: 'active', createdAt: clock(), paidAt: null, approvedAt: clock(), expires: p.e, tokens: [], restored: true };
    else if (m.status !== 'active' || m.expires < p.e) { m.status = 'active'; m.expires = Math.max(m.expires || 0, p.e); }
    const t = bind(m.code, 'member', device);
    return { status: 200, token: t, body: statusBody(t) };
  }

  function adminSession(device) {
    const t = bind(null, 'admin', device);
    return { status: 200, token: t, body: statusBody(t) };
  }
  function admin(code, ip, device) {
    if (blocked('admin', ip, 8, 900000)) return { status: 429, body: { error: 'Too many wrong codes. Wait 15 minutes.' } };
    if (!isAdminCode(code)) { strike('admin', ip); return { status: 403, body: { error: 'Wrong admin code' } }; }
    return adminSession(device);
  }

  function logout(token) {
    const s = token && db.sessions[token];
    if (s) {
      const m = s.code && db.members[s.code];
      if (m) m.tokens = m.tokens.filter((x) => x !== token);
      delete db.sessions[token];
      scheduleSave();
    }
    return { status: 200, body: { ok: true } };
  }

  // ---------- admin actions ----------
  const listMembers = () => ({
    status: 200,
    body: { config: db.config, members: Object.values(db.members).sort((a, b) => (b.paidAt || b.createdAt) - (a.paidAt || a.createdAt)).map(({ tokens, ...m }) => ({ ...m, devices: tokens.length })) },
  });
  function setStatus(code, fn) {
    const m = db.members[normalizeCode(code)];
    if (!m) return { status: 404, body: { error: 'Code not found' } };
    fn(m);
    scheduleSave();
    return { status: 200, body: { ok: true, member: { ...m, tokens: undefined, devices: m.tokens.length } } };
  }
  // Approving a code the server no longer knows (data wiped before approval) recreates it.
  const approve = ({ code, days }) => {
    const c = normalizeCode(code);
    if (!db.members[c] && CODE_RE.test(c)) db.members[c] = { code: c, status: 'pending', createdAt: clock(), paidAt: null, approvedAt: null, expires: 0, tokens: [] };
    return approveExisting({ code: c, days });
  };
  const approveExisting = ({ code, days }) => setStatus(code, (m) => {
    const d = Number(days) > 0 ? Number(days) : db.config.days;
    m.status = 'active';
    m.approvedAt = clock();
    m.expires = Math.max(clock(), m.expires || 0) + d * DAY;
  });
  const deny = ({ code }) => setStatus(code, (m) => { m.status = 'denied'; });
  const revoke = ({ code }) => setStatus(code, (m) => {
    m.status = 'revoked';
    m.expires = clock();
    for (const t of m.tokens) delete db.sessions[t];
    m.tokens = [];
  });
  function setConfig({ price, days }) {
    if (Number(price) > 0 && Number(price) <= 10000) db.config.price = Math.round(Number(price) * 100) / 100;
    if (Number(days) >= 1 && Number(days) <= 3650) db.config.days = Math.round(Number(days));
    scheduleSave();
    return { status: 200, body: { config: db.config } };
  }

  // Drop unpaid requests after 7 days and sessions that point nowhere.
  function prune() {
    const t = clock();
    for (const [c, m] of Object.entries(db.members)) {
      if (m.status === 'pending' && !m.paidAt && t - m.createdAt > 7 * DAY) delete db.members[c];
    }
    for (const [tok, s] of Object.entries(db.sessions)) if (s.role !== 'admin' && !db.members[s.code]) delete db.sessions[tok];
    scheduleSave();
  }

  const isAdminToken = (token) => check(token).role === 'admin';
  const hasAccess = (token) => check(token).access;
  return { load, save, check, statusBody, request, paid, redeem, restore, admin, logout, listMembers, approve, deny, revoke, setConfig, prune, isAdminToken, hasAccess, config: db.config };
}
