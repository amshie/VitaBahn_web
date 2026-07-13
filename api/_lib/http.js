// Small HTTP helpers shared by the serverless functions. Node request/response
// shape (Vercel Node runtime). No framework.

// True client IP. On Vercel the leftmost x-forwarded-for is client-forgeable, so
// prefer x-real-ip (set to the real peer), then the LAST x-forwarded-for hop
// (appended by the trusted proxy), then the socket address. Mirrors api/lead.js.
export function clientIp(req) {
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

export function userAgent(req) {
  return String((req.headers && req.headers['user-agent']) || '').slice(0, 400);
}

export function parseCookies(req) {
  const raw = (req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) {
        try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
      }
    }
  }
  return out;
}

export function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}

export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Gated pages must never be cached by shared caches, and never indexed.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(html);
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

const MAX_BODY = 16 * 1024;

// Read + JSON-parse the request body. Vercel usually pre-parses req.body; fall
// back to reading the stream (capped) if it arrives raw.
export async function readJsonBody(req, maxBytes = MAX_BODY) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > maxBytes) return {};
      try { return JSON.parse(req.body || '{}'); } catch { return {}; }
    }
    if (typeof req.body === 'object') return req.body;
  }
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { try { req.destroy(); } catch {} resolve({}); }
      else data += c;
    });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Read a raw request body (e.g. a document upload) into a Buffer, capped. Handles
// pre-parsed bodies (Buffer/string) and the raw stream. Returns null if over cap.
export async function readRawBody(req, maxBytes = 8 * 1024 * 1024) {
  if (req.body != null) {
    if (Buffer.isBuffer(req.body)) return req.body.length > maxBytes ? null : req.body;
    if (typeof req.body === 'string') return Buffer.byteLength(req.body) > maxBytes ? null : Buffer.from(req.body);
    if (typeof req.body === 'object') { const b = Buffer.from(JSON.stringify(req.body)); return b.length > maxBytes ? null : b; }
  }
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { try { req.destroy(); } catch {} resolve(null); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export function allowedOrigins() {
  return (process.env.ALLOWED_ORIGIN || 'https://vitabahn.com,https://www.vitabahn.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

// CSRF guard for state-changing requests. Accept only when the Origin (or, if the
// browser omitted it, the Referer host) is in the allowlist. Cookies are already
// SameSite=Lax; this is defence-in-depth against cross-site POSTs.
export function requireOrigin(req) {
  const allow = allowedOrigins();
  const origin = req.headers && req.headers.origin;
  if (origin) return allow.includes(origin);
  const ref = (req.headers && req.headers.referer) || '';
  if (!ref) return false;
  try {
    const host = new URL(ref).host;
    return allow.some((a) => { try { return new URL(a).host === host; } catch { return false; } });
  } catch { return false; }
}
