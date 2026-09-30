// /api/hk2026-request — the /hk2026 landing-page forms. Contract parity with the
// PHP handler the page shipped with: same fields, same error codes, same JSON.
import { mockReq, mockRes, TEST_ORIGIN } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import handler, { _setMailerForTests } from '../api/hk2026-request.js';

// Capture what would be mailed instead of touching SMTP.
let outbox = [];
test.beforeEach(() => {
  outbox = [];
  _setMailerForTests(async (msg) => { outbox.push(msg); return { sent: true }; });
});
test.after(() => _setMailerForTests(null));

const MEETING = {
  request_type: 'MEETING', src: 'card', elapsed_ms: '8000', website_url: '',
  full_name: 'Wei Lin', email: 'wei.lin@example-clinic.hk', organization: 'Example Clinic', role: 'Medical Director',
  country: 'Hong Kong', interest: 'Pilot', objective: 'Discuss a one-site pilot.', meeting_date: '2026-10-02', meeting_time: '14:20', consent: 'yes',
};
const PILOT = { ...MEETING, request_type: 'PILOT', meeting_date: undefined, meeting_time: undefined, timing: 'During the event' };
const DATAROOM = {
  request_type: 'DATAROOM', src: 'card', elapsed_ms: '8000', website_url: '',
  full_name: 'Ana Costa', email: 'ana@example-capital.com', organization: 'Example Capital', role: 'Partner',
  website: 'example-capital.com', investor_type: 'VC', mandate: 'Seed / Series A healthtech', message: 'Line one.\nLine two.', consent: 'yes',
};

let ipSeq = 0;
async function post(body, { headers = { origin: TEST_ORIGIN }, ip } = {}) {
  const req = mockReq({ method: 'POST', headers, body, ip: ip || `198.51.100.${++ipSeq % 250}` });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test('meeting request is mailed to the recipient with Source: card and {ok:true}', async () => {
  const res = await post(MEETING);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json_(), { ok: true });
  assert.equal(outbox.length, 1);
  const m = outbox[0];
  assert.equal(m.to, 'drmotazshieban@vitabahn.com');
  assert.equal(m.subject, '[HK2026] Meeting request — Example Clinic — Wei Lin');
  assert.match(m.text, /^Meeting request via www\.vitabahn\.com\/hk2026\n/);
  assert.match(m.text, /Source: {15}card\n/);
  assert.match(m.text, /Country \/ market: {5}Hong Kong\n/);
  assert.match(m.text, /Requested slot: {7}Fri 2 Oct 2026, 14:20 \(Hong Kong time, UTC\+8\)\n/);
  assert.deepEqual(m.replyTo, { name: 'Wei Lin', address: 'wei.lin@example-clinic.hk' });
});

test('meeting forms require a real calendar slot; pilot/partnership keep the free-text timing', async () => {
  const none = await post({ ...MEETING, meeting_date: '', meeting_time: '' });
  assert.equal(none.statusCode, 422);
  assert.deepEqual(none.json_().fields, ['Meeting slot']);
  const bogus = await post({ ...MEETING, meeting_date: '2026-02-30', meeting_time: '14:20' });
  assert.deepEqual(bogus.json_().fields, ['Meeting slot']);
  const badTime = await post({ ...MEETING, request_type: 'INVESTOR_MEETING', meeting_time: '25:00' });
  assert.deepEqual(badTime.json_().fields, ['Meeting slot']);
  assert.equal(outbox.length, 0);
  const pilot = await post(PILOT);
  assert.equal(pilot.statusCode, 200);
  assert.match(outbox[0].text, /Preferred timing: {5}During the event\n/);
  assert.doesNotMatch(outbox[0].text, /Requested slot/);
});

test('data-room request keeps the multi-line message, normalises the website and carries the review reminder', async () => {
  const res = await post(DATAROOM);
  assert.equal(res.statusCode, 200);
  const m = outbox[0];
  assert.equal(m.subject, '[HK2026] Data room request — Example Capital — Ana Costa');
  assert.match(m.text, /Website \/ LinkedIn: {3}https:\/\/example-capital\.com\n/);
  assert.match(m.text, /Message: {14}Line one\.\nLine two\.\n/);
  assert.match(m.text, /Reminder: review before granting any diligence access/);
  // The Data Room itself is never linked — only the request reaches the founder.
  assert.doesNotMatch(m.text, /investor-room/);
});

