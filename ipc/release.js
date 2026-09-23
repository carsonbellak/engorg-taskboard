// IPC handlers: cut a versioned release from the app UI (Settings → About).
//
// OWNER-ONLY. `release:info` reports whether the linked GitHub account is the
// repository owner (config.CONTRIB_REPO.owner); `release:cut` runs the very same
// release.js pipeline the maintainer runs from the terminal — bump the version,
// push it to main via submit-changes.js, then push a vX.Y.Z tag so CI builds the
// installer + Android APK (and deploys the PWA when the FIREBASE_SERVICE_ACCOUNT
// secret is configured).
//
// This is dev-machine / maintainer tooling: it needs `node` + `git` on PATH and
// push credentials, which only exist on the owner's machine. The renderer hides
// the UI unless `canRelease`, and `release:cut` re-verifies ownership here in the
// main process so the check can't be bypassed from the renderer.
const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

const { GITHUB_TOKEN_FILE } = config;
const OWNER = (config.CONTRIB_REPO && config.CONTRIB_REPO.owner) || '';

function appRoot() { try { return app.getAppPath(); } catch { return process.cwd(); } }
function releaseScript() { return path.join(appRoot(), 'release.js'); }

// The linked GitHub login (github.js persists { username, name, tokenEnc }); we
// only read the non-secret username here, never the token.
function linkedUsername() {
  try { return (JSON.parse(fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8')) || {}).username || null; }
  catch { return null; }
}
function currentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}
function isOwner(user) { return !!user && !!OWNER && user.toLowerCase() === OWNER.toLowerCase(); }

function nextVersion(cur, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;               // explicit x.y.z
  const [a, b, c] = String(cur || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  if (bump === 'major') return `${a + 1}.0.0`;
  if (bump === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

module.exports = function register() {
  ipcMain.handle('release:info', async () => {
    const username = linkedUsername();
    const owner = isOwner(username);
    const hasScript = fs.existsSync(releaseScript());
    return {
      connected: !!username,
      username,
      owner: OWNER,
      isOwner: owner,
      hasScript,
      canRelease: owner && hasScript,
      currentVersion: currentVersion(),
      repoUrl: config.CONTRIB_REPO_URL || null,
      reason: !username ? 'GitHub is not linked on this device'
        : !owner ? `Linked GitHub account (${username}) is not the repository owner`
        : !hasScript ? 'release.js is not present in this install'
        : '',
    };
  });

  ipcMain.handle('release:cut', async (event, bump, message) => {
    const username = linkedUsername();
    if (!isOwner(username)) {
      return { error: `Not authorized — only the repository owner (${OWNER || '?'}) can publish a release.` };
    }
    const script = releaseScript();
    if (!fs.existsSync(script)) return { error: 'release.js is not present in this install.' };

    // Strict allowlist so only a bump keyword or an explicit x.y.z ever reaches the
    // CLI; the message is passed as its own argv entry (execFile, no shell) and
    // stripped of newlines, so neither can inject extra arguments.
    bump = String(bump || 'patch').trim();
    if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) return { error: 'Invalid release type.' };
    message = String(message == null ? '' : message).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);

    const preVer = currentVersion();
    const args = [script, bump];
    if (message) args.push('-m', message);

    return await new Promise((resolve) => {
      execFile('node', args,
        { cwd: appRoot(), timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          const output = ((stdout || '') + (stderr || '')).trim();
          if (err) {
            const msg = err.code === 'ENOENT'
              ? 'Could not run the release: `node` is not on PATH on this machine.'
              : (stderr || err.message || 'release failed').trim();
            resolve({ error: msg, output });
            return;
          }
          // release.js prints the release URL (…/releases/tag/vX.Y.Z) on success.
          const m = output.match(/releases\/tag\/(v\d+\.\d+\.\d+)/);
          const tag = m ? m[1] : ('v' + nextVersion(preVer, bump));
          const url = (config.CONTRIB_REPO_URL || '') + '/releases/tag/' + tag;
          resolve({ success: true, tag, version: tag.replace(/^v/, ''), url, output });
        });
    });
  });
};
