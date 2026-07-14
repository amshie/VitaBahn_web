# VitaBahn — Security Audit

**Target:** the `vitabahn.com` codebase (this repository) — the confidential HADP investor brief and its lead-capture backend.
**Type:** read-only defensive code and configuration review. No scanning, probing, or exploitation was performed against the live site; every finding below is grounded in a file, line, or audit-tool output on disk.
**Date:** 2026-07-01.
**Method:** manual inventory and tracing of the full codebase, `npm audit` against a generated lockfile, a full `git log -p` history scan for secrets, and an independent per-area audit (secrets/config, dependencies, the form endpoint, client-side injection, headers/transport, access/GDPR) whose every candidate finding was then adversarially re-verified against the source before inclusion here.

---

## Verdict

The codebase is small, self-contained, and in good shape for what it is: a static single-page brief plus one serverless mail function, with **no client-side XSS, no injection sinks, no committed secrets, no third-party scripts or trackers, and a correctly-mitigated email-header-injection surface.** The genuine weaknesses are concentrated in two places: the lead-capture endpoint, which is unauthenticated and has no rate limiting or effective bot control (its only guard, a honeypot, is bypassed by default for any non-browser client), and the privacy/legal surface, which collects investor personal data with no privacy notice, no disclosure of its non-EU processors, and no Impressum. Secondary gaps are the absence of any HTTP security headers, a known-High advisory in the pinned `nodemailer` version (not currently reachable, but due to be cleared before go-live), and the fact that a document explicitly labelled "confidential" is protected in production by URL obscurity rather than by any server-side access control. Nothing here is remotely exploitable for code execution, data exfiltration, or host compromise.

**Findings by severity:** Critical 0 · High 1 · Medium 3 · Low 4 · Informational 6.

---

## Scope & system overview

This repository is **not** a Next.js/React application or a larger framework build. It is:

