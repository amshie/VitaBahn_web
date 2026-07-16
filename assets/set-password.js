// Set-password page client. Reads the invite token from the URL, validates it,
// then lets the investor choose a password. The server enforces token validity and
// the minimum length; these client checks are UX only.
(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var form = document.getElementById('pwForm');
  var intro = document.getElementById('intro');
  var invalidBox = document.getElementById('invalidBox');
  var loginLink = document.getElementById('loginLink');
  var status = document.getElementById('status');
  var btn = document.getElementById('submitBtn');

  function showError(msg) { status.className = 'status error'; status.textContent = msg; }
  function showInvalid() { form.classList.add('hidden'); invalidBox.classList.remove('hidden'); intro.textContent = ''; }

  async function validate() {
    if (!token) { showInvalid(); return; }
    try {
      var r = await fetch('/api/auth/set-password?token=' + encodeURIComponent(token), { credentials: 'same-origin' });
      var j = await r.json();
      if (j.ok && j.valid) {
        intro.textContent = j.email ? ('Choose a password for ' + j.email + '.') : 'Choose a password to access the Data Room.';
        form.classList.remove('hidden');
      } else {
        showInvalid();
      }
    } catch (e) { showInvalid(); }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    status.className = 'status';
    status.textContent = '';
    var pw = form.password.value;
    var confirm = form.confirm.value;
    if (pw.length < 12) { showError('Password must be at least 12 characters.'); return; }
    if (pw !== confirm) { showError('The two passwords do not match.'); return; }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Setting…';
    try {
      var r = await fetch('/api/auth/set-password', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, password: pw }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.ok) {
        status.className = 'status ok';
        status.textContent = j.message || 'Password set. Redirecting…';
        if (loginLink) loginLink.style.display = 'none';
        window.location.href = j.redirect || '/investor-login';
        return;
      }
      showError(j.error || 'Could not set the password.');
    } catch (err) {
      showError('Network error. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  validate();
})();
