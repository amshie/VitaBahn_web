// GET /api/room/overview — the single authorised data feed for the investor room.
//
// Everything is computed server-side from the authenticated investor via the shared
// buildRoomOverview() (see api/_lib/room-view.js): the response contains ONLY what
// this investor is cleared to see. Documents above the grant are never included —
// not their names, not their counts.

import { sendJson } from '../_lib/http.js';
import { ensureSchema } from '../_lib/store.js';
import { loadInvestor } from '../_lib/auth.js';
import { buildRoomOverview } from '../_lib/room-view.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();
  const { investor } = await loadInvestor(req);
  if (!investor) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const payload = await buildRoomOverview(investor);
  return sendJson(res, 200, { ok: true, ...payload });
}
