const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocketServer = require('ws').Server;
const config = require('./config');
const state = require('./state');
const moonraker = require('./moonraker');

// Get the local machine's LAN IP on the same subnet as the printer.
// Used to replace mDNS-obfuscated WebRTC candidates (Chrome privacy feature)
// so the K1C can reach us by real IP instead of unresolvable "xxxx.local" hostnames.
function getLocalLanIp() {
  const printerIp = new URL(state.moonrakerUrl).hostname;
  // Extract subnet prefix (e.g., "192.168.0." from "192.168.0.130")
  const printerSubnet = printerIp.split('.').slice(0, 3).join('.') + '.';
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal && addr.address.startsWith(printerSubnet)) {
        return addr.address;
      }
    }
  }
  // Fallback: return any non-internal IPv4
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json',
};

// Webcam config object returned for all webcam API/WS calls
// Uses webrtc-go2rtc: Fluidd opens WebSocket to /api/ws, sends SDP offer + ICE candidates,
// we buffer candidates then relay the complete offer to K1C (port 8000), return the answer.
// Native H.264 WebRTC video direct from K1C — zero CPU encoding overhead.
const WEBCAM_ENTRY = {
  name: 'K1C Camera', location: 'printer', service: 'webrtc-go2rtc',
  enabled: true, icon: 'mdiWebcam', target_fps: 15, target_fps_idle: 15,
  stream_url: '/', snapshot_url: '/snapshot',
  flip_horizontal: false, flip_vertical: false, rotation: 0,
  aspect_ratio: '16:9', extra_data: {}, source: 'config', uid: 'k1c-cam-go2rtc'
};

// WebSocket server for go2rtc signaling (noServer mode — we handle upgrade manually)
const signalWss = new WebSocketServer({ noServer: true });

// Build an unmasked WebSocket text frame
function wsFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// Parse ALL WebSocket frames from a buffer — handles multiple frames per TCP packet.
// Returns array of { text, frameStart, frameEnd }; text is null for non-text frames.
function wsParseAllFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < 2) break;
    const opcode = buf[pos] & 0x0f;
    const masked = (buf[pos + 1] & 0x80) !== 0;
    let payloadLen = buf[pos + 1] & 0x7f;
    let offset = pos + 2;
    if (payloadLen === 126) { if (buf.length < offset + 2) break; payloadLen = buf.readUInt16BE(offset); offset += 2; }
    else if (payloadLen === 127) { if (buf.length < offset + 8) break; payloadLen = Number(buf.readBigUInt64BE(offset)); offset += 8; }
    let maskKey;
    if (masked) { if (buf.length < offset + 4) break; maskKey = buf.slice(offset, offset + 4); offset += 4; }
    if (buf.length < offset + payloadLen) break;
    const frameEnd = offset + payloadLen;
    let text = null;
    if (opcode === 1) {
      const payload = Buffer.from(buf.slice(offset, frameEnd));
      if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
      try { text = payload.toString('utf8'); } catch {}
    }
    frames.push({ text, frameStart: pos, frameEnd });
    pos = frameEnd;
  }
  return frames;
}

