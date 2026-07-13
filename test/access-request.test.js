// Investor Access gateway intake: validation, storage, neutral response, gating.
import { mockReq, mockRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/access-request.js';
import { ensureSchema, resetDbForTests } from '../api/_lib/db.js';
import * as store from '../api/_lib/store.js';

test.before(async () => { await ensureSchema(); });
test.beforeEach(async () => { await resetDbForTests(); });

const VALID = {
  fullName: 'Katharina Vogel',
  professionalEmail: 'k.vogel@nordwind.vc',
  organisation: 'Nordwind Ventures',
  role: 'General Partner',
  country: 'Germany',
  linkedin: 'https://linkedin.com/in/kvogel',
  investorType: 'Venture capital',
  ticketRange: 'major',
  roleInRound: 'Participating investor',
  interestArea: 'HealthTech / clinical AI',
  timeline: 'Within 60 days',
  meetingType: 'qualified40',
  message: 'We invest in clinician-governed health infrastructure across the EU.',
  accuracy: true,
  privacy: true,
};

let ipSeq = 0;
async function submit(bodyOverrides = {}, headers = { origin: TEST_ORIGIN }, ip) {
  // Unique IP per call so the per-IP rate limiter (tested separately) doesn't
  // bleed across validation tests.
  const req = mockReq({ method: 'POST', headers, body: { ...VALID, ...bodyOverrides }, ip: ip || `198.51.100.${++ipSeq % 250}` });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test('valid submission is stored, logged, and returns a neutral pending response', async () => {
  const res = await submit();
  assert.equal(res.statusCode, 200);
  const j = res.json_();
  assert.equal(j.ok, true);
  assert.match(j.requestId, /^VB-\d{14}-[0-9A-F]{5}$/);
  assert.equal(j.status, 'pending');
  // Response must NOT leak any grant: no password, token, cookie, or data-room link.
  assert.equal(res.getHeader('set-cookie'), undefined);
  const blob = JSON.stringify(j).toLowerCase();
  for (const bad of ['password', 'investor-room', 'nda', 'token', 'secret']) {
    assert.equal(blob.includes(bad), false, `response leaked "${bad}"`);
  }
  // Stored as pending; no investor account created.
  const reqs = await store.listAccessRequests();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].status, 'pending');
  assert.equal(reqs[0].email, 'k.vogel@nordwind.vc');
  assert.ok(reqs[0].internalRoutingHint.length > 0);
  assert.equal(await store.getInvestorByEmail('k.vogel@nordwind.vc'), null);
  // Audit event recorded.
  const logs = await store.listLogs({ limit: 10 });
  assert.equal(logs.some((l) => l.event === 'request_submitted'), true);
});

test('Lead/Anchor meeting is never auto-bookable (gated behind review)', async () => {
  const res = await submit({ meetingType: 'lead60', ticketRange: 'lead', roleInRound: 'Lead investor' });
  const j = res.json_();
  assert.equal(j.ok, true);
  assert.equal(j.booking.eligible, false);
  assert.equal(j.booking.url, null);
  assert.match(j.booking.note, /review/i);
});

test('non-gated meeting is eligible but only surfaces a URL when configured', async () => {
  const res = await submit({ meetingType: 'intro20' });
  const j = res.json_();
  assert.equal(j.booking.eligible, true);
  assert.equal(j.booking.url, null); // no BOOKING_* env in tests
});

test('free-mail address is rejected', async () => {
  const res = await submit({ professionalEmail: 'someone@gmail.com' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json_().ok, false);
});

test('missing consent is rejected', async () => {
  const res = await submit({ privacy: false });
  assert.equal(res.statusCode, 400);
  assert.equal((await store.listAccessRequests()).length, 0);
});

test('invalid meeting/ticket values are rejected', async () => {
  assert.equal((await submit({ meetingType: 'lead90' })).statusCode, 400);
  assert.equal((await submit({ ticketRange: 'infinite' })).statusCode, 400);
});

test('honeypot submissions are silently accepted but store nothing', async () => {
  const res = await submit({ companyWebsite: 'http://spam.example' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json_().ok, true);
  assert.equal((await store.listAccessRequests()).length, 0);
});

test('cross-site Origin is forbidden', async () => {
  const res = await submit({}, { origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
});

test('repeated submissions from one IP are rate-limited', async () => {
  const ip = '198.51.100.253';
  let last;
  for (let i = 0; i < 7; i++) last = await submit({}, { origin: TEST_ORIGIN }, ip);
  assert.equal(last.statusCode, 429);
  assert.ok(last.getHeader('retry-after'));
});
