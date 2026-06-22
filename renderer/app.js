// App Controller - wires sidebar, header tabs, views

(async function initApp() {
  try {
    await dataManager.init();

    // Assign rainbow gradient colors to projects on startup
    if (dataManager.projects.length > 0) {
      assignRainbowColors(dataManager.projects);
      await dataManager._saveProjects();
    }

    const viewRenderer = new ViewRenderer(dataManager);
    const modalManager = new ModalManager(dataManager);
    const purchasingBoard = new PurchasingBoard(dataManager);
    const notesBoard = new NotesBoard(dataManager);

    modalManager.init(viewRenderer);
    purchasingBoard.init();

    // Initialize file viewer
    let fileViewerReady = false;
    fileViewer.init().then(() => { fileViewerReady = true; }).catch(err => console.warn('File viewer init:', err));

    // ============ BUILD SIDEBAR ============
    function buildSidebar() {
      // Projects - with category badges
      const projContainer = document.getElementById('sidebar-projects');
      projContainer.innerHTML = dataManager.projects.map(p => {
        const cats = p.categories || [];
        const catBadges = cats.length > 1
          ? cats.map(cat => `<span class="sidebar-cat-dot" style="background:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}" title="${CATEGORY_LABELS[cat] || cat}"></span>`).join('')
          : cats.map(cat => `<span class="sidebar-cat-badge" style="background:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}33; color:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}">${CATEGORY_LABELS[cat] || cat}</span>`).join('');
        return `<div class="sidebar-project-row" data-project="${p.id}">
          <button class="sidebar-item" data-project="${p.id}">
            <span class="sidebar-project-dot" style="background:${p.color}"></span>
            <span class="sidebar-project-name">${escapeHtml(p.name)}</span>
            ${catBadges ? `<span class="sidebar-cat-badges">${catBadges}</span>` : ''}
          </button>
          <button class="sidebar-project-menu" data-project-id="${p.id}" title="Options">&#8226;&#8226;&#8226;</button>
          <div class="sidebar-project-dropdown hidden" data-project-id="${p.id}">
            <button class="sidebar-dropdown-item" data-action="edit" data-project-id="${p.id}">&#9998; Edit</button>
            <button class="sidebar-dropdown-item" data-action="archive" data-project-id="${p.id}">&#128230; Archive</button>
            <button class="sidebar-dropdown-item sidebar-dropdown-danger" data-action="delete" data-project-id="${p.id}">&#128465; Delete</button>
          </div>
        </div>`;
      }).join('');

      // Archived projects section
      const archiveWrapper = document.getElementById('sidebar-archive-section-wrapper');
      const archiveContainer = document.getElementById('sidebar-archived-projects');
      if (dataManager.archivedProjects.length > 0) {
        archiveWrapper.style.display = '';
        const archiveCount = document.getElementById('sidebar-archive-count');
        if (archiveCount) archiveCount.textContent = `(${dataManager.archivedProjects.length})`;
        archiveContainer.innerHTML = dataManager.archivedProjects.map(p => {
          return `<div class="sidebar-project-row sidebar-archived-row" data-project="${p.id}">
            <button class="sidebar-item sidebar-archived-item" data-project="${p.id}">
              <span class="sidebar-project-dot" style="background:${p.color};opacity:0.5"></span>
              <span class="sidebar-project-name">${escapeHtml(p.name)}</span>
            </button>
            <button class="sidebar-project-menu" data-project-id="${p.id}" title="Options">&#8226;&#8226;&#8226;</button>
            <div class="sidebar-project-dropdown hidden" data-project-id="${p.id}">
              <button class="sidebar-dropdown-item" data-action="unarchive" data-project-id="${p.id}">&#128230; Unarchive</button>
              <button class="sidebar-dropdown-item sidebar-dropdown-danger" data-action="delete-archived" data-project-id="${p.id}">&#128465; Delete</button>
            </div>
          </div>`;
        }).join('');
      } else {
        archiveWrapper.style.display = 'none';
      }

      // Days - with completion status dots
      const dayContainer = document.getElementById('sidebar-days');
      dayContainer.innerHTML = DAYS.map(d => {
        const status = viewRenderer.getDayCompletionStatus(d);
        let dotHtml = '';
        if (status === 'complete') dotHtml = '<span class="day-status-dot day-status-green"></span>';
        else if (status === 'partial') dotHtml = '<span class="day-status-dot day-status-yellow"></span>';
        else if (status === 'empty') dotHtml = '<span class="day-status-dot day-status-red"></span>';

        return `<button class="sidebar-day ${d === viewRenderer.selectedDay ? 'active' : ''}" data-day="${d}">
          ${d.slice(0, 3)}${dotHtml}
        </button>`;
      }).join('');

      // Bind project clicks (sidebar-item buttons) — skip archived items
      document.querySelectorAll('#sidebar-active-section .sidebar-item[data-project]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#sidebar .sidebar-item[data-project]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          if (btn.dataset.project === 'all') {
            // "All Projects" opens the projects overview as its own view
            viewRenderer.selectedProject = 'all';
            viewRenderer.currentView = 'projects';
            // Deactivate header tabs since this is a sidebar-only view
            document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
            // Show the notes panel container (reused for project slates)
            document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
            document.getElementById('view-notes').classList.add('active');
          } else {
            // Selecting a specific project switches to notes view for that project
            viewRenderer.selectedProject = btn.dataset.project;
            if (viewRenderer.currentView === 'projects') {
              viewRenderer.currentView = 'notes';
              // Reactivate the Notes header tab
              document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
              const notesTab = document.querySelector('.header-tab[data-view="notes"]');
              if (notesTab) notesTab.classList.add('active');
              document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
              document.getElementById('view-notes').classList.add('active');
            }
          }
          updateContentHeader();
          renderCurrentView();
        });
      });

      // Bind "All Archived" button
      const archivedAllBtn = document.querySelector('.sidebar-archived-all-btn');
      if (archivedAllBtn) {
        archivedAllBtn.addEventListener('click', () => {
          document.querySelectorAll('#sidebar .sidebar-item[data-project]').forEach(b => b.classList.remove('active'));
          archivedAllBtn.classList.add('active');
          viewRenderer.selectedProject = 'all-archived';
          viewRenderer.currentView = 'projects';
          document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
          document.getElementById('view-notes').classList.add('active');
          updateContentHeader();
          renderCurrentView();
        });
      }

      // Bind sidebar project three-dots menus
      document.querySelectorAll('.sidebar-project-menu').forEach(menuBtn => {
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const projId = menuBtn.dataset.projectId;
          // Close all other dropdowns
          document.querySelectorAll('.sidebar-project-dropdown').forEach(d => d.classList.add('hidden'));
          const dropdown = menuBtn.parentElement.querySelector('.sidebar-project-dropdown');
          dropdown.classList.toggle('hidden');
        });
      });

      // Bind sidebar dropdown actions
      document.querySelectorAll('.sidebar-dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const projId = item.dataset.projectId;
          const action = item.dataset.action;
          // Close dropdown
          document.querySelectorAll('.sidebar-project-dropdown').forEach(d => d.classList.add('hidden'));

          if (action === 'edit') {
            const project = dataManager.projects.find(p => p.id === projId);
            if (project) window.dispatchEvent(new CustomEvent('edit-project', { detail: project }));
          } else if (action === 'delete') {
            const project = dataManager.projects.find(p => p.id === projId);
            if (project) window.dispatchEvent(new CustomEvent('delete-project', { detail: project }));
          } else if (action === 'archive') {
            const project = dataManager.projects.find(p => p.id === projId);
            if (project) window.dispatchEvent(new CustomEvent('archive-project', { detail: project }));
          } else if (action === 'unarchive') {
            window.dispatchEvent(new CustomEvent('unarchive-project', { detail: { id: projId } }));
          } else if (action === 'delete-archived') {
            window.dispatchEvent(new CustomEvent('delete-archived-project', { detail: { id: projId } }));
          }
        });
      });

      // Bind day clicks
      document.querySelectorAll('#sidebar .sidebar-day').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#sidebar .sidebar-day').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          viewRenderer.selectedDay = btn.dataset.day;
          updateContentHeader();
          renderCurrentView();
        });
      });

      // Highlight active project
      document.querySelectorAll('#sidebar .sidebar-item[data-project]').forEach(btn => {
        btn.classList.toggle('active',
          (viewRenderer.selectedProject === 'all' && btn.dataset.project === 'all') ||
          btn.dataset.project === viewRenderer.selectedProject
        );
      });

      // Drag-to-reorder projects
      let dragRow = null;
      projContainer.querySelectorAll('.sidebar-project-row').forEach(row => {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          dragRow = row;
          row.classList.add('sidebar-drag-active');
          e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('sidebar-drag-active');
          projContainer.querySelectorAll('.sidebar-project-row').forEach(r => r.classList.remove('sidebar-drag-over'));
          dragRow = null;
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragRow && row !== dragRow) {
            projContainer.querySelectorAll('.sidebar-project-row').forEach(r => r.classList.remove('sidebar-drag-over'));
            row.classList.add('sidebar-drag-over');
          }
        });
        row.addEventListener('dragleave', () => {
          row.classList.remove('sidebar-drag-over');
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('sidebar-drag-over');
          if (!dragRow || row === dragRow) return;
          // Reorder in DOM
          const rows = [...projContainer.querySelectorAll('.sidebar-project-row')];
          const fromIdx = rows.indexOf(dragRow);
          const toIdx = rows.indexOf(row);
          if (fromIdx < toIdx) {
            row.after(dragRow);
          } else {
            row.before(dragRow);
          }
          // Reorder in data
          const newOrder = [...projContainer.querySelectorAll('.sidebar-project-row')].map(r => r.dataset.project);
          const reordered = newOrder.map(id => dataManager.projects.find(p => p.id === id)).filter(Boolean);
          dataManager.projects = reordered;
          assignRainbowColors(dataManager.projects);
          dataManager._saveProjects();
          buildSidebar();
          renderCurrentView();
        });
      });
    }

    // ============ SIDEBAR DOT UPDATE (cheap — no full rebuild) ============
    function updateSidebarDots() {
      DAYS.forEach(d => {
        const btn = document.querySelector(`#sidebar .sidebar-day[data-day="${d}"]`);
        if (!btn) return;
        const status = viewRenderer.getDayCompletionStatus(d);
        let dotHtml = '';
        if (status === 'complete') dotHtml = '<span class="day-status-dot day-status-green"></span>';
        else if (status === 'partial') dotHtml = '<span class="day-status-dot day-status-yellow"></span>';
        else if (status === 'empty') dotHtml = '<span class="day-status-dot day-status-red"></span>';
        btn.innerHTML = `${d.slice(0, 3)}${dotHtml}`;
      });
    }

    // ============ UPDATE CONTENT HEADER ============
    function updateContentHeader() {
      const dayTitle = document.getElementById('content-day-title');
      const subtitle = document.getElementById('content-project-subtitle');

      // Full-bleed views hide the day sidebar / content-header / quick-filters and own
      // the entire main-content area (email uses a 3-pane grid that needs the full width).
      const isFullView = viewRenderer.currentView === 'files' || viewRenderer.currentView === 'stats' || viewRenderer.currentView === 'engineering' || viewRenderer.currentView === 'settings' || viewRenderer.currentView === 'timers' || viewRenderer.currentView === 'email';
      document.getElementById('sidebar').style.display = isFullView ? 'none' : '';
      document.getElementById('content-header').style.display = isFullView ? 'none' : '';
      document.getElementById('quick-filters').classList.toggle('hidden', isFullView);

      if (isFullView) return;

      if (viewRenderer.currentView === 'projects') {
        dayTitle.textContent = 'All Projects';
        subtitle.textContent = 'Project Overview';
      } else if (viewRenderer.selectedProject === 'all') {
        const viewLabels = { notes: 'All Notes', calendar: 'Calendar', timeline: 'Timeline', board: 'Board', purchasing: 'Purchasing' };
        dayTitle.textContent = viewLabels[viewRenderer.currentView] || 'All Notes';
        subtitle.textContent = 'Across all projects';
      } else {
        const proj = dataManager.projects.find(p => p.id === viewRenderer.selectedProject);
        dayTitle.textContent = proj ? proj.name : 'Project';
        const viewSubtitles = { notes: 'Project Notes', calendar: 'Calendar', timeline: 'Timeline', board: 'Project Board', purchasing: 'Purchasing' };
        subtitle.textContent = viewSubtitles[viewRenderer.currentView] || 'Project Notes';
      }

      // Update add button text based on current view
      const addBtn = document.getElementById('btn-add-main');
      const labels = { notes: '+ Add Note', calendar: '+ Add Event', timeline: '+ Add Note', board: '+ Add Note', purchasing: '+ Add Order', projects: '+ Project' };
      addBtn.textContent = labels[viewRenderer.currentView] || '+ Add';
    }

    // ============ RENDER CURRENT VIEW ============
    // Track printer init state
    let printerInitialized = false;

    let slicerInitialized = false;

    const emailView = new EmailView();
    let emailInitialized = false;

    function renderCurrentView() {
      // Deactivate the Engineering Utilities tab (and its active sub-utility) when leaving it
      if (viewRenderer.currentView !== 'engineering') {
        engineeringUtilities.deactivate();
      }
      // Stop email polling when leaving the email view
      if (viewRenderer.currentView !== 'email' && emailInitialized) {
        emailView.deactivate();
      }
      if (viewRenderer.currentView === 'email') {
        if (!emailInitialized) { emailView.init(); emailInitialized = true; }
        emailView.activate();
        return;
      }
      if (viewRenderer.currentView === 'engineering') {
        engineeringUtilities.activate();
        return;
      } else if (viewRenderer.currentView === 'files') {
        return;
      } else if (viewRenderer.currentView === 'stats') {
        renderStats();
        return;
      } else if (viewRenderer.currentView === 'settings') {
        renderSettings();
        return;
      } else if (viewRenderer.currentView === 'timers') {
        stopTimerCountdown();
        renderTimers();
        return;
      } else if (viewRenderer.currentView === 'purchasing') {
        purchasingBoard.render();
      } else if (viewRenderer.currentView === 'board') {
        notesBoard.render(viewRenderer.selectedProject);
      } else {
        stopTimerCountdown();
        viewRenderer.render();
      }
      viewRenderer.updateProgress();
    }

    // ============ HEADER TAB SWITCHING ============
    document.querySelectorAll('.header-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const view = tab.dataset.view;
        viewRenderer.currentView = view;

        // Deactivate the "All Projects" sidebar selection when switching to a header tab
        // (All Projects is its own separate view, not a header tab view)
        if (viewRenderer.selectedProject === 'all' && view !== 'projects') {
          // Keep selectedProject as 'all' to show all items, but deselect the sidebar highlight
          // since we're now in a header tab view, not the All Projects overview
        }

        // Show/hide view panels
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('view-' + view).classList.add('active');

        // Show/hide quick filters bar
        const filtersEl = document.getElementById('quick-filters');
        if (view === 'notes' || view === 'board') {
          filtersEl.classList.remove('hidden');
        } else {
          filtersEl.classList.add('hidden');
        }

        updateContentHeader();
        renderCurrentView();
        dataManager.updateSettings({ activeView: view });
      });
    });

    // ============ HEADER TAB DRAG-TO-REORDER + LOCK ============
    try { (function setupTabDrag() {
      const tabContainer = document.querySelector('.header-tabs');
      const lockBtn = document.getElementById('btn-tab-lock');
      let dragTab = null;
      let locked = !!dataManager.settings?.tabsLocked;

      // Reflect the lock state: toggle draggability + the button icon/title.
      function applyLockUI() {
        tabContainer.classList.toggle('tabs-locked', locked);
        tabContainer.querySelectorAll('.header-tab').forEach(t => { t.draggable = !locked; });
        if (lockBtn) {
          lockBtn.innerHTML = locked ? '&#128274;' : '&#128275;'; // 🔒 locked / 🔓 unlocked
          lockBtn.title = locked ? 'Tab order locked — click to unlock and reorder' : 'Drag tabs to reorder · click to lock';
          lockBtn.classList.toggle('locked', locked);
        }
      }

      tabContainer.querySelectorAll('.header-tab').forEach(tab => {
        tab.addEventListener('dragstart', (e) => {
          if (locked) { e.preventDefault(); return; }
          dragTab = tab;
          tab.classList.add('tab-drag-active');
          e.dataTransfer.effectAllowed = 'move';
        });
        tab.addEventListener('dragend', () => {
          tab.classList.remove('tab-drag-active');
          tabContainer.querySelectorAll('.header-tab').forEach(t => t.classList.remove('tab-drag-over'));
          dragTab = null;
        });
        tab.addEventListener('dragover', (e) => {
          if (locked || !dragTab) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (tab !== dragTab) {
            tabContainer.querySelectorAll('.header-tab').forEach(t => t.classList.remove('tab-drag-over'));
            tab.classList.add('tab-drag-over');
          }
        });
        tab.addEventListener('dragleave', () => tab.classList.remove('tab-drag-over'));
        tab.addEventListener('drop', (e) => {
          e.preventDefault();
          tab.classList.remove('tab-drag-over');
          if (!dragTab || tab === dragTab) return;
          const tabs = [...tabContainer.querySelectorAll('.header-tab')];
          const fromIdx = tabs.indexOf(dragTab);
          const toIdx = tabs.indexOf(tab);
          if (fromIdx < toIdx) tab.after(dragTab);
          else tab.before(dragTab);
          const order = [...tabContainer.querySelectorAll('.header-tab')].map(t => t.dataset.view);
          dataManager.updateSettings({ tabOrder: order });
        });
      });

      // Restore saved tab order, then keep the lock button pinned to the far right.
      const saved = dataManager.settings?.tabOrder;
      if (saved && Array.isArray(saved)) {
        saved.forEach(view => {
          const tab = tabContainer.querySelector(`.header-tab[data-view="${view}"]`);
          if (tab) tabContainer.appendChild(tab);
        });
      }
      if (lockBtn) tabContainer.appendChild(lockBtn);

      if (lockBtn) lockBtn.addEventListener('click', () => {
        locked = !locked;
        dataManager.updateSettings({ tabsLocked: locked });
        applyLockUI();
      });

      applyLockUI();
    })(); } catch(e) { console.warn('Tab drag setup failed:', e); }

    // ============ ADD BUTTON ============
    document.getElementById('btn-add-main').addEventListener('click', () => {
      if (dataManager.projects.length === 0 && viewRenderer.currentView !== 'purchasing') {
        if (confirm('Create a project first?')) modalManager.openProjectModal();
        return;
      }
      switch (viewRenderer.currentView) {
        case 'notes': modalManager.openNoteModal(); break;
        case 'calendar': modalManager.openScheduleModal(); break;
        case 'timeline': modalManager.openNoteModal(); break;
        case 'board': modalManager.openNoteModal(); break;
        case 'purchasing': purchasingBoard._openPurchaseModal(); break;
        case 'projects': modalManager.openProjectModal(); break;
      }
    });

    // ============ SETTINGS BUTTON ============
    document.getElementById('btn-settings-header').addEventListener('click', () => {
      document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('btn-settings-header').classList.add('active');
      viewRenderer.currentView = 'settings';
      document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('view-settings').classList.add('active');
      updateContentHeader();
      renderCurrentView();
    });

    // Deactivate settings button when any tab is clicked
    document.querySelectorAll('.header-tab').forEach(tab => {
      tab.addEventListener('click', () => document.getElementById('btn-settings-header').classList.remove('active'));
    });

    // ============ PROJECT BUTTON ============
    document.getElementById('btn-add-project-header').addEventListener('click', () => {
      modalManager.openProjectModal();
    });

    // ============ OUTLOOK SYNC (Local Desktop) ============
    async function syncOutlook(silent = false) {
      try {
        const btn = document.getElementById('btn-outlook-sync');
        btn.textContent = '⏳ Syncing...';
        btn.disabled = true;

        // Fetch events from local Outlook (30 days back, 60 days forward)
        const rawEvents = await window.api.outlookFetchLocal(30, 60);

        // Transform to schedule item format
        const events = rawEvents.map(ev => {
          const startDate = new Date(ev.startTime);
          const endDate = new Date(ev.endTime);
          const dateStr = startDate.toISOString().slice(0, 10);
          const startTime = startDate.toTimeString().slice(0, 5);
          const endTime = endDate.toTimeString().slice(0, 5);
          const dayIdx = startDate.getDay();
          const dayName = DAYS[dayIdx === 0 ? 6 : dayIdx - 1];

          return {
            title: ev.subject || 'Outlook Event',
            description: ev.body || '',
            date: dateStr,
            day: dayName,
            startTime,
            endTime,
            outlookId: ev.entryId,
            source: 'outlook'
          };
        });

        const projectId = viewRenderer.selectedProject !== 'all'
          ? viewRenderer.selectedProject
          : (dataManager.projects[0]?.id || null);

        if (!projectId) {
          if (!silent) alert('Create a project first to import Outlook events into.');
          return;
        }

        const { imported, changed } = await dataManager.importOutlookEvents(events, projectId);
        if (!silent) {
          alert(`Outlook sync complete: ${imported} new events imported, ${rawEvents.length - imported} updated.`);
        }
        if (changed) {
          window.dispatchEvent(new CustomEvent('schedule-changed'));
        }
      } catch (err) {
        console.error('Outlook sync failed:', err);
        if (!silent) alert('Outlook sync failed: ' + err.message);
      } finally {
        const btn = document.getElementById('btn-outlook-sync');
        btn.textContent = '📅 Outlook';
        btn.disabled = false;
      }
    }

    // Manual sync button — shows alert with results
    document.getElementById('btn-outlook-sync').addEventListener('click', async () => {
      await syncOutlook(false);
    });

    // Auto-sync every 30 minutes (silent — no popups)
    setInterval(async () => {
      try { await syncOutlook(true); } catch (e) {
        console.warn('Outlook auto-sync failed:', e.message);
      }
    }, 30 * 60 * 1000);

    // Initial sync on app startup (silent, after a short delay)
    setTimeout(() => {
      syncOutlook(true).catch(e => console.warn('Initial Outlook sync failed:', e.message));
    }, 3000);

    // ============ EXTERNAL CALENDAR SYNC (ICS feeds + email invites) ============
    // Pulls Brightspace (and any other ICS feed) + meeting invites found in email accounts.
    async function syncCalendars() {
      const feeds = dataManager.settings.calendarFeeds || [];
      for (const feed of feeds) {
        if (!feed.url) continue;
        try {
          const events = await window.api.calendar.fetchFeed(feed.url, feed.source || 'feed');
          const { changed } = await dataManager.importExternalEvents(events, { source: feed.source || 'feed', prune: true });
          if (changed) window.dispatchEvent(new CustomEvent('schedule-changed'));
        } catch (e) { console.warn('Calendar feed sync failed (' + (feed.name || feed.url) + '):', e.message); }
      }
      try {
        const invites = await window.api.email.scanInvites();
        if (invites && invites.length) {
          const { changed } = await dataManager.importExternalEvents(invites, { source: 'email', prune: false });
          if (changed) window.dispatchEvent(new CustomEvent('schedule-changed'));
        }
      } catch (e) { console.warn('Email invite scan failed:', e.message); }
    }
    window.syncCalendars = syncCalendars; // allow Settings to trigger a sync after adding a feed

    setTimeout(() => { syncCalendars().catch(e => console.warn('Initial calendar sync failed:', e.message)); }, 4000);
    setInterval(() => { syncCalendars().catch(() => {}); }, 15 * 60 * 1000); // every 15 min

    // ============ QUICK FILTERS ============
    const activeFilters = { priority: null, overdue: false, category: null };
    viewRenderer.activeFilters = activeFilters;
    notesBoard.activeFilters = activeFilters;

    // Initialize color mode and sort mode from settings
    const savedColorMode = dataManager.settings.noteColorMode || 'category';
    const savedSortMode = dataManager.settings.noteSortMode || 'priority';
    viewRenderer.colorMode = savedColorMode;
    viewRenderer.sortMode = savedSortMode;
    notesBoard.colorMode = savedColorMode;
    notesBoard.sortMode = savedSortMode;
    document.getElementById('filter-color-mode').value = savedColorMode;
    document.getElementById('filter-sort').value = savedSortMode;

    // Color mode dropdown in filter bar
    document.getElementById('filter-color-mode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      viewRenderer.colorMode = mode;
      notesBoard.colorMode = mode;
      await dataManager.updateSettings({ noteColorMode: mode });
      renderCurrentView();
    });

    // Sort dropdown in filter bar
    document.getElementById('filter-sort').addEventListener('change', async (e) => {
      const mode = e.target.value;
      viewRenderer.sortMode = mode;
      notesBoard.sortMode = mode;
      await dataManager.updateSettings({ noteSortMode: mode });
      renderCurrentView();
    });

    // Populate category filter chips
    function updateFilterCategories() {
      const catContainer = document.getElementById('filter-categories');
      catContainer.innerHTML = APP_CATEGORIES.map(c =>
        `<button class="filter-chip${activeFilters.category === c.id ? ' active' : ''}" data-filter="category" data-value="${c.id}">${c.label}</button>`
      ).join('');
    }
    updateFilterCategories();

    document.getElementById('quick-filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      const filter = chip.dataset.filter;
      const value = chip.dataset.value;

      if (filter === 'overdue') {
        activeFilters.overdue = !activeFilters.overdue;
        chip.classList.toggle('active');
      } else {
        const wasActive = chip.classList.contains('active');
        document.querySelectorAll(`.filter-chip[data-filter="${filter}"]`).forEach(c => c.classList.remove('active'));
        if (!wasActive) { chip.classList.add('active'); activeFilters[filter] = value; }
        else { activeFilters[filter] = null; }
      }
      renderCurrentView();
    });

    // ============ EVENT LISTENERS ============
    window.addEventListener('board-add-note', () => { modalManager.openNoteModal(); });
    window.addEventListener('cal-new-event', (e) => {
      const { date, time } = e.detail || {};
      const hour = time ? parseInt(time.split(':')[0], 10) : undefined;
      modalManager.openScheduleModal({ date, hour });
    });
    // Coalesce data-change re-renders. A burst of *-changed events (e.g. Firebase
    // pushing several collections at once on initial sync) would otherwise trigger
    // one full innerHTML rebuild per event; batch them into a single rAF render.
    let _renderScheduled = false, _pendingSidebar = false, _pendingDots = false;
    function scheduleRender({ sidebar = false, dots = false } = {}) {
      _pendingSidebar = _pendingSidebar || sidebar;
      _pendingDots = _pendingDots || dots;
      if (_renderScheduled) return;
      _renderScheduled = true;
      requestAnimationFrame(() => {
        _renderScheduled = false;
        if (_pendingSidebar) { buildSidebar(); _pendingSidebar = false; }
        if (_pendingDots) { updateSidebarDots(); _pendingDots = false; }
        renderCurrentView();
      });
    }
    window.addEventListener('tasks-changed', () => scheduleRender({ dots: true }));
    window.addEventListener('timers-changed', () => { if (viewRenderer.currentView === 'timers') renderTimers(); });
    window.addEventListener('schedule-changed', () => scheduleRender({ dots: true }));
    window.addEventListener('purchases-changed', () => scheduleRender());
    window.addEventListener('projects-changed', () => scheduleRender({ sidebar: true }));
    window.addEventListener('categories-changed', () => { buildSidebar(); updateFilterCategories(); });

    // Click a project slate to navigate into that project (switch to notes view)
    window.addEventListener('select-project', (e) => {
      const projectId = e.detail;
      viewRenderer.selectedProject = projectId;
      viewRenderer.currentView = 'notes';
      // Activate the Notes header tab
      document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
      const notesTab = document.querySelector('.header-tab[data-view="notes"]');
      if (notesTab) notesTab.classList.add('active');
      document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('view-notes').classList.add('active');
      document.querySelectorAll('#sidebar .sidebar-item[data-project]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.project === projectId);
      });
      updateContentHeader();
      renderCurrentView();
    });

    // Edit project from three-dots menu
    window.addEventListener('edit-project', (e) => {
      modalManager.openProjectModal(e.detail);
    });

    // Delete project from three-dots menu
    window.addEventListener('delete-project', async (e) => {
      const project = e.detail;
      const noteCount = dataManager.tasks.filter(t => t.projectId === project.id).length;
      const eventCount = dataManager.scheduleItems.filter(s => s.projectId === project.id).length;
      const orderCount = dataManager.purchases.filter(p => p.projectId === project.id).length;

      let msg = `Delete "${project.name}"?`;
      const items = [];
      if (noteCount > 0) items.push(`${noteCount} note${noteCount > 1 ? 's' : ''}`);
      if (eventCount > 0) items.push(`${eventCount} event${eventCount > 1 ? 's' : ''}`);
      if (orderCount > 0) items.push(`${orderCount} order${orderCount > 1 ? 's' : ''}`);
      if (items.length > 0) msg += `\n\nThis will also delete ${items.join(', ')}.`;
      msg += '\n\nThis cannot be undone.';

      if (confirm(msg)) {
        await dataManager.deleteProject(project.id);
        assignRainbowColors(dataManager.projects);
        await dataManager._saveProjects();
        viewRenderer.selectedProject = 'all';
        viewRenderer.currentView = 'projects';
        document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('view-notes').classList.add('active');
        updateContentHeader();
        buildSidebar();
        renderCurrentView();
      }
    });

    // Archive project
    window.addEventListener('archive-project', async (e) => {
      const project = e.detail;
      if (confirm(`Archive "${project.name}"?\n\nAll its notes, events, and orders will be stored in the archive and removed from active views.`)) {
        await dataManager.archiveProject(project.id);
        assignRainbowColors(dataManager.projects);
        await dataManager._saveProjects();
        viewRenderer.selectedProject = 'all';
        viewRenderer.currentView = 'projects';
        document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('view-notes').classList.add('active');
        updateContentHeader();
        buildSidebar();
        renderCurrentView();
      }
    });

    // Unarchive project
    window.addEventListener('unarchive-project', async (e) => {
      await dataManager.unarchiveProject(e.detail.id);
      assignRainbowColors(dataManager.projects);
      await dataManager._saveProjects();
      buildSidebar();
      renderCurrentView();
    });

    // Delete archived project permanently
    window.addEventListener('delete-archived-project', async (e) => {
      const proj = dataManager.archivedProjects.find(p => p.id === e.detail.id);
      if (!proj) return;
      if (confirm(`Permanently delete "${proj.name}" from archive?\n\nThis cannot be undone.`)) {
        await dataManager.deleteArchivedProject(e.detail.id);
        buildSidebar();
      }
    });

    // Collapsible sidebar sections
    document.querySelectorAll('.sidebar-collapsible').forEach(label => {
      const targetId = label.dataset.target;
      const target = document.getElementById(targetId);
      if (!target) return;
      // Set initial state
      if (label.dataset.default === 'closed') {
        target.classList.add('sidebar-collapsed');
        label.querySelector('.sidebar-collapse-arrow').innerHTML = '&#9654;';
      } else {
        target.classList.remove('sidebar-collapsed');
        label.querySelector('.sidebar-collapse-arrow').innerHTML = '&#9660;';
      }
      label.addEventListener('click', () => {
        const collapsed = target.classList.toggle('sidebar-collapsed');
        label.querySelector('.sidebar-collapse-arrow').innerHTML = collapsed ? '&#9654;' : '&#9660;';
      });
    });

    // Close all dropdowns on outside click
    document.addEventListener('click', () => {
      document.querySelectorAll('.slate-dropdown').forEach(d => d.classList.add('hidden'));
      document.querySelectorAll('.sidebar-project-dropdown').forEach(d => d.classList.add('hidden'));
    });

    // ============ CLOUD SYNC ============
    firebaseSync.init();
    document.getElementById('btn-cloud-sync').addEventListener('click', () => {
      firebaseSync.showSignInModal();
    });
    document.getElementById('btn-cancel-cloud').addEventListener('click', () => {
      document.getElementById('modal-cloud-signin').classList.add('hidden');
    });

    // ============ KEYBOARD SHORTCUTS ============
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        document.getElementById('btn-add-main').click();
      }
    });

    // ============ INIT ============
    initTheme();
    buildSidebar();
    updateContentHeader();

    // Always-on printer camera bridge: whenever the printer is enabled, keep it
    // connected and streaming to the PWA in the background — regardless of which
    // tab is active or whether the printer tab has ever been opened.
    if (dataManager.settings.printerEnabled) {
      printerController.startBackground();
      printerInitialized = true; // bridge already rendered + polling; don't re-init on first tab visit
    }

    // Restore last view (handle legacy 'schedule' -> 'calendar', and remove 'tasks')
    let savedView = dataManager.settings.activeView;
    if (savedView === 'schedule') savedView = 'calendar';
    if (savedView === 'tasks') savedView = 'notes';
    if (savedView === 'printer' || savedView === 'slicer') savedView = 'engineering'; // merged into Engineering Utilities
    if (savedView === 'projects') savedView = 'notes'; // projects view is sidebar-only, don't restore it

    if (savedView && savedView !== 'notes') {
      const tab = document.querySelector(`.header-tab[data-view="${savedView}"]`);
      if (tab) tab.click();
    } else {
      renderCurrentView();
    }

    console.log('EngOrg initialized:', dataManager.tasks.length, 'notes,', dataManager.scheduleItems.length, 'events,', dataManager.purchases.length, 'purchases');

  } catch (err) {
    console.error('Init failed:', err);
    document.body.innerHTML = `<div style="padding:40px;text-align:center;font-family:sans-serif;">
      <h1 style="color:#e74c3c;">Failed to Initialize</h1><p>${err.message}</p></div>`;
  }
})();
