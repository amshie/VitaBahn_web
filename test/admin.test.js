// Founder console backend: Level-0 separation, named approval for L4/L5,
// provisioning, revocation, document upload, request review.
import { mockReq, mockRes, cookieFromRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests, query } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import { hashPassword } from '../api/_lib/auth.js';
import { loginKey } from '../api/_lib/throttle.js';

import adminLogin from '../api/auth/admin-login.js';
import investorLogin from '../api/auth/investor-login.js';
import adminInvestors from '../api/admin/investors.js';
import adminInvite from '../api/admin/invite.js';
import adminAdmins from '../api/admin/admins.js';
import adminReset from '../api/admin/reset.js';
import adminRequests from '../api/admin/requests.js';
import adminDocuments from '../api/admin/documents.js';
import roomDocument from '../api/room/document.js';
import previewRoom from '../api/admin/preview-room.js';
import roomOverview from '../api/room/overview.js';

const ADMIN_PW = 'Founder-Console-Pass-1';

async function seedAdmin() {
  await store.createAdmin({ email: 'founder@vitabahn.com', name: 'Founder', passwordHash: hashPassword(ADMIN_PW) });
}
async function adminCookie() {
  const res = mockRes();
  await adminLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'founder@vitabahn.com', password: ADMIN_PW } }), res);
  return cookieFromRes(res, 'vb_adm');
}
const asAdmin = (cookie, extra = {}) => mockReq({ cookies: { vb_adm: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

test('admin endpoints reject anonymous and investor sessions (Level-0 separation)', async () => {
  await seedAdmin();
  // anonymous
  let r = mockRes(); await adminInvestors(mockReq({ method: 'GET' }), r); assert.equal(r.statusCode, 401);
  // an investor session must not reach the console API
  const invId = await store.createInvestor({ email: 'inv@fund.vc', name: 'Inv', accessLevel: 2 });
  await store.updateInvestor(invId, { passwordHash: hashPassword('Investor-Pass-1') });
  const ilog = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'inv@fund.vc', password: 'Investor-Pass-1' } }), ilog);
  const invCookie = cookieFromRes(ilog, 'vb_inv');
  r = mockRes(); await adminInvestors(mockReq({ method: 'GET', cookies: { vb_inv: invCookie } }), r);
  assert.equal(r.statusCode, 401);
});

test('admin login: wrong password 401 + logged; right password sets vb_adm', async () => {
  await seedAdmin();
  const bad = mockRes(); await adminLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'founder@vitabahn.com', password: 'nope' } }), bad);
  assert.equal(bad.statusCode, 401);
  const cookie = await adminCookie();
  assert.ok(cookie);
  const logs = await store.listLogs({ limit: 10 });
  assert.equal(logs.some((l) => l.event === 'login_failed' && l.detail === 'admin'), true);
  assert.equal(logs.some((l) => l.event === 'login_success' && l.detail === 'console'), true);
});

test('admin login is throttled after repeated failures (429 + Retry-After)', async () => {
  await seedAdmin();
  const ip = '198.51.100.201'; // dedicated IP so the throttle key is isolated
  const attempt = async (password) => {
    const res = mockRes();
    await adminLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'founder@vitabahn.com', password }, ip }), res);
    return res;
  };
  // The first 10 failed attempts are answered with 401…
  for (let i = 0; i < 10; i++) assert.equal((await attempt('wrong')).statusCode, 401);
  // …the 11th is throttled — the block is checked BEFORE credential verification,
  // so even the correct password is refused with 429 until the window elapses.
  const blocked = await attempt(ADMIN_PW);
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.getHeader('retry-after'));
  // The counter is persisted in Postgres, not instance memory — so the block
  // holds across serverless instances and cold starts (a distributed guesser
  // cannot start from zero on a fresh instance).
  const { rows } = await query('SELECT fails FROM login_throttle WHERE key = $1', [
    loginKey('adm', ip, 'founder@vitabahn.com'),
  ]);
  assert.ok(rows[0] && Number(rows[0].fails) >= 10, 'failure counter is stored in the database');
});

test('provisioning creates a passwordless account + set-password invite (no login until set)', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const res = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'POST', body: { email: 'new@fund.vc', name: 'New Investor', accessLevel: 2 } }), res);
  const j = res.json_();
  assert.equal(j.ok, true);
  assert.match(j.inviteUrl, /\/investor-set-password\?token=/);
  assert.equal(j.emailed, false); // no SMTP configured in tests
  assert.equal(res.text.includes('tempPassword'), false); // no password is issued/leaked
  const inv = await store.getInvestorByEmail('new@fund.vc');
  assert.equal(inv.hasPassword, false);
  // cannot log in yet — no password is set
  const login = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'new@fund.vc', password: 'anything-at-all-1' } }), login);
  assert.equal(login.statusCode, 401);
});

