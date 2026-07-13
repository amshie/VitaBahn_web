// Transactional mail via nodemailer + SMTP (same Porkbun setup as api/lead.js).
// When SMTP is not configured (local/tests) sendMail no-ops with a logged warning
// instead of throwing, so the request path stays exercised without real delivery.

import nodemailer from 'nodemailer';
import { INVITE_TTL_SEC } from './store.js';

const {
  SMTP_HOST = 'smtp.porkbun.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  LEAD_FROM,
} = process.env;

// Address shown to investors for "was this you?" queries. Defaults to the IR inbox;
// override with IR_CONTACT if you use a different mailbox (e.g. invest@vitabahn.com).
const IR_CONTACT = process.env.IR_CONTACT || 'investors@vitabahn.com';

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

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Human, always-truthful expiry text derived from the real invite TTL, so the email
// can never claim a lifetime the token does not actually have.
function humanDuration(sec) {
  sec = Number(sec) || 0;
  if (sec < 3600) { const m = Math.max(1, Math.round(sec / 60)); return `${m} minute${m === 1 ? '' : 's'}`; }
  if (sec < 86400) { const h = Math.round(sec / 3600); return `${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.round(sec / 86400); return `${d} day${d === 1 ? '' : 's'}`;
}

// Build the set-password / reset email: subject + plain-text + a deployable HTML
// part. Pure (no I/O), so it can be unit-tested. Personalises the greeting from the
// investor name and states the real link lifetime.
export function buildInviteEmail({ name, url, reset = false }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const greeting = first ? `Dear ${first},` : 'Hello,';
  const expiry = humanDuration(INVITE_TTL_SEC);
  const safeUrl = esc(url);
  const safeGreeting = esc(greeting);

  const subject = reset
    ? 'Reset your VitaBahn Data Room password'
    : 'Set your password to activate your VitaBahn Data Room access';

  const intro = reset
    ? 'A password reset was requested for your VitaBahn investor Data Room account. To choose a new password, use the secure button below, then sign in.'
    : 'Your request for access to the VitaBahn investor Data Room has been reviewed and approved. To activate your account, set a password using the secure button below, then sign in.';

  const notExpectingText = reset
    ? `If you didn't request this, you can safely ignore this email — your password is unchanged — or contact us at ${IR_CONTACT}.`
    : `If you weren't expecting this email, please contact us at ${IR_CONTACT} and do not use the link above.`;
  const notExpectingHtml = reset
    ? `If you didn&#39;t request this, you can safely ignore this email — your password is unchanged — or contact us at <a href="mailto:${esc(IR_CONTACT)}" style="color:#0D4D47;">${esc(IR_CONTACT)}</a>.`
    : `If you weren&#39;t expecting this email, please contact us at <a href="mailto:${esc(IR_CONTACT)}" style="color:#0D4D47;">${esc(IR_CONTACT)}</a> and do not use the link above.`;

  const text = [
    greeting,
    '',
    intro,
    '',
    'Set password & sign in:',
    url,
    '',
    'For your security',
    `• This link can be used once and expires in ${expiry}.`,
    "• Please don't forward it — it grants access to your account.",
    '• If it expires, request a new one from the sign-in page.',
    '',
    'Access is limited to the materials assigned to your review stage. All documents are confidential, watermarked and view-only, and access may be updated or withdrawn as the process progresses.',
    '',
    notExpectingText,
    '',
    'Kind regards,',
    'VitaBahn Investor Relations',
  ].join('\n');

  // Bulletproof, table-based HTML with inline styles (email-client safe). No external
  // assets, no web fonts — renders consistently and does not trip spam/phishing heuristics.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f5f3;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Set your password to activate your VitaBahn investor Data Room access. Link expires in ${expiry}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f3;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e4e2;">
  <tr><td style="font-size:0;line-height:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="40%" style="background:#0D4D47;height:4px;line-height:4px;font-size:0;">&nbsp;</td>
    <td width="30%" style="background:#6D948C;height:4px;line-height:4px;font-size:0;">&nbsp;</td>
    <td width="30%" style="background:#C8A86E;height:4px;line-height:4px;font-size:0;">&nbsp;</td>
  </tr></table></td></tr>
  <tr><td style="padding:26px 32px 4px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-size:19px;font-weight:700;color:#0D4D47;letter-spacing:.2px;">VitaBahn</div>
    <div style="font-size:12px;color:#6b7a76;margin-top:2px;">Investor Data Room</div>
  </td></tr>
  <tr><td style="padding:16px 32px 4px;font-family:Arial,Helvetica,sans-serif;color:#243b36;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 14px;">${safeGreeting}</p>
    <p style="margin:0 0 20px;">${esc(intro)}</p>
  </td></tr>
  <tr><td align="center" style="padding:2px 32px 6px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:#0D4D47;">
      <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">Set password &amp; sign in →</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:8px 32px 2px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7a76;line-height:1.5;">
    <p style="margin:0 0 4px;">Or paste this link into your browser:</p>
    <p style="margin:0;word-break:break-all;"><a href="${safeUrl}" style="color:#0D4D47;">${safeUrl}</a></p>
  </td></tr>
  <tr><td style="padding:18px 32px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ee;border:1px solid #ece6d8;border-radius:10px;"><tr>
      <td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b5030;line-height:1.7;">
        <div style="font-weight:700;color:#6E5423;margin-bottom:4px;">For your security</div>
        • This link can be used once and expires in <b>${expiry}</b>.<br>
        • Please don&#39;t forward it — it grants access to your account.<br>
        • If it expires, request a new one from the sign-in page.
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 32px 4px;font-family:Arial,Helvetica,sans-serif;color:#4a5c57;font-size:13px;line-height:1.6;">
    Access is limited to the materials assigned to your review stage. All documents are confidential, watermarked and view-only, and access may be updated or withdrawn as the process progresses.
  </td></tr>
  <tr><td style="padding:8px 32px 16px;font-family:Arial,Helvetica,sans-serif;color:#6b7a76;font-size:12.5px;line-height:1.6;">
    ${notExpectingHtml}
  </td></tr>
  <tr><td style="padding:0 32px 22px;font-family:Arial,Helvetica,sans-serif;color:#243b36;font-size:14px;line-height:1.6;">
    Kind regards,<br><b>VitaBahn Investor Relations</b>
  </td></tr>
  <tr><td style="padding:16px 32px;background:#0B1013;font-family:Arial,Helvetica,sans-serif;color:#9fb0ab;font-size:11px;line-height:1.5;">
    Confidential — intended only for the named recipient. Access is logged and may be withdrawn. © VitaBahn.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

// Compose + send the set-password / reset invitation. Returns sendMail's result so
// the caller can tell whether it actually went out.
export async function sendInviteEmail({ to, name, url, reset = false }) {
  const { subject, text, html } = buildInviteEmail({ name, url, reset });
  return sendMail({ to, subject, text, html, replyTo: IR_CONTACT, fromName: 'VitaBahn Investor Relations' });
}

export async function sendMail({ to, subject, text, html, replyTo, fromName }) {
  if (!mailConfigured()) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`mail: SMTP not configured — not sending "${subject}" to ${to}`);
    }
    return { sent: false, reason: 'not-configured' };
  }
  const from = LEAD_FROM || SMTP_USER;
  try {
    await transporter().sendMail({ from: `${fromName || 'VitaBahn'} <${from}>`, to, subject, text, html, replyTo });
    return { sent: true };
  } catch (err) {
    console.error('mail: sendMail failed:', err && err.message);
    return { sent: false, reason: 'send-error' };
  }
}
