// IPC handlers: Share — send links, text and files between the user's own devices.
//
// The transfer itself runs in the RENDERER (renderer/share.js) over Firestore, so this
// module only owns what needs Node/Electron: the PC's name (default device label),
// writing a received file into Downloads without overwriting anything, and revealing it
// in Explorer. Desktop-only.
const { ipcMain, app, shell } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

// A sender-supplied name must never escape Downloads or hit a reserved Windows name.
function safeName(name) {
  let n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n.slice(0, 180) || 'shared-file';
}

// "report.pdf" → "report (1).pdf", "report (2).pdf", … until one is free.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

module.exports = function register() {
  ipcMain.handle('share:deviceName', () => os.hostname());

  // `bytes` is the reassembled file (Uint8Array). Returns { path } or { error }.
  ipcMain.handle('share:saveDownload', async (event, bytes, name) => {
    try {
      const dir = app.getPath('downloads');
      await fs.promises.mkdir(dir, { recursive: true });
      const filePath = uniquePath(dir, safeName(name));
      await fs.promises.writeFile(filePath, Buffer.from(bytes));
      return { path: filePath };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('share:showInFolder', (event, filePath) => {
    shell.showItemInFolder(filePath);
  });
};
