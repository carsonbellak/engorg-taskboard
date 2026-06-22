// IPC handlers: git status, stage, unstage, commit, diff
const { ipcMain } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

function execFilePromise(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

module.exports = function register() {
  ipcMain.handle('git:status', async (event, dirPath) => {
    try {
      const [porcelain, branchOut] = await Promise.all([
        execFilePromise('git', ['-C', dirPath, 'status', '--porcelain', '-u']),
        execFilePromise('git', ['-C', dirPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
      ]);
      const branch = branchOut.trim();
      const files = [];
      for (const line of porcelain.split('\n')) {
        if (!line.trim()) continue;
        files.push({ path: line.substring(3), status: line.substring(0, 2).trim() });
      }
      return { branch, files };
    } catch (err) {
      return { branch: null, files: [], error: err.message };
    }
  });

  ipcMain.handle('git:stage', async (event, filePath) => {
    const repoRoot = (await execFilePromise('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(filePath) })).trim();
    await execFilePromise('git', ['-C', repoRoot, 'add', filePath]);
    return true;
  });

  ipcMain.handle('git:unstage', async (event, filePath) => {
    const repoRoot = (await execFilePromise('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(filePath) })).trim();
    await execFilePromise('git', ['-C', repoRoot, 'restore', '--staged', filePath]);
    return true;
  });

  ipcMain.handle('git:commit', async (event, dirPath, message) => {
    const stdout = await execFilePromise('git', ['-C', dirPath, 'commit', '-m', message]);
    return stdout.trim();
  });

  ipcMain.handle('git:diff', async (event, filePath) => {
    const repoRoot = (await execFilePromise('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(filePath) })).trim();
    return execFilePromise('git', ['-C', repoRoot, 'diff', filePath]);
  });

  ipcMain.handle('git:isRepo', async (event, dirPath) => {
    try {
      await execFilePromise('git', ['-C', dirPath, 'rev-parse', '--is-inside-work-tree']);
      return true;
    } catch { return false; }
  });
};
