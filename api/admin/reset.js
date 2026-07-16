// POST /api/admin/reset { confirm: "RESET" } — clear all operational data
// (investors, access requests, documents, invites, access logs). Admin accounts
// are preserved so the console stays accessible. Level-0 only, Origin-checked, and
// requires the explicit confirm phrase. The wipe itself is written to the (now
// otherwise empty) audit log.

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, dataCounts, resetData, logEvent } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body.confirm !== 'RESET') {
    return sendJson(res, 400, { ok: false, error: 'Confirmation required: send {"confirm":"RESET"}.' });
  }

  const cleared = await dataCounts();
  await resetData();
  await logEvent({
    actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
    detail: `database reset — cleared ${cleared.investors} investors, ${cleared.requests} requests, ${cleared.documents} documents, ${cleared.invites} invites, ${cleared.logs} logs (admins preserved)`,
    ip: clientIp(req), userAgent: userAgent(req),
  });
  return sendJson(res, 200, { ok: true, cleared });
}
