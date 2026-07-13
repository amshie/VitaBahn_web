// GET /api/room/session — the authenticated investor's own profile + grant, for
// the room shell to render. Returns 401 for any invalid/removed session.

import { sendJson, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, logEvent } from '../_lib/store.js';
import { loadInvestor } from '../_lib/auth.js';

const LEVEL_LABELS = {
  1: 'Public / First Contact',
  2: 'Interested Investor',
  3: 'Qualified / NDA',
  4: 'Lead / Anchor',
  5: 'Signing / Closing',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();
  const { investor, reason } = await loadInvestor(req);
  if (!investor) {
    if (reason === 'revoked' || reason === 'expired') {
      await logEvent({ actorType: 'investor', event: 'session_invalid', detail: reason, ip: clientIp(req), userAgent: userAgent(req) });
    }
    return sendJson(res, 401, { ok: false, error: 'Not authenticated', reason });
  }
  return sendJson(res, 200, {
    ok: true,
    investor: {
      name: investor.name,
      email: investor.email,
      org: investor.org,
      accessLevel: investor.accessLevel,
      levelLabel: LEVEL_LABELS[investor.accessLevel] || String(investor.accessLevel),
      ndaSigned: investor.ndaSigned,
      expiresAt: investor.expiresAt,
    },
  });
}
