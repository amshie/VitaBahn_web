// POST /api/access-request — the Investor Access gateway intake.
//
// Security posture (per brief):
//   • Server generates the request ID; the client-supplied one is ignored.
//   • Every field is re-validated server-side; free-mail addresses are rejected.
//   • The request is stored (status = pending) and an audit event is logged.
//   • An internal notification (with the internal routing hint) goes to the team;
//     the applicant gets ONLY the neutral confirmation.
//   • NOTHING is granted: no password, no NDA, no data-room link, no auto access.
//   • Booking is gated. The Lead/Anchor meeting option is never auto-bookable — it
//     requires founder review first.

import crypto from 'node:crypto';
import { sendJson, readJsonBody, clientIp, userAgent, allowedOrigins } from './_lib/http.js';
import { clean, normaliseEmail, isFreemail, consented } from './_lib/validate.js';
import { ensureSchema, insertAccessRequest, logEvent } from './_lib/store.js';
import { sendMail } from './_lib/mail.js';

const LEAD_TO = process.env.LEAD_TO || 'invest@vitabahn.com';

const MEETINGS = {
  intro20: { label: 'Introductory investor meeting — 20 minutes', env: 'BOOKING_INTRO20', gated: false },
  qualified40: { label: 'Qualified investor review — 40 minutes', env: 'BOOKING_QUALIFIED40', gated: false },
  lead60: { label: 'Lead / Anchor diligence meeting — 60 minutes', env: 'BOOKING_LEAD60', gated: true },
  strategic30: { label: 'Strategic or institutional discussion — 30 minutes', env: 'BOOKING_STRATEGIC30', gated: false },
};
const TICKETS = new Set(['participant', 'major', 'lead', 'strategic', 'undetermined']);

const NEUTRAL_CONFIRMATION =
  'Thank you. Your investor-access request has been received and is subject to verification ' +
  'and internal approval. Submission does not create a right of access, investment allocation ' +
  'or participation in the financing. If your request proceeds, we will contact you directly.';

// Per-instance fixed-window rate limit (best-effort; provision KV for cross-instance).
const RL = new Map();
function rateLimited(ip, max = 5, winSec = 600) {
  const bucket = Math.floor(Date.now() / 1000 / winSec);
  const key = `${ip}:${bucket}`;
  const n = (RL.get(key) || 0) + 1;
  RL.set(key, n);
  return n > max;
}

function makeRequestId() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 5);
  return `VB-${stamp}-${rand}`;
}

// Internal routing hint for the founder's review only — never shown to the investor.
// Ported verbatim from the prototype so routing language stays consistent.
function internalRoutingHint(ticket, role) {
  const r = String(role || '').toLowerCase();
  if (ticket === 'lead' || r.includes('lead') || r.includes('anchor'))
    return 'Lead / Anchor candidate. Hold at Interested Investor level until verification; NDA diligence and named approval required before Lead / Anchor access.';
  if (ticket === 'major')
    return 'Major-investor route. Interested Investor materials first; Qualified / NDA access may follow after verification.';
  if (ticket === 'participant')
    return 'Participant-investor route. Interested Investor materials first; deeper access depends on qualification and NDA status.';
  if (ticket === 'strategic' || r.includes('strategic'))
    return 'Strategic / institutional route. Route via strategic-partnership track; access assigned per relevance and NDA status.';
  if (ticket === 'undetermined')
    return 'Ticket undetermined. Public / first-contact materials only until qualification clarifies capacity and role.';
  return 'Adviser / introducer route. Public or interested-investor materials may be shared according to relevance.';
}

