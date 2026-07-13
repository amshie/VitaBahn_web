# VitaBahn — Go-Live Runbook (Investor Access & Data Room)

A step-by-step checklist to take the investor system live on **Vercel + Neon**.
Work top to bottom; every command and variable name below matches the code.

> **Must run on Vercel.** The investor system needs serverless functions, a Postgres
> database, session cookies and the response headers in `vercel.json`. Porkbun static
> hosting **cannot** run it — serve the domain from the Vercel deployment.

---

## 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | **yes** | Signs the session cookies (`api/_lib/auth.js`). Use a long random value, e.g. `openssl rand -hex 32`. If unset, sessions silently break across instances. |
| `POSTGRES_URL` | **yes** | Neon connection string. Injected automatically when you link a Neon DB via Vercel Storage (`api/_lib/db.js`). |
| `ALLOWED_ORIGIN` | **yes** | Comma-separated allowlist for CSRF/Origin checks (`api/_lib/http.js`). e.g. `https://vitabahn.com,https://www.vitabahn.com`. Must match scheme+host exactly, no trailing slash. |
| `PUBLIC_BASE_URL` | recommended | Base URL used to build links in emails (set-password link). Defaults to the first `ALLOWED_ORIGIN`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | for email | Sends set-password invites, access-request + interest notifications. Without them the app still works but emails no-op (links must be copied manually). |
| `LEAD_FROM` | optional | `From:` header; defaults to `SMTP_USER` (must match the authenticated mailbox). |
| `LEAD_TO` | recommended | Where lead / access-request / interest notifications land. Defaults to `invest@vitabahn.com`. |
| `ADMIN_BOOTSTRAP_TOKEN` | temporary | Enables the one-time admin bootstrap (step 4). **Unset it again afterwards.** |
| `SESSION_TTL_SEC` | optional | Session lifetime, default `43200` (12h). |
| `INVITE_TTL_SEC` | optional | Set-password link lifetime, default 7 days. |
| `BOOKING_*` | optional | Meeting booking links used by the access gateway. |

Redeploy after any env change — Vercel only picks them up on a new deployment.

## 2. Database (Neon)

1. Vercel → **Storage** → add **Postgres (Neon)**; it injects `POSTGRES_URL`.
2. **Prefer an EU region** for the database (GDPR — the room stores investor personal data).
3. The schema is created automatically on first request (`ensureSchema`) — no manual migration.

## 3. Start from a clean database

The demo investors/documents you saw in local preview are **dev-server only** and never
touch production. Still, confirm production is clean before launch:

```bash
# Dry run — shows the row counts, deletes nothing:
POSTGRES_URL="postgres://…your-neon-url…" node scripts/reset-db.mjs
```

If it shows only `admins` (or all zeros) you are clean. To wipe leftover **test** data
(keeps your admin login):

```bash
POSTGRES_URL="postgres://…" node scripts/reset-db.mjs --yes
```

> ⚠️ `access_requests` are **real investor submissions** (leads + personal data). The wipe
> is irreversible — be sure there are none you want to keep. Add `--include-admins` to
> remove admin logins too (then re-bootstrap).

## 4. Create the first founder (Level-0) admin

Set `ADMIN_BOOTSTRAP_TOKEN` (a long random value), redeploy, then:

```bash
curl -X POST https://<your-app>/api/admin/bootstrap \
  -H "Content-Type: application/json" -H "Origin: https://vitabahn.com" \
  -d '{"token":"<ADMIN_BOOTSTRAP_TOKEN>","email":"you@vitabahn.com","password":"a-long-password-12+","name":"Your Name"}'
```

Password must be **≥ 12 characters**. Then **unset `ADMIN_BOOTSTRAP_TOKEN` and redeploy**
so the endpoint disables itself. (Alternative for a rotation: `POSTGRES_URL="…" npm run create-admin -- <email> <password> "<name>"`.)

## 5. Load real data (in the console)

Sign in at **`/founder-login`** → **`/investor-console`**:

- **Documents:** upload the real files; set each document's level (1–2 = Open, 3+ = NDA).
  NDA-tier docs are automatically **view-only** and every served PDF is **watermarked**
  with the recipient's identity.
- **Investors:** review real submissions under **Access requests**, then **Provision** each
  at the correct level. **Levels 4 & 5 require a named approver.** Provisioning emails a
  one-time set-password link (or gives you the link to send if SMTP is unset).
- Use **"View data room"** on any investor to preview exactly what they will see.

## 6. Security & legal — verify before launch

- [ ] Domain served from **Vercel** (not Porkbun static); HTTPS + HSTS active.
- [ ] `vercel.json` headers live: CSP, `X-Frame-Options`, `noindex` on `/investor-*` + `/api/*`.
- [ ] `SESSION_SECRET` set (sessions survive restarts/instances).
- [ ] Production DB clean (step 3) — no demo data.
- [ ] `privacy.html` describes the data-room processing **and** the per-recipient
      watermarking; **Impressum** present; DPAs/SCCs signed with Vercel, Neon, Porkbun.
- [ ] Neon in an EU region (or a documented transfer safeguard).

## 7. Smoke test on the live site

- [ ] Investor login works; the investor sees **only their level**; the next tier shows the
      correct gate (verify / NDA / named-approval); deeper tiers are generic locked panels.
- [ ] Open a document → it renders **watermarked** with the investor's name/email; an
      NDA-tier **download is refused**.
- [ ] Console: change level, toggle NDA, set expiry, **revoke** → investor is locked out
      **immediately**; the "View data room" preview matches the investor's real view.
- [ ] A revoked or expired account **cannot log in**.
- [ ] The access-request form emails the team and shows the applicant a neutral confirmation.
- [ ] Every login and document open appears in the **audit log** (console → Audit log).

---

*Once §6 and §7 pass, you are live. Keep an eye on the audit log for the first real
investor sessions.*
