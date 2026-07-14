# VitaBahn — HADP Investor Brief

A confidential, single-page investor brief. The page is a plain **static site**
(HTML / CSS / JS with self-hosted IBM Plex fonts) and makes **no third-party
requests** to render. The lead-capture form posts to a small **Vercel** serverless
function (`api/lead.js`) that validates the request, blocks spam, and emails each
lead to **info@vitabahn.com**.

> **Content is frozen.** The copy, numbers, and legal/disclaimer text are the
> approved, signed-off version and must not be reworded or changed without
> explicit approval. This repository only adds project structure and wiring —
> the rendered page looks and reads exactly as the approved source.

## Project structure

```
.
├── index.html        # markup (approved content, unchanged)
├── styles.css        # all styles (was the inline <style>)
├── app.js            # nav, scroll-reveal, HADP animation, form submit
├── 404.html          # minimal on-brand not-found page (noindex)
├── fonts/            # self-hosted IBM Plex woff2, no external requests
│   ├── IBMPlexSans-Regular / -Medium / -SemiBold / -Bold .woff2
│   ├── IBMPlexMono-Regular / -Medium / -SemiBold .woff2
│   └── OFL.txt       # SIL Open Font License 1.1 (ships with the fonts)
├── robots.txt        # reinforces noindex for the confidential brief
│
│                     # --- form backend (Vercel only; NOT part of the Porkbun upload) ---
├── api/lead.js       # serverless function -> POST /api/lead
├── package.json      # one dependency: nodemailer (Vercel installs it)
├── .env.example      # the environment variables to set in Vercel
├── .nvmrc            # Node 20 for local dev
│
├── LICENSE           # proprietary/confidential notice (repo only)
├── .editorconfig
├── .gitattributes
├── .gitignore
└── README.md
```

`index.html`, `styles.css`, and all seven fonts are **byte-identical** to the
approved source (`VitaBahn_HADP_Investor_v71.html`). The only behavioural change
versus that single file: the request form no longer opens the visitor's mail app —
it submits to a real backend that captures the lead and emails it.

## Two deploys, one repo

- **Vercel** deploys this repository and exposes the function at **`/api/lead`**.
  It auto-detects `api/*.js` and installs `nodemailer` from `package.json` — no build
  config and no "Root Directory" change needed.
- **Porkbun Static Hosting** serves the actual brief at **vitabahn.com** (static files
  only — see below).

`app.js` already points `LEAD_ENDPOINT` at the Vercel function
(`https://vita-bahn-web.vercel.app/api/lead`).

## Run locally

Render the page with any static server:

```bash
npx serve .
# or:  python -m http.server 8000
```

Run the function locally (optional):

```bash
npm install
npx vercel dev      # serves POST /api/lead at http://localhost:3000/api/lead
```

Add your local origin (e.g. `http://localhost:3000`) to `ALLOWED_ORIGIN` while testing.

## Form backend (Vercel) — environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (template in
`.env.example`), then **redeploy** — env changes only take effect on a new deploy:

| Variable         | Example                          | Notes |
|------------------|----------------------------------|-------|
| `LEAD_TO`        | `info@vitabahn.com`            | Where leads land. |
| `SMTP_HOST`      | `smtp.porkbun.com`               | Default = Porkbun Email Hosting. |
| `SMTP_PORT`      | `587`                            | `587` STARTTLS (default) or `465` TLS. |
| `SMTP_USER`      | `info@vitabahn.com`            | Full mailbox address. |
| `SMTP_PASS`      | *(mailbox password)*             | The password of that mailbox. Keep secret. |
| `LEAD_FROM`      | `info@vitabahn.com`            | `From:` header; defaults to `SMTP_USER`. Must match the authenticated mailbox. |
| `ALLOWED_ORIGIN` | `https://vitabahn.com`           | Comma-separated allowed origins (add `www`/preview if used). |

