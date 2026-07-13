// Founder console client. No enforcement here — every call hits an admin-gated
// /api/admin/* endpoint. All investor-supplied strings are escaped before display.
(function () {
  'use strict';
  var ROUND_TARGET = 3000000;
  var LEVELS = { 1: 'Public / First Contact', 2: 'Interested Investor', 3: 'Qualified / NDA', 4: 'Lead / Anchor', 5: 'Signing / Closing' };
  var LEVEL_DOT = { 1: '#9AA6AC', 2: '#4FB3A3', 3: '#CBA968', 4: '#267F73', 5: '#0B1013' };
  var COMMIT_COLOR = { none: '#9AA6AC', soft: '#CBA968', committed: '#267F73' };

  var state = { investors: [], requests: [], documents: [], logs: [], selectedId: null, search: '' };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(function () { t.style.display = 'none'; }, 4200); }
  function fmtMoney(n) { n = n || 0; if (n >= 1e6) return '€' + (n / 1e6).toFixed(n % 1e6 ? 2 : 1).replace(/\.0$/, '') + 'M'; if (n >= 1e3) return '€' + Math.round(n / 1e3) + 'k'; return '€' + n; }
  function fmtSize(b) { if (!b) return '—'; if (b < 1024) return b + ' B'; if (b < 1048576) return Math.round(b / 1024) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function fmtDate(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function daysSince(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 999; }
  function isDue(day) { if (!day) return false; var t = new Date(); t.setHours(23, 59, 59, 999); return new Date(day) <= t; }

  async function api(method, path, body, raw) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (raw) { opt.headers['Content-Type'] = raw.type || 'application/octet-stream'; opt.body = raw; }
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r = await fetch(path, opt);
    if (r.status === 401) { window.location.href = '/founder-login'; throw new Error('unauth'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function inv() { return state.investors.find(function (i) { return i.id === state.selectedId; }); }
  function logsFor(id) { return state.logs.filter(function (l) { return l.actorId === id; }); }
  function viewsFor(id) { return logsFor(id).filter(function (l) { return l.event === 'document_view'; }).length; }

  // ---------- renderers ----------
  function renderCockpit() {
    var committed = 0, soft = 0, cN = 0, sN = 0;
    state.investors.forEach(function (i) { if (i.commitStatus === 'committed') { committed += i.commitAmount || 0; cN++; } else if (i.commitStatus === 'soft') { soft += i.commitAmount || 0; sN++; } });
    var pctC = Math.min(100, committed / ROUND_TARGET * 100);
    var pctS = Math.max(0, Math.min(100 - pctC, soft / ROUND_TARGET * 100));
    var remaining = Math.max(0, ROUND_TARGET - committed - soft);
    $('cockpit').innerHTML =
      '<div class="sec">Round · Pre-Seed — target ' + fmtMoney(ROUND_TARGET) + '</div>' +
      '<div class="thermo"><i class="tc" style="width:' + pctC + '%"></i><i class="ts" style="width:' + pctS + '%"></i></div>' +
      '<div class="legend"><span><span class="sw c"></span>Committed <span class="legv">' + fmtMoney(committed) + '</span> · ' + cN + '</span>' +
      '<span><span class="sw s"></span>Soft-circled <span class="legv">' + fmtMoney(soft) + '</span> · ' + sN + '</span>' +
      '<span><span class="sw r"></span>Remaining <span class="legv">' + fmtMoney(remaining) + '</span></span>' +
      '<span style="margin-left:auto" class="mono legv">' + Math.round((committed + soft) / ROUND_TARGET * 100) + '% of round</span></div>';
  }

  function renderStats() {
    var list = state.investors;
    var inDil = list.filter(function (i) { return i.accessLevel >= 3; }).length;
    var due = list.filter(function (i) { return isDue(i.followUpAt); }).length;
    var revoked = list.filter(function (i) { return i.revoked; }).length;
    var pending = state.requests.filter(function (r) { return r.status === 'pending'; }).length;
    var cards = [
      { k: 'Investors', v: list.length, d: 'in pipeline' },
      { k: 'In diligence', v: inDil, d: 'Qualified/NDA or later' },
      { k: 'Follow-ups due', v: due, d: 'needs action', due: due > 0 },
      { k: 'Pending requests', v: pending, d: 'awaiting review', due: pending > 0 },
      { k: 'Revoked', v: revoked, d: 'access removed' },
      { k: 'Documents', v: state.documents.length, d: 'in the data room' }
    ];
    $('stats').innerHTML = cards.map(function (c) { return '<div class="stat"><div class="k">' + c.k + '</div><div class="v' + (c.due ? ' due' : '') + '">' + c.v + '</div><div class="d">' + c.d + '</div></div>'; }).join('');
  }

  function renderTable() {
    var q = state.search.trim().toLowerCase();
    var rows = state.investors.filter(function (i) { return !q || (i.name + ' ' + i.org).toLowerCase().indexOf(q) >= 0; });
    $('rows').innerHTML = rows.map(function (i) {
      var flags = '';
      if (i.revoked) flags += ' <span class="tag rev">revoked</span>';
      if (isDue(i.followUpAt)) flags += ' <span class="tag due">follow-up</span>';
      var commit = (i.commitAmount > 0 || i.commitStatus !== 'none')
        ? '<span class="dot" style="background:' + COMMIT_COLOR[i.commitStatus] + '"></span>' + (i.commitAmount > 0 ? fmtMoney(i.commitAmount) : '—')
        : '<span class="muted">—</span>';
      return '<tr data-id="' + i.id + '" class="' + (i.id === state.selectedId ? 'sel' : '') + '">' +
        '<td><div class="who"><b>' + esc(i.name) + '</b>' + flags + '<small>' + esc(i.org || '—') + ' · ' + esc(i.country || '') + '</small></div></td>' +
        '<td><span class="dot" style="background:' + LEVEL_DOT[i.accessLevel] + '"></span>' + i.accessLevel + '</td>' +
        '<td>' + (i.ndaSigned ? '✓' : '—') + '</td>' +
        '<td>' + commit + '</td>' +
        '<td class="mono">' + (i.score == null ? '—' : i.score) + '</td>' +
        '<td class="mono">' + (i.docViews || 0) + '</td>' +
        '<td class="muted mono" style="font-size:12px">' + fmtDate(i.lastActivityAt) + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="muted" style="padding:18px">No investors yet. Provision one from a request below.</td></tr>';
  }

  function renderDetail() {
    var i = inv();
    if (!i) { $('detail').innerHTML = '<div class="muted">Select an investor above to manage their access.</div>'; return; }
    var rail = [1, 2, 3, 4, 5].map(function (lvl) {
      return '<button class="stop ' + (lvl === 3 ? 'gate ' : '') + (lvl === i.accessLevel ? 'on' : '') + '" data-level="' + lvl + '">' + lvl + ' · ' + LEVELS[lvl] + '</button>';
    }).join('');
    var acts = logsFor(i.id).slice(0, 12).map(function (l) {
      return '<li><b>' + esc(l.event.replace(/_/g, ' ')) + '</b>' + (l.documentId ? ' · ' + esc(l.documentId) : '') + (l.detail ? ' — ' + esc(l.detail) : '') + '<div class="ts">' + fmtDate(l.createdAt) + '</div></li>';
    }).join('') || '<li class="muted">No activity yet.</li>';
    var instr = ['—', 'SAFE', 'Equity'].map(function (o) { return '<option ' + (i.instrument === o ? 'selected' : '') + '>' + o + '</option>'; }).join('');
    $('detail').innerHTML =
      '<div class="sec">' + esc(i.name) + ' — ' + esc(i.email) + (i.revoked ? ' · <span class="tag rev">REVOKED</span>' : '') + (i.isExpired ? ' · <span class="tag due">EXPIRED</span>' : '') + '</div>' +
      '<div class="muted" style="margin-top:-6px;margin-bottom:10px">' + esc(i.role || '') + ' · ' + esc(i.org || '') + ' · ' + esc(i.country || '') + ' · score <b class="mono">' + (i.score == null ? '—' : i.score) + '</b>' + (i.hasPassword ? '' : ' · <b style="color:var(--gold-ink)">password not set (invite pending)</b>') + '</div>' +
      '<div style="font-size:12px;color:var(--ink-3);margin-bottom:5px">Disclosure level (levels 4 & 5 require a named approver)</div>' +
      '<div class="rail" id="rail">' + rail + '</div>' +
      '<div class="row" style="margin-bottom:8px">' +
        '<button class="tog gold ' + (i.ndaSigned ? 'on' : '') + '" data-tog="ndaSigned">NDA signed</button>' +
        '<button class="tog ' + (i.meetingBooked ? 'on' : '') + '" data-tog="meetingBooked">Meeting booked</button>' +
        '<button class="btn btn-teal" id="viewRoom">View data room ↗</button>' +
        (i.revoked ? '<button class="btn" id="reinstate">Reinstate access</button>' : '<button class="btn btn-red" id="revoke">Revoke access</button>') +
        '<button class="btn" id="sendInvite">' + (i.hasPassword ? 'Reset password (email link)' : 'Send set-password link') + '</button>' +
        '<button class="btn btn-red" id="deleteInv" style="margin-left:auto">Delete investor</button>' +
      '</div>' +
      '<div class="grid2">' +
        '<div><div class="sec">Commitment</div>' +
          '<label class="fl">Amount (€)</label><input id="cAmt" type="number" min="0" step="50000" value="' + (i.commitAmount || '') + '" />' +
          '<label class="fl">Status</label><select id="cStatus"><option value="none"' + (i.commitStatus === 'none' ? ' selected' : '') + '>Not committed</option><option value="soft"' + (i.commitStatus === 'soft' ? ' selected' : '') + '>Soft-circled</option><option value="committed"' + (i.commitStatus === 'committed' ? ' selected' : '') + '>Committed</option></select>' +
          '<label class="fl">Instrument</label><select id="cInstr">' + instr + '</select>' +
          '<label class="fl">Access expiry (blank = none)</label><input id="cExpiry" type="date" value="' + (i.expiresAt ? i.expiresAt.slice(0, 10) : '') + '" />' +
        '</div>' +
        '<div><div class="sec">Notes &amp; follow-up</div>' +
          '<textarea id="nNotes" placeholder="Private notes…">' + esc(i.notes || '') + '</textarea>' +
          '<label class="fl">Follow-up date</label><input id="nFollow" type="date" value="' + (i.followUpAt ? i.followUpAt.slice(0, 10) : '') + '" />' +
          '<div class="sec" style="margin-top:16px">Activity (audit)</div><ul class="timeline">' + acts + '</ul>' +
        '</div>' +
      '</div>';
  }

  function renderRequests() {
    function dRow(k, v) { return '<div style="display:grid;grid-template-columns:150px 1fr;gap:10px;padding:3px 0"><div class="muted" style="font-size:12px">' + k + '</div><div style="font-size:13px">' + v + '</div></div>'; }
    var rows = state.requests.map(function (r) {
      var rid = esc(r.requestId);
      var lk = r.linkedin || '';
      // Only render as a clickable link if it is a real http(s) URL — never javascript:/data: etc.
      var lkHtml = /^https?:\/\//i.test(lk) ? '<a href="' + esc(lk) + '" target="_blank" rel="noopener noreferrer">' + esc(lk) + '</a>' : (lk ? esc(lk) : '<span class="muted">—</span>');
      var actions = r.status === 'approved'
        ? '<span class="muted">provisioned</span>'
        : '<button class="btn btn-teal" data-provision="' + rid + '">Provision</button> <button class="btn" data-decline="' + rid + '">Decline</button>';
      var summary = '<div class="req-row" data-req="' + rid + '">' +
        '<div><b>' + esc(r.fullName) + '</b>' +
          '<div class="muted" style="font-size:12px">' + esc(r.email) + ' · ' + esc(r.organisation) + '</div>' +
          '<div class="muted" style="font-size:11.5px">ticket ' + esc(r.ticketRange) + ' · ' + esc(r.roleInRound) + ' · ' + esc(r.meetingType) + '</div>' +
          '<button type="button" data-toggle="' + rid + '" style="background:none;border:0;color:var(--teal-dark);cursor:pointer;font-size:12px;padding:4px 0 0;text-decoration:underline">▾ Full details</button>' +
        '</div>' +
        '<div class="mono" style="font-size:12px">' + esc(r.status) + '</div>' +
        '<div class="muted mono" style="font-size:11.5px">' + rid + '</div>' +
        '<div class="right">' + actions + '</div>' +
      '</div>';
      var details = '<div class="req-details" id="rd-' + rid + '" style="display:none;padding:14px 16px;border:1px solid var(--line-2);border-top:0;background:var(--paper-2);margin:0 0 6px;border-radius:0 0 10px 10px">' +
        dRow('Full name', esc(r.fullName)) +
        dRow('Email', esc(r.email)) +
        dRow('Organisation', esc(r.organisation)) +
        dRow('Role / title', esc(r.role || '—')) +
        dRow('Country', esc(r.country || '—')) +
        dRow('LinkedIn / profile', lkHtml) +
        dRow('Investor type', esc(r.investorType || '—')) +
        dRow('Indicative ticket', esc(r.ticketRange || '—')) +
        dRow('Role in round', esc(r.roleInRound || '—')) +
        dRow('Interest area', esc(r.interestArea || '—')) +
        dRow('Decision timeline', esc(r.timeline || '—')) +
        dRow('Requested meeting', esc(r.meetingType || '—')) +
        dRow('Referral', esc(r.referral || '—')) +
        dRow('Submitted', fmtDate(r.createdAt)) +
        '<div style="margin-top:10px"><div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)">Message from investor</div><div style="white-space:pre-wrap;font-size:13px;margin-top:4px;line-height:1.5">' + esc(r.message || '—') + '</div></div>' +
        '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)"><div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--gold-ink)">Internal routing (not shown to investor)</div><div style="font-size:12.5px;margin-top:4px;color:var(--gold-ink)">' + esc(r.internalRoutingHint || '—') + '</div></div>' +
      '</div>';
      return summary + details;
    }).join('') || '<div class="muted">No access requests yet.</div>';
    $('requests').innerHTML = '<div class="sec">Access requests</div>' + rows;
  }

  function renderLibrary() {
    var rows = state.documents.map(function (d) {
      var sel = [1, 2, 3, 4, 5].map(function (l) { return '<option value="' + l + '"' + (d.minLevel === l ? ' selected' : '') + '>L' + l + '</option>'; }).join('');
      return '<div class="lib-row" data-doc="' + esc(d.id) + '">' +
        '<div><b>' + esc(d.title) + '</b> <span class="tag ' + (d.tier === 2 ? '' : '') + '" style="background:' + (d.minLevel >= 3 ? 'var(--gold-soft);color:var(--gold-ink)' : 'var(--teal-soft);color:var(--teal-dark)') + '">' + (d.minLevel >= 3 ? 'NDA' : 'Open') + '</span></div>' +
        '<div class="mono muted">' + fmtSize(d.size) + '</div>' +
        '<div class="muted mono" style="font-size:12px">' + fmtDate(d.addedAt) + '</div>' +
        '<div><select data-doclevel="' + esc(d.id) + '">' + sel + '</select></div>' +
        '<div class="right"><button class="btn btn-red" data-del="' + esc(d.id) + '">Delete</button></div>' +
      '</div>';
    }).join('') || '<div class="muted">No documents in the data room yet.</div>';
    $('library').innerHTML = '<div class="sec">Data room documents</div>' +
      '<div class="row" style="margin-bottom:12px"><label class="fl" style="margin:0">New upload level</label><select id="upLevel" style="width:auto"><option value="2">L2 · Interested (Open)</option><option value="3" selected>L3 · Qualified/NDA</option><option value="4">L4 · Lead/Anchor</option><option value="5">L5 · Signing</option></select><input type="file" id="upFile" style="width:auto" /><span class="muted" style="font-size:11.5px">Max ~4.5 MB per file.</span></div>' + rows;
  }

  function renderLogs() {
    var rows = state.logs.slice(0, 40).map(function (l) {
      return '<div class="log-row"><div class="mono muted">' + fmtDate(l.createdAt) + '</div><div><b>' + esc(l.event.replace(/_/g, ' ')) + '</b> ' + esc(l.email || l.actorType) + '</div><div class="muted">' + esc((l.documentId ? l.documentId + ' ' : '') + (l.detail || '')) + '</div></div>';
    }).join('') || '<div class="muted">No audit events yet.</div>';
    $('logs').innerHTML = '<div class="sec">Audit log (recent)</div>' + rows;
  }

  function renderAll() { renderCockpit(); renderStats(); renderTable(); renderDetail(); renderRequests(); renderLibrary(); renderLogs(); }

  // ---------- data loads ----------
  async function loadInvestorsAndLogs() {
    var a = await api('GET', '/api/admin/investors'); state.investors = a.investors;
    var l = await api('GET', '/api/admin/logs?limit=300'); state.logs = l.logs;
  }
  async function loadRequests() { state.requests = (await api('GET', '/api/admin/requests')).requests; }
  async function loadDocuments() { state.documents = (await api('GET', '/api/admin/documents')).documents; }

  async function patchInvestor(id, changes) {
    try { await api('PATCH', '/api/admin/investors', { id: id, changes: changes }); await loadInvestorsAndLogs(); renderAll(); }
    catch (e) { toast(e.message); }
  }

  // ---------- events ----------
  $('rows').addEventListener('click', function (e) { var tr = e.target.closest('tr[data-id]'); if (!tr) return; state.selectedId = Number(tr.getAttribute('data-id')); renderTable(); renderDetail(); });
  $('search').addEventListener('input', function (e) { state.search = e.target.value; renderTable(); });

  $('detail').addEventListener('click', async function (e) {
    var i = inv(); if (!i) return;
    if (e.target.id === 'viewRoom') { window.open('/investor-console/preview?investorId=' + i.id, '_blank', 'noopener'); return; }
    if (e.target.id === 'deleteInv') {
      if (confirm('Permanently DELETE ' + i.name + ' (' + i.email + ')?\n\nThis removes the account, their access grant, and their entire access-log history. This cannot be undone.')) {
        try { await api('DELETE', '/api/admin/investors', { id: i.id }); state.selectedId = null; await loadInvestorsAndLogs(); renderAll(); toast('Investor permanently deleted.'); }
        catch (er) { toast(er.message); }
      }
      return;
    }
    if (e.target.id === 'sendInvite') {
      try {
        var r = await api('POST', '/api/admin/invite', { id: i.id });
        await loadInvestorsAndLogs(); renderAll();
        if (r.emailed) toast('Set-password link emailed to ' + i.email + '.');
        else window.prompt('Email not configured — copy this one-time set-password link and send it to the investor:', r.inviteUrl);
      } catch (er) { toast(er.message); }
      return;
    }
    var stop = e.target.closest('.stop');
    if (stop) {
      var lvl = Number(stop.getAttribute('data-level'));
      var changes = { accessLevel: lvl };
      if (lvl >= 4) { var by = prompt('Level ' + lvl + ' requires a named approver.\nEnter approver name:'); if (!by) return; changes.approvedBy = by; }
      return patchInvestor(i.id, changes);
    }
    var tog = e.target.closest('.tog');
    if (tog) { var k = tog.getAttribute('data-tog'); var ch = {}; ch[k] = !i[k]; return patchInvestor(i.id, ch); }
    if (e.target.id === 'revoke') { if (confirm('Revoke data-room access for ' + i.name + '? They will be locked out immediately.')) patchInvestor(i.id, { revoked: true }); return; }
    if (e.target.id === 'reinstate') { patchInvestor(i.id, { revoked: false }); return; }
  });
  $('detail').addEventListener('change', function (e) {
    var i = inv(); if (!i) return; var t = e.target;
    if (t.id === 'cAmt') return patchInvestor(i.id, { commitAmount: Math.max(0, parseInt(t.value || '0', 10) || 0) });
    if (t.id === 'cStatus') return patchInvestor(i.id, { commitStatus: t.value });
    if (t.id === 'cInstr') return patchInvestor(i.id, { instrument: t.value });
    if (t.id === 'cExpiry') return patchInvestor(i.id, { expiresAt: t.value || null });
    if (t.id === 'nFollow') return patchInvestor(i.id, { followUpAt: t.value || null });
  });
  var notesTimer;
  $('detail').addEventListener('input', function (e) {
    if (e.target.id !== 'nNotes') return; var i = inv(); if (!i) return;
    clearTimeout(notesTimer); var val = e.target.value;
    notesTimer = setTimeout(function () { api('PATCH', '/api/admin/investors', { id: i.id, changes: { notes: val } }).then(function () { i.notes = val; }).catch(function (er) { toast(er.message); }); }, 700);
  });

  $('requests').addEventListener('click', async function (e) {
    var tog = e.target.getAttribute('data-toggle');
    if (tog) {
      var box = document.getElementById('rd-' + tog);
      if (box) { box.style.display = box.style.display === 'none' ? 'block' : 'none'; e.target.textContent = box.style.display === 'none' ? '▾ Full details' : '▴ Hide details'; }
      return;
    }
    var prov = e.target.getAttribute('data-provision');
    var dec = e.target.getAttribute('data-decline');
    if (prov) {
      var r = state.requests.find(function (x) { return x.requestId === prov; }); if (!r) return;
      var lvlStr = prompt('Provision ' + r.fullName + ' at which access level? (1–5)\n1 First contact · 2 Interested · 3 Qualified/NDA · 4 Lead/Anchor · 5 Signing', '2');
      if (!lvlStr) return; var lvl = Number(lvlStr); if (!(lvl >= 1 && lvl <= 5)) { toast('Level must be 1–5.'); return; }
      var payload = { email: r.email, name: r.fullName, org: r.organisation, role: r.role, country: r.country, investorType: r.investorType, accessLevel: lvl, ticket: r.ticketRange, interest: r.interestArea, timeline: r.timeline, requestId: r.requestId };
      if (lvl >= 4) { var by = prompt('Level ' + lvl + ' requires a named approver:'); if (!by) return; payload.approvedBy = by; }
      try {
        var res = await api('POST', '/api/admin/investors', payload);
        await Promise.all([loadInvestorsAndLogs(), loadRequests()]);
        renderAll();
        if (res.emailed) toast('Account created — set-password email sent to ' + r.email + '.');
        else window.prompt('Account created. Email not configured — copy this one-time set-password link and send it to the investor:', res.inviteUrl);
      } catch (er) { toast(er.message); }
      return;
    }
    if (dec) { try { await api('PATCH', '/api/admin/requests', { requestId: dec, status: 'declined' }); await loadRequests(); renderRequests(); renderStats(); } catch (er) { toast(er.message); } }
  });

  $('library').addEventListener('change', async function (e) {
    if (e.target.id === 'upFile') {
      var file = e.target.files && e.target.files[0]; if (!file) return;
      var lvl = Number($('upLevel').value) || 3;
      var qs = '?title=' + encodeURIComponent(file.name) + '&minLevel=' + lvl + '&filename=' + encodeURIComponent(file.name) + '&contentType=' + encodeURIComponent(file.type || 'application/octet-stream');
      try { await api('POST', '/api/admin/documents' + qs, undefined, file); await loadDocuments(); renderLibrary(); renderStats(); toast('Uploaded "' + file.name + '".'); }
      catch (er) { toast(er.message); }
      e.target.value = '';
      return;
    }
    var dl = e.target.getAttribute('data-doclevel');
    if (dl) { try { await api('PATCH', '/api/admin/documents', { id: dl, changes: { minLevel: Number(e.target.value) } }); await loadDocuments(); renderLibrary(); } catch (er) { toast(er.message); } }
  });
  $('library').addEventListener('click', async function (e) {
    var del = e.target.getAttribute('data-del'); if (!del) return;
    var d = state.documents.find(function (x) { return x.id === del; });
    if (confirm('Delete "' + (d ? d.title : del) + '" from the data room? Its bytes and any view history reference are removed.')) {
      try { await api('DELETE', '/api/admin/documents', { id: del }); await Promise.all([loadDocuments(), loadInvestorsAndLogs()]); renderAll(); } catch (er) { toast(er.message); }
    }
  });

  $('logoutBtn').addEventListener('click', async function () { try { await api('POST', '/api/auth/logout', {}); } catch (e) {} window.location.href = '/founder-login'; });

  (async function init() {
    try { await Promise.all([loadInvestorsAndLogs(), loadRequests(), loadDocuments()]); if (state.investors[0]) state.selectedId = state.investors[0].id; renderAll(); }
    catch (e) { if (e.message !== 'unauth') toast('Failed to load: ' + e.message); }
  })();
})();
