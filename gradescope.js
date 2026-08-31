#!/usr/bin/env node
/*
 * gradescope.js — pull your Gradescope assignment due dates from the command line.
 *
 * Gradescope has no public API, so this logs in the same way a browser does (it
 * posts the login form with its CSRF token, carrying the session cookie), then
 * scrapes your dashboard + each course page for assignment due dates.
 *
 * Standalone: only Node.js built-in modules, no npm install. Needs Node 14+.
 *
 * USAGE
 *   node gradescope.js                 # prompts for email + password
 *   GRADESCOPE_EMAIL=you@school.edu GRADESCOPE_PASSWORD=secret node gradescope.js
 *
 * OUTPUT
 *   - prints your upcoming due dates, sorted, to the terminal
 *   - writes gradescope.ics next to this script — import it into Google Calendar,
 *     Apple Calendar, Outlook, etc. (Calendar app → Import → pick the file)
 *
 * NOTE: This uses email + password login. If you sign into Gradescope through
 * your school's SSO / "Log in with Google", this won't work (no password to post).
 * Your credentials are only sent to gradescope.com and are never stored anywhere.
 */

'use strict';
const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE = 'https://www.gradescope.com';
const UA = 'Mozilla/5.0 (gradescope-cli)';
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MAX_COURSES = 20;
const PAST_GRACE_DAYS = 7; // also list assignments due within the last week

// ── tiny cookie jar + HTTP helpers (raw https so we can read Set-Cookie/Location) ──
function makeJar() {
  const m = new Map();
  return {
    store(setCookies) {
      (setCookies || []).forEach((sc) => {
        const pair = sc.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      });
    },
    header() { return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

function request(method, urlStr, { jar, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const h = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', ...headers };
    const cookie = jar.header();
    if (cookie) h.Cookie = cookie;
    if (body != null) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout: 20000 },
      (res) => {
        jar.store(res.headers['set-cookie']);
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    if (body != null) req.write(body);
    req.end();
  });
}

// GET following redirects (carrying cookies), returning the final response + url.
async function get(urlStr, jar) {
  let url = urlStr;
  for (let i = 0; i < 6; i++) {
    const r = await request('GET', url, { jar });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      url = new URL(r.headers.location, url).href;
      continue;
    }
    return { ...r, url };
  }
  throw new Error('Too many redirects');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
const htmlDecode = (s) => (s || '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
const stripTags = (s) => htmlDecode((s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function extractAuthToken(html) {
  const m = html.match(/name="authenticity_token"\s+value="([^"]+)"/) ||
            html.match(/name="csrf-token"\s+content="([^"]+)"/);
  return m ? htmlDecode(m[1]) : null;
}

// ── login ─────────────────────────────────────────────────────────────────────
async function login(email, password, jar) {
  const page = await get(BASE + '/login', jar);
  const token = extractAuthToken(page.body);
  if (!token) throw new Error('Could not reach the Gradescope login page.');

  const form = new URLSearchParams();
  form.set('utf8', '✓');
  form.set('authenticity_token', token);
  form.set('session[email]', email);
  form.set('session[password]', password);
  form.set('session[remember_me]', '1');
  form.set('commit', 'Log In');
  form.set('session[remember_me_sso]', '0');

  const res = await request('POST', BASE + '/login', { jar, body: form.toString() });
  const loc = res.headers.location || '';
  // Success → 302 redirect to /account. Failure → 200 re-render of /login.
  if (res.status !== 302 || /\/login/.test(loc)) {
    throw new Error('Login failed — check your email/password (SSO logins are not supported).');
  }
  const acct = await get(new URL(loc || '/account', BASE).href, jar);
  return acct.body;
}

// ── parsing ───────────────────────────────────────────────────────────────────
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
    out.push({ id, short, name: name || short || 'Course ' + id });
  }
  return out;
}

// A due date is either an ISO string (React props) or Gradescope's "Nov 07 at
// 11:00PM" text (no year — inferred from the academic calendar).
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
    const cand = new Date(year, mon, day, hour, min);
    if (cand.getTime() < Date.now() - 150 * 86400000) year += 1; // far past → next year's term
  }
  const d = new Date(year, mon, day, hour, min);
  return isNaN(d) ? null : d;
}

