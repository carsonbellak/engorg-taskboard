// Pi runtime config (not the root config.js), pushed by the linked desktop (ipc/pi-link.js → POST /api/config) and
// persisted in data/config.json:
//   printerEnabled — watch the printer at all (off until a desktop with printer support says so,
//                    so a Pi never scans the LAN for a printer the user doesn't have)
//   printerSeed    — the desktop's saved Moonraker URL, tried before any scan
//   timezone       — the desktop's IANA zone; ICS events are rendered in local time, so the
//                    Pi's process TZ must match the PC's or every event shifts
//   autoUpdate     — follow new GitHub releases automatically (default on)
const store = require('./store');

const FILE = 'config.json';
const DEFAULTS = { printerEnabled: false, printerSeed: null, timezone: null, autoUpdate: true };

let cfg = { ...DEFAULTS, ...store.read(FILE, {}) };
const listeners = [];

function applyTimezone() {
  if (cfg.timezone && process.env.TZ !== cfg.timezone) process.env.TZ = cfg.timezone; // Node re-reads TZ on assignment
}
applyTimezone();

function get() { return { ...cfg }; }

function update(patch) {
  const next = { ...cfg };
  if (typeof patch.printerEnabled === 'boolean') next.printerEnabled = patch.printerEnabled;
  if (patch.printerSeed === null || (typeof patch.printerSeed === 'string' && /^https?:\/\/[\w.:-]+$/.test(patch.printerSeed))) next.printerSeed = patch.printerSeed;
  if (patch.timezone === null || (typeof patch.timezone === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(patch.timezone))) next.timezone = patch.timezone;
  if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate;
  const prev = cfg;
  cfg = next;
  store.write(FILE, cfg);
  applyTimezone();
  for (const fn of listeners) { try { fn(cfg, prev); } catch (e) { console.warn('[config] listener failed', e.message); } }
  return get();
}

function onChange(fn) { listeners.push(fn); }

module.exports = { get, update, onChange };
