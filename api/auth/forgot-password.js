// POST /api/auth/forgot-password { email } — self-service password reset.
//
// Always returns the SAME neutral response regardless of whether the email exists
// (no account enumeration). If a matching, non-revoked investor exists, a single-
// use reset link is emailed. Rate-limited per IP. The link is NEVER returned in the
// response body (unlike the founder console) — delivery is by email only.

import { sendJson, readJsonBody, clientIp, userAgent, requireOrigin, baseUrl } from '../_lib/http.js';
import { normaliseEmail } from '../_lib/validate.js';
import { ensureSchema, getInvestorByEmail, createInvite, logEvent } from '../_lib/store.js';
import { sendInviteEmail } from '../_lib/mail.js';

const NEUTRAL = 'If an account exists for that email, a link to reset your password has been sent.';

// Per-instance fixed-window rate limit (best-effort; provision KV for cross-instance).
const RL = new Map();
function rateLimited(ip, max = 5, winSec = 900) {
  const bucket = Math.floor(Date.now() / 1000 / winSec);
  const key = `${ip}:${bucket}`;
  const n = (RL.get(key) || 0) + 1;
  RL.set(key, n);
  return n > max;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  await ensureSchema();
  const ip = clientIp(req);
  const ua = userAgent(req);
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', '900');
    return sendJson(res, 429, { ok: false, error: 'Too many requests. Please try again later.' });
  }

  const body = await readJsonBody(req);
  const email = normaliseEmail(body.email);

  if (email) {
    const inv = await getInvestorByEmail(email);
    if (inv && !inv.revoked) {
      const token = await createInvite(inv.id);
      const url = `${baseUrl()}/investor-set-password?token=${token}`;
      await sendInviteEmail({ to: inv.email, name: inv.name, url, reset: true });
      await logEvent({ actorType: 'investor', actorId: inv.id, email: inv.email, event: 'password_reset_requested', ip, userAgent: ua });
    } else {
      // Log the attempt for audit, but never reveal the outcome to the caller.
      await logEvent({ actorType: 'anon', email, event: 'password_reset_requested', detail: inv ? 'revoked' : 'no-account', ip, userAgent: ua });
    }
  }

  // Same response in every case.
  return sendJson(res, 200, { ok: true, message: NEUTRAL });
}
