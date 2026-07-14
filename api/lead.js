// VitaBahn — investor lead handler (Vercel serverless function).
//
// The static brief AJAX-POSTs the "Request Investor Materials" form here as JSON.
// This function rate-limits by client IP, requires a self-hosted proof-of-work
// token (a bot control that a plain curl loop cannot trivially pass), silently
// drops honeypot spam, validates + normalises the input, and emails the lead to
// info@vitabahn.com.
//
// No secrets live in this file. Everything sensitive (SMTP credentials,
// recipient, allowed origin, the rate-limit store keys and the proof-of-work
// secret) comes from environment variables you set in the Vercel dashboard —
// see ../.env.example and ../README.md.

import nodemailer from 'nodemailer';
import crypto from 'node:crypto';

const {
  SMTP_HOST = 'smtp.porkbun.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  LEAD_TO = 'info@vitabahn.com',
  LEAD_FROM, // defaults to SMTP_USER below
  ALLOWED_ORIGIN = 'https://vitabahn.com,https://www.vitabahn.com',

  // --- Durable rate-limit + PoW-replay store (optional but recommended) ---
  // Vercel KV and Upstash Redis both expose a REST URL + token; either pair works.
  // When unset, the function falls back to a per-instance in-memory store (see note
  // in resolveStore()). Provision one before production — see README.
  KV_REST_API_URL,
  KV_REST_API_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,

  // --- Proof-of-work bot control ---
  POW_SECRET,          // HMAC secret that signs challenges; MUST be set in production
  POW_BITS = '16',     // difficulty in leading zero bits (~65k hashes at 16)

  // --- Rate-limit tunables ---
  RATE_MAX = '5',        // max requests …
  RATE_WINDOW_SEC = '60', // … per IP per this many seconds
} = process.env;

// Accepted fields and their max lengths (keeps payloads sane + injection-free).
const LIMITS = { fn: 100, ln: 100, em: 200, org: 200, tk: 60, msg: 5000 };
const REQUIRED = ['fn', 'ln', 'em', 'org'];
const MAX_BODY_BYTES = 16 * 1024; // hard cap on the request body (defence-in-depth)

// Strict address grammar: no whitespace, and none of the characters an attacker
// would use for header/address-parser abuse (<>"',;:()[]/\). This is the
// defence-in-depth guard for the nodemailer address-parser DoS class, on top of
// the library upgrade — a crafted address never reaches nodemailer as From/Reply-To.
const EMAIL_RE = /^[^\s@<>"',;:()[\]/\\]+@[^\s@<>"',;:()[\]/\\]+\.[^\s@<>"',;:()[\]/\\]+$/;

// Collapse whitespace (incl. newlines), trim, cap length. Newline-stripping here
// also neutralises e-mail header injection through any field.
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function normaliseEmail(raw) {
  const e = clean(raw, LIMITS.em).toLowerCase();
  if (!e || e.length > LIMITS.em || !EMAIL_RE.test(e)) return null;
  return e;
}

// ---------------------------------------------------------------------------
// Store: Vercel KV / Upstash Redis over REST, with an in-memory fallback.
//
// The in-memory fallback keeps the limiter and PoW-replay check FUNCTIONAL for
// local dev and low-traffic single-instance use, but it is per-instance: on
// Vercel each concurrent/cold instance has its own Map, so a determined attacker
// spread across instances is only partially throttled. Provision a durable store
// (env vars above) for real cross-instance enforcement.
// ---------------------------------------------------------------------------
const REDIS_URL = (KV_REST_API_URL || UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = KV_REST_API_TOKEN || UPSTASH_REDIS_REST_TOKEN || '';
const STORE_READY = Boolean(REDIS_URL && REDIS_TOKEN);

const mem = new Map(); // key -> { v, exp(ms epoch, 0 = no expiry) }
function memGet(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; }
  return e.v;
}
function memSet(k, v, ttlSec) { mem.set(k, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 }); }

