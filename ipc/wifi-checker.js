// IPC handlers: WiFi Checker — desktop port of the standalone PyQt5 "Wifi Checker".
// Provides the OS/network/SSH primitives the renderer UI orchestrates:
//   - file/folder pickers
//   - WiFi connect (netsh) to the test SSID
//   - IP discovery (arp + ipconfig CIDRs + optional nmap ping-sweep)
//   - ping a host
//   - SSH check / arbitrary SSH exec (root@host, via ssh2)
//   - temp_shutdown push+verify
//   - write a result file (with "don't overwrite -> numbered copy" behaviour)
// Excel parsing happens in the renderer (bundled lib/xlsx.full.min.js).

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

let SSHClient = null;
try { SSHClient = require('ssh2').Client; } catch { /* ssh2 installed at app install time */ }

// ---- Defaults (mirror the Python app) --------------------------------------
const WIFI_SSID = 'revelotest3';
const WIFI_PASSWORD = 'revelotest!';
const SSH_USER = 'root';
const SSH_PASSWORD = 'landisRoot';
const CIDRS_TO_PROBE = ['192.168.0.0/24'];

// ---- small helpers ---------------------------------------------------------
function run(cmd, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        resolve({ stdout: (stdout || '') + (stderr || ''), code: err ? (err.code || 1) : 0 });
      });
  });
}

function hexOnly(s) { return String(s || '').toLowerCase().replace(/[^0-9a-f]/g, ''); }

// ---- SSH (ssh2) ------------------------------------------------------------
function sshExec(ip, command, { timeout = 25000 } = {}) {
  return new Promise((resolve) => {
    if (!SSHClient) { resolve({ ok: false, stdout: '', stderr: '', error: 'ssh2 module not available' }); return; }
    const conn = new SSHClient();
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.end(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, stdout: '', stderr: '', error: `timeout after ${timeout}ms` }), timeout + 6000);
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { finish({ ok: false, stdout: '', stderr: '', error: err.message }); return; }
        let out = '', errout = '';
        stream.on('close', () => finish({ ok: true, stdout: out, stderr: errout }))
          .on('data', (d) => { out += d.toString('utf-8'); })
          .stderr.on('data', (d) => { errout += d.toString('utf-8'); });
      });
    }).on('error', (e) => finish({ ok: false, stdout: '', stderr: '', error: e.message }))
      .connect({
        host: ip, port: 22, username: SSH_USER, password: SSH_PASSWORD,
        readyTimeout: timeout, keepaliveInterval: 0,
        // The meters use legacy SSH algorithms — be permissive.
        algorithms: {
          kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group14-sha256', 'ecdh-sha2-nistp256'],
          serverHostKey: ['ssh-rsa', 'ssh-dss', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc', 'aes256-cbc'],
        },
      });
  });
}

// ---- ping parsing ----------------------------------------------------------
function parsePingStats(output) {
  let m = output.match(/Packets:\s*Sent\s*=\s*(\d+),\s*Received\s*=\s*(\d+),\s*Lost\s*=\s*(\d+)\s*\((\d+)%\s*loss\)/i);
  if (m) return { sent: +m[1], received: +m[2], loss: +m[4] };
  m = output.match(/(\d+)\s+packets transmitted,\s*(\d+)\s+received,.*?(\d+)%\s*packet loss/i);
  if (m) return { sent: +m[1], received: +m[2], loss: +m[3] };
  m = output.match(/(\d+)\s+packets transmitted,\s*(\d+)\s+received/i);
  if (m) { const sent = +m[1], received = +m[2]; return { sent, received, loss: sent === 0 ? 0 : Math.round(100 * (1 - received / sent)) }; }
  return null;
}
function parsePingTimes(output) {
  const out = [];
  const re = /time[=<]([\d.]+)\s*ms/gi; let m;
  while ((m = re.exec(output))) { const v = parseFloat(m[1]); if (!isNaN(v)) out.push(v); }
  return out;
}

