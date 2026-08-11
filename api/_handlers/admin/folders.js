// /api/admin/folders (Level-0 only) — folders that group data-room documents.
//   GET    → all folders, each with the number of documents filed in it
//   POST   → { name, minLevel }
//   PATCH  → { id, changes:{ name, minLevel, sortOrder } }
//   DELETE → { id }  (documents inside are unfiled, never deleted)
//
// A folder belongs to exactly one disclosure level and its documents inherit that
// level, so changing a folder's level re-levels its contents (handled in the store).
// Investors can see folder and document NAMES at every level; only the bytes stay
// gated — that check lives in /api/room/document and is untouched by this route.

import crypto from 'node:crypto';
import { sendJson, readJsonBody, requireOrigin, clientIp, userAgent } from '../../_lib/http.js';
import { clean } from '../../_lib/validate.js';
import {
  ensureSchema, listFolders, getFolder, createFolder, updateFolder, deleteFolder,
  countDocumentsInFolder, logEvent,
} from '../../_lib/store.js';
import { loadAdmin } from '../../_lib/auth.js';

const validLevel = (lvl) => Number.isInteger(lvl) && lvl >= 1 && lvl <= 5;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const ip = clientIp(req);
  const ua = userAgent(req);

  if (req.method === 'GET') {
    const folders = await listFolders();
    const withCounts = await Promise.all(
      folders.map(async (f) => ({ ...f, docCount: await countDocumentsInFolder(f.id) }))
    );
    return sendJson(res, 200, { ok: true, folders: withCounts });
  }

  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = clean(body.name, 120);
    const minLevel = Number(body.minLevel);
    if (!name) return sendJson(res, 400, { ok: false, error: 'A folder name is required.' });
    if (!validLevel(minLevel)) return sendJson(res, 400, { ok: false, error: 'minLevel must be 1–5.' });
    const id = 'F' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const folder = await createFolder({ id, name, minLevel, sortOrder: Number(body.sortOrder) || 0 });
    await logEvent({
      actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
      detail: `created folder "${name}" at level ${minLevel}`, ip, userAgent: ua,
    });
    return sendJson(res, 200, { ok: true, folder: { ...folder, docCount: 0 } });
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    const existing = await getFolder(id);
    if (!existing) return sendJson(res, 404, { ok: false, error: 'Folder not found.' });

    const c = body.changes || {};
    const patch = {};
    if ('name' in c) {
      const name = clean(c.name, 120);
      if (!name) return sendJson(res, 400, { ok: false, error: 'A folder name is required.' });
      patch.name = name;
    }
    if ('minLevel' in c) {
      const lvl = Number(c.minLevel);
      if (!validLevel(lvl)) return sendJson(res, 400, { ok: false, error: 'minLevel must be 1–5.' });
      patch.minLevel = lvl;
    }
    if ('sortOrder' in c) patch.sortOrder = Number(c.sortOrder) || 0;

    const folder = await updateFolder(id, patch);
    const docCount = await countDocumentsInFolder(id);
    // A level change moves every document with it — worth spelling out in the log,
    // since it silently widens or narrows who can open them.
    const moved = 'minLevel' in patch && patch.minLevel !== existing.minLevel
      ? ` — ${docCount} document(s) moved from level ${existing.minLevel} to ${patch.minLevel}`
      : '';
    await logEvent({
      actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
      detail: `edited folder "${existing.name}" (${JSON.stringify(patch)})${moved}`, ip, userAgent: ua,
    });
    return sendJson(res, 200, { ok: true, folder: { ...folder, docCount } });
  }

  if (req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    const folder = await getFolder(id);
    if (!folder) return sendJson(res, 404, { ok: false, error: 'Folder not found.' });
    const docCount = await countDocumentsInFolder(id);
    await deleteFolder(id);
    await logEvent({
      actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
      detail: `deleted folder "${folder.name}"${docCount ? ` — ${docCount} document(s) kept, now unfiled at level ${folder.minLevel}` : ''}`,
      ip, userAgent: ua,
    });
    return sendJson(res, 200, { ok: true, unfiled: docCount });
  }

  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
