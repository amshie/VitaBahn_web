// /api/room/* — every authenticated investor endpoint in one serverless function.
// See api/_handlers/dispatch.js for why the routes are grouped this way. Each
// handler re-checks the session, level and NDA itself; this file only routes.

import { makeDispatcher } from '../_handlers/dispatch.js';

import document from '../_handlers/room/document.js';
import documents from '../_handlers/room/documents.js';
import nda from '../_handlers/room/nda.js';
import overview from '../_handlers/room/overview.js';
import requestAccess from '../_handlers/room/request-access.js';
import session from '../_handlers/room/session.js';
import video from '../_handlers/room/video.js';

export default makeDispatcher({
  document,
  documents,
  nda,
  overview,
  'request-access': requestAccess,
  session,
  video,
});
