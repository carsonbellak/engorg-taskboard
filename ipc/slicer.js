// IPC handlers: OrcaSlicer CLI slicing, profile discovery, process/filament profile merging
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  ORCASLICER_EXE, ORCASLICER_RESOURCES,
  SLICER_OUTPUT_DIR
} = require('../config');

const MACHINE_PROFILE = path.join(ORCASLICER_RESOURCES, 'machine', 'Creality K1C 0.4 nozzle.json');
const SYSTEM_PROCESS_DIR = path.join(ORCASLICER_RESOURCES, 'process');
const SYSTEM_FILAMENT_DIR = path.join(ORCASLICER_RESOURCES, 'filament');
const USER_PROCESS_DIR = path.join(process.env.APPDATA, 'OrcaSlicer', 'user', 'default', 'process');
const USER_FILAMENT_DIR = path.join(process.env.APPDATA, 'OrcaSlicer', 'user', 'default', 'filament');

// Merge a user profile with its inherited system base profile.
// User profiles often lack the required "type" field — the base provides it.
async function mergeUserProfile(userProfilePath, profileType) {
  const userJson = JSON.parse(await fs.promises.readFile(userProfilePath, 'utf-8'));
  if (userJson.type) return userProfilePath;

  const inherits = userJson.inherits;
  if (!inherits) {
    userJson.type = profileType;
    const tmpPath = path.join(SLICER_OUTPUT_DIR, `merged_${profileType}_${Date.now()}.json`);
    await fs.promises.mkdir(SLICER_OUTPUT_DIR, { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(userJson, null, 2));
    return tmpPath;
  }

  const baseDir = profileType === 'process' ? SYSTEM_PROCESS_DIR : SYSTEM_FILAMENT_DIR;
  let baseJson = {};
  try {
    baseJson = JSON.parse(await fs.promises.readFile(path.join(baseDir, inherits + '.json'), 'utf-8'));
  } catch {
    // Creality Print filament names don't match OrcaSlicer — fuzzy-match on material + K1-all
    if (profileType === 'filament') {
      const materialMatch = inherits.match(/^(?:CR-|Generic |Hyper )?(\w[\w-]*)/i);
      if (materialMatch) {
        const material = materialMatch[1].toUpperCase();
        try {
          const files = await fs.promises.readdir(baseDir);
          const fallback = files.find(f => f.includes(material) && f.includes('K1-all') && f.endsWith('.json'));
          if (fallback) {
            console.log(`Filament fallback: "${inherits}" → "${fallback}"`);
            baseJson = JSON.parse(await fs.promises.readFile(path.join(baseDir, fallback), 'utf-8'));
          } else {
            console.warn(`No filament fallback found for "${inherits}"`);
          }
        } catch (e2) { console.warn('Filament fallback search failed:', e2.message); }
      }
    }
  }

  const merged = { ...baseJson, ...userJson };
  if (!merged.type) merged.type = profileType;
  const tmpPath = path.join(SLICER_OUTPUT_DIR, `merged_${profileType}_${Date.now()}.json`);
  await fs.promises.mkdir(SLICER_OUTPUT_DIR, { recursive: true });
  await fs.promises.writeFile(tmpPath, JSON.stringify(merged, null, 2));
  return tmpPath;
}

// Write a modified copy of a process profile with UI overrides applied (infill, supports, layer height, ironing)
async function applyProcessOverrides(processProfilePath, overrides, isUserProfile) {
  let profilePath = isUserProfile ? await mergeUserProfile(processProfilePath, 'process') : processProfilePath;
  if (!overrides || (overrides.infill === undefined && overrides.supports === undefined && overrides.layerHeight === undefined && overrides.ironing === undefined)) {
    return profilePath;
  }

  const json = JSON.parse(await fs.promises.readFile(profilePath, 'utf-8'));
  if (overrides.infill !== undefined) json.sparse_infill_density = String(overrides.infill) + '%';
  if (overrides.supports !== undefined) {
    if (overrides.supports === false || overrides.supports === 'off') {
      json.enable_support = '0';
    } else {
      json.enable_support = '1';
      json.support_type = overrides.supports === 'tree' ? 'tree(auto)' : 'normal(auto)';
    }
  }
  if (overrides.layerHeight !== undefined) json.layer_height = String(overrides.layerHeight);
  if (overrides.ironing !== undefined) {
    if (overrides.ironing === false) {
      json.ironing_type = 'no ironing';
    } else {
      const typeMap = { top: 'top', topmost: 'topmost', all: 'solid' };
      json.ironing_type = typeMap[overrides.ironing.type] || 'top';
      json.ironing_speed = String(overrides.ironing.speed);
      json.ironing_flow = String(overrides.ironing.flow) + '%';
      json.ironing_spacing = String(overrides.ironing.spacing);
    }
  }

  const tmpPath = path.join(SLICER_OUTPUT_DIR, `process_override_${Date.now()}.json`);
  await fs.promises.mkdir(SLICER_OUTPUT_DIR, { recursive: true });
  await fs.promises.writeFile(tmpPath, JSON.stringify(json, null, 2));
  return tmpPath;
}

// Extract print time, filament usage, and file size from OrcaSlicer gcode header comments
async function parseGcodeEstimates(gcodePath) {
  try {
    const lines = (await fs.promises.readFile(gcodePath, 'utf-8')).split('\n').slice(0, 200);
    let totalTime = null, filamentUsed = null, filamentWeight = null;
    for (const line of lines) {
      if (line.includes('estimated printing time')) { const m = line.match(/=\s*(.+)/); if (m) totalTime = m[1].trim(); }
      if (line.includes('filament used [mm]') || line.includes('total filament used [mm]')) { const m = line.match(/=\s*([\d.]+)/); if (m) filamentUsed = parseFloat(m[1]); }
      if (line.includes('filament used [g]') || line.includes('total filament used [g]')) { const m = line.match(/=\s*([\d.]+)/); if (m) filamentWeight = parseFloat(m[1]); }
    }
    const stat = await fs.promises.stat(gcodePath);
    return { time: totalTime, filamentMm: filamentUsed, filamentG: filamentWeight, filamentM: filamentUsed ? (filamentUsed / 1000).toFixed(2) : null, fileSize: stat.size };
  } catch { return {}; }
}

module.exports = function register(getMainWindow) {
  ipcMain.handle('slicer:selectModel', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'], title: 'Select 3D Model',
      filters: [{ name: '3D Models', extensions: ['stl', '3mf', 'obj', 'step', 'stp'] }, { name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('slicer:getProfiles', async () => {
    const profiles = { process: [], filament: [] };

    const readDir = async (dir, filter, source, target) => {
      try {
        const files = await fs.promises.readdir(dir);
        for (const f of files) {
          if (f.endsWith('.json') && (!filter || f.includes(filter))) {
            target.push({ name: f.replace('.json', ''), path: path.join(dir, f), source });
          }
        }
      } catch (e) { console.warn(`Failed to read ${source} profiles from ${dir}:`, e.message); }
    };

    await readDir(SYSTEM_PROCESS_DIR, 'K1C 0.4', 'system', profiles.process);
    await readDir(USER_PROCESS_DIR, null, 'user', profiles.process);
    await readDir(SYSTEM_FILAMENT_DIR, 'K1-all', 'system', profiles.filament);
    await readDir(USER_FILAMENT_DIR, null, 'user', profiles.filament);

    const sortProfiles = (a, b) => a.source !== b.source ? (a.source === 'user' ? -1 : 1) : a.name.localeCompare(b.name);
    profiles.process.sort(sortProfiles);
    profiles.filament.sort(sortProfiles);
    return profiles;
  });

  // OrcaSlicer on Windows opens a GUI and never exits after slicing.
  // Workaround: spawn, poll for output gcode file stability, then kill the process.
  ipcMain.handle('slicer:slice', async (event, { modelPath, processProfile, filamentProfile, overrides }) => {
    await fs.promises.mkdir(SLICER_OUTPUT_DIR, { recursive: true });

    const finalProcessPath = await applyProcessOverrides(processProfile.path, overrides, processProfile.source === 'user');
    const finalFilamentPath = filamentProfile.source === 'user'
      ? await mergeUserProfile(filamentProfile.path, 'filament')
      : filamentProfile.path;

    const args = ['--load-settings', `${MACHINE_PROFILE};${finalProcessPath}`, '--load-filaments', finalFilamentPath, '--slice', '0', '--outputdir', SLICER_OUTPUT_DIR, modelPath];
    console.log('Slicing with args:', args.join(' '));

    const defaultOutput = path.join(SLICER_OUTPUT_DIR, 'plate_1.gcode');
    const modelName = path.basename(modelPath, path.extname(modelPath));
    const finalOutput = path.join(SLICER_OUTPUT_DIR, modelName + '.gcode');

    await fs.promises.unlink(defaultOutput).catch(() => {});
    const proc = spawn(ORCASLICER_EXE, args, { windowsHide: true, stdio: 'ignore' });

    return new Promise((resolve) => {
      const TIMEOUT = 300000;
      const POLL_INTERVAL = 2000;
      let elapsed = 0;

      const pollTimer = setInterval(async () => {
        elapsed += POLL_INTERVAL;
        if (elapsed >= TIMEOUT) {
          clearInterval(pollTimer);
          proc.kill();
          resolve({ success: false, error: 'Slicing timed out after 5 minutes', output: '' });
          return;
        }
        try {
          const stat = await fs.promises.stat(defaultOutput);
          if (stat.size === 0) return;
          await new Promise(r => setTimeout(r, POLL_INTERVAL));
          const stat2 = await fs.promises.stat(defaultOutput);
          if (stat2.size !== stat.size) return;

          clearInterval(pollTimer);
          proc.kill();

          try {
            await fs.promises.unlink(finalOutput).catch(() => {});
            await fs.promises.rename(defaultOutput, finalOutput);
          } catch {}

          const gcPath = await fs.promises.access(finalOutput).then(() => finalOutput).catch(() => defaultOutput);
          const estimates = await parseGcodeEstimates(gcPath);
          resolve({ success: true, gcodePath: gcPath, output: `Sliced successfully (${(stat2.size / 1024 / 1024).toFixed(1)} MB gcode)`, estimates });
        } catch {}
      }, POLL_INTERVAL);

      proc.on('error', (err) => { clearInterval(pollTimer); resolve({ success: false, error: err.message, output: '' }); });
    });
  });
};