- **A static single-page site.** `index.html` (~107 KB of markup, including three inline base64-encoded JPEG team photos and a data-URI SVG favicon), `styles.css` (~41 KB), and `app.js` (navigation toggle, a scroll-reveal animation, an SVG pipeline animation, and the form submit handler). Seven IBM Plex `woff2` fonts are self-hosted in `fonts/`. There is a matching `404.html` and a `robots.txt`.
- **One Vercel serverless function**, `api/lead.js`, which receives the "Request Investor Access" form as JSON, validates it, drops honeypot spam, and emails the lead to `info@vitabahn.com` via SMTP using `nodemailer` (the project's only runtime dependency).
- **An optional Vercel Routing Middleware**, `middleware.js`, that gates every non-API route behind HTTP Basic Auth when the `SITE_PASSWORD` environment variable is set (it is unset/disabled by default).

**What handles user input:** exactly one surface — the contact/data-room form in `index.html` (lines 515–529), submitted by `app.js` and processed by `api/lead.js`.

**What talks to the outside world:** the page itself makes **no** third-party requests to render (fonts are local; the favicon and photos are inline data URIs). The only outbound references are three LinkedIn profile links in the team section, all carrying `rel="noopener noreferrer"`. The one server-to-server call is `api/lead.js` → Porkbun SMTP.

**Where personal data enters/leaves:** personal data (first name, last name, business email, organization, optional ticket range, optional free-text message, plus a consent flag) is entered in the form, POSTed to the Vercel function, and emailed onward to `info@vitabahn.com` via Porkbun SMTP. No database, cookie, `localStorage`, `sessionStorage`, or analytics is involved anywhere.

**Deployment topology (note for the reader):** the effective production origin is ambiguous in the repo and this affects which controls are actually in the serving path. `app.js:18` uses a **same-origin relative** endpoint (`/api/lead`), and commit `75c3654` is titled *"Use same-origin /api/lead endpoint (page now served by Vercel)"* — both of which imply Vercel serves the page and the function together. Yet `README.md:51–52,127` still describes Porkbun static hosting as the production host for `vitabahn.com`, with the function on a separate Vercel origin. These cannot both be current: if Porkbun serves the page, the relative `/api/lead` POST would 404 because Porkbun static hosting runs no functions. This should be confirmed (see Informational note I6). Throughout this report, findings that depend on the host are flagged accordingly.

---

## High

### H1 — The lead endpoint is unauthenticated and has no rate limiting or effective bot control (email-flood / SMTP quota & reputation abuse)

**Location:** `api/lead.js` (handler `47–116`; honeypot `58–59`; unconditional send `104–110`). No `vercel.json`, no throttle, no CAPTCHA anywhere in the repo.

**Impact.** Any client that can reach `/api/lead` can script an unlimited number of valid-looking submissions, and each one causes `transporter.sendMail()` to send a real email through the authenticated Porkbun mailbox to the fixed address `info@vitabahn.com`. The realistic consequences for an investor-facing business are (a) the lead inbox is flooded with fake requests, drowning or hiding genuine investor leads; (b) the paid Porkbun Email Hosting send quota is exhausted, after which legitimate submissions silently fail at the SMTP step; and (c) the sending domain's SMTP reputation is degraded or blocklisted, which harms *all* `vitabahn.com` email, not just this form. This is an availability-and-reputation attack, not a data breach — the recipient is a fixed environment value, so it is **not** an open relay and cannot be redirected to arbitrary addresses — but for a site whose entire purpose is capturing a small number of high-value leads, losing the channel and poisoning the mail domain is a serious, likely outcome.

**Evidence.** After field validation the handler calls, with no preceding throttle, CAPTCHA, proof-of-work, or per-IP limit:

```js
await transporter.sendMail({ from: `VitaBahn site <${from}>`, to: LEAD_TO,
  replyTo: `${data.fn} ${data.ln} <${data.em}>`, subject: ..., text });   // api/lead.js:104-110
```

The only spam control is the honeypot at `api/lead.js:59` (`if (clean(body['bot-field'], 200)) return res.status(200)...`), which is defeated simply by omitting the field — the default for anything POSTing JSON directly. The CORS logic in `setCors`/`resolveOrigin` (`api/lead.js:32-45`) only *sets* response headers; it never inspects `Origin` to reject a request, so a non-browser client (curl, script) runs the handler to completion regardless. `README.md:110` states this outright ("curl isn't subject to browser CORS") and `README.md:101-105` publishes the exact valid payload. A grep of the repository for `rate`/`limit`/`throttle`/`captcha`/`turnstile` returns only the unrelated field-length `LIMITS` constant.

**Fix.** Add real abuse controls before the `sendMail` call: (1) a bot challenge on the form — Cloudflare Turnstile or hCaptcha (both free and privacy-friendly) — verified server-side in the handler before line 104, returning `400` on failure; (2) per-IP rate limiting using a shared store such as Upstash Redis (`@upstash/ratelimit`) keyed on `x-forwarded-for` with a tight sliding window (e.g. 3–5/hour/IP), returning `429` when exceeded; and (3) a global daily send-cap counter so a distributed flood cannot silently burn the whole SMTP quota — once hit, drop and alert rather than send. Keep the honeypot and length caps as complementary controls. Turnstile plus a per-IP limit neutralize the scripted flood while leaving the single legitimate submission untouched.

*Severity note:* the adversarial verification pass argued for Medium on the grounds that the blast radius is bounded to one fixed inbox and Vercel applies coarse platform-level abuse protection. It is retained at **High** here because exploitation is trivial and fully unauthenticated, the sole existing control is bypassed by default, and the business impact (loss of the primary lead channel plus lasting mail-domain reputation damage, immediately before investors engage) is significant. A reader who weighs impact purely by data-confidentiality may reasonably file it as high-Medium; either way it is the single most important item to fix.

---

## Medium

### M1 — Known-High advisory in the pinned `nodemailer` version

**Location:** `package.json:11` (`"nodemailer": "^6.9.0"`), which resolves to `nodemailer@6.10.1` (confirmed in the generated `package-lock.json`).

**Impact.** `npm audit` reports **1 High** vulnerability against this version. The advisory bundle for `nodemailer <= 9.0.0` covers SSRF (CWE-918), CRLF / SMTP command-injection variants (header injection, `envelope.size`, EHLO/HELO, `List-*` comments), an `addressparser` denial-of-service, and TLS-validation issues in OAuth2 token fetch. The fix is `nodemailer@9.0.3`, a semver-major upgrade.

**Reachability (important, and honest).** None of these advisory classes is currently exploitable through this specific handler. Every user field is passed through `clean()` (`api/lead.js:30`), which runs `String(...).replace(/\s+/g, ' ').trim().slice(0, max)` — and because the regex `\s` matches CR, LF, and tab, all newline primitives required for header/command injection are stripped before any value reaches `replyTo`/`subject`/`text` (`api/lead.js:63`, then `107–109`). The `From`/`To` values are environment-derived, not user input. There are no attachments and no user-supplied URLs, so the SSRF vector has nothing to fetch, and the `addressparser` DoS is blocked in practice by the 100/200-character `LIMITS` caps (`api/lead.js:24`). This is therefore a supply-chain hygiene and pre-launch audit-compliance issue rather than a live exploit path.

**Evidence.** `npm audit` output: `nodemailer <=9.0.0 — Severity: high — fix available via nodemailer@9.0.3` (advisories GHSA-mm7p-fcc7-pg87, GHSA-rcmh-qjqh-p98v, GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g, GHSA-268h-hp4c-crq3, GHSA-r7g4-qg5f-qqm2, GHSA-p6gq-j5cr-w38f, GHSA-wqvq-jvpq-h66f). Lockfile resolves `nodemailer` to `6.10.1`.

**Fix.** Bump `package.json:11` to `"nodemailer": "^9.0.3"` (or later), regenerate the lockfile, and re-run `npm audit` to confirm zero vulnerabilities. Because 6.x → 9.x is a major bump, smoke-test the transport configuration at `api/lead.js:92-101` against both transports actually used — port 465 (`secure:true`, implicit TLS) and port 587 (`requireTLS:true`, STARTTLS) — plus the auth object and the connection/greeting timeouts. Keep `clean()` and `LIMITS` as the primary control regardless.

*Severity note:* the verification pass rated this Low on reachability. It is presented at **Medium** because a known-High advisory in the dependency tree should be cleared before a public go-live, and the mitigation is entirely dependent on the current shape of `api/lead.js` — a single future edit (adding an attachment, an OAuth2 transport, or a code path that bypasses `clean()`) re-opens a High-severity vector.

### M2 — No GDPR Art. 13 privacy notice, informed consent, or non-EU transfer disclosure at the point of personal-data collection

**Location:** the form and its consent checkbox, `index.html:515-529` (consent at `526`); the processing path, `api/lead.js:11,14-21,93-110`; the footer with no privacy link, `index.html:747-748`.

**Impact.** The form collects personal data from (by intent) EU-based investors and gates submission on a required consent checkbox whose only text is *"I agree to be contacted regarding investor materials and controlled Data Room access. Submission does not guarantee access."* (`index.html:526`). There is no privacy policy, no data-protection notice, and no privacy link anywhere on the site. Under GDPR Art. 13, at the moment of collection the data subject must be told the controller's identity, the purpose and legal basis, the recipients, any transfer outside the EEA, the retention period, and their rights. None of this exists, so the consent captured is not "informed." Compounding this, the personal data is processed by, and transferred to, non-EU processors — the Vercel serverless function (US-linked infrastructure) and Porkbun SMTP — with no disclosure of those recipients and no stated transfer safeguard (Chapter V / Art. 13(1)(f)). For a GDPR-sensitive, health-adjacent brief this is a live compliance gap the moment the form is reachable by an EU visitor.

**Evidence.** A repository-wide search for `privacy`/`datenschutz`/`impressum`/`policy`/`GDPR`/`controller`/`retention` across the HTML returns only unrelated marketing prose; a glob for any privacy/legal page returns nothing. The footer (`index.html:747-748`) contains only "Brief" and "Contact" columns. The processing path is visible at `api/lead.js:14` (`SMTP_HOST = 'smtp.porkbun.com'`), `93-101` (transporter), and `104-110` (send). No cookies, `localStorage`, `sessionStorage`, analytics, or trackers exist anywhere (grep is clean), which is genuinely good — the tracking-consent surface is minimal; the gap is specifically the collection notice and transfer transparency.

**Fix.** Create a privacy/data-protection page (and, for a German-facing entity, a `Datenschutzerklärung`) covering: controller identity and contact; purpose (evaluating and responding to investor/data-room requests); legal basis (Art. 6(1)(a) consent and/or 6(1)(b)/(f)); processors/recipients named explicitly (Vercel as hosting/function processor, Porkbun as SMTP relay); the transfer to the US and the safeguard relied on (execute and reference the Vercel and Porkbun DPAs/SCCs under Art. 28/Chapter V, and pin the function to an EU region if feasible); retention; and data-subject rights including the right to complain to a supervisory authority. Then link that page directly from the consent label at `index.html:526` so consent becomes informed, and add a footer "Privacy" link. Ensure it is present on whichever host actually serves the form.

### M3 — A document labelled "confidential" has no server-side access control in production and an ungated, discoverable public mirror

**Location:** `middleware.js:11-18`; `.env.example:24` (`SITE_PASSWORD=` blank); `robots.txt:3-4` and `index.html:6` (the only "protection"); `README.md:159-160` (the public Vercel mirror).

**Impact.** The brief is explicitly marked *"Confidential — for addressed recipients only"* (`index.html:750-751`), yet its only access control, the `SITE_PASSWORD` Basic-Auth gate, is (a) disabled by default because `middleware.js:17-18` early-returns when the variable is unset, and (b) a Vercel-only construct that does not run at all on Porkbun static hosting. In production the document is therefore protected only by `noindex`/`robots.txt` obscurity, which keeps it out of search engines but does not stop anyone who obtains the URL — via a forwarded email, a referrer leak, or link sharing — from reading the entire brief, team photos, and financials with no credential. Separately, the repository documents an ungated public Vercel mirror of the same brief at `vita-bahn-web.vercel.app` (`README.md:159-160`); `*.vercel.app` hostnames are independently discoverable through certificate-transparency logs and predictable project naming, which widens the exposure beyond a single shared secret URL.

**Evidence.** `middleware.js:13` uses `matcher: ['/((?!api/).*)']` (a Vercel middleware export); `middleware.js:17-18` is `const password = process.env.SITE_PASSWORD; if (!password) return;`. `.env.example:24` ships the variable blank. `robots.txt` and the `noindex` meta are anti-indexing signals only. No geo-blocking mechanism exists anywhere in the repo (the task asked whether geo-blocking is enforced server-side or trivially bypassed — the answer is that none exists at all).

**Fix.** Decide whether the brief is meant to be truly access-controlled. If yes: make Vercel the production origin and set `SITE_PASSWORD` so `middleware.js` enforces the gate on every non-API route, or front the origin with a proxy that can gate access (Cloudflare Access / Zero Trust, or a Workers Basic-Auth), and enable Vercel Deployment Protection so the `*.vercel.app` mirror is not an ungated second copy. Prefer per-recipient signed, expiring links or SSO over a single shared password for an investor-confidential document. Treat `noindex` + `robots.txt` as anti-indexing only, never as access control. If the brief is genuinely intended to be public-by-URL, remove the "for addressed recipients only" labelling so the stated and actual postures match, and record that decision.

---

## Low

### L1 — No clickjacking protection (missing `X-Frame-Options` / CSP `frame-ancestors`)

**Location:** `index.html` head (`4-18`, no `http-equiv`); no `vercel.json`; `api/lead.js:39-45` sets only CORS headers.

**Impact.** The confidential brief and the lead form can be embedded in an `<iframe>` on any attacker-controlled origin, with no frame-busting anywhere. Because there is no authenticated session, cookie, or state-changing privileged action to hijack, real impact is limited to UI-redress (tricking a victim into submitting their own contact details, i.e. nuisance lead-spam) and opportunistic re-framing of a brief that is already only obscurity-protected.

**Evidence.** The `<head>` contains only charset/viewport/robots/theme-color/description/OpenGraph/Twitter tags — no CSP meta and no framing directive. A repo-wide grep for `X-Frame-Options`/`frame-ancestors`/`http-equiv` matches only the documentation in `README.md`. No `vercel.json` exists, so the Vercel deployment sets no headers.

**Fix.** On the Vercel deployment, add a `vercel.json` `headers` block applying `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` to `/(.*)` (this also protects `/api/lead` responses). For a Porkbun static origin that cannot set headers, either front it with Cloudflare (as `README.md:133-134` already contemplates) or add a minimal JS frame-buster (`if (window.top !== window.self) window.top.location = window.self.location`), since a `<meta http-equiv>` cannot express `frame-ancestors`.

### L2 — The optional Basic-Auth gate is a weak single-secret control

**Location:** `middleware.js:20-25`.

**Impact.** When `SITE_PASSWORD` is enabled, the gate is a single shared static secret with several weaknesses: there is no rate limiting, lockout, or delay, so it is online-brute-forceable by anyone who knows the URL; the username is deliberately discarded (`middleware.js:24`), so the effective secret is password-only; the comparison at `middleware.js:25` (`pwd === password`) is a short-circuiting `===` and therefore not constant-time (a theoretical timing side-channel, impractical over the network); and `atob()` (`middleware.js:23`) is not UTF-8-safe, so a correctly-set multibyte password can never authenticate (a correctness footgun rather than a vulnerability). Exposure is bounded — the gate is off by default and only runs on the Vercel host — so this is a hardening item, not a live hole.

**Evidence.** `middleware.js:20-25`: `const header = request.headers.get('authorization')...; try { decoded = atob(header.slice(6)); } catch (_) { decoded = ''; } const pwd = decoded.slice(decoded.indexOf(':') + 1); if (pwd === password) return;` — no attempt counter, delay, or per-IP throttle anywhere in the file.

**Fix.** If the gate is used for anything sensitive, prefer real access control (Cloudflare Access, Vercel Deployment Protection, or per-recipient signed links) over a shared password. If keeping Basic Auth, add throttling/lockout at the edge, and replace the `===` check with a length-independent constant-time comparison using Web Crypto (HMAC both sides under a random per-request key and compare digests, since the Edge runtime does not guarantee Node's `crypto.timingSafeEqual`). Given the negligible real-world risk today, this is low priority.

### L3 — No durable proof-of-consent record (GDPR Art. 7(1))

**Location:** `api/lead.js:64-90`.

**Impact.** GDPR Art. 7(1) requires the controller to be able to *demonstrate* that consent was given. The handler requires the consent flag to proceed (`api/lead.js:68`) and writes a hardcoded `"Consent: yes"` line into the notification email (`api/lead.js:89`), but it stores no durable, tamper-evident record: no timestamp, no version of the consent text the user actually saw, no IP/user-agent, and no independent log. The only artifact is a mailbox message. If a lead later disputes consent, there is no defensible record tying their agreement to the specific wording shown.

**Evidence.** `const consent = body.cs === true || body.cs === 'on' || ...` (`api/lead.js:64-65`); the emailed string at `api/lead.js:89` is fixed regardless of the consent-text version presented.

**Fix.** Persist a minimal consent record at submission time — timestamp, a version identifier for the consent wording, and the email — to an append-only store (a logging service or database row), independent of the notification email. This pairs naturally with the privacy notice in M2.

### L4 — No German Impressum (legal-notice obligation) — *needs verification of entity jurisdiction*

**Location:** footer, `index.html:743-751`; no legal page exists in the repo.

**Impact.** If the operating entity is established in Germany (plausible for a physician-led German-market health venture, but not confirmed from the code), a commercial web presence must carry an Impressum under the Digitale-Dienste-Gesetz (DDG §5, successor to TMG §5) identifying the legal entity, its legal form, an authorised representative, a postal address, register/VAT details where applicable, and a rapid electronic contact. The site shows none of this — only a `mailto:` and a `© 2026 VitaBahn` line. Non-compliance is subject to `Abmahnung` (cease-and-desist) and fines. This is a legal-compliance gap, not a security exploit, and its applicability depends on the (unverified) jurisdiction and on whether the page is publicly reachable.

**Evidence.** The footer (`index.html:747-751`) contains only "Brief"/"Contact" anchor columns, a `mailto:info@vitabahn.com`, a confidentiality disclaimer, and the copyright line. A repo grep for `Impressum`/`GmbH`/`UG`/`Handelsregister`/`USt` returns no legal-entity or address information anywhere.

**Fix.** If the entity is German (or otherwise EU-established with an equivalent obligation), add an Impressum page with the DDG §5 particulars and link it in the footer alongside the M2 privacy notice. If the brief is meant to remain strictly private and gated, that materially reduces the obligation — see M3.

---

## Informational

### I1 — No HTTP security headers configured on either host
No `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy` is set anywhere (no `vercel.json`; no `http-equiv` meta; `api/lead.js:39-45` sets only CORS). Because the page is fully self-contained (no third-party scripts, CDN, or analytics), the practical value of most of these is defense-in-depth only. Note that the one concrete concern an auditor might expect here — the confidential URL leaking via `Referer` to LinkedIn — is **already mitigated**: all three outbound links carry `rel="noreferrer"` (`index.html:480-482`), which suppresses the `Referer` header. **Fix:** on the Vercel host, add a `vercel.json` `headers` block (CSP with `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, plus HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Permissions-Policy`). The page uses inline styles/scripts, so a strict CSP requires `'unsafe-inline'` or a move to nonces/hashes. A static Porkbun origin can only get these via a fronting proxy.

### I2 — Operational identifiers and the lead mailbox are exposed (reconnaissance only, public by design)
Tracked files disclose the lead inbox (`info@vitabahn.com`), the SMTP provider (`smtp.porkbun.com:587`), and the Vercel function URL: `.env.example:5,11-12`, `README.md:55,85,102`, and the shipped page itself (`index.html:748` `mailto:`, `app.js:32` fallback text, `api/lead.js:18` default). None of these is a secret, and the mailbox is a public contact by design; the note matters only because these identify the exact target for the H1 mail-flood. No credential is exposed. **Fix:** none required for the identifiers themselves; the real control is the abuse mitigation in H1.

### I3 — The CORS allowlist is not an access control for the endpoint
`ALLOWED_ORIGIN`/`resolveOrigin`/`setCors` (`api/lead.js:32-45`) only computes response headers and fails closed to `allow[0]` for a disallowed origin — it never *rejects* a request based on `Origin`, and it never reflects an arbitrary origin (so it is not a CORS misconfiguration). It provides zero protection against non-browser clients. Classic CSRF is also not meaningful here, since there is no authenticated session or cookie to ride and the action only emails a lead. **Fix:** rely on H1's server-side controls for abuse prevention, and add a line to `README.md` clarifying that `ALLOWED_ORIGIN` governs browser response headers only.

### I4 — No explicit request body-size limit
Per-field length caps (`LIMITS`, `api/lead.js:24`) are applied only after the whole JSON body is parsed (`api/lead.js:54-63`); there is no application-level `sizeLimit`. On Vercel this is bounded by the platform's ~4.5 MB request cap, and the handler only reads flat scalar keys (no recursive walk), so the residual cost is a bounded, minor per-request parse. **Fix (optional):** set an explicit small `bodyParser.sizeLimit` (e.g. `16kb`) for defense-in-depth; matters mainly as an amplifier of H1.

### I5 — Hardcoded default recipient in source
`api/lead.js:18` defaults `LEAD_TO = 'info@vitabahn.com'`, and the config-presence guard (`api/lead.js:73-76`) validates `SMTP_USER`/`SMTP_PASS` but not the recipient wiring. A fork/redeploy that forgets to set `LEAD_TO` would silently email the baked-in VitaBahn address rather than failing closed. A misconfiguration footgun, not attacker-exploitable. **Fix (optional):** require `LEAD_TO` explicitly and fail closed if unset.

### I6 — Deployment topology is ambiguous and should be confirmed
As detailed in the scope section, `app.js:18`'s same-origin `/api/lead` (and commit `75c3654`) imply Vercel serves the page, while `README.md` still describes Porkbun as the production host. The two are inconsistent, and the difference determines whether the middleware gate (M3) and any future `vercel.json` headers (L1, I1) are even in the serving path — and, in the Porkbun-serves-the-page case, whether the form works at all. **Fix:** confirm the live origin, reconcile `README.md` with the actual deployment, and re-evaluate M3/L1/I1 against the confirmed host.

### Reviewed and found clean (no finding)
The following were specifically checked and are sound, recorded so the coverage is on the record:
- **No client-side XSS or DOM injection.** `app.js` writes only via `textContent` and `setAttribute` on fixed attributes; there is no `innerHTML`/`outerHTML`/`document.write`/`insertAdjacentHTML`/`eval`/`new Function`, and no reading of `location.hash`/`search`/`href`, `window.name`, or `document.cookie`. `index.html` has no inline event handlers and a single local `<script src="app.js">`. The independent client-injection auditor returned zero findings.
- **Email header injection is properly neutralized.** User-controlled values flow into the `From`-display, `Reply-To`, and `Subject` headers (`api/lead.js:105-108`), but `clean()` (`api/lead.js:30`) collapses all whitespace including CR/LF and caps length before use, removing the newline primitive required for header injection.
- **No committed secrets.** `.env` is gitignored (`.gitignore:11-13`); only `.env.example` templates with placeholders exist. A full `git log -p` history scan across all seven commits found no real password, key, or token — `SMTP_PASS` was the literal placeholder `your-mailbox-password` and `SITE_PASSWORD` was empty in every revision. The only historical datum was the mailbox address, which is public on the page anyway.
- **No third-party scripts, trackers, analytics, cookies, or storage**, and **no production source maps** (`*.map` absent). Supply-chain surface is limited to the single `nodemailer` dependency (M1). Outbound links use `rel="noopener noreferrer"` (no reverse tabnabbing / referrer leak).

---

## Prioritized remediation order

1. **H1 — Add anti-automation to `/api/lead`** (Turnstile/hCaptcha + per-IP rate limit + global daily send cap). This is the only trivially-exploitable issue and directly protects the business's lead channel and mail-domain reputation. Do this before go-live.
2. **M2 — Publish a privacy notice and wire informed consent**, naming the Vercel/Porkbun processors and the non-EU transfer safeguard, linked from the consent checkbox. Required for lawful processing the moment an EU investor uses the form.
3. **M3 — Decide and enforce the confidentiality posture.** Either serve the brief from a properly gated origin (enable `SITE_PASSWORD` on Vercel or front it with Cloudflare Access, and lock down the `*.vercel.app` mirror), or drop the "confidential / for addressed recipients only" labelling. Resolve I6 (deployment topology) as part of this step, since it determines what actually enforces the gate.
4. **M1 — Upgrade `nodemailer` to `>=9.0.3`**, regenerate the lockfile, confirm a clean `npm audit`, and smoke-test both SMTP transports.
5. **L1 / I1 — Add a `vercel.json` security-headers block** (frame-ancestors/X-Frame-Options first, then CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy); front Porkbun with a proxy if it remains a serving origin.
6. **L3 + L4 — Add a consent record store and (if the entity is German/EU) an Impressum**, alongside the M2 privacy work.
7. **L2, I3, I4, I5 — Hardening and hygiene** (constant-time/throttled Basic Auth, README CORS clarification, explicit body-size limit, required `LEAD_TO`) as time permits.

*Every Critical and High finding was re-verified against the source before finalizing. There are no Critical findings; the single High (H1) was independently confirmed to be a real, unauthenticated, unthrottled code path and is not a false positive.*
