// IPC handlers: Utility Store — fetches a catalog of installable utilities from
// GitHub and manages locally-installed *remote* utilities (self-contained HTML
// rendered in a sandboxed iframe; never executed with app privileges).

const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

const STORE_DIR = path.join(config.DATA_DIR, 'utilities');

module.exports = function registerUtilityStore() {
  // Fetch the GitHub-hosted catalog JSON. Returns { utilities: [...] } or { error }.
  ipcMain.handle('store:fetchCatalog', async (event, url) => {
    const catalogUrl = url || config.UTILITY_STORE_CATALOG_URL;
    if (!catalogUrl) return { error: 'No catalog URL configured' };
    try {
      const r = await fetch(catalogUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) return { error: `Catalog request failed (${r.status})` };
      const data = await r.json();
      const utilities = Array.isArray(data) ? data : (data.utilities || []);
      return { utilities };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Download a remote utility's HTML entry into appdata/utilities/<id>/index.html.
  // Returns { localPath } (a file path the renderer turns into a sandboxed iframe src).
  ipcMain.handle('store:downloadUtility', async (event, entry) => {
    if (!entry || !entry.id || !entry.entry) return { error: 'Invalid utility entry' };
    try {
      const r = await fetch(entry.entry, { cache: 'no-store' });
      if (!r.ok) return { error: `Download failed (${r.status})` };
      const html = await r.text();
      const dir = path.join(STORE_DIR, entry.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
      await fsp.mkdir(dir, { recursive: true });
      const localPath = path.join(dir, 'index.html');
      await fsp.writeFile(localPath, html, 'utf-8');
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(entry, null, 2), 'utf-8');
      return { localPath };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Remove a locally-installed remote utility.
  ipcMain.handle('store:removeUtility', async (event, id) => {
    try {
      const dir = path.join(STORE_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, '_'));
      await fsp.rm(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Return the local index.html path for an installed remote utility, if present.
  ipcMain.handle('store:getLocalPath', async (event, id) => {
    const localPath = path.join(STORE_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, '_'), 'index.html');
    return fs.existsSync(localPath) ? { localPath } : { localPath: null };
  });
};
