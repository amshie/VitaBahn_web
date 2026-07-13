// GET /investor-room (rewritten to /api/page-room). Auth-gated SHELL only: no
// confidential data is embedded — the page fetches it from the authorised
// /api/room/overview endpoint, which returns ONLY what this investor is cleared to
// see. Unauthenticated / removed sessions are redirected to login, so even the
// room's markup is never served to the public. There is no "preview as level"
// switcher: an investor authenticates and sees exactly their own assigned level.

import { sendHtml, redirect } from './_lib/http.js';
import { ensureSchema } from './_lib/store.js';
import { loadInvestor } from './_lib/auth.js';

export function renderShell(preview) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bodyAttr = preview ? ` data-preview-investor="${esc(String(preview.id))}"` : '';
  const ribbon = preview
    ? `<div class="previewbar" role="status">Preview · viewing the data room as <b>${esc(preview.name)}</b> — read-only<a class="pv-back" href="/investor-console">Back to console →</a></div>`
    : '';
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="#0B1013" />
<title>Investor Data Room | VitaBahn</title>
<link rel="stylesheet" href="/assets/fonts.css" />
<style>
:root{
  --paper:#F5F6F4;--paper-2:#EEF1EF;--surface:#FFFFFF;
  --ink:#0B1013;--ink-2:#243138;--ink-3:#5B6870;--ink-4:#8A959B;
  --teal:#4FB3A3;--teal-dark:#267F73;--teal-soft:#DFF2EE;
  --gold:#CBA968;--gold-soft:#F4EBD8;--gold-ink:#6E5423;
  --line:#E0E4E5;--line-2:#ECEEEF;
  --shadow-sm:0 1px 2px rgba(11,16,19,.05);
  --shadow-md:0 22px 60px -26px rgba(11,16,19,.28),0 3px 10px rgba(11,16,19,.05);
  --sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
button{font:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.wrap{width:min(1200px,calc(100% - 40px));margin:auto}
.mono{font-family:var(--mono)}
.railbar{height:3px;display:flex}
.railbar span{display:block;height:100%}
.railbar .a{flex:4;background:var(--teal)}.railbar .b{flex:3;background:#86B5A6}.railbar .c{flex:3;background:var(--gold)}
header{padding:14px 0;border-bottom:1px solid var(--line);background:var(--surface)}
.head{display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand-left{display:flex;align-items:center;gap:11px;flex:0 0 auto}
.brand-name{font-size:17px;font-weight:600;line-height:1.05}
.brand-note{font-size:11.5px;color:var(--ink-3)}
.topsearch{position:relative;flex:1;max-width:360px}
.topsearch input{width:100%;border:1px solid var(--line);background:var(--paper);border-radius:9px;padding:9px 12px 9px 33px;font:inherit;font-size:13px;outline:none}
.topsearch input:focus{border-color:var(--teal);background:var(--surface);box-shadow:0 0 0 3px rgba(79,179,163,.14)}
.topsearch svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);opacity:.5}
.head-right{display:flex;align-items:center;gap:12px;flex:0 0 auto}
.userchip{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink-2)}
.avatar{width:30px;height:30px;border-radius:50%;background:var(--teal-soft);color:var(--teal-dark);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;font-family:var(--mono)}
.logout{border:1px solid var(--line);background:var(--surface);color:var(--ink-3);border-radius:8px;padding:7px 12px;font-size:12.5px}
.logout:hover{border-color:#C9D0D4;background:var(--paper-2)}
main{padding:26px 0 40px}
.app{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-md);overflow:hidden;display:grid;grid-template-columns:256px 1fr;min-height:600px}
.side{background:var(--paper-2);border-right:1px solid var(--line);display:flex;flex-direction:column}
.access{padding:18px 18px 16px;border-bottom:1px solid var(--line)}
.access .ttl{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:11px}
.badge{font-family:var(--mono);font-size:11.5px;font-weight:600;padding:6px 11px;border-radius:999px;display:inline-flex;align-items:center;gap:7px;margin-bottom:14px}
.badge .bd{width:8px;height:8px;border-radius:50%}
.arow{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:4px 0}
.arow .k{color:var(--ink-3)}
.arow .v{font-family:var(--mono);color:var(--ink-2);font-weight:500;text-align:right}
.arow .v.ok{color:var(--teal-dark)}
.arow .v.warn{color:var(--gold-ink)}
.navwrap{padding:12px 10px;flex:1}
.navlabel{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-4);padding:8px 10px 6px}
.nav{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.nav button{width:100%;display:flex;align-items:center;gap:10px;border:0;background:none;text-align:left;padding:9px 10px;border-radius:9px;font-size:13.5px;color:var(--ink-2);position:relative}
.nav button:hover{background:#E5E9E7}
.nav button.on{background:var(--surface);box-shadow:inset 2px 0 0 var(--teal-dark);color:var(--ink);font-weight:600}
.nav .nl{flex:0 0 auto;font-family:var(--mono);font-size:10.5px;color:var(--ink-4);width:20px}
.nav .nt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav .nmeta{flex:0 0 auto;font-family:var(--mono);font-size:10.5px;color:var(--ink-4)}
.nav button.locked{color:var(--ink-4)}
.nav button.locked:hover{background:#E9ECEA}
.lockt{flex:0 0 auto;font-family:var(--mono);font-size:9px;letter-spacing:.04em;padding:2px 6px;border-radius:5px;text-transform:uppercase}
.lockt.nda{background:var(--gold-soft);color:var(--gold-ink)}
.lockt.appr{background:#E4E8EA;color:var(--ink-3)}
.side-foot{padding:14px 18px;border-top:1px solid var(--line);font-family:var(--mono);font-size:10.5px;color:var(--ink-4);display:flex;align-items:center;gap:8px}
.content{padding:24px 28px 28px;display:flex;flex-direction:column;min-width:0}
.crumb{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-bottom:7px}
.crumb b{color:var(--ink-2);font-weight:600}
.ch{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:4px}
.ch h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0}
.ch .cn{color:var(--ink-3);font-size:13px;margin-top:3px}
.tiertag{font-family:var(--mono);font-size:10px;letter-spacing:.05em;padding:4px 9px;border-radius:6px;text-transform:uppercase;white-space:nowrap}
.tiertag.open{background:var(--teal-soft);color:var(--teal-dark)}
.tiertag.nda{background:var(--gold-soft);color:var(--gold-ink)}
.banner{display:flex;align-items:center;gap:10px;margin:16px 0 6px;padding:11px 14px;border-radius:10px;background:var(--paper-2);border:1px solid var(--line);font-size:12.5px;color:var(--ink-2)}
.banner svg{flex:0 0 auto;opacity:.7}
.banner b{font-weight:600}
.banner.pub{background:var(--teal-soft);border-color:#A9DBD0;color:#1E5B52}
.tablewrap{margin-top:16px}
.dhead,.drow{display:grid;grid-template-columns:minmax(0,1fr) 74px 118px 104px 104px;gap:14px;align-items:center}
.dhead{padding:0 4px 9px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);border-bottom:1px solid var(--line)}
.drow{padding:13px 4px;border-bottom:1px solid var(--line-2)}
.drow:hover{background:var(--paper)}
.dname{display:flex;align-items:center;gap:12px;min-width:0}
.ficon{width:36px;height:40px;flex:0 0 auto;position:relative}
.dmeta{min-width:0}
.dt{font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsub{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-top:1px}
.c-pages,.c-upd{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.c-status{display:flex;align-items:center;gap:7px;font-size:12px}
.sdot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.snew{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.03em;color:var(--teal-dark);background:var(--teal-soft);padding:2px 7px;border-radius:5px}
.c-act{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.open{border:1px solid var(--line);background:var(--surface);color:var(--teal-dark);border-radius:8px;padding:7px 13px;font-size:12.5px;font-weight:600;transition:.15s}
.open:hover{background:var(--teal-soft);border-color:#A9DBD0}
.open:disabled{opacity:.6;cursor:default}
.dl{width:32px;height:32px;border:1px solid var(--line);background:var(--surface);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--ink-3);transition:.15s}
.dl:hover{border-color:#C9D0D4;color:var(--ink-2);background:var(--paper-2)}
.dl.off{color:var(--ink-4);cursor:not-allowed;opacity:.7}
.ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 6px}
.ov-card{border:1px solid var(--line);border-radius:12px;padding:15px 16px;background:var(--paper)}
.ov-card .k{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.ov-card .v{font-size:22px;font-weight:600;margin-top:4px;letter-spacing:-.01em}
.ov-card .v.sm{font-size:15px}
.subhead{font-family:var(--mono);font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--teal-dark);font-weight:600;display:flex;align-items:center;gap:10px;margin:24px 0 10px}
.subhead::after{content:"";flex:1;height:1px;background:var(--line)}
.gate{border-radius:14px;padding:22px 24px;margin-top:18px;border:1px solid var(--line);max-width:640px}
.gate.nda{background:var(--gold-soft);border-color:rgba(203,169,104,.5)}
.gate.named{background:var(--paper-2)}
.gate.verify{background:var(--teal-soft);border-color:#A9DBD0}
.gate-h{display:flex;align-items:center;gap:12px;margin-bottom:9px}
.gate-ic{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.gate.nda .gate-ic{background:rgba(203,169,104,.28);color:var(--gold-ink)}
.gate.named .gate-ic{background:#E2E7E9;color:var(--ink-2)}
.gate.verify .gate-ic{background:rgba(79,179,163,.24);color:var(--teal-dark)}
.gate h2{font-size:16px;font-weight:600;margin:0}
.gate p{margin:0 0 16px;font-size:13.5px;color:var(--ink-2);line-height:1.55}
.gate.nda h2,.gate.nda p{color:var(--gold-ink)}
.gate-cta{border:0;border-radius:9px;padding:10px 17px;font-size:13px;font-weight:600}
.gate.nda .gate-cta{background:var(--gold-ink);color:#fff}
.gate.named .gate-cta{background:var(--ink);color:#fff}
.gate.verify .gate-cta{background:var(--teal-dark);color:#fff}
.gate-cta:disabled{opacity:.5;cursor:default}
.gate-note{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-top:11px}
.nda-panel{display:flex;flex-direction:column;gap:11px;margin:2px 0 2px}
.nda-step{display:flex;align-items:center;gap:11px;font-size:13.5px;color:var(--gold-ink);flex-wrap:wrap}
.nda-num{flex:0 0 auto;width:21px;height:21px;border-radius:50%;background:var(--gold-ink);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;font-family:var(--mono)}
.nda-txt{flex:1;min-width:150px}
.nda-hint{font-size:12.5px;color:var(--gold-ink)}
.nda-btn{border:1px solid var(--gold-ink);background:var(--surface);color:var(--gold-ink);border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.nda-btn.primary{background:var(--gold-ink);color:#fff}
.nda-btn:hover{filter:brightness(1.05)}
.nda-status{font-size:13px;padding:10px 13px;border-radius:9px;line-height:1.5}
.nda-status.ok{background:rgba(79,179,163,.16);color:var(--teal-dark);border:1px solid #A9DBD0}
.nda-status.warn{background:#FCEBEA;color:#A32D2D;border:1px solid #F1C9C6}
.noresults{color:var(--ink-3);font-size:13px;padding:22px 4px}
.conf{margin-top:auto;padding-top:20px;border-top:1px solid var(--line-2);font-family:var(--mono);font-size:11px;color:var(--ink-4);line-height:1.6}
#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(14px);background:var(--ink);color:#EAF0F1;padding:12px 18px;border-radius:11px;font-size:13px;max-width:540px;width:calc(100% - 40px);box-shadow:0 12px 40px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:50;line-height:1.45}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:820px){
  .app{grid-template-columns:1fr}
  .side{border-right:0;border-bottom:1px solid var(--line);flex-direction:column}
  .navwrap{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px}
  .navlabel{grid-column:1/-1}
  .topsearch{display:none}
}
@media(max-width:640px){
  .wrap{width:calc(100% - 24px)}
  .dhead{display:none}
  .drow{grid-template-columns:1fr auto;row-gap:2px}
  .c-pages,.c-upd,.c-status{display:none}
  .navwrap{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
.previewbar{position:sticky;top:0;z-index:60;display:flex;align-items:center;gap:6px;justify-content:center;flex-wrap:wrap;background:#0B1013;color:#EAF0F1;font-size:12.5px;padding:9px 16px;border-bottom:2px solid var(--gold)}
.previewbar b{color:#fff;font-weight:600}
.previewbar .pv-back{color:var(--gold);text-decoration:none;font-weight:600;margin-left:8px}
.previewbar .pv-back:hover{text-decoration:underline}
</style>
</head>
<body${bodyAttr}>
${ribbon}<div class="railbar" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="c"></span></div>
<header>
  <div class="wrap head">
    <div class="brand-left">
      <svg width="24" height="30" viewBox="0 0 123 152" aria-hidden="true"><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="4"><path d="M38 34 V86 C38 98 46 100 46 111 C46 127 29 129 22 139 H14" stroke="#0D4D47"/><path d="M44 122 C40.5 126 38 130 37.5 136" stroke="#0D4D47" stroke-width="3.2"/><path d="M61.5 28 V140" stroke="#6D948C"/><path d="M85 34 V86 C85 98 77 100 77 111 C77 127 94 129 101 139 H109" stroke="#C8A86E"/><path d="M79 122 C82.5 126 85 130 85.5 136" stroke="#C8A86E" stroke-width="3.2"/></g><path d="M56 140 L67 140 L65 143.6 L58 143.6 Z" fill="#6D948C"/><circle cx="38" cy="26" r="7" fill="#0D4D47"/><circle cx="61.5" cy="20" r="7" fill="#6D948C"/><circle cx="85" cy="26" r="7" fill="#C8A86E"/><circle cx="50" cy="71" r="2.2" fill="#0D4D47"/><circle cx="50.4" cy="81" r="2.2" fill="#0D4D47"/><circle cx="50.8" cy="91" r="2.2" fill="#0D4D47"/><circle cx="51.2" cy="101" r="2.2" fill="#0D4D47"/><circle cx="51.6" cy="111" r="2.2" fill="#0D4D47"/><circle cx="33" cy="92" r="2.2" fill="#0D4D47"/><circle cx="33.6" cy="101" r="2.2" fill="#0D4D47"/><circle cx="34.2" cy="110" r="2.2" fill="#0D4D47"/><circle cx="34.8" cy="119" r="2.2" fill="#0D4D47"/><circle cx="73" cy="71" r="2.2" fill="#C8A86E"/><circle cx="72.6" cy="81" r="2.2" fill="#C8A86E"/><circle cx="72.2" cy="91" r="2.2" fill="#C8A86E"/><circle cx="71.8" cy="101" r="2.2" fill="#C8A86E"/><circle cx="71.4" cy="111" r="2.2" fill="#C8A86E"/><circle cx="90" cy="92" r="2.2" fill="#C8A86E"/><circle cx="89.4" cy="101" r="2.2" fill="#C8A86E"/><circle cx="88.8" cy="110" r="2.2" fill="#C8A86E"/><circle cx="88.2" cy="119" r="2.2" fill="#C8A86E"/></svg>
      <div>
        <div class="brand-name">VitaBahn</div>
        <div class="brand-note">Investor Data Room</div>
      </div>
    </div>
    <div class="topsearch">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6870" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="search" type="search" placeholder="Search documents in this section…" autocomplete="off" />
    </div>
    <div class="head-right">
      <span class="userchip"><span class="avatar" id="avatar">··</span> <span id="whoami">Loading…</span></span>
      <button class="logout" id="logoutBtn">Sign out</button>
    </div>
  </div>
</header>
<main>
  <div class="wrap">
    <div class="app">
      <aside class="side">
        <div class="access" id="access"></div>
        <div class="navwrap">
          <div class="navlabel">Data room</div>
          <ul class="nav" id="nav"></ul>
        </div>
        <div class="side-foot">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          Confidential · access logged
        </div>
      </aside>
      <section class="content" id="content"></section>
    </div>
  </div>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script src="/assets/room.js"></script>
</body>
</html>`;
}

export default async function handler(req, res) {
  await ensureSchema();
  const { investor } = await loadInvestor(req);
  if (!investor) return redirect(res, '/investor-login');
  return sendHtml(res, 200, renderShell(null));
}
