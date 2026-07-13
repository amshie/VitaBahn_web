// GET /investor-console/preview?investorId=N (rewritten to /api/page-room-preview).
//
// Founder-only, read-only preview of an investor's data room. It serves the SAME
// room shell as /investor-room, but in preview mode: the client fetches its data
// from the admin-gated /api/admin/preview-room, so a founder sees exactly what the
// investor sees. The shell embeds no confidential data; unauthenticated / non-admin
// requests are redirected to the founder login.

import { sendHtml, redirect } from './_lib/http.js';
import { ensureSchema, getInvestorById } from './_lib/store.js';
import { loadAdmin } from './_lib/auth.js';
import { renderShell } from './page-room.js';

export default async function handler(req, res) {
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return redirect(res, '/founder-login');

  const raw = (req.query && req.query.investorId) || new URL(req.url, 'http://x').searchParams.get('investorId');
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return redirect(res, '/investor-console');
  const investor = await getInvestorById(id);
  if (!investor) return redirect(res, '/investor-console');

  return sendHtml(res, 200, renderShell({ id: investor.id, name: investor.name || investor.email }));
}
