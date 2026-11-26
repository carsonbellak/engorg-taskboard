/* Portfolio page: renders window.PORTFOLIO (content.js). */

(function () {
  const P = window.PORTFOLIO || {};
  const projects = Array.isArray(P.projects) ? P.projects : [];
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Anything still marked TODO in content.js stays off the public page.
  const isTodo = s => /^\s*TODO\b/i.test(String(s || ''));
  const visibleMedia = p => (p.media || []).filter(m => m.src || (m.files && m.files.length) || (m.caption && !isTodo(m.caption)));
  const safeUrl = u => (/^(https?:|mailto:|\/)/i.test(String(u || '').trim()) ? String(u).trim() : '#');

  const ICONS = {
    model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/></svg>',
    pcb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/><path d="M9 6V3M12 6V3M15 6V3M9 21v-3M12 21v-3M15 21v-3M6 9H3M6 12H3M6 15H3M21 9h-3M21 12h-3M21 15h-3"/></svg>',
    generic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg>',
    email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    linkedin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.75h4v11H3zM9.5 9.75h3.8v1.5h.06c.53-1 1.83-2.06 3.77-2.06 4.03 0 4.77 2.65 4.77 6.1v5.46h-4v-4.84c0-1.16-.02-2.64-1.6-2.64-1.62 0-1.86 1.26-1.86 2.56v4.92h-4z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
    resume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  };

  // ---------------------------------------------------------- header / hero
  const isPlaceholderName = !P.name || P.name === 'Your Name';
  document.title = isPlaceholderName ? 'Portfolio' : `${P.name} · Portfolio`;
  $('[data-brand]').textContent = P.name || 'Portfolio';
  $('[data-name]').textContent = P.name || '';
  $('[data-role]').textContent = [P.role, P.location].filter(Boolean).join(' · ');
  $('[data-tagline]').textContent = P.tagline || '';
  if (P.status) { const s = $('[data-status]'); s.textContent = P.status; s.hidden = false; }
  $('[data-footer]').textContent = `© ${new Date().getFullYear()} ${P.name || ''}`.trim();

  // Resume buttons appear only once the PDF really exists (the hosting
  // catch-all answers missing files with index.html, so check the type).
  if (P.resume) {
    fetch(P.resume, { method: 'HEAD', cache: 'no-store' }).then(r => {
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/pdf/i.test(type)) return;
      $$('[data-resume]').forEach(a => { a.href = P.resume; a.hidden = false; });
      addContact('Resume', P.resume, ICONS.resume, true);
    }).catch(() => {});
  }

  let heroViewer = null;
  if (P.hero && P.hero.model && window.ModelViewer) {
    $('[data-hero]').hidden = false;
    $('[data-hero-caption]').textContent = P.hero.caption || '';
    heroViewer = new ModelViewer($('[data-hero-stage]'), {
      src: P.hero.model, color: P.hero.color, zUp: P.hero.zUp,
      autoRotate: true, stopRotateOnTouch: true, tools: false,
    });
  }

  // ---------------------------------------------------------- projects grid
  const kinds = p => new Set((p.media || []).filter(m => m.src || (m.files && m.files.length)).map(m => m.type));
  const coverOf = p => p.cover || ((p.media || []).find(m => m.type === 'image' && m.src) || {}).src || '';

  function cardHtml(p) {
    const k = kinds(p);
    const cover = coverOf(p);
    const badges = [k.has('model') && '3D model', k.has('pcb') && 'PCB', k.has('video') && 'Video'].filter(Boolean);
    const icon = k.has('model') ? ICONS.model : k.has('pcb') ? ICONS.pcb : ICONS.generic;
    return `
      <button class="card" type="button" data-open="${esc(p.id)}">
        <div class="card-cover">
          ${cover ? `<img src="${esc(safeUrl(cover))}" alt="" loading="lazy">` : `<div class="gen">${icon}</div>`}
          ${badges.length ? `<div class="card-badges">${badges.map(b => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="card-body">
          ${p.date ? `<span class="card-date">${esc(p.date)}</span>` : ''}
          <h3>${esc(p.title)}</h3>
          <p>${esc(p.summary)}</p>
          <div class="tags">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        </div>
      </button>`;
  }

  let activeTag = null;
  function renderGrid() {
    const list = activeTag ? projects.filter(p => (p.tags || []).includes(activeTag)) : projects;
    $('[data-grid]').innerHTML = list.length ? list.map(cardHtml).join('') : '<p class="empty">No projects with that tag yet.</p>';
  }

  const tagCounts = {};
  projects.forEach(p => (p.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const tags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b));
  const filters = $('[data-filters]');
  if (tags.length > 1) {
    filters.innerHTML = ['All', ...tags].map((t, i) =>
      `<button type="button" data-tag="${i ? esc(t) : ''}" aria-pressed="${i === 0}">${esc(t)}</button>`).join('');
    filters.addEventListener('click', e => {
      const b = e.target.closest('button[data-tag]');
      if (!b) return;
      activeTag = b.dataset.tag || null;
      filters.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderGrid();
    });
  }
  renderGrid();

  $('[data-grid]').addEventListener('click', e => {
    const card = e.target.closest('[data-open]');
    if (card) openProject(card.dataset.open);
  });

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
    if (!href.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noopener'; }
    a.innerHTML = `${icon}<span>${esc(label)}</span>`;
    contactEl.appendChild(a);
    const note = contactEl.parentElement.querySelector('.contact-note');
    if (note) note.remove();
  }
  const c = P.contact || {};
  if (c.email) addContact(c.email, 'mailto:' + c.email, ICONS.email, true);
  if (c.linkedin) addContact('LinkedIn', c.linkedin, ICONS.linkedin);
  if (c.github) addContact('GitHub', c.github, ICONS.github);
  if (!c.email && !c.linkedin && !c.github) {
    contactEl.insertAdjacentHTML('afterend', '<p class="contact-note">Contact links coming soon.</p>');
  }

  // ---------------------------------------------------------- project dialog
  const dlg = $('[data-dialog]');
  const stage = $('[data-pd-stage]');
  let current = null, viewer = null;

  function mediaThumb(m, i) {
    const label = m.label || { model: '3D', pcb: 'PCB', video: 'Video', embed: 'View' }[m.type];
    const inner = m.type === 'image' && m.src
      ? `<img src="${esc(safeUrl(m.src))}" alt="">`
      : (m.type === 'image' && m.poster) ? `<img src="${esc(safeUrl(m.poster))}" alt="">` : esc(label || 'Image');
    return `<button type="button" role="tab" data-media="${i}" aria-label="${esc(m.caption || label || 'Image')}">${inner}</button>`;
  }

  function clearStage() {
    if (viewer) { viewer.dispose(); viewer = null; }
    stage.innerHTML = '';
  }

  function showMedia(i) {
    const media = visibleMedia(current);
    const m = media[i];
    clearStage();
    $$('[data-pd-thumbs] button').forEach(b => b.setAttribute('aria-selected', String(+b.dataset.media === i)));
    $('[data-pd-caption]').textContent = m ? (m.caption || '') : '';
    if (!m) { stage.innerHTML = '<div class="placeholder">Photos coming soon.</div>'; return; }
    const hasSrc = m.src || (m.files && m.files.length);
    if (!hasSrc) { stage.innerHTML = `<div class="placeholder">${esc(m.caption || 'Media coming soon.')}</div>`; $('[data-pd-caption]').textContent = ''; return; }

    if (m.type === 'model') viewer = new ModelViewer(stage, { src: m.src, color: m.color, zUp: m.zUp, autoRotate: false });
    else if (m.type === 'pcb') viewer = new PcbViewer(stage, { src: m.src, files: m.files });
    else if (m.type === 'video') {
      stage.innerHTML = `<video controls playsinline preload="metadata" ${m.poster ? `poster="${esc(safeUrl(m.poster))}"` : ''} src="${esc(safeUrl(m.src))}"></video>`;
    } else if (m.type === 'embed') {
      stage.innerHTML = `<iframe src="${esc(safeUrl(m.src))}" allowfullscreen allow="fullscreen; xr-spatial-tracking" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="${esc(m.caption || 'Embedded viewer')}"></iframe>`;
    } else {
      stage.innerHTML = `<img src="${esc(safeUrl(m.src))}" alt="${esc(m.caption || '')}">`;
    }
  }

  function openProject(id, fromHash) {
    const p = projects.find(x => x.id === id);
    if (!p) return false;
    current = p;
    $('[data-pd-date]').textContent = [p.org, p.date].filter(Boolean).join(' · ');
    $('[data-pd-title]').textContent = p.title || '';
    $('[data-pd-tags]').innerHTML = (p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    const notice = $('[data-pd-notice]');
    notice.textContent = p.notice || '';
    notice.hidden = !p.notice;
    const body = (p.body || []).filter(t => !isTodo(t));
    $('[data-pd-body]').innerHTML = (body.length ? body : [p.summary]).map(t => `<p>${esc(t)}</p>`).join('');
    $('[data-pd-links]').innerHTML = (p.links || []).map((l, i) =>
      `<a class="btn${i ? '' : ' btn-primary'}" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('');
    const media = visibleMedia(p);
    dlg.classList.toggle('no-media', media.length === 0); // text-only layout until photos exist
    $('[data-pd-thumbs]').innerHTML = media.length > 1 ? media.map(mediaThumb).join('') : '';
    if (!dlg.open) dlg.showModal();
    // Let the dialog lay out before a viewer measures its stage.
    requestAnimationFrame(() => { if (current === p) showMedia(0); });
    if (!fromHash) history.replaceState(null, '', '#' + encodeURIComponent(p.id));
    return true;
  }

  $('[data-pd-thumbs]').addEventListener('click', e => {
    const b = e.target.closest('[data-media]');
    if (b) showMedia(+b.dataset.media);
  });
  $('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // backdrop
  dlg.addEventListener('close', () => {
    clearStage();
    current = null;
    if (projects.some(p => '#' + encodeURIComponent(p.id) === location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  });

  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && projects.some(p => p.id === id)) openProject(id, true);
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();

  // Pause the hero model while a project is open (one WebGL context at a time on phones).
  if (heroViewer) {
    dlg.addEventListener('close', () => { heroViewer._visible = true; heroViewer._kick(); });
    new MutationObserver(() => { if (dlg.open) heroViewer._visible = false; }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
  }
})();
