// /api/admin/* — every founder-console endpoint, served by one serverless function.
// See api/_handlers/dispatch.js for why the routes are grouped this way. Each
// handler still performs its own Level-0 check; this file only routes.

import { makeDispatcher } from '../_handlers/dispatch.js';

import admins from '../_handlers/admin/admins.js';
import bootstrap from '../_handlers/admin/bootstrap.js';
import documents from '../_handlers/admin/documents.js';
import folders from '../_handlers/admin/folders.js';
import investors from '../_handlers/admin/investors.js';
import invite from '../_handlers/admin/invite.js';
import logs from '../_handlers/admin/logs.js';
import nda from '../_handlers/admin/nda.js';
import previewRoom from '../_handlers/admin/preview-room.js';
import requests from '../_handlers/admin/requests.js';
import reset from '../_handlers/admin/reset.js';
import video from '../_handlers/admin/video.js';

export default makeDispatcher({
  admins,
  bootstrap,
  documents,
  folders,
  investors,
  invite,
  logs,
  nda,
  'preview-room': previewRoom,
  requests,
  reset,
  video,
});
