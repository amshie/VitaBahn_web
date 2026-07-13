// Set-password invite flow: single-use + expiry + auto-login + re-issue.
import { mockReq, mockRes, cookieFromRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import setPassword from '../api/auth/set-password.js';
import investorLogin from '../api/auth/investor-login.js';

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

const post = (token, password) => mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { token, password } });

test('peek validates, POST sets the password and auto-signs-in', async () => {
  const id = await store.createInvestor({ email: 'a@fund.vc', name: 'A', accessLevel: 3 });
  const token = await store.createInvite(id);

  const g = mockRes(); await setPassword(mockReq({ method: 'GET', query: { token } }), g);
  assert.equal(g.json_().valid, true);
  assert.equal(g.json_().email, 'a@fund.vc');

  const p = mockRes(); await setPassword(post(token, 'my-strong-pass-1'), p);
  assert.equal(p.statusCode, 200);
  assert.equal(p.json_().redirect, '/investor-room');
  assert.ok(cookieFromRes(p, 'vb_inv'), 'auto-signed-in');

  // password_set + login_success logged
  const logs = await store.listLogs({ actorId: id });
  assert.equal(logs.some((l) => l.event === 'password_set'), true);

  // and the investor can now log in normally with the chosen password
  const l = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'a@fund.vc', password: 'my-strong-pass-1' } }), l);
  assert.equal(l.statusCode, 200);
});

test('invite is single-use', async () => {
  const id = await store.createInvestor({ email: 'b@fund.vc', name: 'B', accessLevel: 2 });
  const token = await store.createInvite(id);
  const p1 = mockRes(); await setPassword(post(token, 'first-pass-1234'), p1);
  assert.equal(p1.statusCode, 200);
  const p2 = mockRes(); await setPassword(post(token, 'second-pass-1234'), p2);
  assert.equal(p2.statusCode, 400); // already used
});

test('expired invite is rejected (peek + set)', async () => {
  const id = await store.createInvestor({ email: 'c@fund.vc', name: 'C', accessLevel: 2 });
  const token = await store.createInvite(id, -10); // already expired
  const g = mockRes(); await setPassword(mockReq({ method: 'GET', query: { token } }), g);
  assert.equal(g.json_().valid, false);
  const p = mockRes(); await setPassword(post(token, 'whatever-12345'), p);
  assert.equal(p.statusCode, 400);
});

test('re-issuing an invite invalidates the previous link', async () => {
  const id = await store.createInvestor({ email: 'd@fund.vc', name: 'D', accessLevel: 2 });
  const t1 = await store.createInvite(id);
  const t2 = await store.createInvite(id); // revokes t1
  const p1 = mockRes(); await setPassword(post(t1, 'old-link-pass-1'), p1);
  assert.equal(p1.statusCode, 400);
  const p2 = mockRes(); await setPassword(post(t2, 'new-link-pass-1'), p2);
  assert.equal(p2.statusCode, 200);
});

test('too-short password rejected without consuming the token', async () => {
  const id = await store.createInvestor({ email: 'e@fund.vc', name: 'E', accessLevel: 2 });
  const token = await store.createInvite(id);
  const p = mockRes(); await setPassword(post(token, 'short'), p);
  assert.equal(p.statusCode, 400);
  const g = mockRes(); await setPassword(mockReq({ method: 'GET', query: { token } }), g);
  assert.equal(g.json_().valid, true); // still usable
});

test('bogus token is rejected', async () => {
  const p = mockRes(); await setPassword(post('not-a-real-token', 'some-password-1'), p);
  assert.equal(p.statusCode, 400);
});

test('setting a password for a revoked account does not sign in', async () => {
  const id = await store.createInvestor({ email: 'r@fund.vc', name: 'R', accessLevel: 3 });
  await store.updateInvestor(id, { revoked: true, revokedAt: new Date().toISOString() });
  const token = await store.createInvite(id);
  const p = mockRes(); await setPassword(post(token, 'revoked-pass-1'), p);
  assert.equal(p.statusCode, 200);
  assert.equal(p.json_().redirect, '/investor-login');
  assert.equal(cookieFromRes(p, 'vb_inv'), null); // no session for revoked account
});
