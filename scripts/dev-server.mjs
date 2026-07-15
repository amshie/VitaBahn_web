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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5050;
const ORIGIN = `http://localhost:${PORT}`;

// Env BEFORE importing handlers (they read env at module load).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-session-secret';
process.env.ALLOWED_ORIGIN = ORIGIN;
delete process.env.POSTGRES_URL; delete process.env.DATABASE_URL; // force PGlite
delete process.env.VERCEL; process.env.NODE_ENV = 'development';

const { ensureSchema, query } = await import('../api/_lib/db.js');
const store = await import('../api/_lib/store.js');
const { hashPassword } = await import('../api/_lib/auth.js');

const api = {
  '/api/access-request': (await import('../api/access-request.js')).default,
  '/api/auth/investor-login': (await import('../api/auth/investor-login.js')).default,
  '/api/auth/admin-login': (await import('../api/auth/admin-login.js')).default,
  '/api/auth/logout': (await import('../api/auth/logout.js')).default,
  '/api/auth/set-password': (await import('../api/auth/set-password.js')).default,
  '/api/auth/forgot-password': (await import('../api/auth/forgot-password.js')).default,
  '/api/room/session': (await import('../api/room/session.js')).default,
  '/api/room/overview': (await import('../api/room/overview.js')).default,
  '/api/room/documents': (await import('../api/room/documents.js')).default,
  '/api/room/document': (await import('../api/room/document.js')).default,
  '/api/room/request-access': (await import('../api/room/request-access.js')).default,
  '/api/room/nda': (await import('../api/room/nda.js')).default,
  '/api/admin/investors': (await import('../api/admin/investors.js')).default,
  '/api/admin/invite': (await import('../api/admin/invite.js')).default,
  '/api/admin/admins': (await import('../api/admin/admins.js')).default,
  '/api/admin/requests': (await import('../api/admin/requests.js')).default,
  '/api/admin/logs': (await import('../api/admin/logs.js')).default,
  '/api/admin/documents': (await import('../api/admin/documents.js')).default,
  '/api/admin/nda': (await import('../api/admin/nda.js')).default,
  '/api/admin/preview-room': (await import('../api/admin/preview-room.js')).default,
  '/api/admin/bootstrap': (await import('../api/admin/bootstrap.js')).default,
};
const pages = {
  '/investor-room': (await import('../api/page-room.js')).default,
  '/investor-console': (await import('../api/page-console.js')).default,
  '/investor-console/preview': (await import('../api/page-room-preview.js')).default,
};

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'";

// Build a small but genuine PDF so the preview exercises real per-recipient
// watermarking end-to-end. Real files are uploaded via the founder console.
async function makePdf(title, note) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]); // A4
  page.drawText('VitaBahn', { x: 48, y: 782, size: 20, font: bold, color: rgb(0.15, 0.5, 0.45) });
  page.drawText('Investor Data Room — sample document', { x: 48, y: 762, size: 10, font, color: rgb(0.36, 0.41, 0.44) });
  page.drawText(title.slice(0, 60), { x: 48, y: 700, size: 22, font: bold, color: rgb(0.04, 0.06, 0.07) });
  page.drawText(note || '', { x: 48, y: 672, size: 12, font, color: rgb(0.13, 0.19, 0.22) });
  page.drawText('Placeholder content for preview only.', { x: 48, y: 644, size: 10, font, color: rgb(0.36, 0.41, 0.44) });
  return Buffer.from(await pdf.save());
}

// Section documents, mirroring the approved mockup. PDFs are watermarked on the
// way out; XLSX placeholders exercise the non-PDF, view-only path.
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SEED_DOCS = [
  { id: 'D-onepager', title: 'Executive One-Pager', minLevel: 1, ct: 'application/pdf', pages: '1 page' },
  { id: 'D-overview', title: 'Investor Overview', minLevel: 1, ct: 'application/pdf', pages: '8 pages', old: true },
  { id: 'D-deck', title: 'Investor Deck', minLevel: 2, ct: 'application/pdf', pages: '22 pages' },
  { id: 'D-market', title: 'Market & Competitive Analysis', minLevel: 2, ct: 'application/pdf', pages: '14 pages', old: true },
  { id: 'D-team', title: 'Team & Governance', minLevel: 2, ct: 'application/pdf', pages: '6 pages', old: true },
  { id: 'D-finmodel', title: 'Financial Model', minLevel: 3, ct: XLSX, pages: '6 tabs' },
  { id: 'D-captable', title: 'Capitalisation Table', minLevel: 3, ct: XLSX, pages: '2 tabs', old: true },
  { id: 'D-regulatory', title: 'Regulatory Strategy (MDR / MDSW)', minLevel: 3, ct: 'application/pdf', pages: '18 pages' },
  { id: 'D-clinical', title: 'Clinical & Scientific Dossier', minLevel: 3, ct: 'application/pdf', pages: '24 pages', old: true },
  { id: 'D-loi', title: 'Design-Partner LOI (UAE)', minLevel: 4, ct: 'application/pdf', pages: '4 pages' },
  { id: 'D-unit', title: 'Unit Economics & Cohort Model', minLevel: 4, ct: 'application/pdf', pages: '9 pages' },
  { id: 'D-termsheet', title: 'Draft Term Sheet', minLevel: 4, ct: 'application/pdf', pages: '5 pages' },
  { id: 'D-sha', title: "Shareholders' Agreement (draft)", minLevel: 5, ct: 'application/pdf', pages: '41 pages' },
  { id: 'D-subscription', title: 'Subscription Agreement', minLevel: 5, ct: 'application/pdf', pages: '12 pages', old: true },
  { id: 'D-disclosure', title: 'Disclosure Schedules', minLevel: 5, ct: 'application/pdf', pages: '7 pages', old: true },
];

