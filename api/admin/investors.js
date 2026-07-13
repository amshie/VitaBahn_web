// /api/admin/investors  (Level-0 / founder only)
//   GET   → all investors with engagement + lead score
//   POST  → provision a new investor account (returns a one-time temp password)
//   PATCH → update disclosure level / NDA / expiry / revocation / commitment / notes
//
// Level 4 and Level 5 require a named approver (brief: "named approval"). Level 0
// can never be assigned to an investor account.

import { sendJson, readJsonBody, clientIp, userAgent, requireOrigin, baseUrl } from '../_lib/http.js';
import { normaliseEmail, clean } from '../_lib/validate.js';
import {
  ensureSchema, listInvestors, getInvestorById, createInvestor, updateInvestor,
  deleteInvestor, engagementByInvestor, latestNdaByInvestor, setRequestStatus, createInvite, logEvent,
} from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';
import { sendInviteEmail } from '../_lib/mail.js';

function leadScore(inv, eng) {
  const views = eng ? eng.views : 0;
  const days = eng && eng.lastAt ? Math.floor((Date.now() - new Date(eng.lastAt).getTime()) / 86400000) : 999;
  const engagement = Math.min(45, views * 5);
  const recency = days <= 2 ? 20 : days <= 7 ? 14 : days <= 14 ? 8 : days <= 30 ? 3 : 0;
  const commit = inv.commitStatus === 'committed' ? 20 : inv.commitStatus === 'soft' ? 10 : 0;
  const signals = (inv.ndaSigned ? 8 : 0) + (inv.meetingBooked ? 4 : 0) + (inv.accessLevel >= 4 ? 3 : 0);
  return Math.round(Math.min(100, engagement + recency + commit + signals));
}

