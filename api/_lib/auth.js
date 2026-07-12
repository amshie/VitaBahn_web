// Authentication + authorisation core.
//
// - Passwords: scrypt with a per-user salt (node:crypto, no dependency).
// - Sessions: stateless, HMAC-signed cookie carrying { sub, role, iat, exp }.
//   HttpOnly + SameSite=Lax + Secure (in prod). No secret URLs, no client-trusted
//   claims — the signature is verified on every request and the account is then
//   re-loaded from the database so revocation / expiry / level changes take effect
//   immediately (a still-valid cookie cannot outlive a revoked grant).
// - Separate cookie names per realm so the founder (Level 0) and investor sessions
//   are distinct trust boundaries.

import crypto from 'node:crypto';
import { parseCookies } from './http.js';
import { getInvestorById, getAdminById } from './store.js';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex'); // ephemeral fallback
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      'auth: SESSION_SECRET is unset — using an ephemeral per-instance secret. Sessions will not validate across instances/restarts. Set SESSION_SECRET in production.'
    );
  }
}

const SESSION_TTL_SEC = Number(process.env.SESSION_TTL_SEC || '43200'); // 12h default

// ----------------------------------------------------------- passwords
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 32);
  return `s1$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [v, saltHex, hashHex] = stored.split('$');
  if (v !== 's1' || !saltHex || !hashHex) return false;
  let salt, expected, dk;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
    dk = crypto.scryptSync(String(pw), salt, expected.length);
  } catch { return false; }
  return expected.length === dk.length && crypto.timingSafeEqual(expected, dk);
}

// ------------------------------------------------------------ sessions
function hmac(body) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
}

export function createSession(sub, role, ttlSec = SESSION_TTL_SEC) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, role, iat: now, exp: now + ttlSec };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(hmac(body))}`;
}

export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = b64url(hmac(body));
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// -------------------------------------------------------------- cookies
const COOKIE = { investor: 'vb_inv', admin: 'vb_adm' };
function secureAttr() {
  return process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

export function setSessionCookie(res, role, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE[role]}=${token}; HttpOnly${secureAttr()}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`
  );
}

export function clearSessionCookie(res, role) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE[role]}=; HttpOnly${secureAttr()}; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function sessionFrom(req, role) {
  const token = parseCookies(req)[COOKIE[role]];
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload || payload.role !== role) return null;
  return payload;
}

// ------------------------------------------------------------- guards
// Resolve + status-check the investor behind the request. investor is null on any
// failure, with `reason` naming it (unauthenticated | unknown | revoked | expired
// | no-access). The DB re-check here is what makes revocation/expiry immediate.
export async function loadInvestor(req) {
  const p = sessionFrom(req, 'investor');
  if (!p) return { investor: null, reason: 'unauthenticated' };
  const inv = await getInvestorById(p.sub);
  if (!inv) return { investor: null, reason: 'unknown' };
  if (inv.revoked) return { investor: null, reason: 'revoked' };
  if (inv.isExpired) return { investor: null, reason: 'expired' };
  if (!(inv.accessLevel >= 1)) return { investor: null, reason: 'no-access' };
  return { investor: inv };
}

export async function loadAdmin(req) {
  const p = sessionFrom(req, 'admin');
  if (!p) return { admin: null, reason: 'unauthenticated' };
  const admin = await getAdminById(p.sub);
  if (!admin) return { admin: null, reason: 'unknown' };
  return { admin };
}

export const cookieNames = COOKIE;
export const sessionTtlSec = SESSION_TTL_SEC;