function handleRequest(req, res) {
  const rawUrl = req.url;
  if (!rawUrl.startsWith('/snapshot') && !rawUrl.startsWith('/stream') && !rawUrl.startsWith('/assets/') && !rawUrl.includes('.thumbs/')) {
    console.log(`[Fluidd] ${req.method} ${rawUrl}`);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let urlPath;
  try {
    urlPath = new URL(req.url, `http://localhost:${config.FLUIDD_PORT}`).pathname;
  } catch (e) {
    res.writeHead(400); res.end('Bad request'); return;
  }

  // Legacy WHEP endpoints — no longer used (switched to go2rtc WebSocket signaling)
  if (urlPath === '/whep' || urlPath.startsWith('/whep/')) {
    res.writeHead(404); res.end('WHEP disabled — using go2rtc signaling'); return;
  }

  // Camera snapshot endpoint — returns latest JPEG frame
  if (urlPath === '/snapshot') {
    if (state.latestCameraFrame) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      res.end(state.latestCameraFrame);
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('No camera frame available — connect to K1C camera first');
    }
    return;
  }

  // Camera MJPEG stream endpoint — ~10fps push
  if (urlPath === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
    });
    const interval = setInterval(() => {
      if (state.latestCameraFrame) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${state.latestCameraFrame.length}\r\n\r\n`);
        res.write(state.latestCameraFrame);
        res.write('\r\n');
      }
    }, 100);
    req.on('close', () => clearInterval(interval));
    return;
  }

  // OrcaSlicer upload proxy: POST /upload/<filename> → Moonraker /server/files/upload
  // OrcaSlicer sometimes prepends HTTP headers to the file body (known bug) — stripped below.
  if (req.method === 'POST' && urlPath.startsWith('/upload/')) {
    const filename = decodeURIComponent(urlPath.slice('/upload/'.length));
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let gcodeData = Buffer.concat(chunks);
      const headerEnd = gcodeData.indexOf('\r\n\r\n');
      if (headerEnd > 0 && headerEnd < 500) {
        const possibleHeaders = gcodeData.slice(0, headerEnd).toString('utf8');
        if (possibleHeaders.includes('Content-') || possibleHeaders.includes('HTTP/')) {
          gcodeData = gcodeData.slice(headerEnd + 4);
        }
      }
      forwardToMoonraker(res, filename, gcodeData, true);
    });
    return;
  }

  // OctoPrint compat: POST /api/files/local — OrcaSlicer's standard print-host upload path
  if (req.method === 'POST' && urlPath === '/api/files/local') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let filename = 'upload.gcode';
      let fileData = raw;
      let shouldPrint = false;
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1].replace(/^"(.*)"$/, '$1');
        const parts = raw.toString('binary').split('--' + boundary);
        for (const part of parts) {
          if (part.includes('name="file"')) {
            const fnMatch = part.match(/filename="([^"]+)"/);
            if (fnMatch) filename = fnMatch[1];
            const dataStart = part.indexOf('\r\n\r\n');
            if (dataStart >= 0) {
              fileData = Buffer.from(part.slice(dataStart + 4).replace(/\r\n$/, ''), 'binary');
            }
          }
          if (part.includes('name="print"') || part.includes('name="select"')) {
            if (part.includes('true')) shouldPrint = true;
          }
        }
      }
      forwardToMoonraker(res, filename, fileData, shouldPrint, true);
    });
    return;
  }

  // OctoPrint compat stubs — OrcaSlicer probes these on connection
  if (urlPath === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ api: '0.1', server: '1.10.2', text: 'OctoPrint 1.10.2' }));
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/login') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ _is_external_client: false, name: '_api', active: true, user: true, admin: true, apikey: 'placeholder', settings: {} }));
    return;
  }
  if (urlPath === '/api/connection') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      current: { state: 'Operational', port: 'virtual', baudrate: 115200, printerProfile: '_default' },
      options: { ports: ['virtual'], baudrates: [115200], printerProfiles: [{ id: '_default', name: 'K1C' }], portPreference: 'virtual', baudratePreference: 115200 }
    }));
    return;
  }
  if (urlPath === '/api/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      api: { enabled: true, key: 'placeholder' },
      feature: { sdSupport: false, temperatureGraph: true },
      webcam: { webcamEnabled: true, streamUrl: '/stream', snapshotUrl: '/snapshot', flipH: false, flipV: false, rotate90: false },
      plugins: {}
    }));
    return;
  }
  // OctoPrint compat: /api/printer — OrcaSlicer polls this for live status
  if (urlPath === '/api/printer') {
    const moonUrl = new URL('/printer/objects/query?extruder&heater_bed&print_stats', state.moonrakerUrl);
    http.get(moonUrl, { timeout: 5000 }, (moonRes) => {
      let body = '';
      moonRes.on('data', chunk => body += chunk);
      moonRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          const s = data.result?.status || {};
          const ext = s.extruder || {};
          const bed = s.heater_bed || {};
          const ps = s.print_stats || {};
          const flags = {
            operational: true, paused: ps.state === 'paused', printing: ps.state === 'printing',
            cancelling: false, pausing: false, sdReady: false, error: ps.state === 'error',
            ready: ps.state === 'standby' || ps.state === 'complete', closedOrError: false
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            temperature: {
              tool0: { actual: ext.temperature || 0, target: ext.target || 0, offset: 0 },
              bed: { actual: bed.temperature || 0, target: bed.target || 0, offset: 0 }
            },
            sd: { ready: false },
            state: { text: ps.state || 'Operational', flags }
          }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            temperature: { tool0: { actual: 0, target: 0, offset: 0 }, bed: { actual: 0, target: 0, offset: 0 } },
            sd: { ready: false },
            state: { text: 'Operational', flags: { operational: true, paused: false, printing: false, cancelling: false, pausing: false, sdReady: false, error: false, ready: true, closedOrError: false } }
          }));
        }
      });
    }).on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        temperature: { tool0: { actual: 0, target: 0, offset: 0 }, bed: { actual: 0, target: 0, offset: 0 } },
        sd: { ready: false },
        state: { text: 'Operational', flags: { operational: true, paused: false, printing: false, cancelling: false, pausing: false, sdReady: false, error: false, ready: true, closedOrError: false } }
      }));
    });
    return;
  }
  // OctoPrint compat: /api/job — OrcaSlicer polls this for print progress
  if (urlPath === '/api/job') {
    const moonUrl = new URL('/printer/objects/query?print_stats&virtual_sdcard', state.moonrakerUrl);
    http.get(moonUrl, { timeout: 5000 }, (moonRes) => {
      let body = '';
      moonRes.on('data', chunk => body += chunk);
      moonRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          const s = data.result?.status || {};
          const ps = s.print_stats || {};
          const vsd = s.virtual_sdcard || {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            job: { file: { name: ps.filename || null, origin: 'local', size: null, date: null }, estimatedPrintTime: null, filament: null },
            progress: { completion: (vsd.progress || 0) * 100, filepos: null, printTime: ps.print_duration || null, printTimeLeft: null },
            state: ps.state === 'printing' ? 'Printing' : ps.state === 'paused' ? 'Paused' : 'Operational'
          }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ job: { file: { name: null, origin: 'local', size: null, date: null } }, progress: { completion: 0, filepos: null, printTime: null, printTimeLeft: null }, state: 'Operational' }));
        }
      });
    }).on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job: { file: { name: null, origin: 'local', size: null, date: null } }, progress: { completion: 0, filepos: null, printTime: null, printTimeLeft: null }, state: 'Operational' }));
    });
    return;
  }
  // OctoPrint compat: /api/printer/command — accept but ignore
  if (req.method === 'POST' && urlPath === '/api/printer/command') {
    res.writeHead(204); res.end(); return;
  }
  // OctoPrint compat: /api/printerprofiles — OrcaSlicer requests this on connect
  if (urlPath === '/api/printerprofiles') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ profiles: { _default: { id: '_default', name: 'K1C', model: 'Creality K1C', default: true, current: true } } }));
    return;
  }

  // Webcam REST endpoints — served locally so Fluidd's camera persists across restarts
  if (urlPath === '/server/webcams/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { webcams: [WEBCAM_ENTRY] } }));
    return;
  }
  if (urlPath === '/server/webcams/item') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: { webcam: WEBCAM_ENTRY } }));
    return;
  }

  // Moonraker API proxy — all /server/, /printer/, /api/, /access/, /machine/ paths
  if (urlPath.startsWith('/server/') || urlPath.startsWith('/printer/') || urlPath.startsWith('/api/') || urlPath.startsWith('/access/') || urlPath.startsWith('/machine/')) {
    const moonUrl = new URL(req.url, state.moonrakerUrl);
    const proxyReq = http.request(moonUrl, {
      method: req.method,
      headers: { ...req.headers, host: new URL(state.moonrakerUrl).host },
      timeout: 120000
    }, (proxyRes) => {
      // Strip stale webcam configs from Fluidd's database — we override via server.webcams.list
      if (urlPath === '/server/database/item' && req.url.includes('namespace=fluidd')) {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.result?.value?.cameras) {
              console.log('[Fluidd] Stripping cached camera config from database');
              delete data.result.value.cameras;
            }
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
          } catch {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(body);
          }
        });
        return;
      }
      // Inject webcam component into /server/info so Fluidd shows the camera UI
      if (urlPath === '/server/info') {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.result?.components && !data.result.components.includes('webcam')) {
              data.result.components.push('webcam');
            }
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
          } catch {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(body);
          }
        });
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });
    proxyReq.on('error', (err) => {
      // Printer may have moved (DHCP) — kick off discovery so the next request self-corrects.
      moonraker.resolve({ force: true }).catch(() => {});
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Moonraker proxy error: ' + err.message);
    });
    req.pipe(proxyReq);
    return;
  }

  // Replace Fluidd's service worker with a no-op.
  // Fluidd's real sw.js caches everything, preventing our injected scripts from loading.
  // This SW has no fetch handler so the browser falls through to network (our proxy).
  // Avoid clients.claim() — it triggers Fluidd's controllerchange handler, causing reload loops.
  if (urlPath === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
    res.end(`self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(n) {
    return Promise.all(n.map(function(k) { return caches.delete(k); }));
  }));
});`);
    return;
  }

  // Serve Fluidd static files
  let filePath = path.join(config.FLUIDD_DIR, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath.startsWith(config.FLUIDD_DIR)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();

    // Inject script into index.html to force Fluidd to connect through our proxy.
    // Fluidd stores printer instances in localStorage.appInstances — stale entries pointing
    // directly to the printer (192.168.0.130:7125) bypass the proxy and skip our webcam config.
    if (filePath.endsWith('index.html')) {
      const proxyOrigin = `http://localhost:${config.FLUIDD_PORT}`;
      const wsUrl = `ws://localhost:${config.FLUIDD_PORT}/websocket`;
      const injectScript = `<script>
(function() {
  var key = 'appInstances';
  var target = ${JSON.stringify(proxyOrigin)};
  var wsTarget = ${JSON.stringify(wsUrl)};
  try {
    var raw = localStorage.getItem(key);
    var instances = raw ? JSON.parse(raw) : [];
    var changed = false;
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].apiUrl && instances[i].apiUrl !== target) {
        instances[i].apiUrl = target;
        instances[i].socketUrl = wsTarget;
        instances[i].active = true;
        changed = true;
      }
    }
    if (instances.length === 0) {
      instances.push({ apiUrl: target, socketUrl: wsTarget, active: true, name: 'K1C' });
      changed = true;
    }
    if (changed) localStorage.setItem(key, JSON.stringify(instances));
  } catch(e) { console.warn('Instance fix:', e); }
})();
</script>`;
      const html = data.toString('utf8').replace('<head>', '<head>' + injectScript);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Forward a gcode file buffer to Moonraker /server/files/upload as multipart form data.
