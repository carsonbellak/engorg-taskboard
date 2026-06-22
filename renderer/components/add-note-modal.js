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
    ).join('');
    // Rebind auto-color
    container.querySelectorAll('.project-cat-checkbox').forEach(cb => {
      cb.addEventListener('change', () => this._updateProjectColorFromCategories());
    });
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
    } else {
      heading.innerHTML = '&#128450; New Project';
      saveBtn.textContent = 'Create';
      document.getElementById('project-name-input').value = '';
      this._populateProjectCategories([]);
    }
    this._updateProjectColorPreview();

    document.getElementById('modal-add-project').classList.remove('hidden');
    document.getElementById('project-name-input').focus();
  }

  async _saveProject() {
    const name = document.getElementById('project-name-input').value.trim();
    if (!name) return;
    const categories = Array.from(document.querySelectorAll('.project-cat-checkbox:checked')).map(cb => cb.value);

    if (this._editingProjectId) {
      const duplicate = this.data.projects.some(p =>
        p.id !== this._editingProjectId && p.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) { alert('A project with that name already exists.'); return; }
      await this.data.updateProject(this._editingProjectId, { name, categories });
    } else {
      if (this.data.projects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        alert('Project already exists.'); return;
      }
      await this.data.addProject({ name, categories });
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

    // Refresh the dropdown if we came from note modal
    if (this._catReturnTo === 'note') {
      this._populateCategorySelect('note-category');
      document.getElementById('note-category').value = id;
      this._applyAutoColor();
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
