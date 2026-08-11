// Shared dispatcher for the grouped API routes.
//
// Vercel turns every file under api/ into its own serverless function, and the
// Hobby plan allows twelve. This project has far more endpoints than that, so each
// group (admin / auth / room) is served by ONE dynamic route that forwards to the
// real handler. The handlers themselves live under api/_handlers/, which Vercel
// ignores because of the leading underscore — they are ordinary modules, unchanged.
//
// The endpoint name is taken from the URL PATH, never from req.query: several
// handlers already use query parameters of their own (?action=…), and a dynamic
// segment merged into req.query could collide with them.

import { sendJson } from '../_lib/http.js';

export function makeDispatcher(routes) {
  return async function dispatch(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Bad request' });
    }
    const name = pathname.split('/').filter(Boolean).pop() || '';
    const handler = routes[name];
    if (!handler) return sendJson(res, 404, { ok: false, error: 'Not found' });
    return handler(req, res);
  };
}
