// /api/admin/documents (Level-0 only) — data-room catalog management.
//   GET    → document metadata (never bytes)
//   POST   → upload: raw file body; metadata via query (?title=&minLevel=&contentType=)
//   PATCH  → { id, changes:{ title, minLevel } }
//   DELETE → { id }
//
// Bytes are stored in the DB and served only via the authorised /api/room/document
// route — never at a public URL.

import crypto from 'node:crypto';
import { sendJson, readJsonBody, readRawBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { clean } from '../_lib/validate.js';
import { ensureSchema, listDocuments, getDocumentMeta, insertDocument, updateDocument, deleteDocument, logEvent } from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';

const MAX_UPLOAD = 8 * 1024 * 1024; // 8 MB (note: Vercel request-body limit is ~4.5 MB)
const tierForLevel = (lvl) => (lvl <= 2 ? 1 : 2);
const validLevel = (lvl) => Number.isInteger(lvl) && lvl >= 1 && lvl <= 5;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const ip = clientIp(req);
  const ua = userAgent(req);

  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, documents: await listDocuments() });
  }

  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  if (req.method === 'POST') {
    const q = req.query || {};
    const minLevel = Number(q.minLevel || 3);
    if (!validLevel(minLevel)) return sendJson(res, 400, { ok: false, error: 'minLevel must be 1–5.' });
    const buf = await readRawBody(req, MAX_UPLOAD);
    if (!buf || !buf.length) return sendJson(res, 413, { ok: false, error: 'Empty or oversized upload (max 8 MB; Vercel caps request bodies near 4.5 MB).' });
    const filename = clean(q.filename, 160);
    const title = clean(q.title, 160) || filename || 'Untitled document';
    const contentType = clean(q.contentType, 100) || req.headers['content-type'] || 'application/octet-stream';
    const pages = clean(q.pages, 40); // optional display label, e.g. "22 pages" / "6 tabs"
    const id = 'D' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const doc = await insertDocument({ id, title, minLevel, tier: tierForLevel(minLevel), contentType, size: buf.length, pages, bytes: buf });
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `uploaded "${title}" (level ${minLevel}, ${buf.length} B)`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true, document: doc });
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    const meta = await getDocumentMeta(id);
    if (!meta) return sendJson(res, 404, { ok: false, error: 'Document not found.' });
    const c = body.changes || {};
    const patch = {};
    if ('title' in c) patch.title = clean(c.title, 160) || meta.title;
    if ('pages' in c) patch.pages = clean(c.pages, 40);
    if ('minLevel' in c) {
      const lvl = Number(c.minLevel);
      if (!validLevel(lvl)) return sendJson(res, 400, { ok: false, error: 'minLevel must be 1–5.' });
      patch.minLevel = lvl; patch.tier = tierForLevel(lvl);
    }
    const doc = await updateDocument(id, patch);
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `edited document ${id} (${JSON.stringify(patch)})`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true, document: doc });
  }

  if (req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    const meta = await getDocumentMeta(id);
    if (!meta) return sendJson(res, 404, { ok: false, error: 'Document not found.' });
    await deleteDocument(id);
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `deleted document "${meta.title}" (${id})`, ip, userAgent: ua });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
