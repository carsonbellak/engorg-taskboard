#!/usr/bin/env node
// EngOrg Pi — the minimal headless Linux build of the app for a Raspberry Pi 3 (or newer).
//
// No Electron, no UI: just the always-on backend work the desktop app offloads to a linked Pi
// (see pi/CLAUDE.md). It reuses the desktop's own Electron-free modules (moonraker.js,
// core/ics.js, core/pi-protocol.js, config.js, state.js) via build-pi.js, so the two never drift.
//
//   node pi/server.js                 run the service (systemd: engorg-pi.service)
//   node pi/server.js code            print the 6-digit pairing code
//   node pi/server.js reset-pairing   new code + revoke every paired desktop
//   node pi/server.js --selftest      boot on a temp data dir, hit the API, exit 0/1 (build + updater gate)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
if (SELFTEST) {
  // Never touch the real data dir or the install root from a self-test.
  process.env.ENGORG_PI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'engorg-pi-selftest-'));
  delete process.env.ENGORG_PI_HOME;
}

const proto = require('../core/pi-protocol');
const { normalizeIcs } = require('../core/ics');
const store = require('./lib/store');
const auth = require('./lib/auth');
const runtimeConfig = require('./lib/runtime-config');
const calendar = require('./lib/calendar-cache');
const printer = require('./lib/printer-watch');
const updater = require('./lib/updater');
const discovery = require('./lib/discovery');
const sysinfo = require('./lib/sysinfo');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── CLI subcommands ────────────────────────────────────────────────────────────────
if (argv[0] === 'code') { console.log(auth.code()); process.exit(0); }
if (argv[0] === 'reset-pairing') { console.log('New pairing code:', auth.resetPairing(), '(all desktops must pair again)'); process.exit(0); }

