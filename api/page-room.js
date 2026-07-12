// GET /investor-room (rewritten to /api/page-room). Auth-gated SHELL only: no
// confidential data is embedded — the page fetches it from the authorised
// /api/room/* endpoints. Unauthenticated / removed sessions are redirected to
// login, so even the room's markup is never served to the public.

import { sendHtml, redirect } from './_lib/http.js';
import { ensureSchema } from './_lib/store.js';
import { loadInvestor } from './_lib/auth.js';

const SHELL = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="#0B1013" />
<title>Investor Data Room | VitaBahn</title>
<link rel="stylesheet" href="/assets/fonts.css" />
<style>
:root{--paper:#F7F8F6;--paper-2:#EFF2F0;--surface:#FFF;--ink:#0B1013;--ink-2:#203038;--ink-3:#5B6870;--teal:#4FB3A3;--teal-dark:#267F73;--teal-soft:#DFF2EE;--gold:#CBA968;--gold-soft:#F4EBD8;--gold-ink:#6E5423;--line:#DFE3E7;--red-soft:#FCEBEA;--red-ink:#A32D2D;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Arial,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55}
.railbar{height:3px;display:flex}.railbar span{display:block;height:100%}.railbar .a{flex:4;background:var(--teal)}.railbar .b{flex:3;background:#86B5A6}.railbar .c{flex:3;background:var(--gold)}
.wrap{width:min(980px,calc(100% - 32px));margin:auto}
header{background:var(--surface);border-bottom:1px solid var(--line);padding:16px 0}
.head{display:flex;align-items:center;justify-content:space-between;gap:14px}
.brand{display:flex;align-items:center;gap:11px}.brand b{font-size:17px;font-weight:600}.brand small{display:block;color:var(--ink-3);font-size:12px}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--ink-2);border-radius:9px;padding:8px 13px;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.btn:hover{border-color:#C9D0D4;background:var(--paper-2)}
main{padding:26px 0 70px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 14px 40px -18px rgba(11,16,19,.18),0 2px 6px rgba(11,16,19,.04);margin-bottom:20px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--teal-dark);font-weight:600}
h1{font-size:24px;letter-spacing:-.02em;margin:6px 0 4px;font-weight:600}
.grant{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.chip{font-family:var(--mono);font-size:12px;padding:6px 11px;border-radius:999px;background:var(--teal-soft);color:var(--teal-dark);border:1px solid #A9DBD0}
.chip.gold{background:var(--gold-soft);color:var(--gold-ink);border-color:rgba(203,169,104,.45)}
.chip.warn{background:var(--red-soft);color:var(--red-ink);border-color:#F1C9C6}
.docs{list-style:none;margin:0;padding:0}
.doc{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0;border-bottom:1px solid var(--line)}
.doc:last-child{border-bottom:0}.doc .n{font-weight:500;display:flex;align-items:center;gap:9px}
.tier{font-family:var(--mono);font-size:9.5px;letter-spacing:.05em;padding:2px 7px;border-radius:5px;text-transform:uppercase}
.tier.t1{background:var(--teal-soft);color:var(--teal-dark)}.tier.t2{background:var(--gold-soft);color:var(--gold-ink)}
.doc small{color:var(--ink-3);font-size:12px;font-family:var(--mono)}
.muted{color:var(--ink-3)}.none{color:var(--ink-3);padding:16px 0}
.sec{font-family:var(--mono);font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--teal-dark);font-weight:600;margin:0 0 12px;display:flex;align-items:center;gap:10px}.sec::after{content:"";flex:1;height:1px;background:var(--line)}
.note{margin-top:18px;color:var(--ink-3);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
footer{border-top:1px solid var(--line);background:var(--surface);color:var(--ink-3);font-size:12px;padding:20px 0}
</style>
</head>
<body>
<div class="railbar" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="c"></span></div>
<header><div class="wrap head">
  <div class="brand">
    <svg width="28" height="28" viewBox="0 0 34 34" aria-hidden="true"><rect x="7" y="16" width="4.6" height="12" rx="2.3" fill="#4FB3A3"/><circle cx="9.3" cy="16" r="2.7" fill="#4FB3A3"/><rect x="14.7" y="11" width="4.6" height="17" rx="2.3" fill="#86B5A6"/><circle cx="17" cy="11" r="2.7" fill="#86B5A6"/><rect x="22.4" y="6" width="4.6" height="22" rx="2.3" fill="#CBA968"/><circle cx="24.7" cy="6" r="2.7" fill="#CBA968"/></svg>
    <div><b>VitaBahn</b><small>Investor Data Room</small></div>
  </div>
  <button class="btn" id="logoutBtn">Sign out</button>
</div></header>
<main><div class="wrap">
  <section class="card" id="grantCard">
    <div class="eyebrow">Your access</div>
    <h1 id="who">Loading…</h1>
    <div class="muted" id="orgline"></div>
    <div class="grant" id="grant"></div>
  </section>
  <section class="card">
    <div class="sec">Available documents</div>
    <ul class="docs" id="docs"><li class="none">Loading documents…</li></ul>
    <div class="note">Documents are released progressively by access level and NDA status. Every access is logged. Materials are confidential and for the named recipient only — no redistribution.</div>
  </section>
</div></main>
<footer><div class="wrap">© 2026 VitaBahn · Confidential investor materials · access is monitored and revocable.</div></footer>
<script src="/assets/room.js"></script>
</body>
</html>`;

export default async function handler(req, res) {
  await ensureSchema();
  const { investor } = await loadInvestor(req);
  if (!investor) return redirect(res, '/investor-login');
  return sendHtml(res, 200, SHELL);
}
