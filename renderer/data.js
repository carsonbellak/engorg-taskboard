// Data Management Layer - all persistence through window.api (IPC)

class DataManager {
  constructor() {
    this.tasks = [];         // sticky notes
    this.projects = [];
    this.archivedProjects = []; // archived projects with their data
    this.purchases = [];
    this.scheduleItems = []; // schedule events
    this.todos = [];         // task checklist items
    this.settings = {};
    this.loaded = false;
  }

  async init() {
    const [tasks, projects, archivedProjects, purchases, settings, schedule, todos] = await Promise.all([
      window.api.loadData('tasks.json'),
      window.api.loadData('projects.json'),
      window.api.loadData('archived_projects.json'),
      window.api.loadData('purchases.json'),
      window.api.loadData('settings.json'),
      window.api.loadData('schedule.json'),
      window.api.loadData('todos.json')
    ]);

    this.tasks = tasks?.tasks || [];
    // Backfill modifiedAt for existing tasks
    let needsSave = false;
    for (const t of this.tasks) {
      if (!t.modifiedAt) {
        t.modifiedAt = t.completedAt || t.createdAt || new Date().toISOString();
        needsSave = true;
      }
      // Heal notes whose completed flag disagrees with their status. When a status
      // is set it is the source of truth ('done' === completed); legacy notes with
      // no status are left untouched.
      if (t.status) {
        const shouldBeCompleted = t.status === 'done';
        if (!!t.completed !== shouldBeCompleted) {
          t.completed = shouldBeCompleted;
          t.completedAt = shouldBeCompleted ? (t.completedAt || new Date().toISOString()) : null;
          needsSave = true;
        }
      }
    }
    this.projects = projects?.projects || [];
    this.archivedProjects = archivedProjects?.projects || [];
    this.purchases = purchases?.purchases || [];
    this.scheduleItems = schedule?.items || [];
    this.todos = todos?.items || [];
    this.settings = settings || { lastProjectId: null, activeView: 'notes' };

    // Ensure theme is always explicit so it syncs to the PWA
    let settingsNeedsSave = false;
    if (!this.settings.theme) {
      this.settings.theme = 'default';
      settingsNeedsSave = true;
    }

    // Load user categories into global APP_CATEGORIES
    if (this.settings.categories && this.settings.categories.length > 0) {
      APP_CATEGORIES = this.settings.categories;
    } else {
      // First run: save defaults
      this.settings.categories = [...DEFAULT_CATEGORIES];
      settingsNeedsSave = true;
    }

    if (settingsNeedsSave) await this._saveSettings();

    this.loaded = true;
    if (needsSave) await this._saveTasks();
  }

  async addCategory(cat) {
    if (!this.settings.categories) this.settings.categories = [...DEFAULT_CATEGORIES];
    cat.id = cat.id || cat.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Prevent duplicate ids
    if (this.settings.categories.some(c => c.id === cat.id)) return null;
    this.settings.categories.push(cat);
    APP_CATEGORIES = this.settings.categories;
    await this._saveSettings();
    return cat;
  }

