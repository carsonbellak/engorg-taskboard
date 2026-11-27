/* Portfolio page: renders window.PORTFOLIO (content.js).
 * Layout: header with a rotating CAD showcase, then every project as a full inline section
 * (text beside a live media gallery, alternating sides), then About and Contact. */

(function () {
  const P = window.PORTFOLIO || {};
  // projectOrder (content.js) puts the biggest projects first; unlisted ones keep their order after
  const ORDER = P.projectOrder || [];
  const rank = id => { const i = ORDER.indexOf(id); return i < 0 ? 1e3 : i; };
  const projects = (Array.isArray(P.projects) ? P.projects : []).map((p, i) => [p, i]).sort((x, y) => rank(x[0].id) - rank(y[0].id) || x[1] - y[1]).map(x => x[0]);
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Anything still marked TODO in content.js stays off the public page.
  const isTodo = s => /^\s*TODO\b/i.test(String(s || ''));
  const hasSrc = m => !!(m.src || (m.files && m.files.length));
  // Model/drawing URLs carry content.js's assetVersion so a new release is a new URL (no stale
  // browser copies). KiCad files are left alone: KiCanvas reads the file type from the name.
  const ver = u => (u && P.assetVersion && /^\/portfolio\/assets\/(models|drawings)\//.test(u) ? u + (u.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(P.assetVersion) : u);
  const visibleMedia = p => (p.media || []).filter(m => hasSrc(m) || (m.caption && !isTodo(m.caption)));
  const safeUrl = u => (/^(https?:|mailto:|tel:|\/)/i.test(String(u || '').trim()) ? String(u).trim() : '#');
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICONS = {
    email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    linkedin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.75h4v11H3zM9.5 9.75h3.8v1.5h.06c.53-1 1.83-2.06 3.77-2.06 4.03 0 4.77 2.65 4.77 6.1v5.46h-4v-4.84c0-1.16-.02-2.64-1.6-2.64-1.62 0-1.86 1.26-1.86 2.56v4.92h-4z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
    resume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  // ---------------------------------------------------------- header
  const isPlaceholderName = !P.name || P.name === 'Your Name';
  document.title = isPlaceholderName ? 'Portfolio' : `${P.name} · Portfolio`;
  $('[data-brand]').textContent = P.name || 'Portfolio';
  $('[data-name]').textContent = P.name || '';
  $('[data-role]').textContent = [P.role, P.location].filter(Boolean).join(' · ');
  { const t = $('[data-tagline]'); t.textContent = P.tagline || ''; t.hidden = !P.tagline; }
  $('[data-footer]').textContent = `© ${new Date().getFullYear()} ${P.name || ''}`.trim();

  // Resume buttons appear only once the PDF really exists (the hosting catch-all answers
  // missing files with index.html, so check the type).
  if (P.resume) {
    fetch(P.resume, { method: 'HEAD', cache: 'no-store' }).then(r => {
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/pdf/i.test(type)) return;
      $$('[data-resume]').forEach(a => { a.href = P.resume; a.hidden = false; });
      addContact('Resume', P.resume, ICONS.resume, true);
    }).catch(() => {});
  }

  // ---------------------------------------------------------- rotating CAD showcase
  const slides = (P.showcase || []).filter(s => s && s.model).map((s, i) => [s, i]).sort((x, y) => rank(x[0].project) - rank(y[0].project) || x[1] - y[1]).map(x => x[0]);
  if (slides.length && window.ModelViewer) {
    const box = $('[data-showcase]'); box.hidden = false;
    const stage = $('[data-sc-stage]'), label = $('[data-sc-label]'), dots = $('[data-sc-dots]');
    const DWELL = 9000;
    let idx = -1, viewer = null, timer = 0, pausedUntil = 0, visible = true;
    dots.innerHTML = slides.map((s, i) => `<button type="button" role="tab" aria-label="${esc(s.label)}" data-i="${i}"></button>`).join('');
    const schedule = () => {
      clearTimeout(timer);
      if (reduceMotion || slides.length < 2) return;
      timer = setTimeout(() => {
        if (!visible || document.hidden || Date.now() < pausedUntil) { schedule(); return; }
        show(idx + 1);
      }, DWELL);
    };
    function show(i) {
      idx = (i + slides.length) % slides.length;
      const s = slides[idx];
      label.innerHTML = `<span>${esc(s.label)}</span>${s.project ? ICONS.arrow : ''}`;
      label.href = s.project ? '#' + encodeURIComponent(s.project) : '#projects';
      dots.querySelectorAll('button').forEach((b, k) => b.setAttribute('aria-selected', String(k === idx)));
      stage.classList.add('fading');
      clearTimeout(timer);
      setTimeout(() => {
        if (viewer) viewer.dispose();
        viewer = new ModelViewer(stage, {
          src: ver(s.model), color: s.color, zUp: s.zUp, view: s.view, autoRotate: !reduceMotion, tools: false, stopRotateOnTouch: true,
          onLoad: () => { stage.classList.remove('fading'); schedule(); },
        });
        // if a model fails, still move on
        setTimeout(() => { if (stage.querySelector('.viewer-status:not([hidden])')) { stage.classList.remove('fading'); schedule(); } }, 15000);
      }, 250);
    }
    stage.addEventListener('pointerdown', () => { pausedUntil = Date.now() + 20000; });
    $('[data-sc-prev]').addEventListener('click', () => { pausedUntil = Date.now() + 20000; show(idx - 1); });
    $('[data-sc-next]').addEventListener('click', () => { pausedUntil = Date.now() + 20000; show(idx + 1); });
    dots.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { pausedUntil = Date.now() + 20000; show(+b.dataset.i); } });
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(box);
    show(0);
  }

  // top bar gains a hairline once the page scrolls
  const bar = $('.topbar');
  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // ---------------------------------------------------------- projects, inline
  const list = $('[data-projects]');
  const TONES = ['tone-blue', 'tone-green', 'tone-yellow', 'tone-red'];
  const DOTS = ['--t-blue-dot', '--t-green-dot', '--t-yellow-dot', '--t-red-dot'];
  $('[data-index]').innerHTML = projects.map((p, n) => `<a href="#${esc(encodeURIComponent(p.id))}" style="--dot: var(${DOTS[n % 4]})">${esc(p.short || p.title)}</a>`).join('');

  function mediaTab(m, i) {
    const label = m.label || { model: '3D', pcb: 'PCB', video: 'Video', embed: 'View', drawing: 'Drawing', image: 'Photo' }[m.type] || 'View';
    return `<button type="button" role="tab" data-media="${i}">${esc(label)}</button>`;
  }

  // Every gallery (a project's, or one per sub-section) is registered here while rendering.
  const galSpecs = [];
  const mediaBlock = (media, prot) => {
    if (!media.length) return '';
    const k = galSpecs.push({ media, prot: !!prot }) - 1;
    return `
        <div class="proj-media" data-gal="${k}">
          <div class="stage proj-stage" data-stage></div>
          <p class="proj-caption mono" data-caption></p>
          <p class="proj-protect" data-protect hidden>Heavily simplified to protect work product</p>
          ${media.length > 1 ? `<div class="media-tabs" role="tablist">${media.map(mediaTab).join('')}</div>` : ''}
        </div>`;
  };
  const paras = (arr, fallback) => { const b = (arr || []).filter(t => !isTodo(t)); return (b.length ? b : (fallback ? [fallback] : [])).map(t => `<p>${esc(t)}</p>`).join(''); };

  list.innerHTML = projects.map((p, n) => {
    const head = `
          <p class="proj-meta">${esc([p.org, p.date].filter(Boolean).join(' · '))}</p>
          <h3>${esc(p.title)}</h3>
          <div class="tags">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          ${p.notice ? `<p class="proj-notice">${esc(p.notice)}</p>` : ''}
          <div class="proj-body">${paras(p.body, p.summary)}</div>
          ${(p.links || []).length ? `<div class="proj-links">${p.links.map((l, i) => `<a class="btn${i ? '' : ' btn-primary'}" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div>` : ''}`;
    // sections: [{ title, body, media }] -> overview on top, then one text+gallery row per section
    if (Array.isArray(p.sections) && p.sections.length) {
      return `
      <article class="proj has-sections ${TONES[n % 4]}" id="${esc(p.id)}" data-proj="${n}">
        <div class="proj-text proj-intro">${head}</div>
        ${p.sections.map((s, i) => {
          const media = visibleMedia(s);
          return `
        <section class="proj-sub${media.length ? '' : ' no-media'}${i % 2 ? ' flip' : ''}">
          <div class="proj-sub-text">
            <h4><span>${String(i + 1).padStart(2, '0')}</span>${esc(s.title)}</h4>
            <div class="proj-body">${paras(s.body)}</div>
          </div>${mediaBlock(media, p.protectModels)}
        </section>`;
        }).join('')}
      </article>`;
    }
    const media = visibleMedia(p);
    return `
      <article class="proj ${TONES[n % 4]}${media.length ? '' : ' no-media'}" id="${esc(p.id)}" data-proj="${n}">
        <div class="proj-text">${head}</div>${mediaBlock(media, p.protectModels)}
      </article>`;
  }).join('');

  // Each gallery mounts its viewer only while near the screen (keeps WebGL contexts and
  // memory low on phones) and remembers which tab was chosen.
  const galleries = [];
  $$('[data-gal]').forEach(el => {
    const { media, prot } = galSpecs[+el.dataset.gal];
    const g = { el, media, prot, protEl: el.querySelector('[data-protect]'), idx: 0, viewer: null, stage: el.querySelector('[data-stage]'), cap: el.querySelector('[data-caption]'), mounted: false };
    galleries.push(g);
    el.querySelectorAll('[data-media]').forEach(b => b.addEventListener('click', () => { g.idx = +b.dataset.media; mount(g); }));
    renderTabs(g);
  });

  function renderTabs(g) {
    g.el.querySelectorAll('[data-media]').forEach(b => b.setAttribute('aria-selected', String(+b.dataset.media === g.idx)));
    const m = g.media[g.idx];
    g.cap.textContent = m && hasSrc(m) ? (m.caption || '') : '';
    // work-product note, only where the item really is heavily simplified
    g.protEl.hidden = !(m && hasSrc(m) && m.protect); // only on media marked protect: true (the obfuscated board views)
  }
  function unmount(g) { if (g.viewer) g.viewer.dispose(); g.viewer = null; g.stage.innerHTML = ''; g.mounted = false; }
  function mount(g) {
    unmount(g); renderTabs(g); g.mounted = true;
    const m = g.media[g.idx], stage = g.stage;
    if (!hasSrc(m)) { stage.innerHTML = `<div class="placeholder">${esc(m.caption || 'Coming soon.')}</div>`; return; }
    if (m.type === 'model') g.viewer = new ModelViewer(stage, { src: ver(m.src), color: m.color, zUp: m.zUp, view: m.view, autoRotate: false });
    else if (m.type === 'pcb') g.viewer = new PcbViewer(stage, { src: m.src, files: m.files });
    else if (m.type === 'drawing' && window.PdfViewer) g.viewer = new PdfViewer(stage, { src: ver(m.src) });
    else if (m.type === 'video') stage.innerHTML = `<video controls playsinline preload="metadata" ${m.poster ? `poster="${esc(safeUrl(m.poster))}"` : ''} src="${esc(safeUrl(m.src))}"></video>`;
    else if (m.type === 'embed') stage.innerHTML = `<iframe src="${esc(safeUrl(m.src))}" allowfullscreen allow="fullscreen; xr-spatial-tracking" loading="lazy" title="${esc(m.caption || 'Embedded viewer')}"></iframe>`;
    else stage.innerHTML = `<img src="${esc(safeUrl(m.src))}" alt="${esc(m.caption || '')}" loading="lazy">`;
  }
  const near = new IntersectionObserver(entries => {
    for (const e of entries) {
      const g = galleries.find(x => x.stage === e.target); if (!g) continue;
      if (e.isIntersecting && !g.mounted) mount(g);
      else if (!e.isIntersecting && g.mounted) unmount(g);
    }
  }, { rootMargin: '400px 0px' });
  galleries.forEach(g => near.observe(g.stage));

  // ---------------------------------------------------------- about / contact
  $('[data-about]').innerHTML = (P.about || []).map(t => `<p>${esc(t)}</p>`).join('');
  if (P.photo) { const img = $('[data-photo]'); img.src = P.photo; img.alt = P.name || ''; img.hidden = false; }
  $('[data-skills]').innerHTML = (P.skills || []).map(g => `
    <div class="skill-group">
      <h3>${esc(g.group)}</h3>
      <div class="tags">${(g.items || []).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>
    </div>`).join('');

  const contactEl = $('[data-contact]');
  function addContact(label, href, icon, primary) {
    const a = document.createElement('a');
    a.className = 'btn' + (primary ? ' btn-primary' : '');
    a.href = safeUrl(href);
    if (!/^(mailto|tel):/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
    a.innerHTML = `${icon}<span>${esc(label)}</span>`;
    contactEl.appendChild(a);
    const note = contactEl.parentElement.querySelector('.contact-note');
    if (note) note.remove();
  }
  const c = P.contact || {};
  if (c.email) addContact(c.email, 'mailto:' + c.email, ICONS.email, true);
  if (c.phone) addContact(c.phone, 'tel:' + c.phone.replace(/[^0-9+]/g, ''), ICONS.phone);
  if (c.linkedin) addContact('LinkedIn', c.linkedin, ICONS.linkedin);
  if (c.github) addContact('GitHub', c.github, ICONS.github);
  if (!c.email && !c.linkedin && !c.github) contactEl.insertAdjacentHTML('afterend', '<p class="contact-note">Contact links coming soon.</p>');
})();