async function seed() {
  await ensureSchema();
  if ((await store.countAdmins()) > 0) return;
  await store.createAdmin({ email: 'founder@vitabahn.com', name: 'Founder', passwordHash: hashPassword('founder-dev-pass-1') });
  const mk = async (email, name, org, level, opts = {}) => {
    const id = await store.createInvestor({ email, name, org, accessLevel: level });
    await store.updateInvestor(id, { passwordHash: hashPassword('investor-dev-pass-1'), ...opts });
    return id;
  };
  // One investor per gate state: L1 (verify gate), L2 (NDA gate), L3+NDA (named
  // approval gate), L4+NDA (closing gate). Each has a 12 Aug 2026 expiry to match
  // the mockup's "Access valid" line.
  const expiry = new Date('2026-08-12T23:59:59Z').toISOString();
  await mk('j.fisher@seedwork.vc', 'Jamie Fisher', 'Seedwork Angels', 1, { expiresAt: expiry });
  await mk('o.alrashid@gulfhealth.cap', 'Omar Al-Rashid', 'Gulf Health Capital', 2, { expiresAt: expiry, commitAmount: 500000, commitStatus: 'soft' });
  await mk('k.vogel@nordwind.vc', 'Katharina Vogel', 'Nordwind Ventures', 3, { ndaSigned: true, ndaSignedAt: new Date('2026-06-20T09:00:00Z').toISOString(), expiresAt: expiry, commitAmount: 750000, commitStatus: 'committed', instrument: 'SAFE' });
  await mk('m.stern@lindenanchor.fund', 'Marcus Stern', 'Linden Anchor Fund', 4, { ndaSigned: true, ndaSignedAt: new Date('2026-06-10T09:00:00Z').toISOString(), expiresAt: expiry, approvedBy: 'Founder', approvedLevel: 4, approvedAt: new Date('2026-07-01T09:00:00Z').toISOString(), commitAmount: 1500000, commitStatus: 'committed', instrument: 'Equity' });

  for (const d of SEED_DOCS) {
    const bytes = d.ct === 'application/pdf' ? await makePdf(d.title, `Level ${d.minLevel} · ${d.pages}`) : Buffer.from(`Placeholder spreadsheet: ${d.title}`);
    await store.insertDocument({ id: d.id, title: d.title, minLevel: d.minLevel, tier: d.minLevel <= 2 ? 1 : 2, contentType: d.ct, size: bytes.length, pages: d.pages, bytes });
    // Backdate some so the room shows a realistic mix of New / Not-viewed statuses.
    if (d.old) await query("UPDATE documents SET updated_at = now() - interval '30 days' WHERE id = $1", [d.id]);
  }

  // NDA template investors download to sign (open tier so an L2 investor can get it).
  const ndaTpl = await makePdf('Non-Disclosure Agreement (template)', 'Sign and return to unlock Diligence (Level 3).');
  await store.insertDocument({ id: 'D-nda-template', title: 'Non-Disclosure Agreement (template)', minLevel: 2, tier: 1, contentType: 'application/pdf', size: ndaTpl.length, pages: '3 pages', bytes: ndaTpl });
  await store.setNdaTemplate('D-nda-template');

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
  console.log('  Investor login:  /investor-login   (all investors: password investor-dev-pass-1)');
  console.log('    j.fisher@seedwork.vc        L1 · First contact   (L2 verification gate)');
  console.log('    o.alrashid@gulfhealth.cap   L2 · Interested      (L3 NDA gate)');
  console.log('    k.vogel@nordwind.vc         L3 · Qualified+NDA   (L4 named-approval gate)');
  console.log('    m.stern@lindenanchor.fund   L4 · Lead/Anchor     (L5 closing gate)');
});
