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
const { execFile, spawn } = require('child_process');
const config = require('../config');

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

module.exports = function registerUpdates() {
  ipcMain.handle('updates:check', async () => {
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
  });

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
