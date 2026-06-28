// App Controller - wires sidebar, header tabs, views

(async function initApp() {
  try {
    // Split Window: when this window is the split *shell* (a grid of app iframes),
    // window-split.js has already rendered the grid — skip the whole app init so
    // we don't load data, Firebase, or the auth gate behind the panes.
    if (window.windowSplit && window.windowSplit.isShell()) return;
    // Embedded panes are full app instances, but must NOT duplicate background
    // services (Outlook/calendar sync, printer camera bridge, update checks).
    const EMB = !!(window.windowSplit && window.windowSplit.EMBEDDED);

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
      // Projects - grouped into collapsible groups + an ungrouped list
      const projContainer = document.getElementById('sidebar-projects');
      const groups = dataManager.getActiveProjectGroups();

      const catBadgesHtml = (p) => {
        const cats = p.categories || [];
        return cats.length > 1
          ? cats.map(cat => `<span class="sidebar-cat-dot" style="background:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}" title="${CATEGORY_LABELS[cat] || cat}"></span>`).join('')
          : cats.map(cat => `<span class="sidebar-cat-badge" style="background:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}33; color:${PROJECT_CATEGORY_COLORS[cat] || '#64748B'}">${CATEGORY_LABELS[cat] || cat}</span>`).join('');
      };

      // "Move to group" options shown inside each project's dropdown
      const moveTargetsHtml = (p) => {
        const items = [`<button class="sidebar-dropdown-item" data-action="move-group" data-group-id="" data-project-id="${p.id}">&#11096; Ungrouped</button>`];
        groups.forEach(g => {
          if (g.id === p.groupId) return;
          items.push(`<button class="sidebar-dropdown-item" data-action="move-group" data-group-id="${g.id}" data-project-id="${p.id}"><span class="sidebar-group-dot" style="background:${g.color}"></span> ${escapeHtml(g.name)}</button>`);
        });
        return items.join('');
      };

      const projectRowHtml = (p) => {
        const catBadges = catBadgesHtml(p);
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
            <div class="sidebar-dropdown-divider"></div>
            <div class="sidebar-dropdown-label">Move to</div>
            ${moveTargetsHtml(p)}
          </div>
        </div>`;
      };

      let projHtml = '';
      groups.forEach(g => {
        const members = dataManager.projects.filter(p => p.groupId === g.id);
        projHtml += `<div class="sidebar-group" data-group-id="${g.id}">
          <div class="sidebar-group-header" data-group-id="${g.id}">
            <span class="sidebar-group-arrow">${g.collapsed ? '&#9654;' : '&#9660;'}</span>
            <span class="sidebar-group-dot" style="background:${g.color}"></span>
            <span class="sidebar-group-name">${escapeHtml(g.name)}</span>
            <span class="sidebar-group-count">${members.length}</span>
            <button class="sidebar-group-menu" data-group-id="${g.id}" title="Group options">&#8226;&#8226;&#8226;</button>
            <div class="sidebar-group-dropdown hidden" data-group-id="${g.id}">
              <button class="sidebar-dropdown-item" data-action="edit-group" data-group-id="${g.id}">&#9998; Edit</button>
              <button class="sidebar-dropdown-item" data-action="archive-group" data-group-id="${g.id}">&#128230; Archive</button>
              <button class="sidebar-dropdown-item sidebar-dropdown-danger" data-action="delete-group" data-group-id="${g.id}">&#128465; Delete group</button>
            </div>
          </div>
          <div class="sidebar-group-projects ${g.collapsed ? 'sidebar-collapsed' : ''}" data-group-id="${g.id}">
            ${members.map(projectRowHtml).join('') || '<div class="sidebar-group-empty">Drop projects here</div>'}
          </div>
        </div>`;
      });
      const ungrouped = dataManager.projects.filter(p => !p.groupId || !groups.find(g => g.id === p.groupId));
      projHtml += `<div class="sidebar-ungrouped" data-group-id="">${ungrouped.map(projectRowHtml).join('')}</div>`;
      projContainer.innerHTML = projHtml;

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
            // "All Projects" is now a pure filter: show every project's items in
            // whatever view is currently active (Notes, Calendar, Board, ...).
            // The project OVERVIEW lives in its own "Projects" header tab.
            viewRenderer.selectedProject = 'all';
          } else {
            // Selecting a specific project re-filters the CURRENT tab
            // (calendar stays calendar, board stays board, etc.). From the
            // Projects overview tab, picking a project drills into its notes.
            viewRenderer.selectedProject = btn.dataset.project;
            if (viewRenderer.currentView === 'projects') {
              viewRenderer.currentView = 'notes';
              dataManager.updateSettings({ activeView: 'notes' });
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
          const projTab = document.querySelector('.header-tab[data-view="projects"]');
          if (projTab) projTab.classList.add('active');
          document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
          document.getElementById('view-projects').classList.add('active');
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

      // Bind sidebar project dropdown actions (scoped so group dropdowns don't double-bind)
      document.querySelectorAll('.sidebar-project-dropdown .sidebar-dropdown-item, .sidebar-archived-row .sidebar-dropdown-item').forEach(item => {
        item.addEventListener('click', async (e) => {
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
          } else if (action === 'move-group') {
            await dataManager.setProjectGroup(projId, item.dataset.groupId || null);
            buildSidebar();
            renderCurrentView();
          }
        });
      });

      // Bind group header collapse, three-dots menu, and group dropdown actions
      projContainer.querySelectorAll('.sidebar-group-header').forEach(header => {
        header.addEventListener('click', async (e) => {
          if (e.target.closest('.sidebar-group-menu') || e.target.closest('.sidebar-group-dropdown')) return;
          const gid = header.dataset.groupId;
          const g = dataManager.getProjectGroups().find(x => x.id === gid);
          if (!g) return;
          await dataManager.updateProjectGroup(gid, { collapsed: !g.collapsed });
          buildSidebar();
        });
      });
      projContainer.querySelectorAll('.sidebar-group-menu').forEach(menuBtn => {
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.sidebar-project-dropdown, .sidebar-group-dropdown').forEach(d => d.classList.add('hidden'));
          menuBtn.parentElement.querySelector('.sidebar-group-dropdown').classList.toggle('hidden');
        });
      });
      projContainer.querySelectorAll('.sidebar-group-dropdown .sidebar-dropdown-item').forEach(item => {
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          document.querySelectorAll('.sidebar-group-dropdown').forEach(d => d.classList.add('hidden'));
          const gid = item.dataset.groupId;
          const action = item.dataset.action;
          const g = dataManager.getProjectGroups().find(x => x.id === gid);
          if (!g) return;
          if (action === 'edit-group') editGroupFlow(gid);
          else if (action === 'archive-group') archiveGroupFlow(gid);
          else if (action === 'delete-group') deleteGroupFlow(gid);
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

      // Drag projects to reorder AND to move between groups.
      // After any drop we rebuild the projects array from the DOM: order follows the
      // DOM order, and each project's groupId follows the container it now lives in.
      let dragRow = null;
      const clearDragOver = () => {
        projContainer.querySelectorAll('.sidebar-drag-over, .sidebar-group-drop')
          .forEach(el => el.classList.remove('sidebar-drag-over', 'sidebar-group-drop'));
      };
      const commitSidebarOrder = () => {
        const rows = [...projContainer.querySelectorAll('.sidebar-project-row')];
        const newProjects = [];
        rows.forEach(row => {
          const p = dataManager.projects.find(pp => pp.id === row.dataset.project);
          if (!p) return;
          const zone = row.closest('.sidebar-group-projects');
          p.groupId = zone ? (zone.dataset.groupId || null) : null;
          newProjects.push(p);
        });
        // Safety: keep any project that wasn't represented in the DOM
        dataManager.projects.forEach(p => { if (!newProjects.includes(p)) newProjects.push(p); });
        dataManager.projects = newProjects;
        assignRainbowColors(dataManager.projects);
        dataManager._saveProjects();
        buildSidebar();
        renderCurrentView();
      };

      projContainer.querySelectorAll('.sidebar-project-row').forEach(row => {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          dragRow = row;
          row.classList.add('sidebar-drag-active');
          e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('sidebar-drag-active');
          clearDragOver();
          dragRow = null;
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          if (dragRow && row !== dragRow) {
            clearDragOver();
            row.classList.add('sidebar-drag-over');
          }
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove('sidebar-drag-over');
          if (!dragRow || row === dragRow) return;
          const rows = [...projContainer.querySelectorAll('.sidebar-project-row')];
          const fromIdx = rows.indexOf(dragRow);
          const toIdx = rows.indexOf(row);
          if (fromIdx < toIdx) row.after(dragRow); else row.before(dragRow);
          commitSidebarOrder();
        });
      });

      // Group bodies + the ungrouped list are drop zones that change membership
      projContainer.querySelectorAll('.sidebar-group-projects, .sidebar-ungrouped').forEach(zone => {
        zone.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragRow) { clearDragOver(); zone.classList.add('sidebar-group-drop'); }
        });
        zone.addEventListener('dragleave', (e) => {
          if (!zone.contains(e.relatedTarget)) zone.classList.remove('sidebar-group-drop');
        });
        zone.addEventListener('drop', (e) => {
          e.preventDefault();
          zone.classList.remove('sidebar-group-drop');
          if (!dragRow) return;
          const placeholder = zone.querySelector('.sidebar-group-empty');
          if (placeholder) placeholder.remove();
          zone.appendChild(dragRow);
          commitSidebarOrder();
        });
      });

      // Dropping onto a (possibly collapsed) group header drops into that group
      projContainer.querySelectorAll('.sidebar-group-header').forEach(header => {
        header.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (dragRow) { clearDragOver(); header.classList.add('sidebar-group-drop'); }
        });
        header.addEventListener('dragleave', () => header.classList.remove('sidebar-group-drop'));
        header.addEventListener('drop', (e) => {
          e.preventDefault();
          header.classList.remove('sidebar-group-drop');
          if (!dragRow) return;
          const gid = header.dataset.groupId;
          const zone = projContainer.querySelector(`.sidebar-group-projects[data-group-id="${gid}"]`);
          if (zone) {
            const placeholder = zone.querySelector('.sidebar-group-empty');
            if (placeholder) placeholder.remove();
            zone.appendChild(dragRow);
          }
          commitSidebarOrder();
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
        const archived = viewRenderer.selectedProject === 'all-archived';
        dayTitle.textContent = archived ? 'Archived Projects' : 'All Projects';
        subtitle.textContent = archived ? 'Archived project overview' : 'Project Overview';
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

        // The "all-archived" selection is only meaningful in the Projects overview.
        // Leaving to any other tab would otherwise filter notes/calendar/etc. by a
        // project id of 'all-archived' (matching nothing), so fall back to "all".
        if (viewRenderer.selectedProject === 'all-archived' && view !== 'projects') {
          viewRenderer.selectedProject = 'all';
          document.querySelectorAll('#sidebar .sidebar-item[data-project]').forEach(b =>
            b.classList.toggle('active', b.dataset.project === 'all'));
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

    // ============ HOTBAR: show/hide tabs, promoted utilities, drag-reorder, lock ============
    // Open an engineering utility that's been promoted to its own top-bar tab.
    function openHotbarUtility(id, btn) {
      document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
      if (btn) btn.classList.add('active');
      viewRenderer.currentView = 'engineering';
      document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('view-engineering').classList.add('active');
      document.getElementById('quick-filters').classList.add('hidden');
      updateContentHeader();
      engineeringUtilities.select(id);
      dataManager.updateSettings({ activeView: 'engineering' });
    }

    let applyHotbar = () => {};
    try {
      const tabContainer = document.querySelector('.header-tabs');
      const lockBtn = document.getElementById('btn-tab-lock');
      let dragTab = null;
      let locked = !!dataManager.settings?.tabsLocked;
      const tabKey = (t) => t.dataset.view || ('util:' + t.dataset.util);

      function applyLockUI() {
        tabContainer.classList.toggle('tabs-locked', locked);
        tabContainer.querySelectorAll('.header-tab').forEach(t => { t.draggable = !locked; });
        if (lockBtn) {
          lockBtn.innerHTML = locked ? '&#128274;' : '&#128275;'; // 🔒 / 🔓
          lockBtn.title = locked ? 'Tab order locked — click to unlock and reorder' : 'Drag tabs to reorder · click to lock';
          lockBtn.classList.toggle('locked', locked);
        }
      }
      function saveOrder() {
        dataManager.updateSettings({ tabOrder: [...tabContainer.querySelectorAll('.header-tab')].map(tabKey) });
      }
      function bindTabDrag(tab) {
        tab.addEventListener('dragstart', (e) => { if (locked) { e.preventDefault(); return; } dragTab = tab; tab.classList.add('tab-drag-active'); e.dataTransfer.effectAllowed = 'move'; });
        tab.addEventListener('dragend', () => { tab.classList.remove('tab-drag-active'); tabContainer.querySelectorAll('.header-tab').forEach(t => t.classList.remove('tab-drag-over')); dragTab = null; });
        tab.addEventListener('dragover', (e) => { if (locked || !dragTab) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (tab !== dragTab) { tabContainer.querySelectorAll('.header-tab').forEach(t => t.classList.remove('tab-drag-over')); tab.classList.add('tab-drag-over'); } });
        tab.addEventListener('dragleave', () => tab.classList.remove('tab-drag-over'));
        tab.addEventListener('drop', (e) => { e.preventDefault(); tab.classList.remove('tab-drag-over'); if (!dragTab || tab === dragTab) return; const tabs = [...tabContainer.querySelectorAll('.header-tab')]; const fromIdx = tabs.indexOf(dragTab), toIdx = tabs.indexOf(tab); if (fromIdx < toIdx) tab.after(dragTab); else tab.before(dragTab); saveOrder(); });
      }

      // Bind the built-in (data-view) tabs once.
      tabContainer.querySelectorAll('.header-tab[data-view]').forEach(bindTabDrag);

      applyHotbar = function () {
        const hidden = dataManager.settings?.hiddenTabs || [];
        const promoted = dataManager.settings?.hotbarUtilities || [];

        // Show/hide built-in tabs.
        tabContainer.querySelectorAll('.header-tab[data-view]').forEach(t => {
          t.style.display = hidden.includes(t.dataset.view) ? 'none' : '';
        });

        // Rebuild promoted-utility tabs.
        tabContainer.querySelectorAll('.header-tab[data-util]').forEach(t => t.remove());
        promoted.forEach(id => {
          const m = engineeringUtilities.meta && engineeringUtilities.meta(id);
          if (!m) return;
          const btn = document.createElement('button');
          btn.className = 'header-tab header-tab-util';
          btn.dataset.util = id;
          btn.innerHTML = `${m.icon || '🧩'} ${escapeHtml(m.name)}`;
          btn.addEventListener('click', () => openHotbarUtility(id, btn));
          bindTabDrag(btn);
          tabContainer.appendChild(btn);
        });

        // Apply saved order (keys: view name, or 'util:<id>').
        const order = dataManager.settings?.tabOrder;
        if (Array.isArray(order)) {
          order.forEach(key => {
            const el = String(key).startsWith('util:')
              ? tabContainer.querySelector(`.header-tab[data-util="${String(key).slice(5)}"]`)
              : tabContainer.querySelector(`.header-tab[data-view="${key}"]`);
            if (el) tabContainer.appendChild(el);
          });
        }
        if (lockBtn) tabContainer.appendChild(lockBtn);
        applyLockUI();
        if (engineeringUtilities.refresh) engineeringUtilities.refresh();
      };

      if (lockBtn) lockBtn.addEventListener('click', () => { locked = !locked; dataManager.updateSettings({ tabsLocked: locked }); applyLockUI(); });

      applyHotbar();
    } catch (e) { console.warn('Hotbar setup failed:', e); }
    // Let the Settings editor re-apply after toggling tabs/utilities.
    window.applyHotbar = () => applyHotbar();

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

    // ============ SETTINGS (popup) ============
    const settingsModal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('btn-settings-header');
    function openSettings() {
      renderSettings();                 // render fresh each open
      settingsModal.classList.remove('hidden');
      settingsBtn.classList.add('active');
    }
    function closeSettings() {
      settingsModal.classList.add('hidden');
      settingsBtn.classList.remove('active');
    }
    window.openSettings = openSettings;  // let other modules open settings
    settingsBtn.addEventListener('click', openSettings);
    document.getElementById('settings-modal-close').addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings(); });

    // ============ PROJECT BUTTON ============
    document.getElementById('btn-add-project-header').addEventListener('click', () => {
      modalManager.openProjectModal();
    });

    // ============ THEMED CONFIRM (replaces native confirm()) ============
    // Returns a Promise<boolean>. Message supports newlines (rendered via pre-line).
    function showConfirm({ title = 'Confirm', message = '', confirmText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
      return new Promise(resolve => {
        const modal = document.getElementById('modal-confirm');
        document.getElementById('modal-confirm-title').textContent = title;
        document.getElementById('modal-confirm-message').textContent = message;
        const okBtn = document.getElementById('btn-confirm-ok');
        const cancelBtn = document.getElementById('btn-confirm-cancel');
        okBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        okBtn.classList.toggle('btn-modal-danger', !!danger);
        modal.classList.remove('hidden');

        const cleanup = (result) => {
          modal.classList.add('hidden');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          modal.removeEventListener('mousedown', onBackdrop);
          document.removeEventListener('keydown', onKey);
          resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
        const onKey = (e) => {
          if (e.key === 'Escape') cleanup(false);
          else if (e.key === 'Enter') cleanup(true);
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('mousedown', onBackdrop);
        document.addEventListener('keydown', onKey);
        setTimeout(() => okBtn.focus(), 50);
      });
    }
    window._showConfirm = showConfirm;

    // Themed text-input prompt (replaces native prompt(), which returns null in Electron).
    // Resolves the entered string on OK, or null on cancel.
    function showPrompt({ title = 'Enter Value', message = '', placeholder = '', defaultValue = '', confirmText = 'OK', cancelText = 'Cancel' } = {}) {
      return new Promise(resolve => {
        const modal = document.getElementById('modal-prompt');
        document.getElementById('modal-prompt-title').textContent = title;
        const msgEl = document.getElementById('modal-prompt-message');
        msgEl.textContent = message;
        msgEl.style.display = message ? '' : 'none';
        const input = document.getElementById('modal-prompt-input');
        input.placeholder = placeholder;
        input.value = defaultValue;
        const okBtn = document.getElementById('btn-prompt-ok');
        const cancelBtn = document.getElementById('btn-prompt-cancel');
        okBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        modal.classList.remove('hidden');

        const cleanup = (result) => {
          modal.classList.add('hidden');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          modal.removeEventListener('mousedown', onBackdrop);
          input.removeEventListener('keydown', onKey);
          resolve(result);
        };
        const onOk = () => cleanup(input.value);
        const onCancel = () => cleanup(null);
        const onBackdrop = (e) => { if (e.target === modal) cleanup(null); };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
          else if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('mousedown', onBackdrop);
        input.addEventListener('keydown', onKey);
        setTimeout(() => { input.focus(); input.select(); }, 50);
      });
    }
    window._showPrompt = showPrompt;

    // ============ PROJECT GROUP MODAL (create / edit) ============
    const GROUP_PALETTE = ['#6366F1', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#06B6D4'];
    let _groupModalSelectedColor = GROUP_PALETTE[0];

    function renderGroupSwatches() {
      const wrap = document.getElementById('group-color-swatches');
      wrap.innerHTML = GROUP_PALETTE.map(c =>
        `<button type="button" class="group-swatch${c === _groupModalSelectedColor ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`
      ).join('');
      wrap.querySelectorAll('.group-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
          _groupModalSelectedColor = btn.dataset.color;
          wrap.querySelectorAll('.group-swatch').forEach(b => b.classList.toggle('active', b === btn));
        });
      });
    }

    function openGroupModal(editGroup = null) {
      const modal = document.getElementById('modal-group');
      const title = document.getElementById('modal-group-title');
      const nameInput = document.getElementById('group-name-input');
      const saveBtn = document.getElementById('btn-save-group');
      const idInput = document.getElementById('group-edit-id');

      if (editGroup) {
        title.innerHTML = '&#9998; Edit Group';
        saveBtn.textContent = 'Save Changes';
        nameInput.value = editGroup.name || '';
        idInput.value = editGroup.id;
        _groupModalSelectedColor = /^#[0-9a-fA-F]{6}$/.test(editGroup.color || '') ? editGroup.color : GROUP_PALETTE[0];
      } else {
        title.innerHTML = '&#128193; New Group';
        saveBtn.textContent = 'Create';
        nameInput.value = '';
        idInput.value = '';
        _groupModalSelectedColor = GROUP_PALETTE[dataManager.getProjectGroups().length % GROUP_PALETTE.length];
      }
      renderGroupSwatches();
      modal.classList.remove('hidden');
      setTimeout(() => nameInput.focus(), 50);
    }

    async function saveGroupModal() {
      const name = document.getElementById('group-name-input').value.trim();
      if (!name) { document.getElementById('group-name-input').focus(); return; }
      const id = document.getElementById('group-edit-id').value;
      if (id) {
        await dataManager.updateProjectGroup(id, { name, color: _groupModalSelectedColor });
      } else {
        await dataManager.addProjectGroup({ name, color: _groupModalSelectedColor });
      }
      document.getElementById('modal-group').classList.add('hidden');
      buildSidebar();
      renderCurrentView();
    }

    document.getElementById('btn-add-group').addEventListener('click', () => openGroupModal(null));
    document.getElementById('btn-save-group').addEventListener('click', saveGroupModal);
    document.getElementById('btn-cancel-group').addEventListener('click', () =>
      document.getElementById('modal-group').classList.add('hidden'));
    document.getElementById('group-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveGroupModal(); }
    });
    // ---- Centralized group action flows (shared by the sidebar + Projects page) ----
    function editGroupFlow(id) {
      const g = dataManager.getProjectGroups().find(x => x.id === id);
      if (g) openGroupModal(g);
    }
    async function archiveGroupFlow(id) {
      const g = dataManager.getProjectGroups().find(x => x.id === id);
      if (!g) return;
      const count = dataManager.projects.filter(p => p.groupId === id).length;
      const ok = await showConfirm({
        title: 'Archive group',
        message: `Archive group "${g.name}"${count ? ` and its ${count} project${count > 1 ? 's' : ''}` : ''}?\n\n` +
          'The projects and their notes, events, and orders move to the archive. You can unarchive the group later.',
        confirmText: 'Archive',
      });
      if (!ok) return;
      await dataManager.archiveProjectGroup(id);
      buildSidebar();
      renderCurrentView();
    }
    async function deleteGroupFlow(id) {
      const g = dataManager.getProjectGroups().find(x => x.id === id);
      if (!g) return;
      const ok = await showConfirm({
        title: 'Delete group',
        message: `Delete group "${g.name}"?\n\nIts projects become ungrouped — the projects themselves are NOT deleted.`,
        confirmText: 'Delete group',
        danger: true
      });
      if (!ok) return;
      await dataManager.deleteProjectGroup(id);
      buildSidebar();
      renderCurrentView();
    }
    async function unarchiveGroupFlow(id) {
      await dataManager.unarchiveProjectGroup(id);
      buildSidebar();
      renderCurrentView();
    }

    // Expose so buildSidebar's group menu + the Projects page can drive these
    window._openGroupModal = openGroupModal;
    window.addEventListener('add-group', () => openGroupModal(null));
    window.addEventListener('edit-group', (e) => editGroupFlow(e.detail?.id));
    window.addEventListener('archive-group', (e) => archiveGroupFlow(e.detail?.id));
    window.addEventListener('delete-group', (e) => deleteGroupFlow(e.detail?.id));
    window.addEventListener('unarchive-group', (e) => unarchiveGroupFlow(e.detail?.id));

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

    // Auto-sync every 30 minutes (silent — no popups). Skipped in split panes.
    if (!EMB) {
      setInterval(async () => {
        try { await syncOutlook(true); } catch (e) {
          console.warn('Outlook auto-sync failed:', e.message);
        }
      }, 30 * 60 * 1000);

      // Initial sync on app startup (silent, after a short delay)
      setTimeout(() => {
        syncOutlook(true).catch(e => console.warn('Initial Outlook sync failed:', e.message));
      }, 3000);
    }

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

    if (!EMB) {
      setTimeout(() => { syncCalendars().catch(e => console.warn('Initial calendar sync failed:', e.message)); }, 4000);
      setInterval(() => { syncCalendars().catch(() => {}); }, 15 * 60 * 1000); // every 15 min
    }

    // ============ GITHUB ACTIVITY SYNC (linked account → Timeline) ============
    // Pulls commits on the repos you own and caches them in settings (local + sync),
    // so the Timeline can render them. Token lives encrypted in the main process.
    async function syncGitHub() {
      if (!window.api.github) return;
      const status = await window.api.github.status();
      if (!status.connected) return;
      const res = await window.api.github.fetchActivity(90);
      if (res.error) { console.warn('GitHub sync failed:', res.error); return; }
      await dataManager.updateSettings({ gitActivity: res.commits || [], gitLastSync: new Date().toISOString() });
      if (viewRenderer.currentView === 'timeline') viewRenderer.renderTimeline();
    }
    window.syncGitHub = syncGitHub; // Settings "Connect"/"Refresh" call this

    if (!EMB) {
      setTimeout(() => { syncGitHub().catch(e => console.warn('Initial GitHub sync failed:', e.message)); }, 5000);
      setInterval(() => { syncGitHub().catch(() => {}); }, 30 * 60 * 1000); // every 30 min
    }

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
    // Note/sidebar colors are baked in at render time and vary by light/dark theme,
    // so re-render the whole view when the theme changes.
    window.addEventListener('theme-changed', () => scheduleRender({ sidebar: true, dots: true }));

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
        const projTab = document.querySelector('.header-tab[data-view="projects"]');
        if (projTab) projTab.classList.add('active');
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('view-projects').classList.add('active');
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
        const projTab = document.querySelector('.header-tab[data-view="projects"]');
        if (projTab) projTab.classList.add('active');
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('view-projects').classList.add('active');
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
      document.querySelectorAll('.sidebar-group-dropdown').forEach(d => d.classList.add('hidden'));
    });

    // ============ CLOUD SYNC ============
    firebaseSync.init();

    // ---- Mandatory sign-in gate: block the app until a session resolves ----
    (function setupAuthGate() {
      const gate = document.getElementById('auth-gate');
      const body = document.getElementById('auth-gate-body');
      if (!gate || !body) return;

      function renderForm() {
        body.innerHTML = `
          <p class="auth-gate-desc">Sign in to load your board. Your data lives in the cloud, so the app needs you signed in.</p>
          <button id="auth-gate-google" class="btn-google-signin">
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Sign in with Google
          </button>
          <div class="cloud-signin-divider"><span>or</span></div>
          <input type="email" id="auth-gate-email" class="cloud-input" placeholder="Email" autocomplete="email" />
          <input type="password" id="auth-gate-password" class="cloud-input" placeholder="Password" autocomplete="current-password" />
          <button id="auth-gate-email-btn" class="btn-modal-primary" style="width:100%">Sign in with Email</button>
          <div id="auth-gate-error" class="cloud-error hidden"></div>
          <p class="cloud-signin-hint">New here? Enter an email and password — an account is created automatically.</p>`;
        const showErr = (m) => { const el = document.getElementById('auth-gate-error'); el.textContent = m; el.classList.remove('hidden'); };
        document.getElementById('auth-gate-google').addEventListener('click', async () => {
          try { await firebaseSync.signInWithGoogle(); } catch (e) { showErr(e.message || 'Sign-in failed.'); }
        });
        const doEmail = async () => {
          const email = document.getElementById('auth-gate-email').value.trim();
          const pw = document.getElementById('auth-gate-password').value;
          if (!email || !pw) return;
          try { await firebaseSync.signInWithEmail(email, pw); } catch (e) { showErr(e.message || 'Sign-in failed.'); }
        };
        document.getElementById('auth-gate-email-btn').addEventListener('click', doEmail);
        document.getElementById('auth-gate-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doEmail(); });
      }

      let resolved = false;
      window.addEventListener('auth-changed', (e) => {
        resolved = true;
        if (e.detail.signedIn) {
          gate.classList.add('hidden');
        } else {
          if (!body.querySelector('#auth-gate-google')) renderForm();
          gate.classList.remove('hidden');
        }
      });
      // Safety net: if auth never resolves (e.g. Firebase failed to load), still
      // show the sign-in form instead of leaving the user stuck on "Checking…".
      setTimeout(() => { if (!resolved && !body.querySelector('#auth-gate-google')) renderForm(); }, 6000);
    })();

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
    if (dataManager.settings.printerEnabled && !EMB) {
      printerController.startBackground();
      printerInitialized = true; // bridge already rendered + polling; don't re-init on first tab visit
    }

    // Restore last view (handle legacy 'schedule' -> 'calendar', and remove 'tasks')
    let savedView = dataManager.settings.activeView;
    if (savedView === 'schedule') savedView = 'calendar';
    if (savedView === 'tasks') savedView = 'notes';
    if (savedView === 'printer' || savedView === 'slicer') savedView = 'engineering'; // merged into Engineering Utilities

    if (savedView && savedView !== 'notes') {
      const tab = document.querySelector(`.header-tab[data-view="${savedView}"]`);
      if (tab) tab.click();
    } else {
      renderCurrentView();
    }

    console.log('EngOrg initialized:', dataManager.tasks.length, 'notes,', dataManager.scheduleItems.length, 'events,', dataManager.purchases.length, 'purchases');

    // Scan the canonical repo for newer commits and prompt to update. Non-blocking,
    // silent on errors / when up to date. Opt out via Settings → Check for updates.
    if (dataManager.settings.autoCheckUpdates !== false && typeof updateChecker !== 'undefined' && !EMB) {
      setTimeout(() => updateChecker.run(), 1500);
    }

  } catch (err) {
    console.error('Init failed:', err);
    document.body.innerHTML = `<div style="padding:40px;text-align:center;font-family:sans-serif;">
      <h1 style="color:#e74c3c;">Failed to Initialize</h1><p>${err.message}</p></div>`;
  }
})();
