// GET /investor-console (rewritten to /api/page-console). Admin-gated SHELL only —
// all data is fetched from /api/admin/* after this Level-0 check. Unauthenticated
// requests are redirected to the founder login.

import { sendHtml, redirect } from './_lib/http.js';
import { ensureSchema } from './_lib/store.js';
import { loadAdmin } from './_lib/auth.js';

const SHELL = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="#0B1013" />
<title>Investor Console | VitaBahn</title>
<link rel="stylesheet" href="/assets/fonts.css" />
<style>
:root{--paper:#F7F8F6;--paper-2:#EFF2F0;--surface:#FFF;--ink:#0B1013;--ink-2:#203038;--ink-3:#5B6870;--teal:#4FB3A3;--teal-dark:#267F73;--teal-soft:#DFF2EE;--gold:#CBA968;--gold-soft:#F4EBD8;--gold-ink:#6E5423;--red-soft:#FCEBEA;--red-ink:#A32D2D;--line:#DFE3E7;--line-2:#E9ECEE;--sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Arial,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.5;font-size:14px}
.railbar{height:3px;display:flex}.railbar span{display:block;height:100%}.railbar .a{flex:4;background:var(--teal)}.railbar .b{flex:3;background:#86B5A6}.railbar .c{flex:3;background:var(--gold)}
.wrap{width:min(1240px,calc(100% - 32px));margin:auto}
header{background:var(--surface);border-bottom:1px solid var(--line);padding:15px 0}
.head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px}.brand b{font-size:17px;font-weight:600}.brand small{display:block;color:var(--ink-3);font-size:12px}
.pill{font-family:var(--mono);font-size:10.5px;padding:5px 10px;border-radius:999px;background:var(--gold-soft);color:var(--gold-ink);border:1px solid rgba(203,169,104,.4)}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--ink-2);border-radius:9px;padding:8px 12px;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.btn:hover{border-color:#C9D0D4;background:var(--paper-2)}
.btn-teal{background:var(--teal-dark);border-color:var(--teal-dark);color:#fff}.btn-teal:hover{background:#1F6C62}
.btn-red{color:var(--red-ink);border-color:#E4B4B0}.btn-red:hover{background:var(--red-soft)}
main{padding:22px 0 70px}
h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:2px 0 2px}.sub{color:var(--ink-3);font-size:13px;margin:0 0 18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 26px -16px rgba(11,16,19,.18);padding:18px 20px;margin-bottom:18px}
.sec{font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--teal-dark);font-weight:600;display:flex;align-items:center;gap:10px;margin:0 0 14px}.sec::after{content:"";flex:1;height:1px;background:var(--line)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat .k{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.stat .v{font-size:26px;font-weight:600;margin-top:3px}.stat .v.due{color:var(--red-ink)}.stat .d{font-size:11.5px;color:var(--ink-3)}
.thermo{height:13px;border-radius:7px;background:var(--paper-2);overflow:hidden;display:flex;margin:6px 0 12px}.thermo i{height:100%}.thermo .tc{background:var(--teal-dark)}.thermo .ts{background:var(--gold)}
.legend{display:flex;gap:20px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-2)}.legend .sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}.sw.c{background:var(--teal-dark)}.sw.s{background:var(--gold)}.sw.r{background:var(--paper-2);border:1px solid var(--line)}.legv{font-family:var(--mono);font-weight:600}
table{width:100%;border-collapse:collapse}th{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);text-align:left;padding:11px 12px;border-bottom:1px solid var(--line)}
td{padding:11px 12px;border-bottom:1px solid var(--line-2);font-size:13px}tbody tr{cursor:pointer}tbody tr:hover{background:var(--paper-2)}tbody tr.sel{background:var(--teal-soft)}
.who b{font-weight:600}.who small{display:block;color:var(--ink-3);font-size:11.5px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}
.tag{font-family:var(--mono);font-size:10px;font-weight:600;padding:2px 7px;border-radius:5px}
.tag.due{background:var(--red-soft);color:var(--red-ink)}.tag.rev{background:#F0E9F5;color:#5B2A86}
.rail{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 14px}
.stop{flex:1;min-width:110px;border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:8px 10px;font-size:12px;cursor:pointer;text-align:center}
.stop.on{background:var(--teal-dark);border-color:var(--teal-dark);color:#fff;font-weight:600}
.stop.gate.on{background:var(--gold);border-color:var(--gold);color:#2c2410}
.tog{border:1px solid var(--line);background:var(--surface);color:var(--ink-3);border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;font-weight:500}
.tog.on{background:var(--teal-soft);border-color:#A9DBD0;color:var(--teal-dark)}.tog.gold.on{background:var(--gold-soft);border-color:rgba(203,169,104,.5);color:var(--gold-ink)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
label.fl{display:block;font-size:12px;color:var(--ink-3);margin:10px 0 5px}
input,select,textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:inherit;font-size:13px;background:var(--surface)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(79,179,163,.15)}textarea{min-height:80px;resize:vertical}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.timeline{list-style:none;margin:0;padding:0 0 0 16px;border-left:2px solid var(--line)}
.timeline li{position:relative;padding:0 0 12px 6px;font-size:12.5px}.timeline li b{font-weight:600}.timeline .ts{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.lib-row,.req-row,.log-row{display:grid;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line-2)}
.lib-row{grid-template-columns:1fr 90px 120px 70px 90px}.req-row{grid-template-columns:1fr 120px 130px 150px}.log-row{grid-template-columns:150px 1fr 1fr;font-size:12px}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:12px 18px;border-radius:10px;font-size:13.5px;box-shadow:0 10px 30px rgba(0,0,0,.25);display:none;z-index:50;max-width:90vw}
.mono{font-family:var(--mono)}.muted{color:var(--ink-3)}.right{text-align:right}
.search{max-width:280px;margin-bottom:12px}
</style>
</head>
<body>
<div class="railbar" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="c"></span></div>
<header><div class="wrap head">
  <div class="brand">
    <svg width="26" height="26" viewBox="0 0 34 34" aria-hidden="true"><rect x="7" y="16" width="4.6" height="12" rx="2.3" fill="#4FB3A3"/><circle cx="9.3" cy="16" r="2.7" fill="#4FB3A3"/><rect x="14.7" y="11" width="4.6" height="17" rx="2.3" fill="#86B5A6"/><circle cx="17" cy="11" r="2.7" fill="#86B5A6"/><rect x="22.4" y="6" width="4.6" height="22" rx="2.3" fill="#CBA968"/><circle cx="24.7" cy="6" r="2.7" fill="#CBA968"/></svg>
    <div><b>VitaBahn</b><small>Investor Console</small></div>
  </div>
  <div class="row"><span class="pill">Internal — founder / Level 0</span><button class="btn" id="logoutBtn">Sign out</button></div>
</div></header>
<main><div class="wrap">
  <h1>Investor access &amp; disclosure control</h1>
  <p class="sub">Assign per-user access, move investors along the disclosure pathway, and review engagement. Every change is logged.</p>
  <section class="card" id="cockpit"></section>
  <div class="stats" id="stats"></div>
  <section class="card"><div class="sec">Investor pipeline</div>
    <input class="search" id="search" type="search" placeholder="Search name or organisation…" autocomplete="off" />
    <div style="overflow-x:auto"><table><thead><tr><th>Investor</th><th>Level</th><th>NDA</th><th>Commitment</th><th>Score</th><th>Views</th><th>Last activity</th></tr></thead><tbody id="rows"></tbody></table></div>
  </section>
  <section class="card" id="detail"><div class="muted">Select an investor above to manage their access.</div></section>
  <section class="card" id="requests"></section>
  <section class="card" id="library"></section>
  <section class="card" id="logs"></section>
</div></main>
<div class="toast" id="toast"></div>
<script src="/assets/console.js"></script>
</body>
</html>`;

export default async function handler(req, res) {
  await ensureSchema();
  const { admin } = await loadAdmin(req);
  if (!admin) return redirect(res, '/founder-login');
  return sendHtml(res, 200, SHELL);
}
