// Transactional mail via nodemailer + SMTP (same Porkbun setup as api/lead.js).
// When SMTP is not configured (local/tests) sendMail no-ops with a logged warning
// instead of throwing, so the request path stays exercised without real delivery.

import nodemailer from 'nodemailer';

const {
  SMTP_HOST = 'smtp.porkbun.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  LEAD_FROM,
} = process.env;

export function mailConfigured() {
  return Boolean(SMTP_USER && SMTP_PASS && (LEAD_FROM || SMTP_USER));
}

let _transporter = null;
function transporter() {
  if (_transporter) return _transporter;
  const port = Number(SMTP_PORT);
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // implicit TLS
    requireTLS: port === 587, // require STARTTLS upgrade
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
  return _transporter;
}

// Compose + send the set-password invitation. Returns sendMail's result so the
// caller can tell the founder whether it actually went out.
export async function sendInviteEmail({ to, name, url, expiresDays = 7 }) {
  const text = [
    `${name || 'Hello'},`,
    '',
    'You have been approved for access to the VitaBahn investor Data Room.',
    'Set your password using the secure link below, then sign in:',
    '',
    url,
    '',
    `This link can be used once and expires in ${expiresDays} days. If it expires, contact us for a new one.`,
    'If you did not expect this email, you can ignore it.',
    '',
    '— VitaBahn',
  ].join('\n');
  return sendMail({ to, subject: 'VitaBahn — set your investor Data Room password', text });
}

export async function sendMail({ to, subject, text, replyTo }) {
  if (!mailConfigured()) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`mail: SMTP not configured — not sending "${subject}" to ${to}`);
    }
    return { sent: false, reason: 'not-configured' };
  }
  const from = LEAD_FROM || SMTP_USER;
  try {
    await transporter().sendMail({ from: `VitaBahn <${from}>`, to, subject, text, replyTo });
    return { sent: true };
  } catch (err) {
    console.error('mail: sendMail failed:', err && err.message);
    return { sent: false, reason: 'send-error' };
  }
}
