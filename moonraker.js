// Moonraker URL auto-discovery.
//
// The printer is on DHCP, so its IP can change on reboot/power-loss, breaking the
// hardcoded config.MOONRAKER_URL. Instead of trusting the static value, we keep the
// live URL in state.moonrakerUrl and self-heal: health-check the last-known URL and,
// if it's unreachable, scan the LAN /24 for a host answering on the Moonraker port
// with a valid /printer/info response, then adopt whatever IP responds.
const http = require('http');
const net = require('net');
const config = require('./config');
const state = require('./state');

const MOONRAKER_PORT = 7125;

// GET /printer/info and confirm it's really Moonraker (has a `result` object).
function healthCheck(baseUrl, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL('/printer/info', baseUrl); } catch { return resolve(false); }
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => { data += c; if (data.length > 8192) req.destroy(); });
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(!!(j && j.result)); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Fast TCP connect test — used to shortlist live hosts before the heavier HTTP check.
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Probe x.y.z.1–254 concurrently on the Moonraker port, then validate responders
// over HTTP. Returns the first base URL that speaks Moonraker, or null.
async function scanSubnet(prefix) {
  const open = [];
  await Promise.all(
    Array.from({ length: 254 }, (_, i) => prefix + (i + 1)).map(async (host) => {
      if (await tcpProbe(host, MOONRAKER_PORT, 900)) open.push(host);
    })
  );
  for (const host of open) {
    const url = `http://${host}:${MOONRAKER_PORT}`;
    if (await healthCheck(url)) return url;
  }
  return null;
}

function subnetPrefix(baseUrl) {
  try {
    const parts = new URL(baseUrl).hostname.split('.');
    if (parts.length === 4) return parts.slice(0, 3).join('.') + '.';
  } catch {}
  return null;
}

let inFlight = null;

// Resolve the current Moonraker base URL, updating state.moonrakerUrl as a side effect.
//   seed  — preferred URL to try first (e.g. the renderer's saved printer IP)
//   force — skip the health check and scan immediately
// Returns the resolved URL string (falls back to the last-known URL if nothing answers).
function resolve({ force = false, seed = null } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const candidate = seed || state.moonrakerUrl || config.MOONRAKER_URL;

    if (!force && await healthCheck(candidate)) {
      state.moonrakerUrl = candidate;
      return candidate;
    }

    const prefix = subnetPrefix(candidate);
    if (prefix) {
      console.log(`[Moonraker] ${candidate} unreachable — scanning ${prefix}0/24 on port ${MOONRAKER_PORT}…`);
      const found = await scanSubnet(prefix);
      if (found) {
        if (found !== state.moonrakerUrl) console.log('[Moonraker] discovered printer at', found);
        state.moonrakerUrl = found;
        return found;
      }
      console.warn(`[Moonraker] no Moonraker found on ${prefix}0/24 — keeping ${state.moonrakerUrl}`);
    }
    return state.moonrakerUrl || candidate;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function getUrl() { return state.moonrakerUrl || config.MOONRAKER_URL; }

module.exports = { resolve, getUrl, healthCheck };
