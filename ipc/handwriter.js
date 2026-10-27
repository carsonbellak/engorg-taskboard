// IPC handlers: Handwriter utility — save the rendered handwriting pages.
//
// The LaTeX layout and the handwriting itself are drawn in the RENDERER
// (renderer/handwriter.js) on a <canvas> with the user's handwriting font, and the
// PDF is assembled there with the bundled pdf-lib global. This module only owns
// the native save dialog and the file write. Desktop-only.
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const FILTERS = {
  pdf: { name: 'PDF', extensions: ['pdf'] },
  png: { name: 'PNG image', extensions: ['png'] },
};

module.exports = function register(getMainWindow) {
  // `bytes` is a Uint8Array of the PDF/PNG; the default name's extension picks the filter.
  ipcMain.handle('handwriter:save', async (event, bytes, defaultName) => {
    try {
      const name = defaultName || 'handwriting.pdf';
      const ext = path.extname(name).slice(1).toLowerCase();
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Save handwriting',
        defaultPath: name,
        filters: [FILTERS[ext] || FILTERS.pdf],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.promises.writeFile(result.filePath, Buffer.from(bytes));
      return { path: result.filePath };
    } catch (err) {
      return { error: err.message };
    }
  });
};
