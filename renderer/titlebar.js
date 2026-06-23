// Custom themed title bar — reproduces the (now hidden) native File/Edit/View/
// Window menu and the window controls, themed with the app's CSS variables so it
// follows whatever color theme is active. Window/menu actions go through
// window.api.win.* / window.api.menu.* → ipc/window.js.

(function initTitlebar() {
  const api = window.api;
  if (!api || !api.win) return; // not running under Electron (e.g. plain browser)

  // Segoe MDL2 Assets glyphs for the maximize / restore states.
  const ICON_MAX = String.fromCharCode(0xE922);     // maximize
  const ICON_RESTORE = String.fromCharCode(0xE923); // restore

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
    { label: 'View', items: [
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
    ] },
    { label: 'Window', items: [
      { label: 'Minimize', action: 'minimize' },
      { label: 'Close', action: 'close' },
    ] },
  ];

  const bar = document.getElementById('titlebar');
  const menuRoot = document.getElementById('titlebar-menu');
  if (!bar || !menuRoot) return;

  let openDropdown = null; // currently open <div class="tb-dropdown">
  let menuActive = false;  // hover-to-switch is enabled while a menu is open

  function closeMenu() {
    if (openDropdown) { openDropdown.remove(); openDropdown = null; }
    menuRoot.querySelectorAll('.tb-menu-btn.open').forEach((b) => b.classList.remove('open'));
    menuActive = false;
  }

  function openMenu(btn, menu) {
    closeMenu();
    btn.classList.add('open');
    menuActive = true;
    const dd = document.createElement('div');
    dd.className = 'tb-dropdown';
    menu.items.forEach((it) => {
      if (it.sep) { const s = document.createElement('div'); s.className = 'tb-sep'; dd.appendChild(s); return; }
      const item = document.createElement('button');
      item.className = 'tb-item';
      item.innerHTML = `<span>${it.label}</span>${it.accel ? `<span class="tb-accel">${it.accel}</span>` : ''}`;
      item.addEventListener('click', () => { closeMenu(); api.menu.action(it.action); });
      dd.appendChild(item);
    });
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
