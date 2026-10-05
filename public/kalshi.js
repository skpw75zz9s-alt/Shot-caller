// Link to a Kalshi account with a Kalshi API key, done entirely on the phone. Reading fills and balance;
// orders are placed only by live auto-trading (autotrade.js), which the user turns on with explicit limits.
// Kalshi signs API requests with the key: signature = sign(timestamp + METHOD + path), RSA-PSS for
// RSA keys and Ed25519 for the newer short keys ("MC4CAQAwBQYDK2Vw…"). The private key
// is imported as a non-extractable WebCrypto key, so after linking even this app's own code can't read
// it back out, and it never leaves the device. The server forwards signed portfolio reads, and order POSTs only
// after checking them (server.js validateOrder).

const b64 = (bytes) => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

// DER helpers for wrapping a PKCS#1 key ("BEGIN RSA PRIVATE KEY", what Kalshi hands out) as PKCS#8.
function derLen(n) {
  if (n < 0x80) return [n];
  const out = []; while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}
const der = (tag, body) => Uint8Array.from([tag, ...derLen(body.length), ...body]);
const RSA_ALG_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption, NULL

// PEM (PKCS#1 or PKCS#8) -> PKCS#8 DER bytes
export function pemToPkcs8(pem) {
  const text = String(pem || '').trim();
  const m = text.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/);
  if (!m) throw new Error('That doesn\'t look like a Kalshi private key (it starts with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----)');
  const body = unb64(m[2].replace(/[^A-Za-z0-9+/=]/g, ''));
  if (!m[1]) return body;
  return der(0x30, [0x02, 0x01, 0x00, ...RSA_ALG_ID, ...der(0x04, body)]);
}

// Which kind of key a PKCS#8 blob holds, from its algorithm OID.
const ED25519_OID = [0x06, 0x03, 0x2b, 0x65, 0x70];
const hasBytes = (buf, seq) => { for (let i = 0; i + seq.length <= Math.min(buf.length, 32); i++) if (seq.every((x, j) => buf[i + j] === x)) return true; return false; };
export const keyType = (pkcs8) => (hasBytes(pkcs8, ED25519_OID) ? 'Ed25519' : 'RSA-PSS');

