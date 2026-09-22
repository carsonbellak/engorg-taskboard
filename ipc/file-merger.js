// IPC handlers: File Merger utility — pick PDFs/images and save the merged PDF.
//
// The actual PDF assembly happens in the RENDERER (renderer/file-merger.js) with
// the bundled pdf-lib global, because it needs a <canvas> to normalize arbitrary
// image formats (webp/gif/bmp…) into embeddable bytes — which the main process
// has no DOM for. This module only owns the two things that require Node/Electron:
// the native open dialog (with PDF+image filters) and writing the final bytes to
// a user-chosen path via a save dialog. Reading each input file's bytes reuses the
// existing files:readBinary handler. Desktop-only.
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const IMAGE_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

module.exports = function register(getMainWindow) {
  ipcMain.handle('fileMerger:selectFiles', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: 'Select PDFs and images to merge',
      filters: [
        { name: 'PDFs & Images', extensions: IMAGE_EXTS },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    const out = [];
    for (const fp of result.filePaths) {
      let size = 0;
      try { size = (await fs.promises.stat(fp)).size; } catch (_) {}
      out.push({ name: path.basename(fp), path: fp, ext: path.extname(fp).slice(1).toLowerCase(), size });
    }
    return out;
  });

  // Save the merged PDF. `bytes` is a Uint8Array/ArrayBuffer of the assembled PDF.
  ipcMain.handle('fileMerger:save', async (event, bytes, defaultName) => {
    try {
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Save merged PDF',
        defaultPath: defaultName || 'merged.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const buf = Buffer.from(bytes);
      await fs.promises.writeFile(result.filePath, buf);
      return { path: result.filePath };
    } catch (err) {
      return { error: err.message };
    }
  });
};
