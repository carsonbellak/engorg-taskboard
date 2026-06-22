// Notes Kanban Board - renders into #view-board

const BOARD_COLUMNS = [
  { key: 'backlog',    label: 'Backlog',     showAdd: true },
  { key: 'inProgress', label: 'In Progress', showAdd: false },
  { key: 'review',     label: 'Review',      showAdd: false },
  { key: 'done',       label: 'Done',        showAdd: false }
];

class NotesBoard {
  constructor(dm) {
    this.data = dm;
    this.selectedProject = 'all';
  }

  render(selectedProject) {
    this.selectedProject = selectedProject || 'all';
    const container = document.getElementById('view-board');

    // Preserve per-column scroll positions across the full re-render (drag-moves
    // and Firebase sync both re-render the board and would otherwise reset scroll).
    const savedScroll = {};
    container.querySelectorAll('.kanban-cards').forEach(el => {
      savedScroll[el.dataset.status] = el.scrollTop;
    });

    // Build column HTML
    container.innerHTML = `<div class="notes-board">${BOARD_COLUMNS.map(col => `
      <div class="kanban-column" data-status="${col.key}">
        <div class="kanban-header">
          <h3>${col.label}</h3>
          <span class="kanban-count" data-count="${col.key}">0</span>
        </div>
        <div class="kanban-cards" data-status="${col.key}"></div>
        ${col.showAdd ? '<button class="kanban-add-btn board-add-note-btn">+ Add Note</button>' : ''}
      </div>
    `).join('')}</div>`;

    // Populate cards per column
    BOARD_COLUMNS.forEach(col => {
      const cardsEl = container.querySelector(`.kanban-cards[data-status="${col.key}"]`);
      const countEl = container.querySelector(`.kanban-count[data-count="${col.key}"]`);

      let notes = this.data.tasks.filter(t => {
        const status = t.status || (t.completed ? 'done' : 'backlog');
        return status === col.key;
      });

      // Apply project filter
      if (this.selectedProject !== 'all') {
        notes = notes.filter(n => n.projectId === this.selectedProject);
      }

      // Apply quick filters
      if (this.activeFilters?.priority) notes = notes.filter(n => n.priority === this.activeFilters.priority);
      if (this.activeFilters?.overdue) notes = notes.filter(n => isOverdue(n));
      if (this.activeFilters?.category) notes = notes.filter(n => n.category === this.activeFilters.category);

      // Sort within this column individually, honoring the active sort mode
      this._sortNotes(notes);

      countEl.textContent = notes.length;
      notes.forEach(note => cardsEl.appendChild(this._createCard(note)));
    });

    // Restore the per-column scroll positions captured before the re-render.
    container.querySelectorAll('.kanban-cards').forEach(el => {
      if (savedScroll[el.dataset.status] != null) el.scrollTop = savedScroll[el.dataset.status];
    });

    // Drag and drop
    this._bindDragDrop(container);

    // Add note button
    const addBtn = container.querySelector('.board-add-note-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('board-add-note'));
      });
    }
  }

  // Sort a single column's notes by the active sort mode (mirrors taskboard.js),
  // with color then title as tie-breakers.
  _sortNotes(notes) {
    const priorityOrder = { 'High': 0, 'Medium': 1, 'Low': 2 };
    const sortMode = this.sortMode || 'priority';
    const colorMode = this.colorMode || 'category';
    const projects = this.data.projects;

    const colorCache = new Map();
    notes.forEach(n => colorCache.set(n, resolveAutoColor(n, colorMode, projects)));

    notes.sort((a, b) => {
      let primary = 0;
      switch (sortMode) {
        case 'created':
          primary = new Date(b.createdAt || 0) - new Date(a.createdAt || 0); break;
        case 'created-asc':
          primary = new Date(a.createdAt || 0) - new Date(b.createdAt || 0); break;
        case 'due': {
          const da = a.dueDate ? new Date(a.dueDate) : new Date('2999-12-31');
          const db = b.dueDate ? new Date(b.dueDate) : new Date('2999-12-31');
          primary = da - db; break;
        }
        case 'alpha':
          primary = (a.title || '').localeCompare(b.title || ''); break;
        case 'color':
          primary = colorCache.get(a) - colorCache.get(b); break;
        case 'category':
          primary = (a.category || '').localeCompare(b.category || ''); break;
        case 'project': {
          const pa = projects.find(p => p.id === a.projectId);
          const pb = projects.find(p => p.id === b.projectId);
          primary = (pa?.name || '').localeCompare(pb?.name || ''); break;
        }
        case 'priority':
        default:
          primary = (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1); break;
      }
      if (primary !== 0) return primary;
      const secondary = colorCache.get(a) - colorCache.get(b);
      if (secondary !== 0) return secondary;
      return (a.title || '').localeCompare(b.title || '');
    });

    return notes;
  }

  _createCard(note) {
    const proj = this.data.projects.find(p => p.id === note.projectId);
    const effectiveIdx = resolveAutoColor(note, this.colorMode || 'category', this.data.projects);
    const c = getStickyColors()[effectiveIdx];
    const card = document.createElement('div');
    card.className = 'board-note-card' + (note.completed ? ' board-card-done' : '');
    card.draggable = true;
    card.dataset.noteId = note.id;
    card.style.borderLeftColor = c.border;
    card.style.background = c.bg;

    // Checklist progress
    let checklistHtml = '';
    if (note.checklist && note.checklist.length > 0) {
      const done = note.checklist.filter(cl => cl.done).length;
      checklistHtml = `<span class="board-card-checklist">&#9745; ${done}/${note.checklist.length}</span>`;
    }

    card.innerHTML = `
      <div class="board-card-header">
        <span class="board-card-title">${escapeHtml(note.title)}</span>
        <div class="board-card-actions">
          <button class="board-card-btn edit-btn" data-id="${note.id}" title="Edit">&#9998;</button>
          <button class="board-card-btn del-btn" data-id="${note.id}" title="Delete">&times;</button>
        </div>
      </div>
      <div class="board-card-meta">
        <span class="board-card-priority" style="color:${PRIORITY_COLORS[note.priority] || '#F97316'}">&#9679; ${note.priority || 'Medium'}</span>
        ${proj ? `<span class="board-card-project" style="color:${proj.color}">${escapeHtml(proj.name)}</span>` : ''}
        ${note.category ? `<span class="board-card-category">${CATEGORY_LABELS[note.category] || ''}</span>` : ''}
        ${checklistHtml}
        ${note.dueDate ? `<span class="board-card-due">${formatDateShort(note.dueDate)}</span>` : ''}
        ${isOverdue(note) ? '<span class="board-card-overdue">OVERDUE</span>' : ''}
      </div>
    `;

    // Drag events
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', note.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    // Edit button
    card.querySelector('.edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('edit-note', { detail: note }));
    });

    // Delete button
    card.querySelector('.del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.data.deleteTask(note.id);
      window.dispatchEvent(new CustomEvent('tasks-changed'));
    });

    // Double-click to edit
    card.addEventListener('dblclick', () => {
      window.dispatchEvent(new CustomEvent('edit-note', { detail: note }));
    });

    return card;
  }

  _bindDragDrop(container) {
    container.querySelectorAll('.kanban-column').forEach(col => {
      const cards = col.querySelector('.kanban-cards');

      cards.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drag-over');
      });

      cards.addEventListener('dragleave', (e) => {
        if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
      });

      cards.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        if (id && id.startsWith('note_')) {
          await this.data.updateTaskStatus(id, col.dataset.status);
          window.dispatchEvent(new CustomEvent('tasks-changed'));
        }
      });
    });
  }
}
