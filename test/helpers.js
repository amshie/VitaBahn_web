// Test harness: hermetic PGlite DB + mock Vercel-style req/res so handlers run
// in-process with no server and no external services.

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-deterministic';
process.env.ALLOWED_ORIGIN = 'https://vitabahn.com,https://test.local';
// Ensure no Postgres connection string is set, so db.js selects PGlite in-memory.
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.PGLITE_DATA_DIR;

const ALLOWED = 'https://test.local';

// A mock IncomingMessage. `body` is pre-parsed (as Vercel provides it); cookies is
// a { name: value } map that becomes the Cookie header.
export function mockReq({ method = 'GET', headers = {}, body, cookies = {}, query = {}, ip = '203.0.113.9' } = {}) {
  const h = { 'user-agent': 'test-agent', ...headers };
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookieStr) h.cookie = h.cookie ? `${h.cookie}; ${cookieStr}` : cookieStr;
  if (ip && !h['x-real-ip']) h['x-real-ip'] = ip;
  const qs = new URLSearchParams(query).toString();
  return {
    method,
    headers: h,
    body,
    query, // Vercel provides parsed query params
    url: '/api/test' + (qs ? `?${qs}` : ''),
    socket: { remoteAddress: ip },
    on() {}, // body already provided; stream path unused
  };
}

// A mock ServerResponse capturing status, headers, and body.
export function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    _chunks: [],
    finished: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
    end(c) { if (c != null) this._chunks.push(c); this.finished = true; return this; },
    // Express-style sugar, in case any handler uses it.
    status(c) { this.statusCode = c; return this; },
    json(o) { this.setHeader('content-type', 'application/json'); return this.end(JSON.stringify(o)); },
    // helpers for assertions:
    get text() { return this._chunks.map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c))).join(''); },
    get buffer() { return Buffer.concat(this._chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))); },
    json_() { try { return JSON.parse(this.text); } catch { return null; } },
    setCookie() { return this.getHeader('set-cookie') || ''; },
  };
}

// Extract a cookie NAME=VALUE (without attributes) from a response's Set-Cookie,
// so a follow-up request can carry the session the browser would have stored.
export function cookieFromRes(res, name) {
  const sc = res.getHeader('set-cookie');
  if (!sc) return null;
  const list = Array.isArray(sc) ? sc : [sc];
  for (const line of list) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(line);
    if (m) return m[1];
  }
  return null;
}

export const TEST_ORIGIN = ALLOWED;
