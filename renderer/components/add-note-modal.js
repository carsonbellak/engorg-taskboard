// Handles all modal interactions: Add Note, Add Event, Add Project, New Category

class ModalManager {
  constructor(dm) {
    this.data = dm;
    this.editingNoteId = null;
    this.selectedColorIdx = 0;
    this.selectedPriority = 'Medium';
    this._editingProjectId = null;
  }

  init(viewRenderer) {
    this.viewRenderer = viewRenderer;
    this._buildPriorityPicker('note-priority-picker');
    this._bindNoteModal();
    this._bindScheduleModal();
    this._bindProjectModal();
    this._bindCategoryModal();
    this._bindCloseOnOverlay();

    window.addEventListener('edit-note', (e) => this.openNoteModal(e.detail));
  }

  // Populate project dropdowns
  _populateProjectSelect(selectId) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = this.data.projects.map(p =>
      `<option value="${p.id}">${escapeHtml(p.name)}</option>`
    ).join('');
    if (this.data.settings.lastProjectId) {
      sel.value = this.data.settings.lastProjectId;
    }
  }

  _populateDaySelect(selectId) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = DAYS.map(d =>
      `<option value="${d}" ${d === this.viewRenderer.selectedDay ? 'selected' : ''}>${d}</option>`
    ).join('');
  }

  // Populate note category dropdown dynamically
  _populateCategorySelect(selectId) {
    const sel = document.getElementById(selectId);
    const cats = getCategories();
    sel.innerHTML = '<option value="">— None —</option>' +
      cats.map(c =>
        `<option value="${c.id}" data-color="${c.color}">${escapeHtml(c.name)}</option>`
      ).join('');
  }

  // Populate project category checkboxes dynamically
  _populateProjectCategories(selectedCategories = []) {
    const container = document.getElementById('project-categories');
    const cats = getCategories();
    container.innerHTML = cats.map(c =>
      `<label class="category-checkbox-label">
        <input type="checkbox" value="${c.id}" class="project-cat-checkbox" ${selectedCategories.includes(c.id) ? 'checked' : ''}>
        <span class="category-chip" style="background:${c.color}22;color:${c.color};border:1px solid ${c.color}44">${escapeHtml(c.label)}</span>
      </label>`
    ).join('') +
      `<button type="button" id="btn-new-category-project" class="btn-new-category" title="New Category">+</button>`;
    // Rebind auto-color
    container.querySelectorAll('.project-cat-checkbox').forEach(cb => {
      cb.addEventListener('change', () => this._updateProjectColorFromCategories());
    });
    // "+" add a new category right from the project modal (keeps categories in sync app-wide).
    container.querySelector('#btn-new-category-project').addEventListener('click', () => this._openNewCategoryModal('project'));
  }

  // ============ PRIORITY PICKER ============
  _buildPriorityPicker(containerId) {
    const container = document.getElementById(containerId);
    container.innerHTML = PRIORITIES.map(p =>
      `<button type="button" class="priority-btn ${p === 'Medium' ? 'selected' : ''}" data-priority="${p}" style="color:${PRIORITY_COLORS[p]}; border-color: ${p === 'Medium' ? PRIORITY_COLORS[p] : '#E2E8F0'}; background: ${p === 'Medium' ? PRIORITY_COLORS[p] + '18' : 'white'};">${p}</button>`
    ).join('');

    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.priority-btn');
      if (!btn) return;
      const priority = btn.dataset.priority;
      container.querySelectorAll('.priority-btn').forEach(b => {
        const p = b.dataset.priority;
        const isSelected = p === priority;
        b.classList.toggle('selected', isSelected);
        b.style.borderColor = isSelected ? PRIORITY_COLORS[p] : '#E2E8F0';
        b.style.background = isSelected ? PRIORITY_COLORS[p] + '18' : 'white';
      });
      this.selectedPriority = priority;
    });
  }

  // ============ NOTE MODAL ============
  _bindNoteModal() {
    document.getElementById('btn-cancel-note').addEventListener('click', () => this._closeModal('modal-add-note'));
    document.getElementById('btn-save-note').addEventListener('click', () => this._saveNote());
    document.getElementById('btn-add-link').addEventListener('click', () => this._addLinkRow());
    document.getElementById('btn-add-checklist-item').addEventListener('click', () => this._addChecklistRow());
    document.getElementById('btn-add-attachment').addEventListener('click', () => this._pickAttachments());

    // Category change → recompute the note's auto color
    document.getElementById('note-category').addEventListener('change', () => this._applyAutoColor());

    // Priority/status changes should also recalc if those modes are active
    document.getElementById('note-priority-picker').addEventListener('click', () => {
      setTimeout(() => this._applyAutoColor(), 10);
    });
    document.getElementById('note-status').addEventListener('change', () => this._applyAutoColor());
    document.getElementById('note-due-date').addEventListener('change', () => this._applyAutoColor());
    document.getElementById('note-project').addEventListener('change', () => this._applyAutoColor());

    // "+" new category button
    document.getElementById('btn-new-category').addEventListener('click', () => {
      this._openNewCategoryModal('note');
    });
  }

  // Notes are colored at render time from the global color mode (the COLOR control in
  // the filter bar), so there's no per-note picker. We still compute and store a sensible
  // colorIdx from the current form state so any code that reads it directly stays correct.
  _applyAutoColor() {
    const mode = this.data.settings.noteColorMode || 'category';
    if (mode === 'manual') return; // keep the existing colorIdx in manual mode

    const fakeNote = {
      category: document.getElementById('note-category').value,
      priority: this.selectedPriority,
      status: document.getElementById('note-status').value,
      projectId: document.getElementById('note-project').value,
      dueDate: document.getElementById('note-due-date').value || null,
      dueTime: document.getElementById('note-due-time').value || null,
      completed: document.getElementById('note-status').value === 'done',
      colorIdx: this.selectedColorIdx,
    };
    this.selectedColorIdx = resolveAutoColor(fakeNote, mode, this.data.projects);
  }

  openNoteModal(editNote = null) {
    this.editingNoteId = editNote ? editNote.id : null;
    this._populateProjectSelect('note-project');
    this._populateCategorySelect('note-category');

    if (editNote) {
      document.getElementById('modal-note-heading').textContent = '\u270F Edit Note';
      document.getElementById('btn-save-note').textContent = 'Update Note';
      document.getElementById('note-text').value = editNote.title || '';
      document.getElementById('note-description').value = editNote.description || '';
      document.getElementById('note-project').value = editNote.projectId || '';
      document.getElementById('note-category').value = editNote.category || '';
      document.getElementById('note-due-date').value = editNote.dueDate || '';
      document.getElementById('note-due-time').value = editNote.dueTime || '';
      this.selectedColorIdx = editNote.colorIdx || 0;
      this.selectedPriority = editNote.priority || 'Medium';
      this._selectPriority('note-priority-picker', this.selectedPriority);
      document.getElementById('note-status').value = editNote.status || (editNote.completed ? 'done' : 'backlog');

      document.getElementById('note-links-container').innerHTML = '';
      if (editNote.links) editNote.links.forEach(l => this._addLinkRow(l.label, l.url));

      // Populate checklist
      document.getElementById('note-checklist-container').innerHTML = '';
      if (editNote.checklist) {
        editNote.checklist.forEach(cl => {
          this._addChecklistRow(cl.text, cl.done);
          const rows = document.querySelectorAll('#note-checklist-container .checklist-row');
          const lastRow = rows[rows.length - 1];
          lastRow.dataset.clId = cl.id;
          lastRow.dataset.completedAt = cl.completedAt || '';
        });
      }

      // Populate attachments
      document.getElementById('note-attachments-container').innerHTML = '';
      if (editNote.attachments) {
        editNote.attachments.forEach(a => this._addAttachmentRow(a.name, a.path));
      }
    } else {
      document.getElementById('modal-note-heading').innerHTML = '&#128204; New Note';
      document.getElementById('btn-save-note').textContent = 'Add Note';
      document.getElementById('note-text').value = '';
      document.getElementById('note-description').value = '';
      document.getElementById('note-category').value = '';
      document.getElementById('note-due-date').value = '';
      document.getElementById('note-due-time').value = '';
      this.selectedColorIdx = 0;
      this.selectedPriority = 'Medium';
      this._selectPriority('note-priority-picker', 'Medium');
      document.getElementById('note-links-container').innerHTML = '';
      document.getElementById('note-checklist-container').innerHTML = '';
      document.getElementById('note-attachments-container').innerHTML = '';
      document.getElementById('note-status').value = 'backlog';

      // Pre-select current project if one is active
      if (this.viewRenderer.selectedProject && this.viewRenderer.selectedProject !== 'all') {
        document.getElementById('note-project').value = this.viewRenderer.selectedProject;
      }
    }

    // Compute the note's color from the global color mode (no per-note picker).
    this._applyAutoColor();

    document.getElementById('modal-add-note').classList.remove('hidden');
    // Spell-check the note fields (attach once; re-check after populating values).
    if (typeof Spellcheck !== 'undefined') {
      const nt = document.getElementById('note-text'), nd = document.getElementById('note-description');
      Spellcheck.attach(nt); Spellcheck.attach(nd);
      setTimeout(() => { if (nt._scCheck) nt._scCheck(); if (nd._scCheck) nd._scCheck(); if (nt._scSync) nt._scSync(); if (nd._scSync) nd._scSync(); }, 60);
    }
    // Delay focus to ensure the modal is fully rendered (Electron timing issue)
    setTimeout(() => document.getElementById('note-text').focus(), 50);
  }

  async _saveNote() {
    const title = document.getElementById('note-text').value.trim();
    if (!title) return;
    const projectId = document.getElementById('note-project').value;
    if (!projectId) { alert('Create a project first.'); return; }

    const status = document.getElementById('note-status').value;
    const noteData = {
      title,
      description: document.getElementById('note-description').value.trim(),
      projectId,
      category: document.getElementById('note-category').value,
      colorIdx: this.selectedColorIdx,
      priority: this.selectedPriority,
      status,
      completed: status === 'done',
      day: this.viewRenderer.selectedDay,
      dueDate: document.getElementById('note-due-date').value || null,
      dueTime: document.getElementById('note-due-time').value || null,
      links: this._gatherLinks(),
      checklist: this._gatherChecklist(),
      attachments: this._gatherAttachments()
    };

    await this.data.updateSettings({ lastProjectId: projectId });

    if (this.editingNoteId) {
      // Record status change history
      const existing = this.data.tasks.find(t => t.id === this.editingNoteId);
      if (existing) {
        const oldStatus = existing.status || 'backlog';
        if (oldStatus !== noteData.status) {
          noteData.statusHistory = [...(existing.statusHistory || []), { from: oldStatus, to: noteData.status, date: new Date().toISOString() }];
        }
      }
      await this.data.updateTask(this.editingNoteId, noteData);
    } else {
      await this.data.addTask(noteData);
    }

    this._closeModal('modal-add-note');
    window.dispatchEvent(new CustomEvent('tasks-changed'));
  }

  _selectPriority(containerId, priority) {
    document.querySelectorAll(`#${containerId} .priority-btn`).forEach(b => {
      const p = b.dataset.priority;
      const sel = p === priority;
      b.classList.toggle('selected', sel);
      b.style.borderColor = sel ? PRIORITY_COLORS[p] : '#E2E8F0';
      b.style.background = sel ? PRIORITY_COLORS[p] + '18' : 'white';
    });
  }

  _addLinkRow(label = '', url = '') {
    const container = document.getElementById('note-links-container');
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <input type="text" class="link-label" placeholder="Label" value="${escapeHtml(label)}">
      <input type="text" class="link-url" placeholder="URL or app path" value="${escapeHtml(url)}">
      <button type="button" class="link-remove-btn">&times;</button>
    `;
    row.querySelector('.link-remove-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  _gatherLinks() {
    const links = [];
    document.querySelectorAll('#note-links-container .link-row').forEach(row => {
      const label = row.querySelector('.link-label').value.trim();
      const url = row.querySelector('.link-url').value.trim();
      if (url) links.push({ label: label || url, url });
    });
    return links;
  }

  // ============ CHECKLIST MANAGEMENT ============
  _addChecklistRow(text = '', done = false) {
    const container = document.getElementById('note-checklist-container');
    const row = document.createElement('div');
    row.className = 'checklist-row';
    row.innerHTML = `
      <input type="checkbox" class="checklist-done" ${done ? 'checked' : ''}>
      <input type="text" class="checklist-text" placeholder="Checklist item..." value="${escapeHtml(text)}">
      <button type="button" class="checklist-remove-btn">&times;</button>
    `;
    row.querySelector('.checklist-remove-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
    row.querySelector('.checklist-text').focus();
  }

  _gatherChecklist() {
    const items = [];
    document.querySelectorAll('#note-checklist-container .checklist-row').forEach(row => {
      const text = row.querySelector('.checklist-text').value.trim();
      if (text) {
        const isDone = row.querySelector('.checklist-done').checked;
        items.push({
          id: row.dataset.clId || ('cl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)),
          text,
          done: isDone,
          completedAt: isDone ? (row.dataset.completedAt || new Date().toISOString()) : null
        });
      }
    });
    return items;
  }

  // ============ FILE ATTACHMENTS ============
  async _pickAttachments() {
    const files = await window.api.openFileDialog();
    files.forEach(f => this._addAttachmentRow(f.name, f.path));
  }

  _addAttachmentRow(name, filePath) {
    const container = document.getElementById('note-attachments-container');
    const row = document.createElement('div');
    row.className = 'attachment-row';
    row.innerHTML = `
      <span class="attachment-icon">&#128206;</span>
      <span class="attachment-name" title="${escapeHtml(filePath)}">${escapeHtml(name)}</span>
      <button type="button" class="attachment-remove-btn">&times;</button>
    `;
    row.dataset.path = filePath;
    row.dataset.name = name;
    row.querySelector('.attachment-remove-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  _gatherAttachments() {
    const attachments = [];
    document.querySelectorAll('#note-attachments-container .attachment-row').forEach(row => {
      attachments.push({ name: row.dataset.name, path: row.dataset.path });
    });
    return attachments;
  }

  // ============ SCHEDULE/EVENT MODAL ============
  _bindScheduleModal() {
    document.getElementById('btn-cancel-schedule').addEventListener('click', () => this._closeModal('modal-add-schedule'));
    document.getElementById('btn-save-schedule').addEventListener('click', () => this._saveSchedule());
  }

  openScheduleModal(opts = {}) {
    this._populateProjectSelect('schedule-project');
    this._populateDaySelect('schedule-day');
    document.getElementById('schedule-title').value = '';
    document.getElementById('schedule-desc').value = '';

    // Pre-fill date/time when launched from week-view click
    if (opts.date) {
      document.getElementById('schedule-date').value = opts.date;
    } else {
      document.getElementById('schedule-date').value = '';
    }
    if (opts.hour !== undefined) {
      const h = String(opts.hour).padStart(2, '0');
      document.getElementById('schedule-start').value = `${h}:00`;
      const endH = String(Math.min(opts.hour + 1, 23)).padStart(2, '0');
      document.getElementById('schedule-end').value = `${endH}:00`;
    } else {
      document.getElementById('schedule-start').value = '09:00';
      document.getElementById('schedule-end').value = '10:00';
    }

    // Pre-select current project
    if (this.viewRenderer.selectedProject && this.viewRenderer.selectedProject !== 'all') {
      document.getElementById('schedule-project').value = this.viewRenderer.selectedProject;
    }

    document.getElementById('modal-add-schedule').classList.remove('hidden');
    document.getElementById('schedule-title').focus();
  }

  async _saveSchedule() {
    const title = document.getElementById('schedule-title').value.trim();
    if (!title) return;
    const projectId = document.getElementById('schedule-project').value;
    if (!projectId) { alert('Create a project first.'); return; }

    await this.data.addScheduleItem({
      title,
      description: document.getElementById('schedule-desc').value.trim(),
      projectId,
      day: document.getElementById('schedule-day').value,
      date: document.getElementById('schedule-date').value || null,
      startTime: document.getElementById('schedule-start').value,
      endTime: document.getElementById('schedule-end').value
    });

    await this.data.updateSettings({ lastProjectId: projectId });
    this._closeModal('modal-add-schedule');
    window.dispatchEvent(new CustomEvent('schedule-changed'));
  }

  // ============ PROJECT MODAL ============
  _bindProjectModal() {
    document.getElementById('btn-cancel-project').addEventListener('click', () => this._closeModal('modal-add-project'));
    document.getElementById('btn-save-project').addEventListener('click', () => this._saveProject());
    document.getElementById('project-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._saveProject(); }
    });
    document.getElementById('btn-open-schedule-picker').addEventListener('click', () => this._openSchedulePicker());
    this._bindSchedulePicker();
  }

  // ============ PROJECT WORK-SCHEDULE (drag-to-paint weekly picker) ============
  // A project's workSchedule is an array of recurring weekly blocks ({ day, start, end }).
  // It's edited in a calendar-style grid: the grid is a set of 30-min slots per weekday
  // that the user paints; on "Done" the painted slots are collapsed back into blocks.
  static get _SCHED_START() { return 0; }   // grid spans the full 24 hours …
  static get _SCHED_END()   { return 24; }  // … midnight to midnight
  static get _SLOT_MIN()      { return 15; } // 15-minute resolution
  static get _SLOTS_PER_HOUR(){ return 60 / ModalManager._SLOT_MIN; }
  static get _SLOTS_PER_DAY() { return (ModalManager._SCHED_END - ModalManager._SCHED_START) * ModalManager._SLOTS_PER_HOUR; }

  _slotToTime(slotIdx) {
    const mins = ModalManager._SCHED_START * 60 + slotIdx * ModalManager._SLOT_MIN;
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  _timeToSlot(t) {
    const [h, m] = (t || '0:0').split(':').map(Number);
    return Math.round((h * 60 + m - ModalManager._SCHED_START * 60) / ModalManager._SLOT_MIN);
  }

  // workSchedule blocks → Set of "day|slot" keys
  _scheduleToSlots(schedule) {
    const set = new Set();
    const maxSlot = ModalManager._SLOTS_PER_DAY;
    (schedule || []).forEach(b => {
      if (!b || !b.day) return;
      let s = this._timeToSlot(b.start);
      let e = this._timeToSlot(b.end || b.start);
      s = Math.max(0, s); e = Math.min(maxSlot, e);
      for (let i = s; i < e; i++) set.add(`${b.day}|${i}`);
    });
    return set;
  }
  // Set of painted slots → workSchedule blocks (contiguous runs per day)
  _slotsToSchedule(set) {
    const blocks = [];
    DAYS.forEach(day => {
      const slots = [];
      for (let i = 0; i < ModalManager._SLOTS_PER_DAY; i++) if (set.has(`${day}|${i}`)) slots.push(i);
      let runStart = null, prev = null;
      const flush = (end) => { if (runStart !== null) blocks.push({ day, start: this._slotToTime(runStart), end: this._slotToTime(end + 1) }); };
      slots.forEach(i => {
        if (runStart === null) { runStart = i; prev = i; }
        else if (i === prev + 1) { prev = i; }
        else { flush(prev); runStart = i; prev = i; }
      });
      if (runStart !== null) flush(prev);
    });
    return blocks;
  }

  _renderScheduleSummary() {
    const el = document.getElementById('project-schedule-summary');
    if (!el) return;
    const sched = this._workingSchedule || [];
    if (!sched.length) {
      el.className = 'project-schedule-summary empty';
      el.textContent = 'No work schedule set.';
      return;
    }
    const abbr = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
    const to12 = (t) => (typeof formatTime12 === 'function' ? formatTime12(t) : t);
    el.className = 'project-schedule-summary';
    el.innerHTML = sched
      .slice()
      .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || (a.start || '').localeCompare(b.start || ''))
      .map(b => `<span class="schedule-chip"><b>${abbr[b.day] || b.day}</b> ${to12(b.start)}–${to12(b.end)}</span>`)
      .join('');
  }

  _bindSchedulePicker() {
    document.getElementById('btn-cancel-schedule-picker').addEventListener('click', () => this._closeModal('modal-schedule-picker'));
    document.getElementById('btn-clear-schedule').addEventListener('click', () => {
      this._pickerSlots = new Set();
      this._paintScheduleGrid();
    });
    document.getElementById('btn-done-schedule-picker').addEventListener('click', () => {
      this._workingSchedule = this._slotsToSchedule(this._pickerSlots);
      this._renderScheduleSummary();
      this._closeModal('modal-schedule-picker');
    });

    // Drag-to-paint interaction. Uses document-level mousemove + elementFromPoint so a
    // drag in ANY direction (up/down across hours, left/right across days) reliably paints
    // every cell the cursor crosses — even on fast drags. Mode (add vs erase) is decided by
    // the first cell so you can drag to select or drag over a filled area to deselect.
    const grid = document.getElementById('schedule-picker-grid');
    let painting = false, mode = 'add', lastKey = null;
    const cellFromPoint = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && el.closest ? el.closest('.sched-cell') : null;
    };
    const paintCell = (cell) => {
      if (!cell) return;
      const day = cell.dataset.day, slot = parseInt(cell.dataset.slot, 10);
      const key = `${day}|${slot}`;
      if (key === lastKey) return;      // already handled this cell in the current drag step
      lastKey = key;
      if (mode === 'add') this._pickerSlots.add(key); else this._pickerSlots.delete(key);
      cell.classList.toggle('painted', mode === 'add');
      // Re-round this cell and its vertical neighbours (run edges shift when one toggles).
      this._refreshRunEdges(day, slot);
      this._refreshRunEdges(day, slot - 1);
      this._refreshRunEdges(day, slot + 1);
    };
    grid.addEventListener('mousedown', (e) => {
      const cell = e.target.closest('.sched-cell');
      if (!cell) return;
      e.preventDefault();
      painting = true;
      lastKey = null;
      mode = this._pickerSlots.has(`${cell.dataset.day}|${cell.dataset.slot}`) ? 'erase' : 'add';
      paintCell(cell);
    });
    document.addEventListener('mousemove', (e) => {
      if (!painting) return;
      paintCell(cellFromPoint(e.clientX, e.clientY));
    });
    // End painting wherever the mouse is released.
    document.addEventListener('mouseup', () => { painting = false; lastKey = null; });
  }

  _cellEl(day, slot) {
    const grid = document.getElementById('schedule-picker-grid');
    return grid ? grid.querySelector(`.sched-cell[data-day="${day}"][data-slot="${slot}"]`) : null;
  }

  // A painted cell rounds its top when the slot above is empty, and its bottom when the
  // slot below is empty — so a contiguous run reads as one rounded, padded block.
  _refreshRunEdges(day, slot) {
    const cell = this._cellEl(day, slot);
    if (!cell) return;
    const on = this._pickerSlots.has(`${day}|${slot}`);
    cell.classList.toggle('sched-run-top', on && !this._pickerSlots.has(`${day}|${slot - 1}`));
    cell.classList.toggle('sched-run-bottom', on && !this._pickerSlots.has(`${day}|${slot + 1}`));
  }

  _openSchedulePicker() {
    const proj = this._editingProjectId ? this.data.projects.find(p => p.id === this._editingProjectId) : null;
    this._pickerColor = (proj && proj.color) || '#6366F1';
    this._pickerSlots = this._scheduleToSlots(this._workingSchedule);
    const nameVal = (document.getElementById('project-name-input').value || '').trim();
    document.getElementById('schedule-picker-title').textContent = nameVal ? `Schedule — ${nameVal}` : 'Weekly Schedule';
    this._buildScheduleGrid();
    document.getElementById('modal-schedule-picker').classList.remove('hidden');
    // Open scrolled to ~7 AM so the useful daytime hours are visible first (not midnight).
    const grid = document.getElementById('schedule-picker-grid');
    const rowH = grid.querySelector('.sched-hour-col')?.offsetHeight || 31;
    grid.scrollTop = rowH * (7 - ModalManager._SCHED_START);
  }

  _buildScheduleGrid() {
    const grid = document.getElementById('schedule-picker-grid');
    const START = ModalManager._SCHED_START, END = ModalManager._SCHED_END;
    const dayAbbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let html = '<div class="sched-corner"></div>';
    dayAbbr.forEach(d => { html += `<div class="sched-day-head">${d}</div>`; });
    // Time gutter + 7 day columns; each hour holds four 15-min cells. Alternating hours get
    // a subtle band (sched-hour-alt) so the grid reads as distinct hour rows; the hour /
    // half-hour lines come from the column background (see CSS).
    const perHour = ModalManager._SLOTS_PER_HOUR;
    for (let h = START; h < END; h++) {
      const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
      const alt = (h % 2 === 1) ? ' sched-hour-alt' : '';
      html += `<div class="sched-time-label${alt}">${label}</div>`;
      DAYS.forEach(day => {
        const base = (h - START) * perHour;   // slot index of :00
        let cells = '';
        for (let q = 0; q < perHour; q++) {
          cells += `<div class="sched-cell" data-day="${day}" data-slot="${base + q}"></div>`;
        }
        html += `<div class="sched-hour-col${alt}">${cells}</div>`;
      });
    }
    grid.innerHTML = html;
    this._paintScheduleGrid();
  }

  // Reflect this._pickerSlots onto the rendered cells (full repaint: build / clear).
  _paintScheduleGrid() {
    const grid = document.getElementById('schedule-picker-grid');
    if (!grid) return;
    grid.style.setProperty('--sched-fill', this._pickerColor || '#6366F1');
    grid.querySelectorAll('.sched-cell').forEach(cell => {
      cell.classList.toggle('painted', this._pickerSlots.has(`${cell.dataset.day}|${cell.dataset.slot}`));
      this._refreshRunEdges(cell.dataset.day, parseInt(cell.dataset.slot, 10));
    });
  }

  _updateProjectColorFromCategories() {
    // Categories no longer drive color — rainbow gradient handles it
  }

  _updateProjectColorPreview() {
    const preview = document.getElementById('project-color-preview');
    const total = this.data.projects.length + (this._editingProjectId ? 0 : 1);
    const idx = this._editingProjectId
      ? this.data.projects.findIndex(p => p.id === this._editingProjectId)
      : this.data.projects.length;
    const color = rainbowColor(idx, total);
    document.getElementById('project-color-input').value = color;
    preview.innerHTML = `<span class="rainbow-dot" style="background:${color}"></span> <span class="rainbow-label">Position ${idx + 1} of ${total}</span>`;
  }

  openProjectModal(editProject = null) {
    this._editingProjectId = editProject ? editProject.id : null;
    const heading = document.querySelector('#modal-add-project h2');
    const saveBtn = document.getElementById('btn-save-project');

    if (editProject) {
      heading.innerHTML = '&#9998; Edit Project';
      saveBtn.textContent = 'Save Changes';
      document.getElementById('project-name-input').value = editProject.name || '';
      this._populateProjectCategories(editProject.categories || []);
      this._workingSchedule = (editProject.workSchedule || []).map(b => ({ ...b }));
    } else {
      heading.innerHTML = '&#128450; New Project';
      saveBtn.textContent = 'Create';
      document.getElementById('project-name-input').value = '';
      this._populateProjectCategories([]);
      this._workingSchedule = [];
    }
    this._renderScheduleSummary();
    this._updateProjectColorPreview();

    document.getElementById('modal-add-project').classList.remove('hidden');
    document.getElementById('project-name-input').focus();
  }

  async _saveProject() {
    const name = document.getElementById('project-name-input').value.trim();
    if (!name) return;
    const categories = Array.from(document.querySelectorAll('.project-cat-checkbox:checked')).map(cb => cb.value);
    const workSchedule = this._workingSchedule || [];

    if (this._editingProjectId) {
      const duplicate = this.data.projects.some(p =>
        p.id !== this._editingProjectId && p.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) { alert('A project with that name already exists.'); return; }
      await this.data.updateProject(this._editingProjectId, { name, categories, workSchedule });
    } else {
      if (this.data.projects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        alert('Project already exists.'); return;
      }
      await this.data.addProject({ name, categories, workSchedule });
    }

    // Re-assign rainbow colors to all projects
    assignRainbowColors(this.data.projects);
    await this.data._saveProjects();

    this._editingProjectId = null;
    this._closeModal('modal-add-project');
    window.dispatchEvent(new CustomEvent('projects-changed'));
  }

  // ============ NEW CATEGORY MODAL ============
  _bindCategoryModal() {
    document.getElementById('btn-cancel-new-cat').addEventListener('click', () => this._closeModal('modal-new-category'));
    document.getElementById('btn-save-new-cat').addEventListener('click', () => this._saveNewCategory());
    document.getElementById('new-cat-name').addEventListener('input', () => {
      // Auto-fill label from name
      const name = document.getElementById('new-cat-name').value.trim();
      const labelEl = document.getElementById('new-cat-label');
      if (!labelEl._userEdited) {
        labelEl.value = name.toUpperCase().slice(0, 4);
      }
    });
    document.getElementById('new-cat-label').addEventListener('input', () => {
      document.getElementById('new-cat-label')._userEdited = true;
    });
  }

  _openNewCategoryModal(returnTo) {
    this._catReturnTo = returnTo;
    document.getElementById('new-cat-name').value = '';
    document.getElementById('new-cat-label').value = '';
    document.getElementById('new-cat-label')._userEdited = false;
    document.getElementById('new-cat-color').value = '#8B5CF6';
    document.getElementById('modal-new-category').classList.remove('hidden');
    document.getElementById('new-cat-name').focus();
  }

  async _saveNewCategory() {
    const name = document.getElementById('new-cat-name').value.trim();
    if (!name) return;
    const label = document.getElementById('new-cat-label').value.trim().toUpperCase() || name.toUpperCase().slice(0, 4);
    const color = document.getElementById('new-cat-color').value;
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const result = await this.data.addCategory({ id, name, label, color });
    if (!result) { alert('A category with that name already exists.'); return; }

    this._closeModal('modal-new-category');

    // Refresh whichever modal we came from, selecting the new category.
    if (this._catReturnTo === 'note') {
      this._populateCategorySelect('note-category');
      document.getElementById('note-category').value = id;
      this._applyAutoColor();
    } else if (this._catReturnTo === 'project') {
      const checked = Array.from(document.querySelectorAll('.project-cat-checkbox:checked')).map(cb => cb.value);
      this._populateProjectCategories([...checked, id]);
      this._updateProjectColorFromCategories();
    }

    window.dispatchEvent(new CustomEvent('categories-changed'));
  }

  // ============ HELPERS ============
  _closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  _bindCloseOnOverlay() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });
  }
}
