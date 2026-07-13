// Forgot-password page client. Posts the email to the server, which returns a
// neutral response (it never reveals whether the account exists). On success we
// show that message and hide the form.
(function () {
  'use strict';
  var form = document.getElementById('forgotForm');
  var btn = document.getElementById('submitBtn');
  var status = document.getElementById('status');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    status.className = 'status';
    status.textContent = '';
    var email = form.email.value.trim();
    if (!email) { status.className = 'status error'; status.textContent = 'Please enter your email.'; return; }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      var r = await fetch('/api/auth/forgot-password', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 429) { status.className = 'status error'; status.textContent = j.error || 'Too many requests. Please try again later.'; btn.disabled = false; btn.textContent = old; return; }
      status.className = 'status ok';
      status.textContent = j.message || 'If an account exists for that email, a reset link has been sent.';
      form.email.disabled = true;
      btn.textContent = 'Reset link sent';
    } catch (err) {
      status.className = 'status error';
      status.textContent = 'Network error. Please try again.';
      btn.disabled = false;
      btn.textContent = old;
    }
  });
})();
