// IPC handlers: external calendar sync.
//   - calendar:fetchFeed(url)  → fetch an ICS feed (Brightspace, Google, iCloud, Outlook…)
// Parsing lives in core/ics.js (Electron-free, shared with the Raspberry Pi build). A linked
// Pi keeps every feed pre-fetched, so it answers from its cache first; the desktop fetches
// directly whenever the Pi is unlinked, down, or the feed fails there.
// Email-invite scanning lives in ipc/email.js (it reuses the IMAP pool) but calls
// normalizeIcs() re-exported from here so all ICS parsing goes through one place.
const { ipcMain } = require('electron');
const { normalizeIcs, fetchFeed } = require('../core/ics');
const piLink = require('./pi-link');

module.exports = function register() {
  ipcMain.handle('calendar:fetchFeed', async (e, url, source) => {
    const viaPi = await piLink.fetchFeed(url, source);
    if (viaPi) return viaPi;
    return fetchFeed(url, source);
  });
};

// Exported for ipc/email.js to parse calendar parts pulled from messages.
module.exports.normalizeIcs = normalizeIcs;
