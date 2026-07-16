// Failed-attempt throttle for the authentication endpoints (admin + investor login).
//
// Online password-guessing / credential-stuffing control. It counts ONLY failed
// attempts, keyed on (realm + client IP + email), and is cleared on any successful
// authentication — so a legitimate user who signs in correctly is never throttled;
// only repeated failures against the same account from the same source trip a 429.
//
// Best-effort and per-instance, exactly like the in-memory limiters already used by
// api/lead.js, api/access-request.js and api/auth/forgot-password.js: on serverless
// each cold instance keeps its own Map, so a distributed attacker is only partially
// throttled. Provision a durable store (Vercel KV / Upstash) for cross-instance
// enforcement — see README / .env.example.

const ATTEMPTS = new Map(); // key -> { n, exp(ms epoch) }

const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 10);
const WINDOW_SEC = Number(process.env.LOGIN_WINDOW_SEC || 900); // 15 minutes

function current(key) {
  const e = ATTEMPTS.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) { ATTEMPTS.delete(key); return null; }
  return e;
}

// Build the throttle key. Email is lower-cased/normalised by the caller already.
export function loginKey(realm, ip, email) {
  return `${realm}:${ip || 'unknown'}:${email || 'unknown'}`;
}

// True once this key has reached the failure threshold within the window.
export function loginBlocked(key) {
  const e = current(key);
  return !!(e && e.n >= MAX_FAILS);
}

// Record one failed attempt. Returns the Retry-After hint in seconds.
export function loginFailed(key) {
  const now = Date.now();
  const e = current(key) || { n: 0, exp: now + WINDOW_SEC * 1000 };
  e.n += 1;
  ATTEMPTS.set(key, e);
  return WINDOW_SEC;
}

// Clear the counter — call on any successful authentication (or when the supplied
// credentials are valid but access is blocked for another reason, e.g. revoked).
export function loginReset(key) {
  ATTEMPTS.delete(key);
}

export const loginWindowSec = WINDOW_SEC;
