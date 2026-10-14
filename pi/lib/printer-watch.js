// 24/7 printer watch. Keeps the Moonraker URL resolved with the desktop's own moonraker.js
// (health check → LAN /24 scan, self-healing DHCP moves) so the desktop never has to scan, and
// records every print job's start/end into data/printer_jobs.json — including prints that
// finish while the desktop is off (renderer/print-tracker.js reads them via pi:printerJobs).
const http = require('http');
const moonraker = require('../../moonraker');
const state = require('../../state');
const store = require('./store');
const runtimeConfig = require('./runtime-config');

const JOBS_FILE = 'printer_jobs.json';
const PRINTER_FILE = 'printer.json';
const MAX_JOBS = 200;
const POLL_ACTIVE_MS = 5000, POLL_IDLE_MS = 30000;
const RESCAN_MIN_MS = 10 * 60 * 1000;   // don't LAN-scan more than once per 10 min
const ACTIVE = new Set(['printing', 'paused']);

let jobs = store.read(JOBS_FILE, []);
const saved = store.read(PRINTER_FILE, {});
if (saved.url) state.moonrakerUrl = saved.url;
const jobSaver = store.debounced(JOBS_FILE, () => jobs.slice(-MAX_JOBS));
const printerSaver = store.debounced(PRINTER_FILE, () => ({ url: state.moonrakerUrl }));

let live = { online: false, lastSeen: null, status: null };
let current = jobs.length && ACTIVE.has(jobs[jobs.length - 1].state) ? jobs[jobs.length - 1] : null;
let timer = null, running = false, fails = 0, lastScan = 0, resolving = false;

function query(baseUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL('/printer/objects/query?print_stats&display_status&virtual_sdcard', baseUrl);
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; if (data.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(data).result.status); } catch (e) { reject(new Error('bad Moonraker response')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function resolveUrl(force = false) {
  if (resolving) return;
  if (force && Date.now() - lastScan < RESCAN_MIN_MS) return;
  resolving = true;
  try {
    if (force) lastScan = Date.now();
    const before = state.moonrakerUrl;
    await moonraker.resolve({ seed: force ? null : runtimeConfig.get().printerSeed, force });
    if (state.moonrakerUrl !== before) printerSaver.schedule();
  } catch (e) { console.warn('[printer] resolve failed:', e.message); }
  finally { resolving = false; }
}

function newJob(ps) {
  return { id: 'job_' + Date.now().toString(36), filename: ps.filename || null, state: ps.state, startedAt: new Date().toISOString(), endedAt: null, printDuration: 0, filamentUsed: 0, message: '' };
}

function track(st) {
  const ps = st.print_stats || {};
  const progress = st.display_status ? st.display_status.progress : (st.virtual_sdcard ? st.virtual_sdcard.progress : null);
  live = {
    online: true, lastSeen: new Date().toISOString(),
    status: { state: ps.state || 'unknown', filename: ps.filename || null, progress, printDuration: ps.print_duration || 0, message: ps.message || '' },
  };
  const isActive = ACTIVE.has(ps.state);
  // A different file while one was active means the old job ended unseen.
  if (current && isActive && ps.filename && current.filename && ps.filename !== current.filename) finish('interrupted', {});
  if (isActive) {
    if (!current) { current = newJob(ps); jobs.push(current); console.log('[printer] job started:', current.filename); }
    Object.assign(current, { state: ps.state, printDuration: ps.print_duration || current.printDuration, filamentUsed: ps.filament_used || current.filamentUsed });
    jobSaver.schedule();
  } else if (current) {
    // printing/paused → complete | cancelled | error; → standby without a result = interrupted
    finish(['complete', 'cancelled', 'error'].includes(ps.state) ? ps.state : 'interrupted', ps);
  }
}

function finish(final, ps) {
  Object.assign(current, {
    state: final, endedAt: new Date().toISOString(),
    printDuration: ps.print_duration || current.printDuration, filamentUsed: ps.filament_used || current.filamentUsed,
    message: ps.message || '',
  });
  console.log('[printer] job', final + ':', current.filename);
  current = null;
  if (jobs.length > MAX_JOBS) jobs = jobs.slice(-MAX_JOBS);
  jobSaver.flush();
}

async function poll() {
  timer = null;
  if (!running) return;
  try {
    track(await query(state.moonrakerUrl));
    fails = 0;
  } catch {
    fails++;
    if (live.online) console.warn('[printer] lost contact with', state.moonrakerUrl);
    live = { ...live, online: false };
    if (fails === 3) resolveUrl(true);   // printer probably moved (DHCP) — rescan the LAN
  }
  if (running) timer = setTimeout(poll, current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

function start() {
  if (running) return;
  running = true;
  console.log('[printer] watch on');
  resolveUrl(false).finally(() => { if (running && !timer) poll(); });
}

function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  live = { online: false, lastSeen: live.lastSeen, status: null };
  jobSaver.flush(); printerSaver.flush();
}

function apply(cfg, prev = {}) {
  if (cfg.printerEnabled && !running) start();
  else if (!cfg.printerEnabled && running) { stop(); console.log('[printer] watch off'); }
  else if (running && cfg.printerSeed && cfg.printerSeed !== prev.printerSeed) resolveUrl(false);
}

function getState() {
  return { enabled: running, url: running ? state.moonrakerUrl : null, ...live, currentJob: current };
}

function getJobs(since) {
  const t = since ? Date.parse(since) : 0;
  return jobs.filter(j => !t || Date.parse(j.endedAt || j.startedAt) >= t);
}

module.exports = { apply, start, stop, getState, getJobs };
