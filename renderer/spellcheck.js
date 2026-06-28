// Custom spell-check overlay for <textarea>s. Draws red wavy underlines under
// misspelled words and shows a suggestions popup when you HOVER a flagged word
// (click a suggestion to replace it). Backed by window.api.spell.* (offline).
//
// Technique: a backdrop div mirrors the textarea's text + box metrics behind a
// transparent-background textarea. Misspelled words are wrapped in spans that draw
// the underline; hover is detected by hit-testing the cursor against those spans'
// rects (the textarea stays on top so typing/selection is unaffected).

const Spellcheck = (() => {
  const attached = new WeakSet();
  let popup = null, popupForKey = null, hideTimer = null, activeTextarea = null;

  const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.className = 'sc-popup hidden';
    popup.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    popup.addEventListener('mouseleave', () => scheduleHide());
    document.body.appendChild(popup);
    return popup;
  }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hidePopup, 220); }
  function hidePopup() { if (popup) popup.classList.add('hidden'); popupForKey = null; }

  function attach(textarea) {
    if (!textarea || !window.api || !window.api.spell || attached.has(textarea)) return;
    attached.add(textarea);

    const wrap = document.createElement('div');
    wrap.className = 'sc-wrap';
    textarea.parentNode.insertBefore(wrap, textarea);
    const backdrop = document.createElement('div');
    backdrop.className = 'sc-backdrop';
    wrap.appendChild(backdrop);
    wrap.appendChild(textarea);
    textarea.classList.add('sc-textarea');

    let ranges = [];
    let debounce = null;

    function syncStyle() {
      const cs = getComputedStyle(textarea);
      const copy = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'lineHeight', 'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom',
        'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
        'borderLeftWidth', 'borderTopLeftRadius', 'borderTopRightRadius',
        'borderBottomLeftRadius', 'borderBottomRightRadius', 'wordSpacing', 'tabSize'];
      copy.forEach((p) => { backdrop.style[p] = cs[p]; });
      backdrop.style.borderStyle = 'solid';
      backdrop.style.borderColor = 'transparent';
      backdrop.style.background = cs.backgroundColor;
      backdrop.style.height = textarea.offsetHeight + 'px';
      backdrop.style.width = textarea.offsetWidth + 'px';
      textarea.style.background = 'transparent';
    }

    function render() {
      const text = textarea.value;
      let html = '', i = 0;
      for (const r of ranges) {
        if (r.start < i) continue;
        html += escapeText(text.slice(i, r.start));
        html += `<span class="sc-bad" data-s="${r.start}" data-e="${r.end}">${escapeText(text.slice(r.start, r.end))}</span>`;
        i = r.end;
      }
      html += escapeText(text.slice(i)) + '\n';
      backdrop.innerHTML = html;
      backdrop.scrollTop = textarea.scrollTop;
      backdrop.scrollLeft = textarea.scrollLeft;
    }

    async function check() {
      try { ranges = (await window.api.spell.check(textarea.value)) || []; }
      catch { ranges = []; }
      render();
    }
    const scheduleCheck = () => { clearTimeout(debounce); debounce = setTimeout(check, 350); };

    textarea.addEventListener('input', () => { hidePopup(); scheduleCheck(); });
    textarea.addEventListener('scroll', () => { backdrop.scrollTop = textarea.scrollTop; backdrop.scrollLeft = textarea.scrollLeft; });
    textarea.addEventListener('mousemove', (e) => onMove(textarea, backdrop, e));
    textarea.addEventListener('mouseleave', scheduleHide);

    textarea._scCheck = check;   // let callers force a re-check after setting .value
    textarea._scSync = syncStyle;
    syncStyle();
    try { new ResizeObserver(() => { syncStyle(); render(); }).observe(textarea); } catch {}
    check();
  }

  function onMove(textarea, backdrop, e) {
    const spans = backdrop.querySelectorAll('.sc-bad');
    let hit = null;
    for (const sp of spans) {
      const rect = sp.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) { hit = sp; break; }
    }
    if (hit) { clearTimeout(hideTimer); showSuggestions(textarea, hit); }
    else scheduleHide();
  }

  async function showSuggestions(textarea, span) {
    const s = +span.dataset.s, en = +span.dataset.e;
    const key = textarea.id + ':' + s + '-' + en;
    if (popupForKey === key && popup && !popup.classList.contains('hidden')) return; // already showing
    const word = textarea.value.slice(s, en);
    activeTextarea = textarea;
    popupForKey = key;
    const el = ensurePopup();
    el.innerHTML = '<div class="sc-popup-loading">Checking…</div>';
    el.classList.remove('hidden');
    positionPopup(el, span);

    let suggestions = [];
    try { suggestions = (await window.api.spell.suggest(word)) || []; } catch {}
    if (popupForKey !== key) return; // moved away while fetching

    const sugHtml = suggestions.length
      ? suggestions.map((sg) => `<button class="sc-sug" data-sug="${escapeAttr(sg)}">${escapeText(sg)}</button>`).join('')
      : '<div class="sc-popup-none">No suggestions</div>';
    el.innerHTML = `<div class="sc-popup-word">${escapeText(word)}</div>
      <div class="sc-sug-list">${sugHtml}</div>
      <div class="sc-popup-actions">
        <button class="sc-act" data-act="add">＋ Add to dictionary</button>
        <button class="sc-act" data-act="ignore">Ignore</button>
      </div>`;
    positionPopup(el, span);

    el.querySelectorAll('.sc-sug').forEach((b) => b.addEventListener('click', () => {
      replaceRange(textarea, s, en, b.dataset.sug); hidePopup();
    }));
    el.querySelector('[data-act="add"]').addEventListener('click', async () => {
      try { await window.api.spell.add(word); } catch {}
      hidePopup(); if (textarea._scCheck) textarea._scCheck();
    });
    el.querySelector('[data-act="ignore"]').addEventListener('click', hidePopup);
  }

  function positionPopup(el, span) {
    const r = span.getBoundingClientRect();
    el.style.visibility = 'hidden';
    el.classList.remove('hidden');
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let left = r.left;
    let top = r.bottom + 4;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 4; // flip above
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
    el.style.visibility = 'visible';
  }

  function replaceRange(textarea, s, en, replacement) {
    const v = textarea.value;
    textarea.value = v.slice(0, s) + replacement + v.slice(en);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); // recheck + notify listeners
    textarea.focus();
    const caret = s + replacement.length;
    try { textarea.setSelectionRange(caret, caret); } catch {}
  }

  function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // Dismiss popup on outside interaction.
  document.addEventListener('mousedown', (e) => {
    if (popup && !popup.contains(e.target) && !(e.target.classList && e.target.classList.contains('sc-textarea'))) hidePopup();
  });

  return { attach };
})();
