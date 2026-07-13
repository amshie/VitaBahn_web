// POST /api/auth/investor-login — { email, password } → session cookie.
// Logs every attempt (success + failure). Revoked/expired accounts cannot log in.

import { sendJson, readJsonBody, clientIp, userAgent, requireOrigin } from '../_lib/http.js';
import { normaliseEmail } from '../_lib/validate.js';
import { ensureSchema, getInvestorByEmail, logEvent } from '../_lib/store.js';
import { verifyPassword, hashPassword, createSession, setSessionCookie } from '../_lib/auth.js';

// A real hash so a missing-user path still spends scrypt time (reduces the timing
// side-channel that would otherwise reveal whether an email exists).
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

  const inv = await getInvestorByEmail(email);
  const passOk = inv && inv.passwordHash
    ? verifyPassword(password, inv.passwordHash)
    : (verifyPassword(password, DUMMY_HASH), false);

  if (!passOk) {
    await logEvent({ actorType: inv ? 'investor' : 'anon', actorId: inv ? inv.id : null, email, event: 'login_failed', detail: 'bad-credentials', ip, userAgent: ua });
    return sendJson(res, 401, { ok: false, error: 'Invalid credentials.' });
  }
  if (inv.revoked) {
    await logEvent({ actorType: 'investor', actorId: inv.id, email, event: 'login_failed', detail: 'revoked', ip, userAgent: ua });
    return sendJson(res, 403, { ok: false, error: 'Access to the data room has been revoked.' });
  }
  if (inv.isExpired) {
    await logEvent({ actorType: 'investor', actorId: inv.id, email, event: 'login_failed', detail: 'expired', ip, userAgent: ua });
    return sendJson(res, 403, { ok: false, error: 'Your data-room access has expired.' });
  }

  setSessionCookie(res, 'investor', createSession(inv.id, 'investor'));
  await logEvent({ actorType: 'investor', actorId: inv.id, email, event: 'login_success', ip, userAgent: ua });
  return sendJson(res, 200, { ok: true, redirect: '/investor-room' });
}