  _genId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  }

  // === Tasks (sticky notes) ===
  async addTask(task) {
    task.id = this._genId('note');
    const now = new Date().toISOString();
    task.createdAt = now;
    task.modifiedAt = now;
    // Keep completed consistent with status ('done' === completed). Previously this
    // was hardcoded to false, which left notes created with status 'done' in an
    // inconsistent state (status 'done' but completed false).
    task.completed = task.status === 'done' || task.completed === true;
    if (task.completed && !task.completedAt) task.completedAt = now;
    this.tasks.push(task);
    await this._saveTasks();
    return task;
  }

  async updateTask(id, updates) {
    const idx = this.tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;
    // Track completedAt timestamp when completion status changes
    if ('completed' in updates) {
      if (updates.completed && !this.tasks[idx].completed) {
        updates.completedAt = new Date().toISOString();
      } else if (!updates.completed) {
        updates.completedAt = null;
      }
    }
    updates.modifiedAt = new Date().toISOString();
    Object.assign(this.tasks[idx], updates);
    await this._saveTasks();
    return this.tasks[idx];
  }

  async deleteTask(id) {
    this.tasks = this.tasks.filter(t => t.id !== id);
    await this._saveTasks();
  }

  async updateTaskStatus(id, newStatus) {
    const idx = this.tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;
    // Record status change history
    if (!this.tasks[idx].statusHistory) this.tasks[idx].statusHistory = [];
    const oldStatus = this.tasks[idx].status || 'backlog';
    if (oldStatus !== newStatus) {
      this.tasks[idx].statusHistory.push({ from: oldStatus, to: newStatus, date: new Date().toISOString() });
    }
    this.tasks[idx].status = newStatus;
    this.tasks[idx].modifiedAt = new Date().toISOString();
    if (newStatus === 'done') {
      if (!this.tasks[idx].completed) {
        this.tasks[idx].completed = true;
        this.tasks[idx].completedAt = new Date().toISOString();
      }
    } else {
      if (this.tasks[idx].completed) {
        this.tasks[idx].completed = false;
        this.tasks[idx].completedAt = null;
      }
    }
    await this._saveTasks();
    return this.tasks[idx];
  }

  // === Schedule Items ===
  async addScheduleItem(item) {
    item.id = this._genId('sch');
    item.createdAt = new Date().toISOString();
    item.completed = false;
    this.scheduleItems.push(item);
    await this._saveSchedule();
    return item;
  }

  async toggleScheduleItem(id) {
    const item = this.scheduleItems.find(s => s.id === id);
    if (item) { item.completed = !item.completed; await this._saveSchedule(); }
    return item;
  }

  async deleteScheduleItem(id) {
    this.scheduleItems = this.scheduleItems.filter(s => s.id !== id);
    await this._saveSchedule();
  }

  // === Todos (task checklist) ===
  async addTodo(todo) {
    todo.id = this._genId('todo');
    todo.done = false;
    todo.createdAt = new Date().toISOString();
    this.todos.push(todo);
    await this._saveTodos();
    return todo;
  }

  async toggleTodo(id) {
    const t = this.todos.find(t => t.id === id);
    if (t) { t.done = !t.done; await this._saveTodos(); }
    return t;
  }

  async deleteTodo(id) {
    this.todos = this.todos.filter(t => t.id !== id);
    await this._saveTodos();
  }

  // === Projects ===
  async addProject(project) {
    project.id = this._genId('proj');
    project.createdAt = new Date().toISOString();
    this.projects.push(project);
    await this._saveProjects();
    return project;
  }

  async updateProject(id, updates) {
    const idx = this.projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    Object.assign(this.projects[idx], updates);
    await this._saveProjects();
    return this.projects[idx];
  }

  async deleteProject(id) {
    this.projects = this.projects.filter(p => p.id !== id);
    this.tasks = this.tasks.filter(t => t.projectId !== id);
    this.scheduleItems = this.scheduleItems.filter(s => s.projectId !== id);
    this.todos = this.todos.filter(t => t.projectId !== id);
    await Promise.all([this._saveProjects(), this._saveTasks(), this._saveSchedule(), this._saveTodos()]);
  }

  async archiveProject(id) {
    const project = this.projects.find(p => p.id === id);
    if (!project) return;
    // Bundle the project with its associated data
    const archivedEntry = {
      ...project,
      archivedAt: new Date().toISOString(),
      _tasks: this.tasks.filter(t => t.projectId === id),
      _scheduleItems: this.scheduleItems.filter(s => s.projectId === id),
      _todos: this.todos.filter(t => t.projectId === id),
      _purchases: this.purchases.filter(p => p.projectId === id)
    };
    this.archivedProjects.push(archivedEntry);
    // Remove from active
    this.projects = this.projects.filter(p => p.id !== id);
    this.tasks = this.tasks.filter(t => t.projectId !== id);
    this.scheduleItems = this.scheduleItems.filter(s => s.projectId !== id);
    this.todos = this.todos.filter(t => t.projectId !== id);
    this.purchases = this.purchases.filter(p => p.projectId !== id);
    await Promise.all([
      this._saveProjects(), this._saveArchivedProjects(),
      this._saveTasks(), this._saveSchedule(), this._saveTodos(), this._savePurchases()
    ]);
  }

  async unarchiveProject(id) {
    const idx = this.archivedProjects.findIndex(p => p.id === id);
    if (idx === -1) return;
    const entry = this.archivedProjects[idx];
    // Restore project (strip archive metadata)
    const { archivedAt, _tasks, _scheduleItems, _todos, _purchases, ...project } = entry;
    this.projects.push(project);
    // Restore associated data
    if (_tasks) this.tasks.push(..._tasks);
    if (_scheduleItems) this.scheduleItems.push(..._scheduleItems);
    if (_todos) this.todos.push(..._todos);
    if (_purchases) this.purchases.push(..._purchases);
    this.archivedProjects.splice(idx, 1);
    await Promise.all([
      this._saveProjects(), this._saveArchivedProjects(),
      this._saveTasks(), this._saveSchedule(), this._saveTodos(), this._savePurchases()
    ]);
  }

  async deleteArchivedProject(id) {
    this.archivedProjects = this.archivedProjects.filter(p => p.id !== id);
    await this._saveArchivedProjects();
  }

  // === Purchases ===
  async addPurchase(purchase) {
    purchase.id = this._genId('pur');
    purchase.createdAt = new Date().toISOString();
    if (purchase.trackingNumber) purchase.carrier = detectCarrier(purchase.trackingNumber);
    this.purchases.push(purchase);
    await this._savePurchases();
    return purchase;
  }

  async updatePurchase(id, updates) {
    const idx = this.purchases.findIndex(p => p.id === id);
    if (idx === -1) return null;
    if (updates.trackingNumber) updates.carrier = detectCarrier(updates.trackingNumber);
    Object.assign(this.purchases[idx], updates);
    await this._savePurchases();
    return this.purchases[idx];
  }

  async updatePurchaseStatus(id, newStatus) {
    const idx = this.purchases.findIndex(p => p.id === id);
    if (idx === -1) return null;
    this.purchases[idx].status = newStatus;
    await this._savePurchases();
    return this.purchases[idx];
  }

  async deletePurchase(id) {
    this.purchases = this.purchases.filter(p => p.id !== id);
    await this._savePurchases();
  }

  getPurchasesByStatus(status) {
    return this.purchases.filter(p => p.status === status);
  }

  // === Outlook Import ===
  async importOutlookEvents(events, projectId) {
    let imported = 0;
    let changed = false;
    for (const ev of events) {
      const idx = this.scheduleItems.findIndex(s => s.outlookId === ev.outlookId);
      if (idx >= 0) {
        // Update existing — only if meaningful fields changed
        const s = this.scheduleItems[idx];
        if (s.title !== ev.title || s.startTime !== ev.startTime ||
            s.endTime !== ev.endTime || s.date !== ev.date || s.description !== ev.description) {
          Object.assign(s, ev);
          changed = true;
        }
      } else {
        // Add new
        ev.id = this._genId('sch');
        ev.createdAt = new Date().toISOString();
        ev.completed = false;
        ev.source = 'outlook';
        ev.projectId = projectId;
        this.scheduleItems.push(ev);
        imported++;
        changed = true;
      }
    }
    if (changed) await this._saveSchedule();
    return { imported, changed };
  }

  // === External Calendar Import (ICS feeds + email invites) ===
  // Events carry a stable `extId` (source:uid:occurrenceDate) used for dedup.
  // prune=true (authoritative feeds, e.g. Brightspace) drops this source's items that
  // vanished from the feed; prune=false (email invites, scanned over a rolling window)
  // only adds/updates so older invites aren't deleted as they age out of the scan.
  async importExternalEvents(events, { source, prune = false } = {}) {
    let changed = false;
    const newIds = new Set(events.map(e => e.extId));
    const byExtId = new Map();
    for (const s of this.scheduleItems) if (s.extId) byExtId.set(s.extId, s);

    if (prune) {
      const before = this.scheduleItems.length;
      this.scheduleItems = this.scheduleItems.filter(s => s.source !== source || newIds.has(s.extId));
      if (this.scheduleItems.length !== before) changed = true;
    }

    for (const ev of events) {
      const existing = byExtId.get(ev.extId);
      if (existing) {
        if (existing.title !== ev.title || existing.date !== ev.date || existing.startTime !== ev.startTime ||
            existing.endTime !== ev.endTime || existing.location !== ev.location || existing.description !== ev.description) {
          Object.assign(existing, ev);
          changed = true;
        }
      } else {
        this.scheduleItems.push({
          ...ev,
          id: this._genId('sch'),
          createdAt: new Date().toISOString(),
          completed: false,
          projectId: null,
        });
        changed = true;
      }
    }
    if (changed) await this._saveSchedule();
    return { count: events.length, changed };
  }

  // === Settings ===
  async updateSettings(updates) {
    Object.assign(this.settings, updates);
    await this._saveSettings();
  }

  // === Save methods (local + cloud sync) ===
  async _saveTasks() {
    await window.api.saveData('tasks.json', { tasks: this.tasks });
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('tasks', { tasks: this.tasks });
  }
  async _saveProjects() {
    await window.api.saveData('projects.json', { projects: this.projects });
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('projects', { projects: this.projects });
  }
  async _saveArchivedProjects() {
    await window.api.saveData('archived_projects.json', { projects: this.archivedProjects });
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('archived_projects', { projects: this.archivedProjects });
  }
  async _savePurchases() {
    await window.api.saveData('purchases.json', { purchases: this.purchases });
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('purchases', { purchases: this.purchases });
  }
  async _saveSchedule() {
    await window.api.saveData('schedule.json', { items: this.scheduleItems });
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('schedule', { items: this.scheduleItems });
  }
  async _saveTodos() {
    await window.api.saveData('todos.json', { items: this.todos });
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('todos', { items: this.todos });
  }
  async _saveSettings() {
    await window.api.saveData('settings.json', this.settings);
    if (typeof firebaseSync !== 'undefined') firebaseSync.upload('settings', { ...this.settings });
  }
}

const dataManager = new DataManager();
