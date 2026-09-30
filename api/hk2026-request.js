// POST /api/hk2026-request — the four request forms on /hk2026 (Data Room, Pilot,
// Partnership, Meeting). A 1:1 port of the PHP handler that shipped with the
// landing page (api/hk2026-request.php in the deploy package): same fields, same
// server-side validation, same honeypot ("website_url"), same time gate
// (elapsed_ms < 3000 → bot), same per-IP rate limit and the same JSON contract
// ({ok:true} / {ok:false,error,fields}) so assets/hk2026/hk2026.js needs no change
// beyond CONFIG.endpoint.
//
// Delivery goes through the site's existing SMTP setup (api/_lib/mail.js). The
// From: address is the authenticated mailbox (Porkbun rejects anything else), so
// SPF/DKIM pass; the recipient is HK2026_TO. Nothing is stored server-side.

import { sendJson, readRawBody, clientIp, allowedOrigins } from './_lib/http.js';
import { normaliseEmail } from './_lib/validate.js';
import { sendMail } from './_lib/mail.js';

const RECIPIENT = process.env.HK2026_TO || 'drmotazshieban@vitabahn.com';
const MIN_FILL_MS = 3000;   // faster submissions are treated as bots
const RATE_LIMIT = 6;       // max sent requests per IP per hour
const RATE_WINDOW_MS = 3600 * 1000;
const MAX_BODY = 64 * 1024; // the largest legitimate form is ~4 KB

const TYPES = ['DATAROOM', 'PILOT', 'PARTNERSHIP', 'MEETING', 'INVESTOR_MEETING'];
const LABELS = {
  DATAROOM: 'Data room request', PILOT: 'Pilot discussion', PARTNERSHIP: 'Partnership discussion',
  MEETING: 'Meeting request', INVESTOR_MEETING: 'Investor meeting request',
};
const INVESTOR_TYPES = ['VC', 'CVC', 'Family Office', 'Strategic', 'Other'];
const INTERESTS = ['Pilot', 'Technical Integration', 'Clinical Collaboration', 'APAC Market Partnership', 'Investment', 'Other'];
const PARTNER_CATEGORIES = [
  'Diagnostics and biomarker companies', 'Omics and laboratory platforms',
  'Medical devices and functional measurement technologies', 'AI and health-data platforms',
  'Regenerative medicine and longevity-intervention companies', 'Clinics, medical centres and health systems',
  'APAC market-entry and institutional partners',
];

// Per-instance sliding window of successful sends per IP (best-effort on
// serverless, like api/access-request.js). Only SENT requests count, as in the
// PHP original, so a visitor fixing a validation error is never locked out.
const HITS = new Map();
function recentHits(ip) {
  const now = Date.now();
  const list = (HITS.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);
  HITS.set(ip, list);
  return list;
}

// Mirrors the PHP field(): strip control characters, cap length, and for
// single-line fields fold newlines away (neutralises header injection).
function field(fields, name, max, singleLine = true) {
  let v = String(fields[name] == null ? '' : fields[name]).trim();
  v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (singleLine) v = v.replace(/[\r\n]+/g, ' ');
  return Array.from(v).slice(0, max).join('');
}
const oneOf = (value, allowed) => (allowed.includes(value) ? value : '');

// The forms POST multipart/form-data (FormData). Vercel pre-parses JSON and
// urlencoded bodies into req.body but leaves multipart as a Buffer, so parse it
// with the platform FormData parser. Returns a flat { name: string } map, or
// null when the body exceeds MAX_BODY.
async function readFormFields(req) {
  const ct = String(req.headers['content-type'] || '');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRawBody(req, MAX_BODY);
  if (!raw) return null;
  if (/application\/json/i.test(ct)) { try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return {}; } }
  try {
    const fd = await new Response(raw, { headers: { 'content-type': ct } }).formData();
    const out = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// Same-site check as the PHP original: an Origin that matches the request host
// (production, preview deployments, local dev) or the allowlist is accepted; a
// missing Origin (privacy tools) is allowed, anything else is rejected.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }
  const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (host && host.toLowerCase() === reqHost.toLowerCase()) return true;
  return allowedOrigins().includes(origin);
}

