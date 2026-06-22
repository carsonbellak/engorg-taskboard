// IPC handlers: Contribute — lets any user of the app submit their local changes
// back to the canonical repo as a GitHub Pull Request for the owner to review.
//
// No local git required: we diff the install against the upstream tree by computing
// git blob SHAs locally and comparing to the repo's tree (GitHub API). Submission
// uses the GitHub low-level git data API with the submitter's Personal Access Token
// to: fork the repo, build one commit with the changed files, and open a PR.
// The PAT is encrypted at rest via Electron safeStorage and only used in main.

const { ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const APP_ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(config.DATA_DIR, 'contrib_token.bin');
const GH = 'https://api.github.com';
const IGNORE = new Set(config.CONTRIB_IGNORE || ['.git', 'node_modules', 'appdata']);

// git blob sha1: sha1("blob <bytelen>\0" + content)
function blobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
}

async function walk(dir, rel, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) await walk(abs, r, out);
    else if (e.isFile()) {
      if (/\.(exe|zip|log)$/i.test(e.name)) continue;
      out.push(r);
    }
  }
}

async function gh(token, urlPath, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'EngOrg-Contribute' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(urlPath.startsWith('http') ? urlPath : GH + urlPath, {
    method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store',
  });
  let data = null; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}

function getToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const buf = fs.readFileSync(TOKEN_FILE);
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
  } catch { return null; }
}

module.exports = function registerContribute() {
  // Compute changed files vs upstream main (no token needed for a public repo).
  ipcMain.handle('contribute:getChanges', async () => {
    const { owner, repo, branch } = config.CONTRIB_REPO;
    try {
      const ref = await gh(null, `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
      if (!ref.ok) {
        if (ref.status === 404) return { error: 'Repo not found yet — publish it first (or check config.CONTRIB_REPO).' };
        return { error: `Could not read upstream (${ref.status}).` };
      }
      const upstream = new Map();
      for (const t of (ref.data.tree || [])) if (t.type === 'blob') upstream.set(t.path, t.sha);

      const local = [];
      await walk(APP_ROOT, '', local);
      const localSet = new Set(local);

      const changes = [];
      for (const p of local) {
        let buf; try { buf = await fsp.readFile(path.join(APP_ROOT, p)); } catch { continue; }
        const sha = blobSha(buf);
        if (!upstream.has(p)) changes.push({ path: p, status: 'added', size: buf.length });
        else if (upstream.get(p) !== sha) changes.push({ path: p, status: 'modified', size: buf.length });
      }
      for (const p of upstream.keys()) if (!localSet.has(p)) changes.push({ path: p, status: 'deleted', size: 0 });

      changes.sort((a, b) => a.path.localeCompare(b.path));
      return { changes, repoUrl: config.CONTRIB_REPO_URL };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('contribute:hasToken', async () => ({ hasToken: !!getToken() }));
  ipcMain.handle('contribute:saveToken', async (e, token) => {
    try {
      const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf-8');
      await fsp.mkdir(config.DATA_DIR, { recursive: true });
      await fsp.writeFile(TOKEN_FILE, buf);
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('contribute:clearToken', async () => {
    try { if (fs.existsSync(TOKEN_FILE)) await fsp.unlink(TOKEN_FILE); return { ok: true }; }
    catch (err) { return { error: err.message }; }
  });

  // Open a PR with the selected files. token optional (falls back to saved one).
  ipcMain.handle('contribute:submit', async (e, { token, title, body, files, saveToken }) => {
    const { owner, repo, branch } = config.CONTRIB_REPO;
    token = token || getToken();
    if (!token) return { error: 'A GitHub Personal Access Token is required.' };
    if (!files || !files.length) return { error: 'No files selected to submit.' };

    try {
      // who am I
      const me = await gh(token, '/user');
      if (!me.ok) return { error: `GitHub auth failed (${me.status}). Check your token.` };
      const login = me.data.login;

      // ensure fork exists (forking is async — poll briefly)
      let fork = await gh(token, `/repos/${login}/${repo}`);
      if (!fork.ok) {
        const f = await gh(token, `/repos/${owner}/${repo}/forks`, { method: 'POST' });
        if (!f.ok) return { error: `Could not fork repo (${f.status}).` };
        for (let i = 0; i < 10 && !fork.ok; i++) { await new Promise((r) => setTimeout(r, 2000)); fork = await gh(token, `/repos/${login}/${repo}`); }
        if (!fork.ok) return { error: 'Fork is still being created — try again in a moment.' };
      }

      // base commit/tree from the fork's branch tip
      const refRes = await gh(token, `/repos/${login}/${repo}/git/ref/heads/${branch}`);
      if (!refRes.ok) return { error: `Could not read fork ref (${refRes.status}).` };
      const baseSha = refRes.data.object.sha;
      const baseCommit = await gh(token, `/repos/${login}/${repo}/git/commits/${baseSha}`);
      if (!baseCommit.ok) return { error: `Could not read base commit (${baseCommit.status}).` };
      const baseTree = baseCommit.data.tree.sha;

      // build tree entries
      const tree = [];
      for (const f of files) {
        if (f.status === 'deleted') { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
        const buf = await fsp.readFile(path.join(APP_ROOT, f.path));
        const blob = await gh(token, `/repos/${login}/${repo}/git/blobs`, { method: 'POST', body: { content: buf.toString('base64'), encoding: 'base64' } });
        if (!blob.ok) return { error: `Failed to upload ${f.path} (${blob.status}).` };
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha });
      }

      const newTree = await gh(token, `/repos/${login}/${repo}/git/trees`, { method: 'POST', body: { base_tree: baseTree, tree } });
      if (!newTree.ok) return { error: `Failed to build tree (${newTree.status}).` };

      const commit = await gh(token, `/repos/${login}/${repo}/git/commits`, { method: 'POST', body: { message: title || 'EngOrg contribution', tree: newTree.data.sha, parents: [baseSha] } });
      if (!commit.ok) return { error: `Failed to create commit (${commit.status}).` };

      const branchName = 'contrib/' + Date.now();
      const newRef = await gh(token, `/repos/${login}/${repo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/' + branchName, sha: commit.data.sha } });
      if (!newRef.ok) return { error: `Failed to create branch (${newRef.status}).` };

      const pr = await gh(token, `/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        body: { title: title || 'EngOrg contribution', body: (body || '') + `\n\n— submitted from EngOrg by @${login}`, head: `${login}:${branchName}`, base: branch },
      });
      if (!pr.ok) return { error: `Failed to open PR (${pr.status}): ${pr.data && pr.data.message || ''}` };

      if (saveToken) {
        try {
          const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf-8');
          await fsp.writeFile(TOKEN_FILE, buf);
        } catch {}
      }
      return { url: pr.data.html_url, number: pr.data.number };
    } catch (err) {
      return { error: err.message };
    }
  });
};
