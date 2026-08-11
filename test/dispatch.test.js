// The grouped API routes: /api/admin/*, /api/auth/* and /api/room/* are each served
// by ONE serverless function that forwards to the real handler (Vercel's Hobby plan
// allows twelve functions; this project has far more endpoints).
//
// Every other test imports handlers directly and so never crosses this dispatch
// layer — which is exactly why it needs its own test. A typo in a route table here
// would take an endpoint off the air while the whole rest of the suite stayed green.
import { mockReq, mockRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';

import adminDispatch from '../api/admin/[route].js';
import authDispatch from '../api/auth/[route].js';
import roomDispatch from '../api/room/[route].js';

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

// Every endpoint the site actually calls. Each is probed with a method it accepts,
// so an unauthenticated request reaches the auth check and answers 401. Reaching the
// handler at all is the point: 404 would mean the dispatcher failed to route, which
// is the regression this test exists to catch. A few endpoints are POST-only and
// would answer 405 to a GET — routed correctly, but a weaker signal.
const ADMIN = [
  ['admins', 'GET'], ['documents', 'GET'], ['folders', 'GET'], ['investors', 'GET'],
  ['invite', 'POST'], ['logs', 'GET'], ['nda', 'GET'], ['preview-room', 'GET'],
  ['requests', 'GET'], ['reset', 'POST'], ['video', 'GET'],
];
const ROOM = [
  ['document', 'GET'], ['documents', 'GET'], ['nda', 'POST'], ['overview', 'GET'],
  ['request-access', 'POST'], ['session', 'GET'], ['video', 'GET'],
];

async function call(dispatch, path, extra = {}) {
  const res = mockRes();
  const req = mockReq({ headers: { origin: TEST_ORIGIN }, ...extra });
  req.url = path; // the dispatcher reads the endpoint name from the PATH
  await dispatch(req, res);
  return res;
}

test('every admin endpoint is reachable through the grouped route', async () => {
  for (const [name, method] of ADMIN) {
    const res = await call(adminDispatch, `/api/admin/${name}`, { method, body: {} });
    assert.notEqual(res.statusCode, 404, `/api/admin/${name} did not route`);
    assert.equal(res.statusCode, 401, `/api/admin/${name} should demand a founder session`);
  }
});

test('every room endpoint is reachable through the grouped route', async () => {
  for (const [name, method] of ROOM) {
    const res = await call(roomDispatch, `/api/room/${name}`, { method, body: {} });
    assert.notEqual(res.statusCode, 404, `/api/room/${name} did not route`);
    assert.equal(res.statusCode, 401, `/api/room/${name} should demand an investor session`);
  }
});

test('auth endpoints route to their handlers', async () => {
  // Wrong credentials, not a routing failure: the handler ran and rejected them.
  const login = await call(authDispatch, '/api/auth/investor-login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong-password-here' } });
  assert.notEqual(login.statusCode, 404);
  assert.equal(login.statusCode, 401);

  // Logout is unauthenticated and always succeeds — proof the route was reached.
  const out = await call(authDispatch, '/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(out.statusCode, 200);
});

test('an unknown endpoint in a known group is a clean 404', async () => {
  for (const [dispatch, path] of [[adminDispatch, '/api/admin/nope'], [roomDispatch, '/api/room/nope'], [authDispatch, '/api/auth/nope']]) {
    const res = await call(dispatch, path);
    assert.equal(res.statusCode, 404, `${path} should be a 404`);
    assert.equal(res.json_().ok, false);
  }
});

test('the endpoint is taken from the path, never from a query parameter', async () => {
  // /api/admin/video uses ?action=… of its own. A dispatcher reading req.query for
  // the route name could be steered by a crafted query string; this one cannot.
  const res = await call(adminDispatch, '/api/admin/folders?route=reset&action=init');
  assert.equal(res.statusCode, 401); // folders (admin-gated), not reset
  const bogus = await call(adminDispatch, '/api/admin/nope?route=investors');
  assert.equal(bogus.statusCode, 404);
});

test('a trailing slash or query string still resolves', async () => {
  assert.equal((await call(roomDispatch, '/api/room/session/')).statusCode, 401);
  assert.equal((await call(roomDispatch, '/api/room/session?x=1')).statusCode, 401);
});
