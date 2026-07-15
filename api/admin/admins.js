// /api/admin/admins — manage founder-console (Level 0) operators.
//   GET    → list admins (no password hashes) + your own id
//   POST   { email, name, password } → create a new admin
//   DELETE { id } → remove an admin (never yourself, never the last one)
//
// Level-0 only (loadAdmin). Passwords are scrypt-hashed; only the hash is stored.
// Every create/remove is written to the audit log.

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { normaliseEmail, clean } from '../_lib/validate.js';
import {
  ensureSchema, listAdmins, getAdminByEmail, createAdmin, deleteAdmin, countAdmins, logEvent,
} from '../_lib/store.js';
import { loadAdmin, hashPassword } from '../_lib/auth.js';

const MIN_PW = 12;

export default async function handler(req, res) {
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, admins: await listAdmins(), you: admin.id });
  }

  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  const body = await readJsonBody(req);
  const ip = clientIp(req);
  const ua = userAgent(req);

  if (req.method === 'POST') {
    const email = normaliseEmail(body.email);
    const name = clean(body.name, 120);
    const password = String(body.password || '');
    if (!email) return sendJson(res, 400, { ok: false, error: 'A valid email is required.' });
    if (password.length < MIN_PW) return sendJson(res, 400, { ok: false, error: `Password must be at least ${MIN_PW} characters.` });
    if (await getAdminByEmail(email)) return sendJson(res, 409, { ok: false, error: 'An admin with this email already exists.' });
    const id = await createAdmin({ email, name, passwordHash: hashPassword(password) });
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `created console admin ${email}`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true, adminId: id });
  }

  if (req.method === 'DELETE') {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return sendJson(res, 400, { ok: false, error: 'Invalid id.' });
    if (id === admin.id) return sendJson(res, 400, { ok: false, error: 'You cannot remove your own admin account.' });
    if ((await countAdmins()) <= 1) return sendJson(res, 400, { ok: false, error: 'Cannot remove the last admin.' });
    const target = (await listAdmins()).find((a) => a.id === id);
    if (!target) return sendJson(res, 404, { ok: false, error: 'Admin not found.' });
    await deleteAdmin(id);
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `removed console admin ${target.email}`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
