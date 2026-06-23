// IPC handlers: custom title bar — window controls (minimize / maximize / close)
// and the menu actions that the themed titlebar reproduces from the (now hidden)
// native application menu. See renderer/titlebar.js for the UI.

const { ipcMain, app } = require('electron');

module.exports = function registerWindow(getMainWindow) {
  const win = () => getMainWindow();

  ipcMain.handle('win:minimize', () => { const w = win(); if (w) w.minimize(); });
  ipcMain.handle('win:maximizeToggle', () => {
    const w = win(); if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('win:close', () => { const w = win(); if (w) w.close(); });
  ipcMain.handle('win:isMaximized', () => { const w = win(); return !!(w && w.isMaximized()); });

  // Mirror of the native menu roles so the titlebar dropdowns do the same thing.
  ipcMain.handle('appmenu:action', (e, name) => {
    const w = win(); if (!w) return;
    const wc = w.webContents;
    switch (name) {
      case 'reload': wc.reload(); break;
      case 'forceReload': wc.reloadIgnoringCache(); break;
      case 'toggleDevTools': wc.toggleDevTools(); break;
      case 'zoomIn': wc.setZoomLevel(wc.getZoomLevel() + 0.5); break;
      case 'zoomOut': wc.setZoomLevel(wc.getZoomLevel() - 0.5); break;
      case 'zoomReset': wc.setZoomLevel(0); break;
      case 'toggleFullscreen': w.setFullScreen(!w.isFullScreen()); break;
      case 'undo': wc.undo(); break;
      case 'redo': wc.redo(); break;
      case 'cut': wc.cut(); break;
      case 'copy': wc.copy(); break;
      case 'paste': wc.paste(); break;
      case 'selectAll': wc.selectAll(); break;
      case 'minimize': w.minimize(); break;
      case 'close': w.close(); break;
      case 'quit': app.quit(); break;
      default: break;
    }
  });
};
