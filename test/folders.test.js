// Folders group documents inside ONE disclosure level, and everything filed in a
// folder takes that folder's level. Covers the console CRUD, the level cascade that
// keeps that promise true, and how folders surface in the investor room — named at
// every level, openable only at the granted one.
import { mockReq, mockRes, cookieFromRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import { hashPassword } from '../api/_lib/auth.js';

import investorLogin from '../api/auth/investor-login.js';
import adminLogin from '../api/auth/admin-login.js';
import adminFolders from '../api/admin/folders.js';
import adminDocuments from '../api/admin/documents.js';
import roomOverview from '../api/room/overview.js';
import roomDocument from '../api/room/document.js';

const PW = 'Investor-Pass-1';
const ADMIN_PW = 'Founder-Console-Pass-1';

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

async function seedAdmin() {
  await store.createAdmin({ email: 'founder@vitabahn.com', name: 'Founder', passwordHash: hashPassword(ADMIN_PW) });
}
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
const asAdmin = (cookie, extra = {}) => mockReq({ cookies: { vb_adm: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });
const asInv = (cookie, extra = {}) => mockReq({ cookies: { vb_inv: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });

async function folders(cookie, extra) { const r = mockRes(); await adminFolders(asAdmin(cookie, extra), r); return r; }
async function docs(cookie, extra) { const r = mockRes(); await adminDocuments(asAdmin(cookie, extra), r); return r; }
async function overviewFor(email) {
  const r = mockRes();
  await roomOverview(asInv(await investorCookie(email)), r);
  return r.json_();
}
const allDocsOf = (j) => j.sections.flatMap((s) => [...(s.folders || []).flatMap((f) => f.docs), ...(s.docs || [])]);
const folderNamed = (j, name) => j.sections.flatMap((s) => s.folders || []).find((f) => f.name === name);

async function mkFolder(cookie, name, minLevel) {
  const r = await folders(cookie, { method: 'POST', body: { name, minLevel } });
  assert.equal(r.statusCode, 200, r.text);
  return r.json_().folder;
}
async function upload(cookie, title, query) {
  const r = await docs(cookie, { method: 'POST', query: { title, filename: `${title}.pdf`, contentType: 'application/pdf', ...query }, body: Buffer.from('PDF-' + title) });
  assert.equal(r.statusCode, 200, r.text);
  return r.json_().document;
}

test('only an admin can create folders', async () => {
  await mkInvestor('inv@example.com', 5, { ndaSigned: true });
  const r = mockRes();
  await adminFolders(asInv(await investorCookie('inv@example.com'), { method: 'POST', body: { name: 'Financials', minLevel: 3 } }), r);
  assert.equal(r.statusCode, 401);
  assert.deepEqual(await store.listFolders(), []);
});

test('a folder is created at a level and reports what it holds', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Financials', 3);
  assert.equal(f.minLevel, 3);
  assert.equal(f.docCount, 0);

  await upload(cookie, 'Model', { folderId: f.id });
  const list = (await folders(cookie, { method: 'GET' })).json_().folders;
  assert.equal(list.length, 1);
  assert.equal(list[0].docCount, 1);
});

test('a document filed in a folder inherits the folder level, ignoring any level asked for', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Diligence', 4);
  // minLevel=1 is deliberately contradictory: the folder must win, or a confidential
  // file would land in a folder that claims a stricter level than it enforces.
  const doc = await upload(cookie, 'Term Sheet', { folderId: f.id, minLevel: '1' });
  assert.equal(doc.minLevel, 4);
  assert.equal(doc.folderId, f.id);
});

test('re-levelling a folder moves its documents with it', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Legal', 2);
  const a = await upload(cookie, 'Articles', { folderId: f.id });
  const b = await upload(cookie, 'Bylaws', { folderId: f.id });
  assert.equal(a.minLevel, 2);

  const r = await folders(cookie, { method: 'PATCH', body: { id: f.id, changes: { minLevel: 5 } } });
  assert.equal(r.statusCode, 200);
  for (const id of [a.id, b.id]) {
    const doc = await store.getDocumentMeta(id);
    assert.equal(doc.minLevel, 5, `${id} should have moved to level 5`);
    assert.equal(doc.tier, 2);
  }
});

