// POST /api/admin/bootstrap — one-time creation of a founder (Level-0) account.
//
// Disabled unless ADMIN_BOOTSTRAP_TOKEN is set in the environment. The caller must
// present that exact token (constant-time compared). Intended flow: set the token,
// create the first admin, then UNSET the token and redeploy. Upserts by email so
// it can also rotate an admin password in an emergency.

import crypto from 'node:crypto';
import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { normaliseEmail, clean } from '../_lib/validate.js';
import { ensureSchema, createAdmin, logEvent } from '../_lib/store.js';
import { hashPassword } from '../_lib/auth.js';

function tokenOk(provided) {
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN || '';
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!process.env.ADMIN_BOOTSTRAP_TOKEN) return sendJson(res, 404, { ok: false, error: 'Not found' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  await ensureSchema();
  const body = await readJsonBody(req);
  if (!tokenOk(body.token)) return sendJson(res, 401, { ok: false, error: 'Invalid bootstrap token.' });

  const email = normaliseEmail(body.email);
  const password = String(body.password || '');
  const name = clean(body.name, 120);
  if (!email) return sendJson(res, 400, { ok: false, error: 'A valid email is required.' });
  if (password.length < 12) return sendJson(res, 400, { ok: false, error: 'Password must be at least 12 characters.' });

  const id = await createAdmin({ email, name, passwordHash: hashPassword(password) });
  await logEvent({ actorType: 'admin', actorId: id, email, event: 'admin_action', detail: 'admin account bootstrapped', ip: clientIp(req), userAgent: userAgent(req) });
  return sendJson(res, 200, { ok: true, adminId: id });
}