const COMMIT_STATUS = new Set(['none', 'soft', 'committed']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const ip = clientIp(req);
  const ua = userAgent(req);

  // ---- GET: list ----
  if (req.method === 'GET') {
    const [investors, eng, ndas] = await Promise.all([listInvestors(), engagementByInvestor(), latestNdaByInvestor()]);
    const out = investors.map((inv) => {
      const e = eng.get(inv.id);
      return { ...inv, docViews: e ? e.views : 0, lastActivityAt: e ? e.lastAt : inv.createdAt, score: leadScore(inv, e), ndaSubmission: ndas.get(inv.id) || null };
    });
    return sendJson(res, 200, { ok: true, investors: out });
  }

  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  const body = await readJsonBody(req);

  // ---- POST: provision a new investor account ----
  if (req.method === 'POST') {
    const email = normaliseEmail(body.email);
    const level = Number(body.accessLevel || 2);
    if (!email) return sendJson(res, 400, { ok: false, error: 'A valid email is required.' });
    if (!(level >= 1 && level <= 5)) return sendJson(res, 400, { ok: false, error: 'Access level must be 1–5.' });
    const approvedBy = clean(body.approvedBy, 120);
    if (level >= 4 && !approvedBy) {
      return sendJson(res, 400, { ok: false, error: 'Level 4/5 requires a named approver.' });
    }
    // Create the account WITHOUT a password — the investor sets their own via the
    // emailed set-password link. Until then the account cannot be logged into.
    let id;
    try {
      id = await createInvestor({
        email, name: clean(body.name, 120), org: clean(body.org, 160), role: clean(body.role, 120),
        country: clean(body.country, 80), investorType: clean(body.investorType, 80),
        passwordHash: null, accessLevel: level,
        ticket: clean(body.ticket, 40), interest: clean(body.interest, 120), timeline: clean(body.timeline, 60),
        requestId: clean(body.requestId, 60) || null,
      });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message || '')) return sendJson(res, 409, { ok: false, error: 'An account with this email already exists.' });
      throw err;
    }
    if (level >= 4) await updateInvestor(id, { approvedBy, approvedLevel: level, approvedAt: new Date().toISOString() });
    if (body.requestId) await setRequestStatus(clean(body.requestId, 60), 'approved');

    // Issue + email the single-use set-password invite.
    const token = await createInvite(id);
    const inviteUrl = `${baseUrl()}/investor-set-password?token=${token}`;
    const mail = await sendInviteEmail({ to: email, name: clean(body.name, 120), url: inviteUrl });

    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `provisioned ${email} at level ${level}${approvedBy ? ` (approved by ${approvedBy})` : ''}; invite ${mail.sent ? 'emailed' : 'NOT emailed'}`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true, investorId: id, inviteUrl, emailed: mail.sent });
  }

  // ---- PATCH: update an existing investor ----
  if (req.method === 'PATCH') {
    const id = Number(body.id);
    const inv = Number.isFinite(id) ? await getInvestorById(id) : null;
    if (!inv) return sendJson(res, 404, { ok: false, error: 'Investor not found.' });
    const c = body.changes || {};
    const patch = {};
    const notes = [];

    if ('accessLevel' in c) {
      const lvl = Number(c.accessLevel);
      if (!(lvl >= 1 && lvl <= 5)) return sendJson(res, 400, { ok: false, error: 'Access level must be 1–5 (0 is reserved for admins).' });
      if (lvl >= 4) {
        const approvedBy = clean(c.approvedBy, 120);
        if (!approvedBy) return sendJson(res, 400, { ok: false, error: 'Level 4/5 requires a named approver.' });
        patch.approvedBy = approvedBy; patch.approvedLevel = lvl; patch.approvedAt = new Date().toISOString();
        notes.push(`level→${lvl} approved by ${approvedBy}`);
      } else {
        notes.push(`level→${lvl}`);
      }
      patch.accessLevel = lvl;
    }
    if ('ndaSigned' in c) {
      patch.ndaSigned = !!c.ndaSigned;
      patch.ndaSignedAt = c.ndaSigned ? new Date().toISOString() : null;
      notes.push(c.ndaSigned ? 'NDA marked signed' : 'NDA cleared');
    }
    if ('revoked' in c) {
      patch.revoked = !!c.revoked;
      patch.revokedAt = c.revoked ? new Date().toISOString() : null;
      notes.push(c.revoked ? 'ACCESS REVOKED' : 'access reinstated');
    }
    if ('expiresAt' in c) {
      patch.expiresAt = c.expiresAt ? new Date(c.expiresAt).toISOString() : null;
      notes.push(c.expiresAt ? `expiry→${patch.expiresAt.slice(0, 10)}` : 'expiry cleared');
    }
    if ('meetingBooked' in c) { patch.meetingBooked = !!c.meetingBooked; }
    if ('commitAmount' in c) { patch.commitAmount = Math.max(0, parseInt(c.commitAmount, 10) || 0); }
    if ('commitStatus' in c) {
      if (!COMMIT_STATUS.has(c.commitStatus)) return sendJson(res, 400, { ok: false, error: 'Invalid commitment status.' });
      patch.commitStatus = c.commitStatus;
    }
    if ('instrument' in c) { patch.instrument = clean(c.instrument, 40) || '—'; }
    if ('notes' in c) { patch.notes = clean(c.notes, 4000); }
    if ('followUpAt' in c) { patch.followUpAt = c.followUpAt ? String(c.followUpAt).slice(0, 10) : null; }

    const updated = await updateInvestor(id, patch);
    if (notes.length) {
      await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `${inv.email}: ${notes.join('; ')}`, ip, userAgent: ua });
    }
    return sendJson(res, 200, { ok: true, investor: updated });
  }

  // ---- DELETE: permanently remove an investor + their access-log history ----
  if (req.method === 'DELETE') {
    const id = Number(body.id);
    const inv = Number.isFinite(id) ? await getInvestorById(id) : null;
    if (!inv) return sendJson(res, 404, { ok: false, error: 'Investor not found.' });
    await deleteInvestor(id);
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `deleted investor ${inv.email} (id ${id}) incl. access-log history`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