test('multipart/form-data bodies (what the page sends) are parsed from the raw buffer', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(MEETING)) fd.append(k, v);
  const r = new Response(fd);
  const raw = Buffer.from(await r.arrayBuffer());
  const res = await post(raw, { headers: { origin: TEST_ORIGIN, 'content-type': r.headers.get('content-type') } });
  assert.equal(res.statusCode, 200, res.text);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].text, /Full name: {12}Wei Lin\n/);
});

test('honeypot: a filled website_url answers {ok:true} but sends nothing', async () => {
  const res = await post({ ...MEETING, website_url: 'http://spam.example' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json_(), { ok: true });
  assert.equal(outbox.length, 0);
});

test('time gate: elapsed_ms below 3000 is rejected as too_fast', async () => {
  const res = await post({ ...MEETING, elapsed_ms: '2999' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json_(), { ok: false, error: 'too_fast' });
  assert.equal(outbox.length, 0);
});

test('validation: missing fields are listed by label with a 422', async () => {
  const res = await post({ ...MEETING, full_name: '', email: 'not-an-email', country: '', consent: 'no' });
  assert.equal(res.statusCode, 422);
  const j = res.json_();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'validation');
  assert.deepEqual(j.fields, ['Full name', 'Work email', 'Consent', 'Country / market']);
  assert.equal(outbox.length, 0);
});

test('validation: a partnership needs a partner category from the fixed list', async () => {
  const bad = await post({ ...MEETING, request_type: 'PARTNERSHIP', partner_category: 'Something else' });
  assert.equal(bad.statusCode, 422);
  assert.deepEqual(bad.json_().fields, ['Partner category']);
  const ok = await post({ ...MEETING, request_type: 'PARTNERSHIP', partner_category: 'AI and health-data platforms' });
  assert.equal(ok.statusCode, 200);
  assert.match(outbox[0].text, /Partner category: {5}AI and health-data platforms\n/);
});

test('unknown request_type is rejected before anything else is looked at', async () => {
  const res = await post({ ...MEETING, request_type: 'OTHER' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json_(), { ok: false, error: 'invalid_type' });
});

test('header injection: newlines in single-line fields are folded, control characters dropped', async () => {
  await post({ ...MEETING, full_name: 'Wei\r\nBcc: x@y.z', organization: 'Ex\u0000ample' });
  assert.match(outbox[0].subject, /— Example — Wei Bcc: x@y\.z$/);
  assert.match(outbox[0].text, /Full name: {12}Wei Bcc: x@y\.z\n/);
});

test('an unknown Origin is refused; a same-host or allow-listed one is accepted', async () => {
  const bad = await post(MEETING, { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.statusCode, 403);
  assert.deepEqual(bad.json_(), { ok: false, error: 'origin_not_allowed' });
  const preview = await post(MEETING, { headers: { origin: 'https://site-git-branch.vercel.app', host: 'site-git-branch.vercel.app' } });
  assert.equal(preview.statusCode, 200);
});

test('rate limit: the seventh sent request from one IP within an hour gets a 429', async () => {
  const ip = '203.0.113.77';
  for (let i = 0; i < 6; i++) assert.equal((await post(MEETING, { ip })).statusCode, 200);
  const res = await post(MEETING, { ip });
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json_(), { ok: false, error: 'rate_limited' });
  assert.equal(res.getHeader('retry-after'), '3600');
  assert.equal(outbox.length, 6);
});

test('mail failure surfaces as 502 mail_failed so the page offers its email fallback', async () => {
  _setMailerForTests(async () => ({ sent: false, reason: 'send-error' }));
  const res = await post(MEETING);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json_(), { ok: false, error: 'mail_failed' });
});

test('only POST is accepted', async () => {
  const req = mockReq({ method: 'GET', headers: { origin: TEST_ORIGIN } });
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.json_(), { ok: false, error: 'method_not_allowed' });
});
