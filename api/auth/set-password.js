// /api/auth/set-password
//   GET  ?token=...            → validate an invite (without consuming): { valid, email? }
//   POST { token, password }   → consume the invite, set the password, auto-sign-in
//
// The token is single-use and time-limited; only its hash is stored. Setting the
// password signs the investor in (unless their access is revoked/expired).

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, peekInvite, consumeInvite, getInvestorById, updateInvestor, logEvent } from '../_lib/store.js';
import { hashPassword, createSession, setSessionCookie } from '../_lib/auth.js';

const MIN_LEN = 12; // matches the admin/bootstrap minimum (api/admin/admins.js, bootstrap.js)

export default async function handler(req, res) {
  await ensureSchema();
  const ip = clientIp(req);
  const ua = userAgent(req);

  if (req.method === 'GET') {
    const token = (req.query && req.query.token) || new URL(req.url, 'http://x').searchParams.get('token') || '';
    const invite = await peekInvite(String(token));
    if (!invite) return sendJson(res, 200, { ok: true, valid: false });
    const inv = await getInvestorById(invite.investorId);
    return sendJson(res, 200, { ok: true, valid: !!inv, email: inv ? inv.email : undefined });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  const body = await readJsonBody(req);
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (password.length < MIN_LEN) {
    return sendJson(res, 400, { ok: false, error: `Password must be at least ${MIN_LEN} characters.` });
  }

  // Atomically consume the invite; invalid/expired/used tokens fail here.
  const invite = await consumeInvite(token);
  if (!invite) return sendJson(res, 400, { ok: false, error: 'This link is invalid, already used, or expired. Ask for a new one.' });

  const inv = await getInvestorById(invite.investorId);
  if (!inv) return sendJson(res, 404, { ok: false, error: 'Account not found.' });

  await updateInvestor(inv.id, { passwordHash: hashPassword(password) });
  await logEvent({ actorType: 'investor', actorId: inv.id, email: inv.email, event: 'password_set', ip, userAgent: ua });

  // Auto-sign-in unless access is revoked/expired.
  if (inv.revoked || inv.isExpired) {
    return sendJson(res, 200, { ok: true, redirect: '/investor-login', message: 'Password set. Please sign in.' });
  }
  setSessionCookie(res, 'investor', createSession(inv.id, 'investor'));
  await logEvent({ actorType: 'investor', actorId: inv.id, email: inv.email, event: 'login_success', detail: 'via set-password', ip, userAgent: ua });
  return sendJson(res, 200, { ok: true, redirect: '/investor-room' });
}