function collectFromProps(node, out) {
  if (Array.isArray(node)) { for (const n of node) collectFromProps(n, out); return; }
  if (!node || typeof node !== 'object') return;
  const keys = Object.keys(node);
  const nameKey = keys.find((k) => /^(title|name|assignment_name)$/i.test(k));
  const dueKey = keys.find((k) => /(due_?date|due_?at|hard_?due_?date|hard_?due_?at)/i.test(k));
  if (nameKey && dueKey && node[dueKey] != null && node[nameKey]) {
    const due = parseDue(typeof node[dueKey] === 'object' ? (node[dueKey].date || node[dueKey].due_date) : node[dueKey]);
    if (due) out.push({ name: String(node[nameKey]), due, id: node.id || node.assignment_id || null });
  }
  for (const k of keys) collectFromProps(node[k], out);
}

// Tries React props first, then the classic #assignments-student-table markup.
function parseAssignments(html) {
  const found = [];
  const propRe = /data-react-props="([^"]*)"/g;
  let pm;
  while ((pm = propRe.exec(html))) {
    try { collectFromProps(JSON.parse(htmlDecode(pm[1])), found); } catch (e) { /* not JSON */ }
  }
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
      const dueM = row.match(/submissionTimeChart--dueDate[^>]*>([\s\S]*?)<\//i)
                || row.match(/(?:Due|Late Due)[^<]*<[^>]*>([^<]*\bat\b[^<]*)</i);
      const due = parseDue(stripTags(dueM ? dueM[1] : ''));
      if (due) found.push({ name, due, id: idM ? idM[1] : null });
    }
  }
  const seen = new Set();
  return found.filter((a) => {
    const k = a.name + '|' + a.due.getTime();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── ICS output ──────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function icsStamp(d) {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
         pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
const icsEscape = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
function buildICS(events) {
  const now = icsStamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gradescope-cli//EN', 'CALSCALE:GREGORIAN'];
  events.forEach((e, i) => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid || 'gs-' + i}@gradescope-cli`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsStamp(e.due)}`,
      `DTEND:${icsStamp(e.due)}`,
      `SUMMARY:${icsEscape(e.title)}`,
      `DESCRIPTION:${icsEscape(e.course + (e.url ? '\n' + e.url : ''))}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Assignment due', 'TRIGGER:-P1D', 'END:VALARM',
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ── credential prompt ────────────────────────────────────────────────────────
function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      rl._writeToOutput = (str) => { rl.output.write(str.includes(question) ? str : '*'); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let email = process.env.GRADESCOPE_EMAIL;
  let password = process.env.GRADESCOPE_PASSWORD;
  if (!email) email = (await ask('Gradescope email: ', false)).trim();
  if (!password) password = await ask('Gradescope password: ', true);
  if (!email || !password) { console.error('Email and password are required.'); process.exit(1); }

  const jar = makeJar();
  process.stdout.write('Logging in… ');
  const dashboard = await login(email, password, jar);
  console.log('ok.');

  const courses = parseCourses(dashboard);
  console.log(`Found ${courses.length} course(s). Reading assignments…\n`);

  const cutoff = Date.now() - PAST_GRACE_DAYS * 86400000;
  const events = [];
  for (const c of courses) {
    let assignments = [];
    try {
      const res = await get(`${BASE}/courses/${c.id}`, jar);
      if (res.status === 200) assignments = parseAssignments(res.body);
    } catch (e) { /* skip a course that won't load */ }
    for (const a of assignments) {
      if (a.due.getTime() < cutoff) continue;
      events.push({
        title: a.name,
        course: c.name,
        courseShort: c.short || c.name,
        due: a.due,
        uid: `gs-${c.id}-${a.id || a.name.replace(/\W+/g, '')}`,
        url: a.id ? `${BASE}/courses/${c.id}/assignments/${a.id}` : `${BASE}/courses/${c.id}`,
      });
    }
  }

  events.sort((x, y) => x.due - y.due);

  if (!events.length) {
    console.log('No upcoming assignment due dates found.');
    return;
  }

  console.log('Upcoming assignment due dates');
  console.log('─'.repeat(60));
  for (const e of events) {
    const when = e.due.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    console.log(`${when.padEnd(26)}  ${e.courseShort.padEnd(10)}  ${e.title}`);
  }

  const outPath = path.join(__dirname, 'gradescope.ics');
  fs.writeFileSync(outPath, buildICS(events), 'utf8');
  console.log('─'.repeat(60));
  console.log(`\n${events.length} assignment(s) written to ${outPath}`);
  console.log('Import that .ics file into Google Calendar, Apple Calendar, or Outlook.');
}

main().catch((err) => { console.error('\nError:', err.message); process.exit(1); });