test('admin invite endpoint issues a set-password link', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const id = await store.createInvestor({ email: 'f@fund.vc', name: 'F', accessLevel: 2 });
  const res = mockRes();
  await adminInvite(asAdmin(cookie, { method: 'POST', body: { id } }), res);
  const j = res.json_();
  assert.equal(j.ok, true);
  assert.match(j.inviteUrl, /token=/);
  // anonymous cannot issue invites
  const anon = mockRes();
  await adminInvite(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { id } }), anon);
  assert.equal(anon.statusCode, 401);
});

test('a founder can create another console admin who can then sign in', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const res = mockRes();
  await adminAdmins(asAdmin(cookie, { method: 'POST', body: { email: 'info@vitabahn.com', name: 'Info Desk', password: 'a-strong-admin-pw-12' } }), res);
  assert.equal(res.json_().ok, true);
  // the new admin can authenticate
  const login = mockRes();
  await adminLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'info@vitabahn.com', password: 'a-strong-admin-pw-12' } }), login);
  assert.equal(login.statusCode, 200);
  // it is recorded in the audit log
  assert.equal((await store.listLogs({ limit: 20 })).some((l) => /created console admin info@vitabahn\.com/.test(l.detail)), true);
});

test('admin creation rejects duplicates and short passwords; list shows you', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const dupe = mockRes();
  await adminAdmins(asAdmin(cookie, { method: 'POST', body: { email: 'founder@vitabahn.com', name: 'x', password: 'a-strong-admin-pw-12' } }), dupe);
  assert.equal(dupe.statusCode, 409);
  const shortPw = mockRes();
  await adminAdmins(asAdmin(cookie, { method: 'POST', body: { email: 'new@vitabahn.com', name: 'x', password: 'short' } }), shortPw);
  assert.equal(shortPw.statusCode, 400);
  const list = mockRes();
  await adminAdmins(asAdmin(cookie, { method: 'GET' }), list);
  assert.equal(list.json_().admins.length, 1);
  assert.ok(list.json_().you); // your own id is returned
});

test('an admin cannot remove themselves or the last admin, but can remove others', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const me = (await store.listAdmins())[0];
  // cannot remove the last (and own) admin
  const self = mockRes();
  await adminAdmins(asAdmin(cookie, { method: 'DELETE', body: { id: me.id } }), self);
  assert.equal(self.statusCode, 400);
  // add a second admin, then remove it
  await adminAdmins(asAdmin(cookie, { method: 'POST', body: { email: 'two@vitabahn.com', name: 'Two', password: 'second-admin-pw-123' } }), mockRes());
  const two = (await store.listAdmins()).find((a) => a.email === 'two@vitabahn.com');
  const del = mockRes();
  await adminAdmins(asAdmin(cookie, { method: 'DELETE', body: { id: two.id } }), del);
  assert.equal(del.json_().ok, true);
  assert.equal((await store.listAdmins()).length, 1);
});

test('reset clears all data, preserves admins, and requires confirm + auth', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const invId = await store.createInvestor({ email: 'x@fund.vc', name: 'X', accessLevel: 2 });
  await store.insertAccessRequest({ requestId: 'VB-RESET-1', fullName: 'R', email: 'r@x.com' });
  await store.insertDocument({ id: 'D-r', title: 'Doc', minLevel: 2, tier: 1, size: 3, bytes: Buffer.from('abc') });
  await store.insertNdaSubmission({ investorId: invId, filename: 'nda.pdf', contentType: 'application/pdf', size: 3, bytes: Buffer.from('NDA') });

  // wrong confirm phrase → 400, nothing cleared
  const bad = mockRes();
  await adminReset(asAdmin(cookie, { method: 'POST', body: { confirm: 'nope' } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal((await store.listInvestors()).length, 1);
  assert.equal((await store.latestNdaByInvestor()).size, 1);

  // anonymous → 401
  const anon = mockRes();
  await adminReset(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { confirm: 'RESET' } }), anon);
  assert.equal(anon.statusCode, 401);

  // real reset
  const res = mockRes();
  await adminReset(asAdmin(cookie, { method: 'POST', body: { confirm: 'RESET' } }), res);
  assert.equal(res.json_().ok, true);
  assert.equal(res.json_().cleared.ndas, 1); // NDA submissions are counted in the report
  assert.equal((await store.listInvestors()).length, 0);
  assert.equal((await store.listAccessRequests()).length, 0);
  assert.equal((await store.listDocuments()).length, 0);
  // Signed-NDA PDFs (investor PII) must not survive a reset — ids restart, so a
  // stale submission would re-attach to whichever new investor reuses the id.
  assert.equal((await store.latestNdaByInvestor()).size, 0);
  assert.equal((await store.listAdmins()).length, 1); // admins preserved
  assert.equal((await store.listLogs({ limit: 5 })).some((l) => /database reset/.test(l.detail)), true);
});

