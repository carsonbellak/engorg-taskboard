const { app, BrowserWindow, shell, Menu, MenuItem, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const state = require('./state');
const moonraker = require('./moonraker');
const { startFluiddServer } = require('./fluidd-server');

const registerData    = require('./ipc/data');
const registerOutlook = require('./ipc/outlook');
const registerFiles   = require('./ipc/files');
const registerGit     = require('./ipc/git');
const registerAuth    = require('./ipc/auth');
const registerPrinter = require('./ipc/printer');
const registerSlicer  = require('./ipc/slicer');
const registerPrintHistory = require('./ipc/print-history');
const registerEmail   = require('./ipc/email');
const registerCalendar = require('./ipc/calendar');
const registerGithub  = require('./ipc/github');
const registerGradescope = require('./ipc/gradescope');
const registerClaude  = require('./ipc/claude');
const registerVariate = require('./ipc/variate');
const registerSpell   = require('./ipc/spell');
const registerKicadImporter = require('./ipc/kicad-importer');
const registerUtilityStore  = require('./ipc/utility-store');
const registerWifiChecker   = require('./ipc/wifi-checker');
const registerContribute    = require('./ipc/contribute');
const registerFtdi          = require('./ipc/ftdi');
const registerUartPrograms  = require('./ipc/uart-programs');
const registerUpdates       = require('./ipc/updates');
const registerWindow        = require('./ipc/window');
const registerEnginkMirror  = require('./ipc/engink-mirror');
const registerFileMerger    = require('./ipc/file-merger');
const registerRelease       = require('./ipc/release');
const registerOsTheme       = require('./ipc/os-theme');
const registerDesktopMode   = require('./ipc/desktop-mode');
const registerPiLink        = require('./ipc/pi-link');

let mainWindow;
const getMainWindow = () => mainWindow;

// ── Single instance ─────────────────────────────────────────────────────────────────
// Two copies of the app would share one Chromium profile: the second can't open Local
// Storage / IndexedDB, so it boots signed-out on the first-run screen while both fight
// over the window. A second launch (e.g. double-clicking the shortcut while desktop mode
// has the board behind other apps) now brings the running copy forward instead.
// updates:restart relaunches with --relaunched, so that launch waits briefly for the
// exiting instance to release the lock rather than quitting as a duplicate.
async function acquireSingleInstance() {
  if (app.requestSingleInstanceLock()) return true;
  if (!process.argv.includes('--relaunched')) return false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Desktop + normal window: a relaunch brings the (possibly hidden) normal window back.
  if (registerDesktopMode.isActive() && !registerDesktopMode.hasSeparateWindow()) { registerDesktopMode.reveal(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function ensureDataDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

// Win11 acrylic: a transparent window base + DWM acrylic material, so when the Liquid
// Glass theme fades its surfaces out the desktop shows (frosted) through the app. Other
// themes paint an opaque body over it, so they look unchanged. No-op off Windows.
const WINDOW_LOOK = process.platform === 'win32' ? { backgroundColor: '#00000000', backgroundMaterial: 'acrylic' } : {};

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    // Split Window renders the app inside same-origin <iframe>s. This makes the
    // preload (and thus window.api via contextBridge) load in those subframes too.
    nodeIntegrationInSubFrames: true,
    // Custom offline spell checker (ipc/spell.js + renderer/spellcheck.js) handles
    // note fields with hover suggestions; Chromium's built-in checker is left off
    // so the two don't double-underline.
    spellcheck: false
  };
}

// Per-window wiring shared by the main window and the separate desktop window.
function wireAppWebContents(win) {
  // Native edit context menu for editable fields (spelling is handled by the custom
  // offline checker in the renderer, so no spelling items here).
  win.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return; // non-editable right-clicks use the app's own menus
    const menu = new Menu();
    menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
    menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
    menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
    menu.append(new MenuItem({ role: 'selectAll' }));
    menu.popup();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Keep the application menu registered (for keyboard accelerators) but hidden —
  // the custom titlebar reproduces the menu items visually.
  win.setMenuBarVisibility(false);
}

// Desktop mode's "keep a normal window too": a second app instance that ipc/desktop-mode.js
// attaches to the desktop. Embedded (like a Split Window pane) so it doesn't re-run the
// main window's background services (calendar/LMS sync, printer bridge, update checks);
// off the taskbar, since it's the desktop rather than an app. Created hidden.
function createDesktopWindow() {
  const win = new BrowserWindow({
    ...screen.getPrimaryDisplay().workArea,
    show: false,
    skipTaskbar: true,
    titleBarStyle: 'hidden',
    ...WINDOW_LOOK,
    webPreferences: webPreferences(),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: 'Engineering Task Board — Desktop'
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { embedded: '1', desktop: '1' } });
  wireAppWebContents(win);
  return win;
}

function createWindow() {
  // Clamp the initial window to the current display's WORK AREA (screen minus the
  // taskbar), so on a laptop shorter than our 1400×900 preference the bottom of the
  // app isn't pushed off-screen behind the taskbar. Leave a small margin and center.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const winWidth  = Math.min(1400, workArea.width  - 40);
  const winHeight = Math.min(900,  workArea.height - 40);

  mainWindow = new BrowserWindow({
    width: winWidth, height: winHeight, center: true,
    minWidth: Math.min(1024, winWidth), minHeight: Math.min(700, winHeight),
    // Custom themed title bar (renderer/titlebar.js): hide the native caption +
    // menu bar but keep the resizable window frame. The app draws its own slim,
    // theme-aware bar with the File/Edit/View/Window menus and window controls.
    titleBarStyle: 'hidden',
    ...WINDOW_LOOK,
    webPreferences: webPreferences(),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: 'Engineering Task Board'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  wireAppWebContents(mainWindow);

  // Desktop mode with "keep a normal window too": the desktop lives in its own window, so
  // closing this one just tucks it away (a relaunch or turning desktop mode off brings it
  // back) — it keeps running the background services. Quitting still closes it.
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  mainWindow.on('close', (e) => {
    if (quitting || !registerDesktopMode.hasSeparateWindow()) return;
    e.preventDefault();
    mainWindow.hide();
  });

  // ── Maximize that respects the taskbar (and keeps Liquid Glass acrylic alive) ──────
  // A native maximize on a hidden-title-bar window can spill under the taskbar, and — for
  // the Liquid Glass theme — Windows drops the acrylic desktop-see-through once a window
  // covers the screen. So "maximize" is a manual resize to the display work area; in glass
  // mode we leave a small inset so the window never fully covers the screen and acrylic
  // survives. An explicit _expanded flag tracks the state (geometry-matching was fragile
  // once an inset is involved).
  const GLASS_INSET = 8;
  const workAreaFor = () => screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const expandedBounds = () => {
    const wa = workAreaFor();
    if (!mainWindow._glassMode) return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
    const i = GLASS_INSET;
    return { x: wa.x + i, y: wa.y + i, width: wa.width - 2 * i, height: wa.height - 2 * i };
  };
  mainWindow._expanded = false;
  let _fitting = false;
  // Remember the last "normal" (non-expanded) bounds for Restore. Skip while we're resizing
  // to/from the expanded state so it never captures the expanded geometry.
  const trackNormal = () => {
    if (_fitting) return;
    if (mainWindow && !mainWindow._expanded && !mainWindow.isMaximized()) mainWindow._normalBounds = mainWindow.getBounds();
  };
  mainWindow.on('resize', trackNormal);
  mainWindow.on('move', trackNormal);

  mainWindow.expand = () => {
    if (!mainWindow._expanded && !mainWindow.isMaximized()) mainWindow._normalBounds = mainWindow.getBounds();
    _fitting = true;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setBounds(expandedBounds());
    mainWindow._expanded = true;
    _fitting = false;
    mainWindow.webContents.send('win:maximized', true);
  };
  mainWindow.restore = () => {
    _fitting = true;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow._normalBounds) mainWindow.setBounds(mainWindow._normalBounds);
    mainWindow._expanded = false;
    _fitting = false;
    mainWindow.webContents.send('win:maximized', false);
  };
  mainWindow.toggleExpand = () => { mainWindow._expanded ? mainWindow.restore() : mainWindow.expand(); return mainWindow._expanded; };
  mainWindow.isExpanded = () => mainWindow._expanded;
  // Renderer reports whether Liquid Glass is active; if we're already expanded, re-fit so
  // the inset appears/disappears the moment the theme changes.
  mainWindow.setGlassMode = (on) => {
    const changed = mainWindow._glassMode !== !!on;
    mainWindow._glassMode = !!on;
    if (changed && mainWindow._expanded) { _fitting = true; mainWindow.setBounds(expandedBounds()); _fitting = false; }
  };

  mainWindow.on('maximize', () => { if (!_fitting) mainWindow.expand(); });   // double-click / snap / Win+Up
  mainWindow.on('unmaximize', () => { if (!_fitting) { mainWindow._expanded = false; mainWindow.webContents.send('win:maximized', false); } });

  // ── Web Serial support (UART Bridge utility) ───────────────────────────────
  // Local trusted desktop app: grant permission checks, and relay the OS serial
  // port list to the renderer so the user can pick which COM port to add.
  const ses = mainWindow.webContents.session;
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial' || true);
  let pendingSerialCallback = null;
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    pendingSerialCallback = callback;
    mainWindow.webContents.send('serial:portList', portList.map((p) => ({
      portId: p.portId, portName: p.portName, displayName: p.displayName,
      vendorId: p.vendorId, productId: p.productId,
    })));
  });
  ipcMain.on('serial:selectPort', (e, portId) => {
    if (pendingSerialCallback) { pendingSerialCallback(portId || ''); pendingSerialCallback = null; }
  });
}

// Application menu. The app launches without a console window (launch.vbs), so
// "View > Show Console" gives access to the DevTools console on demand.
function buildMenu() {
  const template = [
    { label: 'File', submenu: [{ role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Show Console',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => { if (mainWindow) mainWindow.webContents.openDevTools(); }
        },
        { type: 'separator' },
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        // Zoom roles are intentionally omitted: their Ctrl +/-/0 accelerators zoom
        // the whole webContents (every split pane at once). Zoom is handled per
        // window/pane in the renderer (window-split.js) so a split pane zooms only
        // itself; the View-menu items call window.windowSplit.zoom*.
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (!(await acquireSingleInstance())) { app.quit(); return; }
  ensureDataDir();

  registerData(getMainWindow);
  registerOutlook();
  registerFiles(getMainWindow);
  registerGit();
  registerAuth(getMainWindow);
  registerPrinter(getMainWindow);
  registerSlicer(getMainWindow);
  registerPrintHistory(getMainWindow);
  registerEmail(getMainWindow);
  registerCalendar();
  registerGithub();
  registerGradescope();
  registerClaude(getMainWindow);
  registerVariate(getMainWindow);
  registerSpell();
  registerKicadImporter(getMainWindow);
  registerUtilityStore();
  registerWifiChecker(getMainWindow);
  registerContribute();
  registerFtdi();
  registerUartPrograms(getMainWindow);
  registerUpdates();
  registerWindow(getMainWindow);
  registerEnginkMirror(getMainWindow);
  registerFileMerger(getMainWindow);
  registerRelease();
  registerOsTheme();
  registerDesktopMode(getMainWindow, { createDesktopWindow });
  registerPiLink(getMainWindow);

  // Start the 3D-printer subsystems only when the user has enabled printer support.
  // On a Compact install (no 3D Printer Tools component) the printer stays disabled,
  // so we skip both the Fluidd proxy and the Moonraker LAN discovery entirely — the app
  // must not touch the network hunting for a printer that isn't part of this install.
  // Discovery still runs lazily when the user later enables the printer (the Settings
  // toggle calls printer:setEnabled, and the printer view calls printer:resolveUrl).
  let savedPrinterUrl = null;
  let printerEnabled = false;
  try {
    const settingsPath = path.join(config.DATA_DIR, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.printerIp) savedPrinterUrl = `http://${settings.printerIp}:${settings.printerPort || 7125}`;
      printerEnabled = settings.printerEnabled === true;
    }
  } catch {}

  if (printerEnabled) {
    startFluiddServer();
    // Resolve the printer's Moonraker URL at startup (health-check the saved/config IP,
    // scan the LAN if it's unreachable). Self-heals DHCP address changes. Non-blocking.
    moonraker.resolve({ seed: savedPrinterUrl }).catch(e => console.warn('[Moonraker] startup resolve failed:', e.message));
  }

  createWindow();
  buildMenu();
  // buildMenu() sets the application menu (kept for keyboard accelerators); make
  // sure the native menu bar stays hidden afterward — the custom titlebar owns it.
  if (mainWindow) mainWindow.setMenuBarVisibility(false);
  // If the app was left in desktop mode (acting as the Windows desktop), re-enter it once
  // the first paint lands. No-op off Windows / when off (state: appdata/desktop_mode.json).
  registerDesktopMode.startupAttach();
});

app.on('window-all-closed', () => {
  if (state.fluiddServer) state.fluiddServer.close();
  try { registerEnginkMirror.stop(); } catch (_) {}
  app.quit();
});
