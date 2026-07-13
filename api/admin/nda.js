// /api/admin/nda  (Level-0 / founder only) — review investor-submitted signed NDAs.
//   GET ?id=N          → stream the signed NDA bytes for review (inline)
//   GET ?investorId=N  → latest submission metadata
//   PATCH { id, action: 'accept' | 'reject' }
//        accept → marks the submission accepted AND flips investors.nda_signed
//        reject → marks it rejected so the investor can re-upload
// Every view and decision is logged.

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, getLatestNdaSubmission, getNdaSubmissionWithBytes, setNdaSubmissionStatus, getInvestorById, logEvent } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const ip = clientIp(req);
  const ua = userAgent(req);

  if (req.method === 'GET') {
    const q = req.query || {};
    const id = Number(q.id);
    if (Number.isInteger(id) && id > 0) {
      const sub = await getNdaSubmissionWithBytes(id);
      if (!sub || !sub.bytes) return sendJson(res, 404, { ok: false, error: 'Not found' });
      await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `viewed signed NDA #${id}`, ip, userAgent: ua });
      res.statusCode = 200;
      res.setHeader('Content-Type', sub.contentType || 'application/pdf');
      res.setHeader('Content-Length', sub.bytes.length);
      res.setHeader('Content-Disposition', `inline; filename="signed-nda-${id}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return res.end(sub.bytes);
    }
    const investorId = Number(q.investorId);
    if (Number.isInteger(investorId) && investorId > 0) {
      return sendJson(res, 200, { ok: true, submission: await getLatestNdaSubmission(investorId) });
    }
    return sendJson(res, 400, { ok: false, error: 'id or investorId is required.' });
  }

  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    const id = Number(body.id);
    const action = String(body.action || '');
    if (!Number.isInteger(id) || !['accept', 'reject'].includes(action)) {
      return sendJson(res, 400, { ok: false, error: 'id and action (accept|reject) are required.' });
    }
    const status = action === 'accept' ? 'accepted' : 'rejected';
    const investorId = await setNdaSubmissionStatus(id, status, admin.name || admin.email);
    if (!investorId) return sendJson(res, 404, { ok: false, error: 'Submission not found.' });
    const inv = await getInvestorById(investorId);
    await logEvent({
      actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
      detail: `${status} signed NDA #${id} for ${inv ? inv.email : investorId}${action === 'accept' ? ' — NDA executed, Diligence (L3) opened' : ''}`,
      ip, userAgent: ua,
    });
    return sendJson(res, 200, { ok: true, status });
  }

  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
