// Engineering Utilities tab — hosts installable utilities (Printer, Slicer,
// KiCad Importer, and GitHub-installed remote utilities) under one tab with a
// sub-nav and a Utility Store. Built-in utilities ship with the app; remote
// utilities render as self-contained HTML in a sandboxed iframe (no app access).

const engineeringUtilities = (() => {
  const STORE_ID = '__store__';
  let currentId = null;
  const remotePanes = {}; // id -> pane element for remote utilities

  // ---- Built-in utility registry -----------------------------------------
  const BUILTIN = {
    printer: {
      id: 'printer', name: '3D Printer', icon: '🖨️',
      color: '#F97316', tagline: 'Live camera, temperatures and print controls for the K1C.',
      description: 'Moonraker status, live camera feed, and print controls.',
      paneId: 'eng-util-printer',
      activate() {
        if (document.querySelector('#view-printer .printer-dashboard')) printerController.startPolling();
        else printerController.init();
      },
      deactivate() { if (typeof printerController !== 'undefined') printerController.stopPolling(); },
    },
    slicer: {
      id: 'slicer', name: 'Slicer', icon: '⚙️',
      color: '#EAB308', tagline: 'Arrange, slice and send models straight to the printer.',
      description: 'Slice STL/STEP models with OrcaSlicer and send to the printer.',
      paneId: 'eng-util-slicer',
      activate() { slicerController.activate(); },
      deactivate() { slicerController.deactivate(); },
    },
    'kicad-importer': {
      id: 'kicad-importer', name: 'KiCad Importer', icon: '🔌',
      color: '#84CC16', tagline: 'Merge part ZIPs into one KiCad library with DigiKey data.',
      description: 'Consolidate UltraLibrarian / SnapMagic ZIPs into one KiCad library with DigiKey metadata.',
      paneId: 'eng-util-kicad-importer',
      activate() { kicadImporter.mount(document.getElementById('view-kicad-importer')); kicadImporter.activate(); },
      deactivate() {},
    },
    'wifi-checker': {
      id: 'wifi-checker', name: 'WiFi Checker', icon: '📶',
      color: '#06B6D4', tagline: 'Ping, SSH-check and schedule meters over Wi-Fi.',
      description: 'Scan meters over WiFi — ping + SSH check, temp shutdown, continuous & scheduled pings.',
      paneId: 'eng-util-wifi-checker',
      activate() { wifiChecker.mount(document.getElementById('view-wifi-checker')); wifiChecker.activate(); },
      deactivate() { wifiChecker.deactivate(); },
    },
    'uart-bridge': {
      id: 'uart-bridge', name: 'UART Bridge', icon: '🔌',
      color: '#8B5CF6', tagline: 'Wire serial ports together, send data and watch the traffic.',
      description: 'Wire up COM/UART ports and FTDI bit-bang devices on a canvas — drag TX→RX to bridge, send hex/ASCII/pulses, and monitor traffic.',
      paneId: 'eng-util-uart-bridge',
      activate() { uartBridge.mount(document.getElementById('view-uart-bridge')); uartBridge.activate(); },
      deactivate() { uartBridge.deactivate(); },
    },
    'git-manager': {
      id: 'git-manager', name: 'Git Manager', icon: '🌿',
      color: '#10B981', tagline: 'Commit, branch, sync and browse history without the terminal.',
      description: 'GitHub-Desktop-style git client — commit, branch, fetch/pull/push/sync, stash, history and diffs with buttons, plus an optional raw git terminal.',
      paneId: 'eng-util-git-manager',
      activate() { gitManager.mount(document.getElementById('view-git-manager')); gitManager.activate(); },
      deactivate() { gitManager.deactivate(); },
    },
    'engink': {
      id: 'engink', name: 'EngInk', icon: '🖋️',
      color: '#D946EF', tagline: 'A live view of your tablet notebook, page by page.',
      description: 'A live reflection of your tablet’s EngInk notebook over Wi-Fi — watch pages and strokes appear as you write, then export the mirrored notebook to PDF.',
      paneId: 'eng-util-engink',
      activate() { enginkMirror.mount(document.getElementById('view-engink')); enginkMirror.activate(); },
      deactivate() { enginkMirror.deactivate(); },
    },
    'file-merger': {
      id: 'file-merger', name: 'File Merger', icon: '📎',
      color: '#EF4444', tagline: 'Combine PDFs and images into a single document.',
      description: 'Combine PDFs and images into a single PDF — add files, drag to arrange the order, and export one document.',
      paneId: 'eng-util-file-merger',
      activate() { fileMerger.mount(document.getElementById('view-file-merger')); fileMerger.activate(); },
      deactivate() { fileMerger.deactivate(); },
    },
    handwriter: {
      id: 'handwriter', name: 'Handwriter', icon: '✍️',
      color: '#EC4899', tagline: 'LaTeX in, your own handwriting out.',
      description: 'Paste or drop LaTeX and get it back in your own handwriting font on EngInk paper, with connected letters, real fractions and roots. Export a PDF or copy page images.',
      paneId: 'eng-util-handwriter',
      activate() { handwriter.mount(document.getElementById('view-handwriter')); handwriter.activate(); },
      deactivate() { handwriter.deactivate(); },
    },
    'circuit-lab': {
      id: 'circuit-lab', name: 'Circuit Lab', icon: '⚡',
      color: '#F59E0B', tagline: 'Draw a schematic, simulate it, and analyze the result.',
      description: 'Schematic editor with a SPICE-style simulator — live DC operating point, transient scope and AC Bode sweeps of R/L/C, sources, diodes, LEDs and op-amps, plus power balance, Thevenin/Norton and waveform/Bode measurements.',
      paneId: 'eng-util-circuit-lab',
      activate() { circuitLab.mount(document.getElementById('view-circuit-lab')); circuitLab.activate(); },
      deactivate() { circuitLab.deactivate(); },
    },
    'trace-designer': {
      id: 'trace-designer', name: 'Trace Designer', icon: '🧵',
      color: '#14B8A6', tagline: 'Route PCB traces sized for the current they carry.',
      description: 'Two-layer PCB trace editor — import a Circuit Lab schematic, route with 45° bends and vias or autoroute, size traces with the IPC-2221 calculator, check DRC, and export Gerbers + drill files.',
      paneId: 'eng-util-trace-designer',
      activate() { traceDesigner.mount(document.getElementById('view-trace-designer')); traceDesigner.activate(); },
      deactivate() { traceDesigner.deactivate(); },
    },
    share: {
      id: 'share', name: 'Share', icon: '📤',
      color: '#3B82F6', tagline: 'Links, notes and files between your devices.',
      ownHeader: true, // share.js renders its own title row (shared with the PWA)
      description: 'Send links, notes and files between your PCs and phone through your EngOrg account. Drop, paste or type, and it shows up on every signed-in device.',
      paneId: 'eng-util-share',
      activate() { shareView.mount(document.getElementById('view-share')); shareView.activate(); },
      deactivate() { shareView.deactivate(); },
    },
  };
  const BUILTIN_ORDER = ['share', 'printer', 'slicer', 'kicad-importer', 'wifi-checker', 'uart-bridge', 'git-manager', 'engink', 'file-merger', 'handwriter', 'circuit-lab', 'trace-designer'];

  // ---- Settings-backed install state --------------------------------------
  function getInstalled() {
    let list = dataManager.settings.installedUtilities;
    if (!Array.isArray(list)) {
      list = ['kicad-importer'];
      if (dataManager.settings.printerEnabled) list.push('printer', 'slicer');
      dataManager.updateSettings({ installedUtilities: list });
    }
    // Share arrived after most installs were set up: install it once so it shows up without a
    // trip to the store (uninstalling it afterwards sticks).
    if (!dataManager.settings.shareUtilSeeded) {
      if (!list.includes('share')) list = [...list, 'share'];
      dataManager.updateSettings({ installedUtilities: list, shareUtilSeeded: true });
    }
    // Same for the circuit tools (Circuit Lab hands off to Trace Designer, so they come as a pair).
    if (!dataManager.settings.circuitUtilsSeeded) {
      list = [...list, ...['circuit-lab', 'trace-designer'].filter(id => !list.includes(id))];
      dataManager.updateSettings({ installedUtilities: list, circuitUtilsSeeded: true });
    }
    return list;
  }
  function getRemoteMeta() { return dataManager.settings.remoteUtilities || {}; }
  function isInstalled(id) { return getInstalled().includes(id); }
  function isRemote(id) { return !BUILTIN[id]; }

  async function install(id, entry) {
    const list = getInstalled();
    if (!list.includes(id)) list.push(id);
    const patch = { installedUtilities: list };

    if (id === 'printer') {
      patch.printerEnabled = true;
      if (window.api?.printer?.setEnabled) await window.api.printer.setEnabled(true);
    }
    if (entry && entry.entry) { // remote utility — download its HTML bundle
      const r = await window.api.store.downloadUtility(entry);
      if (r.error) { alert('Download failed: ' + r.error); return; }
      patch.remoteUtilities = { ...getRemoteMeta(), [id]: entry };
    }
    await dataManager.updateSettings(patch);
    if (id === 'printer' && typeof printerController !== 'undefined') printerController.startBackground();
    renderSubnav();
    renderStore();
  }

  async function uninstall(id) {
    const list = getInstalled().filter(x => x !== id);
    const patch = { installedUtilities: list };
    if (id === 'printer') {
      patch.printerEnabled = false;
      if (window.api?.printer?.setEnabled) await window.api.printer.setEnabled(false);
    }
    if (isRemote(id)) {
      await window.api.store.removeUtility(id);
      const meta = { ...getRemoteMeta() }; delete meta[id];
      patch.remoteUtilities = meta;
      const pane = remotePanes[id];
      if (pane) { pane.remove(); delete remotePanes[id]; }
    }
    await dataManager.updateSettings(patch);
    if (id === 'printer' && typeof printerController !== 'undefined') printerController.stopBackground();
    if (currentId === id) currentId = null;
    renderSubnav();
    renderStore();
  }

  // ---- Sub-nav ------------------------------------------------------------
  // Utilities promoted to their own top-bar (hotbar) tab — hidden from this sub-nav.
  function getHotbar() { const l = dataManager.settings.hotbarUtilities; return Array.isArray(l) ? l : []; }
  function metaOf(id) {
    if (BUILTIN[id]) return { id, name: BUILTIN[id].name, icon: BUILTIN[id].icon, color: BUILTIN[id].color };
    const m = getRemoteMeta()[id];
    return { id, name: (m && m.name) || id, icon: (m && m.icon) || '🧩' };
  }
  // Each utility has its own colour (like a project): it tints the pane's cards, header
  // tile and sub-nav item via --util-color. Remote utilities fall back to the theme accent.
  const colorStyle = (c) => (c ? ` style="--util-color:${c}"` : '');

  // Shared page header (icon tile + title + tagline) — the Notes view's title row, for utilities.
  function pageHeadHtml(u, actions = '') {
    return `
      <div class="eng-page-head">
        <div class="eng-page-icon">${u.icon || '🧩'}</div>
        <div class="eng-page-titles">
          <h2 class="eng-page-title">${escapeHtml(u.name)}</h2>
          <div class="eng-page-sub" title="${escapeHtml(u.description || '').replace(/"/g, '&quot;')}">${escapeHtml(u.tagline || u.description || '')}</div>
        </div>
        <div class="eng-page-actions">${actions}</div>
      </div>`;
  }
  function ensurePageHead(pane, u) {
    if (!pane) return;
    if (u.color) pane.style.setProperty('--util-color', u.color);
    if (u.ownHeader || pane.querySelector(':scope > .eng-page-head')) return;
    pane.insertAdjacentHTML('afterbegin', pageHeadHtml(u));
  }

  function installedUtilityList() {
    const installed = getInstalled();
    const promoted = getHotbar();
    const builtins = BUILTIN_ORDER.filter(id => installed.includes(id) && !promoted.includes(id)).map(id => BUILTIN[id]);
    const meta = getRemoteMeta();
    const remotes = installed.filter(id => isRemote(id) && !promoted.includes(id)).map(id => ({
      id, name: (meta[id] && meta[id].name) || id, icon: (meta[id] && meta[id].icon) || '🧩', remote: true,
    }));
    return [...builtins, ...remotes];
  }

  function renderSubnav() {
    const nav = document.getElementById('eng-subnav');
    if (!nav) return;
    const utils = installedUtilityList();
    nav.innerHTML = `<div class="eng-nav-label">UTILITIES</div>` + utils.map(u => `
      <button class="eng-nav-item${currentId === u.id ? ' active' : ''}" data-util="${u.id}"${colorStyle(u.color)}>
        <span class="eng-nav-icon">${u.icon}</span><span class="eng-nav-name">${escapeHtml(u.name)}</span>
      </button>`).join('') + `
      <div class="eng-nav-sep"></div>
      <button class="eng-nav-item eng-nav-store${currentId === STORE_ID ? ' active' : ''}" data-util="${STORE_ID}">
        <span class="eng-nav-icon">🛒</span><span class="eng-nav-name">Utility Store</span>
      </button>`;
    nav.querySelectorAll('.eng-nav-item').forEach(b => {
      b.addEventListener('click', () => select(b.dataset.util));
    });
    if (typeof shareView !== 'undefined') shareView.refreshBadge(); // re-attach its unread badge
  }

  // ---- Pane switching -----------------------------------------------------
  function hideAllPanes() {
    document.querySelectorAll('#view-engineering .eng-util-pane').forEach(p => p.classList.remove('active'));
  }
  function showPaneEl(el) { hideAllPanes(); if (el) el.classList.add('active'); }

  async function select(id) {
    // Deactivate the previously shown built-in utility
    if (currentId && BUILTIN[currentId] && currentId !== id) BUILTIN[currentId].deactivate();
    currentId = id;
    renderSubnav();

    if (id === STORE_ID) {
      showPaneEl(document.getElementById('eng-util-store'));
      renderStore();
      return;
    }
    if (BUILTIN[id]) {
      const pane = document.getElementById(BUILTIN[id].paneId);
      ensurePageHead(pane, BUILTIN[id]);
      showPaneEl(pane);
      BUILTIN[id].activate();
      return;
    }
    // Remote utility
    await showRemote(id);
  }

  async function showRemote(id) {
    let pane = remotePanes[id];
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'eng-util-pane';
      pane.id = 'eng-util-' + id;
      document.querySelector('#view-engineering .eng-content').appendChild(pane);
      const lp = await window.api.store.getLocalPath(id);
      if (lp.localPath) {
        const url = await window.api.files.getFileUrl(lp.localPath);
        const iframe = document.createElement('iframe');
        iframe.className = 'eng-remote-frame';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
        iframe.src = url;
        pane.appendChild(iframe);
      } else {
        pane.innerHTML = '<div class="kicad-empty">Utility files missing — reinstall from the store.</div>';
      }
      remotePanes[id] = pane;
    }
    showPaneEl(pane);
  }

  // ---- Utility Store ------------------------------------------------------
  let catalogCache = null;

  async function renderStore() {
    const el = document.getElementById('view-utility-store');
    if (!el) return;
    if (!el.dataset.built) {
      el.innerHTML = pageHeadHtml(
        { icon: '🛒', name: 'Utility Store', tagline: 'Install built-in tools or community utilities from GitHub.' },
        '<button id="store-refresh" class="kicad-btn kicad-btn-outline">↻ Refresh</button>') + `
        <div class="store-body">
        <div id="store-status" class="store-status"></div>
        <div class="store-section-title">Built-in</div>
        <div id="store-builtin" class="store-grid"></div>
        <div class="store-section-title">From GitHub</div>
        <div id="store-remote" class="store-grid"></div>
        </div>`;
      el.dataset.built = '1';
      el.querySelector('#store-refresh').addEventListener('click', () => loadCatalog(true));
    }

    // Built-in cards
    document.getElementById('store-builtin').innerHTML =
      BUILTIN_ORDER.map(id => storeCard(BUILTIN[id], false)).join('');
    bindStoreCards(document.getElementById('store-builtin'), null);

    // Remote cards (from cached catalog)
    const remoteWrap = document.getElementById('store-remote');
    const entries = (catalogCache || []).filter(e => !BUILTIN[e.id]);
    if (!catalogCache) {
      remoteWrap.innerHTML = '<div class="kicad-empty">Loading catalog…</div>';
      loadCatalog(false);
    } else if (!entries.length) {
      remoteWrap.innerHTML = '<div class="kicad-empty">No remote utilities available.</div>';
    } else {
      remoteWrap.innerHTML = entries.map(e => storeCard(e, true)).join('');
      bindStoreCards(remoteWrap, entries);
    }
  }

  function storeCard(u, remote) {
    const installed = isInstalled(u.id);
    const ver = u.version ? `<span class="store-ver">v${escapeHtml(u.version)}</span>` : '';
    const state = installed ? '<span class="store-installed">Installed</span>' : '';
    return `
      <div class="store-card${installed ? ' is-installed' : ''}"${colorStyle(u.color)}>
        <div class="store-card-head"><span class="store-card-icon">${u.icon || '🧩'}</span>
          <span class="store-card-name">${escapeHtml(u.name)}</span>${ver}${state}</div>
        <div class="store-card-desc">${escapeHtml(u.description || '')}</div>
        <button class="kicad-btn ${installed ? 'kicad-btn-outline' : 'kicad-btn-start'} store-action"
          data-id="${u.id}" data-remote="${remote ? 1 : 0}">${installed ? 'Uninstall' : 'Install'}</button>
      </div>`;
  }

  function bindStoreCards(wrap, entries) {
    wrap.querySelectorAll('.store-action').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        if (isInstalled(id)) {
          await uninstall(id);
        } else {
          const entry = entries ? entries.find(e => e.id === id) : null;
          await install(id, entry);
        }
        btn.disabled = false;
      });
    });
  }

  async function loadCatalog(force) {
    const status = document.getElementById('store-status');
    if (status) status.textContent = 'Fetching catalog…';
    try {
      const res = await window.api.store.fetchCatalog();
      if (res.error) {
        catalogCache = catalogCache || [];
        if (status) status.textContent = 'Catalog unavailable: ' + res.error;
      } else {
        catalogCache = res.utilities || [];
        if (status) status.textContent = `${catalogCache.length} utilit${catalogCache.length === 1 ? 'y' : 'ies'} in catalog.`;
      }
    } catch (e) {
      catalogCache = catalogCache || [];
      if (status) status.textContent = 'Catalog error: ' + e.message;
    }
    renderStore();
  }

  function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str == null ? '' : str; return d.innerHTML; }

  // ---- Public API (called from app.js view router) ------------------------
  return {
    activate() {
      renderSubnav();
      const installed = installedUtilityList();
      const target = (currentId && (currentId === STORE_ID || isInstalled(currentId)))
        ? currentId
        : (installed[0] ? installed[0].id : STORE_ID);
      select(target);
    },
    deactivate() {
      if (currentId && BUILTIN[currentId]) BUILTIN[currentId].deactivate();
    },
    // ---- Hotbar integration -------------------------------------------------
    select(id) { return select(id); },           // open a utility directly (from a hotbar tab)
    meta(id) { return metaOf(id); },              // { id, name, icon } for building a tab
    listInstalled() { return getInstalled().map(metaOf); }, // for the hotbar editor
    refresh() { renderSubnav(); },                // re-render sub-nav after promote/demote
  };
})();
