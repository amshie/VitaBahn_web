// Shared input validation. Server-side is the security boundary — client checks in
// the pages are UX only and are always re-validated here.

// Collapse whitespace (incl. newlines → neutralises header injection), trim, cap.
export const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Strict address grammar: no whitespace and none of the characters used for
// header/address-parser abuse. Mirrors api/lead.js.
const EMAIL_RE = /^[^\s@<>"',;:()[\]/\\]+@[^\s@<>"',;:()[\]/\\]+\.[^\s@<>"',;:()[\]/\\]+$/;

export function normaliseEmail(raw, max = 200) {
  const e = clean(raw, max).toLowerCase();
  if (!e || e.length > max || !EMAIL_RE.test(e)) return null;
  return e;
}

const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'proton.me', 'protonmail.com', 'live.com', 'msn.com', 'gmx.de', 'web.de',
]);

export function isFreemail(email) {
  const d = (String(email).split('@')[1] || '').toLowerCase();
  return FREEMAIL.has(d);
}

// Truthy consent from a checkbox (boolean or common string encodings).
export function consented(v) {
  return v === true || v === 'on' || v === 'true' || v === '1';
}
