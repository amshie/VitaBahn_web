// POST /api/auth/logout — clears both session cookies and logs the logout for any
// currently-valid session. Idempotent.

import { sendJson, clientIp, userAgent, requireOrigin, parseCookies } from '../_lib/http.js';
import { ensureSchema, logEvent } from '../_lib/store.js';
import { verifySessionToken, clearSessionCookie, cookieNames } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  await ensureSchema();
  const cookies = parseCookies(req);
  const ip = clientIp(req);
  const ua = userAgent(req);

  for (const role of ['investor', 'admin']) {
    const p = verifySessionToken(cookies[cookieNames[role]] || '');
    if (p && p.role === role) {
      await logEvent({ actorType: role, actorId: p.sub, event: 'logout', ip, userAgent: ua });
    }
  }

  // Clear both realms in one response.
  res.statusCode = 200;
  res.setHeader('Set-Cookie', [
    `${cookieNames.investor}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${cookieNames.admin}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: true, redirect: '/investor-login' }));
}
