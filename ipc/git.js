// IPC handlers for the Git Manager utility + the file-viewer Git panel.
// Everything shells out to the system `git` (no native deps). Network ops run
// with GIT_TERMINAL_PROMPT=0 so a missing credential fails fast instead of
// hanging on an invisible prompt — auth relies on the OS credential manager
// (the same store GitHub Desktop / `git push` already use).
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const copyDir = (src, dest) => fs.promises.cp(src, dest, { recursive: true, force: true });

const NET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

function execFilePromise(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const e = new Error((stderr && stderr.trim()) || error.message);
        e.stdout = stdout; e.stderr = stderr;
        reject(e);
      } else resolve(stdout);
    });
  });
}

// Run git inside a repo dir. `net: true` allows network access + a longer timeout.
function git(dir, args, { net = false, timeout } = {}) {
  return execFilePromise('git', ['-C', dir, ...args], {
    env: net ? NET_ENV : process.env,
    timeout: timeout || (net ? 120000 : 30000),
  });
}

// Split a raw command line into argv, honoring single/double quotes. Used by the
// CLI box so users can type e.g. `commit -m "two words"`.
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function repoRootOf(p) {
  // p may be a file or a dir; resolve to the repo top-level.
  const base = p;
  return (await execFilePromise('git', ['rev-parse', '--show-toplevel'], { cwd: base })).trim();
}

function parseStatus(porcelain) {
  // Porcelain v1 `-z`-free parse. Each line: XY <path> (or `R  old -> new`).
  const files = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0];       // index/staged state
    const y = line[1];       // worktree/unstaged state
    let p = line.substring(3);
    let orig = null;
    if (p.includes(' -> ')) { const parts = p.split(' -> '); orig = parts[0]; p = parts[1]; }
    // Unmerged/conflict states: DD, AU, UD, UA, DU, AA, UU.
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    files.push({
      path: p,
      orig,
      status: (x + y).trim(),       // back-compat (file-viewer reads this)
      index: x === ' ' ? '' : x,    // staged change type
      work: y === ' ' ? '' : y,     // unstaged change type
      staged: !conflicted && x !== ' ' && x !== '?',
      unstaged: conflicted || y !== ' ' || x === '?',
      untracked: x === '?' && y === '?',
      conflicted,
    });
  }
  return files;
}