test('admin management is Level-0 only (anonymous denied)', async () => {
  await seedAdmin();
  for (const method of ['GET', 'POST', 'DELETE']) {
    const res = mockRes();
    await adminAdmins(mockReq({ method, headers: { origin: TEST_ORIGIN }, body: { email: 'x@y.z', password: 'a-strong-admin-pw-12', id: 1 } }), res);
    assert.equal(res.statusCode, 401);
  }
});

test('Level 4/5 requires a named approver', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const id = await store.createInvestor({ email: 'lead@fund.vc', name: 'Lead', accessLevel: 3 });

  const no = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'PATCH', body: { id, changes: { accessLevel: 4 } } }), no);
  assert.equal(no.statusCode, 400);
  assert.equal((await store.getInvestorById(id)).accessLevel, 3); // unchanged

  const yes = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'PATCH', body: { id, changes: { accessLevel: 4, approvedBy: 'A. Founder' } } }), yes);
  assert.equal(yes.statusCode, 200);
  const upd = await store.getInvestorById(id);
  assert.equal(upd.accessLevel, 4);
  assert.equal(upd.approvedBy, 'A. Founder');
  assert.equal(upd.approvedLevel, 4);
  const logs = await store.listLogs({ limit: 10 });
  assert.equal(logs.some((l) => l.event === 'admin_action' && /approved by A\. Founder/.test(l.detail)), true);
});

test('access_level 0 can never be assigned to an investor', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const id = await store.createInvestor({ email: 'x@fund.vc', name: 'X', accessLevel: 2 });
  const res = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'PATCH', body: { id, changes: { accessLevel: 0 } } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal((await store.getInvestorById(id)).accessLevel, 2);
});

test('revoke via console locks the investor out of document serving', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const id = await store.createInvestor({ email: 'r@fund.vc', name: 'R', accessLevel: 3 });
  await store.updateInvestor(id, { ndaSigned: true, passwordHash: hashPassword('Investor-Pass-1') });
  await store.insertDocument({ id: 'D-nda', title: 'Model', minLevel: 3, tier: 2, contentType: 'application/pdf', size: 3, bytes: Buffer.from('FIN') });
  // investor logs in and can view
  const ilog = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'r@fund.vc', password: 'Investor-Pass-1' } }), ilog);
  const invCookie = cookieFromRes(ilog, 'vb_inv');
  let d = mockRes(); await roomDocument(mockReq({ cookies: { vb_inv: invCookie }, query: { id: 'D-nda' } }), d);
  assert.equal(d.statusCode, 200);
  // admin revokes
  const rv = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'PATCH', body: { id, changes: { revoked: true } } }), rv);
  assert.equal(rv.statusCode, 200);
  // same session now denied
  d = mockRes(); await roomDocument(mockReq({ cookies: { vb_inv: invCookie }, query: { id: 'D-nda' } }), d);
  assert.equal(d.statusCode, 401);
});

test('document upload stores bytes served only via the authorised route; list leaks no bytes', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const pdf = Buffer.from('%PDF-1.4 fake');
  const up = mockRes();
  await adminDocuments(asAdmin(cookie, { method: 'POST', query: { title: 'Cap Table', minLevel: '4', filename: 'cap.pdf', contentType: 'application/pdf' }, body: pdf }), up);
  const j = up.json_();
  assert.equal(j.ok, true);
  assert.equal(j.document.minLevel, 4);
  // GET returns metadata only
  const list = mockRes(); await adminDocuments(asAdmin(cookie, { method: 'GET' }), list);
  const doc = list.json_().documents.find((x) => x.id === j.document.id);
  assert.equal('bytes' in doc, false);
  // bytes are retrievable through the store (used by the authorised room route)
  const withBytes = await store.getDocumentWithBytes(j.document.id);
  assert.equal(withBytes.bytes.toString(), '%PDF-1.4 fake');
});

test('deleting an investor removes the account and wipes their access-log history', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const id = await store.createInvestor({ email: 'del@fund.vc', name: 'Del', accessLevel: 3 });
  await store.logEvent({ actorType: 'investor', actorId: id, email: 'del@fund.vc', event: 'login_success' });
  await store.logEvent({ actorType: 'investor', actorId: id, event: 'document_view', documentId: 'D-x' });
  const invLogs = async () => (await store.listLogs({ actorId: id })).filter((l) => l.actorType === 'investor');
  assert.equal((await invLogs()).length, 2);

  const res = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'DELETE', body: { id } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(await store.getInvestorById(id), null);
  assert.equal((await invLogs()).length, 0); // investor's history wiped
  const all = await store.listLogs({ limit: 20 });
  assert.equal(all.some((l) => l.event === 'admin_action' && /deleted investor del@fund\.vc/.test(l.detail)), true);

  const res2 = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'DELETE', body: { id: 99999 } }), res2);
  assert.equal(res2.statusCode, 404);
});

