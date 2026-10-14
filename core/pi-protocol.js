// Shared contract between the desktop app (ipc/pi-link.js) and the Raspberry Pi companion
// build (pi/server.js). Both sides require THIS file, so a port, header or protocol change
// can never drift between them. Electron-free (core/ is bundled into the Pi build).
//
// Bump PROTOCOL whenever a /api route's request or response shape changes incompatibly; the
// desktop shows "Pi needs an update" (and asks it to self-update) when the numbers differ.
module.exports = {
  PROTOCOL: 1,
  PI_PORT: 8780,            // HTTP API + status page
  PI_DISCOVERY_PORT: 8781,  // UDP: desktop broadcasts DISCOVERY_PROBE, the Pi replies with JSON
  DISCOVERY_PROBE: 'ENGORG_PI_DISCOVER_V1',
  // GitHub release asset the Pi self-updates from (attached by CI to every vX.Y.Z release).
  PI_ASSET_NAME: 'EngOrg-Pi.tar.gz',
  // Header the desktop sends with every request so the Pi knows which app version it serves.
  APP_VERSION_HEADER: 'x-engorg-app-version',
};
