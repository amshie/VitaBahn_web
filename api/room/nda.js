// POST /api/room/nda — an authenticated investor uploads their SIGNED NDA (PDF).
//
// The file is stored privately (nda_submissions), pending founder review. It grants
// NOTHING on its own: the founder reviews and Accepts it in the console, which is
// what flips nda_signed and opens Diligence (Level 3). Every submission is logged and
// the founder is notified. Bytes are served only to the founder via the admin route.

import { sendJson, readRawBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { clean } from '../_lib/validate.js';
import { ensureSchema, insertNdaSubmission, logEvent } from '../_lib/store.js';
import { loadInvestor } from '../_lib/auth.js';
import { sendMail } from '../_lib/mail.js';

const MAX_UPLOAD = 8 * 1024 * 1024; // 8 MB (Vercel caps request bodies near 4.5 MB)
const LEAD_TO = process.env.LEAD_TO || 'invest@vitabahn.com';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();

  const { investor } = await loadInvestor(req);
  if (!investor) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  const buf = await readRawBody(req, MAX_UPLOAD);
  if (!buf || !buf.length) return sendJson(res, 413, { ok: false, error: 'Empty or oversized file (max 8 MB).' });

  const q = req.query || {};
  const filename = clean(q.filename, 160) || 'signed-nda.pdf';
  const contentType = clean(q.contentType, 100) || req.headers['content-type'] || '';
  const looksPdf = contentType.includes('pdf') || buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (!looksPdf) return sendJson(res, 400, { ok: false, error: 'Please upload your signed NDA as a PDF.' });

  const ip = clientIp(req);
  const ua = userAgent(req);
  await insertNdaSubmission({ investorId: investor.id, filename, contentType: 'application/pdf', size: buf.length, bytes: buf });
  await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'nda_submitted', detail: `${filename} (${buf.length} B)`, ip, userAgent: ua });

  // Best-effort founder notification (no-ops cleanly when SMTP is unconfigured).
  await sendMail({
    to: LEAD_TO,
    subject: `Data room — signed NDA submitted: ${investor.name || investor.email}`,
    text: [
      `${investor.name || investor.email} (${investor.org || 'org n/a'}, ${investor.email})`,
      'has uploaded a signed NDA for review.',
      '',
      'Open the investor console, review the document, and Accept to open Diligence',
      '(Level 3) access — or Reject to request a corrected copy.',
    ].join('\n'),
  });

  return sendJson(res, 200, { ok: true, status: 'submitted' });
}
