// IPC handlers: custom title bar — window controls (minimize / maximize / close)
// and the menu actions that the themed titlebar reproduces from the (now hidden)
// native application menu. See renderer/titlebar.js for the UI.

const { ipcMain, app, screen, BrowserWindow, session } = require('electron');
const { execFile } = require('child_process');
const state = require('../state');

// Kill every non-Electron process this app spawned (FTDI python helper, OrcaSlicer, git,
// powershell, kicad-cli…) along with their own children. Electron's renderer/GPU helpers
// share process.execPath and are left to Chromium's normal shutdown.
function killSpawnedChildren() {
  if (process.platform !== 'win32') return Promise.resolve();
  const ps = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const self = process.execPath.toLowerCase();
      const pids = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split('|')).filter(([pid, exe]) => pid && (exe || '').toLowerCase() !== self).map(([pid]) => pid);
      if (!pids.length) return resolve();
      const args = ['/T', '/F'];
      pids.forEach((p) => args.push('/PID', p));
      execFile('taskkill', args, { windowsHide: true, timeout: 5000 }, () => resolve());
    });
  });
}

// "Quit everything": flush storage so sign-in/onboarding survive, end spawned helper
// processes, then quit — with a hard exit fallback in case something holds the app open
// (desktop mode's tucked-away window, a lingering server).
let quittingAll = false;
async function quitAll() {
  if (quittingAll) return;
  quittingAll = true;
  setTimeout(() => app.exit(0), 4000);
  try { await session.defaultSession.flushStorageData(); } catch (_) {}
  try { await session.defaultSession.cookies.flushStore(); } catch (_) {}
  try { if (state.fluiddServer) state.fluiddServer.close(); } catch (_) {}
  await killSpawnedChildren();
  app.quit();
}

module.exports = function registerWindow(getMainWindow) {
  // Act on the window that asked (the main window, or desktop mode's separate desktop
  // window); fall back to the main window.
  const win = (e) => (e && e.sender && BrowserWindow.fromWebContents(e.sender)) || getMainWindow();

  // In desktop mode (ipc/desktop-mode.js sets w._desktopMode) the window IS the desktop:
  // minimize / expand / fullscreen are ignored so it stays fitted to the work area.
  ipcMain.handle('win:minimize', (e) => { const w = win(e); if (w && !w._desktopMode) w.minimize(); });
  // Expand/restore is owned by main.js (main window keeps an _expanded flag + glass inset).
  ipcMain.handle('win:maximizeToggle', (e) => {
    const w = win(e); if (!w) return false;
    if (w._desktopMode) return false;
    if (typeof w.toggleExpand === 'function') return w.toggleExpand();
    // Fallback for any window without the helpers.
    if (w.isMaximized()) { w.unmaximize(); return false; }
    w.maximize(); return true;
  });
  ipcMain.handle('win:close', (e) => { const w = win(e); if (w) w.close(); });
  ipcMain.handle('win:isMaximized', (e) => {
    const w = win(e);
    return !!(w && (typeof w.isExpanded === 'function' ? w.isExpanded() : w.isMaximized()));
  });
  // Renderer signals when the Liquid Glass theme is active so "maximize" uses the inset.
  ipcMain.handle('win:setGlassMode', (e, on) => { const w = win(e); if (w && typeof w.setGlassMode === 'function') w.setGlassMode(on); });

  // Mirror of the native menu roles so the titlebar dropdowns do the same thing.
  ipcMain.handle('appmenu:action', (e, name) => {
    const w = win(e); if (!w) return;
    const wc = w.webContents;
    switch (name) {
      case 'reload': wc.reload(); break;
      case 'forceReload': wc.reloadIgnoringCache(); break;
      case 'toggleDevTools': wc.toggleDevTools(); break;
      case 'zoomIn': wc.setZoomLevel(wc.getZoomLevel() + 0.5); break;
      case 'zoomOut': wc.setZoomLevel(wc.getZoomLevel() - 0.5); break;
      case 'zoomReset': wc.setZoomLevel(0); break;
      case 'toggleFullscreen': if (!w._desktopMode) w.setFullScreen(!w.isFullScreen()); break;
      case 'undo': wc.undo(); break;
      case 'redo': wc.redo(); break;
      case 'cut': wc.cut(); break;
      case 'copy': wc.copy(); break;
      case 'paste': wc.paste(); break;
      case 'selectAll': wc.selectAll(); break;
      case 'minimize': if (!w._desktopMode) w.minimize(); break;
      case 'close': w.close(); break;
      case 'quit': app.quit(); break;
      case 'quitAll': quitAll(); break;
      default: break;
    }
  });
};
