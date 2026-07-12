// Local dev server: runs the real serverless handlers against an in-memory PGlite
// database and serves the static site, mirroring Vercel's routing + CSP. This is
// for local development / preview only — production runs on Vercel + Neon.
//
//   node scripts/dev-server.mjs        → http://localhost:5050
//
// Seeds a founder account and sample data on boot (printed below).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5050;
const ORIGIN = `http://localhost:${PORT}`;

// Env BEFORE importing handlers (they read env at module load).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-session-secret';
process.env.ALLOWED_ORIGIN = ORIGIN;
delete process.env.POSTGRES_URL; delete process.env.DATABASE_URL; // force PGlite
delete process.env.VERCEL; process.env.NODE_ENV = 'development';

const { ensureSchema } = await import('../api/_lib/db.js');
const store = await import('../api/_lib/store.js');
const { hashPassword } = await import('../api/_lib/auth.js');

const api = {
  '/api/access-request': (await import('../api/access-request.js')).default,
  '/api/auth/investor-login': (await import('../api/auth/investor-login.js')).default,
  '/api/auth/admin-login': (await import('../api/auth/admin-login.js')).default,
  '/api/auth/logout': (await import('../api/auth/logout.js')).default,
  '/api/room/session': (await import('../api/room/session.js')).default,
  '/api/room/documents': (await import('../api/room/documents.js')).default,
  '/api/room/document': (await import('../api/room/document.js')).default,
  '/api/admin/investors': (await import('../api/admin/investors.js')).default,
  '/api/admin/requests': (await import('../api/admin/requests.js')).default,
  '/api/admin/logs': (await import('../api/admin/logs.js')).default,
  '/api/admin/documents': (await import('../api/admin/documents.js')).default,
  '/api/admin/bootstrap': (await import('../api/admin/bootstrap.js')).default,
};
const pages = {
  '/investor-room': (await import('../api/page-room.js')).default,
  '/investor-console': (await import('../api/page-console.js')).default,
};

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'";

async function seed() {
  await ensureSchema();
  if ((await store.countAdmins()) > 0) return;
  await store.createAdmin({ email: 'founder@vitabahn.com', name: 'Founder', passwordHash: hashPassword('founder-dev-pass-1') });
  const mk = async (email, name, org, level, opts = {}) => {
    const id = await store.createInvestor({ email, name, org, accessLevel: level });
    await store.updateInvestor(id, { passwordHash: hashPassword('investor-dev-pass-1'), ...opts });
    return id;
  };
  await mk('k.vogel@nordwind.vc', 'Katharina Vogel', 'Nordwind Ventures', 3, { ndaSigned: true, commitAmount: 750000, commitStatus: 'committed', instrument: 'SAFE' });
  await mk('o.alrashid@gulfhealth.cap', 'Omar Al-Rashid', 'Gulf Health Capital', 2, { commitAmount: 500000, commitStatus: 'soft' });
  await store.insertDocument({ id: 'D-one', title: 'One-Pager', minLevel: 2, tier: 1, contentType: 'application/pdf', size: 20, bytes: Buffer.from('%PDF-1.4 one-pager') });
  await store.insertDocument({ id: 'D-fin', title: 'Financial Model', minLevel: 3, tier: 2, contentType: 'application/pdf', size: 20, bytes: Buffer.from('%PDF-1.4 financial') });
  await store.insertDocument({ id: 'D-cap', title: 'Cap Table', minLevel: 4, tier: 2, contentType: 'application/pdf', size: 20, bytes: Buffer.from('%PDF-1.4 captable') });
  await store.insertAccessRequest({ requestId: 'VB-20260712-DEMO1', fullName: 'Lena Brandt', email: 'lena@brandt-fo.at', organisation: 'Brandt Family Office', ticketRange: 'participant', roleInRound: 'Participating investor', meetingType: 'intro20', internalRoutingHint: 'Participant route.' });
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  if (p === '/') p = '/index.html';
  // cleanUrls: extensionless → .html
  const tryPaths = path.extname(p) ? [p] : [`${p}.html`, p];
  (async () => {
    for (const rel of tryPaths) {
      const abs = path.join(ROOT, path.normalize(rel));
      if (!abs.startsWith(ROOT)) break; // traversal guard
      try {
        const buf = await readFile(abs);
        res.statusCode = 200;
        res.setHeader('Content-Type', CT[path.extname(abs)] || 'application/octet-stream');
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (/investor-access|investor-login|founder-login|request-submitted/.test(rel)) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        return res.end(buf);
      } catch { /* try next */ }
    }
    res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('Not found');
  })();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  req.query = Object.fromEntries(url.searchParams);
  // apply prod-like CSP to dynamic responses too
  res.setHeader('Content-Security-Policy', CSP);
  if (!req.headers.origin && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE')) req.headers.origin = ORIGIN;
  const handler = api[url.pathname] || pages[url.pathname];
  if (handler) {
    Promise.resolve(handler(req, res)).catch((e) => { console.error('handler error', url.pathname, e); if (!res.finished) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'server error' })); } });
    return;
  }
  serveStatic(req, res);
});

await seed();
server.listen(PORT, () => {
  console.log(`VitaBahn dev server → ${ORIGIN}`);
  console.log('  Founder console: /founder-login   founder@vitabahn.com / founder-dev-pass-1');
  console.log('  Investor login:  /investor-login  k.vogel@nordwind.vc / investor-dev-pass-1 (L3+NDA)');
  console.log('                                     o.alrashid@gulfhealth.cap / investor-dev-pass-1 (L2)');
});
