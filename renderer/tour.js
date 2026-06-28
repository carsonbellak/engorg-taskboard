// Guided-tour engine — a small, framework-free coachmark/slideshow system shared
// by the first-run onboarding tour and the updater's "What's new" walkthrough.
//
// A "tour" is an array of steps. Each step is either:
//   • a spotlight step  — { target:'#sel', title, body|bodyHtml, placement?, view? }
//       highlights a real UI element and anchors a tooltip beside it.
//   • a slide step      — { title, body|bodyHtml, emoji?, art? }   (no target)
//       a centered card over a dimmed screen (used for intros/outros/changelogs).
//
// appTour.run(steps, opts) → Promise<{completed:boolean}> resolving when the user
// finishes or skips. Only one tour runs at a time.

const appTour = (() => {
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

  let active = false;
  let steps = [];
  let idx = 0;
  let opts = {};
  let resolver = null;
  let els = null; // { overlay, spotlight, pop }

  function isActive() { return active; }

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    const spotlight = document.createElement('div');
    spotlight.className = 'tour-spotlight';
    const pop = document.createElement('div');
    pop.className = 'tour-pop';
    overlay.appendChild(spotlight);
    overlay.appendChild(pop);
    document.body.appendChild(overlay);
    // Swallow backdrop clicks so the tour can only be advanced via its buttons.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) e.stopPropagation(); });
    return { overlay, spotlight, pop };
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  }
  const onReflow = () => { if (active) position(); };

  function clampRect(r, pad) {
    return { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2,
             right: r.right + pad, bottom: r.bottom + pad };
  }

  // Place the tooltip next to the target rect, flipping/clamping to stay on-screen.
  function placePop(rect) {
    const pop = els.pop;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const M = 14, GAP = 16;
    const pref = steps[idx].placement;
    const space = { bottom: vh - rect.bottom, top: rect.top, right: vw - rect.right, left: rect.left };
    const order = pref ? [pref, 'bottom', 'top', 'right', 'left'] : ['bottom', 'top', 'right', 'left'];
    let place = order.find(p => (p === 'bottom' || p === 'top') ? space[p] >= ph + GAP + M
                                                                 : space[p] >= pw + GAP + M) || 'bottom';

    let top, left;
    if (place === 'bottom') { top = rect.bottom + GAP; left = rect.left + rect.width / 2 - pw / 2; }
    else if (place === 'top') { top = rect.top - ph - GAP; left = rect.left + rect.width / 2 - pw / 2; }
    else if (place === 'right') { left = rect.right + GAP; top = rect.top + rect.height / 2 - ph / 2; }
    else { left = rect.left - pw - GAP; top = rect.top + rect.height / 2 - ph / 2; }

    left = Math.max(M, Math.min(left, vw - pw - M));
    top = Math.max(M, Math.min(top, vh - ph - M));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.transform = 'none';

    // Arrow pointing at the target edge.
    const arrow = pop.querySelector('.tour-arrow');
    if (arrow) {
      arrow.className = 'tour-arrow tour-arrow-' + place;
      if (place === 'bottom' || place === 'top') {
        const cx = rect.left + rect.width / 2 - left;
        arrow.style.left = Math.max(16, Math.min(cx, pw - 16)) + 'px';
        arrow.style.top = '';
      } else {
        const cy = rect.top + rect.height / 2 - top;
        arrow.style.top = Math.max(16, Math.min(cy, ph - 16)) + 'px';
        arrow.style.left = '';
      }
    }
  }

  function position() {
    const step = steps[idx];
    const isSlide = !step.target;
    els.overlay.classList.toggle('tour-dim-bg', isSlide);

    if (isSlide) {
      els.spotlight.style.display = 'none';
      els.pop.classList.add('tour-slide');
      els.pop.style.left = '50%';
      els.pop.style.top = '50%';
      els.pop.style.transform = 'translate(-50%, -50%)';
      const arrow = els.pop.querySelector('.tour-arrow');
      if (arrow) arrow.className = 'tour-arrow tour-arrow-none';
      return;
    }

    const tgt = document.querySelector(step.target);
    if (!tgt) { els.spotlight.style.display = 'none'; els.pop.classList.add('tour-slide');
      els.pop.style.left = '50%'; els.pop.style.top = '50%'; els.pop.style.transform = 'translate(-50%,-50%)'; return; }

    try { tgt.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
    const raw = tgt.getBoundingClientRect();
    const r = clampRect(raw, step.pad != null ? step.pad : 8);
    els.pop.classList.remove('tour-slide');
    els.spotlight.style.display = 'block';
    els.spotlight.style.top = r.top + 'px';
    els.spotlight.style.left = r.left + 'px';
    els.spotlight.style.width = r.width + 'px';
    els.spotlight.style.height = r.height + 'px';
    placePop(r);
  }

  function renderStep() {
    const step = steps[idx];
    const total = steps.length;
    const last = idx === total - 1;
    const dots = steps.map((_, i) => `<span class="tour-dot ${i === idx ? 'active' : ''}"></span>`).join('');
    const bodyHtml = step.bodyHtml != null ? step.bodyHtml : `<p>${esc(step.body || '')}</p>`;
    const art = step.art ? `<div class="tour-art">${step.art}</div>` : (step.emoji ? `<div class="tour-emoji">${esc(step.emoji)}</div>` : '');
    const nextLabel = last ? (opts.finishLabel || 'Done') : 'Next';

    els.pop.innerHTML = `
      <span class="tour-arrow"></span>
      ${art}
      <h3 class="tour-title">${esc(step.title || '')}</h3>
      <div class="tour-body">${bodyHtml}</div>
      <div class="tour-foot">
        <div class="tour-dots">${dots}</div>
        <div class="tour-foot-btns">
          ${total > 1 && !opts.hideSkip ? `<button class="tour-skip">Skip</button>` : ''}
          ${idx > 0 ? `<button class="tour-back">Back</button>` : ''}
          <button class="tour-next">${esc(nextLabel)}</button>
        </div>
      </div>`;

    els.pop.querySelector('.tour-skip')?.addEventListener('click', () => finish(false));
    els.pop.querySelector('.tour-back')?.addEventListener('click', back);
    els.pop.querySelector('.tour-next')?.addEventListener('click', next);

    // A step can request a view switch (clicks the matching header tab) before showing.
    if (step.view) { try { document.querySelector(`.header-tab[data-view="${step.view}"]`)?.click(); } catch {} }

    // Let layout settle (view switch / scroll) before measuring.
    requestAnimationFrame(() => requestAnimationFrame(position));
  }

  function next() { if (idx >= steps.length - 1) finish(true); else { idx++; renderStep(); } }
  function back() { if (idx > 0) { idx--; renderStep(); } }

  function finish(completed) {
    if (!active) return;
    active = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
    if (els && els.overlay) {
      els.overlay.classList.add('tour-closing');
      const ov = els.overlay;
      setTimeout(() => { try { ov.remove(); } catch {} }, 180);
    }
    els = null;
    const r = resolver; resolver = null;
    if (r) r({ completed: !!completed });
  }

  function run(stepList, options = {}) {
    if (active) return Promise.resolve({ completed: false });
    steps = (stepList || []).filter(Boolean);
    if (!steps.length) return Promise.resolve({ completed: false });
    opts = options || {};
    idx = 0;
    active = true;
    els = build();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    renderStep();
    return new Promise((res) => { resolver = res; });
  }

  return { run, isActive };
})();

window.appTour = appTour;
