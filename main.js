const { app, BrowserWindow, shell, Menu } = require('electron');
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
const registerEmail   = require('./ipc/email');
const registerCalendar = require('./ipc/calendar');
const registerKicadImporter = require('./ipc/kicad-importer');
const registerUtilityStore  = require('./ipc/utility-store');
const registerWifiChecker   = require('./ipc/wifi-checker');

let mainWindow;
const getMainWindow = () => mainWindow;

function ensureDataDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1024, minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: 'Engineering Task Board'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
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
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  ensureDataDir();

  registerData(getMainWindow);
  registerOutlook();
  registerFiles(getMainWindow);
  registerGit();
  registerAuth(getMainWindow);
  registerPrinter(getMainWindow);
  registerSlicer(getMainWindow);
  registerEmail(getMainWindow);
  registerCalendar();
  registerKicadImporter(getMainWindow);
  registerUtilityStore();
  registerWifiChecker(getMainWindow);

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
});

app.on('window-all-closed', () => {
  if (state.fluiddServer) state.fluiddServer.close();
  app.quit();
});