// octoprintCompat=true → translate response to OctoPrint format (201 + files object).
function forwardToMoonraker(res, filename, fileData, shouldPrint, octoprintCompat = false) {
  const boundary = '----MoonrakerUpload' + Date.now();
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fileData,
  ];
  if (shouldPrint) {
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="print"\r\n\r\ntrue`));
  }
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  // Send to Moonraker; if the printer's IP changed (connection refused/unreachable),
  // re-run discovery and retry once with the rediscovered URL before giving up.
  function attempt(retried) {
    const moonUrl = new URL('/server/files/upload', state.moonrakerUrl);
    const moonReq = http.request(moonUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 120000
    }, (moonRes) => {
      let data = '';
      moonRes.on('data', chunk => data += chunk);
      moonRes.on('end', () => {
        if (octoprintCompat) {
          res.writeHead(moonRes.statusCode === 200 ? 201 : moonRes.statusCode, { 'Content-Type': 'application/json' });
          try {
            JSON.parse(data); // validate moonraker response
            res.end(JSON.stringify({ files: { local: { name: filename, origin: 'local', path: filename } }, done: true }));
          } catch { res.end(data); }
        } else {
          res.writeHead(moonRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        }
      });
    });
    moonReq.on('error', async (err) => {
      if (!retried) {
        console.warn(`[Fluidd] Upload failed (${err.message}) — rediscovering printer and retrying…`);
        await moonraker.resolve({ force: true });
        attempt(true);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Upload proxy error: ' + err.message);
    });
    moonReq.write(body);
    moonReq.end();
  }
  attempt(false);
}

// go2rtc WebRTC signaling — Fluidd opens WebSocket, sends offer + candidates,
// we buffer candidates then relay the complete offer to K1C, return the answer.
// This mirrors the Electron app's approach: wait for ICE gathering, send full offer.
function handleGo2rtcSignaling(req, socket, head) {
  signalWss.handleUpgrade(req, socket, head, (ws) => {
    console.log('[WebRTC] go2rtc signaling WebSocket connected');

    let sdpOffer = null;
    const candidates = [];
    let relayTimer = null;
    let relayed = false;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('[WebRTC] Received:', msg.type, msg.value ? ('(' + msg.value.length + ' chars)') : '');

        if (msg.type === 'webrtc/offer') {
          sdpOffer = msg.value;
          console.log('[WebRTC] Got SDP offer, waiting for ICE candidates...');
          // Start relay timer — if no candidates arrive in 500ms, send offer as-is
          if (relayTimer) clearTimeout(relayTimer);
          relayTimer = setTimeout(() => doRelay(ws), 500);
        }
        else if (msg.type === 'webrtc/candidate') {
          if (msg.value) {
            candidates.push(msg.value);
            console.log('[WebRTC] Buffered ICE candidate #' + candidates.length);
            // Reset timer — wait for more candidates (300ms after last one)
            if (!relayed && relayTimer) {
              clearTimeout(relayTimer);
              relayTimer = setTimeout(() => doRelay(ws), 300);
            }
          }
        }
      } catch (e) {
        console.log('[WebRTC] Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log('[WebRTC] go2rtc signaling WebSocket closed');
      if (relayTimer) clearTimeout(relayTimer);
    });
    ws.on('error', (err) => console.log('[WebRTC] Signaling error:', err.message));

    function doRelay(ws) {
      if (relayed || !sdpOffer) return;
      relayed = true;

      console.log('[WebRTC] Relaying offer to K1C with', candidates.length, 'ICE candidates');

      // Insert gathered ICE candidates into the offer SDP
      let fullOffer = sdpOffer;
      // Normalize line endings for processing
      fullOffer = fullOffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      if (candidates.length > 0) {
        // Build candidate lines — candidates from toJSON().candidate include "candidate:" prefix
        // OrcaSlicer's Chromium uses mDNS privacy (e.g., "xxxx.local" instead of real IP).
        // The K1C can't resolve mDNS, so replace .local hostnames with our actual LAN IP.
        const lanIp = getLocalLanIp();
        console.log('[WebRTC] Local LAN IP for candidate fix:', lanIp || 'NOT FOUND');
        const candidateLines = candidates.map(c => {
          let fixed = c;
          if (lanIp && /[0-9a-f-]+\.local/.test(fixed)) {
            fixed = fixed.replace(/[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+\.local/i, lanIp);
            console.log('[WebRTC] Fixed mDNS candidate:', fixed);
          }
          const line = fixed.startsWith('candidate:') ? 'a=' + fixed : 'a=candidate:' + fixed;
          console.log('[WebRTC] Injecting candidate into offer:', line);
          return line;
        });
        // Add end-of-candidates marker so K1C knows no more are coming
        candidateLines.push('a=end-of-candidates');
        const insertBlock = candidateLines.join('\n');
        // Insert candidates at end of the video media section
        if (fullOffer.includes('m=video')) {
          fullOffer = fullOffer.replace(/(m=video[\s\S]*?)(\n(?=m=|\s*$))/, `$1\n${insertBlock}$2`);
        }
      }

      // Remove trickle ICE flag — we're sending all candidates upfront in the SDP,
      // and the K1C uses one-shot HTTP signaling (no channel for trickle candidates).
      // Without this, the K1C may wait for more candidates instead of starting ICE checks.
      fullOffer = fullOffer.replace(/a=ice-options:trickle\n?/g, '');

      // MetaRTC requires sendrecv, but Fluidd sends recvonly — fix the SDP
      fullOffer = fullOffer.replace(/a=recvonly/g, 'a=sendrecv');

      // Restore proper CRLF
      fullOffer = fullOffer.replace(/\n/g, '\r\n');
      if (!fullOffer.endsWith('\r\n')) fullOffer += '\r\n';

      console.log('[WebRTC] === FULL OFFER TO K1C ===\n' + fullOffer + '=== END OFFER ===');

      // Base64-encode JSON payload for K1C's MetaRTC endpoint
      const payload = Buffer.from(JSON.stringify({ type: 'offer', sdp: fullOffer })).toString('base64');
      const printerIp = new URL(state.moonrakerUrl).hostname;
      const reqOpts = {
        hostname: printerIp, port: 8000, path: '/call/webrtc_local',
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'plain/text', 'Content-Length': Buffer.byteLength(payload) }
      };

      const proxyReq = http.request(reqOpts, (proxyRes) => {
        let body = '';
        proxyRes.on('data', chunk => body += chunk);
        proxyRes.on('end', () => {
          try {
            const decoded = JSON.parse(Buffer.from(body, 'base64').toString('utf-8'));
            let sdpAnswer = decoded.sdp || '';
            console.log('[WebRTC] === K1C RAW ANSWER SDP ===\n' + sdpAnswer + '\n=== END RAW ANSWER ===');

            // Normalize line endings
            sdpAnswer = sdpAnswer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            // Log any ICE candidates from K1C (don't strip — browser needs them for connectivity)
            const candidateLines = sdpAnswer.split('\n').filter(l => l.startsWith('a=candidate:'));
            if (candidateLines.length > 0) {
              console.log('[WebRTC] K1C ICE candidates (' + candidateLines.length + '):');
              candidateLines.forEach(c => console.log('  ', c));
            } else {
              console.log('[WebRTC] WARNING: K1C answer has NO ICE candidates');
            }

            // Reassemble with proper CRLF
            sdpAnswer = sdpAnswer.split('\n').join('\r\n');
            if (!sdpAnswer.endsWith('\r\n')) sdpAnswer += '\r\n';

            // Fix direction: K1C answers sendrecv but Fluidd's offer was recvonly,
            // so the answer must be sendonly for the browser to accept it.
            sdpAnswer = sdpAnswer.replace(/a=sendrecv/g, 'a=sendonly');

            console.log('[WebRTC] === FINAL ANSWER TO FLUIDD ===\n' + sdpAnswer + '=== END FINAL ANSWER ===');
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'webrtc/answer', value: sdpAnswer }));
            }
          } catch (e) {
            console.log('[WebRTC] Failed to decode K1C response:', e.message, 'body:', body.substring(0, 200));
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', value: 'Failed to decode K1C response' }));
            }
          }
        });
      });
      proxyReq.on('error', (err) => {
        console.log('[WebRTC] K1C signaling error:', err.message);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', value: 'K1C camera not reachable: ' + err.message }));
        }
      });
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', value: 'K1C camera signaling timed out' }));
        }
      });
      proxyReq.write(payload);
      proxyReq.end();
    }
  });
}

// Track active WebSocket proxy connections so we can clean up leaked ones
const activeWsConnections = new Set();

// (go2rtc signaling is implemented above via handleGo2rtcSignaling + signalWss)

function handleWebSocketUpgrade(req, socket, head) {
  const urlPath = new URL(req.url, `http://localhost:${config.FLUIDD_PORT}`).pathname;
  console.log('[WS] Upgrade request:', req.url);

  // go2rtc WebRTC signaling for Fluidd camera
  if (urlPath === '/api/ws') {
    handleGo2rtcSignaling(req, socket, head);
    return;
  }

  // Clean up any dead connections (no close event fired due to browser just dropping them)
  for (const conn of activeWsConnections) {
    if (conn.clientSocket.destroyed || conn.proxySocket?.destroyed) {
      if (!conn.clientSocket.destroyed) conn.clientSocket.destroy();
      if (conn.proxySocket && !conn.proxySocket.destroyed) conn.proxySocket.destroy();
      activeWsConnections.delete(conn);
    }
  }

  const moonUrl = new URL(req.url, state.moonrakerUrl);
  const opts = {
    hostname: moonUrl.hostname, port: moonUrl.port,
    path: moonUrl.pathname + moonUrl.search,
    method: 'GET',
    headers: { ...req.headers, host: `${moonUrl.hostname}:${moonUrl.port}` }
  };

  // Webcam RPC methods intercepted client-side before forwarding to Moonraker
  const WEBCAM_RPC = {
    'server.webcams.list': { webcams: [WEBCAM_ENTRY] },
    'server.webcams.get_item': { webcam: WEBCAM_ENTRY },
    'server.webcams.post_item': { webcam: WEBCAM_ENTRY },
    'server.webcams.delete_item': { webcam: WEBCAM_ENTRY },
  };

  const conn = { clientSocket: socket, proxySocket: null };
  activeWsConnections.add(conn);

  const proxyReq = http.request(opts);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    conn.proxySocket = proxySocket;
    const responseHeaders = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(proxyRes.headers)) responseHeaders.push(`${k}: ${v}`);
    socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
    if (proxyHead.length) socket.write(proxyHead);

    // Client → Moonraker: intercept webcam RPC calls, forward everything else
    socket.on('data', (data) => {
      const buf = Buffer.from(data);
      const frames = wsParseAllFrames(buf);
      if (frames.length === 0) { proxySocket.write(data); return; }
      const intercepted = new Set();
      for (let i = 0; i < frames.length; i++) {
        if (!frames[i].text) continue;
        try {
          const msg = JSON.parse(frames[i].text);
          console.log('[WS] Client RPC:', msg.method, 'id:', msg.id);
          if (msg.method in WEBCAM_RPC) {
            console.log(`[WS] Intercepted ${msg.method}, responding directly`);
            socket.write(wsFrame(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: WEBCAM_RPC[msg.method] })));
            intercepted.add(i);
          }
        } catch {}
      }
      if (intercepted.size === 0) {
        proxySocket.write(data);
      } else if (intercepted.size < frames.length) {
        for (let i = 0; i < frames.length; i++) {
          if (!intercepted.has(i)) proxySocket.write(buf.slice(frames[i].frameStart, frames[i].frameEnd));
        }
        // Preserve trailing partial frame bytes
        const lastEnd = frames[frames.length - 1].frameEnd;
        if (lastEnd < buf.length) proxySocket.write(buf.slice(lastEnd));
      }
    });

    // Moonraker → Client: inject webcam component into server.info responses
    let serverInfoInjected = false; // Only inject once per connection
    proxySocket.on('data', (data) => {
      const buf = Buffer.from(data);
      // Log frame opcodes to detect close frames from Moonraker
      if (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        if (opcode === 8) { console.log('[WS] Moonraker sent close frame'); }
        if (opcode === 9) { console.log('[WS] Moonraker sent ping'); }
      }
      // Skip injection if already done — just pass through for speed
      if (serverInfoInjected) { socket.write(data); return; }
      const frames = wsParseAllFrames(buf);
      if (frames.length === 0) { socket.write(data); return; }
      let modified = false;
      const outputParts = [];
      // Track how far the parsed frames cover the buffer
      let parsedEnd = 0;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (f.frameEnd > parsedEnd) parsedEnd = f.frameEnd;
        if (f.text) {
          try {
            const msg = JSON.parse(f.text);
            if (msg.result?.components && Array.isArray(msg.result.components) && !msg.result.components.includes('webcam')) {
              msg.result.components.push('webcam');
              console.log('[WS] Injected webcam into server.info components');
              outputParts.push(wsFrame(JSON.stringify(msg)));
              serverInfoInjected = true;
              modified = true;
              continue;
            }
          } catch {}
        }
        outputParts.push(buf.slice(f.frameStart, f.frameEnd));
      }
      if (modified) {
        for (const part of outputParts) socket.write(part);
        // Preserve any trailing bytes that weren't part of complete frames (TCP fragmentation)
        if (parsedEnd < buf.length) {
          console.log('[WS] Preserving', buf.length - parsedEnd, 'trailing bytes after injection');
          socket.write(buf.slice(parsedEnd));
        }
      }
      else { socket.write(data); }
    });

    function cleanup(reason) {
      if (!conn.cleaned) {
        conn.cleaned = true;
        console.log('[WS] Connection closed:', reason, '(active:', activeWsConnections.size - 1, ')');
        activeWsConnections.delete(conn);
        // Send proper WebSocket close frames so both sides release connection slots
        const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xE8]); // Close frame: status 1000 (normal)
        try { if (!socket.destroyed) { socket.write(closeFrame); socket.end(); } } catch {}
        try { if (!proxySocket.destroyed) { proxySocket.write(closeFrame); proxySocket.end(); } } catch {}
        // Force destroy after a short delay in case graceful close hangs
        setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
          if (!proxySocket.destroyed) proxySocket.destroy();
        }, 1000);
      }
    }
    proxySocket.on('error', (err) => cleanup('Moonraker error: ' + err.message));
    socket.on('error', (err) => cleanup('Client error: ' + err.message));
    proxySocket.on('close', () => cleanup('Moonraker closed'));
    socket.on('close', () => cleanup('Client closed'));
  });
  proxyReq.on('response', (res) => { console.log('[WS] Moonraker returned HTTP', res.statusCode, 'instead of upgrade'); activeWsConnections.delete(conn); socket.destroy(); });
  proxyReq.on('error', (err) => { console.log('[WS] Moonraker upgrade error:', err.message); activeWsConnections.delete(conn); socket.destroy(); });
  proxyReq.end();
}

function startFluiddServer() {
  const server = http.createServer(handleRequest);
  server.on('upgrade', handleWebSocketUpgrade);
  server.on('error', (err) => console.warn('Fluidd server failed to start:', err.message));
  server.listen(config.FLUIDD_PORT, () => {
    console.log(`Fluidd server running at http://localhost:${config.FLUIDD_PORT}`);
  });
  state.fluiddServer = server;
  return server;
}

module.exports = { startFluiddServer };
