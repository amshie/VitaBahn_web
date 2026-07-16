// Failed-attempt throttle for the authentication endpoints (admin + investor login).
//
// Online password-guessing / credential-stuffing control. It counts ONLY failed
// attempts, keyed on (realm + client IP + email), and is cleared on any successful
// authentication — so a legitimate user who signs in correctly is never throttled;
// only repeated failures against the same account from the same source trip a 429.
//
// Counters live in the login_throttle table (schema.js), NOT in instance memory,
// so the limit holds across every serverless instance and cold start. The database
// is already a hard dependency of each login (user lookup + audit log), so this
// adds no new failure mode — and it fails CLOSED: no database, no login attempt.
// (The lighter limiters in api/lead.js and api/access-request.js remain in-memory
// with optional KV — they guard form spam, not credentials.)

import { query } from './db.js';

const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 10);
const WINDOW_SEC = Number(process.env.LOGIN_WINDOW_SEC || 900); // 15 minutes

// Build the throttle key. Email is lower-cased/normalised by the caller already.
export function loginKey(realm, ip, email) {
  return `${realm}:${ip || 'unknown'}:${email || 'unknown'}`;
}

// True once this key has reached the failure threshold within the window.
export async function loginBlocked(key) {
  const { rows } = await query(
    'SELECT 1 FROM login_throttle WHERE key = $1 AND fails >= $2 AND expires_at > now()',
    [key, MAX_FAILS]
  );
  return rows.length > 0;
}

// Record one failed attempt. The upsert is atomic, so concurrent instances never
// lose a count. Fixed window: it opens on the first failure and later failures do
// not extend it. Returns the Retry-After hint in seconds.
export async function loginFailed(key) {
  // Opportunistic purge — keeps the table at one row per currently-active key.
  await query('DELETE FROM login_throttle WHERE expires_at <= now()');
  const expires = new Date(Date.now() + WINDOW_SEC * 1000).toISOString();
  await query(
    `INSERT INTO login_throttle (key, fails, expires_at) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       fails      = CASE WHEN login_throttle.expires_at <= now() THEN 1  ELSE login_throttle.fails + 1 END,
       expires_at = CASE WHEN login_throttle.expires_at <= now() THEN $2 ELSE login_throttle.expires_at END`,
    [key, expires]
  );
  return WINDOW_SEC;
}

// Clear the counter — call on any successful authentication (or when the supplied
// credentials are valid but access is blocked for another reason, e.g. revoked).
export async function loginReset(key) {
  await query('DELETE FROM login_throttle WHERE key = $1', [key]);
}

export const loginWindowSec = WINDOW_SEC;
