// IPC handlers: Gradescope link → assignment due dates flow into the calendar.
//
// Gradescope has NO public API, so this logs in the way a browser does (POST the
// login form with its CSRF token) and scrapes the dashboard + course pages for
// assignment due dates. Credentials are encrypted at rest with Electron safeStorage
// (DPAPI on Windows), decrypted only here in the main process, and NEVER sent to the
// renderer — gradescope:status returns just the email/connected flag.
//
// Networking uses Electron's net.fetch against a dedicated in-memory session
// partition so the login cookie jar persists across the redirect chain and the
// follow-up course requests automatically (global fetch/undici keeps no cookie jar).
const { ipcMain, safeStorage, net, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { GRADESCOPE_CREDS_FILE } = require('../config');

const BASE = 'https://www.gradescope.com';
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MAX_COURSES = 20;          // safety cap on courses scraped per sync
const PAST_GRACE_DAYS = 7;       // keep assignments due within the last week, drop older

// ── credential store ────────────────────────────────────────────────────────
function loadStore() {
  try { return JSON.parse(fs.readFileSync(GRADESCOPE_CREDS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveStore(obj) {
  fs.mkdirSync(path.dirname(GRADESCOPE_CREDS_FILE), { recursive: true });
  fs.writeFileSync(GRADESCOPE_CREDS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
function encrypt(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable — cannot securely store your password.');
  return safeStorage.encryptString(plain).toString('base64');
}
function decrypt(enc) { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }

// ── session / http helpers ──────────────────────────────────────────────────
// A named, non-persistent partition: cookies live only for this app run and are
// wiped before each fresh login so a stale session can't mask a bad password.
function gsSession() { return session.fromPartition('gradescope-scrape'); }

async function gsFetch(url, opts = {}) {
  const res = await net.fetch(url, {
    session: gsSession(),
    headers: { 'User-Agent': 'Mozilla/5.0 (EngOrg-TaskBoard)', 'Accept': 'text/html,application/xhtml+xml', ...(opts.headers || {}) },
    ...opts,
  });
  return res;
}

const htmlDecode = (s) => (s || '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
const stripTags = (s) => htmlDecode((s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function extractAuthToken(html) {
  const m = html.match(/name="authenticity_token"\s+value="([^"]+)"/) ||
            html.match(/name="csrf-token"\s+content="([^"]+)"/);
  return m ? htmlDecode(m[1]) : null;
}

// Log in and leave the session cookie jar authenticated. Throws on bad credentials.
async function login(email, password) {
  const sess = gsSession();
  try { await sess.clearStorageData({ storages: ['cookies'] }); } catch {}

  const page = await gsFetch(BASE + '/login');
  const token = extractAuthToken(await page.text());
  if (!token) throw new Error('Could not reach the Gradescope login page.');

  const form = new URLSearchParams();
  form.set('utf8', '✓');
  form.set('authenticity_token', token);
  form.set('session[email]', email);
  form.set('session[password]', password);
  form.set('session[remember_me]', '1');
  form.set('commit', 'Log In');
  form.set('session[remember_me_sso]', '0');

  const res = await gsFetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  // net.fetch follows the 302 on success (→ /account) using the session cookie jar.
  // A failed login re-renders /login (200) with a flash error.
  const finalUrl = res.url || '';
  const body = await res.text();
  if (/\/login(\?|$)/.test(finalUrl) || /class="alert-error"|Invalid email\/password|Sorry, your account/i.test(body)) {
    throw new Error('Login failed — check your Gradescope email and password.');
  }
  return body; // this is the account dashboard HTML
}

// ── parsing ─────────────────────────────────────────────────────────────────
// Course boxes on the dashboard → { id, short, name }. Instructor courses are
// harmless to include: their pages have no student assignment table, so they yield
// nothing downstream.
function parseCourses(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*class="[^"]*\bcourseBox\b(?![-\w])[^"]*"[^>]*href="\/courses\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_COURSES) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const inner = m[2];
    const short = stripTags((inner.match(/courseBox--shortname"[^>]*>([\s\S]*?)<\//) || [])[1] || '');
    const name = stripTags((inner.match(/courseBox--name"[^>]*>([\s\S]*?)<\//) || [])[1] || '');
    out.push({ id, short, name: name || short || ('Course ' + id) });
  }
  return out;
}

// A due date may be an ISO string (React props) or Gradescope's "Nov 07 at 11:00PM"
// text (no year — inferred from the academic calendar).
function parseDue(value) {
  if (value == null) return null;
  if (typeof value === 'number') { const d = new Date(value < 1e12 ? value * 1000 : value); return isNaN(d) ? null : d; }
  const s = String(value).trim();
  if (!s) return null;
  const iso = new Date(s);
  if (!isNaN(iso) && /\d{4}-\d{2}-\d{2}|T\d{2}:/.test(s)) return iso;

  const m = s.match(/([A-Za-z]{3,})\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  const day = +m[2];
  let hour = (+m[4]) % 12;
  if (/p/i.test(m[6])) hour += 12;
  const min = +m[5];
  let year = m[3] ? +m[3] : new Date().getFullYear();
  if (!m[3]) {
    // No year given: if the date lands far in the past, it belongs to next year's term.
    const cand = new Date(year, mon, day, hour, min);
    if (cand.getTime() < Date.now() - 150 * 86400000) year += 1;
  }
  const d = new Date(year, mon, day, hour, min);
  return isNaN(d) ? null : d;
}

// Walk arbitrary React-props JSON collecting anything shaped like an assignment.
function collectFromProps(node, out) {
  if (Array.isArray(node)) { for (const n of node) collectFromProps(n, out); return; }
  if (!node || typeof node !== 'object') return;
  const keys = Object.keys(node);
  const nameKey = keys.find(k => /^(title|name|assignment_name)$/i.test(k));
  const dueKey = keys.find(k => /(due_?date|due_?at|hard_?due_?date|hard_?due_?at)/i.test(k));
  if (nameKey && dueKey && node[dueKey] != null && node[nameKey]) {
    const due = parseDue(typeof node[dueKey] === 'object' ? (node[dueKey].date || node[dueKey].due_date) : node[dueKey]);
    if (due) out.push({ name: String(node[nameKey]), due, id: node.id || node.assignment_id || null });
  }
  for (const k of keys) collectFromProps(node[k], out);
}

// Assignments for one course page. Tries React props first, then the classic
// #assignments-student-table markup.
function parseAssignments(html) {
  const found = [];

  // Strategy A: React props blobs.
  const propRe = /data-react-props="([^"]*)"/g;
  let pm;
  while ((pm = propRe.exec(html))) {
    try {
      const json = JSON.parse(htmlDecode(pm[1]));
      collectFromProps(json, found);
    } catch {}
  }

  // Strategy B: server-rendered student table rows.
  if (!found.length) {
    const tableMatch = html.match(/<table[^>]*id="assignments-student-table"[\s\S]*?<\/table>/i);
    const scope = tableMatch ? tableMatch[0] : html;
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rm;
    while ((rm = rowRe.exec(scope))) {
      const row = rm[1];
      const th = row.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
      if (!th) continue;
      const name = stripTags(th[1]);
      if (!name) continue;
      const idM = row.match(/\/assignments\/(\d+)/);
      // First due-date span in the row is the real deadline (a later one is the late-due).
      const dueM = row.match(/submissionTimeChart--dueDate[^>]*>([\s\S]*?)<\//i)
                || row.match(/(?:Due|Late Due)[^<]*<[^>]*>([^<]*\bat\b[^<]*)</i);
      const due = parseDue(stripTags(dueM ? dueM[1] : ''));
      if (due) found.push({ name, due, id: idM ? idM[1] : null });
    }
  }

  // De-dupe within the course by name+time.
  const seen = new Set();
  return found.filter(a => {
    const k = a.name + '|' + a.due.getTime();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ── handlers ────────────────────────────────────────────────────────────────
module.exports = function register() {
  ipcMain.handle('gradescope:status', async () => {
    const s = loadStore();
    return { connected: !!s.passEnc, email: s.email || null };
  });

  ipcMain.handle('gradescope:connect', async (event, email, password) => {
    try {
      email = (email || '').trim();
      password = password || '';
      if (!email || !password) return { error: 'Enter your Gradescope email and password.' };
      await login(email, password); // validates the credentials
      saveStore({ email, passEnc: encrypt(password) });
      return { email };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('gradescope:disconnect', async () => {
    try { fs.unlinkSync(GRADESCOPE_CREDS_FILE); } catch {}
    try { await gsSession().clearStorageData({ storages: ['cookies'] }); } catch {}
    return true;
  });

  // Log in with the stored credentials, scrape every course, and return
  // calendar-ready schedule-item objects (same shape as ipc/calendar.js events).
  ipcMain.handle('gradescope:fetchAssignments', async () => {
    try {
      const s = loadStore();
      if (!s.passEnc) return { error: 'Gradescope is not connected.', events: [] };
      const dashboard = await login(s.email, decrypt(s.passEnc));
      const courses = parseCourses(dashboard);

      const events = [];
      const courseSummary = [];
      const cutoff = Date.now() - PAST_GRACE_DAYS * 86400000;

      for (const c of courses) {
        let assignments = [];
        try {
          const res = await gsFetch(`${BASE}/courses/${c.id}`);
          if (res.ok) assignments = parseAssignments(await res.text());
        } catch (e) { /* skip a course that fails to load */ }

        let kept = 0;
        for (const a of assignments) {
          if (a.due.getTime() < cutoff) continue; // only upcoming (+ this week's past)
          kept++;
          events.push({
            title: a.name,
            description: `Gradescope · ${c.name}`,
            location: c.short || c.name,
            date: localDate(a.due),
            day: DAYS_FULL[a.due.getDay()],
            startTime: localTime(a.due),
            endTime: localTime(a.due),
            allDay: false,
            extId: `gradescope:${c.id}:${a.id || slug(a.name)}`,
            source: 'gradescope',
            url: a.id ? `${BASE}/courses/${c.id}/assignments/${a.id}` : `${BASE}/courses/${c.id}`,
          });
        }
        if (kept) courseSummary.push({ id: c.id, name: c.name, count: kept });
      }

      return { events, courses: courseSummary, coursesScanned: courses.length };
    } catch (err) {
      return { error: err.message, events: [] };
    }
  });
};
