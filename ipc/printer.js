// IPC handlers: Moonraker API calls, file upload, WebRTC signaling, camera frame relay
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const state = require('../state');
const moonraker = require('../moonraker');
const { startFluiddServer } = require('../fluidd-server');

module.exports = function register(getMainWindow) {
  // Resolve the live Moonraker URL (health-check + LAN scan). The renderer passes its
  // saved IP as a seed so a working manual setting is honored before any scan happens.
  ipcMain.handle('printer:resolveUrl', async (event, seedUrl) => {
    return moonraker.resolve({ seed: seedUrl || null });
  });

  // Enable or disable the Fluidd proxy server at runtime (toggled from Settings)
  ipcMain.handle('printer:setEnabled', async (event, enabled) => {
    if (enabled && !state.fluiddServer) {
      startFluiddServer();
      return { started: true };
    } else if (!enabled && state.fluiddServer) {
      state.fluiddServer.close();
      state.fluiddServer = null;
      return { stopped: true };
    }
    return { noChange: true };
  });

  ipcMain.handle('printer:apiGet', async (event, baseUrl, apiPath) => {
    const url = new URL(apiPath, baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.get(url.href, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ error: 'Invalid JSON', raw: data }); }
        });
      });
      req.on('error', (err) => reject(new Error('Printer connection failed: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Printer request timed out')); });
    });
  });

  ipcMain.handle('printer:apiPost', async (event, baseUrl, apiPath, body) => {
    const url = new URL(apiPath, baseUrl);
    const postData = body ? JSON.stringify(body) : '';
    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname, port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: true, raw: data }); }
        });
      });
      req.on('error', (err) => reject(new Error('Printer connection failed: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Printer request timed out')); });
      req.write(postData);
      req.end();
    });
  });

  ipcMain.handle('printer:uploadFile', async (event, baseUrl, filePath) => {
    const url = new URL('/server/files/upload', baseUrl);
    const fileName = path.basename(filePath);
    const fileData = await fs.promises.readFile(filePath);
    const boundary = '----PrinterUpload' + Date.now().toString(36);
    const bodyBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname, port: url.port || 80, path: url.pathname,
        method: 'POST', timeout: 120000,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuffer.length }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: true, raw: data }); } });
      });
      req.on('error', (err) => reject(new Error('Upload failed: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Upload timed out')); });
      req.write(bodyBuffer);
      req.end();
    });
  });

  // Upload raw base64 file data — used by remote PWA file transfer
  ipcMain.handle('printer:uploadFileData', async (event, baseUrl, filename, base64Data) => {
    const url = new URL('/server/files/upload', baseUrl);
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const boundary = '----PrinterUpload' + Date.now().toString(36);
    const bodyBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname, port: url.port || 80, path: url.pathname,
        method: 'POST', timeout: 120000,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuffer.length }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: true, raw: data }); } });
      });
      req.on('error', (err) => reject(new Error('Upload failed: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Upload timed out')); });
      req.write(bodyBuffer);
      req.end();
    });
  });

  // WebRTC signaling — POST base64(JSON SDP offer) to printer:8000, decode base64(JSON SDP answer)
  ipcMain.handle('printer:webrtcOffer', async (event, printerIp, sdpOffer) => {
    const payload = Buffer.from(JSON.stringify({ type: 'offer', sdp: sdpOffer })).toString('base64');
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: printerIp, port: 8000, path: '/call/webrtc_local',
        method: 'POST', timeout: 10000,
        headers: { 'Content-Type': 'plain/text', 'Content-Length': Buffer.byteLength(payload) }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('error', (err) => reject(new Error('WebRTC signaling failed: ' + err.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('WebRTC signaling timed out')); });
      req.write(payload);
      req.end();
    });

    if (result.body && result.body.length > 2) {
      try {
        const decoded = JSON.parse(Buffer.from(result.body, 'base64').toString('utf-8'));
        result.body = decoded.sdp || '';
      } catch (e) {
        console.log('WebRTC: failed to decode response:', e.message);
      }
    }
    return result;
  });

  // Renderer sends JPEG frames here; fluidd-server.js reads state.latestCameraFrame for /snapshot and /stream
  ipcMain.handle('printer:sendCameraFrame', (event, jpegDataUrl) => {
    if (jpegDataUrl?.startsWith('data:image/jpeg')) {
      state.latestCameraFrame = Buffer.from(jpegDataUrl.split(',')[1], 'base64');
    }
    return true;
  });

  ipcMain.handle('printer:selectFile', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      title: 'Select G-code file to upload',
      filters: [{ name: 'G-code files', extensions: ['gcode', 'g', 'gco'] }, { name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });
};
