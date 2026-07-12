// GET /api/admin/logs (Level-0 only) — the audit trail. Optional ?investorId= to
// scope to one investor, ?limit= (capped at 500).

import { sendJson } from '../_lib/http.js';
import { ensureSchema, listLogs } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const q = req.query || {};
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 200));
  const actorId = q.investorId ? Number(q.investorId) : null;
  return sendJson(res, 200, { ok: true, logs: await listLogs({ limit, actorId }) });
}
