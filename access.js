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
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const normalizeCode = (c) => {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s ? `SC-${s.replace(/^SC/, '')}` : '';
};

export function createAccess({ file, env = process.env, log = console, clock = () => Date.now(), onPaid = () => {} }) {
  const adminHash = env.ADMIN_CODE ? sha(env.ADMIN_CODE.trim().toUpperCase()) : null;
  const db = {
    config: { price: Number(env.PAYWALL_PRICE || 20), days: Number(env.ACCESS_DAYS || 30), cashtag: (env.CASHTAG || 'Akizzle55').replace(/^\$/, '') },
    members: {}, // code -> { code, status: pending|active|denied|revoked, createdAt, paidAt, approvedAt, expires, tokens: [] }
    sessions: {}, // token -> { code, role: member|admin, at }
  };
  const attempts = new Map(); // `${kind}:${ip}` -> timestamps
  let saveTimer = null;

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(db.config, saved.config || {});
      db.members = saved.members || {};
      db.sessions = saved.sessions || {};
    } catch { /* first run */ }
    if (!adminHash) log.warn('ADMIN_CODE is not set: nobody can log in as admin to approve payments.');
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); }
  async function save() {
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(db));
      await rename(`${file}.tmp`, file);
    } catch (e) { log.error('access save failed', e.message); }
  }

  // Simple per-IP rate limit for code guessing and request spam.
  function limited(kind, ip, max, windowMs) {
    const key = `${kind}:${ip}`, t = clock();
    const list = (attempts.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) { attempts.set(key, list); return true; }
    list.push(t); attempts.set(key, list);
    if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
    return false;
  }

  function bind(code, role) {
    const token = newToken();
    db.sessions[token] = { code, role, at: clock() };
    const m = code && db.members[code];
    if (m) {
      m.tokens.push(token);
      while (m.tokens.length > MAX_DEVICES) delete db.sessions[m.tokens.shift()];
    }
    scheduleSave();
    return token;
  }

  function check(token) {
    const s = token && db.sessions[token];
    if (!s) return { access: false, role: null, member: null };
    if (s.role === 'admin') return { access: true, role: 'admin', member: null };
    const m = db.members[s.code];
    return { access: !!m && m.status === 'active' && m.expires > clock(), role: 'member', member: m || null };
  }

  function statusBody(token) {
    const { access, role, member } = check(token);
    return {
      access, role, ...db.config,
      code: member?.code ?? null, state: member ? (member.status === 'active' && member.expires <= clock() ? 'expired' : member.status) : null,
      expires: member?.expires ?? null, paidAt: member?.paidAt ?? null, approvedAt: member?.approvedAt ?? null, adminReady: !!adminHash,
    };
  }

  // ---------- public actions ----------
  // Start (or resume) a purchase: returns a code to put in the Cash App note.
  function request(token, ip) {
    const cur = check(token);
    if (cur.role === 'admin' || (cur.member && cur.member.status !== 'denied' && cur.member.status !== 'revoked')) return { status: 200, body: statusBody(token) };
    if (limited('request', ip, 5, 3600000)) return { status: 429, body: { error: 'Too many requests. Try again later.' } };
    if (Object.values(db.members).filter((m) => m.status === 'pending').length >= 1000) return { status: 503, body: { error: 'Too many pending payments. Try again later.' } };
    let code;
    do code = newCode(); while (db.members[code]);
    db.members[code] = { code, status: 'pending', createdAt: clock(), paidAt: null, approvedAt: null, expires: 0, tokens: [] };
    const t = bind(code, 'member');
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
  function redeem(code, ip) {
    if (limited('redeem', ip, 10, 900000)) return { status: 429, body: { error: 'Too many tries. Wait 15 minutes.' } };
    const m = db.members[normalizeCode(code)];
    if (!m || m.status === 'denied' || m.status === 'revoked') return { status: 404, body: { error: 'Code not found' } };
    const t = bind(m.code, 'member');
    return { status: 200, token: t, body: statusBody(t) };
  }

  function admin(code, ip) {
    if (limited('admin', ip, 8, 900000)) return { status: 429, body: { error: 'Too many tries. Wait 15 minutes.' } };
    if (!adminHash) return { status: 503, body: { error: 'Admin code is not set up on the server (ADMIN_CODE).' } };
    if (!crypto.timingSafeEqual(sha(String(code || '').trim().toUpperCase()), adminHash)) return { status: 403, body: { error: 'Wrong admin code' } };
    const t = bind(null, 'admin');
    return { status: 200, token: t, body: statusBody(t) };
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
  const approve = ({ code, days }) => setStatus(code, (m) => {
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
  return { load, save, check, statusBody, request, paid, redeem, admin, logout, listMembers, approve, deny, revoke, setConfig, prune, isAdminToken, hasAccess, config: db.config };
}
