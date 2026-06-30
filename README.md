# VitaBahn — HADP Investor Brief

A confidential, single-page investor brief. The page is a plain **static site**
(HTML / CSS / JS with self-hosted IBM Plex fonts) and makes **no third-party
requests** to render. A lead-capture form posts to a small **Vercel** function
that emails each request to the team.

> **Content is frozen.** The copy, numbers, and legal/disclaimer text are the
> approved, signed-off version and must not be reworded or changed without
> explicit approval. This repository only adds project structure and wiring —
> the rendered page looks and reads exactly as the approved source.

## Project structure

```
.
├── index.html            # markup (approved content, unchanged)
├── styles.css            # all styles (was the inline <style>)
├── app.js                # nav, scroll-reveal, HADP animation, form submit
├── 404.html              # minimal on-brand not-found page (noindex)
├── fonts/                # self-hosted IBM Plex woff2, no external requests
│   ├── IBMPlexSans-Regular / -Medium / -SemiBold / -Bold .woff2
│   ├── IBMPlexMono-Regular / -Medium / -SemiBold .woff2
│   └── OFL.txt           # SIL Open Font License 1.1 (ships with the fonts)
├── robots.txt            # reinforces noindex for the confidential brief
├── form-backend/         # the Vercel form handler (deployed separately — see its README)
├── LICENSE               # proprietary/confidential notice (repo only)
├── .editorconfig
├── .gitattributes
├── .gitignore
└── README.md
```

`index.html`, `styles.css`, and all seven fonts are **byte-identical** to the
approved source (`VitaBahn_HADP_Investor_v71.html`). The only behavioural change
versus that single file: the request form no longer opens the visitor's mail app —
it submits to a real backend that captures the lead and emails it.

## Run locally

Any static file server renders the page:

```bash
npx serve .
# or:  python -m http.server 8000
```

The **form** only reaches an inbox once `form-backend/` is deployed and its URL is
wired into `app.js` (see below). Locally the page renders perfectly; a submission
will simply show the inline "something went wrong" fallback until the endpoint is set.

## The lead form (two pieces)

1. **Backend:** deploy `form-backend/` to Vercel and set its environment variables.
   Full steps in [`form-backend/README.md`](form-backend/README.md).
2. **Wire-up:** put the resulting endpoint into `app.js`:

   ```js
   var LEAD_ENDPOINT='https://REPLACE-WITH-YOUR-PROJECT.vercel.app/api/lead';  // -> your real Vercel URL
   ```

   (That `REPLACE-WITH-YOUR-PROJECT…` string is the exact placeholder shipped in `app.js`.)
   Then re-upload `app.js` to the host. Leads are emailed to **invest@vitabahn.com**;
   a hidden honeypot and the same required-field/email validation as the page run
   before anything is sent.

## Deploy the page (Porkbun Static Hosting)

This site is plain static files — host it on **Porkbun Static Hosting**.

1. In your Porkbun account, open the domain's **Website** / hosting panel and enable
   **Static Hosting**.
2. Upload the static files — **`index.html`, `styles.css`, `app.js`, `404.html`,
   `fonts/` (including `fonts/OFL.txt`), `robots.txt`** — via the built-in file editor,
   FTP, or by connecting a GitHub repo. (Do **not** upload `form-backend/`, `LICENSE`, or
   the dotfiles — those are repo/Vercel artifacts, not part of the served site.)
3. Point **vitabahn.com** at the hosting and let Porkbun issue the free SSL certificate.
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
  The default `ALLOWED_ORIGIN` also lists `https://www.vitabahn.com`; that entry only
  matters if you actually serve the site at `www` too (origins must match scheme + host
  exactly, no trailing slash). If you don't use `www`, drop it from `ALLOWED_ORIGIN`.
- **Email:** `invest@vitabahn.com` is the lead inbox and the footer contact link.
  The Vercel function sends notifications via SMTP — by default Porkbun Email Hosting
  (`smtp.porkbun.com`), which keeps mail within your Porkbun stack. See
  [`form-backend/README.md`](form-backend/README.md).

## Pre-launch checklist

There is no build/lint step, so these are easy to forget — verify each before go-live:

- [ ] **Deploy `form-backend/` to Vercel** and set its env vars (see its README).
- [ ] **Replace `LEAD_ENDPOINT`** in `app.js` with your real Vercel URL, then re-upload `app.js`.
      (If left unset the page still loads, but every submission fails — and `app.js` logs a
      `console.warn` to flag it.)
- [ ] **Set `ALLOWED_ORIGIN`** (in Vercel) to your live domain(s); redeploy after changing env vars.
- [ ] **Send a real test submission** from the live site and confirm it lands in `invest@vitabahn.com`.
- [ ] *(Optional)* set `og:url` in `index.html` to `https://vitabahn.com/` once the domain is live
      (intentionally blank now; the page is `noindex`, so link-preview is a non-goal).

## Notes

- Fonts are fully self-hosted; the page makes no external network requests to render.
- Keep `LEAD_ENDPOINT` (in `app.js`) and `ALLOWED_ORIGIN` (in Vercel) pointed at the
  same live domain so the form and its CORS lock stay in sync.
