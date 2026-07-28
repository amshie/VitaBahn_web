// GET /api/room/video — the ONE authorised path to the Overview briefing video.
//
// Unlike documents, this is deliberately open to EVERY authenticated investor: any
// level, NDA or not. It is still not public — the session is re-checked here, the
// account must be live, and there is no object URL anywhere, so the bytes cannot be
// reached without signing in. A founder previewing the room is also allowed through.
//
// Responses are served as bounded HTTP ranges: the player asks for the slice it
// needs (which is what makes seeking work) and a single response never has to hold
// more than one window in function memory.

import { sendJson, clientIp, userAgent } from '../_lib/http.js';
import { ensureSchema, getActiveRoomVideo, readRoomVideoRange, logEvent } from '../_lib/store.js';
import { loadInvestor, loadAdmin } from '../_lib/auth.js';

// Largest slice returned in one response. Keeps each response comfortably inside
// serverless payload limits and bounds the memory a single request can use.
const WINDOW = 2 * 1024 * 1024;

// Parse a single-range "bytes=..." header. Returns null when absent or unusable
// (multi-range is not supported — players never need it for progressive playback).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const n = Number(rawEnd);
    if (!n) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

// Write the whole resource in windows, respecting backpressure. Used only for a
// request that carried no Range header; the media element always sends one.
async function streamWhole(res, video) {
  for (let start = 0; start < video.size; start += WINDOW) {
    const end = Math.min(start + WINDOW, video.size) - 1;
    const slice = await readRoomVideoRange(video, start, end);
    if (!slice.length) break;
    if (res.write(slice) === false) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  }
  return res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  await ensureSchema();

  const ip = clientIp(req);
  const ua = userAgent(req);

  // Investor session first; fall back to an admin session so the founder's
  // read-only room preview can play the same video it is previewing.
  const { investor, reason } = await loadInvestor(req);
  let actor = investor ? { type: 'investor', id: investor.id, email: investor.email } : null;
  if (!actor) {
    const { admin } = await loadAdmin(req);
    if (admin) actor = { type: 'admin', id: admin.id, email: admin.email };
  }
  if (!actor) {
    if (reason === 'revoked' || reason === 'expired') {
      await logEvent({ actorType: 'investor', event: 'session_invalid', detail: reason, ip, userAgent: ua });
    }
    return sendJson(res, 401, { ok: false, error: 'Not authenticated' });
  }

  const video = await getActiveRoomVideo();
  if (!video || !video.size) return sendJson(res, 404, { ok: false, error: 'No briefing video is published.' });

  res.setHeader('Content-Type', video.contentType || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const rangeHeader = req.headers && req.headers.range;
  const range = parseRange(rangeHeader, video.size);

  // A Range header that parsed to nothing usable is a client error, not a reason to
  // silently send the whole file.
  if (rangeHeader && !range) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${video.size}`);
    return res.end();
  }

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.setHeader('Content-Length', video.size);
    return res.end();
  }

  // First segment of a playback = one audit row. Later range requests are the same
  // view continuing, so they are not logged again.
  if (!range || range.start === 0) {
    await logEvent({
      actorType: actor.type, actorId: actor.id, email: actor.email, event: 'document_view',
      detail: `overview video "${video.title}"${actor.type === 'admin' ? ' (founder preview)' : ''}`, ip, userAgent: ua,
    });
  }

  if (!range) {
    res.statusCode = 200;
    res.setHeader('Content-Length', video.size);
    return streamWhole(res, video);
  }

  // Clamp to one window. Returning fewer bytes than asked for is a normal server
  // response; the player simply requests the next range.
  const end = Math.min(range.end, range.start + WINDOW - 1);
  const slice = await readRoomVideoRange(video, range.start, end);
  if (!slice.length) return sendJson(res, 404, { ok: false, error: 'Video data is missing.' });

  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${range.start}-${range.start + slice.length - 1}/${video.size}`);
  res.setHeader('Content-Length', slice.length);
  return res.end(slice);
}
