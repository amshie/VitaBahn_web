// VitaBahn — investor lead handler (Vercel serverless function).
//
// The static brief (hosted on Porkbun) AJAX-POSTs the "Request Investor
// Materials" form here as JSON. This function validates it, silently drops
// spam via the honeypot, and emails the lead to invest@vitabahn.com.
//
// No secrets live in this file. Everything sensitive (SMTP credentials,
// recipient, allowed origin) comes from environment variables you set in the
// Vercel dashboard — see ../.env.example and ../README.md.

import nodemailer from 'nodemailer';

const {
  SMTP_HOST = 'smtp.porkbun.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  LEAD_TO = 'invest@vitabahn.com',
  LEAD_FROM, // defaults to SMTP_USER below
  ALLOWED_ORIGIN = 'https://vitabahn.com,https://www.vitabahn.com',
} = process.env;

// Accepted fields and their max lengths (keeps payloads sane + injection-free).
const LIMITS = { fn: 100, ln: 100, em: 200, org: 200, tk: 60, msg: 5000 };
const REQUIRED = ['fn', 'ln', 'em', 'org'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Collapse whitespace (incl. newlines), trim, cap length. Newline-stripping
// here also neutralises e-mail header injection through any field.
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function resolveOrigin(req) {
  const allow = ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allow.includes(origin)) return origin;
  return allow[0] || 'https://vitabahn.com'; // fail closed if ALLOWED_ORIGIN is blank
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', resolveOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Vercel parses JSON bodies automatically; stay defensive if it arrives raw.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // Honeypot: real users never fill this. Pretend success so bots learn nothing.
  if (clean(body['bot-field'], 200)) return res.status(200).json({ ok: true });

  // Collect + validate (mirrors the client-side checks in app.js).
  const data = {};
  for (const k of Object.keys(LIMITS)) data[k] = clean(body[k], LIMITS[k]);
  const consent =
    body.cs === true || body.cs === 'on' || body.cs === 'true' || body.cs === '1';

  const missing = REQUIRED.filter((k) => !data[k]);
  if (missing.length || !EMAIL_RE.test(data.em) || !consent) {
    return res.status(400).json({ ok: false, error: 'Invalid submission' });
  }

  const from = LEAD_FROM || SMTP_USER;
  if (!SMTP_USER || !SMTP_PASS || !from) {
    console.error('Mail not configured: set SMTP_USER, SMTP_PASS (and optionally LEAD_FROM).');
    return res.status(500).json({ ok: false, error: 'Server email not configured' });
  }

  const text = [
    'New investor request — VitaBahn HADP',
    '',
    `Name:        ${data.fn} ${data.ln}`,
    `Email:       ${data.em}`,
    `Fund / org:  ${data.org}`,
    `Ticket:      ${data.tk || '—'}`,
    '',
    'Message:',
    data.msg || '—',
    '',
    'Consent: yes (agreed to be contacted; submission does not guarantee access).',
  ].join('\n');

  const port = Number(SMTP_PORT);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,        // 465 = implicit TLS
    requireTLS: port === 587,    // 587 = require STARTTLS upgrade
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,    // don't let a stalled SMTP server hang the function
    greetingTimeout: 10000,
  });

  try {
    await transporter.sendMail({
      from: `VitaBahn site <${from}>`,
      to: LEAD_TO,
      replyTo: `${data.fn} ${data.ln} <${data.em}>`,
      subject: `Investor request — ${data.fn} ${data.ln} (${data.org})`,
      text,
    });
  } catch (err) {
    console.error('sendMail failed:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Could not send' });
  }

  return res.status(200).json({ ok: true });
}