function bookingFor(meetingType) {
  const m = MEETINGS[meetingType];
  if (!m) return { eligible: false, url: null, note: '' };
  if (m.gated) {
    return {
      eligible: false,
      url: null,
      note: 'Lead / Anchor diligence meetings are arranged after founder review. We will contact you to schedule.',
    };
  }
  const url = process.env[m.env] || process.env.BOOKING_FALLBACK || null;
  return {
    eligible: true,
    url,
    note: url
      ? 'Your request is recorded. Choose a time below — the booking remains subject to confirmation.'
      : 'Your request is recorded. A scheduling link will be shared after review.',
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });

  // Reject clearly cross-site origins if present; absent Origin (privacy tools) is allowed.
  const origin = req.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) {
    return sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
  }

  await ensureSchema();
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', '600');
    return sendJson(res, 429, { ok: false, error: 'Too many requests. Please try again later.' });
  }

  const body = await readJsonBody(req);

  // Honeypot: bots fill the hidden field. Pretend success, store/transmit nothing.
  if (clean(body.companyWebsite, 200)) {
    return sendJson(res, 200, { ok: true, requestId: makeRequestId(), status: 'pending', message: NEUTRAL_CONFIRMATION, booking: { eligible: false, url: null, note: '' } });
  }

  const f = {
    fullName: clean(body.fullName, 120),
    organisation: clean(body.organisation, 160),
    role: clean(body.role, 120),
    country: clean(body.country, 80),
    linkedin: clean(body.linkedin, 300),
    investorType: clean(body.investorType, 80),
    ticketRange: clean(body.ticketRange, 40),
    roleInRound: clean(body.roleInRound, 80),
    interestArea: clean(body.interestArea, 120),
    timeline: clean(body.timeline, 60),
    meetingType: clean(body.meetingType, 40),
    message: clean(body.message, 2000),
    referral: clean(body.referral, 160),
  };
  const email = normaliseEmail(body.professionalEmail);

  const required = ['fullName', 'organisation', 'role', 'country', 'investorType', 'ticketRange', 'roleInRound', 'interestArea', 'timeline', 'meetingType', 'message'];
  const missing = required.filter((k) => !f[k]);
  const validMeeting = Object.prototype.hasOwnProperty.call(MEETINGS, f.meetingType);
  const validTicket = TICKETS.has(f.ticketRange);
  const consent = consented(body.accuracy) && consented(body.privacy);

  if (missing.length || !email || !validMeeting || !validTicket || !consent) {
    return sendJson(res, 400, { ok: false, error: 'Please complete all required fields with valid values.' });
  }
  if (isFreemail(email)) {
    return sendJson(res, 400, { ok: false, error: 'Please use a professional or institutional email address.' });
  }

  const requestId = makeRequestId();
  const hint = internalRoutingHint(f.ticketRange, f.roleInRound);

  try {
    await insertAccessRequest({
      requestId,
      fullName: f.fullName,
      email,
      organisation: f.organisation,
      role: f.role,
      country: f.country,
      linkedin: f.linkedin,
      investorType: f.investorType,
      ticketRange: f.ticketRange,
      roleInRound: f.roleInRound,
      interestArea: f.interestArea,
      timeline: f.timeline,
      meetingType: f.meetingType,
      message: f.message,
      referral: f.referral,
      internalRoutingHint: hint,
      source: 'vitabahn.com/investor-access',
      ip,
    });
  } catch (err) {
    console.error('access-request: store failed:', err && err.message);
    return sendJson(res, 500, { ok: false, error: 'The request could not be recorded. Please try again.' });
  }

  await logEvent({
    actorType: 'anon', email, event: 'request_submitted',
    detail: `${requestId} · ${f.investorType} · ticket=${f.ticketRange} · meeting=${f.meetingType}`,
    ip, userAgent: userAgent(req),
  });

  // Internal notification to the authorised team (full detail + routing hint).
  const internalText = [
    'New investor-access request — VitaBahn',
    '',
    `Request ID:   ${requestId}`,
    `Name:         ${f.fullName}`,
    `Email:        ${email}`,
    `Organisation: ${f.organisation}`,
    `Role/title:   ${f.role}`,
    `Country:      ${f.country}`,
    `LinkedIn:     ${f.linkedin}`,
    `Investor type:${f.investorType}`,
    `Ticket:       ${f.ticketRange}`,
    `Role in round:${f.roleInRound}`,
    `Interest:     ${f.interestArea}`,
    `Timeline:     ${f.timeline}`,
    `Meeting:      ${f.meetingType}`,
    `Referral:     ${f.referral || '—'}`,
    '',
    'Message:',
    f.message,
    '',
    '— INTERNAL ROUTING (do not share with the investor) —',
    hint,
    '',
    `Source IP: ${ip}`,
    'Status: pending manual review. No access, credentials or booking granted automatically.',
  ].join('\n');
  await sendMail({ to: LEAD_TO, subject: `Investor access — ${f.fullName} (${f.organisation}) [${requestId}]`, text: internalText, replyTo: { name: f.fullName.slice(0, 120), address: email } });

  // Applicant confirmation — strictly neutral. No access, no routing, no secure link.
  await sendMail({
    to: email,
    subject: 'VitaBahn — investor-access request received',
    text: `${f.fullName},\n\n${NEUTRAL_CONFIRMATION}\n\nYour reference: ${requestId}\n\n— VitaBahn`,
  });

  return sendJson(res, 200, {
    ok: true,
    requestId,
    status: 'pending',
    message: NEUTRAL_CONFIRMATION,
    booking: bookingFor(f.meetingType),
  });
}
