// Pi health for /api/status and the status page (all reads are cheap file reads — no exec).
const fs = require('fs');
const os = require('os');
const store = require('./store');

function readTrim(p) { try { return fs.readFileSync(p, 'utf8').replace(/\0/g, '').trim(); } catch { return null; } }

const MODEL = readTrim('/proc/device-tree/model'); // e.g. "Raspberry Pi 3 Model B Rev 1.2"

function cpuTempC() {
  const raw = readTrim('/sys/class/thermal/thermal_zone0/temp');
  return raw ? Math.round(parseInt(raw, 10) / 100) / 10 : null;
}

function disk() {
  try {
    const s = fs.statfsSync(store.DATA_DIR);
    return { freeMB: Math.round((s.bavail * s.bsize) / 1048576), totalMB: Math.round((s.blocks * s.bsize) / 1048576) };
  } catch { return null; }
}

function get() {
  return {
    hostname: os.hostname(),
    model: MODEL,
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    uptimeSec: Math.round(os.uptime()),
    serviceUptimeSec: Math.round(process.uptime()),
    load: os.loadavg().map(n => Math.round(n * 100) / 100),
    memMB: { free: Math.round(os.freemem() / 1048576), total: Math.round(os.totalmem() / 1048576), rss: Math.round(process.memoryUsage().rss / 1048576) },
    cpuTempC: cpuTempC(),
    disk: disk(),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

module.exports = { get };
