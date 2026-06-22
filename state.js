// Shared mutable state between main.js, fluidd-server.js, and ipc/printer.js
module.exports = {
  latestCameraFrame: null, // Buffer — latest JPEG from WebRTC camera, served at /snapshot and /stream
  fluiddServer: null,      // http.Server instance when Fluidd proxy is running, null when stopped
  // Live Moonraker base URL — seeded from config.MOONRAKER_URL, updated by moonraker.js
  // auto-discovery when the printer's DHCP address changes. Read this, not config, at request time.
  moonrakerUrl: require('./config').MOONRAKER_URL,
};
