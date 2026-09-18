// Syllabus Importer — the app's first "Claude agent" feature.
//
// Flow: pick a syllabus (PDF / image / pasted text) → main sends it to Claude
// (ipc/claude.js) → Claude returns structured { course, events } → we show a quick,
// all-checked preview the user can trim/edit → one click drops the chosen events on
// the calendar. Events are written through dataManager.importExternalEvents with
// source:'syllabus' and a stable extId, so re-importing the same syllabus updates in
// place instead of duplicating (prune:false, so it never touches other syllabi).
//
// Desktop-only (Anthropic call + file access live in the Electron main process); the
// calendar events it creates sync to the PWA via Firebase like any other schedule item.
(function () {
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const TYPE_ICON = {
    assignment: '📝', quiz: '❓', exam: '📄', project: '🚧',
    lab: '🔬', lecture: '📚', holiday: '🌴', other: '📌',
  };
  const NEW_PROJECT = '__new__';

  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function weekday(dateStr) { const d = new Date(dateStr + 'T00:00:00'); return isNaN(d) ? '' : DAY_NAMES[d.getDay()]; }
  function fmtDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return isNaN(d) ? dateStr : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  let overlay = null;
  let course = null;      // { name, code, term }
  let pickedFile = null;  // { name, path }
  let escHandler = null;

  function close() {
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    course = null; pickedFile = null;
  }

  function shell(innerHtml) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'modal syllabus-modal';
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      document.body.appendChild(overlay);
      escHandler = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', escHandler);
    }
    overlay.innerHTML = `<div class="modal-box syllabus-box">${innerHtml}</div>`;
    overlay.querySelectorAll('[data-act="close"]').forEach(el => el.addEventListener('click', close));
  }

  // ── open ──────────────────────────────────────────────────────────────────
  async function open() {
    let status = { connected: false };
    try { status = await window.api.claude.status(); } catch {}
    if (!status.connected) return renderNotConnected();
    renderPicker(status);
  }

  function renderNotConnected() {
    shell(`
      <div class="syllabus-head">
        <div><h2>📄 Import syllabus</h2><p class="syllabus-sub">Turn a course syllabus into calendar events with Claude.</p></div>
        <button class="syllabus-x" data-act="close" title="Close">&times;</button>
      </div>
      <div class="syllabus-empty">
        <div class="syllabus-empty-icon">✨</div>
        <p>Connect your Anthropic (Claude) API key first — it powers this and other AI features.</p>
        <p class="syllabus-hint">Settings → Linked Accounts → Claude. Your key is encrypted on this device and never leaves it.</p>
        <div class="modal-actions">
          <button class="btn-modal-cancel" data-act="close">Not now</button>
          <button class="btn-modal-primary" data-act="settings">Open Settings</button>
        </div>
      </div>`);
    overlay.querySelector('[data-act="settings"]').addEventListener('click', () => {
      close();
      if (window.openSettings) window.openSettings();
    });
  }

  function renderPicker(status) {
    const modelLabel = ((status.models || []).find(m => m.id === status.model) || {}).label || status.model || 'Claude';
    shell(`
      <div class="syllabus-head">
        <div><h2>📄 Import syllabus</h2><p class="syllabus-sub">Claude reads your syllabus and finds every due date, exam, and deadline.</p></div>
        <button class="syllabus-x" data-act="close" title="Close">&times;</button>
      </div>
      <div class="syllabus-pick">
        <button class="syllabus-drop" data-act="pick">
          <span class="syllabus-drop-icon">📎</span>
          <span class="syllabus-drop-main" id="syl-file">${pickedFile ? esc(pickedFile.name) : 'Choose a syllabus file'}</span>
          <span class="syllabus-hint">PDF, image (PNG/JPG), or .txt</span>
        </button>
        <div class="syllabus-or"><span>or paste the text</span></div>
        <textarea id="syl-text" class="syllabus-textarea" placeholder="Paste the syllabus schedule here…"></textarea>
      </div>
      <div class="syllabus-status" id="syl-status"></div>
      <div class="modal-actions">
        <span class="syllabus-model">Using ${esc(modelLabel)}</span>
        <button class="btn-modal-cancel" data-act="close">Cancel</button>
        <button class="btn-modal-primary" id="syl-extract" disabled>Extract events</button>
      </div>`);

    const fileEl = overlay.querySelector('#syl-file');
    const textEl = overlay.querySelector('#syl-text');
    const extractBtn = overlay.querySelector('#syl-extract');
    const refresh = () => { extractBtn.disabled = !(pickedFile || textEl.value.trim()); };

    overlay.querySelector('[data-act="pick"]').addEventListener('click', async () => {
      try {
        const f = await window.api.claude.selectSyllabus();
        if (f) {
          pickedFile = f;
          fileEl.textContent = f.name;
          textEl.value = '';
        }
      } catch (e) { setStatus('Could not open the file picker.', true); }
      refresh();
    });
    textEl.addEventListener('input', () => { if (textEl.value.trim()) { pickedFile = null; fileEl.textContent = 'Choose a syllabus file'; } refresh(); });
    extractBtn.addEventListener('click', () => extract(textEl.value));
    refresh();
  }

  function setStatus(msg, isError) {
    const el = overlay && overlay.querySelector('#syl-status');
    if (el) { el.textContent = msg || ''; el.classList.toggle('is-error', !!isError); }
  }

  async function extract(pastedText) {
    const btn = overlay.querySelector('#syl-extract');
    if (btn) { btn.disabled = true; }
    setStatus('Reading your syllabus with Claude… this can take a moment.', false);
    let res;
    try {
      res = await window.api.claude.extractSyllabus(
        pickedFile ? { filePath: pickedFile.path } : { text: pastedText }
      );
    } catch (e) { setStatus('Extraction failed: ' + (e.message || e), true); if (btn) btn.disabled = false; return; }
    if (res.error) { setStatus(res.error, true); if (btn) btn.disabled = false; return; }
    if (!res.events || !res.events.length) { setStatus('No dated items found. Try the full schedule page, a clearer PDF, or paste the text.', true); if (btn) btn.disabled = false; return; }
    course = res.course || null;
    renderPreview(res.events);
  }

  // ── preview ─────────────────────────────────────────────────────────────────
  function projectOptions() {
    const projects = (dataManager.projects || []);
    const code = course && (course.code || '');
    const detected = (course && (course.name || course.code)) ? (course.name || course.code) : '';
    // Preselect an existing class project that matches the detected course code/name.
    let preselect = '';
    if (code || detected) {
      const key = norm(code) || norm(detected);
      const match = projects.find(p => {
        const pk = norm(p.courseCode || p.courseShort || p.name);
        return key && pk && (pk === key || pk.includes(key) || key.includes(pk));
      });
      if (match) preselect = match.id;
    }
    const opts = ['<option value="">No project (calendar only)</option>'];
    if (detected) opts.push(`<option value="${NEW_PROJECT}">➕ New project: ${esc(detected)}</option>`);
    for (const p of projects) {
      opts.push(`<option value="${esc(p.id)}"${p.id === preselect ? ' selected' : ''}>${esc(p.name)}</option>`);
    }
    return opts.join('');
  }

  function eventRow(ev, i) {
    const icon = TYPE_ICON[ev.type] || TYPE_ICON.other;
    const time = ev.allDay ? '' : (ev.startTime || '');
    return `
      <div class="syl-row" data-i="${i}">
        <label class="syl-check"><input type="checkbox" checked data-role="on"></label>
        <span class="syl-type" title="${esc(ev.type || 'other')}">${icon}</span>
        <input class="syl-title" data-role="title" value="${esc(ev.title)}">
        <input class="syl-date" type="date" data-role="date" value="${esc(ev.date)}">
        <input class="syl-time" type="time" data-role="time" value="${esc(time)}" title="Time (optional)">
      </div>`;
  }

  function renderPreview(events) {
    const courseLine = course && (course.name || course.code)
      ? `<div class="syllabus-course">📚 ${esc(course.name || course.code)}${course.term ? ' · ' + esc(course.term) : ''}</div>`
      : '';
    shell(`
      <div class="syllabus-head">
        <div><h2>📄 Review events</h2><p class="syllabus-sub">Uncheck anything you don't want, fix any dates, then add them.</p></div>
        <button class="syllabus-x" data-act="close" title="Close">&times;</button>
      </div>
      ${courseLine}
      <div class="syllabus-projrow">
        <label class="field-label">Add to project</label>
        <select id="syl-project" class="syllabus-select">${projectOptions()}</select>
      </div>
      <div class="syllabus-list" id="syl-list">${events.map(eventRow).join('')}</div>
      <div class="syllabus-status" id="syl-status"></div>
      <div class="modal-actions">
        <button class="syllabus-selall" id="syl-selall" type="button">Select all</button>
        <button class="btn-modal-cancel" data-act="back">← Back</button>
        <button class="btn-modal-primary" id="syl-add">Add ${events.length} event${events.length === 1 ? '' : 's'}</button>
      </div>`);

    overlay._events = events;
    overlay.querySelector('[data-act="back"]').addEventListener('click', () => open());
    overlay.querySelector('#syl-selall').addEventListener('click', () => {
      const boxes = overlay.querySelectorAll('.syl-row [data-role="on"]');
      const anyOff = [...boxes].some(b => !b.checked);
      boxes.forEach(b => { b.checked = anyOff; });
      updateAddCount();
    });
    overlay.querySelector('#syl-list').addEventListener('change', updateAddCount);
    overlay.querySelector('#syl-add').addEventListener('click', commit);
    updateAddCount();
  }

  function updateAddCount() {
    const n = overlay.querySelectorAll('.syl-row [data-role="on"]:checked').length;
    const btn = overlay.querySelector('#syl-add');
    if (btn) { btn.textContent = `Add ${n} event${n === 1 ? '' : 's'}`; btn.disabled = n === 0; }
  }

  async function commit() {
    const rows = [...overlay.querySelectorAll('.syl-row')];
    const chosen = [];
    for (const row of rows) {
      if (!row.querySelector('[data-role="on"]').checked) continue;
      const title = row.querySelector('[data-role="title"]').value.trim();
      const date = row.querySelector('[data-role="date"]').value;
      const time = row.querySelector('[data-role="time"]').value;
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const base = overlay._events[Number(row.dataset.i)] || {};
      chosen.push({ ...base, title, date, startTime: time || '' });
    }
    if (!chosen.length) { setStatus('Nothing selected.', true); return; }

    const btn = overlay.querySelector('#syl-add');
    if (btn) btn.disabled = true;
    setStatus('Adding to your calendar…', false);

    // Resolve the target project (optionally creating one from the detected course).
    let projectId = overlay.querySelector('#syl-project').value || null;
    if (projectId === NEW_PROJECT) {
      const palette = ['#6366F1', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#06B6D4', '#EF4444'];
      const name = (course && (course.name || course.code)) || 'New course';
      try {
        const proj = await dataManager.addProject({
          name,
          color: palette[(dataManager.projects.length) % palette.length],
          categories: [],
          courseCode: (course && course.code) || null,
          courseShort: (course && course.code) || null,
        });
        projectId = proj.id;
        window.dispatchEvent(new CustomEvent('projects-changed'));
      } catch (e) { projectId = null; }
    }

    const courseKey = slug((course && (course.code || course.name)) || pickedFile && pickedFile.name || 'syllabus');
    const items = chosen.map(ev => ({
      title: ev.title,
      date: ev.date,
      day: weekday(ev.date),
      startTime: ev.startTime || '',
      endTime: ev.endTime || '',
      location: ev.location || '',
      description: ev.notes || (ev.type ? ev.type[0].toUpperCase() + ev.type.slice(1) : ''),
      projectId: projectId || null,
      source: 'syllabus',
      extId: `syllabus:${courseKey}:${ev.date}:${slug(ev.title)}`,
    }));

    try {
      await dataManager.importExternalEvents(items, { source: 'syllabus', prune: false });
      window.dispatchEvent(new CustomEvent('schedule-changed'));
      close();
      if (window._toast) window._toast(`Added ${items.length} event${items.length === 1 ? '' : 's'} from your syllabus.`);
    } catch (e) {
      setStatus('Could not save: ' + (e.message || e), true);
      if (btn) btn.disabled = false;
    }
  }

  window.openSyllabusImport = open;
})();
