// IPC handlers: GitHub account link (Settings → Linked Accounts) → commits on the
// repos you own surface on the Timeline.
//
// The personal access token is encrypted at rest with Electron safeStorage (DPAPI
// on Windows), decrypted only here in the main process, and NEVER sent to the
// renderer — github:status returns just the username/connected flag.
const { ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { GITHUB_TOKEN_FILE } = require('../config');

const API = 'https://api.github.com';

function loadStore() {
  try { return JSON.parse(fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveStore(obj) {
  fs.mkdirSync(path.dirname(GITHUB_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(GITHUB_TOKEN_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
function encrypt(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable — cannot securely store the token.');
  return safeStorage.encryptString(plain).toString('base64');
}
function decrypt(enc) { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }

function getToken() {
  const s = loadStore();
  if (!s.tokenEnc) throw new Error('GitHub is not connected.');
  return decrypt(s.tokenEnc);
}

async function gh(pathOrUrl, token) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'EngOrg-TaskBoard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch {}
    throw new Error(`GitHub ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

module.exports = function register() {
  ipcMain.handle('github:status', async () => {
    const s = loadStore();
    return { connected: !!s.tokenEnc, username: s.username || null, name: s.name || null };
  });

  ipcMain.handle('github:connect', async (event, token) => {
    try {
      token = (token || '').trim();
      if (!token) return { error: 'No token provided.' };
      const user = await gh('/user', token); // validates the token
      saveStore({ username: user.login, name: user.name || user.login, tokenEnc: encrypt(token) });
      return { username: user.login, name: user.name || user.login };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('github:disconnect', async () => {
    try { fs.unlinkSync(GITHUB_TOKEN_FILE); } catch {}
    return true;
  });

  // Commits on the repos you OWN, within the last `days`, newest first.
  ipcMain.handle('github:fetchActivity', async (event, days = 90) => {
    try {
      const token = getToken();
      const sinceISO = new Date(Date.now() - days * 86400000).toISOString();
      // Owned repos, most-recently-pushed first.
      const repos = await gh('/user/repos?affiliation=owner&sort=pushed&per_page=100', token);
      const out = [];
      for (const repo of repos) {
        if (repo.pushed_at && new Date(repo.pushed_at) < new Date(sinceISO)) break; // rest are older
        let commits;
        try { commits = await gh(`/repos/${repo.full_name}/commits?since=${encodeURIComponent(sinceISO)}&per_page=100`, token); }
        catch { continue; } // empty repo (409) or no access → skip
        for (const c of commits) {
          const when = (c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date);
          out.push({
            sha: c.sha,
            repo: repo.name,
            message: (c.commit.message || '').split('\n')[0].slice(0, 200),
            date: when,
            url: c.html_url,
            author: (c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
          });
        }
      }
      out.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { commits: out.slice(0, 300) };
    } catch (err) {
      return { error: err.message, commits: [] };
    }
  });
};
