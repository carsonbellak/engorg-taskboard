// IPC handlers: file system operations, KiCad export, file watching
const { ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const TEXT_EXTENSIONS = new Set([
  'txt','md','log','ini','cfg','conf','env','js','ts','jsx','tsx','py','rb','go','rs',
  'java','kt','c','cpp','h','hpp','cs','php','swift','sh','bash','bat','ps1','cmd',
  'html','css','scss','less','xml','json','yaml','yml','toml','sql','r','lua','dart',
  'zig','makefile','cmake','gradle','properties','gcode','gco','nc'
]);

const SKIP_DIRS = new Set(['node_modules', '.git']);

// File watchers map: dirPath → FSWatcher
const _fileWatchers = new Map();

// Resolve kicad-cli path, checking common Windows install locations before falling back to PATH
function findKicadCli() {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const base of [programFiles, programFilesX86]) {
    for (const ver of ['9.0', '8.0', '8', '9', '7.0']) {
      const candidate = path.join(base, 'KiCad', ver, 'bin', 'kicad-cli.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    const flat = path.join(base, 'KiCad', 'bin', 'kicad-cli.exe');
    if (fs.existsSync(flat)) return flat;
  }
  return 'kicad-cli';
}

let _kicadCliPath = null;
function getKicadCli() {
  if (_kicadCliPath === null) _kicadCliPath = findKicadCli();
  return _kicadCliPath;
}

module.exports = function register(getMainWindow) {
  ipcMain.handle('files:selectFolder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
      title: 'Select folder to browse'
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('files:readdir', async (event, dirPath) => {
    try { await fs.promises.access(dirPath); } catch { return []; }
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN') continue;
      const fullPath = path.join(dirPath, entry.name);
      let stats = null;
      try { stats = await fs.promises.stat(fullPath); } catch { continue; }
      items.push({ name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size: stats.size, modified: stats.mtime.toISOString() });
    }
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return items;
  });

  ipcMain.handle('files:readText', async (event, filePath) => {
    const buf = await fs.promises.readFile(filePath);
    if (buf.length > 50 * 1024 * 1024) throw new Error('File too large for text read (>50MB)');
    return buf.toString('utf-8');
  });

  ipcMain.handle('files:readBinary', async (event, filePath) => {
    const buf = await fs.promises.readFile(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('files:getFileUrl', async (event, filePath) => {
    return `file:///${filePath.replace(/\\/g, '/')}`;
  });

  ipcMain.handle('files:stat', async (event, filePath) => {
    const stats = await fs.promises.stat(filePath);
    return { size: stats.size, modified: stats.mtime.toISOString(), created: stats.birthtime.toISOString(), isDirectory: stats.isDirectory() };
  });

  ipcMain.handle('files:getHome', async () => require('os').homedir());

  ipcMain.handle('files:rename', async (event, oldPath, newPath) => {
    await fs.promises.rename(oldPath, newPath);
    return true;
  });

  ipcMain.handle('files:delete', async (event, filePath) => {
    await shell.trashItem(filePath);
    return true;
  });

  ipcMain.handle('files:writeText', async (event, filePath, content) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return true;
  });

  ipcMain.handle('files:mkdir', async (event, dirPath) => {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return true;
  });

  ipcMain.handle('files:copyFile', async (event, src, dest) => {
    await fs.promises.copyFile(src, dest);
    return true;
  });

  ipcMain.handle('files:moveFile', async (event, src, dest) => {
    await fs.promises.rename(src, dest);
    return true;
  });

  ipcMain.handle('files:exists', async (event, filePath) => {
    try { await fs.promises.access(filePath); return true; } catch { return false; }
  });

  ipcMain.handle('files:readHead', async (event, filePath, bytes) => {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fd.read(buf, 0, bytes, 0);
      return buf.slice(0, bytesRead).toString('utf-8');
    } finally {
      await fd.close();
    }
  });

  ipcMain.handle('files:batchRename', async (event, dirPath, find, replace, options) => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      const oldName = entry.name;
      let newName;
      if (options?.regex) {
        try {
          const re = new RegExp(find, options.caseSensitive ? 'g' : 'gi');
          newName = oldName.replace(re, replace);
        } catch { newName = oldName; }
      } else {
        if (options?.caseSensitive) {
          newName = oldName.split(find).join(replace);
        } else {
          newName = oldName.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replace);
        }
      }
      if (newName !== oldName && newName.length > 0) {
        const oldFull = path.join(dirPath, oldName);
        const newFull = path.join(dirPath, newName);
        try {
          await fs.promises.rename(oldFull, newFull);
          results.push({ old: oldName, new: newName, success: true });
        } catch (err) {
          results.push({ old: oldName, new: newName, success: false, error: err.message });
        }
      }
    }
    return results;
  });

  ipcMain.handle('files:searchContent', async (event, rootDir, query, options = {}) => {
    const { regex = false, caseSensitive = false, maxResults = 200 } = options;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    const results = [];
    let totalMatches = 0;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(regex ? query : escaped, caseSensitive ? 'g' : 'gi');

    async function walk(dir) {
      if (totalMatches >= maxResults) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (totalMatches >= maxResults) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          await walk(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase().replace('.', '');
          if (!TEXT_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(entry.name.toLowerCase())) continue;
          let stats;
          try { stats = await fs.promises.stat(fullPath); } catch { continue; }
          if (stats.size > MAX_FILE_SIZE) continue;
          let content;
          try { content = await fs.promises.readFile(fullPath, 'utf-8'); } catch { continue; }
          const lines = content.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length; i++) {
            if (totalMatches >= maxResults) break;
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) { matches.push({ line: lines[i], lineNumber: i + 1 }); totalMatches++; }
          }
          if (matches.length > 0) results.push({ filePath: fullPath, matches });
        }
      }
    }

    await walk(rootDir);
    return results;
  });

  ipcMain.handle('files:watch', async (event, dirPath) => {
    if (_fileWatchers.has(dirPath)) return true;
    let debounceTimer = null;
    try {
      const watcher = fs.watch(dirPath, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send('files:changed', dirPath);
        }, 500);
      });
      watcher.on('error', () => _fileWatchers.delete(dirPath));
      _fileWatchers.set(dirPath, watcher);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('files:unwatch', async (event, dirPath) => {
    const watcher = _fileWatchers.get(dirPath);
    if (watcher) { watcher.close(); _fileWatchers.delete(dirPath); }
    return true;
  });

  // KiCad schematic/PCB → SVG via kicad-cli
  ipcMain.handle('files:exportKicad', async (event, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const tmpDir = path.join(require('os').tmpdir(), 'engorg-kicad-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const kicadCli = getKicadCli();

    return new Promise((resolve, reject) => {
      let args;
      if (ext === '.kicad_sch') {
        args = ['sch', 'export', 'svg', '--output', tmpDir + path.sep, filePath];
      } else if (ext === '.kicad_pcb') {
        const outFile = path.join(tmpDir, 'board.svg');
        args = ['pcb', 'export', 'svg', '--layers', 'F.Cu,B.Cu,F.SilkS,B.SilkS,Edge.Cuts,F.Fab,F.Mask', '--mode-single', '--page-size-mode', '2', '--output', outFile, filePath];
      } else {
        reject(new Error('Unsupported KiCad file type: ' + ext)); return;
      }

      execFile(kicadCli, args, { timeout: 60000 }, async (error) => {
        if (error) {
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          reject(new Error(error.code === 'ENOENT' ? 'kicad-cli not found. Searched: ' + kicadCli : 'KiCad export failed: ' + error.message));
          return;
        }
        try {
          const svgs = [];
          async function collectSvgs(dir) {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) { await collectSvgs(full); }
              else if (entry.name.endsWith('.svg')) { svgs.push({ name: entry.name, content: await fs.promises.readFile(full, 'utf-8') }); }
            }
          }
          await collectSvgs(tmpDir);
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          if (svgs.length === 0) { reject(new Error('KiCad export produced no SVG output')); return; }
          resolve(svgs);
        } catch (readErr) {
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          reject(readErr);
        }
      });
    });
  });

  // KiCad PCB → GLB (3D model) via kicad-cli
  // kicad-cli exits with code 2 for missing VRML warnings but still produces the file
  ipcMain.handle('files:exportKicadGlb', async (event, filePath) => {
    const kicadCli = getKicadCli();
    const tmpDir = path.join(require('os').tmpdir(), 'engorg-kicad-glb-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const outFile = path.join(tmpDir, 'board.glb');

    return new Promise((resolve, reject) => {
      const args = ['pcb', 'export', 'glb', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '--force', '--output', outFile, filePath];
      execFile(kicadCli, args, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, async (error) => {
        if (error?.code === 'ENOENT') {
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          reject(new Error('kicad-cli not found. Searched: ' + kicadCli)); return;
        }
        try {
          await fs.promises.access(outFile);
          const buf = await fs.promises.readFile(outFile);
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        } catch (readErr) {
          try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
          reject(new Error(error ? 'KiCad GLB export failed: ' + error.message : 'KiCad GLB export produced no output'));
        }
      });
    });
  });

  ipcMain.handle('files:hasKicadCli', async () => {
    const kicadCli = getKicadCli();
    return new Promise((resolve) => {
      execFile(kicadCli, ['--version'], { timeout: 5000 }, (error) => resolve(!error));
    });
  });
};
