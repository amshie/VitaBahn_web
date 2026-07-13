// NDA upload flow: investor submits a signed PDF -> founder reviews -> accept opens
// Diligence (L3); reject lets the investor re-upload. Plus template surfacing +
// admin-only access to the submitted bytes.
import { mockReq, mockRes, cookieFromRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import { hashPassword } from '../api/_lib/auth.js';

import investorLogin from '../api/auth/investor-login.js';
import adminLogin from '../api/auth/admin-login.js';
import roomNda from '../api/room/nda.js';
import roomOverview from '../api/room/overview.js';
import adminNda from '../api/admin/nda.js';

const PW = 'Investor-Pass-1';
const ADMIN_PW = 'Founder-Console-Pass-1';

async function pdfBytes(text = 'Signed NDA') {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]).drawText(text, { x: 20, y: 150, size: 12 });
  return Buffer.from(await pdf.save());
}

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

async function seedAdmin() { await store.createAdmin({ email: 'founder@vitabahn.com', name: 'Founder', passwordHash: hashPassword(ADMIN_PW) }); }
async function adminCookie() {
  const res = mockRes();
  await adminLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email: 'founder@vitabahn.com', password: ADMIN_PW } }), res);
  return cookieFromRes(res, 'vb_adm');
}
async function mkInvestor(email, level, opts = {}) {
  const id = await store.createInvestor({ email, name: email.split('@')[0], accessLevel: level });
  await store.updateInvestor(id, { passwordHash: hashPassword(PW), ...opts });
  return id;
}
async function investorCookie(email) {
  const res = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email, password: PW } }), res);
  return cookieFromRes(res, 'vb_inv');
}
const asInv = (cookie, extra = {}) => mockReq({ cookies: { vb_inv: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });
const asAdmin = (cookie, extra = {}) => mockReq({ cookies: { vb_adm: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });
async function overview(cookie) { const r = mockRes(); await roomOverview(asInv(cookie), r); return r.json_(); }
const secOf = (j, lvl) => j.sections.find((s) => s.level === lvl);
async function upload(cookie, buf, ct = 'application/pdf', fn = 'nda.pdf') {
  const res = mockRes();
  await roomNda(asInv(cookie, { method: 'POST', body: buf, query: { filename: fn, contentType: ct } }), res);
  return res;
}

test('unauthenticated NDA upload is denied', async () => {
  const r = mockRes();
  await roomNda(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: await pdfBytes() }), r);
  assert.equal(r.statusCode, 401);
});

test('investor uploads a signed NDA — stored pending, logged, reflected in overview', async () => {
  await seedAdmin();
  const id = await mkInvestor('l2@fund.vc', 2);
  const cookie = await investorCookie('l2@fund.vc');

  let j = await overview(cookie);
  assert.equal(j.nda.status, 'required');
  assert.equal(secOf(j, 3).state, 'gate');

  const up = mockRes();
  await roomNda(asInv(cookie, { method: 'POST', body: await pdfBytes(), query: { filename: 'nda.pdf', contentType: 'application/pdf' } }), up);
  assert.equal(up.statusCode, 200);
  assert.equal(up.json_().status, 'submitted');

  const sub = await store.getLatestNdaSubmission(id);
  assert.equal(sub.status, 'submitted');
  assert.equal((await store.listLogs({ actorId: id })).some((l) => l.event === 'nda_submitted'), true);

  j = await overview(cookie);
  assert.equal(j.nda.status, 'submitted');
  assert.equal(secOf(j, 3).state, 'gate'); // still gated until the founder accepts
});

test('non-PDF upload is rejected', async () => {
  await mkInvestor('l2@fund.vc', 2);
  const cookie = await investorCookie('l2@fund.vc');
  const r = await upload(cookie, Buffer.from('this is not a pdf'), 'text/plain', 'x.txt');
  assert.equal(r.statusCode, 400);
});

test('founder accepts → NDA executed and Diligence (L3) opens for the investor', async () => {
  await seedAdmin();
  await store.insertDocument({ id: 'D-nda', title: 'Financial Model', minLevel: 3, tier: 2, contentType: 'application/pdf', size: 3, bytes: Buffer.from('FIN') });
  const id = await mkInvestor('l2@fund.vc', 2);
  const invc = await investorCookie('l2@fund.vc');
  await upload(invc, await pdfBytes());
  const sub = await store.getLatestNdaSubmission(id);

  const ac = await adminCookie();
  const patch = mockRes();
  await adminNda(asAdmin(ac, { method: 'PATCH', body: { id: sub.id, action: 'accept' } }), patch);
  assert.equal(patch.statusCode, 200);

  const inv = await store.getInvestorById(id);
  assert.equal(inv.ndaSigned, true);
  assert.equal(inv.accessLevel, 3); // NDA is the L2->L3 gate

  const j = await overview(invc); // session re-checked against DB — change is immediate
  assert.equal(j.nda.status, 'executed');
  assert.equal(secOf(j, 3).state, 'unlocked');
  assert.deepEqual(secOf(j, 3).docs.map((d) => d.name), ['Financial Model']);
});

test('founder rejects → overview flags rejected and the investor can re-upload', async () => {
  await seedAdmin();
  const id = await mkInvestor('l2@fund.vc', 2);
  const invc = await investorCookie('l2@fund.vc');
  await upload(invc, await pdfBytes());
  const sub = await store.getLatestNdaSubmission(id);

  const ac = await adminCookie();
  await adminNda(asAdmin(ac, { method: 'PATCH', body: { id: sub.id, action: 'reject' } }), mockRes());

  const j = await overview(invc);
  assert.equal(j.nda.status, 'required');
  assert.equal(j.nda.rejected, true);

  const up2 = await upload(invc, await pdfBytes('corrected'), 'application/pdf', 'nda2.pdf');
  assert.equal(up2.statusCode, 200);
  assert.equal((await store.getLatestNdaSubmission(id)).status, 'submitted');
});

test('signed NDA bytes are founder-only; investor sessions cannot reach the review route', async () => {
  await seedAdmin();
  const id = await mkInvestor('l2@fund.vc', 2);
  const invc = await investorCookie('l2@fund.vc');
  await upload(invc, await pdfBytes());
  const sub = await store.getLatestNdaSubmission(id);
  const ac = await adminCookie();

  const view = mockRes();
  await adminNda(asAdmin(ac, { method: 'GET', query: { id: String(sub.id) } }), view);
  assert.equal(view.statusCode, 200);
  assert.equal(view.buffer.slice(0, 5).toString(), '%PDF-');

  // an investor session must not reach the admin NDA route (GET or PATCH)
  const g = mockRes(); await adminNda(asInv(invc, { method: 'GET', query: { id: String(sub.id) } }), g);
  assert.equal(g.statusCode, 401);
  const p = mockRes(); await adminNda(asInv(invc, { method: 'PATCH', body: { id: sub.id, action: 'accept' } }), p);
  assert.equal(p.statusCode, 401);
});

test('overview surfaces the NDA template an L2 investor can download', async () => {
  await store.insertDocument({ id: 'D-tpl', title: 'NDA (template)', minLevel: 2, tier: 1, contentType: 'application/pdf', size: 3, bytes: await pdfBytes('template') });
  await store.setNdaTemplate('D-tpl');
  await mkInvestor('l2@fund.vc', 2);
  const j = await overview(await investorCookie('l2@fund.vc'));
  assert.equal(j.nda.templateDocId, 'D-tpl');
  assert.equal(j.nda.templateName, 'NDA (template)');
});
