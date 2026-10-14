// Pi data dir + small JSON persistence helpers (atomic write-then-rename so a power cut on
// the Pi's SD card never leaves a half-written file).
//   ENGORG_PI_DATA — data dir (the systemd unit sets /opt/engorg-pi/data)
//   ENGORG_PI_HOME — install root with releases/ + current symlink (unset = dev mode)
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.ENGORG_PI_DATA || path.join(os.homedir(), '.engorg-pi');
const HOME = process.env.ENGORG_PI_HOME || null;

function file(name) { return path.join(DATA_DIR, name); }

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

function write(name, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file(name));
}

// Debounced writer for state that changes often (printer status, caches).
function debounced(name, getObj, ms = 2000) {
  let t = null;
  const flush = () => { if (t) { clearTimeout(t); t = null; } try { write(name, getObj()); } catch (e) { console.warn('[store] write failed', name, e.message); } };
  const schedule = () => { if (!t) t = setTimeout(flush, ms); };
  return { schedule, flush };
}

// The bundle's own version (stamped into package.json by build-pi.js).
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

module.exports = { DATA_DIR, HOME, file, read, write, debounced, version };
