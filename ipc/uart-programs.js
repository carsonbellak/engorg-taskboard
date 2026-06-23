// IPC handlers: UART Bridge program library — saves/loads visual programs as JSON
// in appdata/uart_programs/, and handles Python script export/import via file
// dialogs. The Python files carry an embedded model header so they round-trip
// back into the visual editor losslessly.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

const DIR = path.join(config.DATA_DIR, 'uart_programs');
const safe = (n) => String(n || 'untitled').replace(/[^a-zA-Z0-9_\- ]/g, '_').trim() || 'untitled';

module.exports = function registerUartPrograms(getMainWindow) {
  ipcMain.handle('uartprog:list', async () => {
    try {
      await fsp.mkdir(DIR, { recursive: true });
      const files = await fsp.readdir(DIR);
      return { names: files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) };
    } catch (e) { return { names: [], error: e.message }; }
  });

  ipcMain.handle('uartprog:save', async (e, { name, data }) => {
    try {
      await fsp.mkdir(DIR, { recursive: true });
      await fsp.writeFile(path.join(DIR, safe(name) + '.json'), data, 'utf-8');
      return { ok: true, name: safe(name) };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('uartprog:load', async (e, name) => {
    try { return { data: await fsp.readFile(path.join(DIR, safe(name) + '.json'), 'utf-8') }; }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('uartprog:delete', async (e, name) => {
    try { await fsp.unlink(path.join(DIR, safe(name) + '.json')); return { ok: true }; }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('uartprog:exportPython', async (e, { suggestedName, code }) => {
    try {
      const win = getMainWindow && getMainWindow();
      const r = await dialog.showSaveDialog(win, {
        title: 'Export program as Python',
        defaultPath: safe(suggestedName) + '.py',
        filters: [{ name: 'Python', extensions: ['py'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      await fsp.writeFile(r.filePath, code, 'utf-8');
      return { path: r.filePath };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('uartprog:importPython', async () => {
    try {
      const win = getMainWindow && getMainWindow();
      const r = await dialog.showOpenDialog(win, {
        title: 'Import a UART Bridge Python script',
        properties: ['openFile'],
        filters: [{ name: 'Python', extensions: ['py'] }],
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true };
      const content = await fsp.readFile(r.filePaths[0], 'utf-8');
      return { content, path: r.filePaths[0] };
    } catch (err) { return { error: err.message }; }
  });
};
