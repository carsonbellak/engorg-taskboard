// IPC handlers: Raspberry Pi companion link (Settings → Integrations → Raspberry Pi).
//
// A paired Pi (the headless build in pi/, see pi/CLAUDE.md) runs the always-on backend work
// so the desktop doesn't have to: it keeps the printer's Moonraker URL resolved (no /24 scan
// on the desktop), watches print jobs 24/7, and keeps every calendar feed pre-fetched. This
// module is the desktop's client for it:
//   - pi:discover   UDP broadcast (core/pi-protocol DISCOVERY_PROBE) → Pis on the LAN
//   - pi:pair       host + 6-digit code (shown on the Pi by `sudo engorg-pi code`) → token
//   - pi:status / pi:unpair / pi:update / pi:printerJobs
// and exports helpers other main modules use transparently (calendar.js, moonraker.js hook).
//
// The token is encrypted with safeStorage in appdata/pi_link.json (device-local) and never
// reaches the renderer. Every helper fails soft: when the Pi is down the desktop falls back
// to doing the work itself, and skips the Pi for a short back-off so nothing stalls.
const { ipcMain, safeStorage, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const config = require('../config');
const proto = require('../core/pi-protocol');
const moonraker = require('../moonraker');

const LINK_FILE = config.PI_LINK_FILE;
const BACKOFF_MS = 2 * 60 * 1000;

let link = null;      // cached contents of pi_link.json
let downUntil = 0;    // skip the Pi until this time after a failed request

function loadLink() {
  if (link) return link;
  try { link = JSON.parse(fs.readFileSync(LINK_FILE, 'utf8')) || {}; } catch { link = {}; }
  return link;
}
function saveLink(obj) {
  link = obj || {};
  fs.mkdirSync(path.dirname(LINK_FILE), { recursive: true });
  fs.writeFileSync(LINK_FILE, JSON.stringify(link, null, 2), 'utf8');
}
function encrypt(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable — cannot securely store the Pi token.');
  return safeStorage.encryptString(plain).toString('base64');
}
function decrypt(enc) { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }

function isLinked() { const l = loadLink(); return !!(l.host && l.tokenEnc); }
function isAvailable() { return isLinked() && Date.now() >= downUntil; }

function cmpSemver(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
  return 0;
}

// One HTTP call to the Pi. `target` overrides the saved link (used while pairing).
async function request(method, apiPath, body, { timeoutMs = 5000, target } = {}) {
  const l = target || loadLink();
  if (!l.host) throw new Error('No Raspberry Pi is linked.');
  const headers = { [proto.APP_VERSION_HEADER]: app.getVersion() };
  if (!target && l.tokenEnc) headers.Authorization = 'Bearer ' + decrypt(l.tokenEnc);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`http://${l.host}:${l.port || proto.PI_PORT}${apiPath}`, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (!target) downUntil = Date.now() + BACKOFF_MS;
    throw new Error('Raspberry Pi unreachable' + (e && e.name === 'TimeoutError' ? ' (timed out)' : ''));
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Raspberry Pi returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (!target) downUntil = 0;
  return data;
}

// ── LAN discovery ───────────────────────────────────────────────────────────────
function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

function discover(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    const finish = () => { try { sock.close(); } catch {} resolve([...found.values()]); };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString('utf8'));
        if (j && j.app === 'engorg-pi') found.set(j.id || rinfo.address, { ...j, host: rinfo.address });
      } catch {}
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      const probe = Buffer.from(proto.DISCOVERY_PROBE);
      for (const addr of broadcastAddrs()) sock.send(probe, proto.PI_DISCOVERY_PORT, addr, () => {});
      setTimeout(finish, timeoutMs);
    });
  });
}

// The Pi is on DHCP too: if it stopped answering at the saved host, look for the same Pi id
// on the LAN and adopt its new address.
async function heal() {
  const l = loadLink();
  if (!l.id) return false;
  const hit = (await discover()).find(p => p.id === l.id);
  if (!hit || hit.host === l.host) return false;
  saveLink({ ...l, host: hit.host, port: hit.port || l.port });
  downUntil = 0;
  console.log('[Pi] linked Pi moved to', hit.host);
  return true;
}