SMTP via Porkbun requires a **paid Porkbun Email Hosting** mailbox (free forwarding
can't send). Any SMTP works by changing these values — e.g. Resend
(`smtp.resend.com`, port `465`, user `resend`, pass = API key).

What the function does: accepts `POST` JSON (+ `OPTIONS` preflight), is CORS-restricted
to `ALLOWED_ORIGIN`, drops spam via a hidden `bot-field` honeypot, validates the same
fields as the page (`fn`, `ln`, `em`, `org`, consent required; `tk`, `msg` optional),
caps field lengths (no header injection), and sets `Reply-To` to the submitter.

### Test it

```bash
curl -i -X POST https://vita-bahn-web.vercel.app/api/lead \
  -H "Content-Type: application/json" \
  -H "Origin: https://vitabahn.com" \
  -d '{"fn":"Test","ln":"Investor","em":"test@example.com","org":"Test Fund","cs":"on","msg":"Hello"}'
```

Expect a **`200`** with `{"ok":true}` and an email in `info@vitabahn.com`. A missing
required field returns `400`; a filled `bot-field` returns `200` but sends nothing.
(`curl` isn't subject to browser CORS, so also submit once from the real site.)

## Deploy the page (Porkbun Static Hosting)

1. In Porkbun, open the domain's hosting panel and enable **Static Hosting**.
2. Upload **only the static files** — `index.html`, `styles.css`, `app.js`, `404.html`,
   `fonts/` (incl. `fonts/OFL.txt`), `robots.txt`. Do **not** upload the backend/repo
   artifacts: `api/`, `package.json`, `.env.example`, `.nvmrc`, `LICENSE`,
   `node_modules/`, or the dotfiles.
3. Point **vitabahn.com** at the hosting; Porkbun issues the free SSL certificate.
4. Site size is ~250 KB, well under Porkbun's 40 MB static-hosting limit.

Docs: <https://kb.porkbun.com/article/137-how-to-set-up-static-hosting>

### Confidentiality / headers — important

The brief is intentionally **`noindex, nofollow`** (meta tag in `index.html`) and
ships a `robots.txt` that disallows all crawlers. Porkbun Static Hosting serves files
as-is and does **not** support custom HTTP response headers, so the extra hardening
headers used on some hosts (`X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `X-Robots-Tag`) are **not** applied there. The `noindex` meta +
`robots.txt` still keep it out of search engines.

> If those HTTP headers are required, route the domain through a proxy that can inject
> them (e.g. Cloudflare in front of the Porkbun origin) — ask before changing hosting.

## Custom domain & email (vitabahn.com)

- **Domain & DNS:** managed at Porkbun. Point `vitabahn.com` at the static hosting.
  If you don't serve `www`, drop it from `ALLOWED_ORIGIN`; origins must match
  scheme + host exactly (no trailing slash).
- **Email:** `info@vitabahn.com` is the lead inbox and the footer contact link.
  The Vercel function sends notifications via SMTP (Porkbun by default).

## Pre-launch checklist

There is no build/lint step, so these are easy to forget — verify each before go-live:

- [ ] **Vercel function live** at `/api/lead` (the repo deploys automatically on push).
- [ ] **Env vars set in Vercel** (`SMTP_*`, `LEAD_TO`, `ALLOWED_ORIGIN`); redeploy after changes.
- [ ] **`LEAD_ENDPOINT` in `app.js`** points at the Vercel URL (already set).
- [ ] **Real test submission** from the live site lands in `info@vitabahn.com`.
- [ ] *(Optional)* set `og:url` in `index.html` to `https://vitabahn.com/` once the domain is live.

## Notes

- Fonts are fully self-hosted; the page makes no external network requests to render.
- Keep `LEAD_ENDPOINT` (`app.js`) and `ALLOWED_ORIGIN` (Vercel) pointed at the same live
  domain so the form and its CORS lock stay in sync.
- Because the repo also deploys to Vercel, the brief is reachable at the Vercel URL too;
  the production site is Porkbun + `vitabahn.com`.

---

# Investor Access & Data Room system

A staged, server-enforced investor-access and secure data-room system layered on the
existing Vercel serverless architecture. It replaces the old inline "request data room"
email form: every investor CTA now routes to **`/investor-access`**.

> **Hosting requirement — must run on Vercel.** This system needs serverless functions,
> a Postgres database, session cookies and the response headers in `vercel.json`.
> **Porkbun static hosting cannot run it.** To use it, serve the domain from the
> **Vercel** deployment (which serves the static pages *and* the functions *and* applies
> the CSP/security headers), not from Porkbun static hosting.

## What it does

- **`/investor-access`** — public qualification gateway. Submits to `POST /api/access-request`,
  which validates server-side, stores the request (status *pending*), emails the team the
  internal routing hint, emails the applicant a **neutral** confirmation, and gates booking.
  It **never** grants access, sends credentials, or exposes the Lead/Anchor booking automatically.
- **`/investor-login` → `/investor-room`** — authenticated investors sign in and see only the
  documents released at their **access level (1–5)** and **NDA** status. Documents are streamed
  **only** through `GET /api/room/document` after a per-request re-check of level, NDA, expiry and
  revocation. Bytes live in the database — there is **no public object URL**. Every view and denial
  is logged.
- **`/founder-login` → `/investor-console`** — the internal Level-0 console: assign per-user access
  level (L4/L5 require a **named approver**), toggle NDA/meeting, set expiry, **revoke** access (takes
  effect immediately), manage commitments/notes, review access requests and provision accounts, upload/
  classify/delete data-room documents, and read the audit log.

Access levels: **0** founders/admins (never assigned to an investor) · **1** public/first-contact ·
**2** interested · **3** qualified/NDA · **4** lead/anchor *(named approval)* · **5** signing *(named approval)*.

## Security model

- Server-side auth/authz only. Client-side hiding, secret URLs and `noindex` are **not** relied on.
- Passwords: scrypt with per-user salt. Sessions: HMAC-signed, HttpOnly, SameSite=Lax cookies;
  the signature is verified **and the account re-loaded from the DB on every request**, so
  revocation / expiry / level changes are immediate. Investor and founder are separate cookie realms.
- All SQL is parameterised; the only dynamic SQL is column-**allowlisted** update builders.
- State-changing requests require an allowlisted `Origin`/`Referer` (CSRF defence, on top of SameSite).
- Every login (success + failure), logout, document view, document denial and admin action is written
  to an append-only `access_logs` table.

## Setup (Vercel)

1. **Link a database.** Vercel Storage → add Postgres (Neon). It injects `POSTGRES_URL`.
2. **Set env vars** (see `.env.example`): `SESSION_SECRET` (required), `POSTGRES_URL` (auto),
   `LEAD_TO`, `SMTP_*`, `ALLOWED_ORIGIN`, optional `BOOKING_*`. Redeploy.
3. **Create the first admin.** Set `ADMIN_BOOTSTRAP_TOKEN`, redeploy, then:
   ```bash
   curl -X POST https://<your-app>/api/admin/bootstrap \
     -H "Content-Type: application/json" -H "Origin: https://vitabahn.com" \
     -d '{"token":"<ADMIN_BOOTSTRAP_TOKEN>","email":"you@vitabahn.com","password":"a-long-password","name":"You"}'
   ```
   Then **unset `ADMIN_BOOTSTRAP_TOKEN`** and redeploy. The schema is created automatically on first use.

## Run locally

```bash
npm install
node scripts/dev-server.mjs      # http://localhost:5050 — runs the real handlers on embedded PGlite
```

The dev server seeds a founder + sample investors/documents and prints demo credentials. It mirrors the
production CSP. (Data is in-memory unless you set `PGLITE_DATA_DIR`.) `npm run create-admin -- <email> <password> "<name>"`
creates/rotates an admin against `PGLITE_DATA_DIR` (local) or `POSTGRES_URL` (prod).

## Tests

```bash
npm test        # 33 hermetic tests (PGlite) exercising authn/authz, level + NDA enforcement,
                # revocation, expiry, access logging, gateway intake, and console/admin flows
```

## Data protection (GDPR)

The system stores **investor personal data**: access-request submissions (name, professional email,
organisation, role, country, LinkedIn, free-text message) and, for provisioned accounts, the same
profile plus a scrypt password hash, access grant and an audit trail of logins and document access.

- **Lawful basis:** legitimate interest / pre-contractual steps for evaluating investor-access requests
  (Art. 6(1)(b)/(f) GDPR). Consent is captured on the gateway (accuracy + privacy notice).
- **Data minimisation:** only fields needed to qualify an investor are collected; documents are shown
  strictly per access level + NDA.
- **Security:** passwords hashed (scrypt), transport over HTTPS/HSTS, access controlled per user and
  revocable, all access logged.
- **Retention & rights:** access requests and audit logs are retained for the fundraise; implement a
  periodic purge and honour access/erasure requests via `info@vitabahn.com`. The `documents.bytes`,
  `investors` and `access_requests`/`access_logs` tables are the records to include in a data-subject
  export or deletion. **Update `privacy.html`** to describe the investor data-room processing (categories,
  purpose, retention, rights) before go-live.
