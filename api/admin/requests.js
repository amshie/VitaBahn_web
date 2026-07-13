// /api/admin/requests (Level-0 only)
//   GET   → all investor-access gateway submissions (newest first)
//   PATCH → { requestId, status } to move a request through review states

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, listAccessRequests, setRequestStatus, logEvent } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';

const STATUS = new Set(['pending', 'reviewed', 'approved', 'declined']);

export default async function handler(req, res) {
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, requests: await listAccessRequests() });
  }
  if (req.method === 'PATCH') {
    if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
    const body = await readJsonBody(req);
    const requestId = String(body.requestId || '');
    const status = String(body.status || '');
    if (!requestId || !STATUS.has(status)) return sendJson(res, 400, { ok: false, error: 'Invalid request or status.' });
    await setRequestStatus(requestId, status);
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `request ${requestId} → ${status}`, ip: clientIp(req), userAgent: userAgent(req) });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
