#!/usr/bin/env node
/*
 * build-pi.js — build the minimal Raspberry Pi (Linux) bundle of the app.
 *
 * Assembles dist/EngOrg-Pi.tar.gz from pi/manifest.json: the Pi service (pi/) plus the
 * desktop's OWN Electron-free modules (config.js, state.js, moonraker.js, core/), with the
 * runtime dependencies at the exact versions the desktop runs. Because the Pi ships the same
 * source as the desktop — never a fork — it can't drift; this script is the gate that keeps it
 * that way:
 *   • any bundled file that requires 'electron' fails the build
 *   • the staged bundle must pass `node pi/server.js --selftest` in isolation (staged outside
 *     the repo, so a module missing from the bundle can't be resolved from ./node_modules)
 *
 * Usage:
 *   node build-pi.js           # → dist/EngOrg-Pi.tar.gz (version = package.json)
 *   node build-pi.js --check   # stage + verify only (no tarball) — run by the pre-ship guard
 *
 * CI (.github/workflows/release-installer.yml, job `pi`) runs this on every vX.Y.Z tag and
 * attaches the tarball to the release; installed Pis self-update from there (pi/lib/updater.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const CHECK = process.argv.includes('--check');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, require('./core/pi-protocol').PI_ASSET_NAME);

function die(m) { process.stderr.write('✗ ' + m + '\n'); process.exit(1); }
function log(m) { process.stdout.write(m + '\n'); }

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pi', 'manifest.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const exclude = new Set((manifest.exclude || []).map(p => p.replace(/\\/g, '/')));
const TEXT_EXT = /\.(js|json|sh|service|md|txt)$/i;

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'engorg-pi-build-'));
const cleanup = () => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// ── 1. Copy the manifest's files (LF line endings: install.sh/.service must run on Linux) ──
const copied = [];
function copyEntry(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) die(`pi/manifest.json lists "${rel}" but it does not exist.`);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(src)) copyEntry(path.posix.join(rel.replace(/\/$/, ''), name));
    return;
  }
  if (exclude.has(rel)) return;
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (TEXT_EXT.test(rel)) fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'));
  else fs.copyFileSync(src, dest);
  copied.push(rel);
}
for (const rel of manifest.include) copyEntry(rel.replace(/\\/g, '/'));

// ── 2. Electron guard ──────────────────────────────────────────────────────────────────
const offenders = copied.filter(rel => rel.endsWith('.js') && /require\(\s*['"]electron['"]\s*\)/.test(fs.readFileSync(path.join(stage, rel), 'utf8')));
if (offenders.length) die(`These Pi-bundled files require Electron (the Pi has none):\n  ${offenders.join('\n  ')}\nMove the Electron-free logic into core/ and keep the IPC wrapper in ipc/.`);

// ── 3. package.json — version + dependency ranges come from the desktop's package.json ──
const deps = {};
for (const name of manifest.dependencies || []) {
  const range = (rootPkg.dependencies || {})[name];
  if (!range) die(`Pi dependency "${name}" is not a dependency of the desktop package.json.`);
  deps[name] = range;
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'engorg-pi',
  version: rootPkg.version,
  description: 'EngOrg Task Board — headless Raspberry Pi companion (built by build-pi.js)',
  private: true,
  main: 'pi/server.js',
  engines: { node: manifest.node || '>=20' },
  dependencies: deps,
}, null, 2) + '\n');

// ── 4. node_modules — copy the desktop's installed versions (offline), else npm install ──
function resolvePkgDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    if (dir === ROOT || path.dirname(dir) === dir) return null;
  }
}
function copyDeps() {
  const seen = new Set();
  const walk = (name, fromDir) => {
    const dir = resolvePkgDir(name, fromDir);
    if (!dir) throw new Error('missing ' + name);
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.gypfile || fs.existsSync(path.join(dir, 'binding.gyp'))) throw new Error(`${name} is a native module — it would need an ARM build on the Pi`);
    for (const d of Object.keys(pkg.dependencies || {})) walk(d, dir);
  };
  for (const name of Object.keys(deps)) walk(name, ROOT);
  for (const dir of seen) {
    const dest = path.join(stage, path.relative(ROOT, dir));
    fs.cpSync(dir, dest, { recursive: true, filter: (src) => !/[\\/]node_modules[\\/]\.bin([\\/]|$)/.test(src) });
  }
  return seen.size;
}
let depNote;
try {
  depNote = `${copyDeps()} packages copied from ./node_modules`;
} catch (e) {
  log(`• ${e.message} in ./node_modules — installing with npm`);
  fs.rmSync(path.join(stage, 'node_modules'), { recursive: true, force: true });
  const localNpm = path.join(ROOT, 'nodejs', 'npm.cmd');
  const npm = process.platform === 'win32' ? (fs.existsSync(localNpm) ? localNpm : 'npm.cmd') : 'npm';
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die('npm install failed for the Pi bundle.');
  depNote = 'installed with npm';
}

// ── 5. Self-test the staged bundle in isolation ─────────────────────────────────────────
const env = { ...process.env };
delete env.NODE_PATH; delete env.ENGORG_PI_HOME; delete env.ENGORG_PI_DATA;
const test = spawnSync(process.execPath, [path.join(stage, 'pi', 'server.js'), '--selftest'], { cwd: stage, env, encoding: 'utf8', timeout: 120000 });
if (test.status !== 0) die(`Pi bundle self-test failed:\n${(test.stdout || '') + (test.stderr || '')}`);
log(`• ${copied.length} files, ${depNote}`);
log(`• ${test.stdout.trim().split('\n').pop()}`);

if (CHECK) { log(`✓ Pi build check passed (v${rootPkg.version}).`); process.exit(0); }

// ── 6. Tarball ─────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(OUT_FILE, { force: true });
// On Windows use the built-in bsdtar explicitly (Git's GNU tar treats "C:" as a remote host).
const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const tar = process.platform === 'win32' && fs.existsSync(sysTar) ? sysTar : 'tar';
execFileSync(tar, ['-czf', OUT_FILE, '-C', stage, '.'], { stdio: 'inherit' });
const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
log(`✓ ${path.relative(ROOT, OUT_FILE)} — EngOrg Pi v${rootPkg.version} (${kb} KB)`);
log('  Install on the Pi: copy it over, then  mkdir engorg-pi && tar -xzf EngOrg-Pi.tar.gz -C engorg-pi && sudo bash engorg-pi/pi/install.sh');