module.exports = function registerWifiChecker(getMainWindow) {
  // -- pickers ----------------------------------------------------------------
  ipcMain.handle('wifi:selectExcel', async () => {
    const win = getMainWindow && getMainWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'Open Meter Status File',
      properties: ['openFile'],
      filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls'] }],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  ipcMain.handle('wifi:selectFolder', async () => {
    const win = getMainWindow && getMainWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Select Output Folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // -- read excel bytes for the renderer to parse with SheetJS ---------------
  ipcMain.handle('wifi:readExcelBuffer', async (e, filePath) => {
    try { const buf = await fsp.readFile(filePath); return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }; }
    catch (err) { return { error: err.message }; }
  });

  // -- nmap availability ------------------------------------------------------
  ipcMain.handle('wifi:hasNmap', async () => {
    const r = await run(process.platform === 'win32' ? 'where nmap' : 'which nmap', { timeout: 5000 });
    return r.code === 0 && /nmap/i.test(r.stdout);
  });

  // -- WiFi connect (Windows netsh) ------------------------------------------
  ipcMain.handle('wifi:connectWifi', async (e, opts = {}) => {
    const ssid = opts.ssid || WIFI_SSID;
    const password = opts.password || WIFI_PASSWORD;
    try {
      if (process.platform !== 'win32') return { connected: false, message: 'WiFi auto-connect is only supported on Windows.' };

      let r = await run('netsh wlan show interfaces');
      let connected = false;
      for (const line of r.stdout.split(/\r?\n/)) {
        const s = line.trim();
        if (/^state\b/i.test(s) && s.includes(':')) { connected = s.split(':')[1].trim().toLowerCase() === 'connected'; break; }
      }
      if (connected && r.stdout.includes(ssid)) return { connected: true, message: `Already connected to ${ssid}` };

      const profiles = await run('netsh wlan show profiles');
      if (!profiles.stdout.includes(ssid)) {
        const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>${ssid}</name>
    <SSIDConfig><SSID><name>${ssid}</name></SSID></SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>auto</connectionMode>
    <MSM><security>
        <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption></authEncryption>
        <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${password}</keyMaterial></sharedKey>
    </security></MSM>
</WLANProfile>`;
        const tmp = path.join(os.tmpdir(), `${ssid}.xml`);
        await fsp.writeFile(tmp, xml, 'utf-8');
        await run(`netsh wlan add profile filename="${tmp}"`);
        try { await fsp.unlink(tmp); } catch {}
      }

      await run(`netsh wlan connect name="${ssid}"`, { timeout: 20000 });
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        r = await run('netsh wlan show interfaces');
        let poll = false;
        for (const line of r.stdout.split(/\r?\n/)) {
          const s = line.trim();
          if (/^state\b/i.test(s) && s.includes(':')) { poll = s.split(':')[1].trim().toLowerCase() === 'connected'; break; }
        }
        if (poll && r.stdout.includes(ssid)) return { connected: true, message: `Connected to ${ssid}` };
      }
      return { connected: false, message: `Could not connect to ${ssid}` };
    } catch (err) {
      return { connected: false, message: `WiFi error: ${err.message}` };
    }
  });

  // -- IP discovery -----------------------------------------------------------
  ipcMain.handle('wifi:discoverIps', async () => {
    const map = {};
    try {
      if (process.platform === 'win32') {
        await run('arp -d *', { timeout: 8000 }); // flush (best-effort; may need admin)
      }

      const cidrs = CIDRS_TO_PROBE.slice();
      if (process.platform === 'win32') {
        const ipc = await run('ipconfig');
        const re = /IPv4 Address[.\s]*:\s*(\d+\.\d+\.\d+\.\d+)/gi; let m;
        while ((m = re.exec(ipc.stdout))) {
          const ip = m[1];
          if (ip !== '0.0.0.0' && !ip.startsWith('169.254.')) {
            const base = ip.split('.').slice(0, 3).join('.') + '.0/24';
            if (!cidrs.includes(base)) cidrs.push(base);
          }
        }
      } else {
        const neigh = await run('ip neigh show');
        for (const line of neigh.stdout.split(/\r?\n/)) {
          const m = line.match(/(\d+\.\d+\.\d+\.\d+).+lladdr\s+([0-9a-f:]{11,})/i);
          if (m) { const mac = hexOnly(m[2]); if (mac.length === 12) map[mac] = m[1]; }
        }
      }

      const arp = await run('arp -a');
      for (const raw of arp.stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /interface|internet address/i.test(line)) continue;
        const m = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})\s+(dynamic|static)/i);
        if (m) { const mac = hexOnly(m[2]); if (mac.length === 12) map[mac] = m[1]; }
      }

      // Optional nmap ping-sweep (forces ARP population for quiet hosts).
      const hasNmap = await run(process.platform === 'win32' ? 'where nmap' : 'which nmap', { timeout: 5000 });
      if (hasNmap.code === 0 && /nmap/i.test(hasNmap.stdout)) {
        const flags = '-PR --host-timeout 8s --max-rtt-timeout 80ms --max-retries 1 -T4';
        await Promise.all(cidrs.map(async (cidr) => {
          const r = await run(`nmap -sn ${flags} ${cidr}`, { timeout: 45000 });
          let curIp = null;
          for (const line of r.stdout.split(/\r?\n/)) {
            const ipm = line.match(/Nmap scan report for\s+(\d+\.\d+\.\d+\.\d+)/);
            if (ipm) { curIp = ipm[1]; continue; }
            const macm = line.match(/MAC Address:\s*([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})/i);
            if (macm && curIp) { const mac = hexOnly(macm[1]); if (mac.length === 12) map[mac] = curIp; curIp = null; }
          }
        }));
      }
      return { map };
    } catch (err) {
      return { map, error: err.message };
    }
  });

  // -- ping -------------------------------------------------------------------
  ipcMain.handle('wifi:ping', async (e, ip) => {
    const cmd = process.platform === 'win32' ? `ping -n 4 -w 1000 ${ip}` : `ping -c 4 -W 1 -w 5 ${ip}`;
    const r = await run(cmd, { timeout: 10000 });
    const stats = parsePingStats(r.stdout);
    const pass = !!(stats && stats.sent > 0 && stats.received > 0);
    return { output: r.stdout, pass, stats, times: parsePingTimes(r.stdout) };
  });

  // -- SSH check (hostname; pwd;) --------------------------------------------
  ipcMain.handle('wifi:ssh', async (e, ip) => {
    const r = await sshExec(ip, 'hostname; pwd;');
    if (!r.ok) return { ok: false, prompt: null, raw: r.error || 'SSH failed' };
    const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const host = lines[0] || '', pwd = lines[1] || '';
    const prompt = host ? `${host}:${pwd}#` : null;
    const raw = (r.stdout || '') + (r.stderr && r.stderr.trim() ? r.stderr : '');
    return { ok: true, prompt, raw };
  });

  // -- temp_shutdown push + verify -------------------------------------------
  ipcMain.handle('wifi:setTemp', async (e, { ip, temp }) => {
    const set = await sshExec(ip, `lgipc-msg varval set platform global temp_shutdown ${temp}`);
    if (!set.ok) return { ok: false, output: '', verify: '', error: set.error || 'SSH failed' };
    const ver = await sshExec(ip, 'lgipc-msg varval get platform global temp_shutdown');
    const verifyOut = (ver.stdout || '').trim();
    const ok = !((set.stderr || '').trim()) && verifyOut === String(temp);
    return { ok, output: set.stdout || '', error: (set.stderr || '').trim(), verify: verifyOut, verifyError: (ver.stderr || '').trim() };
  });

  // -- write result file (numbered-copy unless overwrite) --------------------
  ipcMain.handle('wifi:writeFile', async (e, { folder, filename, content, overwrite }) => {
    try {
      await fsp.mkdir(folder, { recursive: true });
      let target = path.join(folder, filename);
      if (!overwrite && fs.existsSync(target)) {
        const ext = path.extname(filename);
        const base = filename.slice(0, filename.length - ext.length);
        let n = 1;
        while (fs.existsSync(path.join(folder, `${base} (${n})${ext}`))) n++;
        target = path.join(folder, `${base} (${n})${ext}`);
      }
      await fsp.writeFile(target, content, { encoding: 'utf-8' });
      return { path: target };
    } catch (err) {
      return { error: err.message };
    }
  });
};
