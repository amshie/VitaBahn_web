/* VitaBahn — Hong Kong 2026 landing page (/hk2026)
 * No dependencies. Edit CONFIG below; nothing else needs to change for launch.
 */
(function () {
  'use strict';

  var CONFIG = {
    // Where the forms POST to: the site's serverless port of the PHP handler
    // (api/hk2026-request.js — same fields, validation and JSON responses).
    endpoint: '/api/hk2026-request',

    // Used for the "email us instead" fallback if the endpoint cannot be reached.
    fallbackEmail: 'drmotazshieban@vitabahn.com',

    // Existing booking tool (Calendly, Cal.com, Microsoft Bookings ...). Leave empty to use the request form.
    bookingUrl: '',

    // Only fill a channel once it is VERIFIED. Empty = the button stays hidden.
    channels: {
      linkedin: 'https://www.linkedin.com/in/drmotazshieban/',   // verified: the profile the main site already links
      whatsapp: '',   // e.g. 'https://wa.me/34623161272'
      wechat: ''      // e.g. a verified WeChat contact link
    }
  };

  /* ---------- campaign source (?src=card) ---------- */
  function readSource() {
    var src = '';
    try {
      var p = new URLSearchParams(window.location.search);
      src = p.get('src') || p.get('utm_source') || '';
    } catch (e) {}
    src = String(src).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    try {
      if (src) { sessionStorage.setItem('hk2026_src', src); }
      else { src = sessionStorage.getItem('hk2026_src') || ''; }
    } catch (e) {}
    return src || 'direct';
  }
  var SRC = readSource();

  /* ---------- analytics: forwards to whatever the site already uses ---------- */
  function track(name, extra) {
    var props = { src: SRC, page: 'hk2026' };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) props[k] = extra[k]; } }
    try { if (window.dataLayer && typeof window.dataLayer.push === 'function') window.dataLayer.push(Object.assign({ event: name }, props)); } catch (e) {}
    try { if (typeof window.gtag === 'function') window.gtag('event', name, props); } catch (e) {}
    try { if (typeof window.plausible === 'function') window.plausible(name, { props: props }); } catch (e) {}
    try { if (window.umami && typeof window.umami.track === 'function') window.umami.track(name, props); } catch (e) {}
    try { if (typeof window._paq === 'object' && window._paq.push) window._paq.push(['trackEvent', 'hk2026', name, SRC]); } catch (e) {}
    try { if (typeof window.va === 'function') window.va('event', { name: name, data: props }); } catch (e) {} // Vercel Web Analytics — what vitabahn.com uses
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-track]');
    if (el) track(el.getAttribute('data-track'));
  });

  /* ---------- verified channels ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-channel]'), function (a) {
    var url = CONFIG.channels[a.getAttribute('data-channel')];
    if (url && /^https:\/\//.test(url)) { a.href = url; a.hidden = false; }
  });

  /* ---------- mobile menu ---------- */
  var menuBtn = document.querySelector('.menu-btn');
  var nav = document.getElementById('site-nav');
  function closeMenu() { if (!nav) return; nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); }
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () {
      var open = !nav.classList.contains('open');
      nav.classList.toggle('open', open);
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (ev) { if (ev.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && nav.classList.contains('open')) { closeMenu(); menuBtn.focus(); } });
  }

  /* ---------- sticky mobile CTA: visible after the hero, hidden at the contact block ---------- */
  var sticky = document.getElementById('sticky-cta');
  var hero = document.getElementById('top');
  var meet = document.getElementById('meet');
  if (sticky && hero && meet && 'IntersectionObserver' in window) {
    var heroVisible = true, meetVisible = false;
    var update = function () { sticky.classList.toggle('show', !heroVisible && !meetVisible); };
    new IntersectionObserver(function (e) { heroVisible = e[0].isIntersecting; update(); }, { threshold: 0.05 }).observe(hero);
    new IntersectionObserver(function (e) { meetVisible = e[0].isIntersecting; update(); }, { threshold: 0.05 }).observe(meet);
  }

  /* ---------- meeting calendar (Book a meeting / investor meeting) ---------- */
  // A dependency-free month grid + 20-minute slot chips, always in Hong Kong time.
  // The pick lands in the hidden meeting_date / meeting_time fields the server validates.
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOWS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hkToday() { // YYYY-MM-DD as seen in Hong Kong
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function calHuman(date, time) {
    var q = date.split('-'); var dt = new Date(Date.UTC(+q[0], +q[1] - 1, +q[2]));
    return WDAYS[dt.getUTCDay()] + ' ' + (+q[2]) + ' ' + MONTHS[+q[1] - 1].slice(0, 3) + ' ' + q[0] + ', ' + time;
  }
  var cal = { y: 0, m: 0, date: '', time: '' };
  var calGrid = document.getElementById('cal-grid');
  var calTitle = document.getElementById('cal-title');
  var calSlots = document.getElementById('cal-slots');
  var calPick = document.getElementById('cal-pick');
  var calForm = calGrid && calGrid.closest('form');
  function calSlotList() { var out = []; for (var h = 9; h < 18; h++) for (var mm = 0; mm < 60; mm += 20) out.push(pad(h) + ':' + pad(mm)); return out; }
  function calRenderSlots() {
    if (!cal.date) { calSlots.innerHTML = ''; calPick.hidden = true; }
    else {
      calSlots.innerHTML = calSlotList().map(function (t) { return '<button class="cal-slot" type="button" data-time="' + t + '" aria-pressed="' + (t === cal.time ? 'true' : 'false') + '">' + t + '</button>'; }).join('');
      calPick.hidden = !cal.time;
      if (cal.time) calPick.textContent = 'Selected: ' + calHuman(cal.date, cal.time) + ' (Hong Kong time)';
    }
    calForm.querySelector('[name="meeting_date"]').value = cal.date;
    calForm.querySelector('[name="meeting_time"]').value = cal.time;
  }
  function calRender() {
    var today = hkToday();
    calTitle.textContent = MONTHS[cal.m] + ' ' + cal.y;
    var offset = (new Date(Date.UTC(cal.y, cal.m, 1)).getUTCDay() + 6) % 7; // Monday-first grid
    var days = new Date(Date.UTC(cal.y, cal.m + 1, 0)).getUTCDate();
    var html = DOWS.map(function (d) { return '<span class="cal-dow" aria-hidden="true">' + d + '</span>'; }).join('');
    for (var i = 0; i < offset; i++) html += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var key = cal.y + '-' + pad(cal.m + 1) + '-' + pad(d);
      html += '<button class="cal-day" type="button" data-date="' + key + '"' + (key < today ? ' disabled' : '') + ' aria-pressed="' + (key === cal.date ? 'true' : 'false') + '" aria-label="' + d + ' ' + MONTHS[cal.m] + ' ' + cal.y + '">' + d + '</button>';
    }
    calGrid.innerHTML = html;
    calGrid.parentNode.querySelector('[data-cal-nav="-1"]').disabled = (cal.y + '-' + pad(cal.m + 1)) <= today.slice(0, 7);
    calRenderSlots();
  }
  function calReset() { var t = hkToday(); cal.y = +t.slice(0, 4); cal.m = +t.slice(5, 7) - 1; cal.date = ''; cal.time = ''; calRender(); }
  if (calGrid) {
    calGrid.addEventListener('click', function (ev) { var b = ev.target.closest('.cal-day'); if (!b || b.disabled) return; cal.date = b.getAttribute('data-date'); cal.time = ''; calRender(); });
    calSlots.addEventListener('click', function (ev) { var b = ev.target.closest('.cal-slot'); if (!b) return; cal.time = b.getAttribute('data-time'); calRenderSlots(); });
    calGrid.parentNode.addEventListener('click', function (ev) {
      var n = ev.target.closest('[data-cal-nav]'); if (!n || n.disabled) return;
      cal.m += +n.getAttribute('data-cal-nav'); if (cal.m < 0) { cal.m = 11; cal.y--; } if (cal.m > 11) { cal.m = 0; cal.y++; }
      calRender();
    });
  }
  function isMeetingType(type) { return type === 'MEETING' || type === 'INVESTOR_MEETING'; }

  /* ---------- dialogs ---------- */
  var VARIANTS = {
    MEETING:          { title: 'Book a 20-minute meeting', sub: 'Tell us who you are and when suits you. We confirm by email.', interest: '' },
    INVESTOR_MEETING: { title: 'Book an investor meeting', sub: 'We confirm a time by email.', interest: 'Investment' },
    PILOT:            { title: 'Request a pilot discussion', sub: 'Tell us about your organization and the use case.', interest: 'Pilot' },
    PARTNERSHIP:      { title: 'Discuss a partnership', sub: 'One concrete interface, one owner, one next step.', interest: '' }
  };
  var dlgDataroom = document.getElementById('dlg-dataroom');
  var dlgRequest = document.getElementById('dlg-request');
  var lastTrigger = null;

  function resetDialog(dlg) {
    var form = dlg.querySelector('form');
    var ok = dlg.querySelector('.success');
    form.hidden = false; ok.hidden = true;
    var st = form.querySelector('.form-status'); st.textContent = ''; st.className = 'form-status';
    form.querySelector('[name="src"]').value = SRC;
    form.setAttribute('data-opened', String(Date.now()));
  }

  function openDialog(type, trigger) {
    if (type === 'MEETING' || type === 'INVESTOR_MEETING') {
      if (CONFIG.bookingUrl && /^https:\/\//.test(CONFIG.bookingUrl)) { window.open(CONFIG.bookingUrl, '_blank', 'noopener'); return; }
    }
    if (typeof HTMLDialogElement === 'undefined') { return false; }
    lastTrigger = trigger || null;
    closeMenu();
    if (type === 'DATAROOM') {
      resetDialog(dlgDataroom);
      dlgDataroom.showModal();
    } else {
      var v = VARIANTS[type] || VARIANTS.MEETING;
      resetDialog(dlgRequest);
      var form = dlgRequest.querySelector('form');
      form.querySelector('[name="request_type"]').value = type;
      document.getElementById('rq-title').textContent = v.title;
      document.getElementById('rq-sub').textContent = v.sub;
      var interest = form.querySelector('[name="interest"]');
      if (!interest.value || interest.getAttribute('data-auto') === '1') { interest.value = v.interest; interest.setAttribute('data-auto', '1'); }
      var cat = form.querySelector('[data-only="PARTNERSHIP"]');
      var isPartner = type === 'PARTNERSHIP';
      cat.hidden = !isPartner;
      cat.querySelector('select').required = isPartner;
      var meeting = isMeetingType(type);
      form.querySelector('[data-only="MEETING"]').hidden = !meeting;
      form.querySelector('[data-not="MEETING"]').hidden = meeting;
      if (meeting && calGrid) calReset();
      dlgRequest.showModal();
    }
    if (sticky) sticky.classList.remove('show');
    return true;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-open]');
    if (!t) return;
    var opened = openDialog(t.getAttribute('data-open'), t);
    if (opened !== false) ev.preventDefault(); // otherwise the mailto: href is the no-dialog fallback
  });

  [dlgDataroom, dlgRequest].forEach(function (dlg) {
    if (!dlg) return;
    dlg.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]') || ev.target === dlg) dlg.close();
    });
    dlg.addEventListener('close', function () { if (lastTrigger && lastTrigger.focus) lastTrigger.focus(); });
    var interest = dlg.querySelector('[name="interest"]');
    if (interest) interest.addEventListener('change', function () { interest.setAttribute('data-auto', '0'); });
  });

  /* ---------- form submission ---------- */
  var SUCCESS_EVENT = {
    DATAROOM: 'hk2026_dataroom_request',
    PILOT: 'hk2026_pilot_request',
    PARTNERSHIP: 'hk2026_partner_request',
    MEETING: 'hk2026_meeting_request',
    INVESTOR_MEETING: 'hk2026_meeting_request'
  };

  function mailtoFallback(form) {
    var type = form.querySelector('[name="request_type"]').value;
    var lines = [];
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.type === 'hidden' || el.name === 'website_url' || el.type === 'checkbox') return;
      if (el.value) {
        var lab = form.querySelector('label[for="' + el.id + '"]');
        var name = lab ? lab.textContent.replace(/\*|\(optional\)/g, '').trim() : el.name;
        lines.push(name + ': ' + el.value);
      }
    });
    if (isMeetingType(type) && cal.date && cal.time) lines.push('Requested slot: ' + calHuman(cal.date, cal.time) + ' (Hong Kong time)');
    lines.push('Source: ' + SRC);
    return 'mailto:' + CONFIG.fallbackEmail + '?subject=' + encodeURIComponent('[HK2026] ' + type + ' request') + '&body=' + encodeURIComponent(lines.join('\n'));
  }

  Array.prototype.forEach.call(document.querySelectorAll('form[data-form]'), function (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var status = form.querySelector('.form-status');
      status.className = 'form-status'; status.textContent = '';
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      var meeting = form === calForm && isMeetingType(form.querySelector('[name="request_type"]').value);
      if (meeting && !(cal.date && cal.time)) {
        status.className = 'form-status error';
        status.textContent = 'Please choose a date and a time for the meeting.';
        try { calGrid.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
        return;
      }
      var slotText = meeting ? calHuman(cal.date, cal.time) : '';
      var opened = Number(form.getAttribute('data-opened') || Date.now());
      form.querySelector('[name="elapsed_ms"]').value = String(Date.now() - opened);
      form.querySelector('[name="src"]').value = SRC;

      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = 'Sending…';
      var type = form.querySelector('[name="request_type"]').value;

      fetch(CONFIG.endpoint, { method: 'POST', body: new FormData(form), headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok || data.ok === false) { var err = new Error(data.error || ('HTTP ' + res.status)); err.fields = data.fields; throw err; }
            return data;
          });
        })
        .then(function () {
          track(SUCCESS_EVENT[type] || 'hk2026_request', { request_type: type });
          form.reset();
          form.hidden = true;
          var ok = form.parentNode.querySelector('.success');
          var okTitle = document.getElementById('rq-ok-title'), okText = document.getElementById('rq-ok-text');
          if (okTitle && form === calForm) {
            okTitle.textContent = meeting ? 'Meeting request sent' : 'Request received';
            okText.textContent = meeting
              ? 'Your meeting request for ' + slotText + ' (Hong Kong time) has been sent to Dr. Motaz Shieban. You will receive a confirmation by email.'
              : 'Thank you. We will reply by email to arrange the next step.';
          }
          ok.hidden = false; ok.focus();
        })
        .catch(function (err) {
          status.className = 'form-status error';
          if (err && err.fields && err.fields.length) {
            status.textContent = 'Please check: ' + err.fields.join(', ') + '.';
          } else {
            status.innerHTML = '';
            status.appendChild(document.createTextNode('The request could not be sent. Please '));
            var a = document.createElement('a');
            a.href = mailtoFallback(form); a.textContent = 'send it by email instead';
            status.appendChild(a);
            status.appendChild(document.createTextNode(' — your details are pre-filled.'));
          }
        })
        .then(function () { btn.disabled = false; btn.textContent = 'Send request'; });
    });
  });

  track('hk2026_page_view');
})();
