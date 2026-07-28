// /api/admin/video (Level-0 only) — the Overview briefing video.
//
//   GET                        → metadata of the published video (never bytes)
//   POST ?action=init          → { title, contentType, size, chunkSize } → new upload id
//   POST ?action=chunk&id=&seq= → raw bytes of one chunk
//   POST ?action=finish&id=    → verify completeness, publish, drop the previous video
//   DELETE                     → { id } (or none = remove the published video)
//
// The upload is chunked because a serverless request body caps out near 4.5 MB —
// far below a usable video. Chunks are verified against the declared size before
// anything is published, so a half-uploaded file can never reach investors. Bytes
// are served only through the authorised /api/room/video route; there is no public
// object URL, exactly as for documents.

import crypto from 'node:crypto';
import { sendJson, readJsonBody, readRawBody, requireOrigin, clientIp, userAgent } from '../_lib/http.js';
import { clean } from '../_lib/validate.js';
import {
  ensureSchema, getActiveRoomVideo, getRoomVideoById, createRoomVideo, putRoomVideoChunk,
  roomVideoUploadedBytes, finishRoomVideo, deleteRoomVideo, purgeStaleRoomVideoUploads, logEvent,
} from '../_lib/store.js';
import { loadAdmin } from '../_lib/auth.js';

// Total video size ceiling. Bytes live in Postgres, so this is a deliberate brake
// on database growth rather than a protocol limit — raise via VIDEO_MAX_BYTES.
const MAX_VIDEO_BYTES = Number(process.env.VIDEO_MAX_BYTES || 200 * 1024 * 1024);
// One chunk must fit in a single request body (Vercel caps around 4.5 MB).
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

// Accept a media type with or without parameters ("video/mp4", but also
// 'video/mp4; codecs="avc1.42E01E"', which some sources attach) and keep only the
// bare type, so what gets stored and echoed back in Content-Type is always clean.
const baseType = (t) => String(t || '').split(';')[0].trim().toLowerCase();
const isVideoType = (t) => /^video\/[a-z0-9.+-]+$/.test(baseType(t));
const chunkCount = (size, chunkSize) => Math.ceil(size / chunkSize);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return sendJson(res, 401, { ok: false, error: 'Not authenticated' });

  const ip = clientIp(req);
  const ua = userAgent(req);
  const q = req.query || {};

  if (req.method === 'GET') {
    return sendJson(res, 200, { ok: true, video: await getActiveRoomVideo(), maxBytes: MAX_VIDEO_BYTES, chunkSize: MAX_CHUNK_BYTES });
  }

  if (!requireOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });

  if (req.method === 'POST') {
    const action = String(q.action || '');

    if (action === 'init') {
      const body = await readJsonBody(req);
      const size = Number(body.size || 0);
      const chunkSize = Number(body.chunkSize || 0);
      const contentType = clean(body.contentType, 100);
      if (!isVideoType(contentType)) {
        return sendJson(res, 400, { ok: false, error: 'Only video files are accepted (e.g. MP4 / H.264).' });
      }
      if (!Number.isInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) {
        return sendJson(res, 413, { ok: false, error: `Video must be between 1 byte and ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB.` });
      }
      if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_BYTES) {
        return sendJson(res, 400, { ok: false, error: `chunkSize must be 1–${MAX_CHUNK_BYTES} bytes.` });
      }
      await purgeStaleRoomVideoUploads();
      const id = 'V' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const title = clean(body.title, 160) || 'Investor briefing';
      const video = await createRoomVideo({ id, title, contentType: baseType(contentType), size, chunkSize });
      return sendJson(res, 200, { ok: true, video, chunks: chunkCount(size, chunkSize) });
    }

    if (action === 'chunk') {
      const id = String(q.id || '');
      const seq = Number(q.seq);
      const video = await getRoomVideoById(id);
      if (!video) return sendJson(res, 404, { ok: false, error: 'Upload not found — start again.' });
      if (video.status !== 'uploading') return sendJson(res, 409, { ok: false, error: 'This upload is already published.' });

      const total = chunkCount(video.size, video.chunkSize);
      if (!Number.isInteger(seq) || seq < 0 || seq >= total) {
        return sendJson(res, 400, { ok: false, error: 'Chunk index out of range.' });
      }
      const buf = await readRawBody(req, MAX_CHUNK_BYTES);
      if (!buf || !buf.length) return sendJson(res, 413, { ok: false, error: 'Empty or oversized chunk.' });

      // Every chunk but the last must be exactly chunkSize, and the last must be the
      // remainder. Enforcing this here means byte offsets can be derived arithmetically
      // at read time, so a Range request cannot silently return misaligned data.
      const expected = seq === total - 1 ? video.size - seq * video.chunkSize : video.chunkSize;
      if (buf.length !== expected) {
        return sendJson(res, 400, { ok: false, error: `Chunk ${seq} must be ${expected} bytes, received ${buf.length}.` });
      }
      await putRoomVideoChunk(id, seq, buf);
      const progress = await roomVideoUploadedBytes(id);
      return sendJson(res, 200, { ok: true, seq, received: progress.total, size: video.size });
    }

    if (action === 'finish') {
      const id = String(q.id || '');
      const video = await getRoomVideoById(id);
      if (!video) return sendJson(res, 404, { ok: false, error: 'Upload not found.' });
      const progress = await roomVideoUploadedBytes(id);
      const expectedChunks = chunkCount(video.size, video.chunkSize);
      if (progress.total !== video.size || progress.chunks !== expectedChunks) {
        return sendJson(res, 409, {
          ok: false,
          error: `Upload incomplete (${progress.chunks}/${expectedChunks} chunks, ${progress.total}/${video.size} bytes). Nothing was published.`,
        });
      }
      const published = await finishRoomVideo(id);
      await logEvent({
        actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
        detail: `published overview video "${published.title}" (${video.size} B, ${video.contentType})`, ip, userAgent: ua,
      });
      return sendJson(res, 200, { ok: true, video: published });
    }

    return sendJson(res, 400, { ok: false, error: 'Unknown action.' });
  }

  if (req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const id = String(body.id || '') || (await getActiveRoomVideo() || {}).id || '';
    const video = id ? await getRoomVideoById(id) : null;
    if (!video) return sendJson(res, 404, { ok: false, error: 'No video to delete.' });
    await deleteRoomVideo(id);
    await logEvent({
      actorType: 'admin', actorId: admin.id, email: admin.email, event: 'admin_action',
      detail: `deleted overview video "${video.title}" (${id})`, ip, userAgent: ua,
    });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
