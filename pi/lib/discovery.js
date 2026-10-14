// UDP discovery responder: the desktop (ipc/pi-link.js) broadcasts DISCOVERY_PROBE on
// PI_DISCOVERY_PORT and lists every Pi that answers. The reply carries no secrets.
const dgram = require('dgram');
const proto = require('../../core/pi-protocol');
const auth = require('./auth');
const store = require('./store');

let sock = null;

function start(httpPort) {
  if (sock) return;
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => { console.warn('[discovery] socket error:', e.message); try { sock.close(); } catch {} sock = null; });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== proto.DISCOVERY_PROBE) return;
    const a = auth.info();
    const reply = Buffer.from(JSON.stringify({ app: 'engorg-pi', id: a.id, name: a.name, paired: a.paired, port: httpPort, version: store.version(), protocol: proto.PROTOCOL }));
    sock.send(reply, rinfo.port, rinfo.address, () => {});
  });
  sock.bind(proto.PI_DISCOVERY_PORT, () => console.log('[discovery] listening on udp', proto.PI_DISCOVERY_PORT));
}

function stop() { if (sock) { try { sock.close(); } catch {} sock = null; } }

module.exports = { start, stop };
