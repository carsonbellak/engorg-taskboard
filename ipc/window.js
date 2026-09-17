// IPC handlers: custom title bar — window controls (minimize / maximize / close)
// and the menu actions that the themed titlebar reproduces from the (now hidden)
// native application menu. See renderer/titlebar.js for the UI.

const { ipcMain, app, screen } = require('electron');

module.exports = function registerWindow(getMainWindow) {
  const win = () => getMainWindow();

  ipcMain.handle('win:minimize', () => { const w = win(); if (w) w.minimize(); });
  // Expand/restore is owned by main.js (main window keeps an _expanded flag + glass inset).
  ipcMain.handle('win:maximizeToggle', () => {
    const w = win(); if (!w) return false;
    if (typeof w.toggleExpand === 'function') return w.toggleExpand();
    // Fallback for any window without the helpers.
    if (w.isMaximized()) { w.unmaximize(); return false; }
    w.maximize(); return true;
  });
  ipcMain.handle('win:close', () => { const w = win(); if (w) w.close(); });
  ipcMain.handle('win:isMaximized', () => {
    const w = win();
    return !!(w && (typeof w.isExpanded === 'function' ? w.isExpanded() : w.isMaximized()));
  });
  // Renderer signals when the Liquid Glass theme is active so "maximize" uses the inset.
  ipcMain.handle('win:setGlassMode', (e, on) => { const w = win(); if (w && typeof w.setGlassMode === 'function') w.setGlassMode(on); });

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