async function redis(cmd) {
  // Upstash/Vercel-KV path-style REST: GET {url}/CMD/arg1/arg2 with a Bearer token.
  const path = cmd.map((c) => encodeURIComponent(String(c))).join('/');
  const r = await fetch(`${REDIS_URL}/${path}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  if (!r.ok) throw new Error(`store ${r.status}`);
  const j = await r.json();
  return j.result;
}

// One-time posture warnings so misconfiguration is visible in the function logs.
if (!STORE_READY) {
  console.warn('lead: no durable store configured (KV/Upstash env vars unset) — using per-instance in-memory rate limiting. Provision a store before production.');
}
let powSecret = POW_SECRET;
if (!powSecret) {
  powSecret = crypto.randomBytes(32).toString('hex'); // ephemeral, per-instance
  console.warn('lead: POW_SECRET is unset — using an ephemeral per-instance secret. Challenges will not validate across instances/restarts. Set POW_SECRET in production.');
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window per IP).
// ---------------------------------------------------------------------------
// Derive the client IP from a source the platform vouches for. On Vercel the
// client-supplied (leftmost) x-forwarded-for value is forgeable — an attacker
// could rotate it to get a fresh bucket every request and bypass the limit — so
// we key on x-real-ip, which Vercel sets to the true connecting IP and overwrites
// on every request. Fallbacks: if x-real-ip is absent, use the LAST (rightmost)
// x-forwarded-for entry, i.e. the hop appended by the trusted proxy rather than
// the client-controlled first entry; then the socket address for local/dev.
function clientIp(req) {
  const h = req.headers || {};
  const real = h['x-real-ip'];
  if (real) return String(real).split(',')[0].trim();
  const xff = h['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// In-memory fixed-window limiter. Used when there is no durable store AND as the
// degraded fallback when the store errors — a store hiccup must never remove the
// limit entirely (fail-open); it degrades to per-instance throttling instead.
function memRateLimit(key, max, win) {
  const count = (Number(memGet(key)) || 0) + 1;
  memSet(key, count, win);
  return { ok: count <= max, retryAfter: win };
}

async function rateLimit(ip) {
  const max = Number(RATE_MAX) || 5;
  const win = Number(RATE_WINDOW_SEC) || 60;
  const bucket = Math.floor(Date.now() / 1000 / win);
  const key = `rl:${ip}:${bucket}`;
  if (STORE_READY) {
    try {
      const count = Number(await redis(['INCR', key]));
      if (count === 1) await redis(['EXPIRE', key, String(win)]);
      return { ok: count <= max, retryAfter: win };
    } catch (err) {
      console.error('rate-limit store error — degrading to in-memory per-instance limiter:', err && err.message);
      return memRateLimit(key, max, win);
    }
  }
  return memRateLimit(key, max, win);
}

// ---------------------------------------------------------------------------
// Proof of work: stateless, HMAC-signed challenge; client must find a solution
// whose sha256("nonce.solution") has >= difficulty leading zero bits. Single-use
// (replay-protected via the store). Fully self-hosted — no third-party calls.
// ---------------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const powSig = (payload) => b64url(crypto.createHmac('sha256', powSecret).update(payload).digest());
const clampBits = (b) => Math.max(8, Math.min(24, Number(b) || 16));
const POW_TTL_SEC = 120;

function issueChallenge() {
  const nonce = crypto.randomBytes(12).toString('hex');
  const exp = Date.now() + POW_TTL_SEC * 1000;
  const bits = clampBits(POW_BITS);
  const payload = `${nonce}.${exp}.${bits}`;
  return { challenge: `${payload}.${powSig(payload)}`, difficulty: bits, ttlSec: POW_TTL_SEC };
}

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    for (let m = 7; m >= 0; m--) { if ((byte >> m) & 1) return n; n++; }
    break;
  }
  return n;
}

// Mark a PoW nonce as spent. Returns true if it was fresh (now consumed), false
// if it was already used (replay). Degrades to in-memory per-instance tracking on
// a store error so a store outage can never silently re-enable replays — the
// control weakens to per-instance rather than disappearing.
async function markNonceUsed(nonce) {
  const rkey = `pow:${nonce}`;
  const ttl = POW_TTL_SEC + 60;
  if (STORE_READY) {
    try {
      const set = await redis(['SET', rkey, '1', 'NX', 'EX', String(ttl)]);
      return set === 'OK';
    } catch (err) {
      console.error('pow-replay store error — degrading to in-memory nonce tracking:', err && err.message);
      // fall through to in-memory tracking below
    }
  }
  if (memGet(rkey)) return false;
  memSet(rkey, '1', ttl);
  return true;
}

async function verifyPow(pow, solution) {
  if (typeof pow !== 'string' || typeof solution !== 'string' || !solution) return { ok: false, reason: 'missing' };
  const parts = pow.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [nonce, expStr, bitsStr, sig] = parts;
  const expect = powSig(`${nonce}.${expStr}.${bitsStr}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-sig' };
  const exp = Number(expStr);
  const bits = Number(bitsStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false, reason: 'expired' };
  if (!Number.isFinite(bits) || bits < 8 || bits > 24) return { ok: false, reason: 'bad-bits' };
  const h = crypto.createHash('sha256').update(`${nonce}.${solution}`).digest();
  if (leadingZeroBits(h) < bits) return { ok: false, reason: 'unsolved' };
  // Single-use: reject replay of an already-spent nonce (degrades, never fails open).
  if (!(await markNonceUsed(nonce))) return { ok: false, reason: 'replay' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
function resolveOrigin(req) {
  const allow = ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allow.includes(origin)) return origin;
  return allow[0] || 'https://vitabahn.com'; // fail closed if ALLOWED_ORIGIN is blank
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', resolveOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Rate limit every real request (GET challenge issuance + POST submit) by IP.
  // rateLimit() degrades to an in-memory limiter on a store error rather than
  // failing open, so throttling never disappears entirely.
  const ip = clientIp(req);
  const rl = await rateLimit(ip);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many requests. Please try again shortly.' });
  }

  // Issue a proof-of-work challenge for the form to solve before it can POST.
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ...issueChallenge() });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Body-size guard (defence-in-depth for the parser-DoS class + resource abuse).
  const declaredLen = Number(req.headers['content-length'] || 0);
  if (declaredLen && declaredLen > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'Payload too large' });
  }

  // Vercel parses JSON bodies automatically; stay defensive if it arrives raw.
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return res.status(413).json({ ok: false, error: 'Payload too large' });
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // Honeypot: real users never fill this. Pretend success so bots learn nothing.
  if (clean(body['bot-field'], 200)) return res.status(200).json({ ok: true });

  // Collect + validate (mirrors the client-side checks in app.js).
  const data = {};
  for (const k of Object.keys(LIMITS)) data[k] = clean(body[k], LIMITS[k]);
  const em = normaliseEmail(body.em);
  const consent =
    body.cs === true || body.cs === 'on' || body.cs === 'true' || body.cs === '1';

  const missing = REQUIRED.filter((k) => !data[k]);
  if (missing.length || !em || !consent) {
    return res.status(400).json({ ok: false, error: 'Invalid submission' });
  }
  data.em = em; // use the strictly-normalised address downstream

  // Proof-of-work: the real bot control. A plain scripted POST has no valid token.
  const pow = await verifyPow(body.pow, String(body.pow_sol == null ? '' : body.pow_sol));
  if (!pow.ok) {
    return res.status(403).json({ ok: false, error: 'Bot check failed' });
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
      // Pass the address as a structured field with a cleaned display name;
      // data.em has already passed the strict EMAIL_RE guard above.
      replyTo: { name: `${data.fn} ${data.ln}`.slice(0, 200), address: data.em },
      subject: `Investor request — ${data.fn} ${data.ln} (${data.org})`,
      text,
    });
  } catch (err) {
    console.error('sendMail failed:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Could not send' });
  }

  return res.status(200).json({ ok: true });
}
