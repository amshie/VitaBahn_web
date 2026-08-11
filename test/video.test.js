// Overview briefing video: chunked founder upload -> published -> streamed to EVERY
// investor at every level, NDA or not. Covers the authorisation boundary, Range
// serving (seeking), completeness enforcement and replace/delete cleanup.
import { mockReq, mockRes, cookieFromRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';
import { hashPassword } from '../api/_lib/auth.js';

import investorLogin from '../api/_handlers/auth/investor-login.js';
import adminLogin from '../api/_handlers/auth/admin-login.js';
import adminVideo from '../api/_handlers/admin/video.js';
import roomVideo from '../api/_handlers/room/video.js';
import roomOverview from '../api/_handlers/room/overview.js';

const PW = 'Investor-Pass-1';
const ADMIN_PW = 'Founder-Console-Pass-1';

// 7 000 bytes at a 3 000-byte chunk size => 3 chunks (3000 / 3000 / 1000), which
// exercises both the full-chunk and remainder paths.
const SIZE = 7000;
const CHUNK = 3000;
const CONTENT = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

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
const asInv = (cookie, extra = {}) => mockReq({ cookies: { vb_inv: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });
const asAdmin = (cookie, extra = {}) => mockReq({ cookies: { vb_adm: cookie }, headers: { origin: TEST_ORIGIN }, ...extra });

async function callAdminVideo(cookie, extra) { const r = mockRes(); await adminVideo(asAdmin(cookie, extra), r); return r; }

// Full founder upload: init -> every chunk -> finish. Returns the published video.
async function publishVideo(cookie, { size = SIZE, chunkSize = CHUNK, contentType = 'video/mp4', title = 'Investor briefing', content = CONTENT } = {}) {
  const init = await callAdminVideo(cookie, { method: 'POST', query: { action: 'init' }, body: { title, contentType, size, chunkSize } });
  assert.equal(init.statusCode, 200, init.text);
  const id = init.json_().video.id;
  const total = Math.ceil(size / chunkSize);
  for (let seq = 0; seq < total; seq++) {
    const slice = content.subarray(seq * chunkSize, Math.min(size, (seq + 1) * chunkSize));
    const r = await callAdminVideo(cookie, { method: 'POST', query: { action: 'chunk', id, seq: String(seq) }, body: slice });
    assert.equal(r.statusCode, 200, r.text);
  }
  const fin = await callAdminVideo(cookie, { method: 'POST', query: { action: 'finish', id }, body: {} });
  assert.equal(fin.statusCode, 200, fin.text);
  return fin.json_().video;
}

async function stream(cookie, range) {
  const r = mockRes();
  await roomVideo(asInv(cookie, { method: 'GET', headers: range ? { origin: TEST_ORIGIN, range } : { origin: TEST_ORIGIN } }), r);
  return r;
}

test('unauthenticated video request is denied', async () => {
  await seedAdmin();
  await publishVideo(await adminCookie());
  const r = mockRes();
  await roomVideo(mockReq({ method: 'GET', headers: { origin: TEST_ORIGIN } }), r);
  assert.equal(r.statusCode, 401);
});

test('non-admin cannot upload a video', async () => {
  await mkInvestor('inv@example.com', 5, { ndaSigned: true });
  const cookie = await investorCookie('inv@example.com');
  const r = mockRes();
  await adminVideo(asInv(cookie, { method: 'POST', query: { action: 'init' }, body: { contentType: 'video/mp4', size: SIZE, chunkSize: CHUNK } }), r);
  assert.equal(r.statusCode, 401);
  assert.equal(await store.getActiveRoomVideo(), null);
});

test('every level sees the video — L1 without an NDA included', async () => {
  await seedAdmin();
  const admin = await adminCookie();
  await publishVideo(admin);

  for (const [email, level, nda] of [['a@x.com', 1, false], ['b@x.com', 2, false], ['c@x.com', 5, true]]) {
    await mkInvestor(email, level, { ndaSigned: nda });
    const cookie = await investorCookie(email);

    const ov = mockRes();
    await roomOverview(asInv(cookie), ov);
    const payload = ov.json_();
    assert.ok(payload.video, `level ${level} should receive video metadata`);
    assert.equal(payload.video.title, 'Investor briefing');
    assert.equal(payload.video.size, SIZE);

    const r = await stream(cookie, 'bytes=0-');
    assert.equal(r.statusCode, 206, `level ${level} should be able to stream`);
    assert.equal(r.buffer.length, SIZE);
    assert.ok(r.buffer.equals(CONTENT));
  }
});

test('range request returns the exact requested slice', async () => {
  await seedAdmin();
  await publishVideo(await adminCookie());
  await mkInvestor('inv@example.com', 1);
  const cookie = await investorCookie('inv@example.com');

  // A window spanning a chunk boundary (chunk 0 ends at 2999).
  const r = await stream(cookie, 'bytes=2500-3500');
  assert.equal(r.statusCode, 206);
  assert.equal(r.getHeader('content-range'), `bytes 2500-3500/${SIZE}`);
  assert.equal(r.getHeader('accept-ranges'), 'bytes');
  assert.ok(r.buffer.equals(CONTENT.subarray(2500, 3501)));

  // Suffix form: the last 100 bytes.
  const tail = await stream(cookie, 'bytes=-100');
  assert.equal(tail.statusCode, 206);
  assert.ok(tail.buffer.equals(CONTENT.subarray(SIZE - 100)));

  // Unsatisfiable range.
  const bad = await stream(cookie, 'bytes=99999-100000');
  assert.equal(bad.statusCode, 416);
});

test('a request with no Range header streams the whole video', async () => {
  await seedAdmin();
  await publishVideo(await adminCookie());
  await mkInvestor('inv@example.com', 3, { ndaSigned: true });
  const r = await stream(await investorCookie('inv@example.com'));
  assert.equal(r.statusCode, 200);
  assert.equal(Number(r.getHeader('content-length')), SIZE);
  assert.ok(r.buffer.equals(CONTENT));
});

test('an incomplete upload is never published', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const init = await callAdminVideo(cookie, { method: 'POST', query: { action: 'init' }, body: { contentType: 'video/mp4', size: SIZE, chunkSize: CHUNK } });
  const id = init.json_().video.id;
  // Only the first of three chunks.
  await callAdminVideo(cookie, { method: 'POST', query: { action: 'chunk', id, seq: '0' }, body: CONTENT.subarray(0, CHUNK) });

  const fin = await callAdminVideo(cookie, { method: 'POST', query: { action: 'finish', id }, body: {} });
  assert.equal(fin.statusCode, 409);
  assert.equal(await store.getActiveRoomVideo(), null);

  await mkInvestor('inv@example.com', 2);
  const r = await stream(await investorCookie('inv@example.com'), 'bytes=0-');
  assert.equal(r.statusCode, 404);
});

test('a mis-sized chunk is rejected', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const init = await callAdminVideo(cookie, { method: 'POST', query: { action: 'init' }, body: { contentType: 'video/mp4', size: SIZE, chunkSize: CHUNK } });
  const id = init.json_().video.id;
  const r = await callAdminVideo(cookie, { method: 'POST', query: { action: 'chunk', id, seq: '0' }, body: CONTENT.subarray(0, 42) });
  assert.equal(r.statusCode, 400);
  assert.match(r.json_().error, /must be 3000 bytes/);
});

