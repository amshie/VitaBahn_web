// POST /api/auth/admin-login — founder / Level-0 console login. Separate cookie
// realm (vb_adm) from investor sessions. Every attempt is logged.

import { sendJson, readJsonBody, clientIp, userAgent, requireOrigin } from '../_lib/http.js';
import { normaliseEmail } from '../_lib/validate.js';
import { ensureSchema, getAdminByEmail, logEvent } from '../_lib/store.js';
import { verifyPassword, hashPassword, createSession, setSessionCookie } from '../_lib/auth.js';
import { loginKey, loginBlocked, loginFailed, loginReset, loginWindowSec } from '../_lib/throttle.js';

const DUMMY_HASH = hashPassword('dummy-password-for-constant-time');

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  await ensureSchema();
  const ip = clientIp(req);
  const ua = userAgent(req);
  const body = await readJsonBody(req);
  const email = normaliseEmail(body.email);
  const password = String(body.password || '');

  if (!email || !password) {
    return sendJson(res, 400, { ok: false, error: 'Email and password are required.' });
  }

  // Brute-force throttle: too many recent failures for this IP+email → 429.
  const key = loginKey('adm', ip, email);
  if (loginBlocked(key)) {
    await logEvent({ actorType: 'anon', email, event: 'login_failed', detail: 'admin rate-limited', ip, userAgent: ua });
    res.setHeader('Retry-After', String(loginWindowSec));
    return sendJson(res, 429, { ok: false, error: 'Too many failed attempts. Please try again later.' });
  }

  const admin = await getAdminByEmail(email); // includes password_hash
  const passOk = admin && admin.password_hash
    ? verifyPassword(password, admin.password_hash)
    : (verifyPassword(password, DUMMY_HASH), false);

  if (!passOk) {
    loginFailed(key);
    await logEvent({ actorType: admin ? 'admin' : 'anon', actorId: admin ? admin.id : null, email, event: 'login_failed', detail: 'admin', ip, userAgent: ua });
    return sendJson(res, 401, { ok: false, error: 'Invalid credentials.' });
  }

  loginReset(key); // valid credentials — clear the failure counter
  setSessionCookie(res, 'admin', createSession(admin.id, 'admin'));
  await logEvent({ actorType: 'admin', actorId: admin.id, email, event: 'login_success', detail: 'console', ip, userAgent: ua });
  return sendJson(res, 200, { ok: true, redirect: '/investor-console' });
}
