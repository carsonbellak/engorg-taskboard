// IPC: 3D print archive — copies the STL + G-code of each tracked print into a
// local historical store (appdata/print_archive/<id>/) so the settings that
// produced a good (or bad) print are never lost.
const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../config');

const ARCHIVE_DIR = path.join(DATA_DIR, 'print_archive');

module.exports = function register() {
  // Copy the source model + sliced gcode into the archive for a print entry.
  ipcMain.handle('printHistory:archive', async (event, { id, stlPath, gcodePath } = {}) => {
    const out = { stl: null, gcode: null };
    if (!id) return out;
    const dir = path.join(ARCHIVE_DIR, id);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { return out; }
    const copy = async (src, key) => {
      try {
        if (src && fs.existsSync(src)) {
          const dest = path.join(dir, path.basename(src));
          await fs.promises.copyFile(src, dest);
          out[key] = dest;
        }
      } catch (e) { /* keep original path on failure */ }
    };
    await copy(stlPath, 'stl');
    await copy(gcodePath, 'gcode');
    return out;
  });

  // Reveal a print's archived folder in the OS file browser.
  ipcMain.handle('printHistory:openArchive', async (event, id) => {
    if (!id) return;
    await shell.openPath(path.join(ARCHIVE_DIR, id));
  });
};
