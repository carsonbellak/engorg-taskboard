// IPC handlers: Variate (Purdue's StudioKit assessment platform) → assignment due
// dates flow into the calendar, exactly like the Gradescope / Brightspace links.
//
// Variate has a real JSON API (https://purdue.api.variate.org) but it's gated behind
// Purdue Career Account SSO (BoilerKey + Duo 2FA) using an OAuth/PKCE flow — there is
// NO headless username/password login like Gradescope. So we authenticate the way a
// browser does: open the real web app in an Electron BrowserWindow on a PERSISTENT
// session partition, let the user complete SSO+Duo once, and let the SPA manage the
// OAuth token. On each sync we reopen the app HIDDEN; while the Purdue SSO session is
// alive the SPA re-authenticates silently (no Duo prompt), and we read its bearer
// token from the page to call the API. When the SSO session finally expires the
// silent load can't authenticate and we ask the user to reconnect.
//
// No password is ever stored (SSO): variate.json holds only non-secret metadata
// (name/email/connected). The session itself lives in the encrypted partition cookie
// jar on disk, managed by Chromium.
const { ipcMain, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { VARIATE_APP_URL, VARIATE_API_URL, VARIATE_STATE_FILE } = require('../config');

const PARTITION = 'persist:variate';
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_COURSES = 30;      // safety cap on courses returned per sync
const PAST_GRACE_DAYS = 7;   // keep assignments due within the last week, drop older

let getMainWindow = () => null;

// ── state store (no secrets — just linked-account metadata) ───────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(VARIATE_STATE_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveState(obj) {
  fs.mkdirSync(path.dirname(VARIATE_STATE_FILE), { recursive: true });
  fs.writeFileSync(VARIATE_STATE_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function isAppOrigin(url) {
  try { return new URL(url).origin === new URL(VARIATE_APP_URL).origin; }
  catch { return false; }
}

// ── in-page fetch bundle ──────────────────────────────────────────────────────
// Runs inside the authenticated app page (its own origin), so calls to the API are
// exactly what the SPA itself does. Digs the SPA's OAuth bearer token out of its own
// storage and sends it (plus the session cookie) to the API. Returns a JSON string:
//   { userInfo, groups, groupAssessments, assessments }   on success
//   { needAuth: true, ... }                                when not yet authenticated
function bundleScript() {
  const API = JSON.stringify(VARIATE_API_URL);
  return `(async () => {
    const API = ${API};
    // Find an OAuth access token anywhere in the SPA's persisted storage (redux-persist
    // double-stringifies, so recurse through JSON-in-JSON).
    const token = (function () {
      function dig(v, d) {
        if (d > 6 || v == null) return null;
        if (typeof v === 'string') { const s = v.trim(); if (s[0] === '{' || s[0] === '[') { try { return dig(JSON.parse(s), d + 1); } catch { return null; } } return null; }
        if (typeof v === 'object') {
          for (const k of Object.keys(v)) { if (/^(access_?token|accessToken|id_?token)$/i.test(k) && typeof v[k] === 'string' && v[k].length > 20) return v[k]; }
          for (const k of Object.keys(v)) { const r = dig(v[k], d + 1); if (r) return r; }
        }
        return null;
      }
      try { for (let i = 0; i < localStorage.length; i++) { const t = dig(localStorage.getItem(localStorage.key(i)), 0); if (t) return t; } } catch {}
      return null;
    })();
    async function api(p) {
      try {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = await fetch(API + p, { headers, credentials: 'include' });
        if (!r.ok) return { __status: r.status };
        return await r.json();
      } catch (e) { return { __error: String(e) }; }
    }
    const userInfo = await api('/api/account/userInfo');
    if (!userInfo || userInfo.__status || userInfo.__error) return JSON.stringify({ needAuth: true, reason: 'userinfo', detail: userInfo });
    const [groups, groupAssessments, assessments] = await Promise.all([
      api('/api/groups/home'), api('/api/groupAssessments'), api('/api/assessments'),
    ]);
    return JSON.stringify({ userInfo, groups, groupAssessments, assessments });
  })()`;
}

// Open the Variate web app in a BrowserWindow on the persistent partition and give the
// SPA a chance to restore its OAuth session (silently when hidden). Polls the bundle
// script until it authenticates or times out. `visible` shows the window so the user
// can complete SSO+Duo on first connect.
function runSession({ visible, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    const parent = visible ? getMainWindow() : null;
    const win = new BrowserWindow({
      width: 520, height: 720,
      show: !!visible,
      title: 'Sign in to Variate',
      parent: parent || undefined,
      modal: !!(visible && parent),
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    // Let the Purdue SSO + Duo chain (CAS, duosecurity, popups) proceed unhindered.
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

    let poll, killer;
    const finish = (result) => {
      if (done) return; done = true;
      clearInterval(poll); clearTimeout(killer);
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
      resolve(result);
    };

    win.on('closed', () => { if (!done) { done = true; clearInterval(poll); clearTimeout(killer); resolve({ error: 'cancelled' }); } });

    const tryFetch = async () => {
      if (done || win.isDestroyed()) return;
      let url = '';
      try { url = win.webContents.getURL(); } catch { return; }
      if (!isAppOrigin(url)) return; // still on the SSO / Duo pages — keep waiting
      let raw;
      try { raw = await win.webContents.executeJavaScript(bundleScript(), true); } catch { return; }
      let data; try { data = JSON.parse(raw); } catch { return; }
      if (!data || data.needAuth) return; // authenticated app not ready yet
      finish({ data });
    };

    win.loadURL(VARIATE_APP_URL).catch(() => {});
    poll = setInterval(tryFetch, 1500);
    killer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
    setTimeout(tryFetch, 800);
  });
}

// ── parsing / mapping ─────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Strip a term prefix ("Fall 2026", "Sp25") from a course/group name (mirrors gradescope).
function cleanCourseName(s) {
  return (s || '')
    .replace(/\b(fall|spring|summer|winter|autumn)\s*'?\d{2,4}\b/gi, '')
    .replace(/\b\d{4}\s+(fall|spring|summer|winter|autumn)\b/gi, '')
    .replace(/\b(fa|sp|su|wi)\s*'?\d{2,4}\b/gi, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—:,|]+|[\s\-–—:,|]+$/g, '')
    .trim();
}

// A group name → { name (term-stripped), short (course-code if we can spot one) } so
// the renderer can merge this into the same class project as Gradescope/Brightspace.
function deriveCourse(raw) {
  const name = cleanCourseName(raw) || (raw || '');
  const m = (raw || '')
    .replace(/\b(fall|spring|summer|winter|autumn|fa|sp|su|wi)\s*'?\d{2,4}\b/gi, ' ')
    .match(/\b([A-Za-z]{2,4})\s*(\d{3,5})\b/);
  const short = m ? `${m[1].toUpperCase()} ${m[2]}` : name;
  return { name, short };
}

// StudioKit collections come back as arrays, {items:[…]} envelopes, or id-keyed maps.
function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.items)) return x.items;
  if (x && Array.isArray(x.results)) return x.results;
  if (x && typeof x === 'object') return Object.values(x).filter(v => v && typeof v === 'object' && (v.id != null || v.name || v.title));
  return [];
}

// Walk the /api/groups/home tree collecting every node's id → name.
function collectGroups(node, map, depth) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) { for (const n of node) collectGroups(n, map, depth + 1); return; }
  if (typeof node !== 'object') return;
  if (node.id != null && (node.name || node.title)) map[String(node.id)] = node.name || node.title;
  for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') collectGroups(v, map, depth + 1); }
}

// Turn the API bundle into calendar-ready schedule-item objects (same shape as
// ipc/gradescope.js) plus the course linkage the renderer builds projects/notes from.
function mapAssignments(bundle) {
  const gMap = {};
  collectGroups(bundle.groups, gMap, 0);

  const aMap = {};
  for (const a of asArray(bundle.assessments)) { if (a && a.id != null) aMap[String(a.id)] = a.name || a.title || ''; }

  const events = [];
  const courseKept = {};
  const cutoff = Date.now() - PAST_GRACE_DAYS * 86400000;

  for (const ga of asArray(bundle.groupAssessments)) {
    if (!ga || typeof ga !== 'object') continue;
    // Effective due date = dueDate (soft) → special-access due → endDate (hard close),
    // matching what Variate's own UI shows.
    const dueRaw = ga.dueDate || (ga.specialAccess && ga.specialAccess.dueDate) || ga.endDate;
    const due = dueRaw ? new Date(dueRaw) : null;
    if (!due || isNaN(due) || due.getTime() < cutoff) continue;

    const assessmentId = ga.assessmentId || (ga.assessment && ga.assessment.id) || null;
    const title = (ga.assessment && (ga.assessment.name || ga.assessment.title))
      || ga.name || ga.title || (assessmentId != null && aMap[String(assessmentId)]) || 'Assessment';
    const groupId = ga.groupId || (ga.group && ga.group.id) || null;
    const groupName = (ga.group && (ga.group.name || ga.group.title)) || (groupId != null && gMap[String(groupId)]) || '';
    const { name: courseName, short } = deriveCourse(groupName);

    // currentLearnerStatus: UNSTARTED / SUBMITTED / COMPLETED / ENDED. Done = the
    // student submitted/completed it (ENDED just means the window closed).
    const status = String(ga.currentLearnerStatus || ga.learnerStatus || '').toUpperCase();
    const submitted = /SUBMITTED|COMPLETED|FINALIZED/.test(status) || !!ga.dateFinalized;

    const gaId = ga.id || ga.groupAssessmentId || null;
    const extId = `variate:${groupId || 'x'}:${gaId || assessmentId || slug(title)}`;

    events.push({
      title,
      description: `Variate · ${courseName || 'Course'}`,
      location: short || courseName || 'Course',
      date: localDate(due),
      day: DAYS_FULL[due.getDay()],
      startTime: localTime(due),
      endTime: localTime(due),
      dueISO: due.toISOString(),
      allDay: false,
      submitted,
      extId,
      source: 'variate',
      courseId: groupId != null ? String(groupId) : null,
      course: courseName || 'Course',
      courseShort: short || courseName || 'Course',
      assignmentId: gaId != null ? String(gaId) : null,
      variateAssessmentId: assessmentId != null ? String(assessmentId) : null,
      url: VARIATE_APP_URL,
    });

    if (groupId != null) {
      const k = String(groupId);
      const c = courseKept[k] || (courseKept[k] = { id: k, name: courseName || 'Course', short: short || courseName || 'Course', count: 0 });
      c.count++;
    }
  }

  // Raw counts help diagnose a sync that authenticates but maps nothing (e.g. an
  // unexpected API shape) without needing to reproduce the SSO login.
  const debug = {
    rawGroupAssessments: asArray(bundle.groupAssessments).length,
    rawAssessments: asArray(bundle.assessments).length,
    groups: Object.keys(gMap).length,
    kept: events.length,
  };
  return { events, courses: Object.values(courseKept).slice(0, MAX_COURSES), coursesScanned: Object.keys(gMap).length, debug };
}

// ── handlers ────────────────────────────────────────────────────────────────
module.exports = function register(gmw) {
  if (typeof gmw === 'function') getMainWindow = gmw;

  ipcMain.handle('variate:status', async () => {
    const s = loadState();
    return { connected: !!s.connected, name: s.name || null, email: s.email || null };
  });

  ipcMain.handle('variate:connect', async () => {
    try {
      const r = await runSession({ visible: true, timeoutMs: 4 * 60 * 1000 });
      if (r.error === 'cancelled') return { error: 'Sign-in window was closed.' };
      if (r.error === 'timeout') return { error: 'Timed out waiting for Purdue sign-in — try again.' };
      if (r.error) return { error: 'Sign-in failed — try again.' };
      const u = (r.data && r.data.userInfo) || {};
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.name || null;
      const email = u.email || u.uid || null;
      saveState({ connected: true, name, email, addedAt: new Date().toISOString() });
      return { name, email };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('variate:disconnect', async () => {
    try { fs.unlinkSync(VARIATE_STATE_FILE); } catch {}
    try { await session.fromPartition(PARTITION).clearStorageData(); } catch {}
    return true;
  });

  ipcMain.handle('variate:fetchAssignments', async () => {
    try {
      const s = loadState();
      if (!s.connected) return { error: 'Variate is not connected.', events: [] };
      const r = await runSession({ visible: false, timeoutMs: 45 * 1000 });
      if (r.error || !r.data) {
        return { error: 'Your Purdue session expired — reconnect Variate in Settings.', events: [], needAuth: true };
      }
      return mapAssignments(r.data);
    } catch (err) {
      return { error: err.message, events: [] };
    }
  });
};
