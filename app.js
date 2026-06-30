/* VitaBahn — investor brief. Behaviour split out of the approved page, unchanged
   except the lead form now submits to a Vercel function (which emails the lead)
   instead of opening a mail app. */


(function(){'use strict';
  var nav=document.getElementById('nav'),t=document.getElementById('navToggle');
  if(t){t.addEventListener('click',function(){var o=nav.classList.toggle('open');t.setAttribute('aria-expanded',String(o));});
    nav.querySelectorAll('.nav-links a').forEach(function(a){a.addEventListener('click',function(){nav.classList.remove('open');t.setAttribute('aria-expanded','false');});});}
  // reveal
  var rm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!rm&&'IntersectionObserver'in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12});
    document.querySelectorAll('.reveal').forEach(function(el){io.observe(el);});
  }else{document.querySelectorAll('.reveal').forEach(function(el){el.classList.add('in');});}
  // form submit → Vercel function (validates, blocks spam, emails the lead to invest@vitabahn.com)
  // ▸ DEPLOY STEP: replace the URL below with your deployed Vercel endpoint (see form-backend/README.md).
  var LEAD_ENDPOINT='/api/lead';
  if(LEAD_ENDPOINT.indexOf('REPLACE-WITH-YOUR-PROJECT')>-1){console.warn('VitaBahn: LEAD_ENDPOINT is not configured — form submissions will fail. Set it to your Vercel endpoint (see form-backend/README.md).');}
  var f=document.getElementById('drForm'),note=document.getElementById('drNote');
  if(f){var btn=f.querySelector('button[type="submit"]');f.addEventListener('submit',function(ev){ev.preventDefault();var bad=null;
    f.querySelectorAll('[required]').forEach(function(el){var ok=el.type==='checkbox'?el.checked:el.value.trim()!=='';
      if(el.type==='email'){ok=ok&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value);}
      el.classList.toggle('err',!ok);if(!ok&&!bad)bad=el;});
    if(bad){bad.focus();note.textContent='Please check the required fields.';note.style.color='#c2453f';return;}
    note.textContent='Sending your request …';note.style.color='var(--teal-dark)';
    if(btn){btn.disabled=true;}
    var data={};new FormData(f).forEach(function(v,k){data[k]=v;});
    fetch(LEAD_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){if(!r.ok){throw new Error('status '+r.status);}
        note.textContent='Thank you — your request has been received. We will be in touch.';note.style.color='var(--teal-dark)';f.reset();})
      .catch(function(){note.textContent='Something went wrong. Please email invest@vitabahn.com directly.';note.style.color='#c2453f';})
      .then(function(){if(btn){btn.disabled=false;}});});}
})();



(function(){
  const root = document.querySelector('.hadp-pipe');
  if(!root) return;
  const flow   = document.getElementById('hadpFlow');
  const rail   = document.getElementById('hadpRail');
  const fill   = document.getElementById('hadpFill');
  const pulse  = document.getElementById('hadpPulse');
  const footLk = document.getElementById('hadpFootLock');
  const steps  = Array.from(flow.querySelectorAll('.hp-step'));
  const gate   = flow.querySelector('.hp-step--gate');
  const badge  = gate.querySelector('.hp-badge');

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let centers = [];
  let timer = null;
  let token = 0;
  let measured = false;

  const wait = (ms) => new Promise(res => { timer = setTimeout(res, ms); });

  function measure(){
    const ft = flow.getBoundingClientRect().top;
    centers = steps.map(s => {
      const n = s.querySelector('.hp-node');
      const r = n.getBoundingClientRect();
      return (r.top - ft) + r.height / 2;
    });
    const first = centers[0], last = centers[centers.length - 1];
    rail.style.top = first + 'px';
    rail.style.height = (last - first) + 'px';
    fill.style.top = first + 'px';
    measured = true;
  }

  function ping(node, gold){
    const el = node.querySelector('.hp-ping');
    if(!el) return;
    el.style.borderColor = gold ? 'var(--gold)' : 'var(--teal)';
    el.animate(
      [{ transform:'scale(.55)', opacity:.55 }, { transform:'scale(1.95)', opacity:0 }],
      { duration: gold ? 1000 : 680, easing:'cubic-bezier(.2,.7,.3,1)' }
    );
  }

  function activate(i, gold){
    steps[i].classList.add('is-on');
    ping(steps[i].querySelector('.hp-node'), gold);
  }

  function setPulse(i, dur){
    pulse.style.transitionDuration = dur + 'ms';
    pulse.style.top = centers[i] + 'px';
  }
  function setFill(i, dur){
    fill.style.transitionDuration = dur + 'ms';
    fill.style.height = (centers[i] - centers[0]) + 'px';
  }

  function clearState(){
    steps.forEach(s => s.classList.remove('is-on'));
    gate.classList.remove('is-locked','is-open');
    badge.classList.remove('hp-badge--live');
    footLk.classList.remove('lit');
    pulse.style.transitionDuration = '0ms';
    pulse.style.opacity = '0';
    fill.style.transitionDuration = '0ms';
    fill.style.height = '0px';
  }

  function staticState(){
    steps.forEach(s => s.classList.add('is-on'));
    gate.classList.add('is-locked','is-open');
    footLk.classList.add('lit');
    fill.style.transitionDuration = '0ms';
    fill.style.height = (centers[centers.length-1] - centers[0]) + 'px';
  }

  async function travel(i, dur, gold){
    setPulse(i, dur);
    setFill(i, dur);
    await wait(dur);
    activate(i, gold);
  }

  async function run(){
    const my = ++token;
    const alive = () => my === token;

    clearState();
    await wait(320); if(!alive()) return;

    pulse.style.transitionDuration = '0ms';
    pulse.style.top = centers[0] + 'px';
    void pulse.offsetWidth;
    pulse.style.opacity = '1';
    activate(0, false);
    await wait(460); if(!alive()) return;

    for(let i = 1; i <= 3; i++){ await travel(i, 680, false); if(!alive()) return; }

    await travel(4, 820, true); if(!alive()) return;
    gate.classList.add('is-locked');
    await wait(420); if(!alive()) return;
    badge.classList.add('hp-badge--live');
    await wait(1000); if(!alive()) return;
    gate.classList.add('is-open');
    footLk.classList.add('lit');
    badge.classList.remove('hp-badge--live');
    await wait(560); if(!alive()) return;

    await travel(5, 700, false); if(!alive()) return;
    await travel(6, 700, false); if(!alive()) return;

    const last = steps[6].querySelector('.hp-node');
    last.animate(
      [{ boxShadow:'0 0 0 4px var(--teal-soft)' },
       { boxShadow:'0 0 0 14px rgba(79,179,163,0)' }],
      { duration:900, easing:'cubic-bezier(.2,.7,.3,1)' }
    );

    await wait(1700); if(!alive()) return;
    pulse.style.opacity = '0';
    await wait(550); if(!alive()) return;

    run();
  }

  function start(){
    if(!measured) measure();
    if(reduced){ staticState(); return; }
    run();
  }
  function stop(){
    token++;
    if(timer) clearTimeout(timer);
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if(e.isIntersecting) start();
      else { stop(); if(!reduced) clearState(); }
    });
  }, { threshold:.35 });

  function boot(){ measure(); io.observe(flow); }
  if(document.fonts && document.fonts.ready){
    document.fonts.ready.then(boot);
  } else {
    window.addEventListener('load', boot);
  }

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      stop();
      measure();
      if(reduced){ staticState(); }
      else { clearState(); run(); }
    }, 180);
  });
})();
