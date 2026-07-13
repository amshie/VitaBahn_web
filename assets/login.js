// Shared login client for the investor and founder login pages. The form's
// data-endpoint attribute selects the server route. On success the server returns
// the redirect target; the session cookie is set HttpOnly by the server.
(function () {
  'use strict';
  var form = document.getElementById('loginForm');
  var btn = document.getElementById('submitBtn');
  var status = document.getElementById('status');
  var endpoint = form.getAttribute('data-endpoint');

  function showError(msg) {
    status.className = 'status error';
    status.textContent = msg;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    status.className = 'status';
    status.textContent = '';
    var email = form.email.value.trim();
    var password = form.password.value;
    if (!email || !password) { showError('Email and password are required.'); return; }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Signing in…';
    try {
      var r = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.ok) {
        window.location.href = j.redirect || '/';
        return;
      }
      showError(j.error || 'Sign-in failed.');
    } catch (err) {
      showError('Network error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
})();
