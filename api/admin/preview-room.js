// GET /api/admin/preview-room?investorId=N — founder-only, read-only.
//
// Returns the EXACT room payload a given investor would be served, computed by the
// same buildRoomOverview() the investor's own endpoint uses. This lets a founder see
// precisely what an investor sees (which tiers are unlocked, gated or locked) without
// impersonation or any investor session. Admin-gated; every preview is logged.

import { sendJson, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, getInvestorById, logEvent } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';
import { buildRoomOverview } from '../_lib/room-view.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();

  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const raw = (req.query && req.query.investorId) || new URL(req.url, 'http://x').searchParams.get('investorId');
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { ok: false, error: 'investorId is required.' });

  const investor = await getInvestorById(id);
  if (!investor) return sendJson(res, 404, { ok: false, error: 'Investor not found.' });

  const payload = await buildRoomOverview(investor);

  await logEvent({
    actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
    detail: `previewed data room as ${investor.email} (level ${investor.accessLevel}${investor.ndaSigned ? ', NDA' : ''})`,
    ip: clientIp(req), userAgent: userAgent(req),
  });

  return sendJson(res, 200, {
    ok: true,
    preview: {
      investorId: investor.id,
      name: investor.name || investor.email,
      email: investor.email,
      revoked: !!investor.revoked,
      expired: !!investor.isExpired,
    },
    ...payload,
  });
}
