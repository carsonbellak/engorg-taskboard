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

  // Coarse import buckets. The two the user actually toggles are Exams (things you sit
  // for) and Assignments (deliverables that the linked-account imports —
  // Gradescope / Variate / Brightspace — already create as notes, so they duplicate the
  // most). "Other" holds one-off class dates no platform ever produces. Assignments are
  // OFF by default so a syllabus never doubles up the platform imports; if the user turns
  // them on, dedupeAgainstExisting() still drops any that match an existing item.
  const BUCKET_OF = {
    exam: 'exams', quiz: 'exams',
    assignment: 'assignments', project: 'assignments', lab: 'assignments',
    lecture: 'other', holiday: 'other', other: 'other',
  };
  const BUCKETS = [
    { key: 'exams', label: 'Exams & quizzes', defaultOn: true, hint: 'Exams, midterms, finals, quizzes' },
    { key: 'assignments', label: 'Assignments', defaultOn: false, hint: 'Homework, projects, labs — usually already imported from Gradescope / Variate / Brightspace' },
    { key: 'other', label: 'Other dates', defaultOn: true, hint: 'No-class days, add/drop deadlines, etc.' },
  ];
  const bucketOf = (t) => BUCKET_OF[t] || 'other';

  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function weekday(dateStr) { const d = new Date(dateStr + 'T00:00:00'); return isNaN(d) ? '' : DAY_NAMES[d.getDay()]; }
  function fmtDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return isNaN(d) ? dateStr : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── de-dup against what the platform imports already created ──────────────────
  // Assignment-type syllabus rows can collide with the notes Gradescope/Variate/
  // Brightspace make (their dueDate IS their calendar entry) or with other calendar
  // sources. We match on a fuzzy title (HW3 ≡ "Homework 3", but "Lab 1" ≠ "Lab 10")
  // within a few days of the same date, scoped to the same project when both have one.
  const numsOf = (s) => (String(s).match(/\d+/g) || []).map(Number).join(',');
  const stemOf = (s) => norm(s).replace(/[0-9]/g, '')
    .replace(/HOMEWORKS?|ASSIGNMENTS?|ASSIGN|PROBLEMSETS?|PSETS?|PROBLEMS?/g, 'HW');
  function titlesMatch(t1, t2) {
    const n1 = numsOf(t1), n2 = numsOf(t2);
    if (n1 && n2 && n1 !== n2) return false;            // different numbers → different item
    const s1 = stemOf(t1), s2 = stemOf(t2);
    if (!s1 || !s2) return norm(t1) === norm(t2);
    return s1 === s2 || s1.includes(s2) || s2.includes(s1);
  }
  function daysApart(a, b) {
    const d1 = new Date(a + 'T00:00:00'), d2 = new Date(b + 'T00:00:00');
    if (isNaN(d1) || isNaN(d2)) return Infinity;
    return Math.abs(d1 - d2) / 86400000;
  }
  // Everything already on the calendar that a syllabus assignment could duplicate:
  // platform assignment notes (their dueDate renders on the calendar) + non-syllabus
  // schedule items. Our own syllabus items are excluded — they self-dedupe by extId.
  function existingCalendarIndex() {
    const out = [];
    for (const t of (dataManager.tasks || [])) {
      if (!t || !t.dueDate) continue;
      if (t.category === 'assignment' || ['gradescope', 'variate', 'brightspace', 'syllabus'].includes(t.source)) {
        out.push({ title: t.title || '', date: t.dueDate, projectId: t.projectId || null });
      }
    }
    for (const s of (dataManager.scheduleItems || [])) {
      if (!s || !s.date || s.source === 'syllabus') continue;
      out.push({ title: s.title || '', date: s.date, projectId: s.projectId || null });
    }
    return out;
  }
  function isDuplicate(ev, projectId, index) {
    return index.some(e =>
      (!e.projectId || !projectId || e.projectId === projectId) &&
      daysApart(ev.date, e.date) <= 3 &&
      titlesMatch(ev.title, e.title));
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
      <div class="syl-row" data-i="${i}" data-bucket="${bucketOf(ev.type)}">
        <label class="syl-check"><input type="checkbox" checked data-role="on"></label>
        <span class="syl-type" title="${esc(ev.type || 'other')}">${icon}</span>
        <input class="syl-title" data-role="title" value="${esc(ev.title)}">
        <input class="syl-date" type="date" data-role="date" value="${esc(ev.date)}">
        <input class="syl-time" type="time" data-role="time" value="${esc(time)}" title="Time (optional)">
      </div>`;
  }

  // Toggle chips for the buckets actually present in this syllabus.
  function filterBar(events) {
    const present = new Set(events.map(ev => bucketOf(ev.type)));
    overlay._buckets = {};
    const chips = [];
    for (const b of BUCKETS) {
      if (!present.has(b.key)) continue;
      overlay._buckets[b.key] = b.defaultOn;
      chips.push(`<button type="button" class="syl-filter${b.defaultOn ? ' is-on' : ''}" data-bucket="${b.key}" aria-pressed="${b.defaultOn}" title="${esc(b.hint)}"><span class="syl-filter-dot"></span>${esc(b.label)}</button>`);
    }
    if (chips.length < 2) {            // nothing to choose between → skip the bar, show it all
      Object.keys(overlay._buckets).forEach(k => { overlay._buckets[k] = true; });
      return '';
    }
    return `<div class="syllabus-filters" role="group" aria-label="Which items to import"><span class="syllabus-filters-label">Import:</span>${chips.join('')}</div>`;
  }

  function applyBuckets() {
    overlay.querySelectorAll('.syl-row').forEach(row => {
      const on = overlay._buckets[row.dataset.bucket] !== false;
      row.classList.toggle('syl-hidden', !on);
    });
    updateAddCount();
  }

  function renderPreview(events) {
    const courseLine = course && (course.name || course.code)
      ? `<div class="syllabus-course">📚 ${esc(course.name || course.code)}${course.term ? ' · ' + esc(course.term) : ''}</div>`
      : '';
    const bar = filterBar(events);
    shell(`
      <div class="syllabus-head">
        <div><h2>📄 Review events</h2><p class="syllabus-sub">Pick what to import, fix any dates, then add them.</p></div>
        <button class="syllabus-x" data-act="close" title="Close">&times;</button>
      </div>
      ${courseLine}
      <div class="syllabus-projrow">
        <label class="field-label">Add to project</label>
        <select id="syl-project" class="syllabus-select">${projectOptions()}</select>
      </div>
      ${bar}
      <div class="syllabus-list" id="syl-list">${events.map(eventRow).join('')}</div>
      <div class="syllabus-status" id="syl-status"></div>
      <div class="modal-actions">
        <button class="syllabus-selall" id="syl-selall" type="button">Select all</button>
        <button class="btn-modal-cancel" data-act="back">← Back</button>
        <button class="btn-modal-primary" id="syl-add">Add ${events.length} event${events.length === 1 ? '' : 's'}</button>
      </div>`);

    overlay._events = events;
    overlay.querySelector('[data-act="back"]').addEventListener('click', () => open());
    overlay.querySelectorAll('.syl-filter').forEach(chip => {
      chip.addEventListener('click', () => {
        const k = chip.dataset.bucket;
        const on = !overlay._buckets[k];
        overlay._buckets[k] = on;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        applyBuckets();
      });
    });
    overlay.querySelector('#syl-selall').addEventListener('click', () => {
      const boxes = [...overlay.querySelectorAll('.syl-row:not(.syl-hidden) [data-role="on"]')];
      const anyOff = boxes.some(b => !b.checked);
      boxes.forEach(b => { b.checked = anyOff; });
      updateAddCount();
    });
    overlay.querySelector('#syl-list').addEventListener('change', updateAddCount);
    overlay.querySelector('#syl-add').addEventListener('click', commit);
    applyBuckets();
  }

  function updateAddCount() {
    const n = [...overlay.querySelectorAll('.syl-row:not(.syl-hidden) [data-role="on"]')].filter(b => b.checked).length;
    const btn = overlay.querySelector('#syl-add');
    if (btn) { btn.textContent = `Add ${n} event${n === 1 ? '' : 's'}`; btn.disabled = n === 0; }
  }

  async function commit() {
    const rows = [...overlay.querySelectorAll('.syl-row')];
    const chosen = [];
    for (const row of rows) {
      if (row.classList.contains('syl-hidden')) continue;   // bucket toggled off
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
    // Assignment-type rows can double up the notes Gradescope/Variate/Brightspace already
    // make, so drop any that match an existing calendar item. Exams/other never collide
    // with the platform imports, so they pass straight through.
    const index = existingCalendarIndex();
    let skipped = 0;
    const items = [];
    for (const ev of chosen) {
      if (bucketOf(ev.type) === 'assignments' && isDuplicate(ev, projectId, index)) { skipped++; continue; }
      items.push({
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
      });
    }

    if (!items.length) {
      setStatus(skipped ? `Those ${skipped} item${skipped === 1 ? '' : 's'} are already on your calendar from another source.` : 'Nothing selected.', true);
      if (btn) btn.disabled = false;
      return;
    }

    try {
      await dataManager.importExternalEvents(items, { source: 'syllabus', prune: false });
      window.dispatchEvent(new CustomEvent('schedule-changed'));
      close();
      const extra = skipped ? ` (skipped ${skipped} already imported elsewhere)` : '';
      if (window._toast) window._toast(`Added ${items.length} event${items.length === 1 ? '' : 's'} from your syllabus${extra}.`);
    } catch (e) {
      setStatus('Could not save: ' + (e.message || e), true);
      if (btn) btn.disabled = false;
    }
  }

  window.openSyllabusImport = open;
})();
