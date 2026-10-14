// Pairing + bearer tokens. The Pi has no screen, so pairing uses a 6-digit code the owner
// reads on the Pi itself (`sudo engorg-pi code`, also printed by install.sh). A desktop that
// presents the code gets a random token; only its SHA-256 is stored here. Wrong codes are
// rate-limited so the code can't be brute-forced from the LAN.
const crypto = require('crypto');
const os = require('os');
const store = require('./store');

const FILE = 'auth.json';
const MAX_FAILS = 5, FAIL_WINDOW_MS = 10 * 60 * 1000;

let data = null;
let fails = [];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newCode = () => String(crypto.randomInt(100000, 1000000));

function load() {
  if (data) return data;
  data = store.read(FILE, null);
  if (!data || !data.id || !data.code) {
    data = { id: crypto.randomUUID(), name: os.hostname(), code: newCode(), tokens: [] };
    store.write(FILE, data);
  }
  if (!Array.isArray(data.tokens)) data.tokens = [];
  return data;
}

function info() { const d = load(); return { id: d.id, name: d.name, paired: d.tokens.length > 0 }; }
function code() { return load().code; }

function resetPairing() {
  const d = load();
  d.code = newCode();
  d.tokens = [];
  store.write(FILE, d);
  return d.code;
}

// → { token } on success, { error, status } otherwise.
function pair(presented, client) {
  const d = load();
  const now = Date.now();
  fails = fails.filter(t => now - t < FAIL_WINDOW_MS);
  if (fails.length >= MAX_FAILS) return { error: 'Too many wrong codes — wait 10 minutes and try again.', status: 429 };
  const a = Buffer.from(String(presented || '')), b = Buffer.from(d.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    fails.push(now);
    return { error: 'Wrong pairing code.', status: 403 };
  }
  const token = crypto.randomBytes(32).toString('hex');
  d.tokens.push({ hash: sha(token), client: String(client || 'desktop').slice(0, 80), createdAt: new Date().toISOString(), lastSeen: null });
  store.write(FILE, d);
  return { token };
}

// Returns the token record for an Authorization header, or null.
function check(header) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!m) return null;
  const h = sha(m[1]);
  const rec = load().tokens.find(t => t.hash === h);
  if (rec) rec.lastSeen = new Date().toISOString();
  return rec || null;
}

function revoke(rec) {
  const d = load();
  d.tokens = d.tokens.filter(t => t !== rec);
  store.write(FILE, d);
}

module.exports = { info, code, pair, check, revoke, resetPairing };
