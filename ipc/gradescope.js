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
const { GRADESCOPE_CREDS_FILE, GRADESCOPE_ATTACH_DIR } = require('../config');

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

// Ensure the scrape session is authenticated, reusing a recent login so a single
// sync (dashboard + every course + attachment downloads) logs in only once.
// Returns the dashboard HTML when a fresh login happened, else null.
let _authAt = 0;
async function ensureAuth() {
  const s = loadStore();
  if (!s.passEnc) throw new Error('Gradescope is not connected.');
  if (Date.now() - _authAt < 40 * 60 * 1000) return null; // still fresh
  const dashboard = await login(s.email, decrypt(s.passEnc));
  _authAt = Date.now();
  return dashboard;
}

// ── parsing ─────────────────────────────────────────────────────────────────
// Course boxes on the dashboard → { id, short, name }. Instructor courses are
// harmless to include: their pages have no student assignment table, so they yield
// nothing downstream.
// Strip a term label ("Fall 2026", "2025 Spring", "Sp25") from a course name so
// the project is just the class (e.g. "Fall 2026 ME 270" → "ME 270").
function cleanCourseName(s) {
  return (s || '')
    .replace(/\b(fall|spring|summer|winter|autumn)\s*'?\d{2,4}\b/gi, '')
    .replace(/\b\d{4}\s+(fall|spring|summer|winter|autumn)\b/gi, '')
    .replace(/\b(fa|sp|su|wi)\s*'?\d{2,4}\b/gi, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')          // stray empty brackets left behind
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—:,|]+|[\s\-–—:,|]+$/g, '')
    .trim();
}

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
    const short = cleanCourseName(stripTags((inner.match(/courseBox--shortname"[^>]*>([\s\S]*?)<\//) || [])[1] || ''));
    const name = cleanCourseName(stripTags((inner.match(/courseBox--name"[^>]*>([\s\S]*?)<\//) || [])[1] || ''));
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

// Does this assignment object look already-submitted / graded?
function isSubmittedProps(node) {
  for (const k of Object.keys(node)) {
    if (/^(status|submission_status|state)$/i.test(k) && /submitt|graded|complete/i.test(String(node[k]))) return true;
    if (/^(submitted|is_submitted|has_submission)$/i.test(k) && node[k] === true) return true;
    if (/^(grade|score|points_earned)$/i.test(k) && node[k] != null && node[k] !== '') return true;
  }
  return false;
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
    if (due) out.push({ name: String(node[nameKey]), due, id: node.id || node.assignment_id || null, submitted: isSubmittedProps(node) });
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
      // Submission status: the status cell reads "Submitted"/"Graded"/a score when
      // done, "No Submission" when not. (Note "No Submission" must not match.)
      const statusText = stripTags((row.match(/class="[^"]*submissionStatus[^"]*"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '');
      const submitted = /submissionStatus-complete/i.test(row)
        || /\bsubmitted\b|\bgraded\b/i.test(statusText)
        || /\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?/.test(statusText);
      if (due) found.push({ name, due, id: idM ? idM[1] : null, submitted });
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

// ── attachments ───────────────────────────────────────────────────────────────
// Coursework file types we'll download; executables are never fetched.
const SAFE_EXT = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|rtf|md|py|ipynb|m|c|h|cpp|hpp|cc|java|js|ts|tex|json|xml|png|jpe?g|gif|svg|stl|step|stp|obj|dxf|dwg)$/i;
const BLOCK_EXT = /\.(exe|bat|cmd|com|msi|sh|ps1|scr|dll|jar|apk|vbs|js)$/i;
// Only Gradescope + its file-storage CDNs — never a host injected into page markup.
const ALLOWED_HOST = /(^|\.)gradescope\.com$|(^|\.)amazonaws\.com$|(^|\.)cloudfront\.net$/i;

// Reject site chrome (logos, favicons, sprites, webpack/asset-pipeline images,
// thumbnail avatars like "64x64-<hash>.png"). Real assignment files live under
// /courses/ on gradescope.com, or on the S3/CloudFront upload CDNs.
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
function isAssetUrl(urlStr) {
  let u;
  try { u = new URL(urlStr, BASE); } catch { return true; }
  const p = u.pathname.toLowerCase();
  const base = p.split('/').pop() || '';
  if (/^\d+x\d+[-_.]/.test(base)) return true;                                   // 64x64-… thumbnails
  if (/(^|[-_])(logo|favicon|sprite|icon|avatar|apple-touch|brand)([-_.]|$)/.test(base)) return true;
  if (/\/(assets|packs|images|img|icons|static)\//.test(p)) return true;         // asset pipelines
  if (/(^|\.)gradescope\.com$/i.test(u.hostname) && !p.startsWith('/courses/')) return true;
  return false;
}

// Recursively pull file-looking URLs out of React-props JSON. Accepts a URL when it
// ends in a known file type OR sits under a file-ish key (e.g. template_pdf_url,
// outline_url, attachment_url) even without an extension — Gradescope's submission
// page is React-rendered, so the instructor PDF lives in props, not a plain <a>.
function collectUrls(node, out, key) {
  if (typeof node === 'string') {
    if (!/^https?:\/\//i.test(node)) return;
    const pathOnly = node.split('?')[0];
    const keyish = key && /(pdf|template|outline|attachment|handout|packet|worksheet|download|starter|file)/i.test(key);
    const ok = SAFE_EXT.test(pathOnly) || (keyish && !/\.(html?|json|css|js)$/i.test(pathOnly));
    if (ok && !isAssetUrl(node)) out.add(node);
    return;
  }
  if (Array.isArray(node)) { for (const n of node) collectUrls(n, out, key); return; }
  if (node && typeof node === 'object') for (const k of Object.keys(node)) collectUrls(node[k], out, k);
}

async function downloadAttachment(url, destDir, idx) {
  let u;
  try { u = new URL(url, BASE); } catch { return null; }
  if (u.protocol !== 'https:' || !ALLOWED_HOST.test(u.hostname) || isAssetUrl(u.href)) return null;
  // Fetch the URL verbatim (absolute already, or resolved) — pre-signed S3 URLs are
  // signature-sensitive, so avoid any needless re-encoding.
  const res = await net.fetch(/^https?:/i.test(url) ? url : u.href, { session: gsSession() });
  if (!res.ok) return null;
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const cd = res.headers.get('content-disposition') || '';
  // A download-looking link that actually returns a web page is navigation, not a file.
  if (ctype.startsWith('text/html') && !/attachment/i.test(cd)) return null;

  let name = '';
  const mcd = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (mcd) { try { name = decodeURIComponent(mcd[1]); } catch { name = mcd[1]; } }
  if (!name) { try { name = decodeURIComponent(u.pathname.split('/').pop() || ''); } catch { name = u.pathname.split('/').pop() || ''; } }
  name = (name || `attachment-${idx + 1}`).replace(/[<>:"/\\|?* -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (BLOCK_EXT.test(name)) return null;
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('pdf')) name += '.pdf';
    else if (ct.includes('zip')) name += '.zip';
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 30 * 1024 * 1024) return null; // skip empty / >30MB
  if (IMAGE_EXT.test(name) && buf.length < 15 * 1024) return null; // tiny image = logo/icon, not coursework
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  fs.writeFileSync(dest, buf);
  return { name, path: dest };
}

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
      _authAt = Date.now(); // the just-authenticated session is reusable
      return { email };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('gradescope:disconnect', async () => {
    try { fs.unlinkSync(GRADESCOPE_CREDS_FILE); } catch {}
    try { await gsSession().clearStorageData({ storages: ['cookies'] }); } catch {}
    _authAt = 0;
    return true;
  });

  // Log in with the stored credentials, scrape every course, and return both
  // calendar-ready schedule-item objects (same shape as ipc/calendar.js events) AND
  // the course/assignment linkage the renderer uses to build projects + notes. Each
  // event carries courseId/course/courseShort/assignmentId so the renderer can map
  // it to a project, an assignment note, and (lazily) its attachments.
  ipcMain.handle('gradescope:fetchAssignments', async () => {
    try {
      let dashboard = await ensureAuth();
      if (!dashboard) { const r = await gsFetch(BASE + '/account'); dashboard = await r.text(); }
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
            dueISO: a.due.toISOString(),
            allDay: false,
            submitted: !!a.submitted,
            extId: `gradescope:${c.id}:${a.id || slug(a.name)}`,
            source: 'gradescope',
            courseId: c.id,
            course: c.name,
            courseShort: c.short || c.name,
            assignmentId: a.id || null,
            url: a.id ? `${BASE}/courses/${c.id}/assignments/${a.id}` : `${BASE}/courses/${c.id}`,
          });
        }
        if (kept) courseSummary.push({ id: c.id, name: c.name, short: c.short || c.name, count: kept });
      }

      return { events, courses: courseSummary, coursesScanned: courses.length };
    } catch (err) {
      return { error: err.message, events: [] };
    }
  });

  // Download a single assignment's attachment files (best-effort) to a local,
  // device-only folder, returning [{ name, path }] for the note to reference.
  // Called lazily by the renderer once per assignment (not on every sync).
  ipcMain.handle('gradescope:fetchAttachments', async (event, courseId, assignmentId) => {
    try {
      if (!courseId || !assignmentId) return { attachments: [] };
      await ensureAuth();
      // The instructor's "Download … PDF" template link lives on the submission page;
      // the assignment page is a fallback. Scan both.
      const pages = [
        `${BASE}/courses/${courseId}/assignments/${assignmentId}/submissions/new`,
        `${BASE}/courses/${courseId}/assignments/${assignmentId}`,
      ];
      let html = '';
      const finals = [];
      for (const p of pages) {
        try { const r = await gsFetch(p); if (r.ok) { html += '\n' + await r.text(); finals.push(r.url); } } catch (e) {}
      }
      if (!html) return { attachments: [], debug: { status: 'no page loaded' } };
      const res = { url: finals.join(' , '), text: () => html }; // keep debug shape below

      const urls = new Set();
      let pm;
      const propRe = /data-react-props="([^"]*)"/g;
      while ((pm = propRe.exec(html))) { try { collectUrls(JSON.parse(htmlDecode(pm[1])), urls); } catch (e) {} }
      // Anchors: take links that either point at a known file type OR read like a
      // download (e.g. "Download Section 6.2 PDF"), whose href often has no extension.
      let am;
      const aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((am = aRe.exec(html))) {
        const href = htmlDecode(am[1]);
        const text = stripTags(am[2]);
        const isFile = SAFE_EXT.test(href.split('?')[0]);
        const looksDownload = /\b(download|template|outline|starter|handout|instructions?|attachment|pdf|worksheet|packet)\b/i.test(text)
          || /\/(download|template|outline|attachment|blob)\b|\.pdf/i.test(href);
        if ((isFile || looksDownload) && !isAssetUrl(href)) urls.add(href);
      }
      // data-*-url attributes: Gradescope stashes the instructor's template PDF in
      // data-template-url="…s3…pdf?…" and lets JS populate the (empty) anchor href,
      // so the raw HTML we fetch only has it here.
      let dm;
      const dataRe = /data-[\w-]*url="([^"]+)"/gi;
      while ((dm = dataRe.exec(html))) {
        const raw = htmlDecode(dm[1]);
        if (/^https?:\/\//i.test(raw)
          && (SAFE_EXT.test(raw.split('?')[0]) || /pdf_attachment|\/uploads\//i.test(raw))
          && !isAssetUrl(raw)) urls.add(raw);
      }

      const destDir = path.join(GRADESCOPE_ATTACH_DIR, String(assignmentId));
      const out = [];
      let i = 0;
      for (const url of urls) {
        if (out.length >= 8) break; // cap per assignment
        try { const f = await downloadAttachment(url, destDir, i++); if (f && !out.some(o => o.name === f.name)) out.push(f); } catch (e) {}
      }
      // Diagnostic (visible via the renderer console) when nothing downloaded, so a
      // missing attachment can be traced without guessing at the page structure.
      return { attachments: out, debug: { finalUrl: res.url, pageLen: html.length, candidates: urls.size } };
    } catch (err) {
      return { attachments: [], error: err.message };
    }
  });
};
