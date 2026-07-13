// GET /api/room/document?id=... — the ONE authorised path to a document's bytes.
//
// There is no public object URL anywhere: bytes live in the database and are
// streamed only after this handler re-checks the session, the account status, the
// required access level and NDA state. Every grant AND every denial is logged.

import { sendJson, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, getDocumentMeta, getDocumentWithBytes, logEvent } from '../_lib/store.js';
import { loadInvestor } from '../_lib/auth.js';
import { looksLikePdf, watermarkPdf } from '../_lib/watermark.js';

const NDA_MIN_LEVEL = 3;
// Documents at the NDA tier (min_level >= 3) are view-only: the room hides their
// download control and this route refuses an explicit download of them, matching
// the mockup's download-restricted rule. Open-tier docs (1–2) may be downloaded.
const isViewOnly = (minLevel) => minLevel >= NDA_MIN_LEVEL;

function safeFilename(title, contentType) {
  const base = String(title || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 100).trim() || 'document';
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(base);
  const ext = { 'application/pdf': '.pdf', 'text/html': '.html', 'text/plain': '.txt', 'image/png': '.png', 'image/jpeg': '.jpg' }[contentType] || '';
  return hasExt ? base : base + ext;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  await ensureSchema();

  const ip = clientIp(req);
  const ua = userAgent(req);
  const { investor, reason } = await loadInvestor(req);
  if (!investor) {
    if (reason === 'revoked' || reason === 'expired') {
      await logEvent({ actorType: 'investor', event: 'session_invalid', detail: reason, ip, userAgent: ua });
    }
    return sendJson(res, 401, { ok: false, error: 'Not authenticated' });
  }

  const id = String((req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
  const meta = await getDocumentMeta(id);
  if (!meta) {
    await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'document_denied', documentId: id, detail: 'not-found', ip, userAgent: ua });
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  // Authorisation: level, then NDA for restricted tiers.
  if (meta.minLevel > investor.accessLevel) {
    await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'document_denied', documentId: id, detail: `level ${investor.accessLevel} < required ${meta.minLevel}`, ip, userAgent: ua });
    return sendJson(res, 403, { ok: false, error: 'Not authorised for this document.' });
  }
  if (meta.minLevel >= NDA_MIN_LEVEL && !investor.ndaSigned) {
    await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'document_denied', documentId: id, detail: 'nda-required', ip, userAgent: ua });
    return sendJson(res, 403, { ok: false, error: 'An executed NDA is required for this document.' });
  }

  // Download vs inline view. NDA-tier documents are view-only: an explicit
  // download is refused (and logged), so there is no one-click path to a pristine,
  // un-watermarked copy of restricted material.
  const wantsDownload = Boolean((req.query && req.query.dl) || new URL(req.url, 'http://x').searchParams.get('dl'));
  if (wantsDownload && isViewOnly(meta.minLevel)) {
    await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'document_denied', documentId: id, detail: 'download-restricted (view-only tier)', ip, userAgent: ua });
    return sendJson(res, 403, { ok: false, error: 'This document is view-only at its tier; download is restricted.' });
  }

  const full = await getDocumentWithBytes(id);
  if (!full || !full.bytes) {
    await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'document_denied', documentId: id, detail: 'no-bytes', ip, userAgent: ua });
    return sendJson(res, 404, { ok: false, error: 'Document has no stored content.' });
  }

  // Per-recipient watermark. PDFs are stamped with the authenticated investor's
  // identity + timestamp before the bytes leave the server, so any leaked copy is
  // traceable. Non-PDFs cannot be stamped in place and are served as-is (still
  // access-controlled, view-only and logged).
  let outBytes = full.bytes;
  let watermarked = false;
  if (looksLikePdf(full.bytes, full.contentType)) {
    const wm = await watermarkPdf(full.bytes, { name: investor.name, email: investor.email, when: new Date().toISOString() });
    outBytes = wm.bytes;
    watermarked = wm.applied;
  }

  const disposition = wantsDownload ? 'attachment' : 'inline';
  res.statusCode = 200;
  res.setHeader('Content-Type', full.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', outBytes.length);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeFilename(full.title, full.contentType)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  await logEvent({ actorType: 'investor', actorId: investor.id, email: investor.email, event: 'document_view', documentId: id, detail: `${full.title} (${disposition}${watermarked ? ', watermarked' : ''})`, ip, userAgent: ua });
  return res.end(outBytes);
}
