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
      description: 'Slice STL/STEP models with OrcaSlicer and send to the printer.',
      paneId: 'eng-util-slicer',
      activate() { slicerController.activate(); },
      deactivate() { slicerController.deactivate(); },
    },
    'kicad-importer': {
      id: 'kicad-importer', name: 'KiCad Importer', icon: '🔌',
      description: 'Consolidate UltraLibrarian / SnapMagic ZIPs into one KiCad library with DigiKey metadata.',
      paneId: 'eng-util-kicad-importer',
      activate() { kicadImporter.mount(document.getElementById('view-kicad-importer')); kicadImporter.activate(); },
      deactivate() {},
    },
    'wifi-checker': {
      id: 'wifi-checker', name: 'WiFi Checker', icon: '📶',
      description: 'Scan meters over WiFi — ping + SSH check, temp shutdown, continuous & scheduled pings.',
      paneId: 'eng-util-wifi-checker',
      activate() { wifiChecker.mount(document.getElementById('view-wifi-checker')); wifiChecker.activate(); },
      deactivate() { wifiChecker.deactivate(); },
    },
    'uart-bridge': {
      id: 'uart-bridge', name: 'UART Bridge', icon: '🔌',
      description: 'Wire up COM/UART ports and FTDI bit-bang devices on a canvas — drag TX→RX to bridge, send hex/ASCII/pulses, and monitor traffic.',
      paneId: 'eng-util-uart-bridge',
      activate() { uartBridge.mount(document.getElementById('view-uart-bridge')); uartBridge.activate(); },
      deactivate() { uartBridge.deactivate(); },
    },
  };
  const BUILTIN_ORDER = ['printer', 'slicer', 'kicad-importer', 'wifi-checker', 'uart-bridge'];

  // ---- Settings-backed install state --------------------------------------
  function getInstalled() {
    let list = dataManager.settings.installedUtilities;
    if (!Array.isArray(list)) {
      list = ['kicad-importer'];
      if (dataManager.settings.printerEnabled) list.push('printer', 'slicer');
      dataManager.updateSettings({ installedUtilities: list });
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
    if (BUILTIN[id]) return { id, name: BUILTIN[id].name, icon: BUILTIN[id].icon };
    const m = getRemoteMeta()[id];
    return { id, name: (m && m.name) || id, icon: (m && m.icon) || '🧩' };
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
    nav.innerHTML = utils.map(u => `
      <button class="eng-nav-item${currentId === u.id ? ' active' : ''}" data-util="${u.id}">
        <span class="eng-nav-icon">${u.icon}</span><span class="eng-nav-name">${escapeHtml(u.name)}</span>
      </button>`).join('') + `
      <div class="eng-nav-sep"></div>
      <button class="eng-nav-item eng-nav-store${currentId === STORE_ID ? ' active' : ''}" data-util="${STORE_ID}">
        <span class="eng-nav-icon">🛒</span><span class="eng-nav-name">Utility Store</span>
      </button>`;
    nav.querySelectorAll('.eng-nav-item').forEach(b => {
      b.addEventListener('click', () => select(b.dataset.util));
    });
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
      showPaneEl(document.getElementById(BUILTIN[id].paneId));
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
      el.innerHTML = `
        <div class="store-header">
          <h2>Utility Store</h2>
          <button id="store-refresh" class="kicad-btn kicad-btn-outline">Refresh</button>
        </div>
        <div id="store-status" class="store-status"></div>
        <div class="store-section-title">Built-in</div>
        <div id="store-builtin" class="store-grid"></div>
        <div class="store-section-title">From GitHub</div>
        <div id="store-remote" class="store-grid"></div>`;
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
    return `
      <div class="store-card">
        <div class="store-card-head"><span class="store-card-icon">${u.icon || '🧩'}</span>
          <span class="store-card-name">${escapeHtml(u.name)}</span>${ver}</div>
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