// ── HTTP API ───────────────────────────────────────────────────────────────────────
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function status() {
  return {
    app: 'engorg-pi', version: store.version(), protocol: proto.PROTOCOL, ...auth.info(),
    autoUpdate: runtimeConfig.get().autoUpdate,
    system: sysinfo.get(),
    printer: printer.getState(),
    calendar: calendar.summary(),
    update: updater.status(),
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Read-only health page for a browser on the LAN. Shows nothing secret (no code, no feed URLs).
function statusPage() {
  const s = status(), sys = s.system, p = s.printer;
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const job = p.currentJob ? `${p.currentJob.filename || 'print'} (${p.status && p.status.progress != null ? Math.round(p.status.progress * 100) + '%' : p.currentJob.state})` : '—';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EngOrg Pi</title><meta http-equiv="refresh" content="15"><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d2330;--mut:#6b7280;--card:#fff;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e6e8ee;--mut:#9aa1ad;--card:#1f2229;--line:#2c3038}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:var(--mut);margin:0 0 16px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:16px}
th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mut);font-weight:500;width:40%}
tr:last-child th,tr:last-child td{border-bottom:0}</style></head><body><main>
<h1>EngOrg Pi</h1><p>${esc(sys.model || sys.platform)} · v${esc(s.version)} · ${s.paired ? 'paired' : 'not paired yet'}</p>
<table>${row('Uptime', Math.round(sys.uptimeSec / 3600) + ' h')}${row('CPU temp', sys.cpuTempC != null ? sys.cpuTempC + ' °C' : '—')}${row('Load', sys.load.join(' / '))}${row('Memory free', sys.memMB.free + ' / ' + sys.memMB.total + ' MB')}${row('Disk free', sys.disk ? sys.disk.freeMB + ' MB' : '—')}</table>
<table>${row('Printer watch', p.enabled ? (p.online ? 'online' : 'printer offline') : 'off')}${row('Printer state', p.status ? p.status.state : '—')}${row('Current job', job)}${row('Calendar feeds cached', s.calendar.feeds)}${row('Last feed refresh', s.calendar.lastRefresh || '—')}</table>
<table>${row('Latest release', s.update.latest || '—')}${row('Update', s.update.updating ? 'installing ' + s.update.updating : (s.update.available ? 'available' : 'up to date'))}${row('Auto-update', s.autoUpdate ? 'on' : 'off')}</table>
</main></body></html>`;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://pi');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    const html = statusPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && p === '/api/hello') return send(res, 200, { app: 'engorg-pi', version: store.version(), protocol: proto.PROTOCOL, ...auth.info() });
  if (req.method === 'POST' && p === '/api/pair') {
    const body = await readBody(req);
    const r = auth.pair(body.code, body.client);
    if (r.error) return send(res, r.status, { error: r.error });
    log('[auth] paired', body.client || 'desktop');
    return send(res, 200, { token: r.token, ...auth.info(), version: store.version() });
  }

  // Everything below needs a paired desktop's token.
  const tokenRec = auth.check(req.headers.authorization);
  if (!tokenRec) return send(res, 401, { error: 'Not paired with this Pi — pair again from Settings → Integrations.' });

  if (req.method === 'GET' && p === '/api/status') return send(res, 200, status());
  if (req.method === 'POST' && p === '/api/unpair') { auth.revoke(tokenRec); return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/config') return send(res, 200, runtimeConfig.update(await readBody(req)));
  if (req.method === 'GET' && p === '/api/printer') return send(res, 200, printer.getState());
  if (req.method === 'GET' && p === '/api/printer/jobs') return send(res, 200, { jobs: printer.getJobs(url.searchParams.get('since')) });
  if (req.method === 'GET' && p === '/api/calendar/feed') {
    const feedUrl = url.searchParams.get('url');
    if (!feedUrl || !/^(https?|webcal):\/\//i.test(feedUrl)) return send(res, 400, { error: 'Missing or invalid feed url' });
    try { return send(res, 200, await calendar.get(feedUrl, url.searchParams.get('source') || 'feed')); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (req.method === 'POST' && p === '/api/update') {
    const from = req.headers[proto.APP_VERSION_HEADER];
    if (from) log('[update] requested by desktop v' + from);
    return send(res, 200, await updater.apply());
  }
  return send(res, 404, { error: 'Not found' });
}

function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch {} });
  });
}

// ── Self-test: boot on a temp dir, exercise the API + shared modules, exit ───────────────
// Plain http (no keep-alive) so the process can exit cleanly right after.
function call(base, method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(base + apiPath, { method, agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function selftest() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hello = (await call(base, 'GET', '/api/hello')).json;
  if (!hello || hello.app !== 'engorg-pi' || hello.protocol !== proto.PROTOCOL) throw new Error('hello mismatch');
  const pair = (await call(base, 'POST', '/api/pair', { code: auth.code(), client: 'selftest' })).json;
  if (!pair || !pair.token) throw new Error('pairing failed');
  const st = await call(base, 'GET', '/api/status', null, pair.token);
  if (st.status !== 200 || st.json.version !== store.version()) throw new Error('status failed');
  if ((await call(base, 'GET', '/api/status')).status !== 401) throw new Error('auth not enforced');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:t1', 'DTSTART:' + stamp, 'SUMMARY:Selftest', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  if (normalizeIcs(ics, 'feed').length !== 1) throw new Error('ICS parse failed');
  await new Promise((r) => server.close(r));
  fs.rmSync(store.DATA_DIR, { recursive: true, force: true });
  console.log(`selftest ok — engorg-pi v${store.version()} on node ${process.version}`);
}

// ── Service ─────────────────────────────────────────────────────────────────────────
function main() {
  const port = parseInt(process.env.ENGORG_PI_PORT, 10) || proto.PI_PORT;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    log(`engorg-pi v${store.version()} listening on :${port} (data: ${store.DATA_DIR})`);
    if (!auth.info().paired) log(`[auth] not paired yet — pairing code: ${auth.code()}`);
  });
  discovery.start(port);
  calendar.start();
  printer.apply(runtimeConfig.get());
  runtimeConfig.onChange((cfg, prev) => printer.apply(cfg, prev));
  updater.start();

  const shutdown = () => {
    log('shutting down');
    discovery.stop(); calendar.stop(); printer.stop(); updater.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (SELFTEST) selftest().then(() => process.exit(0), (e) => { console.error('selftest FAILED:', e.message); process.exit(1); });
else main();
