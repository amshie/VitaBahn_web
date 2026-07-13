// POST /api/admin/invite { id } — issue (or re-issue) a single-use set-password
// invite for an investor and email them the link. Also returns the link so the
// founder can share it manually if SMTP is not configured. Re-issuing revokes any
// previous unused link. Level-0 only.

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent, baseUrl } from '../_lib/http.js';
import { ensureSchema, getInvestorById, createInvite, logEvent } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';
import { sendInviteEmail } from '../_lib/mail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const body = await readJsonBody(req);
  const id = Number(body.id != null ? body.id : body.investorId);
  const inv = Number.isFinite(id) ? await getInvestorById(id) : null;
  if (!inv) return sendJson(res, 404, { ok: false, error: 'Investor not found.' });

  const token = await createInvite(id);
  const url = `${baseUrl()}/investor-set-password?token=${token}`;
  const mail = await sendInviteEmail({ to: inv.email, name: inv.name, url });

  await logEvent({
    actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
    detail: `issued set-password invite to ${inv.email}${mail.sent ? ' (emailed)' : ' (email NOT sent — share link manually)'}`,
    ip: clientIp(req), userAgent: userAgent(req),
  });
  return sendJson(res, 200, { ok: true, inviteUrl: url, emailed: mail.sent });
}
