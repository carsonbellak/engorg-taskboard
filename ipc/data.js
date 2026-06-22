// IPC handlers: data persistence, file dialogs, shell operations, installer build
const { ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../config');

const ALLOWED_FILES = [
  'tasks.json', 'projects.json', 'purchases.json', 'settings.json',
  'schedule.json', 'todos.json', 'archived_projects.json'
];

module.exports = function register(getMainWindow) {
  ipcMain.handle('data:load', async (event, filename) => {
    if (!ALLOWED_FILES.includes(filename)) throw new Error('Invalid filename');
    const filePath = path.join(DATA_DIR, filename);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle('data:save', async (event, filename, data) => {
    if (!ALLOWED_FILES.includes(filename)) throw new Error('Invalid filename');
    const filePath = path.join(DATA_DIR, filename);
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  });

  ipcMain.handle('shell:openExternal', async (event, url) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('shell:openPath', async (event, filePath) => {
    await shell.openPath(filePath);
  });

  ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: 'Select files to attach'
    });
    if (result.canceled) return [];
    return result.filePaths.map(fp => ({ name: path.basename(fp), path: fp }));
  });

  ipcMain.handle('installer:build', async () => {
    try {
      const { build } = require('../build-installer');
      await build();
      return { success: true, path: 'C:\\Assistant\\EngOrg-Setup.exe' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
};
