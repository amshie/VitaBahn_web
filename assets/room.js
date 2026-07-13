// Investor data-room client. Holds no secrets and enforces nothing: every call
// hits an authorised /api/room/* endpoint that re-checks the session, level and NDA
// server-side and returns ONLY what this investor may see. The page is rendered
// from /api/room/overview — sections above the investor's grant arrive as gates or
// locked panels with no document names. All dynamic values are written as text
// nodes (never innerHTML), so a document title can never inject markup; the only
// innerHTML used is for constant, in-file SVG icons.
(function () {
  'use strict';

  // Presentation-only colour map per level (badge tint). Not authoritative.
  var LEVELS = {
    1: { color: '#9AA6AC', soft: '#EEF1F2' },
    2: { color: '#4FB3A3', soft: '#DFF2EE' },
    3: { color: '#CBA968', soft: '#F4EBD8' },
    4: { color: '#267F73', soft: '#DDEDE9' },
    5: { color: '#0B1013', soft: '#E5E7E8' }
  };

  // Constant SVG icons — no user data ever flows into these strings.
  var ICONS = {
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
    dl: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    lock: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
    person: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>'
  };

  var state = { data: null, active: 'overview', search: '' };

  function $(id) { return document.getElementById(id); }
  function toLogin() { window.location.href = '/investor-login'; }

  // Minimal safe hyperscript. String children become text nodes. `attrs.on<evt>`
  // adds a listener. No innerHTML path — icons use setIcon() with constant strings.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      append(el, c);
    }
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function setIcon(el, name) { el.innerHTML = ICONS[name] || ''; return el; }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, 3800);
  }

  function ftColor(ft) { return ft === 'XLSX' ? '#3E8E6E' : ft === 'THREAD' ? '#4FB3A3' : ft === 'DOC' ? '#2E5E9E' : '#B4453B'; }

  function ficon(color) {
    var span = document.createElement('span');
    // Constant structure; `color` is drawn from a fixed palette above.
    span.innerHTML = '<svg class="ficon" viewBox="0 0 36 40" aria-hidden="true"><path d="M6 1h17l9 9v27a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="#fff" stroke="#D6DBDC" stroke-width="1.4"/><path d="M23 1l9 9h-7a2 2 0 0 1-2-2V1z" fill="#EDF0F0"/><rect x="4" y="26" width="28" height="9" rx="2" fill="' + color + '"/></svg>';
    return span.firstChild;
  }

  // ---- data helpers -------------------------------------------------------
  function investor() { return state.data.investor; }
  function access() { return state.data.access; }
  function sections() { return state.data.sections; }
  function sectionAt(level) { return sections().find(function (s) { return s.level === level; }); }
  function unlockedSections() { return sections().filter(function (s) { return s.state === 'unlocked'; }); }

  // ---- open / download / request -----------------------------------------
  async function openDoc(id, btn) {
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      var r = await fetch('/api/room/document?id=' + encodeURIComponent(id), { credentials: 'same-origin' });
      if (!r.ok) {
        if (r.status === 401) return toLogin();
        var j = await r.json().catch(function () { return {}; });
        toast(j.error || 'This document is not available.');
        return;
      }
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) {
      toast('Could not open the document.');
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  function downloadDoc(id) {
    var a = document.createElement('a');
    a.href = '/api/room/document?id=' + encodeURIComponent(id) + '&dl=1';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function requestAccess(level, btn) {
    if (btn) btn.disabled = true;
    try {
      await fetch('/api/room/request-access', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: level })
      });
    } catch (e) { /* best-effort; the confirmation below is what the user needs */ }
    toast('Request noted — the VitaBahn team has been notified. Access is granted manually, per person.');
  }

  // ---- rendering ----------------------------------------------------------
  function renderHeader() {
    var inv = investor();
    $('avatar').textContent = inv.initials || '··';
    $('whoami').textContent = [inv.name, inv.org].filter(Boolean).join(' · ');
  }

  function renderAccess() {
    var a = access();
    var L = LEVELS[a.level] || LEVELS[1];
    var ndaClass = a.ndaSigned ? 'ok' : (a.level >= 2 ? 'warn' : '');
    var box = $('access');
    box.textContent = '';
    append(box, [
      h('div', { class: 'ttl' }, 'Your access'),
      h('span', { class: 'badge', style: 'background:' + L.soft + ';color:' + L.color },
        h('span', { class: 'bd', style: 'background:' + L.color }), a.levelName + ' · Level ' + a.level),
      h('div', { class: 'arow' }, h('span', { class: 'k' }, 'NDA status'), h('span', { class: 'v ' + ndaClass }, a.ndaStatus)),
      h('div', { class: 'arow' }, h('span', { class: 'k' }, 'Access valid'), h('span', { class: 'v' }, a.validUntil || '—')),
      h('div', { class: 'arow' }, h('span', { class: 'k' }, 'Documents'), h('span', { class: 'v' }, a.docCount + ' available'))
    ]);
  }

  function navTag(sec) {
    if (sec.state === 'gate' && sec.gate && sec.gate.tag === 'nda') return h('span', { class: 'lockt nda' }, 'NDA');
    if (sec.state === 'gate' && sec.gate && sec.gate.tag === 'appr') return h('span', { class: 'lockt appr' }, 'Approval');
    return h('span', { class: 'lockt appr' }, 'Locked');
  }

  function renderNav() {
    var nav = $('nav');
    nav.textContent = '';
    nav.appendChild(h('button', { class: state.active === 'overview' ? 'on' : '', onclick: function () { setActive('overview'); } },
      h('span', { class: 'nl' }, '—'), h('span', { class: 'nt' }, 'Overview')));
    sections().forEach(function (sec) {
      var on = String(state.active) === String(sec.level) ? ' on' : '';
      if (sec.state === 'unlocked') {
        nav.appendChild(h('button', { class: on.trim(), onclick: navClick(sec.level) },
          h('span', { class: 'nl' }, 'L' + sec.level), h('span', { class: 'nt' }, sec.title),
          h('span', { class: 'nmeta' }, String(sec.docs.length))));
      } else {
        nav.appendChild(h('button', { class: ('locked' + on), onclick: navClick(sec.level) },
          h('span', { class: 'nl' }, 'L' + sec.level), h('span', { class: 'nt' }, sec.title), navTag(sec)));
      }
    });
  }
  function navClick(level) { return function () { setActive(level); }; }

  function banner() {
    if (access().level === 1) {
      return h('div', { class: 'banner pub' }, setIcon(h('span'), 'clock'),
        h('span', {}, 'First-contact materials · public overview · no confidential documents at this level.'));
    }
    var valid = access().validUntil;
    return h('div', { class: 'banner' }, setIcon(h('span'), 'clock'),
      h('span', {}, valid ? h('b', {}, 'Access valid until ' + valid) : h('b', {}, 'Access is time-limited'),
        ' · view-only, watermarked · revocable at any time · every open is logged.'));
  }

  function conf() {
    var inv = investor();
    var who = [inv.name, inv.org].filter(Boolean).join(', ');
    return h('div', { class: 'conf' }, 'Confidential — prepared for ' + who + '. Documents are watermarked and view-only; access is logged and may be revoked.');
  }

  function statusCell(status) {
    if (status === 'new') return h('span', { class: 'c-status' }, h('span', { class: 'snew' }, 'New'));
    if (status === 'viewed') return h('span', { class: 'c-status' }, h('span', { class: 'sdot', style: 'background:#C7CDD0' }), 'Viewed');
    return h('span', { class: 'c-status' }, h('span', { class: 'sdot', style: 'background:var(--teal)' }), 'Not viewed');
  }

  function docRow(d) {
    var openBtn = h('button', { class: 'open' }, 'Open');
    openBtn.addEventListener('click', function () { openDoc(d.id, openBtn); });

    var dlBtn = setIcon(h('button', {
      class: 'dl' + (d.downloadable ? '' : ' off'),
      title: d.downloadable ? 'Download' : 'Download restricted — view-only',
      'aria-label': 'Download'
    }), 'dl');
    dlBtn.addEventListener('click', function () {
      if (d.downloadable) downloadDoc(d.id);
      else toast('Download is restricted for “' + d.name + '” — this document is view-only at its tier.');
    });

    return h('div', { class: 'drow' },
      h('div', { class: 'dname' }, ficon(ftColor(d.ft)),
        h('div', { class: 'dmeta' }, h('div', { class: 'dt' }, d.name), h('div', { class: 'dsub' }, d.ft + ' · ' + d.pages))),
      h('div', { class: 'c-pages' }, d.pages),
      h('div', { class: 'c-upd' }, d.updated),
      statusCell(d.status),
      h('div', { class: 'c-act' }, openBtn, dlBtn)
    );
  }

  function docTable(list) {
    if (!list.length) {
      return h('div', { class: 'noresults' }, state.search ? 'No documents match “' + state.search + '”.' : 'No documents here yet.');
    }
    var wrap = h('div', { class: 'tablewrap' },
      h('div', { class: 'dhead' }, h('span', {}, 'Document'), h('span', {}, 'Size'), h('span', {}, 'Updated'), h('span', {}, 'Status'), h('span', {})));
    list.forEach(function (d) { wrap.appendChild(docRow(d)); });
    return wrap;
  }

  function overviewView() {
    var a = access();
    var inv = investor();
    var L = LEVELS[a.level] || LEVELS[1];
    var first = (inv.name || '').split(/\s+/)[0] || inv.name || 'there';
    var newDocs = [];
    unlockedSections().forEach(function (s) { s.docs.forEach(function (d) { if (d.status === 'new') newDocs.push(d); }); });
    return [
      h('div', { class: 'crumb' }, 'Data room / ', h('b', {}, 'Overview')),
      h('div', { class: 'ch' }, h('div', {}, h('h1', {}, 'Welcome, ' + first),
        h('div', { class: 'cn' }, 'VitaBahn is raising a €3.0M pre-seed round. Materials are released progressively; you are viewing the level assigned to your account.'))),
      banner(),
      h('div', { class: 'ov-grid' },
        h('div', { class: 'ov-card' }, h('div', { class: 'k' }, 'Access level'), h('div', { class: 'v sm', style: 'color:' + L.color }, a.levelName + ' · L' + a.level)),
        h('div', { class: 'ov-card' }, h('div', { class: 'k' }, 'Documents'), h('div', { class: 'v' }, String(a.docCount))),
        h('div', { class: 'ov-card' }, h('div', { class: 'k' }, 'NDA status'), h('div', { class: 'v sm' }, a.ndaStatus)),
        h('div', { class: 'ov-card' }, h('div', { class: 'k' }, 'Valid until'), h('div', { class: 'v sm' }, a.validUntil || '—'))),
      h('div', { class: 'subhead' }, 'Recently updated'),
      newDocs.length ? docTable(newDocs) : h('div', { class: 'noresults' }, 'No recent updates at your level.'),
      conf()
    ];
  }

  function sectionView(sec) {
    var q = state.search.trim().toLowerCase();
    var list = q ? sec.docs.filter(function (d) { return d.name.toLowerCase().indexOf(q) >= 0; }) : sec.docs;
    var n = sec.docs.length;
    return [
      h('div', { class: 'crumb' }, 'Data room / ', h('b', {}, sec.title)),
      h('div', { class: 'ch' },
        h('div', {}, h('h1', {}, sec.title), h('div', { class: 'cn' }, 'Level ' + sec.level + ' · ' + n + ' document' + (n === 1 ? '' : 's') + ' · view-only, watermarked.')),
        h('span', { class: 'tiertag ' + sec.tier }, sec.tier === 'nda' ? 'NDA tier' : 'Open tier')),
      banner(),
      docTable(list),
      conf()
    ];
  }

  function gateView(sec) {
    var g = sec.gate;
    if (!g) return [h('div', { class: 'noresults' }, 'Nothing to show.')];
    var iconName = g.kind === 'nda' ? 'lock' : g.kind === 'verify' ? 'check' : 'person';
    var cta = h('button', { class: 'gate-cta' }, g.cta);
    if (g.disabled) cta.disabled = true;
    else cta.addEventListener('click', function () { requestAccess(sec.level, cta); });
    return [
      h('div', { class: 'crumb' }, 'Data room / ', h('b', {}, sec.title)),
      h('div', { class: 'ch' }, h('div', {}, h('h1', {}, sec.title), h('div', { class: 'cn' }, 'Level ' + sec.level + ' · access not yet granted.'))),
      h('div', { class: 'gate ' + g.kind },
        h('div', { class: 'gate-h' }, setIcon(h('div', { class: 'gate-ic' }), iconName), h('h2', {}, g.title)),
        h('p', {}, g.body),
        cta,
        h('div', { class: 'gate-note' }, g.note)),
      conf()
    ];
  }

  function lockedView(sec) {
    return [
      h('div', { class: 'crumb' }, 'Data room / ', h('b', {}, sec.title)),
      h('div', { class: 'ch' }, h('div', {}, h('h1', {}, sec.title), h('div', { class: 'cn' }, 'Level ' + sec.level + ' · unlocks at a later stage.'))),
      h('div', { class: 'gate named' },
        h('div', { class: 'gate-h' }, setIcon(h('div', { class: 'gate-ic' }), 'lock'), h('h2', {}, 'Not yet available')),
        h('p', {}, 'These materials are released according to qualification, NDA status and named approval as diligence progresses. They will appear here once your access level reaches Level ' + sec.level + '.'),
        h('div', { class: 'gate-note' }, 'Access is assigned manually by the VitaBahn team.')),
      conf()
    ];
  }

  function renderContent() {
    var c = $('content');
    c.textContent = '';
    var nodes;
    if (state.active === 'overview') {
      nodes = overviewView();
    } else {
      var sec = sectionAt(Number(state.active));
      if (!sec) nodes = [h('div', { class: 'noresults' }, 'Nothing to show.')];
      else if (sec.state === 'unlocked') nodes = sectionView(sec);
      else if (sec.state === 'gate') nodes = gateView(sec);
      else nodes = lockedView(sec);
    }
    append(c, nodes);
  }

  function render() { renderHeader(); renderAccess(); renderNav(); renderContent(); }

  function setActive(sec) {
    state.active = sec;
    state.search = '';
    var s = $('search'); if (s) s.value = '';
    render();
  }

  // ---- wiring -------------------------------------------------------------
  $('search').addEventListener('input', function (e) {
    state.search = e.target.value;
    var sec = state.active !== 'overview' && sectionAt(Number(state.active));
    if (sec && sec.state === 'unlocked') renderContent();
  });

  $('logoutBtn').addEventListener('click', async function () {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { /* fall through to redirect */ }
    toLogin();
  });

  async function load() {
    var r;
    try { r = await fetch('/api/room/overview', { credentials: 'same-origin' }); }
    catch (e) { return toast('Could not reach the data room. Please retry.'); }
    if (r.status === 401) return toLogin();
    var j = await r.json().catch(function () { return null; });
    if (!j || !j.ok) return toLogin();
    state.data = j;
    render();
  }

  load();
})();