test('access requests are listable and provisioning marks the request approved', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  await store.insertAccessRequest({ requestId: 'VB-20260712-ABCDE', fullName: 'Omar', email: 'o@gulf.cap', organisation: 'Gulf', ticketRange: 'major', roleInRound: 'Anchor investor', meetingType: 'qualified40' });
  const listed = mockRes(); await adminRequests(asAdmin(cookie, { method: 'GET' }), listed);
  assert.equal(listed.json_().requests.length, 1);

  const prov = mockRes();
  await adminInvestors(asAdmin(cookie, { method: 'POST', body: { email: 'o@gulf.cap', name: 'Omar', accessLevel: 2, requestId: 'VB-20260712-ABCDE' } }), prov);
  assert.equal(prov.json_().ok, true);
  const reqs = await store.listAccessRequests();
  assert.equal(reqs[0].status, 'approved');
});

// ---- Founder "view as investor" preview -----------------------------------
async function seedInvestorA() {
  await store.insertDocument({ id: 'D-open', title: 'One-Pager', minLevel: 2, tier: 1, contentType: 'application/pdf', size: 3, bytes: Buffer.from('ONE') });
  await store.insertDocument({ id: 'D-nda', title: 'Financial Model', minLevel: 3, tier: 2, contentType: 'application/pdf', size: 3, bytes: Buffer.from('FIN') });
  await store.insertDocument({ id: 'D-lead', title: 'Cap Table', minLevel: 4, tier: 2, contentType: 'application/pdf', size: 3, bytes: Buffer.from('CAP') });
  const id = await store.createInvestor({ email: 'a@fund.vc', name: 'Investor A', accessLevel: 3 });
  await store.updateInvestor(id, { passwordHash: hashPassword('Investor-Pass-1'), ndaSigned: true });
  return id;
}

test('preview-room is founder-only (anonymous + investor sessions rejected)', async () => {
  await seedAdmin();
  const invId = await seedInvestorA();
  // anonymous
  let r = mockRes(); await previewRoom(mockReq({ method: 'GET', query: { investorId: String(invId) } }), r);
  assert.equal(r.statusCode, 401);
  // an investor session must not reach the founder preview
  const ilog = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'a@fund.vc', password: 'Investor-Pass-1' } }), ilog);
  const invCookie = cookieFromRes(ilog, 'vb_inv');
  r = mockRes(); await previewRoom(mockReq({ method: 'GET', cookies: { vb_inv: invCookie }, query: { investorId: String(invId) } }), r);
  assert.equal(r.statusCode, 401);
});

test('preview-room returns 404 for an unknown investor', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const r = mockRes(); await previewRoom(asAdmin(cookie, { method: 'GET', query: { investorId: '99999' } }), r);
  assert.equal(r.statusCode, 404);
});

test('preview-room shows EXACTLY the investor view (matches /api/room/overview) and is logged', async () => {
  await seedAdmin();
  const invId = await seedInvestorA();
  // The investor's own view.
  const ilog = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'a@fund.vc', password: 'Investor-Pass-1' } }), ilog);
  const invCookie = cookieFromRes(ilog, 'vb_inv');
  const ov = mockRes(); await roomOverview(mockReq({ cookies: { vb_inv: invCookie } }), ov);
  const ovJson = ov.json_();
  // The founder's preview of that same investor.
  const cookie = await adminCookie();
  const pv = mockRes(); await previewRoom(asAdmin(cookie, { method: 'GET', query: { investorId: String(invId) } }), pv);
  assert.equal(pv.statusCode, 200);
  const pvJson = pv.json_();
  // Founder sees the investor's exact sections + access grant.
  assert.deepEqual(pvJson.sections, ovJson.sections);
  assert.deepEqual(pvJson.access, ovJson.access);
  assert.equal(pvJson.preview.investorId, invId);
  assert.equal(pvJson.preview.email, 'a@fund.vc');
  // L3+NDA: 1-3 unlocked, 4 gated, and no higher-tier document name leaks.
  assert.equal(pvJson.sections.find((s) => s.level === 3).state, 'unlocked');
  assert.equal(pvJson.sections.find((s) => s.level === 4).state, 'gate');
  assert.equal(JSON.stringify(pvJson).includes('Cap Table'), false);
  // The preview is written to the audit log.
  const logs = await store.listLogs({ limit: 20 });
  assert.equal(logs.some((l) => l.event === 'admin_action' && /previewed data room as a@fund\.vc/.test(l.detail)), true);
});
