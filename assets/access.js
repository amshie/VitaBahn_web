// Investor Access gateway client. Intake only — NOT a security boundary. The
// server (/api/access-request) re-validates everything, generates the request ID,
// stores the request, notifies the team, sends the neutral confirmation and gates
// booking. This page never grants access or shows credentials.
(function () {
  'use strict';
  var form = document.getElementById('investorForm');
  var submitBtn = document.getElementById('submitBtn');
  var statusBox = document.getElementById('formStatus');
  var bookingSection = document.getElementById('bookingSection');
  var calendarContainer = document.getElementById('calendarContainer');
  var requestIdEl = document.getElementById('requestId');
  var accessResult = document.getElementById('accessResult');
  var accessResultText = document.getElementById('accessResultText');
  var bookingNote = document.getElementById('bookingNote');

  var FREEMAIL = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com', 'gmx.de', 'web.de'];
  function professionalEmail(e) { var d = (e.split('@')[1] || '').toLowerCase(); return d && FREEMAIL.indexOf(d) < 0; }

  function renderBooking(booking) {
    calendarContainer.innerHTML = '';
    if (booking && booking.eligible && booking.url) {
      var iframe = document.createElement('iframe');
      iframe.src = booking.url;
      iframe.title = 'Book a VitaBahn investor meeting';
      iframe.loading = 'lazy';
      iframe.setAttribute('allow', 'fullscreen');
      calendarContainer.appendChild(iframe);
    } else {
      var d = document.createElement('div');
      d.className = 'calendar-placeholder';
      var inner = document.createElement('div');
      var h = document.createElement('h3');
      h.textContent = booking && booking.eligible ? 'Scheduling to follow' : 'Meeting subject to review';
      var p = document.createElement('p');
      p.textContent = (booking && booking.note) || 'We will contact you to arrange a time.';
      inner.appendChild(h); inner.appendChild(p); d.appendChild(inner);
      calendarContainer.appendChild(d);
    }
    if (bookingNote) bookingNote.textContent = (booking && booking.note) || '';
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    statusBox.className = 'status';
    statusBox.textContent = '';

    // Honeypot: silently accept without transmitting (mirrors server behaviour).
    if (String(form.companyWebsite.value || '').trim() !== '') {
      statusBox.className = 'status ok';
      statusBox.textContent = 'Your request has been submitted successfully.';
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      statusBox.className = 'status error';
      statusBox.textContent = 'Please complete all required fields.';
      return;
    }
    var data = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) data[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
    var email = String(data.professionalEmail || '').trim();
    if (!professionalEmail(email)) {
      statusBox.className = 'status error';
      statusBox.textContent = 'Please use a professional or institutional email address.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    try {
      var r = await fetch('/api/access-request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.ok) throw new Error(j.error || 'The request could not be submitted.');

      statusBox.className = 'status ok';
      statusBox.textContent = 'Your request has been submitted successfully.';
      accessResult.hidden = false;
      accessResultText.textContent = j.message;
      requestIdEl.textContent = j.requestId;
      renderBooking(j.booking);
      bookingSection.style.display = 'block';
      bookingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      Array.prototype.forEach.call(form.querySelectorAll('input, select, textarea'), function (el) { el.disabled = true; });
      submitBtn.textContent = 'Request submitted';
    } catch (err) {
      statusBox.className = 'status error';
      statusBox.textContent = err.message || 'Unable to submit the request.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit request and continue to booking';
    }
  });
})();
