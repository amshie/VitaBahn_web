# VitaBahn — lead form backend (Vercel)

A single serverless function that receives the investor "Request Materials" form
from the static brief (hosted on Porkbun), validates it, blocks spam, and emails
each lead to **invest@vitabahn.com**.

The static site never processes the form itself — a static host can't. The page
just AJAX-POSTs the form as JSON to this function's URL.

```
form-backend/
├── api/
│   └── lead.js       # the function -> deployed as POST /api/lead
├── package.json      # one dependency: nodemailer (Vercel installs it automatically)
├── .nvmrc            # Node 20 for local dev (Vercel honours package.json "engines")
├── .env.example      # the environment variables to set in Vercel
└── README.md
```

## What it does

- Accepts `POST` JSON only (plus `OPTIONS` for the browser's CORS preflight).
- **CORS-restricted** to your live origin(s) via `ALLOWED_ORIGIN`, so other *websites'*
  JavaScript can't call it from a browser. (CORS is a browser rule — it doesn't stop a
  direct `curl`/server POST. For a confidential, low-traffic form the honeypot + length
  caps suffice; add Vercel rate-limiting or a captcha only if abuse appears.)
- **Honeypot:** if the hidden `bot-field` is filled, it returns success and silently drops the message.
- **Validates** the same fields as the page: `fn`, `ln`, `em` (email format), `org`, and the consent checkbox `cs` are required; `tk` and `msg` are optional. Over-long input is truncated; newlines are stripped (no e-mail header injection).
- **Emails** the lead via SMTP, with `Reply-To` set to the submitter so you can reply directly.

## Deploy (Vercel)

1. Create a free account at <https://vercel.com> and "Add New… → Project".
2. Import this repository. In the project settings, set **Root Directory** to `form-backend`
   (so Vercel builds *this* folder, not the static site).
   - Framework preset: **Other**. Build command: *(none)*. Vercel auto-detects `api/lead.js`.
3. Add the environment variables (next section), then **Deploy**.
4. Your endpoint will be:  `https://<your-project>.vercel.app/api/lead`

### Wire the page to it

Open **`../app.js`**, find `LEAD_ENDPOINT` (it ships as the placeholder
`https://REPLACE-WITH-YOUR-PROJECT.vercel.app/api/lead`) and set it to the URL above:

```js
var LEAD_ENDPOINT='https://your-project.vercel.app/api/lead';
```

(Re-upload `app.js` to Porkbun afterwards.)

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (see `.env.example`):

| Variable         | Example                                          | Notes |
|------------------|--------------------------------------------------|-------|
| `LEAD_TO`        | `invest@vitabahn.com`                            | Where leads land. |
| `SMTP_HOST`      | `smtp.porkbun.com`                               | Default = Porkbun Email Hosting. |
| `SMTP_PORT`      | `587`                                            | `587` STARTTLS (default) or `465` TLS. |
| `SMTP_USER`      | `invest@vitabahn.com`                            | Full mailbox address. |
| `SMTP_PASS`      | *(mailbox password)*                             | Keep secret. |
| `LEAD_FROM`      | `invest@vitabahn.com`                            | `From:` header; defaults to `SMTP_USER`. |
| `ALLOWED_ORIGIN` | `https://vitabahn.com,https://www.vitabahn.com`  | Comma-separated allowed origins. |

> **After the first deploy:** changing an env var does **not** take effect until you
> trigger a redeploy (Vercel → Deployments → ⋯ → **Redeploy**).

### SMTP via Porkbun (default, keeps email in your Porkbun stack)

Porkbun's outgoing mail server is `smtp.porkbun.com`, port `587` (STARTTLS),
username = the full address, password = the mailbox password. This requires a
paid **Porkbun Email Hosting** mailbox (free *forwarding* alone has no SMTP to
send from). Settings: <https://kb.porkbun.com/article/146-email-client-configuration-settings>

### Alternative SMTP providers

Any SMTP works — only the env values change, not the code. E.g. **Resend**
(`smtp.resend.com`, port `465`, user `resend`, pass = API key) or any
transactional provider. Set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`
accordingly.

## Test it

After deploying and setting env vars, from a terminal:

```bash
curl -i -X POST https://your-project.vercel.app/api/lead \
  -H "Content-Type: application/json" \
  -H "Origin: https://vitabahn.com" \
  -d '{"fn":"Test","ln":"Investor","em":"test@example.com","org":"Test Fund","cs":"on","msg":"Hello"}'
```

Expect a **`200`** response with body `{"ok":true}`, and an email in `invest@vitabahn.com`.
A missing required field returns `400 {"ok":false,...}`; a filled `bot-field`
returns `200 {"ok":true}` but sends nothing.

> `curl` isn't subject to browser CORS, so a `200` here doesn't by itself prove the
> browser allowlist is correct — also submit once from the real site to confirm.

## Local development

```bash
cd form-backend
npm install
npx vercel dev      # serves the function at http://localhost:3000/api/lead
```

Add `http://localhost:3000` (or your static-server origin) to `ALLOWED_ORIGIN`
while testing locally.
