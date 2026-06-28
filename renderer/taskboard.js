// Renders Notes and Calendar views

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function getTodayDay() {
  const d = new Date().getDay();
  return DAYS[d === 0 ? 6 : d - 1];
}

class ViewRenderer {
  constructor(dm) {
    this.data = dm;
    this.selectedDay = getTodayDay();
    this.selectedProject = 'all';
    this.currentView = 'notes';
    // Calendar state
    this.calendarYear = new Date().getFullYear();
    this.calendarMonth = new Date().getMonth();
    this.calendarView = 'month'; // 'month' | 'week' | 'agenda'
    this.calendarWeekStart = this._getWeekStart(new Date());
  }

  getProject(id) {
    return this.data.projects.find(p => p.id === id);
  }

  // Filter notes by day and optionally by project
  filterByDayAndProject(items) {
    return items.filter(n =>
      (this.selectedProject === 'all' || n.projectId === this.selectedProject) &&
      n.day === this.selectedDay
    );
  }

  // ============ DAY COMPLETION STATUS ============
  getDayCompletionStatus(day) {
    const notes = (this.data.tasks || []).filter(t => t.day === day);
    const events = (this.data.scheduleItems || []).filter(s => s.day === day);

    const totalItems = notes.length + events.length;
    if (totalItems === 0) return 'none';

    const doneCount =
      notes.filter(n => n.completed).length +
      events.filter(e => e.completed).length;

    if (doneCount === totalItems) return 'complete';
    if (doneCount > 0) return 'partial';
    return 'empty';
  }

  // ============ RENDER DISPATCHER ============
  render() {
    if (this.currentView === 'projects') {
      this.renderProjectSlates();
    } else if (this.currentView === 'notes') {
      this.renderNotes();
    } else if (this.currentView === 'calendar') {
      this.renderCalendar();
    } else if (this.currentView === 'timeline') {
      this.renderTimeline();
    }
  }