export async function importKey(pem, subtle = globalThis.crypto.subtle) {
  const der = pemToPkcs8(pem);
  const type = keyType(der);
  try {
    return type === 'Ed25519'
      ? await subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
      : await subtle.importKey('pkcs8', der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
  } catch (e) {
    if (type === 'Ed25519' && /not supported|unrecognized|algorithm/i.test(`${e.name} ${e.message}`)) {
      throw new Error('This browser can\'t use Kalshi\'s Ed25519 keys yet. Update iOS/Safari or Chrome and try again.');
    }
    throw new Error('Couldn\'t read that private key. Paste the whole file Kalshi gave you, including the BEGIN/END lines.');
  }
}

// Headers for one Kalshi request. `path` is the full API path without the query, e.g. /trade-api/v2/portfolio/fills
export async function signHeaders(key, keyId, method, path, ts = Date.now(), subtle = globalThis.crypto.subtle) {
  const msg = new TextEncoder().encode(`${ts}${method}${path}`);
  const alg = key.algorithm.name === 'Ed25519' ? { name: 'Ed25519' } : { name: 'RSA-PSS', saltLength: 32 };
  const sig = new Uint8Array(await subtle.sign(alg, key, msg));
  return { 'x-kalshi-key': keyId, 'x-kalshi-ts': String(ts), 'x-kalshi-sig': b64(sig) };
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// Dollars from a *_dollars field, or from the older cents field
const dollarsOf = (o, k) => num(o[`${k}_dollars`]) ?? (num(o[k]) != null ? num(o[k]) / 100 : null);

// Which outcome a fill is on. Newer fills say it in outcome_side ("yes"/"no"); their side field can be the book side
// ("bid"/"ask"), which used to be read as YES every time. Older fills say yes/no in side.
function fillSide(f) {
  const os = String(f.outcome_side || '').toLowerCase(), sd = String(f.side || '').toLowerCase();
  if (os === 'yes' || os === 'no') return os.toUpperCase();
  if (sd === 'yes' || sd === 'no') return sd.toUpperCase();
  const book = String(f.book_side || sd).toLowerCase(); // V2 book only: buying on the bid is YES, on the ask is NO
  return book === 'ask' ? 'NO' : 'YES';
}

// One Kalshi fill -> { id, ticker, side, action, count, price (dollars, for that side), fee (dollars Kalshi charged), at (ms) }.
// Handles both the cents fields (yes_price) and the newer *_dollars / *_fp fields.
export function parseFill(f) {
  const side = fillSide(f);
  const pick = (k) => num(f[`${k}_dollars`]) ?? (num(f[k]) != null ? num(f[k]) / 100 : null);
  const price = side === 'YES' ? pick('yes_price') ?? (pick('no_price') != null ? 1 - pick('no_price') : null)
    : pick('no_price') ?? (pick('yes_price') != null ? 1 - pick('yes_price') : null);
  const count = num(f.count_fp) ?? num(f.count);
  const at = Date.parse(f.created_time) || (num(f.ts) ? num(f.ts) * 1000 : null);
  const action = String(f.action || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const fee = num(f.fee_cost_dollars) ?? num(f.fee_cost); // the exact fee Kalshi charged (a dollars string)
  return { id: String(f.fill_id ?? f.trade_id ?? `${f.order_id}-${at}-${count}`), ticker: String(f.ticker || f.market_ticker || ''), side, action, count, price: price == null ? null : Math.round(price * 10000) / 10000, fee: fee == null || Number.isNaN(fee) ? null : fee, orderId: f.order_id ?? null, at };
}

// Apply fills (oldest first) to holdings { [ticker]: { side, contracts, price, at } }.
// Returns the new holdings, the closes (partial or full sales) and which tickers opened or grew.
// Kalshi nets the two sides: buying NO while holding YES closes YES at 1 − price (and vice versa), and
// selling a side you don't hold opens the other side.
export function foldFills(holdings, fills) {
  const h = structuredClone(holdings);
  const closes = [], touched = new Set();
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    if (!f.ticker || !(f.count > 0) || f.price == null) continue;
    let side = f.side, price = f.price, buying = f.action === 'buy';
    const cur = h[f.ticker];
    if (!buying && (!cur || cur.side !== side)) { buying = true; side = side === 'YES' ? 'NO' : 'YES'; price = Math.round((1 - price) * 10000) / 10000; }
    let left = f.count;
    // Kalshi's actual fees: each close carries its share of the entry fees and of the closing fill's fee
    const feeShare = (n) => (f.fee == null ? null : f.fee * n / f.count);
    const close = (n, exit) => {
      const entryFees = cur.fees == null ? null : cur.fees * n / cur.contracts, exitFees = feeShare(n);
      closes.push({ ticker: f.ticker, side: cur.side, contracts: n, entry: cur.price, entryAt: cur.at, exit, at: f.at,
        fees: entryFees == null || exitFees == null ? null : Math.round((entryFees + exitFees) * 10000) / 10000 });
      if (cur.fees != null) cur.fees -= entryFees;
      cur.contracts -= n;
      if (cur.contracts <= 1e-9) delete h[f.ticker];
    };
    if (cur && cur.side !== side && buying) { // opposite side closes what's held
      const n = Math.min(left, cur.contracts);
      close(n, Math.round((1 - price) * 10000) / 10000); left -= n;
    } else if (cur && !buying) { // selling the held side
      close(Math.min(left, cur.contracts), price); left = 0;
    }
    if (left > 1e-9 && buying) {
      const pos = h[f.ticker], fee = feeShare(left);
      if (pos && pos.side === side) {
        pos.price = Math.round(((pos.price * pos.contracts + price * left) / (pos.contracts + left)) * 10000) / 10000; pos.contracts += left;
        pos.fees = pos.fees == null || fee == null ? null : pos.fees + fee;
      } else h[f.ticker] = { side, contracts: left, price, at: f.at, fees: fee };
      touched.add(f.ticker);
    }
  }
  return { holdings: h, closes, touched: [...touched] };
}

// Kalshi balance response -> dollars
export const balanceDollars = (b) => num(b?.balance_dollars) ?? (num(b?.balance) != null ? num(b.balance) / 100 : null);

// ---------- Kalshi's own records (the source of truth) ----------
// GET /portfolio/positions -> { ticker, side, contracts, cost (dollars), realized, fees }. position_fp: + YES, - NO.
export function parsePosition(p) {
  const pos = num(p.position_fp) ?? num(p.position) ?? 0;
  const cost = dollarsOf(p, 'market_exposure');
  return { ticker: String(p.ticker || p.market_ticker || ''), side: pos < 0 ? 'NO' : 'YES', contracts: Math.abs(pos),
    cost: cost == null ? null : Math.abs(cost), realized: dollarsOf(p, 'realized_pnl'), fees: dollarsOf(p, 'fees_paid'), resting: num(p.resting_orders_count) ?? 0 };
}

// GET /portfolio/settlements -> { ticker, result, yes, no, cost, revenue, fees, at }
export function parseSettlement(s) {
  const fee = num(s.fee_cost_dollars) ?? num(s.fee_cost);
  return { ticker: String(s.ticker || s.market_ticker || ''), result: String(s.market_result || '').toLowerCase(),
    yes: num(s.yes_count_fp) ?? num(s.yes_count) ?? 0, no: num(s.no_count_fp) ?? num(s.no_count) ?? 0,
    cost: (dollarsOf(s, 'yes_total_cost') ?? 0) + (dollarsOf(s, 'no_total_cost') ?? 0), revenue: dollarsOf(s, 'revenue'),
    fees: fee == null || Number.isNaN(fee) ? null : fee, at: Date.parse(s.settled_time) || null };
}

// GET /portfolio/orders -> { id, clientId, ticker, status, filled, remaining, cost, fees, avgPrice (dollars per contract) }
export function parseOrder(o) {
  const filled = num(o.fill_count_fp) ?? num(o.fill_count);
  const remaining = num(o.remaining_count_fp) ?? num(o.remaining_count);
  const tc = dollarsOf(o, 'taker_fill_cost'), mc = dollarsOf(o, 'maker_fill_cost');
  const tf = dollarsOf(o, 'taker_fees'), mf = dollarsOf(o, 'maker_fees');
  const cost0 = tc == null && mc == null ? null : (tc ?? 0) + (mc ?? 0);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const fees = tf == null && mf == null ? null : r4((tf ?? 0) + (mf ?? 0)), cost = cost0 == null ? null : r4(cost0);
  return { id: o.order_id ?? null, clientId: o.client_order_id ?? null, ticker: String(o.ticker || ''), status: o.status ? String(o.status).toLowerCase() : null,
    filled, remaining, cost, fees, avgPrice: filled > 0 && cost != null ? Math.round((cost / filled) * 10000) / 10000 : null };
}

// Compare the app's Kalshi positions with Kalshi's own list. Kalshi wins. Returns the corrections to make.
// Positions the app added after `asOf` (newer than Kalshi's answer) are left alone.
export function reconcilePositions(app, kalshi, { series, asOf = Date.now() } = {}) {
  const truth = new Map(kalshi.filter((k) => k.ticker.startsWith(`${series}-`) && k.contracts > 0).map((k) => [k.ticker, k]));
  const set = [], remove = [], add = [];
  for (const p of app) {
    if (p.source !== 'kalshi') continue;
    const k = truth.get(p.ticker);
    if (!k) { if (!(p.at > asOf)) remove.push({ ticker: p.ticker, why: `Kalshi shows no ${p.side} position (app had ${p.contracts})` }); continue; }
    const avg0 = k.cost != null && k.contracts > 0 ? Math.round((k.cost / k.contracts) * 10000) / 10000 : null;
    const avg = avg0 != null && avg0 > 0 && avg0 < 1 ? avg0 : null; // a contract always costs between 0 and $1
    const same = k.side === p.side && Math.abs(k.contracts - p.contracts) < 1e-9;
    // keep the app's exact fill price when Kalshi agrees on the holding; otherwise take Kalshi's average cost
    const price = same && (avg == null || Math.abs(avg - p.price) < 0.01) ? p.price : avg ?? p.price;
    if (!same || price !== p.price) set.push({ ticker: p.ticker, side: k.side, contracts: k.contracts, price, why: same ? `average price ${Math.round(p.price * 1000) / 10}¢ → ${Math.round(price * 1000) / 10}¢` : `${p.contracts} ${p.side} → ${k.contracts} ${k.side}` });
    truth.delete(p.ticker);
  }
  for (const k of truth.values()) {
    const avg = k.cost != null ? Math.round((k.cost / k.contracts) * 10000) / 10000 : null;
    add.push({ ticker: k.ticker, side: k.side, contracts: k.contracts, price: avg > 0 && avg < 1 ? avg : null, why: `Kalshi shows ${k.contracts} ${k.side} the app didn't have` });
  }
  return { set, remove, add };
}
