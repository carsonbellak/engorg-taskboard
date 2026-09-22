// EngInk live mirror — desktop server side.
//
// The native EngInk (Android) app streams the strokes you write to this desktop over the LAN, and
// the Engineering > EngInk utility reflects them read-only. This module owns the two sockets:
//   - a WebSocket server (ws) on ENGINK_MIRROR_PORT that the tablet connects to and pushes strokes at
//   - a UDP socket on ENGINK_DISCOVERY_PORT for zero-config discovery (the tablet broadcasts a probe,
//     we reply with our host/port/pairing-code so the tablet can list nearby PCs)
//
// Everything stays on the local network — no cloud. A 6-digit pairing code (shown in the utility)
// gates connections so a random LAN device can't silently mirror. Parsed client messages are
// forwarded to the renderer via the 'engink:message' channel; the renderer does all the drawing.

const os = require('os');
const dgram = require('dgram');
const { ipcMain } = require('electron');
const WebSocketServer = require('ws').Server;
const config = require('./../config');
const state = require('./../state');

// Pick this machine's primary LAN IPv4 (first non-internal). Shown to the user so they can also
// pair by typing host:port if discovery is blocked on their network.
function localLanIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

let getWin = () => null;
function send(channel, payload) {
  try { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(channel, payload); } catch (_) {}
}

function statusObject() {
  const m = state.enginkMirror;
  if (!m) return { running: false };
  return {
    running: true,
    host: localLanIp(),
    port: config.ENGINK_MIRROR_PORT,
    code: m.code,
    clients: [...m.clients.values()].filter(c => c.authed).map(c => ({ device: c.device, version: c.version })),
  };
}

function stop() {
  const m = state.enginkMirror;
  if (!m) return;
  try { m.udp && m.udp.close(); } catch (_) {}
  try {
    for (const ws of m.wss.clients) { try { ws.terminate(); } catch (_) {} }
    m.wss.close();
  } catch (_) {}
  if (m.heartbeat) clearInterval(m.heartbeat);
  state.enginkMirror = null;
  send('engink:message', { t: 'server', running: false });
}

function start() {
  if (state.enginkMirror) return statusObject();

  const code = newCode();
  const clients = new Map(); // ws -> { device, version, authed }

  // ---- WebSocket server (stroke stream) ----
  const wss = new WebSocketServer({ port: config.ENGINK_MIRROR_PORT, maxPayload: 12 * 1024 * 1024 });

  wss.on('connection', (ws) => {
    const info = { device: '', version: '', authed: false };
    clients.set(ws, info);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      // Gate everything behind a valid pairing code (sent in the first `hello`).
      if (!info.authed) {
        if (msg.t !== 'hello') return;
        if (String(msg.code || '') !== code) {
          try { ws.send(JSON.stringify({ t: 'reject', reason: 'code' })); } catch (_) {}
          try { ws.close(); } catch (_) {}
          return;
        }
        info.authed = true;
        info.device = String(msg.device || 'Tablet').slice(0, 60);
        info.version = String(msg.version || '').slice(0, 20);
        try { ws.send(JSON.stringify({ t: 'welcome' })); } catch (_) {}
        send('engink:message', { t: 'client', connected: true, device: info.device, version: info.version });
        send('engink:status', statusObject());
        return;
      }

      // Authed stroke/notebook traffic — hand straight to the renderer to draw.
      send('engink:message', msg);
    });

    const drop = () => {
      if (!clients.has(ws)) return;
      clients.delete(ws);
      if (info.authed) {
        send('engink:message', { t: 'client', connected: false, device: info.device });
        send('engink:status', statusObject());
      }
    };
    ws.on('close', drop);
    ws.on('error', drop);
  });

  wss.on('error', (err) => {
    send('engink:message', { t: 'server', running: false, error: String(err && err.message || err) });
  });

  // Drop dead sockets so a tablet that vanished doesn't linger as "connected".
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 15000);

  // ---- UDP discovery responder ----
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (buf, rinfo) => {
    let probe;
    try { probe = JSON.parse(buf.toString()); } catch (_) { return; }
    if (!probe || probe.engink !== 'discover') return;
    const reply = Buffer.from(JSON.stringify({
      engink: 'here', name: os.hostname(), port: config.ENGINK_MIRROR_PORT, code,
    }));
    try { udp.send(reply, rinfo.port, rinfo.address); } catch (_) {}
  });
  udp.on('error', () => { /* discovery is best-effort; manual pairing still works */ });
  try { udp.bind(config.ENGINK_DISCOVERY_PORT); } catch (_) {}

  state.enginkMirror = { wss, udp, code, clients, heartbeat };
  send('engink:message', { t: 'server', running: true });
  return statusObject();
}

module.exports = function registerEnginkMirror(getMainWindow) {
  getWin = getMainWindow;
  ipcMain.handle('engink:start', () => { try { return start(); } catch (e) { return { running: false, error: String(e && e.message || e) }; } });
  ipcMain.handle('engink:stop', () => { stop(); return { running: false }; });
  ipcMain.handle('engink:status', () => statusObject());
};

module.exports.stop = stop;