  // ============ NOTES VIEW ============
  renderNotes() {
    const container = document.getElementById('view-notes');
    // Show all notes when "all" is selected, or filter by project
    let notes = this.selectedProject === 'all'
      ? [...this.data.tasks]
      : this.data.tasks.filter(n => n.projectId === this.selectedProject);

    // Apply quick filters
    if (this.activeFilters?.priority) notes = notes.filter(n => n.priority === this.activeFilters.priority);
    if (this.activeFilters?.overdue) notes = notes.filter(n => isOverdue(n));
    if (this.activeFilters?.category) notes = notes.filter(n => n.category === this.activeFilters.category);

    if (notes.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128204;</div><div class="empty-state-text">No notes yet. Add one!</div></div>';
      return;
    }

    // Sort: incomplete first, then by selected sort mode, then by color within group
    const priorityOrder = { 'High': 0, 'Medium': 1, 'Low': 2 };
    const sortMode = this.sortMode || 'priority';
    const colorMode = this.colorMode || 'category';
    const projects = this.data.projects;

    // Pre-compute effective color index for each note (used as secondary sort)
    const colorCache = new Map();
    notes.forEach(n => colorCache.set(n, resolveAutoColor(n, colorMode, projects)));

    notes.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
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
          const pa = this.getProject(a.projectId);
          const pb = this.getProject(b.projectId);
          primary = (pa?.name || '').localeCompare(pb?.name || ''); break;
        }
        case 'priority':
        default:
          primary = (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1); break;
      }
      // Secondary sort: color within each group
      if (primary !== 0) return primary;
      const secondary = colorCache.get(a) - colorCache.get(b);
      if (secondary !== 0) return secondary;
      // Tertiary sort: alphabetical
      return (a.title || '').localeCompare(b.title || '');
    });

    // Dynamic grouping based on sort mode
    const groups = this._buildGroups(notes, sortMode);

    container.innerHTML = '';

    groups.forEach(group => {
      if (group.notes.length === 0) return;

      // Section header
      const header = document.createElement('div');
      header.className = 'notes-section-header';
      header.innerHTML = `
        <span class="notes-section-dot" style="background:${group.color}"></span>
        <span class="notes-section-label">${group.label}</span>
        <span class="notes-section-count">${group.notes.length}</span>
      `;
      container.appendChild(header);

      // Grid of notes for this group
      const grid = document.createElement('div');
      grid.className = 'notes-grid';

      group.notes.forEach(note => {
      const effectiveIdx = resolveAutoColor(note, this.colorMode || 'category', this.data.projects);
      const c = getStickyColors()[effectiveIdx];
      const proj = this.getProject(note.projectId);
      const rotation = ((note.id ? note.id.charCodeAt(note.id.length - 1) : 0) % 3 - 1) * 1.2;

      const el = document.createElement('div');
      // Determine stale/old status for shake animations
      let staleClass = '';
      if (!note.completed) {
        const now = Date.now();
        const ageMs = now - new Date(note.createdAt).getTime();
        const staleMs = now - new Date(note.modifiedAt || note.createdAt).getTime();
        const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
        const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
        if (ageMs > ONE_MONTH) {
          staleClass = ' note-shiver';
        } else if (staleMs > ONE_WEEK) {
          staleClass = ' note-shake';
        }
      }
      el.className = 'sticky-note' + (note.completed ? ' note-done' : '') + (isOverdue(note) ? ' note-overdue' : '') + staleClass;
      el.style.background = c.bg;
      el.style.borderColor = c.border;
      el.style.setProperty('--rot', `${rotation}deg`);
      if (!staleClass) el.style.transform = `rotate(${rotation}deg)`;

      let linksHtml = '';
      if (note.links && note.links.length > 0) {
        linksHtml = '<div class="note-links">' +
          note.links.map(l => `<a href="#" class="note-link-chip" data-url="${escapeHtml(l.url)}">${escapeHtml(l.label || l.url)}</a>`).join('') +
          '</div>';
      }

      let attachmentsHtml = '';
      if (note.attachments && note.attachments.length > 0) {
        attachmentsHtml = '<div class="note-attachments">' +
          note.attachments.map(a =>
            `<a href="#" class="note-attachment-chip" data-path="${escapeHtml(a.path)}" title="${escapeHtml(a.path)}">&#128206; ${escapeHtml(a.name)}</a>`
          ).join('') +
          '</div>' +
          '<div class="note-attachment-preview"></div>';
      }

      let checklistHtml = '';
      if (note.checklist && note.checklist.length > 0) {
        const doneCount = note.checklist.filter(cl => cl.done).length;
        const totalCount = note.checklist.length;
        checklistHtml = `<div class="note-checklist">
          <div class="note-checklist-progress">${doneCount}/${totalCount}</div>
          ${note.checklist.map(cl => `
            <label class="note-checklist-item ${cl.done ? 'done' : ''}">
              <input type="checkbox" class="note-cl-toggle" data-note-id="${note.id}" data-cl-id="${cl.id}" ${cl.done ? 'checked' : ''}>
              <span>${escapeHtml(cl.text)}</span>
            </label>
          `).join('')}
        </div>`;
      }

      el.innerHTML = `
        <div class="note-top">
          <span class="note-project-badge" style="color: ${proj?.color || '#64748B'}">${proj ? escapeHtml(proj.name) : ''}</span>
          <div class="note-top-actions">
            <button class="note-check ${note.completed ? 'checked' : ''}" data-id="${note.id}" title="Mark complete">${note.completed ? '&#10003;' : ''}</button>
            <button class="note-close" data-id="${note.id}">&times;</button>
          </div>
        </div>
        <p class="note-text">${escapeHtml(note.title)}</p>
        ${note.description ? `<span class="note-desc-hint">...</span><div class="note-desc">${escapeHtml(note.description)}</div>` : ''}
        ${checklistHtml}
        ${linksHtml}
        ${attachmentsHtml}
        ${isOverdue(note) ? '<div class="note-overdue-badge">OVERDUE</div>' : ''}
        <div class="note-bottom">
          <span class="note-priority-dot" style="color: ${PRIORITY_COLORS[note.priority] || '#F97316'}">&#9679; ${note.priority || 'Medium'}</span>
          <span class="note-category-tag">${CATEGORY_LABELS[note.category] || ''}</span>
          <span class="note-day-tag">${note.day ? note.day.slice(0, 3) : ''}</span>
          ${note.dueDate ? `<span class="note-due-tag">${formatDateShort(note.dueDate)}${note.dueTime ? ' ' + formatTime12(note.dueTime) : ''}</span>` : ''}
        </div>
      `;

      // Completion toggle
      el.querySelector('.note-check').addEventListener('click', async (e) => {
        e.stopPropagation();
        const newCompleted = !note.completed;
        await this.data.updateTask(note.id, {
          completed: newCompleted,
          status: newCompleted ? 'done' : (note.status === 'done' ? 'backlog' : note.status)
        });
        window.dispatchEvent(new CustomEvent('tasks-changed'));
      });

      el.querySelector('.note-close').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.data.deleteTask(note.id);
        window.dispatchEvent(new CustomEvent('tasks-changed'));
      });

      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.note-close') || e.target.closest('.note-check') || e.target.closest('.note-link-chip') || e.target.closest('.note-cl-toggle') || e.target.closest('.note-attachment-chip')) return;
        window.dispatchEvent(new CustomEvent('edit-note', { detail: note }));
      });

      el.querySelectorAll('.note-link-chip').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          window.api.openExternal(link.dataset.url);
        });
      });

      // Checklist toggle handlers
      el.querySelectorAll('.note-cl-toggle').forEach(toggle => {
        toggle.addEventListener('click', async (e) => {
          e.stopPropagation();
          const noteId = toggle.dataset.noteId;
          const clId = toggle.dataset.clId;
          const task = this.data.tasks.find(t => t.id === noteId);
          if (task && task.checklist) {
            const item = task.checklist.find(cl => cl.id === clId);
            if (item) {
              item.done = !item.done;
              item.completedAt = item.done ? new Date().toISOString() : null;
              await this.data.updateTask(noteId, { checklist: task.checklist });
              window.dispatchEvent(new CustomEvent('tasks-changed'));
            }
          }
        });
      });

      // Attachment click handlers
      el.querySelectorAll('.note-attachment-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.api.openPath(chip.dataset.path);
        });
      });

      // Attachment hover preview - lazy load on first hover
      if (note.attachments && note.attachments.length > 0) {
        let previewLoaded = false;
        el.addEventListener('mouseenter', async () => {
          if (previewLoaded) return;
          previewLoaded = true;
          const previewEl = el.querySelector('.note-attachment-preview');
          if (!previewEl) return;

          const IMAGE_EXTS = ['png','jpg','jpeg','gif','svg','bmp','webp','ico','tiff','tif','avif'];
          const VIDEO_EXTS = ['mp4','webm','ogv','mov'];
          const TEXT_EXTS = ['txt','md','log','ini','cfg','conf','js','ts','py','c','cpp','h','json','xml','yaml','yml','html','css','sh','bat','sql'];

          for (const att of note.attachments) {
            const ext = (att.name.split('.').pop() || '').toLowerCase();
            const item = document.createElement('div');
            item.className = 'note-preview-item';

            if (IMAGE_EXTS.includes(ext)) {
              try {
                const fileUrl = await window.api.files.getFileUrl(att.path);
                item.innerHTML = `<img src="${fileUrl}" alt="${escapeHtml(att.name)}" class="note-preview-img">`;
              } catch {
                item.innerHTML = `<div class="note-preview-fallback">&#128206; ${escapeHtml(att.name)}</div>`;
              }
            } else if (VIDEO_EXTS.includes(ext)) {
              try {
                const fileUrl = await window.api.files.getFileUrl(att.path);
                item.innerHTML = `<video src="${fileUrl}" class="note-preview-video" muted preload="metadata"></video>`;
              } catch {
                item.innerHTML = `<div class="note-preview-fallback">&#127916; ${escapeHtml(att.name)}</div>`;
              }
            } else if (ext === 'pdf') {
              try {
                const fileUrl = await window.api.files.getFileUrl(att.path);
                item.innerHTML = `<embed src="${fileUrl}" type="application/pdf" class="note-preview-pdf">`;
              } catch {
                item.innerHTML = `<div class="note-preview-fallback">&#128213; ${escapeHtml(att.name)}</div>`;
              }
            } else if (ext === 'docx') {
              try {
                const buffer = await window.api.files.readBinary(att.path);
                const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
                item.innerHTML = `<div class="note-preview-docx">${result.value}</div>`;
              } catch {
                item.innerHTML = `<div class="note-preview-fallback">&#128195; ${escapeHtml(att.name)}</div>`;
              }
            } else if (TEXT_EXTS.includes(ext)) {
              try {
                const text = await window.api.files.readText(att.path);
                const snippet = text.length > 500 ? text.slice(0, 500) + '...' : text;
                item.innerHTML = `<pre class="note-preview-text">${escapeHtml(snippet)}</pre>`;
              } catch {
                item.innerHTML = `<div class="note-preview-fallback">&#128196; ${escapeHtml(att.name)}</div>`;
              }
            } else {
              item.innerHTML = `<div class="note-preview-fallback">&#128206; ${escapeHtml(att.name)}</div>`;
            }

            previewEl.appendChild(item);
          }
        });
      }

      grid.appendChild(el);
      });

      container.appendChild(grid);
    });
  }

  // ============ DYNAMIC GROUPING ============
  _buildGroups(notes, sortMode) {
    // Always separate completed notes into their own group at the bottom
    const active = notes.filter(n => !n.completed);
    const completed = notes.filter(n => n.completed);

    let groups = [];

    switch (sortMode) {
      case 'priority':
      default:
        groups = [
          { key: 'High', label: 'High Priority', color: PRIORITY_COLORS['High'], notes: [] },
          { key: 'Medium', label: 'Medium Priority', color: PRIORITY_COLORS['Medium'], notes: [] },
          { key: 'Low', label: 'Low Priority', color: PRIORITY_COLORS['Low'], notes: [] },
        ];
        active.forEach(note => {
          const pri = note.priority || 'Medium';
          const idx = pri === 'High' ? 0 : pri === 'Low' ? 2 : 1;
          groups[idx].notes.push(note);
        });
        break;

      case 'created':
      case 'created-asc':
        groups = this._buildDateGroups(active, n => n.createdAt);
        break;

      case 'due':
        groups = this._buildDueDateGroups(active);
        break;

      case 'alpha': {
        // Group A-Z by first letter, combine rare letters
        const letterMap = {};
        active.forEach(note => {
          const ch = (note.title || '?')[0].toUpperCase().replace(/[^A-Z]/, '#');
          if (!letterMap[ch]) letterMap[ch] = [];
          letterMap[ch].push(note);
        });
        const letters = Object.keys(letterMap).sort();
        // If more than 10, merge small groups
        if (letters.length > 10) {
          groups = this._mergeSmallGroups(letters.map(ch => ({
            key: ch, label: ch, notes: letterMap[ch]
          })), 10);
        } else {
          groups = letters.map(ch => ({ key: ch, label: ch, notes: letterMap[ch] }));
        }
        // Assign rainbow colors
        groups.forEach((g, i) => { g.color = rainbowColor(i, groups.length); });
        break;
      }

      case 'color': {
        const colorGroups = {};
        active.forEach(note => {
          const idx = resolveAutoColor(note, this.colorMode || 'category', this.data.projects);
          const c = getStickyColors()[idx];
          if (!colorGroups[idx]) colorGroups[idx] = { key: c.label, label: c.label, color: c.border, notes: [] };
          colorGroups[idx].notes.push(note);
        });
        groups = Object.values(colorGroups);
        break;
      }

      case 'category': {
        const catGroups = {};
        active.forEach(note => {
          const catId = note.category || '_none';
          if (!catGroups[catId]) {
            const cat = getCategoryById(catId);
            catGroups[catId] = {
              key: catId,
              label: cat ? cat.name : 'Uncategorized',
              color: cat ? cat.color : '#94A3B8',
              notes: []
            };
          }
          catGroups[catId].notes.push(note);
        });
        groups = Object.values(catGroups);
        groups.sort((a, b) => a.label.localeCompare(b.label));
        break;
      }

      case 'project': {
        const projGroups = {};
        active.forEach(note => {
          const pid = note.projectId || '_none';
          if (!projGroups[pid]) {
            const proj = this.getProject(pid);
            projGroups[pid] = {
              key: pid,
              label: proj ? proj.name : 'No Project',
              color: proj ? proj.color : '#94A3B8',
              notes: []
            };
          }
          projGroups[pid].notes.push(note);
        });
        groups = Object.values(projGroups);
        groups.sort((a, b) => a.label.localeCompare(b.label));
        break;
      }
    }

    // Remove empty groups, add completed group
    groups = groups.filter(g => g.notes.length > 0);
    if (completed.length > 0) {
      groups.push({ key: 'completed', label: 'Completed', color: '#22C55E', notes: completed });
    }
    return groups;
  }

  // Build smart date groups — max 10 buckets with ascending time spans
  _buildDateGroups(notes, getDateFn) {
    if (notes.length === 0) return [];

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msDay = 86400000;

    // Define candidate buckets from fine to coarse
    const buckets = [
      { label: 'Today',         test: d => d >= today },
      { label: 'Yesterday',     test: d => d >= new Date(today - msDay) && d < today },
      { label: 'Last 3 Days',   test: d => d >= new Date(today - 3 * msDay) },
      { label: 'This Week',     test: d => d >= new Date(today - 7 * msDay) },
      { label: 'Last 2 Weeks',  test: d => d >= new Date(today - 14 * msDay) },
      { label: 'This Month',    test: d => d >= new Date(now.getFullYear(), now.getMonth(), 1) },
      { label: 'Last Month',    test: d => d >= new Date(now.getFullYear(), now.getMonth() - 1, 1) },
      { label: 'Last 3 Months', test: d => d >= new Date(now.getFullYear(), now.getMonth() - 3, 1) },
      { label: 'Last 6 Months', test: d => d >= new Date(now.getFullYear(), now.getMonth() - 6, 1) },
      { label: 'Older',         test: () => true },
    ];

    // Assign each note to the first bucket it fits
    const bucketNotes = buckets.map(() => []);
    notes.forEach(note => {
      const dateStr = getDateFn(note);
      const d = dateStr ? new Date(dateStr) : new Date(0);
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].test(d)) { bucketNotes[i].push(note); break; }
      }
    });

    // Only keep non-empty buckets, max 10
    const groups = [];
    for (let i = 0; i < buckets.length && groups.length < 10; i++) {
      if (bucketNotes[i].length > 0) {
        groups.push({ key: buckets[i].label, label: buckets[i].label, notes: bucketNotes[i] });
      }
    }

    // Assign rainbow colors
    groups.forEach((g, i) => { g.color = rainbowColor(i, groups.length); });
    return groups;
  }

  // Due date grouping — future-facing buckets
  _buildDueDateGroups(notes) {
    if (notes.length === 0) return [];

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msDay = 86400000;

    const buckets = [
      { label: 'Overdue',        color: '#EF4444', test: d => d < today },
      { label: 'Today',          color: '#F97316', test: d => d < new Date(+today + msDay) },
      { label: 'Tomorrow',       color: '#EAB308', test: d => d < new Date(+today + 2 * msDay) },
      { label: 'This Week',      color: '#22C55E', test: d => d < new Date(+today + 7 * msDay) },
      { label: 'Next Week',      color: '#3B82F6', test: d => d < new Date(+today + 14 * msDay) },
      { label: 'This Month',     color: '#8B5CF6', test: d => d < new Date(now.getFullYear(), now.getMonth() + 1, 1) },
      { label: 'Next Month',     color: '#6366F1', test: d => d < new Date(now.getFullYear(), now.getMonth() + 2, 1) },
      { label: 'Later',          color: '#64748B', test: d => true },
    ];

    const noDueBucket = { label: 'No Due Date', color: '#94A3B8', notes: [] };
    const bucketNotes = buckets.map(() => []);

    notes.forEach(note => {
      if (!note.dueDate) { noDueBucket.notes.push(note); return; }
      const d = new Date(note.dueDate + 'T' + (note.dueTime || '23:59'));
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].test(d)) { bucketNotes[i].push(note); break; }
      }
    });

    const groups = [];
    for (let i = 0; i < buckets.length; i++) {
      if (bucketNotes[i].length > 0) {
        groups.push({ key: buckets[i].label, label: buckets[i].label, color: buckets[i].color, notes: bucketNotes[i] });
      }
    }
    if (noDueBucket.notes.length > 0) groups.push(noDueBucket);
    return groups;
  }

  // Merge small groups to stay under maxGroups
  _mergeSmallGroups(groups, maxGroups) {
    while (groups.length > maxGroups) {
      // Find the two smallest adjacent groups and merge them
      let minSum = Infinity, minIdx = 0;
      for (let i = 0; i < groups.length - 1; i++) {
        const sum = groups[i].notes.length + groups[i + 1].notes.length;
        if (sum < minSum) { minSum = sum; minIdx = i; }
      }
      const a = groups[minIdx], b = groups[minIdx + 1];
      const merged = {
        key: a.key + '-' + b.key,
        label: a.key + ' - ' + b.key,
        notes: [...a.notes, ...b.notes]
      };
      groups.splice(minIdx, 2, merged);
    }
    return groups;
  }

  // ============ PROJECT SLATES (All Projects Dashboard / Projects tab) ============
  renderProjectSlates() {
    const container = document.getElementById('view-projects');
    const isArchiveView = this.selectedProject === 'all-archived';
    const projectList = isArchiveView ? this.data.archivedProjects : this.data.projects;
    const allGroups = (this.data.getProjectGroups && this.data.getProjectGroups()) || this.data.settings?.projectGroups || [];

    container.innerHTML = '';

    const makeGrid = (projects) => {
      const grid = document.createElement('div');
      grid.className = 'project-slates-grid';
      projects.forEach(project => grid.appendChild(this._createProjectSlate(project, isArchiveView)));
      return grid;
    };

    // A group section: header (name + count + ••• menu) and its slate grid.
    // The menu dispatches window CustomEvents handled centrally in app.js.
    const buildGroupSection = (g, members, { archived }) => {
      const section = document.createElement('div');
      section.className = 'project-group-section';
      const header = document.createElement('div');
      header.className = 'project-group-title';
      header.innerHTML = `
        <span class="project-group-dot" style="background:${g.color}"></span>
        <span class="project-group-name">${escapeHtml(g.name)}</span>
        <span class="project-group-title-count">${members.length}</span>
        <button class="slate-menu-btn" title="Group options">&#8226;&#8226;&#8226;</button>
        <div class="slate-dropdown hidden">
          ${archived ? `
            <button class="slate-dropdown-item" data-action="unarchive-group">&#128230; Unarchive group</button>
            <button class="slate-dropdown-item slate-dropdown-danger" data-action="delete-group">&#128465; Delete group</button>
          ` : `
            <button class="slate-dropdown-item" data-action="edit-group">&#9998; Edit</button>
            <button class="slate-dropdown-item" data-action="archive-group">&#128230; Archive</button>
            <button class="slate-dropdown-item slate-dropdown-danger" data-action="delete-group">&#128465; Delete group</button>
          `}
        </div>`;
      const menuBtn = header.querySelector('.slate-menu-btn');
      const dd = header.querySelector('.slate-dropdown');
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.slate-dropdown').forEach(d => { if (d !== dd) d.classList.add('hidden'); });
        dd.classList.toggle('hidden');
      });
      dd.querySelectorAll('.slate-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          dd.classList.add('hidden');
          window.dispatchEvent(new CustomEvent(item.dataset.action, { detail: { id: g.id } }));
        });
      });
      section.appendChild(header);
      if (members.length) section.appendChild(makeGrid(members));
      else section.insertAdjacentHTML('beforeend', '<div class="project-group-empty">No projects in this group.</div>');
      return section;
    };

    const ungroupedSection = (members) => {
      const section = document.createElement('div');
      section.className = 'project-group-section';
      section.innerHTML = `<div class="project-group-title project-group-title-ungrouped">Ungrouped <span class="project-group-title-count">${members.length}</span></div>`;
      section.appendChild(makeGrid(members));
      return section;
    };

    // ===== Archived overview: group archived projects by their group =====
    if (isArchiveView) {
      if (projectList.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128451;</div><div class="empty-state-text">No archived projects.</div></div>';
        return;
      }
      allGroups.forEach(g => {
        const members = projectList.filter(p => p.groupId === g.id);
        // Show a section if the group has archived members, or it's an archived
        // group with none (so an empty archived group can still be unarchived/deleted).
        if (members.length || g.archived) {
          container.appendChild(buildGroupSection(g, members, { archived: !!g.archived }));
        }
      });
      const ungrouped = projectList.filter(p => !p.groupId || !allGroups.find(g => g.id === p.groupId));
      if (ungrouped.length) {
        container.appendChild(container.children.length ? ungroupedSection(ungrouped) : makeGrid(ungrouped));
      }
      return;
    }

    // ===== Active overview: toolbar + a section per active group, then ungrouped =====
    const activeGroups = (this.data.getActiveProjectGroups && this.data.getActiveProjectGroups()) || allGroups.filter(g => !g.archived);

    const toolbar = document.createElement('div');
    toolbar.className = 'projects-toolbar';
    toolbar.innerHTML = `<button class="projects-add-group-btn" id="projects-add-group">&#43; Group</button>`;
    toolbar.querySelector('#projects-add-group').addEventListener('click', () => window.dispatchEvent(new CustomEvent('add-group')));
    container.appendChild(toolbar);

    if (projectList.length === 0 && activeGroups.length === 0) {
      container.insertAdjacentHTML('beforeend', '<div class="empty-state"><div class="empty-state-icon">&#128450;</div><div class="empty-state-text">No projects yet. Create one to get started!</div></div>');
      return;
    }

    activeGroups.forEach(g => {
      const members = projectList.filter(p => p.groupId === g.id);
      container.appendChild(buildGroupSection(g, members, { archived: false }));
    });

    const ungrouped = projectList.filter(p => !p.groupId || !activeGroups.find(g => g.id === p.groupId));
    if (ungrouped.length) {
      container.appendChild(activeGroups.length ? ungroupedSection(ungrouped) : makeGrid(ungrouped));
    }
  }

  // Build a single project slate card (used by the grouped + archived overviews)
  _createProjectSlate(project, isArchiveView) {
    {
      let notes, notesDone, events, purchases;
      if (isArchiveView) {
        notes = project._tasks || [];
        notesDone = notes.filter(n => n.completed).length;
        events = project._scheduleItems || [];
        purchases = project._purchases || [];
      } else {
        notes = this.data.tasks.filter(t => t.projectId === project.id);
        notesDone = notes.filter(n => n.completed).length;
        events = this.data.scheduleItems.filter(s => s.projectId === project.id);
        purchases = this.data.purchases.filter(p => p.projectId === project.id);
      }

      const totalItems = notes.length;
      const progress = totalItems > 0 ? Math.round((notesDone / totalItems) * 100) : 0;

      const catBadges = (project.categories || []).map(cat =>
        `<span class="slate-cat-badge" style="background:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}22; color:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}">${CATEGORY_LABELS[cat] || cat}</span>`
      ).join('');

      const card = document.createElement('div');
      card.className = `project-slate${isArchiveView ? ' project-slate-archived' : ''}`;
      card.style.borderLeftColor = project.color;

      const archivedDate = project.archivedAt ? new Date(project.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

      card.innerHTML = `
        <div class="slate-header">
          <span class="slate-dot" style="background:${project.color}${isArchiveView ? ';opacity:0.5' : ''}"></span>
          <h3 class="slate-name">${escapeHtml(project.name)}</h3>
          <button class="slate-menu-btn" data-project-id="${project.id}" title="Options">&#8226;&#8226;&#8226;</button>
          <div class="slate-dropdown hidden" data-project-id="${project.id}">
            ${isArchiveView ? `
              <button class="slate-dropdown-item" data-action="unarchive" data-project-id="${project.id}">&#128230; Unarchive</button>
              <button class="slate-dropdown-item slate-dropdown-danger" data-action="delete-archived" data-project-id="${project.id}">&#128465; Delete</button>
            ` : `
              <button class="slate-dropdown-item" data-action="edit" data-project-id="${project.id}">&#9998; Edit</button>
              <button class="slate-dropdown-item" data-action="archive" data-project-id="${project.id}">&#128230; Archive</button>
              <button class="slate-dropdown-item slate-dropdown-danger" data-action="delete" data-project-id="${project.id}">&#128465; Delete</button>
            `}
          </div>
        </div>
        ${catBadges ? `<div class="slate-categories">${catBadges}</div>` : ''}
        ${isArchiveView && archivedDate ? `<div class="slate-archived-date">Archived ${archivedDate}</div>` : ''}
        <div class="slate-stats">
          <div class="slate-stat">
            <span class="slate-stat-num">${notes.length}</span>
            <span class="slate-stat-label">Notes</span>
          </div>
          <div class="slate-stat">
            <span class="slate-stat-num">${events.length}</span>
            <span class="slate-stat-label">Events</span>
          </div>
          <div class="slate-stat">
            <span class="slate-stat-num">${purchases.length}</span>
            <span class="slate-stat-label">Orders</span>
          </div>
          <div class="slate-stat">
            <span class="slate-stat-num">${notesDone}</span>
            <span class="slate-stat-label">Done</span>
          </div>
        </div>
        <div class="slate-progress">
          <div class="slate-progress-bar">
            <div class="slate-progress-fill" style="width:${progress}%; background:${project.color}"></div>
          </div>
          <span class="slate-progress-text">${progress}% complete</span>
        </div>
      `;

      // Three-dots menu toggle
      const menuBtn = card.querySelector('.slate-menu-btn');
      const dropdown = card.querySelector('.slate-dropdown');
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.slate-dropdown').forEach(d => {
          if (d !== dropdown) d.classList.add('hidden');
        });
        dropdown.classList.toggle('hidden');
      });

      // Bind dropdown actions
      card.querySelectorAll('.slate-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.add('hidden');
          const action = item.dataset.action;
          if (action === 'edit') window.dispatchEvent(new CustomEvent('edit-project', { detail: project }));
          else if (action === 'delete') window.dispatchEvent(new CustomEvent('delete-project', { detail: project }));
          else if (action === 'archive') window.dispatchEvent(new CustomEvent('archive-project', { detail: project }));
          else if (action === 'unarchive') window.dispatchEvent(new CustomEvent('unarchive-project', { detail: { id: project.id } }));
          else if (action === 'delete-archived') window.dispatchEvent(new CustomEvent('delete-archived-project', { detail: { id: project.id } }));
        });
      });

      // Click card body to navigate into project (active only)
      if (!isArchiveView) {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.slate-menu-btn') || e.target.closest('.slate-dropdown')) return;
          window.dispatchEvent(new CustomEvent('select-project', { detail: project.id }));
        });
      }

      return card;
    }
  }

  // ============ CALENDAR VIEW ============
  renderCalendar() {
    this._renderCalendarView();
  }

  // ── Helpers ──────────────────────────────────────────────────────
  _getWeekStart(date) {
    const d = new Date(date);
    const dow = d.getDay(); // 0=Sun
    const diff = dow === 0 ? 6 : dow - 1; // Mon=0
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _dateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  _getDayItems(dateStr, dayName) {
    const events = this.data.scheduleItems.filter(item => {
      const matchDate = item.date === dateStr || (!item.date && item.day === dayName);
      const matchProj = this.selectedProject === 'all' || item.projectId === this.selectedProject;
      return matchDate && matchProj;
    }).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    const notes = this.data.tasks.filter(note => {
      return note.dueDate === dateStr &&
        (this.selectedProject === 'all' || note.projectId === this.selectedProject);
    });

    return { events, notes };
  }

  // ── Shared calendar header ────────────────────────────────────────
  _buildCalHeader(titleHtml) {
    return `<div class="calendar-header">
      <div class="calendar-nav">
        <button class="cal-nav-btn" id="cal-prev">&#8249;</button>
        <h2 class="cal-month-title">${titleHtml}</h2>
        <button class="cal-nav-btn" id="cal-next">&#8250;</button>
        <button class="cal-today-btn" id="cal-today">Today</button>
      </div>
      <div class="calendar-view-toggle">
        <button class="cal-view-btn ${this.calendarView==='month'?'active':''}" data-view="month">Month</button>
        <button class="cal-view-btn ${this.calendarView==='week'?'active':''}"  data-view="week">Week</button>
        <button class="cal-view-btn ${this.calendarView==='agenda'?'active':''}" data-view="agenda">Agenda</button>
      </div>
    </div>`;
  }

  _bindCalHeader(container) {
    const today = new Date();

    container.querySelectorAll('.cal-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.calendarView = btn.dataset.view;
        if (this.calendarView === 'week') {
          // Sync week to current month/day context
          this.calendarWeekStart = this._getWeekStart(new Date(this.calendarYear, this.calendarMonth, 1));
        }
        this._renderCalendarView();
      });
    });

    container.querySelector('#cal-today').addEventListener('click', () => {
      this.calendarYear  = today.getFullYear();
      this.calendarMonth = today.getMonth();
      this.calendarWeekStart = this._getWeekStart(today);
      this._renderCalendarView();
    });

    container.querySelector('#cal-prev').addEventListener('click', () => {
      if (this.calendarView === 'week') {
        this.calendarWeekStart = new Date(this.calendarWeekStart.getTime() - 7 * 86400000);
      } else if (this.calendarView === 'agenda') {
        this.calendarMonth--;
        if (this.calendarMonth < 0) { this.calendarMonth = 11; this.calendarYear--; }
      } else {
        this.calendarMonth--;
        if (this.calendarMonth < 0) { this.calendarMonth = 11; this.calendarYear--; }
      }
      this._renderCalendarView();
    });

    container.querySelector('#cal-next').addEventListener('click', () => {
      if (this.calendarView === 'week') {
        this.calendarWeekStart = new Date(this.calendarWeekStart.getTime() + 7 * 86400000);
      } else if (this.calendarView === 'agenda') {
        this.calendarMonth++;
        if (this.calendarMonth > 11) { this.calendarMonth = 0; this.calendarYear++; }
      } else {
        this.calendarMonth++;
        if (this.calendarMonth > 11) { this.calendarMonth = 0; this.calendarYear++; }
      }
      this._renderCalendarView();
    });
  }

  // ── Dispatcher ───────────────────────────────────────────────────
  _renderCalendarView() {
    const container = document.getElementById('view-calendar');
    if (this.calendarView === 'week')   return this._renderWeekView(container);
    if (this.calendarView === 'agenda') return this._renderAgendaView(container);
    this._renderMonthView(container);
  }

  // ── MONTH VIEW ───────────────────────────────────────────────────
  _renderMonthView(container) {
    const year  = this.calendarYear;
    const month = this.calendarMonth;
    const today = new Date();
    const monthNames = ['January','February','March','April','May','June',
      'July','August','September','October','November','December'];

    const firstDay   = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let startDow = firstDay.getDay();
    startDow = startDow === 0 ? 6 : startDow - 1;

    let html = `<div class="calendar-container">`;
    html += this._buildCalHeader(`${monthNames[month]} ${year}`);

    html += `<div class="calendar-grid"><div class="cal-dow-row">`;
    ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d => {
      html += `<div class="cal-dow-header">${d}</div>`;
    });
    html += `</div><div class="cal-days-grid">`;

    for (let i = 0; i < startDow; i++) html += `<div class="cal-day-cell cal-empty"></div>`;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const dateStr = this._dateStr(dateObj);
      const dayName = DAYS[dateObj.getDay() === 0 ? 6 : dateObj.getDay() - 1];
      const isToday = dateObj.toDateString() === today.toDateString();
      const isPast  = dateObj < new Date(today.getFullYear(), today.getMonth(), today.getDate());

      const { events: dayEvents, notes: dayNotes } = this._getDayItems(dateStr, dayName);
      const allItems = [...dayEvents, ...dayNotes];

      let completionClass = '';
      if (dayNotes.length > 0) {
        completionClass = dayNotes.every(n => n.completed) ? 'cal-day-all-done' : 'cal-day-incomplete';
      } else if (isPast) {
        completionClass = 'cal-day-all-done';
      }

      html += `<div class="cal-day-cell ${isToday ? 'cal-today' : ''} ${completionClass}" data-date="${dateStr}" data-day-name="${dayName}">
        <div class="cal-day-number">${day}</div>
        <div class="cal-day-events">`;

      const maxShow = 3;
      dayEvents.slice(0, maxShow).forEach(item => {
        const proj = this.getProject(item.projectId);
        const timeStr = item.startTime ? `${formatTime12(item.startTime)} ` : '';
        html += `<div class="cal-event-dot" style="background:${proj?.color || '#3B82F6'}">
          <span class="cal-event-text">${timeStr}${escapeHtml(item.title)}</span>
        </div>`;
      });

      const noteSlots = maxShow - Math.min(dayEvents.length, maxShow);
      dayNotes.slice(0, noteSlots).forEach(note => {
        const proj = this.getProject(note.projectId);
        const timeStr = note.dueTime ? `${formatTime12(note.dueTime)} ` : '';
        html += `<div class="cal-event-dot cal-note-dot" style="background:${proj?.color || '#6366F1'}88">
          <span class="cal-event-text">${timeStr}&#128204; ${escapeHtml(note.title)}</span>
        </div>`;
      });

      if (allItems.length > maxShow) {
        html += `<div class="cal-more-events">+${allItems.length - maxShow} more</div>`;
      }

      html += `</div></div>`;
    }

    html += `</div></div></div>`;
    container.innerHTML = html;
    this._bindCalHeader(container);

    container.querySelectorAll('.cal-day-cell:not(.cal-empty)').forEach(cell => {
      cell.addEventListener('click', () => this._showDayExpanded(cell.dataset.date, cell.dataset.dayName));
    });
  }

  // ── WEEK VIEW ────────────────────────────────────────────────────
  _renderWeekView(container) {
    const today      = new Date();
    const weekStart  = this.calendarWeekStart;
    const HOUR_H     = 56; // px per hour
    const START_HOUR = 6;
    const END_HOUR   = 22;
    const HOURS      = END_HOUR - START_HOUR;

    // Build 7-day array
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart.getTime() + i * 86400000);
      return { date: d, dateStr: this._dateStr(d), dayName: DAYS[i] };
    });

    const weekEnd   = weekDays[6].date;
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rangeTitle = weekDays[0].date.getMonth() === weekEnd.getMonth()
      ? `${monthNames[weekDays[0].date.getMonth()]} ${weekDays[0].date.getDate()}–${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
      : `${monthNames[weekDays[0].date.getMonth()]} ${weekDays[0].date.getDate()} – ${monthNames[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;

    // Collect all-day items and timed items per day
    const dayData = weekDays.map(({ dateStr, dayName }) => this._getDayItems(dateStr, dayName));

    let html = `<div class="calendar-container cal-week-container">`;
    html += this._buildCalHeader(rangeTitle);

    // Column headers
    html += `<div class="cal-week-header">
      <div class="cal-week-gutter"></div>`;
    weekDays.forEach(({ date, dateStr }, i) => {
      const isToday = date.toDateString() === today.toDateString();
      html += `<div class="cal-week-col-head ${isToday ? 'cal-week-today-head' : ''}" data-date="${dateStr}">
        <div class="cal-week-dow">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</div>
        <div class="cal-week-date-num ${isToday ? 'cal-week-date-today' : ''}">${date.getDate()}</div>
      </div>`;
    });
    html += `</div>`;

    // All-day strip
    const hasAllDay = dayData.some(d => d.notes.filter(n => !n.dueTime).length > 0);
    if (hasAllDay) {
      html += `<div class="cal-week-allday-row">
        <div class="cal-week-gutter cal-week-allday-label">All day</div>`;
      dayData.forEach(({ notes }, i) => {
        const { dateStr } = weekDays[i];
        html += `<div class="cal-week-allday-cell" data-date="${dateStr}">`;
        notes.filter(n => !n.dueTime).forEach(note => {
          const proj = this.getProject(note.projectId);
          html += `<div class="cal-week-allday-event" style="background:${proj?.color||'#6366F1'}22;border-left:3px solid ${proj?.color||'#6366F1'}">
            &#128204; ${escapeHtml(note.title)}
          </div>`;
        });
        html += `</div>`;
      });
      html += `</div>`;
    }

    // Scrollable time grid
    html += `<div class="cal-week-body-wrap"><div class="cal-week-body">`;

    // Time gutter
    html += `<div class="cal-week-gutter cal-week-time-col">`;
    for (let h = START_HOUR; h < END_HOUR; h++) {
      const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
      html += `<div class="cal-week-hour-label" style="height:${HOUR_H}px">${label}</div>`;
    }
    html += `</div>`;

    // Day columns
    weekDays.forEach(({ date, dateStr, dayName }, ci) => {
      const isToday = date.toDateString() === today.toDateString();
      const { events, notes } = dayData[ci];

      html += `<div class="cal-week-day-col ${isToday ? 'cal-week-col-today' : ''}" data-date="${dateStr}" data-day-name="${dayName}" style="height:${HOURS * HOUR_H}px">`;

      // Hour lines
      for (let h = 0; h < HOURS; h++) {
        html += `<div class="cal-week-hour-line" style="top:${h * HOUR_H}px"></div>`;
      }

      // Current time indicator
      if (isToday) {
        const now = new Date();
        const mins = (now.getHours() - START_HOUR) * 60 + now.getMinutes();
        if (mins >= 0 && mins <= HOURS * 60) {
          const top = (mins / 60) * HOUR_H;
          html += `<div class="cal-week-now-line" style="top:${top}px"></div>`;
        }
      }

      // Timed events
      events.filter(e => e.startTime).forEach(item => {
        const proj = this.getProject(item.projectId);
        const [sh, sm] = (item.startTime || '00:00').split(':').map(Number);
        const [eh, em] = (item.endTime   || item.startTime || '00:30').split(':').map(Number);
        const topMins  = (sh - START_HOUR) * 60 + sm;
        const durMins  = Math.max(30, (eh * 60 + em) - (sh * 60 + sm));
        if (topMins < 0 || topMins > HOURS * 60) return;
        const top  = (topMins / 60) * HOUR_H;
        const height = Math.min((durMins / 60) * HOUR_H, (HOURS * 60 - topMins) / 60 * HOUR_H);
        html += `<div class="cal-week-event" data-id="${item.id}"
          style="top:${top}px;height:${height-2}px;background:${proj?.color||'#3B82F6'};border-color:${proj?.color||'#3B82F6'}">
          <div class="cal-week-event-title">${escapeHtml(item.title)}</div>
          <div class="cal-week-event-time">${formatTime12(item.startTime)}${item.endTime ? '–'+formatTime12(item.endTime) : ''}</div>
        </div>`;
      });

      // Timed notes
      notes.filter(n => n.dueTime).forEach(note => {
        const proj = this.getProject(note.projectId);
        const [h, m] = (note.dueTime || '00:00').split(':').map(Number);
        const topMins = (h - START_HOUR) * 60 + m;
        if (topMins < 0 || topMins > HOURS * 60) return;
        const top = (topMins / 60) * HOUR_H;
        html += `<div class="cal-week-event cal-week-note" data-id="${note.id}"
          style="top:${top}px;height:28px;background:${proj?.color||'#6366F1'}22;border-color:${proj?.color||'#6366F1'}">
          <div class="cal-week-event-title">&#128204; ${escapeHtml(note.title)}</div>
        </div>`;
      });

      html += `</div>`; // day col
    });

    html += `</div></div>`; // body + wrap
    html += `</div>`; // calendar-container

    container.innerHTML = html;
    this._bindCalHeader(container);

    // Click column header → show day detail
    container.querySelectorAll('.cal-week-col-head').forEach(el => {
      el.addEventListener('click', () => {
        const d = new Date(el.dataset.date + 'T00:00:00');
        const dayName = DAYS[d.getDay() === 0 ? 6 : d.getDay() - 1];
        this._showDayExpanded(el.dataset.date, dayName);
      });
    });

    // Click empty area in column → open new event modal pre-filled
    container.querySelectorAll('.cal-week-day-col').forEach(col => {
      col.addEventListener('click', (e) => {
        if (e.target.closest('.cal-week-event')) return;
        const rect = col.getBoundingClientRect();
        const y    = e.clientY - rect.top;
        const totalMins = (y / HOUR_H) * 60;
        const hour = Math.floor(totalMins / 60) + START_HOUR;
        const min  = Math.round((totalMins % 60) / 15) * 15;
        const timeStr = `${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
        window.dispatchEvent(new CustomEvent('cal-new-event', {
          detail: { date: col.dataset.date, time: timeStr }
        }));
      });
    });

    // Scroll to 8am on first render
    const bodyWrap = container.querySelector('.cal-week-body-wrap');
    if (bodyWrap) bodyWrap.scrollTop = (8 - START_HOUR) * HOUR_H;
  }

  // ── AGENDA VIEW ──────────────────────────────────────────────────
  _renderAgendaView(container) {
    const today  = new Date();
    const monthNames = ['January','February','March','April','May','June',
      'July','August','September','October','November','December'];
    const year  = this.calendarYear;
    const month = this.calendarMonth;

    // Show full month
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const items = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const dateStr = this._dateStr(dateObj);
      const dayName = DAYS[dateObj.getDay() === 0 ? 6 : dateObj.getDay() - 1];
      const { events, notes } = this._getDayItems(dateStr, dayName);
      if (events.length || notes.length) {
        items.push({ dateObj, dateStr, dayName, events, notes });
      }
    }

    let html = `<div class="calendar-container">`;
    html += this._buildCalHeader(`${monthNames[month]} ${year}`);
    html += `<div class="cal-agenda">`;

    if (items.length === 0) {
      html += `<div class="cal-agenda-empty">No events this month.</div>`;
    } else {
      items.forEach(({ dateObj, dateStr, dayName, events, notes }) => {
        const isToday = dateObj.toDateString() === today.toDateString();
        const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        html += `<div class="cal-agenda-day ${isToday ? 'cal-agenda-today' : ''}" data-date="${dateStr}">
          <div class="cal-agenda-date-col">
            <div class="cal-agenda-dow">${dayName.slice(0,3)}</div>
            <div class="cal-agenda-num ${isToday ? 'cal-agenda-num-today' : ''}">${dateObj.getDate()}</div>
          </div>
          <div class="cal-agenda-items">`;

        events.forEach(item => {
          const proj = this.getProject(item.projectId);
          const timeStr = item.startTime ? formatTime12(item.startTime) + (item.endTime ? ' – ' + formatTime12(item.endTime) : '') : 'All day';
          html += `<div class="cal-agenda-item" data-id="${item.id}" data-date="${dateStr}" data-day-name="${dayName}">
            <div class="cal-agenda-item-bar" style="background:${proj?.color||'#3B82F6'}"></div>
            <div class="cal-agenda-item-content">
              <div class="cal-agenda-item-title">${escapeHtml(item.title)}</div>
              <div class="cal-agenda-item-meta">
                ${timeStr}${proj ? ' · ' + escapeHtml(proj.name) : ''}
                ${item.source==='outlook'?'<span class="outlook-badge">Outlook</span>':''}
              </div>
            </div>
            ${item.completed ? '<span class="cal-agenda-done">&#10003;</span>' : ''}
          </div>`;
        });

        notes.forEach(note => {
          const proj = this.getProject(note.projectId);
          const timeStr = note.dueTime ? formatTime12(note.dueTime) : '';
          html += `<div class="cal-agenda-item cal-agenda-note" data-id="${note.id}" data-date="${dateStr}">
            <div class="cal-agenda-item-bar" style="background:${proj?.color||'#6366F1'}"></div>
            <div class="cal-agenda-item-content">
              <div class="cal-agenda-item-title">&#128204; ${escapeHtml(note.title)}</div>
              <div class="cal-agenda-item-meta">
                ${timeStr}${timeStr&&proj?' · ':''}${proj ? escapeHtml(proj.name) : ''}
              </div>
            </div>
            ${note.completed ? '<span class="cal-agenda-done">&#10003;</span>' : ''}
          </div>`;
        });

        html += `</div></div>`; // items + agenda-day
      });
    }

    html += `</div></div>`; // agenda + container
    container.innerHTML = html;
    this._bindCalHeader(container);

    // Click agenda day → expand detail
    container.querySelectorAll('.cal-agenda-day').forEach(row => {
      row.addEventListener('click', () => {
        const d = new Date(row.dataset.date + 'T00:00:00');
        const dn = DAYS[d.getDay() === 0 ? 6 : d.getDay() - 1];
        this._showDayExpanded(row.dataset.date, dn);
      });
    });
  }

  _getNotesForMonth(year, month) {
    // Only show notes that have a due date in this month
    return this.data.tasks.filter(note => {
      if (!note.dueDate) return false;
      const d = new Date(note.dueDate + 'T00:00:00');
      return d.getFullYear() === year && d.getMonth() === month;
    });
  }

  _getEventsForMonth(year, month) {
    return this.data.scheduleItems.filter(item => {
      if (item.date) {
        const d = new Date(item.date + 'T00:00:00');
        return d.getFullYear() === year && d.getMonth() === month;
      }
      return true; // recurring weekly
    });
  }

  _showDayExpanded(dateStr, dayName) {
    const existing = document.querySelector('.cal-day-detail');
    if (existing) existing.remove();

    // Gather events for this day
    const events = this.data.scheduleItems.filter(item => {
      if (item.date === dateStr) return true;
      if (!item.date && item.day === dayName) return true;
      return false;
    }).filter(item =>
      this.selectedProject === 'all' || item.projectId === this.selectedProject
    ).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    // Gather notes for this day (only notes with matching dueDate)
    const notes = this.data.tasks.filter(note => {
      return note.dueDate === dateStr;
    }).filter(note =>
      this.selectedProject === 'all' || note.projectId === this.selectedProject
    );

    const detail = document.createElement('div');
    detail.className = 'cal-day-detail';

    const dateLabel = new Date(dateStr + 'T00:00:00');
    const formattedDate = dateLabel.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    let html = `<div class="cal-detail-header">
      <h3>${formattedDate}</h3>
      <button class="cal-detail-close">&times;</button>
    </div>`;

    if (events.length === 0 && notes.length === 0) {
      html += `<p class="cal-detail-empty">No items for this day.</p>`;
    } else {
      // Events section
      if (events.length > 0) {
        html += `<div class="cal-detail-section-label">Events</div>`;
        html += `<div class="schedule-list">`;
        events.forEach(item => {
          const proj = this.getProject(item.projectId);
          html += `<div class="schedule-card ${item.completed ? 'done' : ''}" style="border-left-color: ${proj?.color || '#3B82F6'}">
            <button class="schedule-check ${item.completed ? 'checked' : ''}" data-id="${item.id}">${item.completed ? '&#10003;' : ''}</button>
            <div class="schedule-time">
              <div class="schedule-time-start">${formatTime12(item.startTime)}</div>
              <div class="schedule-time-end">&rarr; ${formatTime12(item.endTime)}</div>
            </div>
            <div class="schedule-info">
              <div class="schedule-title">${escapeHtml(item.title)}</div>
              ${item.description ? `<div class="schedule-desc">${escapeHtml(item.description)}</div>` : ''}
              <div class="schedule-project-name" style="color: ${proj?.color || '#64748B'}">${proj ? escapeHtml(proj.name) : ''}</div>
              ${item.date ? '<span class="cal-event-type-badge">One-time</span>' : '<span class="cal-event-type-badge recurring">Weekly</span>'}
              ${item.source === 'outlook' ? '<span class="outlook-badge">Outlook</span>' : ''}
            </div>
            <button class="schedule-close" data-id="${item.id}">&times;</button>
          </div>`;
        });
        html += `</div>`;
      }

      // Notes section
      if (notes.length > 0) {
        html += `<div class="cal-detail-section-label" style="margin-top:12px">Notes</div>`;
        html += `<div class="schedule-list">`;
        notes.forEach(note => {
          const proj = this.getProject(note.projectId);
          html += `<div class="schedule-card ${note.completed ? 'done' : ''}" style="border-left-color: ${proj?.color || '#6366F1'}">
            <button class="schedule-check ${note.completed ? 'checked' : ''}" data-id="${note.id}" data-type="note">${note.completed ? '&#10003;' : ''}</button>
            ${note.dueTime ? `<div class="schedule-time"><div class="schedule-time-start">${formatTime12(note.dueTime)}</div></div>` : ''}
            <div class="schedule-info">
              <div class="schedule-title">&#128204; ${escapeHtml(note.title)}</div>
              ${note.description ? `<div class="schedule-desc">${escapeHtml(note.description)}</div>` : ''}
              <div class="schedule-project-name" style="color: ${proj?.color || '#64748B'}">${proj ? escapeHtml(proj.name) : ''}</div>
            </div>
            <span class="note-priority-dot" style="color: ${PRIORITY_COLORS[note.priority] || '#F97316'}">&#9679; ${note.priority || 'Medium'}</span>
          </div>`;
        });
        html += `</div>`;
      }
    }

    detail.innerHTML = html;
    document.querySelector('.calendar-container').appendChild(detail);

    detail.querySelector('.cal-detail-close').addEventListener('click', () => detail.remove());

    // Bind event completion toggles
    detail.querySelectorAll('.schedule-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.type === 'note') {
          const note = this.data.tasks.find(t => t.id === btn.dataset.id);
          if (note) {
            await this.data.updateTask(btn.dataset.id, { completed: !note.completed });
            window.dispatchEvent(new CustomEvent('tasks-changed'));
          }
        } else {
          await this.data.toggleScheduleItem(btn.dataset.id);
          window.dispatchEvent(new CustomEvent('schedule-changed'));
        }
      });
    });

    detail.querySelectorAll('.schedule-close').forEach(btn => {
      btn.addEventListener('click', async () => {
        await this.data.deleteScheduleItem(btn.dataset.id);
        window.dispatchEvent(new CustomEvent('schedule-changed'));
      });
    });
  }

  // ============ TIMELINE VIEW ============
  renderTimeline() {
    const container = document.getElementById('view-timeline');

    // Collect all items with timestamps
    const events = [];

    // Notes: created tile, completed tile, and checklist completion tiles
    this.data.tasks.forEach(note => {
      if (this.selectedProject !== 'all' && note.projectId !== this.selectedProject) return;
      const proj = this.getProject(note.projectId);

      // Created tile
      events.push({
        date: note.createdAt || '2024-01-01T00:00:00Z',
        type: 'note-created',
        icon: '\u{1F4DD}',
        title: note.title,
        subtitle: proj ? proj.name : '',
        color: proj?.color || '#6366F1',
        completed: note.completed,
        category: note.category,
        priority: note.priority,
        day: note.day
      });

      // Completed tile (separate from created)
      if (note.completedAt) {
        events.push({
          date: note.completedAt,
          type: 'note-completed',
          icon: '\u2705',
          title: 'Completed: ' + note.title,
          subtitle: proj ? proj.name : '',
          color: '#22C55E',
          completed: true
        });
      }

      // Checklist item completions
      if (note.checklist) {
        note.checklist.forEach(cl => {
          if (cl.done && cl.completedAt) {
            events.push({
              date: cl.completedAt,
              type: 'checklist-completed',
              icon: '\u2611\uFE0F',
              title: cl.text,
              subtitle: (proj ? proj.name + ' \u00B7 ' : '') + note.title,
              color: '#16A34A',
              completed: true
            });
          }
        });
      }

      // Status change history
      if (note.statusHistory) {
        note.statusHistory.forEach(entry => {
          if (entry.to === 'done') return; // already shown as note-completed
          events.push({
            type: 'status-changed',
            date: entry.date,
            icon: '\u{1F504}',
            title: note.title,
            subtitle: proj ? proj.name : '',
            color: '#6366F1',
            fromLabel: STATUS_LABELS[entry.from] || entry.from,
            toLabel: STATUS_LABELS[entry.to] || entry.to
          });
        });
      }
    });

    // Schedule events created
    this.data.scheduleItems.forEach(item => {
      if (this.selectedProject !== 'all' && item.projectId !== this.selectedProject) return;
      const proj = this.getProject(item.projectId);
      events.push({
        date: item.createdAt || '2024-01-01T00:00:00Z',
        type: 'event-created',
        icon: '📅',
        title: item.title,
        subtitle: proj ? proj.name : '',
        color: proj?.color || '#3B82F6',
        completed: item.completed,
        day: item.day,
        time: item.startTime
      });
    });

    // Projects created
    this.data.projects.forEach(proj => {
      if (this.selectedProject !== 'all' && proj.id !== this.selectedProject) return;
      events.push({
        date: proj.createdAt || '2024-01-01T00:00:00Z',
        type: 'project-created',
        icon: '🚀',
        title: 'Project created: ' + proj.name,
        subtitle: (proj.categories || []).map(c => getCategoryLabel(c)).join(', '),
        color: proj.color
      });
    });

    // Purchases - only track waiting and arrived (not toPlace)
    this.data.purchases.forEach(pur => {
      if (this.selectedProject !== 'all' && pur.projectId !== this.selectedProject) return;
      if (pur.status === 'toPlace') return; // Skip orders not yet placed
      const proj = this.getProject(pur.projectId);
      events.push({
        date: pur.createdAt || '2024-01-01T00:00:00Z',
        type: 'purchase-created',
        icon: '📦',
        title: pur.item,
        subtitle: (proj ? proj.name + ' · ' : '') + (pur.supplier || 'Unknown supplier'),
        color: proj?.color || '#22C55E',
        cost: pur.cost,
        status: pur.status
      });
    });

    // Weekly summaries for past weeks
    const projFilter = p => this.selectedProject === 'all' || p.projectId === this.selectedProject;
    const weekMap = {};
    this.data.tasks.filter(projFilter).forEach(t => {
      if (t.completedAt) {
        const d = new Date(t.completedAt);
        const ws = new Date(d); ws.setDate(d.getDate() - d.getDay()); ws.setHours(0,0,0,0);
        const key = ws.toISOString().split('T')[0];
        if (!weekMap[key]) weekMap[key] = { completed: 0, created: 0, weekStart: ws };
        weekMap[key].completed++;
      }
      if (t.createdAt) {
        const d = new Date(t.createdAt);
        const ws = new Date(d); ws.setDate(d.getDate() - d.getDay()); ws.setHours(0,0,0,0);
        const key = ws.toISOString().split('T')[0];
        if (!weekMap[key]) weekMap[key] = { completed: 0, created: 0, weekStart: ws };
        weekMap[key].created++;
      }
    });
    const nowDate = new Date();
    Object.entries(weekMap).forEach(([key, w]) => {
      // Weekly summary appears Friday 4PM
      const friday = new Date(w.weekStart);
      friday.setDate(friday.getDate() + 5); // Sunday + 5 = Friday
      friday.setHours(16, 0, 0, 0);
      if (friday >= nowDate) return; // skip current/future weeks
      events.push({
        type: 'weekly-summary',
        date: friday.toISOString(),
        icon: '\u{1F4CB}',
        title: 'Weekly Summary',
        subtitle: `${w.completed} completed \u00B7 ${w.created} created`,
        color: '#8B5CF6'
      });
    });

    // GitHub commits (linked account → repos you own). Not project-scoped, so
    // only shown in the "All Projects" view to avoid cluttering project timelines.
    if (this.selectedProject === 'all') {
      (dataManager.settings.gitActivity || []).forEach(c => {
        if (!c.date) return;
        events.push({
          date: c.date,
          type: 'git-commit',
          icon: '\u{1F517}',
          title: c.message || '(no message)',
          subtitle: c.repo + (c.author ? ' · ' + c.author : ''),
          color: '#8957E5',
          repo: c.repo,
          url: c.url,
        });
      });
    }

    // Sort newest first
    events.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-text">No activity yet. Start creating notes and events!</div></div>';
      return;
    }

    // Group by date
    const grouped = {};
    events.forEach(ev => {
      const dateKey = new Date(ev.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(ev);
    });

    // Compute summary stats
    const totalNotes = this.data.tasks.filter(projFilter).length;
    const completedNotes = this.data.tasks.filter(t => projFilter(t) && t.completed).length;
    const totalEvents = this.data.scheduleItems.filter(projFilter).length;
    const totalPurchases = this.data.purchases.filter(p => projFilter(p) && p.status !== 'toPlace').length;
    const totalSpent = this.data.purchases
      .filter(p => projFilter(p) && p.status !== 'toPlace')
      .reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
    const stillToSpend = this.data.purchases
      .filter(p => projFilter(p) && p.status === 'toPlace')
      .reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
    const checklistTotal = this.data.tasks
      .filter(projFilter)
      .reduce((sum, t) => sum + (t.checklist ? t.checklist.length : 0), 0);
    const checklistDone = this.data.tasks
      .filter(projFilter)
      .reduce((sum, t) => sum + (t.checklist ? t.checklist.filter(c => c.done).length : 0), 0);
    const overdueNotes = this.data.tasks.filter(t => projFilter(t) && isOverdue(t)).length;

    let html = '<div class="timeline-container">';

    // Summary cards
    html += `<div class="timeline-summary">
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">${totalNotes}</div>
        <div class="timeline-stat-label">Total Notes</div>
      </div>
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">${completedNotes}</div>
        <div class="timeline-stat-label">Completed</div>
      </div>
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">${totalNotes > 0 ? Math.round((completedNotes / totalNotes) * 100) : 0}%</div>
        <div class="timeline-stat-label">Completion</div>
      </div>
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">${checklistDone}/${checklistTotal}</div>
        <div class="timeline-stat-label">Checklist</div>
      </div>
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">${totalEvents}</div>
        <div class="timeline-stat-label">Events</div>
      </div>
      ${(dataManager.settings.gitActivity || []).length ? `<div class="timeline-stat-card">
        <div class="timeline-stat-num" style="color:#8957E5">${dataManager.settings.gitActivity.length}</div>
        <div class="timeline-stat-label">Commits</div>
      </div>` : ''}
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">${totalPurchases}</div>
        <div class="timeline-stat-label">Orders</div>
      </div>
      <div class="timeline-stat-card">
        <div class="timeline-stat-num">$${totalSpent.toFixed(0)}</div>
        <div class="timeline-stat-label">Spent</div>
      </div>
      <div class="timeline-stat-card">
        <div class="timeline-stat-num" style="color:#D97706">$${stillToSpend.toFixed(0)}</div>
        <div class="timeline-stat-label">Still to Spend</div>
      </div>
      ${overdueNotes > 0 ? `<div class="timeline-stat-card">
        <div class="timeline-stat-num" style="color:#EF4444">${overdueNotes}</div>
        <div class="timeline-stat-label">Overdue</div>
      </div>` : ''}
    </div>`;

    // Timeline feed
    html += '<div class="timeline-feed">';
    Object.keys(grouped).forEach(dateKey => {
      html += `<div class="timeline-date-group">
        <div class="timeline-date-label">${dateKey}</div>`;

      grouped[dateKey].forEach(ev => {
        const timeStr = new Date(ev.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        let metaHtml = '';
        if (ev.type === 'note-created') {
          const catLabel = ev.category ? getCategoryLabel(ev.category) : '';
          metaHtml = `<span class="tl-meta">${ev.day || ''}${catLabel ? ' · ' + catLabel : ''}${ev.priority ? ' · ' + ev.priority : ''}</span>`;
          if (ev.completed) metaHtml += '<span class="tl-badge tl-done">Done</span>';
        } else if (ev.type === 'note-completed') {
          metaHtml = '<span class="tl-badge tl-done">Completed</span>';
        } else if (ev.type === 'checklist-completed') {
          metaHtml = '<span class="tl-badge tl-done">Checked Off</span>';
        } else if (ev.type === 'event-created') {
          metaHtml = `<span class="tl-meta">${ev.day || ''}${ev.time ? ' · ' + formatTime12(ev.time) : ''}</span>`;
          if (ev.completed) metaHtml += '<span class="tl-badge tl-done">Done</span>';
        } else if (ev.type === 'purchase-created') {
          const statusLabels = { toPlace: 'To Place', placed: 'Placed', shipped: 'Shipped', delivered: 'Delivered' };
          metaHtml = `<span class="tl-meta">${ev.cost ? '$' + Number(ev.cost).toFixed(2) : ''}</span>`;
          if (ev.status) metaHtml += `<span class="tl-badge tl-status-${ev.status}">${statusLabels[ev.status] || ev.status}</span>`;
        } else if (ev.type === 'status-changed') {
          metaHtml = `<span class="tl-badge tl-status-change">${ev.fromLabel} \u2192 ${ev.toLabel}</span>`;
        } else if (ev.type === 'weekly-summary') {
          metaHtml = `<span class="tl-badge tl-weekly">\u{1F4CB} ${ev.subtitle}</span>`;
        } else if (ev.type === 'git-commit') {
          metaHtml = `<span class="tl-badge tl-commit">${escapeHtml(ev.repo)}</span>`;
        }

        const isCompleted = ev.completed;
        const dotColor = isCompleted ? '#22C55E' : ev.color;
        const completedClass = isCompleted ? ' timeline-item-done' : '';

        const linkAttr = ev.url ? ` data-open-url="${escapeHtml(ev.url)}"` : '';
        html += `<div class="timeline-item${completedClass}${ev.url ? ' timeline-item-link' : ''}"${linkAttr}>
          <div class="timeline-dot" style="background:${dotColor}"></div>
          <div class="timeline-item-content${isCompleted ? ' timeline-content-done' : ''}">
            <div class="timeline-item-header">
              <span class="timeline-icon">${ev.icon}</span>
              <span class="timeline-item-title">${escapeHtml(ev.title)}</span>
              <span class="timeline-item-time">${timeStr}</span>
            </div>
            <div class="timeline-item-sub">${escapeHtml(ev.subtitle)}${metaHtml ? ' ' + metaHtml : ''}</div>
          </div>
        </div>`;
      });

      html += '</div>';
    });
    html += '</div></div>';

    container.innerHTML = html;

    // Commit (and other linked) items open externally on click.
    container.querySelectorAll('[data-open-url]').forEach(el =>
      el.addEventListener('click', () => window.api.openExternal(el.dataset.openUrl)));
  }

  // ============ UPDATE PROGRESS BAR ============
  updateProgress() {
    let allNotes;
    if (this.selectedProject === 'all') {
      // All projects: show progress for current day
      allNotes = (this.data.tasks || []).filter(t => t.day === this.selectedDay);
    } else {
      // Specific project: show progress for ALL notes in that project
      allNotes = (this.data.tasks || []).filter(t => t.projectId === this.selectedProject);
    }
    const done = allNotes.filter(t => t.completed).length;
    const total = allNotes.length;

    const progressEl = document.getElementById('sidebar-progress');
    if (total > 0) {
      progressEl.classList.remove('hidden');
      document.getElementById('progress-bar-fill').style.width = `${(done / total) * 100}%`;
      document.getElementById('progress-text').textContent = `${done}/${total} done`;
    } else {
      progressEl.classList.add('hidden');
    }

    // Compute streak — consecutive days with all tasks completed
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let streak = 0;
    const checkDate = new Date(todayDate);
    checkDate.setDate(checkDate.getDate() - 1); // start from yesterday

    for (let i = 0; i < 365; i++) {
      const dayName = DAY_NAMES[checkDate.getDay()];
      const dateStr = checkDate.toISOString().split('T')[0];
      const dayNotes = this.data.tasks.filter(t => {
        if (this.selectedProject !== 'all' && t.projectId !== this.selectedProject) return false;
        return t.day === dayName || t.dueDate === dateStr;
      });
      if (dayNotes.length > 0 && !dayNotes.every(t => t.completed)) break;
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    const streakEl = document.getElementById('sidebar-streak');
    if (streak > 0) {
      streakEl.classList.remove('hidden');
      document.getElementById('streak-count').textContent = streak;
    } else {
      streakEl.classList.add('hidden');
    }
  }
}
