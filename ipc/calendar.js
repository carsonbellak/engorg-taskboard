// IPC handlers: external calendar sync.
//   - calendar:fetchFeed(url)  → fetch an ICS feed (Brightspace, Google, iCloud, Outlook…)
//   - normalizeIcs(text, src)  → parse ICS + expand recurrences into schedule-item objects
// Email-invite scanning lives in ipc/email.js (it reuses the IMAP pool) but calls
// normalizeIcs() from here so all ICS parsing goes through one place.
const { ipcMain } = require('electron');
const https = require('https');
const http = require('http');
const ical = require('node-ical');

const WINDOW_BACK_DAYS = 30;
const WINDOW_FWD_DAYS = 120;
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Build one normalized schedule-item from a start/end Date pair.
function makeEvent(ev, startDt, endDt, source, occurrenceKey) {
  const allDay = ev.datetype === 'date';
  return {
    title: (ev.summary || 'Event').toString().slice(0, 200),
    description: (ev.description || '').toString().replace(/\r?\n/g, ' ').slice(0, 300),
    location: (ev.location || '').toString().slice(0, 200),
    date: localDate(startDt),
    day: DAYS_FULL[startDt.getDay()],
    startTime: allDay ? null : localTime(startDt),
    endTime: allDay || !endDt ? null : localTime(endDt),
    allDay,
    extId: `${source}:${ev.uid || 'nouid'}:${occurrenceKey}`,
    source,
  };
}

// Parse an ICS string and expand recurrences within the sync window.
function normalizeIcs(text, source) {
  const parsed = ical.sync.parseICS(text);
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_BACK_DAYS * 86400000);
  const windowEnd = new Date(now.getTime() + WINDOW_FWD_DAYS * 86400000);

  const events = [];
  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    const durationMs = ev.end ? (ev.end - ev.start) : 0;

    if (ev.rrule) {
      // Recurring: expand each occurrence, honoring EXDATE and per-instance overrides.
      const exdates = Object.keys(ev.exdate || {}).map(k => new Date(ev.exdate[k]).getTime());
      const occurrences = ev.rrule.between(windowStart, windowEnd, true);
      for (const occ of occurrences) {
        if (exdates.includes(occ.getTime())) continue;
        const override = ev.recurrences && ev.recurrences[localDate(occ)];
        const startDt = override ? override.start : occ;
        const endDt = override ? override.end : new Date(occ.getTime() + durationMs);
        events.push(makeEvent(override || ev, startDt, endDt, source, localDate(occ)));
      }
    } else {
      // Single event: include if it falls within the window.
      if (ev.start >= windowStart && ev.start <= windowEnd) {
        events.push(makeEvent(ev, ev.start, ev.end, source, localDate(ev.start)));
      }
    }
    if (events.length >= 2000) break; // safety cap
  }
  return events;
}

// Fetch an ICS feed over http/https, following a couple of redirects (webcal:// → https).
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u = url.trim().replace(/^webcal:\/\//i, 'https://');
    let parsed;
    try { parsed = new URL(u); } catch { return reject(new Error('Invalid feed URL')); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(u, { timeout: 15000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 4) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, u).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Feed returned HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', c => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', (e) => reject(new Error('Could not reach feed: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Feed request timed out')); });
  });
}

module.exports = function register() {
  ipcMain.handle('calendar:fetchFeed', async (e, url, source) => {
    const text = await fetchUrl(url);
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That URL did not return a calendar (ICS) feed.');
    return normalizeIcs(text, source || 'feed');
  });
};

// Exported for ipc/email.js to parse calendar parts pulled from messages.
module.exports.normalizeIcs = normalizeIcs;