module.exports = function register() {
  // ---- Status / inspection ------------------------------------------------
  ipcMain.handle('git:status', async (event, dirPath) => {
    try {
      const porcelain = await git(dirPath, ['status', '--porcelain', '-u']);
      // Branch may not resolve on an unborn HEAD (fresh repo, no commits yet).
      let branch = null;
      try { branch = (await git(dirPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* unborn */ }
      if (!branch || branch === 'HEAD') {
        try { branch = (await git(dirPath, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch { /* detached or unborn */ }
      }
      const files = parseStatus(porcelain);

      // Upstream + ahead/behind (best-effort; no upstream is normal).
      let upstream = null, ahead = 0, behind = 0;
      try {
        upstream = (await git(dirPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
        const counts = (await git(dirPath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim();
        const [b, a] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
        behind = b; ahead = a;
      } catch { /* no upstream configured */ }

      return { branch, files, upstream, ahead, behind, staged: files.filter(f => f.staged), unstaged: files.filter(f => f.unstaged) };
    } catch (err) {
      return { branch: null, files: [], error: err.message };
    }
  });

  ipcMain.handle('git:branches', async (event, dirPath) => {
    try {
      // Literal \x1f separators (ref-filter emits non-atom chars verbatim).
      const out = await git(dirPath, ['branch', '-a', '--format=%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)']);
      const local = [], remote = [];
      let current = null;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [name, head, upstream] = line.split('\x1f');
        if (name.startsWith('remotes/') || name.includes('/HEAD')) {
          if (!name.includes('/HEAD')) remote.push(name.replace(/^remotes\//, ''));
          continue;
        }
        const isCurrent = head === '*';
        if (isCurrent) current = name;
        local.push({ name, current: isCurrent, upstream: upstream || null });
      }
      return { current, local, remote };
    } catch (err) {
      return { current: null, local: [], remote: [], error: err.message };
    }
  });

  ipcMain.handle('git:log', async (event, dirPath, limit = 80) => {
    try {
      // Unit-separator delimited so subjects with any char are safe.
      const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%D'].join('%x1f');
      const out = await git(dirPath, ['log', `--max-count=${limit}`, `--pretty=format:${fmt}`, '--all', '--date-order']);
      const commits = out.split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, author, email, date, subject, refs] = line.split('\x1f');
        return { hash, shortHash, author, email, date, subject, refs: (refs || '').trim() };
      });
      return { commits };
    } catch (err) {
      return { commits: [], error: err.message };
    }
  });

  ipcMain.handle('git:remotes', async (event, dirPath) => {
    try {
      const out = await git(dirPath, ['remote', '-v']);
      const map = {};
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [name, rest] = line.split('\t');
        const url = (rest || '').replace(/\s*\(fetch\)|\s*\(push\)/, '').trim();
        if (!map[name]) map[name] = url;
      }
      return { remotes: Object.entries(map).map(([name, url]) => ({ name, url })) };
    } catch (err) {
      return { remotes: [], error: err.message };
    }
  });

  ipcMain.handle('git:isRepo', async (event, dirPath) => {
    try { await git(dirPath, ['rev-parse', '--is-inside-work-tree']); return true; }
    catch { return false; }
  });

  // ---- Staging ------------------------------------------------------------
  ipcMain.handle('git:stage', async (event, filePath) => {
    const root = await repoRootOf(path.dirname(filePath));
    await execFilePromise('git', ['-C', root, 'add', '--', filePath]);
    return true;
  });

  ipcMain.handle('git:unstage', async (event, filePath) => {
    const root = await repoRootOf(path.dirname(filePath));
    await execFilePromise('git', ['-C', root, 'restore', '--staged', '--', filePath]);
    return true;
  });

  // Repo-relative path variants used by the Git Manager.
  ipcMain.handle('git:stagePaths', async (event, dirPath, paths) => {
    await git(dirPath, ['add', '--', ...paths]); return true;
  });
  ipcMain.handle('git:unstagePaths', async (event, dirPath, paths) => {
    await git(dirPath, ['restore', '--staged', '--', ...paths]); return true;
  });
  ipcMain.handle('git:stageAll', async (event, dirPath) => { await git(dirPath, ['add', '-A']); return true; });
  ipcMain.handle('git:unstageAll', async (event, dirPath) => { await git(dirPath, ['reset']); return true; });

  // Discard working-tree changes. Tracked → restore; untracked → clean.
  ipcMain.handle('git:discardPaths', async (event, dirPath, paths) => {
    try { await git(dirPath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]); } catch { /* may be untracked-only */ }
    await git(dirPath, ['clean', '-fd', '--', ...paths]).catch(() => {});
    return true;
  });
  ipcMain.handle('git:discardAll', async (event, dirPath) => {
    await git(dirPath, ['reset', '--hard', 'HEAD']).catch(() => {});
    await git(dirPath, ['clean', '-fd']).catch(() => {});
    return true;
  });

  // ---- Commit / history ---------------------------------------------------
  ipcMain.handle('git:commit', async (event, dirPath, message, opts = {}) => {
    const args = ['commit', '-m', message];
    if (opts.amend) args.push('--amend');
    if (opts.stageAll) await git(dirPath, ['add', '-A']);
    return (await git(dirPath, args)).trim();
  });

  ipcMain.handle('git:undoLastCommit', async (event, dirPath) => {
    // Keep changes staged (GitHub Desktop "Undo" behavior).
    await git(dirPath, ['reset', '--soft', 'HEAD~1']);
    return true;
  });

  // ---- Diff ---------------------------------------------------------------
  ipcMain.handle('git:diff', async (event, filePath) => {
    const root = await repoRootOf(path.dirname(filePath));
    return execFilePromise('git', ['-C', root, 'diff', '--', filePath]);
  });
  ipcMain.handle('git:diffPath', async (event, dirPath, relPath, staged) => {
    const args = ['diff'];
    if (staged) args.push('--staged');
    args.push('--', relPath);
    let out = await git(dirPath, args);
    if (!out.trim() && !staged) {
      // Untracked file: show its whole content as additions.
      out = await git(dirPath, ['diff', '--no-index', '--', '/dev/null', relPath]).catch(e => e.stdout || '');
    }
    return out;
  });

  // ---- Branching ----------------------------------------------------------
  ipcMain.handle('git:createBranch', async (event, dirPath, name, checkout = true) => {
    await git(dirPath, checkout ? ['checkout', '-b', name] : ['branch', name]);
    return true;
  });
  ipcMain.handle('git:checkout', async (event, dirPath, name) => {
    return (await git(dirPath, ['checkout', name])).trim();
  });
  ipcMain.handle('git:deleteBranch', async (event, dirPath, name, force = false) => {
    await git(dirPath, ['branch', force ? '-D' : '-d', name]);
    return true;
  });
  ipcMain.handle('git:renameBranch', async (event, dirPath, oldName, newName) => {
    await git(dirPath, ['branch', '-m', oldName, newName]);
    return true;
  });
  ipcMain.handle('git:merge', async (event, dirPath, branch) => {
    return (await git(dirPath, ['merge', '--no-edit', branch])).trim();
  });

  // ---- Stash --------------------------------------------------------------
  ipcMain.handle('git:stash', async (event, dirPath, message) => {
    const args = ['stash', 'push', '--include-untracked'];
    if (message) args.push('-m', message);
    return (await git(dirPath, args)).trim();
  });
  ipcMain.handle('git:stashList', async (event, dirPath) => {
    try {
      const out = await git(dirPath, ['stash', 'list', '--pretty=format:%gd%x1f%s']);
      return { stashes: out.split('\n').filter(Boolean).map(l => { const [ref, subject] = l.split('\x1f'); return { ref, subject }; }) };
    } catch (err) { return { stashes: [], error: err.message }; }
  });
  ipcMain.handle('git:stashApply', async (event, dirPath, ref, drop = true) => {
    await git(dirPath, ['stash', drop ? 'pop' : 'apply', ...(ref ? [ref] : [])]);
    return true;
  });
  ipcMain.handle('git:stashDrop', async (event, dirPath, ref) => {
    await git(dirPath, ['stash', 'drop', ...(ref ? [ref] : [])]);
    return true;
  });

  // ---- Network ------------------------------------------------------------
  ipcMain.handle('git:fetch', async (event, dirPath) => {
    return (await git(dirPath, ['fetch', '--all', '--prune'], { net: true })).trim();
  });
  ipcMain.handle('git:pull', async (event, dirPath, opts = {}) => {
    const args = ['pull'];
    if (opts.rebase) args.push('--rebase');
    return (await git(dirPath, args, { net: true })).trim();
  });
  ipcMain.handle('git:push', async (event, dirPath, opts = {}) => {
    const args = ['push'];
    if (opts.setUpstream && opts.remote && opts.branch) args.push('-u', opts.remote, opts.branch);
    if (opts.force) args.push('--force-with-lease');
    if (opts.tags) args.push('--tags');
    return (await git(dirPath, args, { net: true })).trim();
  });
  // GitHub Desktop "Sync": fetch, then pull (if behind), then push.
  ipcMain.handle('git:sync', async (event, dirPath) => {
    const log = [];
    log.push(await git(dirPath, ['fetch', '--all', '--prune'], { net: true }));
    try { log.push(await git(dirPath, ['pull', '--ff-only'], { net: true })); }
    catch (e) { log.push(await git(dirPath, ['pull', '--no-edit'], { net: true })); }
    try { log.push(await git(dirPath, ['push'], { net: true })); } catch (e) { log.push(e.message); }
    return log.filter(Boolean).join('\n').trim();
  });

  // ---- Repo lifecycle -----------------------------------------------------
  ipcMain.handle('git:init', async (event, dirPath) => { await git(dirPath, ['init']); return true; });
  ipcMain.handle('git:clone', async (event, parentDir, url, dirName) => {
    const args = ['clone', url];
    if (dirName) args.push(dirName);
    const out = await execFilePromise('git', args, { cwd: parentDir, env: NET_ENV, timeout: 300000 });
    // Derive the resulting repo path.
    const name = dirName || (url.split('/').pop() || '').replace(/\.git$/, '');
    return { path: path.join(parentDir, name), output: out.trim() };
  });
  ipcMain.handle('git:addRemote', async (event, dirPath, name, url) => {
    await git(dirPath, ['remote', 'add', name, url]); return true;
  });

  // ---- Folder upload / download ------------------------------------------
  // Copy a local folder INTO the selected repo, then commit (and optionally push).
  ipcMain.handle('git:uploadFolder', async (event, repoDir, srcFolder, opts = {}) => {
    const name = (opts.subfolder || path.basename(srcFolder.replace(/[\\/]+$/, ''))).replace(/[\\/]+$/, '');
    const dest = path.join(repoDir, name);
    await copyDir(srcFolder, dest);
    await git(repoDir, ['add', '-A']);
    const log = [];
    try { log.push(await git(repoDir, ['commit', '-m', opts.commitMessage || `Add ${name}`])); }
    catch (e) { log.push(e.message); } // e.g. nothing to commit
    if (opts.push) {
      try { log.push(await git(repoDir, ['push'], { net: true })); }
      catch (e) {
        const branch = (await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        log.push(await git(repoDir, ['push', '-u', 'origin', branch], { net: true }));
      }
    }
    return { dest, output: log.filter(Boolean).join('\n').trim() };
  });

  // Turn a standalone local folder into a repo and push it to a remote URL.
  ipcMain.handle('git:publishFolder', async (event, srcFolder, remoteUrl, opts = {}) => {
    const isRepo = await git(srcFolder, ['rev-parse', '--is-inside-work-tree']).then(() => true).catch(() => false);
    let branch = opts.branch;
    if (!isRepo) {
      branch = branch || 'main';
      try { await git(srcFolder, ['init', '-b', branch]); }       // git ≥2.28
      catch { await git(srcFolder, ['init']); await git(srcFolder, ['checkout', '-B', branch]); }
    } else if (!branch) {
      branch = (await git(srcFolder, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main')).trim() || 'main';
    }
    const remotes = (await git(srcFolder, ['remote']).catch(() => '')).split('\n').map(s => s.trim());
    await git(srcFolder, ['remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', remoteUrl]);
    await git(srcFolder, ['add', '-A']);
    try { await git(srcFolder, ['commit', '-m', opts.commitMessage || 'Initial commit']); } catch { /* nothing to commit */ }
    const out = await git(srcFolder, ['push', '-u', 'origin', branch], { net: true });
    return { path: srcFolder, branch, output: out.trim() };
  });

  // Copy a folder OUT of the repo's working tree to a destination on disk.
  ipcMain.handle('git:extractFolder', async (event, srcFolder, destParent) => {
    const base = path.basename(srcFolder.replace(/[\\/]+$/, ''));
    const dest = path.join(destParent, base);
    await copyDir(srcFolder, dest);
    return { dest };
  });

  // Download a single subfolder from a remote repo via sparse-checkout, then
  // copy just that folder to the destination (the temp clone is cleaned up).
  ipcMain.handle('git:sparseDownload', async (event, remoteUrl, subfolder, destParent, opts = {}) => {
    const rel = subfolder.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-sparse-'));
    try {
      const args = ['clone', '--no-checkout', '--depth', '1', '--filter=blob:none', '--sparse'];
      if (opts.branch) args.push('--branch', opts.branch);
      args.push(remoteUrl, tmp);
      await execFilePromise('git', args, { env: NET_ENV, timeout: 300000 });
      await git(tmp, ['sparse-checkout', 'set', rel]);
      await git(tmp, ['checkout']);
      const src = path.join(tmp, rel);
      if (!fs.existsSync(src)) throw new Error(`Folder "${rel}" was not found in the repository.`);
      const dest = path.join(destParent, path.basename(rel));
      await copyDir(src, dest);
      return { dest };
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // List immediate subfolders of the repo working tree (for the extract picker).
  ipcMain.handle('git:listFolders', async (event, dirPath) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return { folders: entries.filter(e => e.isDirectory() && e.name !== '.git').map(e => e.name).sort() };
    } catch (err) { return { folders: [], error: err.message }; }
  });

  // ---- In-progress operations / conflict resolution ----------------------
  const gitDirOf = async (dir) => (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();

  ipcMain.handle('git:mergeStatus', async (event, dir) => {
    try {
      const g = await gitDirOf(dir);
      const has = (f) => fs.existsSync(path.join(g, f));
      let state = null;
      if (has('MERGE_HEAD')) state = 'merge';
      else if (has('rebase-merge') || has('rebase-apply')) state = 'rebase';
      else if (has('CHERRY_PICK_HEAD')) state = 'cherry-pick';
      else if (has('REVERT_HEAD')) state = 'revert';
      return { state };
    } catch (err) { return { state: null, error: err.message }; }
  });

  ipcMain.handle('git:resolvePaths', async (event, dir, paths, side) => {
    await git(dir, ['checkout', side === 'theirs' ? '--theirs' : '--ours', '--', ...paths]);
    await git(dir, ['add', '--', ...paths]);
    return true;
  });
  ipcMain.handle('git:abort', async (event, dir, state) => {
    const map = { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'] };
    await git(dir, map[state] || ['merge', '--abort']);
    return true;
  });
  ipcMain.handle('git:continueOp', async (event, dir, state) => {
    const env = { ...process.env, GIT_EDITOR: 'true' }; // never open an editor
    if (state === 'merge') return (await execFilePromise('git', ['-C', dir, 'commit', '--no-edit'], { env })).trim();
    const sub = { rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[state] || 'merge';
    return (await execFilePromise('git', ['-C', dir, sub, '--continue'], { env })).trim();
  });

  // ---- Commit-level operations (History context menu) --------------------
  ipcMain.handle('git:revert', async (event, dir, hash) => (await git(dir, ['revert', '--no-edit', hash])).trim());
  ipcMain.handle('git:cherryPick', async (event, dir, hash) => (await git(dir, ['cherry-pick', hash])).trim());
  ipcMain.handle('git:reset', async (event, dir, hash, mode = 'mixed') => { await git(dir, ['reset', '--' + mode, hash]); return true; });
  ipcMain.handle('git:checkoutCommit', async (event, dir, hash) => (await git(dir, ['checkout', hash])).trim());
  ipcMain.handle('git:branchAt', async (event, dir, name, hash) => { await git(dir, ['checkout', '-b', name, hash]); return true; });
  ipcMain.handle('git:lastCommitMessage', async (event, dir) => { try { return (await git(dir, ['log', '-1', '--pretty=%B'])).trim(); } catch { return ''; } });

  // ---- Tags ---------------------------------------------------------------
  ipcMain.handle('git:tags', async (event, dir) => {
    try {
      const out = await git(dir, ['tag', '--sort=-creatordate', '--format=%(refname:short)\x1f%(subject)']);
      return { tags: out.split('\n').filter(Boolean).map(l => { const [name, subject] = l.split('\x1f'); return { name, subject: subject || '' }; }) };
    } catch (err) { return { tags: [], error: err.message }; }
  });
  ipcMain.handle('git:tagAt', async (event, dir, name, hash, message) => {
    const args = ['tag']; if (message) args.push('-a', '-m', message); args.push(name); if (hash) args.push(hash);
    await git(dir, args); return true;
  });
  ipcMain.handle('git:deleteTag', async (event, dir, name) => { await git(dir, ['tag', '-d', name]); return true; });
  ipcMain.handle('git:pushTag', async (event, dir, name) => (await git(dir, ['push', 'origin', name], { net: true })).trim());

  // ---- Remotes (write ops) ------------------------------------------------
  ipcMain.handle('git:removeRemote', async (event, dir, name) => { await git(dir, ['remote', 'remove', name]); return true; });
  ipcMain.handle('git:renameRemote', async (event, dir, oldN, newN) => { await git(dir, ['remote', 'rename', oldN, newN]); return true; });
  ipcMain.handle('git:setRemoteUrl', async (event, dir, name, url) => { await git(dir, ['remote', 'set-url', name, url]); return true; });

  // ---- Raw CLI ------------------------------------------------------------
  // Powers the in-utility git terminal. Always scoped to the chosen repo.
  ipcMain.handle('git:raw', async (event, dirPath, commandLine) => {
    let argv = splitArgs(commandLine);
    if (argv[0] === 'git') argv = argv.slice(1); // tolerate a leading "git"
    if (!argv.length) return { stdout: '', stderr: '', error: 'No command.' };
    try {
      const stdout = await git(dirPath, argv, { net: true });
      return { stdout, stderr: '', ok: true };
    } catch (err) {
      return { stdout: err.stdout || '', stderr: err.stderr || err.message, ok: false, error: err.message };
    }
  });
};
