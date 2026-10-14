// Self-update — keeps the Pi on the same release as the desktop app.
//
// CI attaches EngOrg-Pi.tar.gz (core/pi-protocol PI_ASSET_NAME) to every vX.Y.Z GitHub
// release. The Pi checks every 12 h (and whenever a linked desktop that is newer asks via
// POST /api/update), downloads the newest bundle into $ENGORG_PI_HOME/releases/<ver>, runs
// its --selftest, atomically repoints the `current` symlink and exits; systemd
// (Restart=always) starts the new version. A bundle that fails its self-test is discarded and
// the running version keeps serving. Only works when installed as the service (install.sh).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const config = require('../../config');
const proto = require('../../core/pi-protocol');
const store = require('./store');
const runtimeConfig = require('./runtime-config');

const CHECK_EVERY_MS = 12 * 3600 * 1000;
const KEEP_RELEASES = 2;

let last = { checkedAt: null, latest: null, available: false, error: null };
let busy = null, timer = null;

function cmpSemver(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
  return 0;
}

async function latestRelease() {
  const { owner, repo } = config.CONTRIB_REPO;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`, {
    headers: { 'User-Agent': 'EngOrg-Pi', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('GitHub returned HTTP ' + res.status);
  let best = null;
  for (const r of await res.json()) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(r.tag_name || '');
    if (!m || r.draft) continue;
    const asset = (r.assets || []).find(a => a.name === proto.PI_ASSET_NAME);
    if (asset && (!best || cmpSemver(m[1], best.version) > 0)) best = { version: m[1], url: asset.browser_download_url };
  }
  return best;
}

async function check() {
  try {
    const rel = await latestRelease();
    last = { checkedAt: new Date().toISOString(), latest: rel ? rel.version : null, available: !!rel && cmpSemver(rel.version, store.version()) > 0, error: null };
  } catch (e) {
    last = { ...last, checkedAt: new Date().toISOString(), error: e.message };
  }
  return status();
}

function status() { return { ...last, updating: busy, selfUpdate: !!store.HOME }; }

async function install(rel) {
  const releases = path.join(store.HOME, 'releases');
  const dest = path.join(releases, rel.version);
  const partial = dest + '.partial';
  const tarball = path.join(store.DATA_DIR, 'update.tar.gz');
  fs.mkdirSync(releases, { recursive: true });

  console.log('[update] downloading', rel.version);
  const res = await fetch(rel.url, { headers: { 'User-Agent': 'EngOrg-Pi' }, signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
  fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));

  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', partial], { stdio: 'ignore' });
  fs.rmSync(tarball, { force: true });

  // Prove the new bundle boots before switching to it.
  const test = spawnSync(process.execPath, [path.join(partial, 'pi', 'server.js'), '--selftest'], { encoding: 'utf8', timeout: 120000 });
  if (test.status !== 0) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new Error('new version failed its self-test: ' + ((test.stderr || test.stdout || '').trim().split('\n').pop() || 'exit ' + test.status));
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(partial, dest);
  const current = path.join(store.HOME, 'current');
  const next = current + '.new';
  fs.rmSync(next, { force: true });
  fs.symlinkSync(dest, next);
  fs.renameSync(next, current); // atomic swap of the symlink

  // Keep the newest few releases for manual rollback.
  const all = fs.readdirSync(releases).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort(cmpSemver);
  for (const d of all.slice(0, Math.max(0, all.length - KEEP_RELEASES))) {
    if (d !== rel.version) fs.rmSync(path.join(releases, d), { recursive: true, force: true });
  }

  console.log(`[update] installed ${rel.version} — restarting`);
  setTimeout(() => process.exit(0), 500); // systemd restarts us on the new `current`
}

// → { updating, from, to } | { upToDate } | { error }
async function apply() {
  if (!store.HOME) return { error: 'Self-update only works on an installed Pi (pi/install.sh); this is a dev run.' };
  if (busy) return { updating: true, to: busy };
  let rel;
  try { rel = await latestRelease(); } catch (e) { return { error: 'Could not check GitHub: ' + e.message }; }
  if (!rel) return { error: 'No Raspberry Pi build has been published yet.' };
  if (cmpSemver(rel.version, store.version()) <= 0) return { upToDate: true, version: store.version(), latest: rel.version };
  busy = rel.version;
  install(rel).catch((e) => { console.error('[update] failed:', e.message); last.error = e.message; busy = null; });
  return { updating: true, from: store.version(), to: rel.version };
}

async function tick() {
  await check();
  if (last.available && runtimeConfig.get().autoUpdate) await apply();
}

function start() { if (!timer && store.HOME) { setTimeout(tick, 2 * 60 * 1000); timer = setInterval(tick, CHECK_EVERY_MS); } }
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { check, apply, status, start, stop };
