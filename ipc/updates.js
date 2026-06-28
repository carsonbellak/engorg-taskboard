// IPC handlers: Update Checker — on startup the renderer asks whether the
// canonical repo (config.CONTRIB_REPO) has commits the local install doesn't
// have yet, and if so prompts the user to update.
//
// Two detection modes:
//   • git checkout (.git present) — compares local HEAD to the upstream branch
//     via the GitHub compare API (precise "behind by N commits"); "Update now"
//     runs `git pull --ff-only` in place.
//   • packaged build (no .git)    — falls back to a stored baseline SHA: the
//     first run records the current upstream tip, and any later change to that
//     tip is reported as an available update (manual download from the repo).
//
// All GitHub calls are unauthenticated (public repo). Failures are non-fatal —
// the checker reports it couldn't determine an update and the UI stays quiet.

const { ipcMain, app, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const config = require('../config');

// Top-level entries that aren't part of the running app (never pulled/overwritten).
const IGNORE = new Set(config.CONTRIB_IGNORE || ['.git', 'node_modules', 'appdata']);

// Rolling release the CI publishes EngOrg-Setup.exe to on every push.
const INSTALLER_URL = `${config.CONTRIB_REPO_URL}/releases/download/latest/EngOrg-Setup.exe`;

const APP_ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(config.DATA_DIR, 'update_state.json');
const GH = 'https://api.github.com';

function execFilePromise(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function gh(urlPath, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(urlPath.startsWith('http') ? urlPath : GH + urlPath, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EngOrg-Updater' },
      cache: 'no-store', signal: ctrl.signal,
    });
    let data = null; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
async function writeState(patch) {
  const next = { ...readState(), ...patch };
  try { await fsp.mkdir(config.DATA_DIR, { recursive: true }); await fsp.writeFile(STATE_FILE, JSON.stringify(next, null, 2)); } catch {}
  return next;
}

const isGitRepo = () => fs.existsSync(path.join(APP_ROOT, '.git'));
async function localHead() {
  try { return (await execFilePromise('git', ['-C', APP_ROOT, 'rev-parse', 'HEAD'])).trim(); }
  catch { return null; }
}

// ---- File-level pull helpers (apply upstream changes without a git checkout) ----
// git blob sha1: sha1("blob <bytelen>\0" + content)
function blobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0'); h.update(buf);
  return h.digest('hex');
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
// Upstream text blobs are stored with LF; the local install may have CRLF. Normalize
// before hashing so unchanged files aren't seen as different (and re-downloaded).
function gitBlobSha(buf) {
  const content = isBinary(buf) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return blobSha(content);
}
// The install is a subset of the repo; only touch top-level areas it actually ships.
function shippedTopLevel() {
  let names = [];
  try { names = fs.readdirSync(APP_ROOT); } catch {}
  return new Set(names.filter((n) => !IGNORE.has(n)));
}
async function fetchRaw(owner, repo, branch, p) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/` +
    p.split('/').map(encodeURIComponent).join('/');
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed for ${p} (${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

// ---- Version sync: the repo's package.json version is the source of truth. ----
// Compare local app.getVersion() against the upstream package.json version (semver)
// so the in-app version always reflects what's published on GitHub.
function cmpSemver(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}
async function upstreamVersion(owner, repo, branch) {
  try { return JSON.parse((await fetchRaw(owner, repo, branch, 'package.json')).toString('utf8')).version || null; }
  catch { return null; }
}

module.exports = function registerUpdates() {
  async function checkForUpdates() {
    const { owner, repo, branch } = config.CONTRIB_REPO;
    try {
      const head = await gh(`/repos/${owner}/${repo}/commits/${branch}`);
      if (!head.ok || !head.data || !head.data.sha) {
        return { error: `Could not reach the update server (${head.status || 'no response'}).` };
      }
      const latest = {
        sha: head.data.sha,
        shortSha: String(head.data.sha).slice(0, 7),
        message: ((head.data.commit && head.data.commit.message) || '').split('\n')[0],
        date: head.data.commit && head.data.commit.author && head.data.commit.author.date,
        url: head.data.html_url || config.CONTRIB_REPO_URL,
      };
      const state = readState();
      const skipped = state.skipSha === latest.sha;

      if (isGitRepo()) {
        const current = await localHead();
        if (current && current === latest.sha) return { upToDate: true, latest, current, isGitRepo: true };
        if (current) {
          const cmp = await gh(`/repos/${owner}/${repo}/compare/${current}...${branch}`);
          if (cmp.ok && cmp.data) {
            const behindBy = cmp.data.behind_by || 0; // status: behind | ahead | diverged | identical
            if (behindBy > 0) {
              const commits = (cmp.data.commits || []).slice(-25).reverse().map((c) => ({
                shortSha: String(c.sha || '').slice(0, 7),
                message: ((c.commit && c.commit.message) || '').split('\n')[0],
              }));
              return { updatesAvailable: true, skipped, behindBy, commits, latest, current, isGitRepo: true };
            }
            return { upToDate: true, latest, current, isGitRepo: true }; // ahead / identical
          }
          // Local commit not present upstream (e.g. unpushed work) — can't verify; stay quiet.
          return { upToDate: true, latest, current, isGitRepo: true, unverified: true };
        }
        return { upToDate: true, latest, isGitRepo: true, unverified: true };
      }

      // No git checkout: baseline heuristic.
      if (!state.baseline) { await writeState({ baseline: latest.sha }); return { upToDate: true, latest, isGitRepo: false, baselineInit: true }; }
      if (state.baseline !== latest.sha) return { updatesAvailable: true, skipped, latest, isGitRepo: false };
      return { upToDate: true, latest, isGitRepo: false };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Wrap the commit-level check with version info synced from the repo's package.json.
  ipcMain.handle('updates:check', async () => {
    const res = await checkForUpdates();
    if (res && !res.error) {
      try {
        const { owner, repo, branch } = config.CONTRIB_REPO;
        res.currentVersion = app.getVersion();
        res.latestVersion = await upstreamVersion(owner, repo, branch);
        res.versionBehind = res.latestVersion ? cmpSemver(res.latestVersion, res.currentVersion) > 0 : false;
      } catch {}
    }
    return res;
  });

  // Cheap local-version read for display (Settings → About).
  ipcMain.handle('updates:version', () => ({ version: app.getVersion() }));

  // git checkout only — fast-forward pull in place.
  ipcMain.handle('updates:apply', async () => {
    if (!isGitRepo()) return { error: 'This install is not a git checkout — open the repo to download the latest version.' };
    try {
      // GIT_TERMINAL_PROMPT=0 so a missing credential never blocks on an interactive prompt.
      const out = await execFilePromise('git', ['-C', APP_ROOT, 'pull', '--ff-only'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return { ok: true, output: out.trim() };
    } catch (e) {
      // Common causes: local uncommitted changes, non-fast-forward, or auth required.
      return { error: e.message };
    }
  });

  // No git checkout: "pull" by downloading just the changed upstream files in place.
  // Diffs the repo tree against the install (CRLF-normalized blob compare), fetches
  // every changed file into memory first (so a mid-download failure changes nothing),
  // then writes them all. Reports file-count progress on the same channel the
  // installer download uses. Advances the baseline so the prompt stops afterward.
  ipcMain.handle('updates:pull', async () => {
    const { owner, repo, branch } = config.CONTRIB_REPO;
    const win = BrowserWindow.getAllWindows()[0];
    try {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { timeoutMs: 15000 });
      if (!tree.ok || !tree.data || !Array.isArray(tree.data.tree)) {
        return { error: `Could not read the update file list (${tree.status || 'no response'}).` };
      }
      const head = await gh(`/repos/${owner}/${repo}/commits/${branch}`);
      const latestSha = head.ok && head.data && head.data.sha;

      const shipped = shippedTopLevel();

      // Which upstream files differ from the local copy (within the install footprint)?
      const toPull = [];
      for (const t of tree.data.tree) {
        if (t.type !== 'blob') continue;
        if (!shipped.has(t.path.split('/')[0])) continue;
        let localSha = null;
        try { localSha = gitBlobSha(await fsp.readFile(path.join(APP_ROOT, t.path))); } catch { localSha = null; }
        if (localSha !== t.sha) toPull.push(t.path);
      }

      if (toPull.length === 0) {
        if (latestSha) await writeState({ baseline: latestSha });
        return { ok: true, count: 0, files: [] };
      }

      // Phase 1 — download everything into memory (atomic-ish: nothing written yet).
      const blobs = [];
      let depsChanged = false;
      for (let i = 0; i < toPull.length; i++) {
        const p = toPull[i];
        blobs.push({ path: p, buf: await fetchRaw(owner, repo, branch, p) });
        if (p === 'package.json' || p === 'package-lock.json') depsChanged = true;
        if (win) win.webContents.send('updates:progress', { received: i + 1, total: toPull.length, pct: Math.round(((i + 1) / toPull.length) * 100) });
      }

      // Phase 2 — write them all.
      for (const b of blobs) {
        const abs = path.join(APP_ROOT, b.path);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, b.buf);
      }

      if (latestSha) await writeState({ baseline: latestSha });
      return { ok: true, count: blobs.length, files: blobs.map((b) => b.path), depsChanged };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Remember a version the user chose to skip (also advances the no-git baseline
  // so a manually-updated packaged build stops nagging).
  ipcMain.handle('updates:skip', async (e, sha) => { if (sha) await writeState({ skipSha: sha, baseline: sha }); return { ok: true }; });

  ipcMain.handle('updates:openRepo', async () => {
    try { await shell.openExternal(config.CONTRIB_REPO_URL); return { ok: true }; }
    catch (err) { return { error: err.message }; }
  });

  // Download the latest installer in-app (with progress) so the user never has to
  // visit GitHub. Returns the saved path; the renderer then calls updates:runInstaller.
  ipcMain.handle('updates:download', async () => {
    const dest = path.join(app.getPath('temp'), 'EngOrg-Setup.exe');
    const win = BrowserWindow.getAllWindows()[0];
    try {
      const res = await fetch(INSTALLER_URL, { cache: 'no-store', redirect: 'follow' });
      if (!res.ok || !res.body) return { error: `Download failed (${res.status}).` };
      const total = Number(res.headers.get('content-length')) || 0;

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const fileStream = fs.createWriteStream(dest);
      const reader = res.body.getReader();
      let received = 0, lastPct = -1;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise((resolve, reject) => fileStream.write(Buffer.from(value), (e) => (e ? reject(e) : resolve())));
          received += value.length;
          if (win && total) {
            const pct = Math.floor((received / total) * 100);
            if (pct !== lastPct) { lastPct = pct; win.webContents.send('updates:progress', { received, total, pct }); }
          }
        }
      } finally {
        await new Promise((resolve) => fileStream.end(resolve));
      }
      if (total && received < total) return { error: 'Download was incomplete — try again.' };
      return { ok: true, path: dest };
    } catch (err) {
      try { fs.existsSync(dest) && fs.unlinkSync(dest); } catch {}
      return { error: err.message };
    }
  });

  // Launch the downloaded installer (detached) and quit so it can replace the
  // running files. The installer reinstalls to C:\Assistant and relaunches the app.
  ipcMain.handle('updates:runInstaller', async (e, installerPath) => {
    try {
      const p = installerPath || path.join(app.getPath('temp'), 'EngOrg-Setup.exe');
      if (!fs.existsSync(p)) return { error: 'Installer not found — download it again.' };
      const child = spawn(p, [], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => { app.quit(); }, 800);
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('updates:restart', async () => { app.relaunch(); app.exit(0); });
};