test('a media type carrying parameters is accepted and stored bare', async () => {
  await seedAdmin();
  const v = await publishVideo(await adminCookie(), { contentType: 'video/mp4; codecs="avc1.42E01E"' });
  assert.equal(v.contentType, 'video/mp4');

  await mkInvestor('inv@example.com', 1);
  const r = await stream(await investorCookie('inv@example.com'), 'bytes=0-');
  assert.equal(r.getHeader('content-type'), 'video/mp4');
});

test('non-video uploads are refused', async () => {
  await seedAdmin();
  const r = await callAdminVideo(await adminCookie(), { method: 'POST', query: { action: 'init' }, body: { contentType: 'application/pdf', size: SIZE, chunkSize: CHUNK } });
  assert.equal(r.statusCode, 400);
});

test('publishing a replacement drops the previous video and its bytes', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const first = await publishVideo(cookie, { title: 'Old briefing' });

  const replacement = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7) % 251));
  const second = await publishVideo(cookie, { title: 'New briefing', size: 4000, chunkSize: 2000, content: replacement });

  assert.notEqual(second.id, first.id);
  const active = await store.getActiveRoomVideo();
  assert.equal(active.id, second.id);
  assert.equal(active.title, 'New briefing');

  // The superseded row and every one of its chunks are gone.
  assert.equal(await store.getRoomVideoById(first.id), null);
  assert.equal((await store.roomVideoUploadedBytes(first.id)).chunks, 0);

  await mkInvestor('inv@example.com', 1);
  const r = await stream(await investorCookie('inv@example.com'), 'bytes=0-');
  assert.ok(r.buffer.equals(replacement));
});

test('founder can delete the video and the room stops offering it', async () => {
  await seedAdmin();
  const cookie = await adminCookie();
  const v = await publishVideo(cookie);

  const del = await callAdminVideo(cookie, { method: 'DELETE', body: { id: v.id } });
  assert.equal(del.statusCode, 200);
  assert.equal(await store.getActiveRoomVideo(), null);
  assert.equal((await store.roomVideoUploadedBytes(v.id)).chunks, 0);

  await mkInvestor('inv@example.com', 4, { ndaSigned: true });
  const invCookie = await investorCookie('inv@example.com');

  const ov = mockRes();
  await roomOverview(asInv(invCookie), ov);
  assert.equal(ov.json_().video, null);

  const r = await stream(invCookie, 'bytes=0-');
  assert.equal(r.statusCode, 404);
});

test('a revoked investor cannot stream the video', async () => {
  await seedAdmin();
  await publishVideo(await adminCookie());
  await mkInvestor('inv@example.com', 3, { ndaSigned: true });
  const cookie = await investorCookie('inv@example.com');
  assert.equal((await stream(cookie, 'bytes=0-')).statusCode, 206);

  const id = (await store.getInvestorByEmail('inv@example.com')).id;
  await store.updateInvestor(id, { revoked: true });
  assert.equal((await stream(cookie, 'bytes=0-')).statusCode, 401);
});

test('playback is written to the audit log', async () => {
  await seedAdmin();
  await publishVideo(await adminCookie());
  await mkInvestor('inv@example.com', 1);
  const cookie = await investorCookie('inv@example.com');

  await stream(cookie, 'bytes=0-1000');   // first segment -> logged
  await stream(cookie, 'bytes=1001-2000'); // continuation -> not logged again

  const logs = await store.listLogs({ limit: 50 });
  const views = logs.filter((l) => l.event === 'document_view' && /overview video/.test(l.detail || ''));
  assert.equal(views.length, 1);
});
