// POST /api/room/request-access — an authenticated investor signals interest in the
// next tier from a gate (NDA / lead / closing). This grants NOTHING: level 4/5 and
// NDA are assigned manually in the console by a named founder. It only writes an
// audit event (which the founder console's lead-scoring consumes) and best-effort
// notifies the team. Requires a same-site origin (CSRF defence on top of SameSite).

import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, logEvent } from '../_lib/store.js';
import { loadInvestor } from '../_lib/auth.js';
import { sendMail } from '../_lib/mail.js';

const LEAD_TO = process.env.LEAD_TO || 'info@vitabahn.com';
const STAGE = { 2: 'verification / interested', 3: 'NDA diligence', 4: 'lead / anchor', 5: 'closing / signing' };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();

  const { investor } = await loadInvestor(req);
  if (!investor) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });
  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  const body = await readJsonBody(req);
  const level = Number(body && body.level);
  if (!Number.isInteger(level) || level < 2 || level > 5) {
    return sendJson(res, 400, { ok: false, error: 'Invalid level.' });
  }

  const ip = clientIp(req);
  const ua = userAgent(req);
  await logEvent({
    actorType: 'investor', actorId: investor.id, email: investor.email, event: 'access_interest',
    detail: `requested ${STAGE[level] || `level ${level}`} (currently level ${investor.accessLevel}${investor.ndaSigned ? ', NDA' : ''})`,
    ip, userAgent: ua,
  });

  // Best-effort founder notification. No-ops cleanly when SMTP is unconfigured.
  await sendMail({
    to: LEAD_TO,
    subject: `Data room — access interest: ${investor.name || investor.email} → ${STAGE[level] || `level ${level}`}`,
    text: [
      `${investor.name || investor.email} (${investor.org || 'org n/a'}, ${investor.email})`,
      `is at level ${investor.accessLevel}${investor.ndaSigned ? ' with NDA executed' : ''} and requested access to the ${STAGE[level] || `level ${level}`} tier.`,
      '',
      'This is an interest signal only — no access has been granted. Review and, if appropriate,',
      'assign the level (L4/L5 require a named approver) in the investor console.',
    ].join('\n'),
  });

  return sendJson(res, 200, { ok: true });
}
