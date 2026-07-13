// GET /api/room/documents — documents the authenticated investor is authorised to
// open, filtered server-side by BOTH access level and NDA status. Restricted
// document names are never returned to an investor not cleared for them (no
// directory listing, no name leakage). Metadata only — bytes come from
// /api/room/document.

import { sendJson } from '../_lib/http.js';
import { ensureSchema, listDocumentsForLevel } from '../_lib/store.js';
import { loadInvestor } from '../_lib/auth.js';

// Documents at min_level >= 3 are NDA-restricted and require an executed NDA.
const NDA_MIN_LEVEL = 3;

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();
  const { investor } = await loadInvestor(req);
  if (!investor) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const byLevel = await listDocumentsForLevel(investor.accessLevel);
  const visible = byLevel.filter((d) => d.minLevel < NDA_MIN_LEVEL || investor.ndaSigned);

  return sendJson(res, 200, {
    ok: true,
    accessLevel: investor.accessLevel,
    ndaSigned: investor.ndaSigned,
    documents: visible.map((d) => ({
      id: d.id,
      title: d.title,
      minLevel: d.minLevel,
      tier: d.tier,
      restricted: d.minLevel >= NDA_MIN_LEVEL,
      size: d.size,
      contentType: d.contentType,
      addedAt: d.addedAt,
    })),
  });
}
