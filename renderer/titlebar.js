// Custom themed title bar — reproduces the (now hidden) native File/Edit/View/
// Window menu and the window controls, themed with the app's CSS variables so it
// follows whatever color theme is active. Window/menu actions go through
// window.api.win.* / window.api.menu.* → ipc/window.js.
//
// Items support: { action } (→ api.menu.action), { onClick } (local handler),
// { submenu: [...] } (right-hand flyout), { checked }, { sep }.

(function initTitlebar() {
  const api = window.api;
  if (!api || !api.win) return; // not running under Electron (e.g. plain browser)

  // Segoe MDL2 Assets glyphs for the maximize / restore states.
  const ICON_MAX = String.fromCharCode(0xE922);     // maximize
  const ICON_RESTORE = String.fromCharCode(0xE923); // restore

  const ws = window.windowSplit;

  // ── Dynamic View submenus (Split Window + Set Theme) ───────────────────────
  function splitSubmenu() {
    if (!ws) return [];
    const cur = ws.currentLayout();
    return ws.layouts().map(l => ({ label: l.label, checked: l.id === cur, onClick: () => ws.setLayout(l.id) }));
  }
  function themeSubmenu() {
    if (!ws) return [];
    const cur = ws.currentLocalTheme();
    const items = [{ label: 'Use synced theme', checked: !cur, onClick: () => ws.clearLocalTheme() }, { sep: true }];
    ws.themeList().forEach(t => items.push({ label: t.name, checked: t.id === cur, onClick: () => ws.setLocalTheme(t.id) }));
    return items;
  }

  function buildViewItems() {
    const items = [
      { label: 'Show Console', action: 'toggleDevTools', accel: 'Ctrl+Shift+I' },
      { sep: true },
      { label: 'Reload', action: 'reload', accel: 'Ctrl+R' },
      { label: 'Force Reload', action: 'forceReload' },
      { sep: true },
      { label: 'Reset Zoom', action: 'zoomReset' },
      { label: 'Zoom In', action: 'zoomIn' },
      { label: 'Zoom Out', action: 'zoomOut' },
      { sep: true },
      { label: 'Toggle Fullscreen', action: 'toggleFullscreen', accel: 'F11' },
    ];
    if (ws) {
      items.push({ sep: true });
      // Panes drive layout too (a pane forwards the change to the shell) so you can
      // re-split or return to Single from inside any view.
      items.push({ label: 'Split Window', submenu: splitSubmenu });
      items.push({ label: 'Set Theme', submenu: themeSubmenu });
    }
    return items;
  }

  const MENUS = [
    { label: 'File', items: [
      { label: 'Quit', action: 'quit', accel: 'Ctrl+Q' },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', action: 'undo', accel: 'Ctrl+Z' },
      { label: 'Redo', action: 'redo', accel: 'Ctrl+Y' },
      { sep: true },
      { label: 'Cut', action: 'cut', accel: 'Ctrl+X' },
      { label: 'Copy', action: 'copy', accel: 'Ctrl+C' },
      { label: 'Paste', action: 'paste', accel: 'Ctrl+V' },
      { label: 'Select All', action: 'selectAll', accel: 'Ctrl+A' },
    ] },
    { label: 'View', items: buildViewItems },
    { label: 'Window', items: [
      { label: 'Minimize', action: 'minimize' },
      { label: 'Close', action: 'close' },
    ] },
  ];

  const bar = document.getElementById('titlebar');
  const menuRoot = document.getElementById('titlebar-menu');
  if (!bar || !menuRoot) return;

  let openDropdown = null; // top-level <div class="tb-dropdown">
  let menuActive = false;  // hover-to-switch is enabled while a menu is open

  function closeMenu() {
    bar.querySelectorAll('.tb-dropdown').forEach((d) => d.remove());
    openDropdown = null;
    menuRoot.querySelectorAll('.tb-menu-btn.open').forEach((b) => b.classList.remove('open'));
    menuActive = false;
  }

  function closeSubmenus() { bar.querySelectorAll('.tb-dropdown.tb-submenu').forEach((d) => d.remove()); }

  // Render a list of items into a dropdown element. `isSubmenu` is true for items
  // inside a flyout — those must NOT close submenus on hover (that would close the
  // very flyout the cursor just moved into).
  function renderItems(dd, items, isSubmenu) {
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement('div'); s.className = 'tb-sep'; dd.appendChild(s); return; }
      const item = document.createElement('button');
      item.className = 'tb-item' + (it.submenu ? ' tb-haschild' : '');
      const right = it.submenu ? '▸' : (it.accel || '');
      item.innerHTML = `<span class="tb-item-label">${it.checked ? '✓ ' : ''}${it.label}</span>${right ? `<span class="tb-accel">${right}</span>` : ''}`;
      if (it.submenu) {
        const open = () => openSubmenu(item, typeof it.submenu === 'function' ? it.submenu() : it.submenu);
        item.addEventListener('mouseenter', open);
        item.addEventListener('click', (e) => { e.stopPropagation(); open(); });
      } else {
        // Only top-level items dismiss an open flyout when hovered.
        if (!isSubmenu) item.addEventListener('mouseenter', closeSubmenus);
        item.addEventListener('click', (e) => {
          e.stopPropagation(); closeMenu();
          if (it.onClick) it.onClick(); else if (it.action) api.menu.action(it.action);
        });
      }
      dd.appendChild(item);
    });
  }

  function openSubmenu(parentItem, items) {
    closeSubmenus();
    const dd = document.createElement('div');
    dd.className = 'tb-dropdown tb-submenu';
    renderItems(dd, items, true);
    bar.appendChild(dd);
    // Fixed (viewport) positioning so it's independent of the dropdown's offset parent.
    const pr = parentItem.getBoundingClientRect();
    let left = pr.right - 2;
    if (left + dd.offsetWidth > window.innerWidth) left = pr.left - dd.offsetWidth + 2;
    let top = pr.top;
    if (top + dd.offsetHeight > window.innerHeight) top = Math.max(0, window.innerHeight - dd.offsetHeight - 4);
    dd.style.position = 'fixed';
    dd.style.left = Math.max(0, left) + 'px';
    dd.style.top = top + 'px';
  }

  function openMenu(btn, menu) {
    closeMenu();
    btn.classList.add('open');
    menuActive = true;
    const dd = document.createElement('div');
    dd.className = 'tb-dropdown';
    renderItems(dd, typeof menu.items === 'function' ? menu.items() : menu.items);
    bar.appendChild(dd);
    // Position under its button, clamped to the window width.
    const left = Math.min(btn.offsetLeft, bar.clientWidth - dd.offsetWidth - 2);
    dd.style.left = Math.max(0, left) + 'px';
    openDropdown = dd;
  }

  MENUS.forEach((menu) => {
    const btn = document.createElement('button');
    btn.className = 'tb-menu-btn';
    btn.textContent = menu.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.classList.contains('open')) closeMenu();
      else openMenu(btn, menu);
    });
    // Classic menu behavior: once one menu is open, hovering switches to another.
    btn.addEventListener('mouseenter', () => { if (menuActive && !btn.classList.contains('open')) openMenu(btn, menu); });
    menuRoot.appendChild(btn);
  });

  // Dismiss menus on outside click or Escape.
  document.addEventListener('click', () => closeMenu());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ── Window controls ────────────────────────────────────────────────────────
  const maxBtn = document.getElementById('tb-max');
  const setMaxIcon = (isMax) => {
    if (!maxBtn) return;
    maxBtn.textContent = isMax ? ICON_RESTORE : ICON_MAX;
    maxBtn.title = isMax ? 'Restore' : 'Maximize';
  };

  const minBtn = document.getElementById('tb-min');
  const closeBtn = document.getElementById('tb-close');
  if (minBtn) minBtn.addEventListener('click', () => api.win.minimize());
  if (maxBtn) maxBtn.addEventListener('click', async () => setMaxIcon(await api.win.maximizeToggle()));
  if (closeBtn) closeBtn.addEventListener('click', () => api.win.close());

  api.win.onMaximized((isMax) => setMaxIcon(isMax));
  api.win.isMaximized().then(setMaxIcon).catch(() => {});
})();
