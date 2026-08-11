// /api/admin/documents (Level-0 only) — data-room catalog management.
//   GET    → document metadata (never bytes)
//   POST   → upload: raw file body; metadata via query (?title=&minLevel=&contentType=)
//   PATCH  → { id, changes:{ title, minLevel } }
//   DELETE → { id }
//
// Bytes are stored in the DB and served only via the authorised /api/room/document
// route — never at a public URL.

import crypto from 'node:crypto';
import { sendJson, readJsonBody, readRawBody, requireOrigin, clientIp, userAgent } from '../../_lib/http.js';
import { clean } from '../../_lib/validate.js';
import { ensureSchema, listDocuments, getDocumentMeta, insertDocument, updateDocument, deleteDocument, setNdaTemplate, getFolder, logEvent } from '../../_lib/store.js';
import { loadAdmin } from '../../_lib/auth.js';

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
    // Filing a document in a folder takes the folder's level: the folder is the
    // thing the founder reasons about, and a mismatch would make it show documents
    // its label says are not there.
    const folderId = clean(q.folderId, 60);
    let folder = null;
    if (folderId) {
      folder = await getFolder(folderId);
      if (!folder) return sendJson(res, 404, { ok: false, error: 'Folder not found.' });
    }
    const minLevel = folder ? folder.minLevel : Number(q.minLevel || 3);
    if (!validLevel(minLevel)) return sendJson(res, 400, { ok: false, error: 'minLevel must be 1–5.' });
    const buf = await readRawBody(req, MAX_UPLOAD);
    if (!buf || !buf.length) return sendJson(res, 413, { ok: false, error: 'Empty or oversized upload (max 8 MB; Vercel caps request bodies near 4.5 MB).' });
    const filename = clean(q.filename, 160);
    const title = clean(q.title, 160) || filename || 'Untitled document';
    const contentType = clean(q.contentType, 100) || req.headers['content-type'] || 'application/octet-stream';
    const pages = clean(q.pages, 40); // optional display label, e.g. "22 pages" / "6 tabs"
    const id = 'D' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const doc = await insertDocument({ id, title, minLevel, tier: tierForLevel(minLevel), contentType, size: buf.length, pages, folderId: folder ? folder.id : null, bytes: buf });
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `uploaded "${title}" (level ${minLevel}${folder ? `, folder "${folder.name}"` : ''}, ${buf.length} B)`, ip, userAgent: ua });
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
    // Moving between folders re-levels the document to match its new home; moving
    // it out leaves the level it already had.
    let destFolder = null;
    if ('folderId' in c) {
      const fid = clean(c.folderId, 60);
      if (fid) {
        destFolder = await getFolder(fid);
        if (!destFolder) return sendJson(res, 404, { ok: false, error: 'Folder not found.' });
        patch.folderId = destFolder.id;
        patch.minLevel = destFolder.minLevel;
        patch.tier = tierForLevel(destFolder.minLevel);
      } else {
        patch.folderId = null;
      }
    }
    if ('minLevel' in c) {
      const lvl = Number(c.minLevel);
      if (!validLevel(lvl)) return sendJson(res, 400, { ok: false, error: 'minLevel must be 1–5.' });
      // A folder owns the level of everything inside it. Letting one document drift
      // would put a file an investor cannot open inside a folder they can — so the
      // founder is pointed at the two operations that keep the invariant true.
      const staysFiled = 'folderId' in patch ? patch.folderId : meta.folderId;
      if (staysFiled && lvl !== (destFolder ? destFolder.minLevel : null)) {
        return sendJson(res, 409, {
          ok: false,
          error: 'This document is in a folder and takes the folder\'s level. Change the folder\'s level, or move the document out of the folder first.',
        });
      }
      patch.minLevel = lvl; patch.tier = tierForLevel(lvl);
    }
    let doc = await updateDocument(id, patch);
    if ('isNdaTemplate' in c) { await setNdaTemplate(c.isNdaTemplate ? id : null); doc = await getDocumentMeta(id); }
    await logEvent({ actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action', detail: `edited document ${id} (${JSON.stringify(patch)}${'isNdaTemplate' in c ? `, nda_template=${!!c.isNdaTemplate}` : ''})`, ip, userAgent: ua });
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