// ── What the desktop tells the Pi (printer + timezone) ─────────────────────────────
function desktopConfig() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'settings.json'), 'utf8')) || {}; } catch {}
  return {
    printerEnabled: s.printerEnabled === true,
    printerSeed: s.printerIp ? `http://${s.printerIp}:${s.printerPort || 7125}` : null,
    // ICS times are rendered in the Pi's local zone, so it must match this PC's.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}

async function pushConfig() {
  if (!isLinked()) return null;
  return request('POST', '/api/config', desktopConfig());
}

// Ask an outdated Pi to update itself so it always matches this app's release.
async function syncVersion() {
  if (!isAvailable()) return;
  try {
    const st = await request('GET', '/api/status');
    await pushConfig();
    const behind = cmpSemver(st.version, app.getVersion()) < 0 || st.protocol !== proto.PROTOCOL;
    if (behind && st.autoUpdate !== false) await request('POST', '/api/update', { target: app.getVersion() }, { timeoutMs: 10000 });
  } catch (e) { console.warn('[Pi] version sync skipped:', e.message); }
}

// ── Helpers used by other main modules (all fail soft → null) ─────────────────────
async function fetchFeed(url, source) {
  if (!isAvailable()) return null;
  try {
    const q = `?url=${encodeURIComponent(url)}&source=${encodeURIComponent(source || 'feed')}`;
    const r = await request('GET', '/api/calendar/feed' + q, undefined, { timeoutMs: 20000 });
    return r && Array.isArray(r.events) ? r.events : null;
  } catch (e) {
    if (e.status) console.warn('[Pi] feed via Pi failed, fetching locally:', e.message);
    return null;
  }
}

async function printerUrl() {
  if (!isAvailable()) return null;
  try { const r = await request('GET', '/api/printer', undefined, { timeoutMs: 3000 }); return (r && r.url) || null; }
  catch { return null; }
}

module.exports = function register() {
  // Before the desktop scans the LAN for the printer, ask the Pi (it already knows).
  moonraker.setRemoteResolver(printerUrl);

  ipcMain.handle('pi:discover', async () => {
    const list = await discover();
    const l = loadLink();
    return list.map(p => ({ ...p, linked: !!(l.id && p.id === l.id) }));
  });

  ipcMain.handle('pi:pair', async (e, host, port, code) => {
    host = String(host || '').trim(); port = parseInt(port, 10) || proto.PI_PORT;
    if (!host) return { error: 'Enter the Pi’s address.' };
    if (!/^\d{6}$/.test(String(code || '').trim())) return { error: 'Enter the 6-digit pairing code.' };
    try {
      const r = await request('POST', '/api/pair', { code: String(code).trim(), client: os.hostname() }, { target: { host, port } });
      if (!r || !r.token) return { error: 'The Pi did not return a token.' };
      saveLink({ host, port, id: r.id, name: r.name, tokenEnc: encrypt(r.token), pairedAt: new Date().toISOString() });
      downUntil = 0;
      try { await pushConfig(); } catch {}
      return { ok: true, name: r.name, version: r.version };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('pi:unpair', async () => {
    try { if (isLinked()) await request('POST', '/api/unpair', {}, { timeoutMs: 3000 }); } catch {}
    saveLink({});
    return { ok: true };
  });

  ipcMain.handle('pi:status', async () => {
    const l = loadLink();
    const base = { linked: isLinked(), host: l.host || null, port: l.port || proto.PI_PORT, name: l.name || null, appVersion: app.getVersion(), protocol: proto.PROTOCOL };
    if (!base.linked) return base;
    let info = null, error = null;
    try { info = await request('GET', '/api/status'); }
    catch (err) {
      error = err.message;
      if (!err.status && await heal()) {
        try { info = await request('GET', '/api/status'); error = null; base.host = loadLink().host; } catch (e2) { error = e2.message; }
      }
    }
    if (!info) return { ...base, online: false, error };
    return {
      ...base, online: true, info,
      behind: cmpSemver(info.version, base.appVersion) < 0,
      protocolMismatch: info.protocol !== proto.PROTOCOL,
    };
  });

  ipcMain.handle('pi:update', async () => {
    try { return await request('POST', '/api/update', { target: app.getVersion() }, { timeoutMs: 15000 }); }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('pi:setAutoUpdate', async (e, on) => {
    try { return await request('POST', '/api/config', { autoUpdate: !!on }); }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('pi:printerJobs', async (e, since) => {
    if (!isAvailable()) return null;
    try { return await request('GET', '/api/printer/jobs' + (since ? '?since=' + encodeURIComponent(since) : '')); }
    catch { return null; }
  });

  // Keep the Pi's printer/timezone config and version in step with this app: shortly after
  // launch, then every 6 h.
  if (isLinked()) setTimeout(syncVersion, 15000);
  setInterval(syncVersion, 6 * 60 * 60 * 1000);
};

module.exports.isLinked = isLinked;
module.exports.fetchFeed = fetchFeed;
module.exports.printerUrl = printerUrl;
module.exports.pushConfig = pushConfig;
