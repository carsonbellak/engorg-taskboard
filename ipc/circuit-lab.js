// IPC handlers: Circuit Lab + Trace Designer utilities — native open/save dialogs.
//
// The simulator (renderer/circuit-engine.js), the schematic editor (renderer/circuit-sim.js)
// and the PCB editor/autorouter/Gerber writer (renderer/trace-designer.js) all run in the
// RENDERER. This module only owns the dialogs and file I/O: save one text file (circuit /
// board JSON, CSV, SVG), open one, or write a set of files (a Gerber + drill package) into
// a new folder the user picks. Desktop-only.
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const FILTERS = {
  json: { name: 'JSON', extensions: ['json'] },
  csv: { name: 'CSV', extensions: ['csv'] },
  svg: { name: 'SVG image', extensions: ['svg'] },
};
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);

module.exports = function register(getMainWindow) {
  ipcMain.handle('circuitLab:saveText', async (event, text, defaultName) => {
    try {
      const name = safeName(defaultName || 'circuit.json');
      const ext = path.extname(name).slice(1).toLowerCase();
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Save',
        defaultPath: name,
        filters: [FILTERS[ext] || { name: 'File', extensions: [ext || '*'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.promises.writeFile(result.filePath, String(text), 'utf8');
      return { path: result.filePath };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('circuitLab:openText', async (event, filters) => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Open',
        properties: ['openFile'],
        filters: Array.isArray(filters) && filters.length ? filters : [FILTERS.json],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      const file = result.filePaths[0];
      const stat = await fs.promises.stat(file);
      if (stat.size > 20 * 1024 * 1024) return { error: 'File is too large' };
      return { path: file, text: await fs.promises.readFile(file, 'utf8') };
    } catch (err) {
      return { error: err.message };
    }
  });

  // files: [{ name, text }] → written into <picked parent>/<folderName> (suffixed if it exists).
  ipcMain.handle('circuitLab:saveFolder', async (event, files, folderName) => {
    try {
      if (!Array.isArray(files) || !files.length) return { error: 'Nothing to write' };
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose where to put the fabrication files',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      const base = safeName(folderName || 'gerbers');
      let dir = path.join(result.filePaths[0], base);
      for (let n = 2; fs.existsSync(dir); n++) dir = path.join(result.filePaths[0], `${base}-${n}`);
      await fs.promises.mkdir(dir, { recursive: true });
      for (const f of files) await fs.promises.writeFile(path.join(dir, safeName(f.name)), String(f.text), 'utf8');
      return { dir, count: files.length };
    } catch (err) {
      return { error: err.message };
    }
  });
};
