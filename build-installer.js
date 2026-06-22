// Build Installer — Compiles EngOrg-Setup.exe using Inno Setup
// Triggered from Settings > App Distribution > Build Installer

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = 'C:\\Assistant';
const ISCC = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe');
const ISS_FILE = path.join(ROOT, 'installer.iss');
const OUTPUT = path.join(ROOT, 'EngOrg-Setup.exe');

function build() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    // Check if rebuild needed
    if (fs.existsSync(OUTPUT)) {
      const exeMtime = fs.statSync(OUTPUT).mtimeMs;
      const keyFiles = ['main.js', 'preload.js', 'config.js', 'state.js',
        'fluidd-server.js', 'package.json',
        'renderer/app.js', 'renderer/index.html', 'renderer/settings.js',
        'renderer/printer.js', 'renderer/styles.css',
        'pwa/app.js', 'pwa/index.html', 'pwa/styles.css',
        'ipc/data.js', 'ipc/files.js', 'ipc/git.js', 'ipc/auth.js',
        'ipc/printer.js', 'ipc/slicer.js', 'ipc/outlook.js',
        'ipc/wifi-checker.js', 'renderer/wifi-checker.js', 'renderer/engineering.js',
        'ipc/contribute.js',
        'ipc/ftdi.js', 'ipc/ftdi_helper.py', 'renderer/uart-bridge.js',
        'installer.iss'];
      const newestKey = keyFiles.reduce((max, f) => {
        try { return Math.max(max, fs.statSync(path.join(ROOT, f)).mtimeMs); }
        catch { return max; }
      }, 0);
      if (exeMtime > newestKey) {
        console.log('[Installer] Already up to date, skipping.');
        return resolve({ success: true, path: OUTPUT, skipped: true });
      }
    }

    if (!fs.existsSync(ISCC)) {
      const msg = 'Inno Setup not found. Install it from https://jrsoftware.org/isinfo.php';
      console.error('[Installer]', msg);
      return reject(new Error(msg));
    }

    console.log('[Installer] Building EngOrg-Setup.exe...');
    try { fs.unlinkSync(OUTPUT); } catch {}

    const proc = spawn(ISCC, [ISS_FILE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('Reading')) {
          console.log('[Installer]', trimmed);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      console.error('[Installer]', data.toString().trim());
    });

    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) {
        console.error(`[Installer] Inno Setup exited with code ${code}`);
        return reject(new Error(`Inno Setup compilation failed (code ${code})`));
      }

      try {
        const sizeMB = (fs.statSync(OUTPUT).size / (1024 * 1024)).toFixed(1);
        console.log(`[Installer] Created EngOrg-Setup.exe (${sizeMB} MB) in ${elapsed}s`);
        resolve({ success: true, path: OUTPUT });
      } catch (err) {
        reject(new Error('Installer file not found after build'));
      }
    });

    proc.on('error', (err) => {
      console.error('[Installer] Failed to spawn ISCC:', err.message);
      reject(err);
    });
  });
}

if (require.main === module) {
  build()
    .then(r => console.log('[Installer] Done:', r.path))
    .catch(err => {
      console.error('[Installer] Build failed:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { build };
}