test('a document in a folder cannot be re-levelled on its own', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Clinical', 3);
  const doc = await upload(cookie, 'Dossier', { folderId: f.id });

  const r = await docs(cookie, { method: 'PATCH', body: { id: doc.id, changes: { minLevel: 1 } } });
  assert.equal(r.statusCode, 409);
  assert.match(r.json_().error, /folder/i);
  assert.equal((await store.getDocumentMeta(doc.id)).minLevel, 3);
});

test('moving a document into a folder re-levels it; moving it out keeps the level', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Anchor', 4);
  const doc = await upload(cookie, 'Loose Memo', { minLevel: '2' });
  assert.equal(doc.minLevel, 2);

  await docs(cookie, { method: 'PATCH', body: { id: doc.id, changes: { folderId: f.id } } });
  assert.equal((await store.getDocumentMeta(doc.id)).minLevel, 4);

  await docs(cookie, { method: 'PATCH', body: { id: doc.id, changes: { folderId: null } } });
  const out = await store.getDocumentMeta(doc.id);
  assert.equal(out.folderId, null);
  assert.equal(out.minLevel, 4); // keeps where it was, rather than silently reopening
});

test('deleting a folder keeps its documents and unfiles them', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Scratch', 3);
  const doc = await upload(cookie, 'Keep Me', { folderId: f.id });

  const r = await folders(cookie, { method: 'DELETE', body: { id: f.id } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json_().unfiled, 1);

  const kept = await store.getDocumentMeta(doc.id);
  assert.ok(kept, 'the document survives its folder');
  assert.equal(kept.folderId, null);
  assert.equal(kept.minLevel, 3);
  assert.deepEqual(await store.listFolders(), []);
});

test('an investor sees folder and file names at every level, but only opens their own', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const open = await mkFolder(cookie, 'Company overview', 2);
  const deep = await mkFolder(cookie, 'Cap table & terms', 4);
  await upload(cookie, 'One-Pager', { folderId: open.id });
  const capTable = await upload(cookie, 'Cap Table', { folderId: deep.id });

  await mkInvestor('l2@fund.vc', 2);
  const j = await overviewFor('l2@fund.vc');

  // Both folders are named, including the one four levels up.
  assert.ok(folderNamed(j, 'Company overview'));
  assert.ok(folderNamed(j, 'Cap table & terms'));
  assert.deepEqual(folderNamed(j, 'Cap table & terms').docs.map((d) => d.name), ['Cap Table']);

  // Openable at the granted level, locked above it.
  assert.equal(allDocsOf(j).find((d) => d.name === 'One-Pager').locked, false);
  assert.equal(allDocsOf(j).find((d) => d.name === 'Cap Table').locked, true);
  assert.equal(j.access.docCount, 1);

  // And the listing grants nothing: the bytes are still refused.
  const r = mockRes();
  await roomDocument(asInv(await investorCookie('l2@fund.vc'), { query: { id: capTable.id } }), r);
  assert.equal(r.statusCode, 403);
});

test('a folder whose level changes changes what an investor can open', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const f = await mkFolder(cookie, 'Market', 4);
  const doc = await upload(cookie, 'Market Study', { folderId: f.id });
  await mkInvestor('l2@fund.vc', 2);

  assert.equal(allDocsOf(await overviewFor('l2@fund.vc')).find((d) => d.name === 'Market Study').locked, true);

  // The founder opens the folder up to level 2 — its contents follow.
  await folders(cookie, { method: 'PATCH', body: { id: f.id, changes: { minLevel: 2 } } });
  const j = await overviewFor('l2@fund.vc');
  assert.equal(allDocsOf(j).find((d) => d.name === 'Market Study').locked, false);
  assert.equal(j.access.docCount, 1);

  const r = mockRes();
  await roomDocument(asInv(await investorCookie('l2@fund.vc'), { query: { id: doc.id } }), r);
  assert.equal(r.statusCode, 200);
});

test('folder names are rejected when empty and levels when out of range', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  assert.equal((await folders(cookie, { method: 'POST', body: { name: '   ', minLevel: 3 } })).statusCode, 400);
  assert.equal((await folders(cookie, { method: 'POST', body: { name: 'X', minLevel: 0 } })).statusCode, 400);
  assert.equal((await folders(cookie, { method: 'POST', body: { name: 'X', minLevel: 6 } })).statusCode, 400);
  assert.deepEqual(await store.listFolders(), []);
});
