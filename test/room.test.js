// Security heart: authentication, per-user level + NDA enforcement, revocation,
// expiry, and full access logging — exercised on both authenticated and
// unauthenticated paths.
import { mockReq, mockRes, cookieFromRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import { hashPassword } from '../api/_lib/auth.js';

import investorLogin from '../api/auth/investor-login.js';
import pageRoom from '../api/page-room.js';
import roomSession from '../api/room/session.js';
import roomOverview from '../api/room/overview.js';
import roomDocuments from '../api/room/documents.js';
import roomDocument from '../api/room/document.js';
import { PDFDocument } from 'pdf-lib';

const PW = 'Investor-Pass-1';

async function realPdfBytes(text = 'Confidential sample') {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]).drawText(text, { x: 20, y: 150, size: 12 });
  return Buffer.from(await pdf.save());
}

async function seed() {
  // Documents at three restriction levels.
  await store.insertDocument({ id: 'D-open', title: 'One-Pager', minLevel: 2, tier: 1, contentType: 'application/pdf', size: 3, bytes: Buffer.from('ONE') });
  await store.insertDocument({ id: 'D-nda', title: 'Financial Model', minLevel: 3, tier: 2, contentType: 'application/pdf', size: 3, bytes: Buffer.from('FIN') });
  await store.insertDocument({ id: 'D-lead', title: 'Cap Table', minLevel: 4, tier: 2, contentType: 'application/pdf', size: 3, bytes: Buffer.from('CAP') });

  const mk = async (email, level, opts = {}) => {
    const id = await store.createInvestor({ email, name: email.split('@')[0], accessLevel: level });
    await store.updateInvestor(id, { passwordHash: hashPassword(PW), ...opts });
    return id;
  };
  return {
    l1: await mk('l1@fund.vc', 1),
    l2: await mk('l2@fund.vc', 2),
    l3nda: await mk('l3nda@fund.vc', 3, { ndaSigned: true }),
    l3no: await mk('l3no@fund.vc', 3, { ndaSigned: false }),
    l4nda: await mk('l4@fund.vc', 4, { ndaSigned: true }),
    revoked: await mk('rev@fund.vc', 3, { ndaSigned: true, revoked: true }),
    expired: await mk('exp@fund.vc', 3, { ndaSigned: true, expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  };
}

async function login(email, password = PW) {
  const res = mockRes();
  await investorLogin(mockReq({ method: 'POST', headers: { origin: TEST_ORIGIN }, body: { email, password } }), res);
  return { res, cookie: cookieFromRes(res, 'vb_inv') };
}
const authed = (cookie, extra = {}) => mockReq({ cookies: cookie ? { vb_inv: cookie } : {}, ...extra });

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

test('login: success sets cookie + logs; wrong password 401 + logs failure', async () => {
  await seed();
  const ok = await login('l2@fund.vc');
  assert.equal(ok.res.statusCode, 200);
  assert.ok(ok.cookie, 'session cookie set');
  assert.match(String(ok.res.getHeader('set-cookie')), /HttpOnly/);

  const bad = await login('l2@fund.vc', 'wrong');
  assert.equal(bad.res.statusCode, 401);
  assert.equal(bad.cookie, null);

  const logs = await store.listLogs({ limit: 20 });
  assert.equal(logs.some((l) => l.event === 'login_success'), true);
  assert.equal(logs.some((l) => l.event === 'login_failed'), true);
});

test('unauthenticated: all room routes deny; page redirects to login', async () => {
  await seed();
  const s = mockRes(); await roomSession(authed(null), s); assert.equal(s.statusCode, 401);
  const d = mockRes(); await roomDocuments(authed(null), d); assert.equal(d.statusCode, 401);
  const f = mockRes(); await roomDocument(authed(null, { query: { id: 'D-open' } }), f); assert.equal(f.statusCode, 401);
  const p = mockRes(); await pageRoom(authed(null), p);
  assert.equal(p.statusCode, 302);
  assert.equal(p.getHeader('location'), '/investor-login');
});

test('level-2 investor sees only open docs; NDA + higher docs are denied', async () => {
  await seed();
  const { cookie } = await login('l2@fund.vc');

  const d = mockRes(); await roomDocuments(authed(cookie), d);
  const ids = d.json_().documents.map((x) => x.id);
  assert.deepEqual(ids.sort(), ['D-open']); // no name leakage of D-nda/D-lead

  const open = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-open' } }), open);
  assert.equal(open.statusCode, 200);
  assert.equal(open.buffer.toString(), 'ONE');

  const nda = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-nda' } }), nda);
  assert.equal(nda.statusCode, 403);
  const lead = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-lead' } }), lead);
  assert.equal(lead.statusCode, 403);

  const logs = await store.listLogs({ limit: 30 });
  assert.equal(logs.some((l) => l.event === 'document_view' && l.documentId === 'D-open'), true);
  assert.equal(logs.filter((l) => l.event === 'document_denied').length >= 2, true);
});

test('level-3 with NDA can view NDA docs but not level-4', async () => {
  await seed();
  const { cookie } = await login('l3nda@fund.vc');
  const d = mockRes(); await roomDocuments(authed(cookie), d);
  assert.deepEqual(d.json_().documents.map((x) => x.id).sort(), ['D-nda', 'D-open']);

  const nda = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-nda' } }), nda);
  assert.equal(nda.statusCode, 200);
  assert.equal(nda.buffer.toString(), 'FIN');

  const lead = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-lead' } }), lead);
  assert.equal(lead.statusCode, 403);
});

test('level-3 WITHOUT NDA cannot see or open NDA docs', async () => {
  await seed();
  const { cookie } = await login('l3no@fund.vc');
  const d = mockRes(); await roomDocuments(authed(cookie), d);
  assert.deepEqual(d.json_().documents.map((x) => x.id).sort(), ['D-open']); // NDA doc hidden

  const nda = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-nda' } }), nda);
  assert.equal(nda.statusCode, 403);
  assert.match(nda.json_().error, /NDA/);
});

test('revocation takes effect immediately for an existing session', async () => {
  const ids = await seed();
  const { cookie } = await login('l3nda@fund.vc');
  // session works…
  let s = mockRes(); await roomSession(authed(cookie), s); assert.equal(s.statusCode, 200);
  // …then revoke in the DB (as the console would)
  await store.updateInvestor(ids.l3nda, { revoked: true, revokedAt: new Date().toISOString() });
  s = mockRes(); await roomSession(authed(cookie), s);
  assert.equal(s.statusCode, 401);
  const doc = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-nda' } }), doc);
  assert.equal(doc.statusCode, 401);
  const logs = await store.listLogs({ limit: 30 });
  assert.equal(logs.some((l) => l.event === 'session_invalid' && l.detail === 'revoked'), true);
});

test('revoked / expired accounts cannot even log in', async () => {
  await seed();
  const rev = await login('rev@fund.vc');
  assert.equal(rev.res.statusCode, 403);
  assert.equal(rev.cookie, null);
  const exp = await login('exp@fund.vc');
  assert.equal(exp.res.statusCode, 403);
  assert.equal(exp.cookie, null);
});

test('expiry blocks an existing session immediately', async () => {
  const ids = await seed();
  const { cookie } = await login('l3nda@fund.vc');
  await store.updateInvestor(ids.l3nda, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const s = mockRes(); await roomSession(authed(cookie), s);
  assert.equal(s.statusCode, 401);
  assert.equal(s.json_().reason, 'expired');
});

test('authenticated room page returns the shell (noindex), not a redirect', async () => {
  await seed();
  const { cookie } = await login('l2@fund.vc');
  const p = mockRes(); await pageRoom(authed(cookie), p);
  assert.equal(p.statusCode, 200);
  assert.match(String(p.getHeader('x-robots-tag')), /noindex/);
  assert.match(p.text, /Investor Data Room/);
  // The shell must not embed document bytes/names.
  assert.equal(p.text.includes('Financial Model'), false);
});

// ---------------------------------------------------------------------------
// /api/room/overview — the server decides which sections/documents exist per user.
// ---------------------------------------------------------------------------
async function overview(cookie) { const r = mockRes(); await roomOverview(authed(cookie), r); return r; }
const secOf = (j, lvl) => j.sections.find((s) => s.level === lvl);
// Titles of the seeded restricted docs that must never leak above their tier.
const RESTRICTED_NAMES = ['One-Pager', 'Financial Model', 'Cap Table'];
const leaksAny = (raw) => RESTRICTED_NAMES.some((n) => raw.includes(n));

test('overview: unauthenticated is denied', async () => {
  await seed();
  const r = mockRes(); await roomOverview(authed(null), r);
  assert.equal(r.statusCode, 401);
});

test('overview L1: only the (empty) Overview tier; next is the verify gate; no names leak', async () => {
  await seed();
  const { cookie } = await login('l1@fund.vc');
  const r = await overview(cookie); const j = r.json_();
  assert.equal(r.statusCode, 200);
  assert.equal(j.access.level, 1);
  assert.equal(j.access.docCount, 0);
  assert.equal(secOf(j, 1).state, 'unlocked');
  assert.equal(secOf(j, 2).state, 'gate');
  assert.equal(secOf(j, 2).gate.kind, 'verify');
  assert.equal(secOf(j, 3).state, 'locked');
  // gate + locked sections carry NO docs array…
  assert.equal('docs' in secOf(j, 2), false);
  assert.equal('docs' in secOf(j, 3), false);
  // …and no restricted document name appears anywhere in the payload.
  assert.equal(leaksAny(r.text), false);
});

test('overview L2: open docs shown; Diligence is an NDA gate; NDA/lead names hidden', async () => {
  await seed();
  const { cookie } = await login('l2@fund.vc');
  const r = await overview(cookie); const j = r.json_();
  assert.equal(secOf(j, 2).state, 'unlocked');
  assert.deepEqual(secOf(j, 2).docs.map((d) => d.name), ['One-Pager']);
  assert.equal(secOf(j, 3).state, 'gate');
  assert.equal(secOf(j, 3).gate.kind, 'nda');
  assert.equal(secOf(j, 4).state, 'locked');
  assert.equal(j.access.docCount, 1);
  // The L3/L4 document names are not in the response.
  assert.equal(r.text.includes('Financial Model'), false);
  assert.equal(r.text.includes('Cap Table'), false);
});

test('overview L3 WITHOUT NDA: Diligence is a gate (not docs); NDA name never sent', async () => {
  await seed();
  const { cookie } = await login('l3no@fund.vc');
  const r = await overview(cookie); const j = r.json_();
  assert.equal(secOf(j, 3).state, 'gate');
  assert.equal(secOf(j, 3).gate.kind, 'nda');
  assert.equal('docs' in secOf(j, 3), false);
  assert.equal(r.text.includes('Financial Model'), false);
  assert.equal(j.access.docCount, 1); // only the open-tier One-Pager
});

test('overview L3 WITH NDA: Diligence unlocked; named-approval gate next; L4 name hidden', async () => {
  await seed();
  const { cookie } = await login('l3nda@fund.vc');
  const r = await overview(cookie); const j = r.json_();
  assert.equal(secOf(j, 3).state, 'unlocked');
  assert.deepEqual(secOf(j, 3).docs.map((d) => d.name), ['Financial Model']);
  assert.equal(secOf(j, 4).state, 'gate');
  assert.equal(secOf(j, 4).gate.kind, 'named');
  assert.equal(r.text.includes('Cap Table'), false);
  assert.equal(j.access.docCount, 2);
});

test('overview L4: Lead/Anchor unlocked; closing gate next; no Level 0 anywhere', async () => {
  await seed();
  const { cookie } = await login('l4@fund.vc');
  const r = await overview(cookie); const j = r.json_();
  assert.equal(secOf(j, 4).state, 'unlocked');
  assert.deepEqual(secOf(j, 4).docs.map((d) => d.name), ['Cap Table']);
  assert.equal(secOf(j, 5).state, 'gate');
  assert.equal(secOf(j, 5).gate.kind, 'named');
  assert.equal(j.access.docCount, 3);
  assert.equal(j.sections.some((s) => s.level === 0), false);
  assert.ok(j.access.level >= 1);
});

test('download rule: NDA-tier is view-only (?dl refused + logged); open-tier downloads', async () => {
  await seed();
  const { cookie } = await login('l3nda@fund.vc');
  // Inline view of an NDA-tier doc is allowed…
  const inline = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-nda' } }), inline);
  assert.equal(inline.statusCode, 200);
  assert.match(String(inline.getHeader('content-disposition')), /inline/);
  // …but an explicit download of it is refused.
  const dl = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-nda', dl: '1' } }), dl);
  assert.equal(dl.statusCode, 403);
  assert.match(dl.json_().error, /view-only|download/i);
  // Open-tier documents may be downloaded (attachment).
  const openDl = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-open', dl: '1' } }), openDl);
  assert.equal(openDl.statusCode, 200);
  assert.match(String(openDl.getHeader('content-disposition')), /attachment/);
  // The refusal is in the audit log.
  const logs = await store.listLogs({ limit: 40 });
  assert.equal(logs.some((l) => l.event === 'document_denied' && /download-restricted/.test(l.detail)), true);
});

test('served PDFs are watermarked with the recipient identity', async () => {
  await seed();
  await store.insertDocument({ id: 'D-realpdf', title: 'Sample Brief', minLevel: 2, tier: 1, contentType: 'application/pdf', size: 0, bytes: await realPdfBytes() });
  const { cookie } = await login('l2@fund.vc');
  const r = mockRes(); await roomDocument(authed(cookie, { query: { id: 'D-realpdf' } }), r);
  assert.equal(r.statusCode, 200);
  const out = r.buffer;
  assert.equal(out.slice(0, 5).toString(), '%PDF-');
  // Recipient stamped into the served bytes (greppable) …
  assert.equal(out.includes(Buffer.from('l2@fund.vc')), true);
  // … and machine-readable in the PDF metadata after a round-trip.
  const re = await PDFDocument.load(out, { updateMetadata: false });
  assert.match(String(re.getSubject() || ''), /l2@fund\.vc/);
  // The open is logged as watermarked.
  const logs = await store.listLogs({ limit: 20 });
  assert.equal(logs.some((l) => l.event === 'document_view' && /watermarked/.test(l.detail)), true);
});
