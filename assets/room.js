// Investor data-room client. Holds no secrets and enforces nothing — every call
// hits an authorised /api/room/* endpoint that re-checks the session, level and
// NDA server-side. Built with textContent (no innerHTML) so document titles can
// never inject markup.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function toLogin() { window.location.href = '/investor-login'; }

  function chip(text, cls) {
    var s = document.createElement('span');
    s.className = 'chip' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  async function loadSession() {
    var r = await fetch('/api/room/session', { credentials: 'same-origin' });
    if (r.status === 401) return toLogin();
    var j = await r.json();
    if (!j.ok) return toLogin();
    var inv = j.investor;
    $('who').textContent = inv.name || inv.email;
    $('orgline').textContent = [inv.org, inv.email].filter(Boolean).join(' · ');
    var g = $('grant');
    g.textContent = '';
    g.appendChild(chip('Level ' + inv.accessLevel + ' · ' + inv.levelLabel));
    g.appendChild(chip(inv.ndaSigned ? 'NDA executed' : 'NDA not on file', inv.ndaSigned ? 'gold' : 'warn'));
    if (inv.expiresAt) {
      var d = new Date(inv.expiresAt);
      g.appendChild(chip('Access until ' + d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })));
    }
  }

  function fmtSize(b) {
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return Math.round(b / 1024) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  async function view(id, title, btn) {
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Opening…';
    try {
      var r = await fetch('/api/room/document?id=' + encodeURIComponent(id), { credentials: 'same-origin' });
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        alert(j.error || 'This document is not available.');
        if (r.status === 401) return toLogin();
        return;
      }
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) {
      alert('Could not open the document.');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function loadDocs() {
    var r = await fetch('/api/room/documents', { credentials: 'same-origin' });
    if (r.status === 401) return toLogin();
    var j = await r.json();
    var ul = $('docs');
    ul.textContent = '';
    if (!j.ok || !j.documents.length) {
      var li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'No documents are currently released at your access level.';
      ul.appendChild(li);
      return;
    }
    j.documents.forEach(function (d) {
      var li = document.createElement('li');
      li.className = 'doc';
      var left = document.createElement('div');
      left.className = 'n';
      var tier = document.createElement('span');
      tier.className = 'tier ' + (d.restricted ? 't2' : 't1');
      tier.textContent = d.restricted ? 'NDA' : 'Open';
      var name = document.createElement('span');
      name.textContent = d.title;
      left.appendChild(tier);
      left.appendChild(name);
      var right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '12px';
      var meta = document.createElement('small');
      meta.textContent = fmtSize(d.size);
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'View';
      btn.addEventListener('click', function () { view(d.id, d.title, btn); });
      right.appendChild(meta);
      right.appendChild(btn);
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });
  }

  $('logoutBtn').addEventListener('click', async function () {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {});
    toLogin();
  });

  loadSession();
  loadDocs();
})();
