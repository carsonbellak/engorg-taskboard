// IPC handlers: FTDI bit-bang — drives the FTDI device type in the UART Bridge
// utility via a long-lived Python helper (ipc/ftdi_helper.py) that wraps ftd2xx.
// JS speaks one JSON command per line over the helper's stdin/stdout. Native Node
// FTDI bindings are painful to rebuild for Electron, so we reuse the user's
// already-working Python ftd2xx install instead.

const { ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const HELPER = path.join(__dirname, 'ftdi_helper.py');
let proc = null;
let buf = '';
let nextId = 1;
const pending = new Map();

function detectPython() {
  for (const c of ['py', 'python', 'python3']) {
    try {
      const r = spawnSync(c, ['--version'], { windowsHide: true });
      if (!r.error && (r.status === 0 || r.status === null && (r.stdout || r.stderr))) return c;
    } catch { /* try next */ }
  }
  return null;
}

function ensureProc() {
  if (proc) return proc;
  const cmd = detectPython();
  if (!cmd) return null;
  proc = spawn(cmd, ['-u', HELPER], { windowsHide: true });
  proc.stdout.setEncoding('utf-8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* ignore non-JSON noise */ }
    }
  });
  const fail = () => { proc = null; for (const r of pending.values()) r({ ok: false, error: 'FTDI helper exited' }); pending.clear(); };
  proc.on('exit', fail);
  proc.on('error', () => { proc = null; });
  return proc;
}

function send(cmd) {
  return new Promise((resolve) => {
    const p = ensureProc();
    if (!p) { resolve({ ok: false, error: 'Python not found — FTDI bit-bang needs Python + ftd2xx installed.' }); return; }
    const id = nextId++;
    pending.set(id, resolve);
    try { p.stdin.write(JSON.stringify({ ...cmd, id }) + '\n'); }
    catch (e) { pending.delete(id); resolve({ ok: false, error: e.message }); return; }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'FTDI helper timeout' }); } }, 8000);
  });
}

module.exports = function registerFtdi() {
  ipcMain.handle('ftdi:list', () => send({ cmd: 'list' }));
  ipcMain.handle('ftdi:open', (e, index) => send({ cmd: 'open', index }));
  ipcMain.handle('ftdi:bitmode', (e, index, mask, mode) => send({ cmd: 'bitmode', index, mask, mode }));
  ipcMain.handle('ftdi:baud', (e, index, baud) => send({ cmd: 'baud', index, baud }));
  ipcMain.handle('ftdi:write', (e, index, bytes) => send({ cmd: 'write', index, bytes }));
  ipcMain.handle('ftdi:close', (e, index) => send({ cmd: 'close', index }));
};
