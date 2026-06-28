// window-split.js — View → Split Window (an in-window grid of independent app
// instances) and View → Set Theme (a LOCAL, non-synced per-window theme).
//
// Loaded BEFORE app.js so it can decide, before anything else initializes,
// whether this window is the split "shell" (a grid of <iframe> app instances)
// and short-circuit the normal app boot behind the panes.
//
// How it works:
//   • Layout is stored in localStorage (`splitLayout`) — local to this machine,
//     never synced to the cloud. Changing layout just reloads the window.
//   • The shell renders N iframes of index.html?embedded=1&pane=i[&theme=…] and
//     hides its own titlebar/header so the only chrome is each pane's own bar.
//   • Each pane is a full app instance; app.js suppresses background services
//     (Outlook/calendar sync, printer bridge, update checks) when embedded.
//   • "Set Theme" applies a theme for display only: the top window persists it in
//     localStorage; a pane reports it to the shell so it survives a reload.
(function () {
  const params = new URLSearchParams(location.search);
  const EMBEDDED = params.get('embedded') === '1';
  const PANE_INDEX = parseInt(params.get('pane') || '-1', 10);
  const LS_LAYOUT = 'splitLayout';
  const LS_LOCAL_THEME = 'localTheme';

  // type -> { panes, css (grid), label }. "vertical" = columns (widescreen),
  // "horizontal" = rows (tall/portrait).
  const LAYOUTS = {
    single: { panes: 1, css: '', label: 'Single (no split)' },
    '2v':   { panes: 2, css: 'grid-template-columns:1fr 1fr;',            label: '2× Side by side (vertical)' },
    '2h':   { panes: 2, css: 'grid-template-rows:1fr 1fr;',               label: '2× Stacked (horizontal)' },
    '3v':   { panes: 3, css: 'grid-template-columns:1fr 1fr 1fr;',        label: '3× Columns (vertical)' },
    '3h':   { panes: 3, css: 'grid-template-rows:1fr 1fr 1fr;',           label: '3× Rows (horizontal)' },
    '4q':   { panes: 4, css: 'grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;', label: '4× Quadrant' },
    '4v':   { panes: 4, css: 'grid-template-columns:repeat(4,1fr);',      label: '4× Columns (vertical)' },
    '4h':   { panes: 4, css: 'grid-template-rows:repeat(4,1fr);',         label: '4× Rows (horizontal)' },
  };

  function readConfig() {
    try { const c = JSON.parse(localStorage.getItem(LS_LAYOUT)); if (c && LAYOUTS[c.type]) return c; } catch {}
    return { type: 'single', themes: [] };
  }
  function writeConfig(c) { try { localStorage.setItem(LS_LAYOUT, JSON.stringify(c)); } catch {} }

  const config = readConfig();
  const isShell = !EMBEDDED && config.type !== 'single';

  function applyThemeSafe(themeId) {
    try { if (typeof applyTheme === 'function' && (typeof COLOR_THEMES === 'undefined' || COLOR_THEMES[themeId])) applyTheme(themeId); } catch {}
  }

  // Effective theme override at startup (consulted by settings.js initTheme).
  function startupThemeOverride() {
    if (EMBEDDED) return params.get('theme') || null;
    return localStorage.getItem(LS_LOCAL_THEME) || null;
  }
  let runtimeTheme = startupThemeOverride(); // live override, updated on Set Theme

  // ---- shell render -------------------------------------------------------
  function renderShell() {
    document.body.classList.add('split-shell');
    applyThemeSafe(localStorage.getItem(LS_LOCAL_THEME) || 'default');
    const root = document.getElementById('split-root');
    if (!root) return;
    const L = LAYOUTS[config.type] || LAYOUTS.single;
    root.style.cssText = 'display:grid;gap:0;' + (L.css || '');
    root.innerHTML = '';
    for (let i = 0; i < L.panes; i++) {
      const frame = document.createElement('iframe');
      frame.className = 'split-frame';
      const theme = config.themes && config.themes[i];
      frame.src = `index.html?embedded=1&pane=${i}` + (theme ? '&theme=' + encodeURIComponent(theme) : '');
      root.appendChild(frame);
    }
    buildShellControls();
  }

  // The shell titlebar is hidden, so provide a small floating min/max/close
  // cluster (with a drag-grab strip) at the window's top-right corner.
  function buildShellControls() {
    if (document.getElementById('split-winctrls')) return;
    const api = window.api;
    if (!api || !api.win) return;
    const cc = String.fromCharCode;
    const MIN = cc(0xE921), MAX = cc(0xE922), RES = cc(0xE923), CLOSE = cc(0xE8BB);
    const wrap = document.createElement('div');
    wrap.id = 'split-winctrls';
    wrap.innerHTML =
      `<button class="tb-btn" id="sw-min" title="Minimize">${MIN}</button>` +
      `<button class="tb-btn" id="sw-max" title="Maximize">${MAX}</button>` +
      `<button class="tb-btn tb-close" id="sw-close" title="Close">${CLOSE}</button>`;
    document.body.appendChild(wrap);
    const maxBtn = wrap.querySelector('#sw-max');
    const setIcon = (m) => { maxBtn.textContent = m ? RES : MAX; maxBtn.title = m ? 'Restore' : 'Maximize'; };
    wrap.querySelector('#sw-min').onclick = () => api.win.minimize();
    maxBtn.onclick = async () => setIcon(await api.win.maximizeToggle());
    wrap.querySelector('#sw-close').onclick = () => api.win.close();
    api.win.onMaximized(setIcon);
    api.win.isMaximized().then(setIcon).catch(() => {});
  }

  // Messages from panes: theme reports (persist per pane) and layout changes
  // (only the shell/top window can actually re-tile + reload).
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d) return;
    if (d.type === 'split-theme' && typeof d.index === 'number' && d.index >= 0) {
      const c = readConfig();
      c.themes = c.themes || [];
      c.themes[d.index] = d.theme || null;
      writeConfig(c);
    } else if (d.type === 'split-setlayout' && LAYOUTS[d.layout]) {
      applyLayout(d.layout);
    }
  });

  // ---- public actions -----------------------------------------------------
  function applyLayout(type) {
    const c = readConfig();
    c.type = type;
    if (!c.themes) c.themes = [];
    writeConfig(c);
    location.reload(); // clean rebuild — avoids tearing down a live app instance
  }
  function setLayout(type) {
    if (!LAYOUTS[type]) return;
    // From a pane, ask the shell to do it (a pane's own reload wouldn't re-tile).
    if (EMBEDDED) { try { parent.postMessage({ type: 'split-setlayout', layout: type }, '*'); } catch {} return; }
    applyLayout(type);
  }

  function themeChanged() { try { window.dispatchEvent(new CustomEvent('theme-changed')); } catch {} }

  function setLocalTheme(themeId) {
    runtimeTheme = themeId;
    applyThemeSafe(themeId);
    themeChanged();
    if (EMBEDDED) { try { parent.postMessage({ type: 'split-theme', index: PANE_INDEX, theme: themeId }, '*'); } catch {} }
    else { try { localStorage.setItem(LS_LOCAL_THEME, themeId); } catch {} }
  }

  function clearLocalTheme() {
    runtimeTheme = null;
    const synced = (window.dataManager && dataManager.settings && dataManager.settings.theme) || 'default';
    applyThemeSafe(synced);
    themeChanged();
    if (EMBEDDED) { try { parent.postMessage({ type: 'split-theme', index: PANE_INDEX, theme: null }, '*'); } catch {} }
    else { try { localStorage.removeItem(LS_LOCAL_THEME); } catch {} }
  }

  function themeList() {
    try { return Object.entries(COLOR_THEMES).map(([id, t]) => ({ id, name: t.name })); } catch { return []; }
  }

  window.windowSplit = {
    EMBEDDED,
    isShell: () => isShell,
    renderShell,
    setLayout,
    currentLayout: () => readConfig().type,
    layouts: () => Object.entries(LAYOUTS).map(([id, l]) => ({ id, label: l.label })),
    setLocalTheme,
    clearLocalTheme,
    currentLocalTheme: () => runtimeTheme,
    themeList,
    startupThemeOverride,
  };

  if (EMBEDDED) document.documentElement.classList.add('is-embedded');

  // Render the shell now (DOM up to this script already exists), before app.js.
  if (isShell) {
    if (document.getElementById('split-root')) renderShell();
    else document.addEventListener('DOMContentLoaded', renderShell);
  }
})();