let deliver = sendMail;
// Test seam: swap the mailer so the suite can assert on the composed message.
export function _setMailerForTests(fn) { deliver = fn || sendMail; }

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });

  const fields = await readFormFields(req);
  if (!fields) return sendJson(res, 413, { ok: false, error: 'payload_too_large' });

  // ---------- spam protection ----------
  if (field(fields, 'website_url', 200) !== '') return sendJson(res, 200, { ok: true }); // honeypot: pretend success
  if ((parseInt(fields.elapsed_ms, 10) || 0) < MIN_FILL_MS) return sendJson(res, 400, { ok: false, error: 'too_fast' });

  const ip = clientIp(req);
  const hits = recentHits(ip);
  if (hits.length >= RATE_LIMIT) {
    res.setHeader('Retry-After', '3600');
    return sendJson(res, 429, { ok: false, error: 'rate_limited' });
  }

  // ---------- validation ----------
  const type = oneOf(field(fields, 'request_type', 20), TYPES);
  if (!type) return sendJson(res, 400, { ok: false, error: 'invalid_type' });

  const data = {
    'Full name': field(fields, 'full_name', 120),
    'Work email': field(fields, 'email', 160),
    'Organization': field(fields, 'organization', 160),
    'Role': field(fields, 'role', 120),
  };
  const missing = Object.keys(data).filter((label) => data[label] === '');
  const email = normaliseEmail(data['Work email'], 160);
  if (data['Work email'] !== '' && !email) missing.push('Work email');
  if (fields.consent !== 'yes') missing.push('Consent');

  if (type === 'DATAROOM') {
    let website = field(fields, 'website', 300);
    if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
    data['Website / LinkedIn'] = website;
    data['Investor type'] = oneOf(field(fields, 'investor_type', 40), INVESTOR_TYPES);
    data['Stage / mandate fit'] = field(fields, 'mandate', 200);
    data['Message'] = field(fields, 'message', 2000, false);
  } else {
    data['Country / market'] = field(fields, 'country', 120);
    data['Interest'] = oneOf(field(fields, 'interest', 60), INTERESTS);
    data['Objective'] = field(fields, 'objective', 500, false);
    data['Preferred timing'] = field(fields, 'timing', 200);
    if (data['Country / market'] === '') missing.push('Country / market');
    if (data['Objective'] === '') missing.push('Objective');
    if (type === 'PARTNERSHIP') {
      data['Partner category'] = oneOf(field(fields, 'partner_category', 120), PARTNER_CATEGORIES);
      if (data['Partner category'] === '') missing.push('Partner category');
    }
  }

  if (missing.length) return sendJson(res, 422, { ok: false, error: 'validation', fields: [...new Set(missing)] });

  const src = field(fields, 'src', 40).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'direct';

  // ---------- send ----------
  const subject = `[HK2026] ${LABELS[type]} — ${data['Organization']} — ${data['Full name']}`;
  const lines = [`${LABELS[type]} via www.vitabahn.com/hk2026`, '-'.repeat(48)];
  for (const [label, value] of Object.entries(data)) {
    if (value !== '') lines.push(`${label}:`.padEnd(22) + value);
  }
  lines.push('-'.repeat(48));
  lines.push('Source:               ' + src);
  lines.push('Received (UTC):       ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  if (type === 'DATAROOM') {
    lines.push('', 'Reminder: review before granting any diligence access. Do not forward the Data Room link automatically.');
  }

  const result = await deliver({
    to: RECIPIENT,
    subject,
    text: lines.join('\n') + '\n',
    replyTo: { name: data['Full name'], address: email },
    fromName: 'VitaBahn HK2026',
  });
  if (!result || !result.sent) return sendJson(res, 502, { ok: false, error: 'mail_failed' });

  hits.push(Date.now());
  return sendJson(res, 200, { ok: true });
}
